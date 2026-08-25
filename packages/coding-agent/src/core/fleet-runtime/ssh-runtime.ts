/**
 * SSH runtime adapter — deploys self-contained agent bundles to fleet hosts.
 *
 * Flow:
 * 1. Orchestrator calls spawn()
 * 2. SSHRuntime assembles an AgentBundle (runtime + files + creds + config)
 * 3. tars the bundle and pipes it over SSH
 * 4. Target extracts and runs ./run.sh
 * 5. The agent starts with everything it needs — no pre-install required
 * 6. Events stream back over SSH stdout (JSONL)
 * 7. Files can be requested/sent via SSH cat
 *
 * The target host needs only: bash + node. Everything else is in the bundle.
 * Like Needle: "one artifact runs anywhere."
 */

import { spawn } from "node:child_process";
import { getFleetHost } from "../../cli/fleet/fleet-config.js";
import { type AgentIdentitySpec, assembleBundle, type BundleSpec, tarBundle } from "./agent-bundle.js";
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

		// Assemble the self-contained bundle
		const identitySpec: AgentIdentitySpec = {
			agentId,
			host,
			hardwareId: `${process.arch}-${process.platform}`,
			depth: request.depth,
			parentAgentId: request.parent?.agentId,
			parentHost: request.parent?.host,
		};

		const bundleSpec: BundleSpec = {
			prompt: request.prompt,
			identity: identitySpec,
			model: request.model,
			name: request.name,
			workDir: request.workDir,
			files: request.syncFiles,
			includeCredentials: true,
			cwd: process.cwd(),
		};

		const bundleDir = await assembleBundle(bundleSpec);
		const tarPath = await tarBundle(bundleDir);

		// Ship the bundle over SSH and run it
		// The target receives the tarball, extracts it, and runs run.sh
		const remoteBundleDir = `/tmp/prime-agent-bundle-${agentId.slice(0, 8)}`;
		const remoteCmd = `mkdir -p ${remoteBundleDir} && tar xzf - -C ${remoteBundleDir} && bash ${remoteBundleDir}/$(ls ${remoteBundleDir})/run.sh`;

		// Start SSH with the tarball piped to stdin
		const ssh = spawn("ssh", [`${user}${target}`, remoteCmd], {
			stdio: ["pipe", "pipe", "pipe"],
			detached: false,
		});

		// Pipe the tarball to SSH stdin
		const { createReadStream } = await import("node:fs");
		const tarStream = createReadStream(tarPath);
		tarStream.pipe(ssh.stdin);

		// Track the process
		let status: AgentStatus = "running";
		let statusInfo: AgentStatusInfo = { status };
		const eventListeners = new Set<(event: AgentEvent) => void>();
		const startTime = Date.now();

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
					const scp = spawn("ssh", [`${user}${target}`, `cat ${sessionDir}/${path}`], {
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
					const escapedContent = content.replace(/'/g, "'\\''");
					const scp = spawn(
						"ssh",
						[
							`${user}${target}`,
							`mkdir -p ${sessionDir}/$(dirname ${path}) && echo '${escapedContent}' > ${sessionDir}/${path}`,
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
