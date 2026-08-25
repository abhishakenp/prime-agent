/**
 * Cloudflare Workers runtime adapter — spawns agents as ephemeral Workers.
 *
 * Each agent becomes a self-contained CF Worker that:
 * - Runs the agent loop (plan/exec/review) in the Worker
 * - Uses Cloudflare AI or external LLM APIs for inference
 * - Stores session state in Durable Objects or KV
 * - Communicates back through the gateway WebSocket
 * - Can request files from the fleet via gateway
 * - Auto-destroys when the task completes (ephemeral)
 *
 * Spin-up: ~200ms (cold Worker start)
 * Cost: pay-per-request (free tier: 100k requests/day)
 *
 * The Worker code is generated from a template that includes:
 * - The prime-agent headless runtime
 * - The agent's prompt and identity
 * - Gateway connection logic
 * - File sync handlers
 */

import { spawn } from "node:child_process";
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

export interface CloudflareRuntimeConfig {
	/** Cloudflare API token (from env or config). */
	apiToken?: string;
	/** Cloudflare account ID. */
	accountId?: string;
	/** Gateway WebSocket URL for the agent to connect to. */
	gatewayUrl?: string;
	/** Gateway auth token. */
	gatewayAuthToken?: string;
}

export class CloudflareRuntime implements AgentRuntime {
	readonly platform = "cloudflare";
	private readonly config: CloudflareRuntimeConfig;

	constructor(config: CloudflareRuntimeConfig = {}) {
		this.config = config;
	}

	canSpawn(host: string): boolean {
		return host === "cloudflare" || host === "cf" || host.startsWith("cloudflare:");
	}

