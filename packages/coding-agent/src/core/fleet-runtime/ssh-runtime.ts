/**
 * SSH runtime adapter — spawns agents on fleet hosts via SSH.
 *
 * Flow:
 * 1. Orchestrator calls spawn() with target host
 * 2. SSHRuntime connects to the host and runs:
 *      prime-agent --headless --session <id> --prompt "..." --work-dir ~/...
 * 3. The agent runs on the remote host with its own IPython kernel
 * 4. Status is polled via SSH (checking process / reading session JSONL)
 * 5. If the host is gateway-connected, events stream via WebSocket instead
 * 6. Files are transferred via SSH (scp/cat)
 * 7. The remote agent can itself spawn sub-agents on other fleet hosts
 *
 * The spawned agent is fully self-contained:
 * - Its own working directory under ~/ on the target
 * - Its own session directory
 * - Its own IPython kernel
 * - Can request files from the orchestrator via gateway
 * - Can spawn recursively on other hosts
 */

import { spawn } from "node:child_process";
import { getFleetHost } from "../../cli/fleet/fleet-config.js";
import type {
	AgentEvent,
	AgentIdentity,
	AgentRuntime,
	AgentStatus,
	AgentStatusEndpoint,
	AgentStatusInfo,
	SpawnRequest,
	SpawnResult,
} from "./agent-runtime.js";

export class SSHRuntime implements AgentRuntime {
	readonly platform = "ssh";

	canSpawn(host: string): boolean {
		// SSH runtime handles any host that's not a known platform name
		// and not "local"/"self"/"localhost"
		const knownPlatforms = [
			"local",
			"self",
			"localhost",
			"cloudflare",
			"github-actions",
			"github",
			"vercel",
			"netlify",
		];
		return !knownPlatforms.includes(host);
	}

	async spawn(request: SpawnRequest): Promise<SpawnResult> {
		const host = request.host.replace(/^ssh:/, "");
		const fleetHost = await getFleetHost(host);
		if (!fleetHost) {
			throw new Error(`Host "${host}" not found in fleet. Run \`prime-agent fleet add ${host}\` first.`);
		}

		const agentId = crypto.randomUUID();
		const sessionDir = request.workDir ?? `.prime/agent/sessions/fleet/${agentId}`;
		const target = fleetHost.address;
		const user = fleetHost.user ? `${fleetHost.user}@` : "";

		const identity: AgentIdentity = {
			agentId,
			host,
			sessionDir,
			model: request.model ?? "default",
			label: request.name ?? request.prompt.slice(0, 60),
			depth: request.depth,
			parentAgentId: request.parent?.agentId,
		};

		// Build the remote command
		// The agent runs headless — no TUI, just the RLM loop
		const escapedPrompt = request.prompt.replace(/'/g, "'\\''");
		const remoteCmd = [
			"prime-agent",
			"--headless",
			`--session-id ${agentId}`,
			`--work-dir ~/${sessionDir}`,
			`--prompt '${escapedPrompt}'`,
			request.model ? `--model ${request.model}` : "",
			request.name ? `--name '${request.name.replace(/'/g, "'\\''")}'` : "",
			`--depth ${request.depth}`,
			request.parent ? `--parent-agent-id ${request.parent.agentId}` : "",
			`--parent-host ${request.parent?.host ?? "local"}`,
		]
			.filter(Boolean)
			.join(" ");

		// Start the SSH session
		const ssh = spawn("ssh", [`${user}${target}`, remoteCmd], {
			stdio: ["pipe", "pipe", "pipe"],
			detached: false,
		});

		// Track the process
		let status: AgentStatus = "running";
		let statusInfo: AgentStatusInfo = { status };
		const eventListeners = new Set<(event: AgentEvent) => void>();
		const startTime = Date.now();

		// Parse stdout for events (JSONL format)
		ssh.stdout?.setEncoding("utf-8");
		ssh.stdout?.on("data", (data: string) => {
			for (const line of data.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const event = JSON.parse(trimmed) as AgentEvent;
					for (const listener of eventListeners) listener(event);
					if (event.type === "status") {
						status = event.status;
						statusInfo = event.info;
					}
				} catch {
					// Non-JSON output — emit as log
					for (const listener of eventListeners) {
						listener({ type: "log", level: "info", message: trimmed });
					}
				}
			}
		});

		ssh.stderr?.setEncoding("utf-8");
		ssh.stderr?.on("data", (data: string) => {
			for (const line of data.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				for (const listener of eventListeners) {
					listener({ type: "log", level: "error", message: trimmed });
				}
			}
		});

		ssh.on("exit", (code) => {
			if (status === "running") {
				status = code === 0 ? "completed" : "error";
				statusInfo = {
					...statusInfo,
					status,
					durationMs: Date.now() - startTime,
					error: code !== 0 ? `Process exited with code ${code}` : undefined,
				};
				for (const listener of eventListeners) {
					listener({ type: "status", status, info: statusInfo });
				}
			}
		});

		const statusEndpoint: AgentStatusEndpoint = {
			poll: async () => statusInfo,
			subscribe: (listener) => {
				eventListeners.add(listener);
				return () => eventListeners.delete(listener);
			},
			abort: async () => {
				if (status === "running") {
					ssh.kill("SIGTERM");
					status = "aborted";
					statusInfo = { ...statusInfo, status, error: "Aborted by parent" };
				}
			},
			requestFile: async (path) => {
				return new Promise((resolve, reject) => {
					const scp = spawn("ssh", [`${user}${target}`, `cat ~/${sessionDir}/${path}`], {
						stdio: ["pipe", "pipe", "pipe"],
					});
					let output = "";
					scp.stdout?.setEncoding("utf-8");
					scp.stdout?.on("data", (d: string) => (output += d));
					scp.on("exit", (code) => {
						if (code === 0) resolve(output);
						else reject(new Error(`Failed to read file: ${path}`));
					});
				});
			},
			sendFile: async (path, content) => {
				return new Promise((resolve, reject) => {
					// Ensure directory exists, then write file
					const escapedContent = content.replace(/'/g, "'\\''");
					const scp = spawn(
						"ssh",
						[
							`${user}${target}`,
							`mkdir -p ~/${sessionDir}/$(dirname ${path}) && echo '${escapedContent}' > ~/${sessionDir}/${path}`,
						],
						{ stdio: ["pipe", "pipe", "pipe"] },
					);
					scp.on("exit", (code) => {
						if (code === 0) resolve();
						else reject(new Error(`Failed to write file: ${path}`));
					});
				});
			},
		};

		return { identity, statusEndpoint };
	}
}
