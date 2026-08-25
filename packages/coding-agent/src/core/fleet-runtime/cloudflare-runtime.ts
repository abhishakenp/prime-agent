/**
 * Cloudflare Workers runtime adapter — deploys self-contained agent bundles as Workers.
 *
 * The bundle is embedded directly in the Worker script. The Worker:
 * - Contains the agent spec (prompt, identity, creds)
 * - Connects to the gateway to register and report events
 * - Calls the LLM API with the included credentials
 * - Auto-destroys when the task completes
 *
 * Spin-up: ~200ms (cold Worker start)
 * The target (CF Workers) needs nothing — the bundle IS the Worker.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type AgentIdentitySpec, assembleBundle, type BundleSpec } from "./agent-bundle.js";
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
	apiToken?: string;
	accountId?: string;
	/** workers.dev subdomain (e.g. "abhi-shake-np"). If absent, extracted from wrangler output. */
	workersSubdomain?: string;
	gatewayUrl?: string;
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

		// Assemble the bundle to get credentials and agent spec
		const identitySpec: AgentIdentitySpec = {
			agentId,
			host: "cloudflare",
			hardwareId: "cloudflare-worker",
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

		// Read the env.json (credentials) and agent spec from the bundle
		const envVars = JSON.parse(readFileSync(join(bundleDir, "agent", "env.json"), "utf-8")) as Record<string, string>;
		const settings = JSON.parse(readFileSync(join(bundleDir, "agent", "settings.json"), "utf-8")) as Record<
			string,
			unknown
		>;

		// Generate the Worker script — the bundle is embedded as JSON
		const workerScript = this.generateWorkerScript(request, identity, envVars, settings);

		// Deploy
		const workerName = `prime-agent-${agentId.slice(0, 8)}`;
		const status = await this.deployWorker(workerName, workerScript);

		// Trigger the agent run — retry until the Worker is ready
		if (status.deployed && status.url) {
			for (let i = 0; i < 10; i++) {
				try {
					const resp = await fetch(`${status.url}/run`, { method: "POST" });
					if (resp.ok) {
						const data = (await resp.json()) as { status?: string };
						if (data.status !== "pending") break;
					}
				} catch {}
				await new Promise((r) => setTimeout(r, 2000));
			}
		}

		let currentStatus: AgentStatusInfo = { status: "running" };
		const eventListeners = new Set<(event: AgentEvent) => void>();

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
					} catch {}
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

	/**
	 * Generate the Worker script with the bundle embedded.
	 * The Worker is self-contained: agent spec + credentials + gateway connection.
	 */
	private generateWorkerScript(
		request: SpawnRequest,
		identity: AgentIdentity,
		envVars: Record<string, string>,
		settings: Record<string, unknown>,
	): string {
		const gatewayUrl = this.config.gatewayUrl ?? "";
		const gatewayToken = this.config.gatewayAuthToken ?? "";
		const escapedPrompt = JSON.stringify(request.prompt);
		const envJson = JSON.stringify(envVars);
		const settingsJson = JSON.stringify(settings);

		return `
// Prime Agent Worker — self-contained, auto-generated
// Agent ID: ${identity.agentId}
// Bundle: everything sealed inside (like Needle)

const AGENT_ID = ${JSON.stringify(identity.agentId)};
const AGENT_LABEL = ${JSON.stringify(identity.label)};
const AGENT_DEPTH = ${identity.depth};
const PARENT_AGENT_ID = ${JSON.stringify(identity.parentAgentId ?? null)};
const PARENT_HOST = ${JSON.stringify(request.parent?.host ?? null)};
const GATEWAY_URL = ${JSON.stringify(gatewayUrl)};
const GATEWAY_TOKEN = ${JSON.stringify(gatewayToken)};
const PROMPT = ${escapedPrompt};
const MODEL = ${JSON.stringify(identity.model)};
const ENV_VARS = ${envJson};
const SETTINGS = ${settingsJson};

// Agent state
let agentStatus = "pending";
let startedAt = 0;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, agentId: AGENT_ID, status: agentStatus });
    }

    if (url.pathname === "/status") {
      return Response.json({
        status: agentStatus,
        info: {
          status: agentStatus,
          durationMs: startedAt > 0 ? Date.now() - startedAt : 0,
        },
      });
    }

    if (url.pathname === "/file" && request.method === "POST") {
      const body = await request.json();
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

    if (url.pathname === "/run" || url.pathname === "/") {
      if (agentStatus === "pending") {
        agentStatus = "running";
        startedAt = Date.now();
        ctx.waitUntil(runAgent(env));
      }
      return Response.json({ agentId: AGENT_ID, status: agentStatus });
    }

    return new Response("Prime Agent Worker", { status: 200 });
  }
};

async function runAgent(env) {
  // sendEvent works with or without gateway
  let ws = null;
  const sendEvent = (eventType, extra = {}) => {
    if (ws) {
      try {
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: "agent_event",
          payload: {
            agentId: AGENT_ID,
            parentAgentId: PARENT_AGENT_ID,
            eventType,
            host: "cloudflare",
            ...extra,
          },
          timestamp: Date.now(),
        }));
      } catch {}
    }
  };

  // Connect to gateway if configured
  if (GATEWAY_URL) {
    try {
      ws = new WebSocket(GATEWAY_URL);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve);
        ws.addEventListener("error", reject);
        setTimeout(reject, 5000);
      });

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
          parentHost: PARENT_HOST,
          tags: ["cloudflare", "ephemeral"],
        },
        timestamp: Date.now(),
      }));
    } catch {
      ws = null; // Continue without gateway
    }
  }

  sendEvent("status", { status: "running" });
  sendEvent("log", { content: "Agent started on Cloudflare Worker" });

  // Call the LLM API using the included credentials
  const model = SETTINGS.defaultModel || MODEL;
  const provider = SETTINGS.defaultProvider || "openrouter";

  // Determine API endpoint and key from the bundled credentials
  let apiUrl = null;
  let apiKey = null;

  if (provider === "openrouter" && ENV_VARS.OPENROUTER_API_KEY) {
    apiUrl = "https://openrouter.ai/api/v1/chat/completions";
    apiKey = ENV_VARS.OPENROUTER_API_KEY;
  } else if (provider === "anthropic" && ENV_VARS.ANTHROPIC_API_KEY) {
    apiUrl = "https://api.anthropic.com/v1/messages";
    apiKey = ENV_VARS.ANTHROPIC_API_KEY;
  } else if (provider === "openai" && ENV_VARS.OPENAI_API_KEY) {
    apiUrl = "https://api.openai.com/v1/chat/completions";
    apiKey = ENV_VARS.OPENAI_API_KEY;
  } else if (provider === "gemini" && ENV_VARS.GEMINI_API_KEY) {
    apiUrl = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";
    apiKey = ENV_VARS.GEMINI_API_KEY;
  } else if (provider === "deepseek" && ENV_VARS.DEEPSEEK_API_KEY) {
    apiUrl = "https://api.deepseek.com/v1/chat/completions";
    apiKey = ENV_VARS.DEEPSEEK_API_KEY;
  }

  if (apiUrl && apiKey) {
    sendEvent("log", { content: "Calling LLM: " + provider + "/" + model });

    const isGemini = provider === "gemini";
    try {
      const response = await fetch(apiUrl + (isGemini ? "?key=" + apiKey : ""), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(isGemini ? {} : { "Authorization": "Bearer " + apiKey }),
        },
        body: isGemini
          ? JSON.stringify({ contents: [{ parts: [{ text: PROMPT }] }] })
          : JSON.stringify({
              model: model,
              messages: [{ role: "user", content: PROMPT }],
              max_tokens: 4096,
            }),
      });

      if (response.ok) {
        const result = await response.json();
        const answer = isGemini
          ? result.candidates?.[0]?.content?.parts?.[0]?.text
          : result.choices?.[0]?.message?.content;

        sendEvent("message", { content: answer || "No response", role: "assistant" });
        sendEvent("status", {
          status: "completed",
          answerPreview: (answer || "").slice(0, 200),
          durationMs: Date.now() - startedAt,
        });
        agentStatus = "completed";
      } else {
        const errText = await response.text();
        sendEvent("log", { content: "LLM API error: " + response.status + " " + errText.slice(0, 200) });
        sendEvent("status", { status: "error", error: "LLM API error: " + response.status });
        agentStatus = "error";
      }
    } catch (err) {
      sendEvent("log", { content: "LLM fetch error: " + err.message });
      sendEvent("status", { status: "error", error: err.message });
      agentStatus = "error";
    }
  } else {
    sendEvent("log", { content: "No LLM credentials found for provider: " + provider });
    sendEvent("status", { status: "error", error: "No LLM credentials" });
    agentStatus = "error";
  }

  if (ws) try { ws.close(); } catch {}
}
`;
	}

	private async deployWorker(name: string, script: string): Promise<{ deployed: boolean; url?: string }> {
		const apiToken = this.config.apiToken ?? process.env.CLOUDFLARE_API_TOKEN;
		const accountId = this.config.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;

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
					// Enable workers.dev subdomain if not already
					await fetch(
						`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}/subdomain`,
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${apiToken}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({ enabled: true }),
						},
					).catch(() => {});
					// Get the workers.dev subdomain for this account
					let workersSubdomain = accountId;
					try {
						const subResp = await fetch(
							`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
							{ headers: { Authorization: `Bearer ${apiToken}` } },
						);
						if (subResp.ok) {
							const subData = (await subResp.json()) as { result?: { subdomain?: string } };
							workersSubdomain = subData.result?.subdomain ?? accountId;
						}
					} catch {}
					return { deployed: true, url: `https://${name}.${workersSubdomain}.workers.dev` };
				}
			} catch {}
		}

		// Fallback: wrangler CLI
		return new Promise((resolve) => {
			const tmpDir = `/tmp/cf-worker-${name}`;
			try {
				mkdirSync(tmpDir, { recursive: true });
				writeFileSync(join(tmpDir, "worker.js"), script);
				writeFileSync(
					join(tmpDir, "wrangler.jsonc"),
					JSON.stringify({
						name,
						main: "worker.js",
						compatibility_date: "2024-09-23",
						compatibility_flags: ["nodejs_compat"],
					}),
				);
			} catch {}

			// Find npx-cli.js — npx is a symlink to a node script, can't spawn directly
			const npxCliPath = findNpxCli();
			// Resolve symlinks — spawn doesn't follow them on macOS
			let nodePath = realpathSync(process.execPath);
			if (!existsSync(nodePath)) nodePath = "/usr/local/bin/node";
			if (!existsSync(nodePath)) nodePath = "node";
			const wranglerArgs = npxCliPath ? [npxCliPath, "wrangler", "deploy"] : ["wrangler", "deploy"];
			const wrangler = spawn(nodePath, wranglerArgs, {
				cwd: tmpDir,
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, CLOUDFLARE_API_TOKEN: apiToken ?? "", CLOUDFLARE_ACCOUNT_ID: accountId ?? "" },
			});
			let output = "";
			wrangler.stdout?.setEncoding("utf-8");
			wrangler.stdout?.on("data", (d: string) => (output += d));
			wrangler.stderr?.setEncoding("utf-8");
			wrangler.stderr?.on("data", (d: string) => (output += d));
			wrangler.on("error", (err) => {
				console.error("wrangler spawn error:", err.message);
				resolve({ deployed: false });
			});
			wrangler.on("exit", (code) => {
				if (code === 0) {
					// Try to extract URL from wrangler output first
					const urlMatch = output.match(/https:\/\/[^\s]+\.workers\.dev/);
					if (urlMatch) {
						resolve({ deployed: true, url: urlMatch[0] });
					} else if (this.config.workersSubdomain) {
						resolve({ deployed: true, url: `https://${name}.${this.config.workersSubdomain}.workers.dev` });
					} else {
						resolve({ deployed: true });
					}
				} else {
					console.error("wrangler deploy failed:", output.slice(-500));
					resolve({ deployed: false });
				}
			});
		});
	}

	private async destroyWorker(name: string): Promise<void> {
		const apiToken = this.config.apiToken ?? process.env.CLOUDFLARE_API_TOKEN;
		const accountId = this.config.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
		if (apiToken && accountId) {
			try {
				await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}`, {
					method: "DELETE",
					headers: { Authorization: `Bearer ${apiToken}` },
				});
			} catch {}
		}
	}
}

/** Find npx-cli.js so we can spawn it via node directly. */
function findNpxCli(): string | null {
	// Check common npm locations
	const candidates = [
		"/opt/homebrew/lib/node_modules/npm/bin/npx-cli.js",
		"/usr/local/lib/node_modules/npm/bin/npx-cli.js",
		join(homedir(), ".npm-global/lib/node_modules/npm/bin/npx-cli.js"),
		join(homedir(), ".nvm/versions/node", process.version, "lib/node_modules/npm/bin/npx-cli.js"),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	// Search PATH for npx, resolve symlink, find npx-cli.js relative to it
	for (const dir of (process.env.PATH ?? "").split(":")) {
		const npxPath = join(dir, "npx");
		if (existsSync(npxPath)) {
			try {
				const real = realpathSync(npxPath);
				const npmRoot = join(dirname(real), "..", "..", "lib", "node_modules", "npm", "bin", "npx-cli.js");
				if (existsSync(npmRoot)) return npmRoot;
				// Try relative to the symlink target
				const cli = join(dirname(real), "npx-cli.js");
				if (existsSync(cli)) return cli;
			} catch {}
		}
	}
	return null;
}