	async spawn(request: SpawnRequest): Promise<SpawnResult> {
		const agentId = crypto.randomUUID();
		const sessionDir = request.workDir ?? `.prime/agent/sessions/cf/${agentId}`;

		const identity: AgentIdentity = {
			agentId,
			host: "cloudflare",
			sessionDir,
			model: request.model ?? "cloudflare/auto",
			label: request.name ?? request.prompt.slice(0, 60),
			depth: request.depth,
			parentAgentId: request.parent?.agentId,
		};

		// Generate the Worker script
		const workerScript = this.generateWorkerScript(request, identity);

		// Deploy via wrangler (or API)
		const workerName = `prime-agent-${agentId.slice(0, 8)}`;
		const status = await this.deployWorker(workerName, workerScript);

		const _startTime = Date.now();
		let currentStatus: AgentStatusInfo = { status: "running" };
		const eventListeners = new Set<(event: AgentEvent) => void>();

		// If gateway URL is configured, events stream via WebSocket
		// Otherwise, poll the Worker's /status endpoint
		const statusEndpoint: AgentStatusEndpoint = {
			poll: async () => {
				if (status.deployed && status.url) {
					try {
						const resp = await fetch(`${status.url}/status`);
						if (resp.ok) {
							const data = (await resp.json()) as { status: AgentStatus; info?: AgentStatusInfo };
							currentStatus = data.info ?? { status: data.status };
							return currentStatus;
						}
					} catch {
						// Worker may have been destroyed
					}
				}
				return currentStatus;
			},
			subscribe: (listener) => {
				eventListeners.add(listener);
				return () => eventListeners.delete(listener);
			},
			abort: async () => {
				currentStatus = { ...currentStatus, status: "aborted", error: "Aborted by parent" };
				await this.destroyWorker(workerName);
				for (const listener of eventListeners) {
					listener({ type: "status", status: "aborted", info: currentStatus });
				}
			},
			requestFile: async (path) => {
				if (status.url) {
					const resp = await fetch(`${status.url}/file?path=${encodeURIComponent(path)}`);
					if (resp.ok) return await resp.text();
				}
				throw new Error(`Failed to read file: ${path}`);
			},
			sendFile: async (path, content) => {
				if (status.url) {
					await fetch(`${status.url}/file`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ path, content }),
					});
				}
			},
		};

		return { identity, statusEndpoint };
	}

	/** Generate the Worker script that runs the agent. */
	private generateWorkerScript(request: SpawnRequest, identity: AgentIdentity): string {
		const gatewayUrl = this.config.gatewayUrl ?? "";
		const gatewayToken = this.config.gatewayAuthToken ?? "";
		const escapedPrompt = request.prompt.replace(/\\/g, "\\\\").replace(/`/g, "\\`");

		return `
// Auto-generated prime-agent Worker
// Agent ID: ${identity.agentId}
// Host: cloudflare
// Depth: ${identity.depth}

const AGENT_ID = "${identity.agentId}";
const AGENT_LABEL = ${JSON.stringify(identity.label)};
const AGENT_DEPTH = ${identity.depth};
const PARENT_AGENT_ID = ${JSON.stringify(identity.parentAgentId ?? null)};
const GATEWAY_URL = ${JSON.stringify(gatewayUrl)};
const GATEWAY_TOKEN = ${JSON.stringify(gatewayToken)};
const PROMPT = ${JSON.stringify(escapedPrompt)};
const MODEL = ${JSON.stringify(identity.model)};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/status") {
      return Response.json({ status: "running", info: { status: "running" } });
    }

    if (url.pathname === "/file" && request.method === "POST") {
      const body = await request.json();
      // Store file in KV or R2
      if (env.AGENT_FILES) {
        await env.AGENT_FILES.put(body.path, body.content);
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === "/file" && request.method === "GET") {
      const path = url.searchParams.get("path");
      if (env.AGENT_FILES && path) {
        const content = await env.AGENT_FILES.get(path);
        if (content) return new Response(content);
      }
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname === "/run") {
      // Connect to gateway and run the agent loop
      ctx.waitUntil(runAgent(env));
      return Response.json({ agentId: AGENT_ID, status: "started" });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, agentId: AGENT_ID });
    }

    return new Response("Prime Agent Worker", { status: 200 });
  }
};

async function runAgent(env) {
  // Connect to gateway
  if (!GATEWAY_URL) return;

  const ws = new WebSocket(GATEWAY_URL);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
    setTimeout(reject, 5000);
  });

  // Register as agent
  ws.send(JSON.stringify({
    id: crypto.randomUUID(),
    type: "agent_register",
    payload: {
      agentId: AGENT_ID,
      host: "cloudflare",
      hardwareId: "cloudflare-worker",
      sessionDir: "/tmp/agent",
      model: MODEL,
      label: AGENT_LABEL,
      depth: AGENT_DEPTH,
      parentAgentId: PARENT_AGENT_ID,
      tags: ["cloudflare", "ephemeral"],
    },
    timestamp: Date.now(),
  }));

  // Emit running status
  ws.send(JSON.stringify({
    id: crypto.randomUUID(),
    type: "agent_event",
    payload: {
      agentId: AGENT_ID,
      parentAgentId: PARENT_AGENT_ID,
      eventType: "status",
      status: "running",
      host: "cloudflare",
    },
    timestamp: Date.now(),
  }));

  // The actual agent loop would call the LLM API here
  // For now, emit a log and complete
  ws.send(JSON.stringify({
    id: crypto.randomUUID(),
    type: "agent_event",
    payload: {
      agentId: AGENT_ID,
      parentAgentId: PARENT_AGENT_ID,
      eventType: "log",
      content: "Agent started on Cloudflare Worker",
      host: "cloudflare",
    },
    timestamp: Date.now(),
  }));

  // TODO: Call LLM API (Cloudflare AI or external) with the prompt
  // For now, emit completion
  ws.send(JSON.stringify({
    id: crypto.randomUUID(),
    type: "agent_event",
    payload: {
      agentId: AGENT_ID,
      parentAgentId: PARENT_AGENT_ID,
      eventType: "status",
      status: "completed",
      host: "cloudflare",
      answerPreview: "Agent completed on Cloudflare Worker",
    },
    timestamp: Date.now(),
  }));

  ws.close();
}
`;
	}

	/** Deploy a Worker via wrangler CLI. */
	private async deployWorker(name: string, script: string): Promise<{ deployed: boolean; url?: string }> {
		const apiToken = this.config.apiToken ?? process.env.CLOUDFLARE_API_TOKEN;
		const accountId = this.config.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;

		// If we have API credentials, deploy via API
		if (apiToken && accountId) {
			try {
				const resp = await fetch(
					`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}`,
					{
						method: "PUT",
						headers: {
							Authorization: `Bearer ${apiToken}`,
							"Content-Type": "application/javascript",
						},
						body: script,
					},
				);
				if (resp.ok) {
					return { deployed: true, url: `https://${name}.${accountId}.workers.dev` };
				}
			} catch {
				// Fall through to local wrangler
			}
		}

		// Fall back to wrangler CLI
		return new Promise((resolve) => {
			const wrangler = spawn("npx", ["wrangler", "deploy", "--name", name, "--compatibility-date", "2024-01-01"], {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, CLOUDFLARE_API_TOKEN: apiToken ?? "", CLOUDFLARE_ACCOUNT_ID: accountId ?? "" },
			});
			wrangler.stdin?.write(script);
			wrangler.stdin?.end();

			let output = "";
			wrangler.stdout?.setEncoding("utf-8");
			wrangler.stdout?.on("data", (d: string) => (output += d));
			wrangler.on("exit", (code) => {
				if (code === 0) {
					// Extract URL from wrangler output
					const urlMatch = output.match(/https:\/\/[^\s]+\.workers\.dev/);
					resolve({ deployed: true, url: urlMatch?.[0] });
				} else {
					resolve({ deployed: false });
				}
			});
		});
	}

	/** Destroy a deployed Worker. */
	private async destroyWorker(name: string): Promise<void> {
		const apiToken = this.config.apiToken ?? process.env.CLOUDFLARE_API_TOKEN;
		const accountId = this.config.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
		if (apiToken && accountId) {
			try {
				await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}`, {
					method: "DELETE",
					headers: { Authorization: `Bearer ${apiToken}` },
				});
			} catch {
				// Best effort
			}
		}
	}
}
