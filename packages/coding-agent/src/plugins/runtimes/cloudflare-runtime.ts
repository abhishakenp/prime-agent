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

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type AgentIdentitySpec, assembleBundle, type BundleSpec } from "../../core/fleet-runtime/agent-bundle.js";
import type {
	AgentEvent,
	AgentIdentity,
	AgentRuntime,
	AgentStatus,
	AgentStatusEndpoint,
	AgentStatusInfo,
	SpawnRequest,
	SpawnResult,
} from "../../core/fleet-runtime/agent-runtime.js";
import {
	ensureAccount,
	isProvisionerAlive,
	type LeasedAccount,
	releaseAccount,
} from "../../core/fleet-runtime/provisioner-client.js";

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
							// Release account back to pool when done
							if (
								this.leasedCfAccount &&
								(currentStatus.status === "completed" ||
									currentStatus.status === "error" ||
									currentStatus.status === "aborted")
							) {
								await releaseAccount("cloudflare-workers", this.leasedCfAccount.email).catch(() => {});
								this.leasedCfAccount = null;
							}
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
				if (this.leasedCfAccount) {
					await releaseAccount("cloudflare-workers", this.leasedCfAccount.email).catch(() => {});
					this.leasedCfAccount = null;
				}
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
let agentError = null;
let agentAnswer = null;

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
          error: agentError,
          answer: agentAnswer,
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
  const model = MODEL || SETTINGS.defaultModel || "";
  // Auto-detect provider from model name if not explicitly set
  let provider = SETTINGS.defaultProvider || "";
  if (!provider || provider === "openrouter") {
    // Check if model matches a known provider pattern
    if (model.startsWith("gemini-") && ENV_VARS.GEMINI_API_KEY) {
      provider = "gemini";
    } else if (model.startsWith("deepseek") && ENV_VARS.DEEPSEEK_API_KEY) {
      provider = "deepseek";
    } else if (model.startsWith("claude") && ENV_VARS.ANTHROPIC_API_KEY) {
      provider = "anthropic";
    } else if (model.startsWith("gpt") && ENV_VARS.OPENAI_API_KEY) {
      provider = "openai";
    } else if (ENV_VARS.OPENROUTER_API_KEY) {
      provider = "openrouter";
    }
  }

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

        agentAnswer = answer || "No response";
        sendEvent("message", { content: agentAnswer, role: "assistant" });
        sendEvent("status", {
          status: "completed",
          answerPreview: (agentAnswer || "").slice(0, 200),
          durationMs: Date.now() - startedAt,
        });
        agentStatus = "completed";
      } else {
        const errText = await response.text();
        agentError = "LLM API error: " + response.status + " " + errText.slice(0, 500);
        console.error(agentError);
        sendEvent("log", { content: agentError });
        sendEvent("status", { status: "error", error: agentError });
        agentStatus = "error";
      }
    } catch (err) {
      agentError = "LLM fetch error: " + err.message;
      console.error(agentError);
      sendEvent("log", { content: agentError });
      sendEvent("status", { status: "error", error: agentError });
      agentStatus = "error";
    }
  } else {
    agentError = "No LLM credentials found for provider: " + provider;
    console.error(agentError);
    sendEvent("log", { content: agentError });
    sendEvent("status", { status: "error", error: agentError });
    agentStatus = "error";
  }

  if (ws) try { ws.close(); } catch {}
}
`;
	}

	private leasedCfAccount: LeasedAccount | null = null;

	private async deployWorker(name: string, script: string): Promise<{ deployed: boolean; url?: string }> {
		let apiToken = this.config.apiToken ?? process.env.CLOUDFLARE_API_TOKEN ?? this.getWranglerToken();
		let accountId = this.config.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;

		// Multi-account: if no config, try leasing from provisioner pool
		if ((!apiToken || !accountId) && (await isProvisionerAlive())) {
			try {
				this.leasedCfAccount = await ensureAccount("cloudflare-workers");
				apiToken = this.leasedCfAccount.apiKey;
				accountId = (this.leasedCfAccount.metadata?.accountId as string) || accountId;
			} catch (err) {
				console.error(`[cloudflare] Provisioner lease failed: ${err}`);
			}
		}

		if (apiToken && accountId) {
			try {
				const metadata = JSON.stringify({
					main_module: "worker.js",
					compatibility_date: "2024-09-23",
					compatibility_flags: ["nodejs_compat"],
				});
				const formData = new FormData();
				formData.append("worker.js", new Blob([script], { type: "application/javascript+module" }), "worker.js");
				formData.append("metadata", new Blob([metadata], { type: "application/json" }), "metadata");

				const resp = await fetch(
					`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}`,
					{
						method: "PUT",
						headers: { Authorization: `Bearer ${apiToken}` },
						body: formData,
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
		const apiToken = this.config.apiToken ?? process.env.CLOUDFLARE_API_TOKEN ?? this.getWranglerToken();
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

	private getWranglerToken(): string | undefined {
		try {
			const configPath = join(homedir(), "Library/Preferences/.wrangler/config/default.toml");
			if (!existsSync(configPath)) return undefined;
			const content = readFileSync(configPath, "utf-8");
			const match = content.match(/oauth_token\s*=\s*"([^"]+)"/);
			return match?.[1];
		} catch {
			return undefined;
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

// ─── Plugin setup (interactive) ────────────────────────────────────

/**
 * Interactive setup for the Cloudflare Workers runtime.
 *
 * Flow:
 * 1. Check if wrangler is authenticated (`wrangler whoami`)
 * 2. If not, prompt to run `wrangler login` (opens browser)
 * 3. Extract account ID from wrangler whoami output
 * 4. Check for workers.dev subdomain
 * 5. Save accountId + apiToken (if available) to config
 *
 * Called when the user enables/installs the plugin from the fleet menu.
 */
export async function setupCloudflare(
	config: Record<string, unknown>,
	prompt: {
		ask: (q: string, def?: string) => Promise<string | undefined>;
		confirm: (q: string, def?: boolean) => Promise<boolean>;
		choose: (q: string, options: string[]) => Promise<number>;
		status: (msg: string) => void;
	},
): Promise<{ success: boolean; message: string; config?: Record<string, unknown> }> {
	const newConfig = { ...config };

	// 1. Check wrangler auth
	prompt.status("Checking Cloudflare authentication...");
	let authed = false;
	let whoamiOutput = "";
	try {
		whoamiOutput = execSync("npx wrangler whoami 2>&1", {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 15000,
		});
		authed = !whoamiOutput.includes("not authenticated") && !whoamiOutput.includes("ERR");
	} catch (err) {
		// wrangler whoami may exit non-zero if not logged in
		try {
			const output = (err as { stdout?: string }).stdout ?? "";
			if (!output.includes("not authenticated")) {
				whoamiOutput = output;
				authed = true;
			}
		} catch {}
	}

	if (!authed) {
		prompt.status("Not logged in to Cloudflare.");
		const confirmed = await prompt.confirm("Open Cloudflare login in browser? (runs: npx wrangler login)", true);
		if (confirmed) {
			prompt.status("Running: npx wrangler login (follow prompts in browser)...");
			prompt.status("Waiting for browser callback on localhost:8976...");
			try {
				// Use spawn (async) instead of execSync so the event loop isn't blocked
				// and the callback server can properly handle the browser redirect
				await new Promise<void>((resolve, reject) => {
					const child = spawn("npx", ["wrangler", "login"], {
						stdio: "inherit",
						env: { ...process.env },
						timeout: 120000,
					});
					child.on("error", reject);
					child.on("exit", (code) => {
						if (code === 0) resolve();
						else reject(new Error(`wrangler login exited with code ${code}`));
					});
				});
				// Re-check auth
				whoamiOutput = execSync("npx wrangler whoami 2>&1", {
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
					timeout: 15000,
				});
				authed = !whoamiOutput.includes("not authenticated");
			} catch (err) {
				return {
					success: false,
					message: `Cloudflare login failed: ${err instanceof Error ? err.message : String(err)}. Run \`npx wrangler login\` manually and retry.`,
				};
			}
		} else {
			return {
				success: false,
				message: "Cloudflare login required. Run `npx wrangler login` and retry.",
			};
		}
	}

	if (!authed) {
		return { success: false, message: "Cloudflare authentication failed." };
	}

	// 2. Extract account ID from whoami output
	prompt.status("Extracting account info...");
	let accountId: string | undefined = newConfig.accountId as string | undefined;
	if (!accountId) {
		// wrangler whoami output format: "│ Account Name │ 123abc... │"
		const accountMatch = whoamiOutput.match(/│\s+\S.*?\s+│\s+([a-f0-9]{32})\s+│/);
		if (accountMatch) {
			accountId = accountMatch[1];
			newConfig.accountId = accountId;
		} else {
			// Try to extract any 32-char hex
			const hexMatch = whoamiOutput.match(/([a-f0-9]{32})/);
			if (hexMatch) {
				accountId = hexMatch[1];
				newConfig.accountId = accountId;
			}
		}
	}

	// 3. Check for API token (optional — wrangler login may suffice)
	if (!newConfig.apiToken) {
		const hasToken = await prompt.confirm(
			"Do you have a Cloudflare API token? (Optional if wrangler login works. Needed for headless/CI.)",
			false,
		);
		if (hasToken) {
			const token = await prompt.ask("Enter Cloudflare API token:");
			if (token) {
				newConfig.apiToken = token;
			}
		}
	}

	// 4. Check for workers.dev subdomain
	if (!newConfig.workersSubdomain) {
		prompt.status("Checking workers.dev subdomain...");
		try {
			const subdomainOutput = execSync("npx wrangler whoami 2>&1", {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 15000,
			});
			// Look for workers.dev subdomain in output
			const subdomainMatch = subdomainOutput.match(/([\w-]+)\.workers\.dev/);
			if (subdomainMatch) {
				newConfig.workersSubdomain = subdomainMatch[1];
			}
		} catch {}

		if (!newConfig.workersSubdomain) {
			const subdomain = await prompt.ask(
				"Enter your workers.dev subdomain (e.g. 'my-name' for my-name.workers.dev):",
			);
			if (subdomain) {
				newConfig.workersSubdomain = subdomain;
			}
		}
	}

	// 5. List existing Workers and offer: create new, pick existing, or skip
	if (!newConfig.workerName) {
		prompt.status("Fetching your Cloudflare Workers...");
		let workerNames: string[] = [];
		try {
			const wranglerConfigPath = join(homedir(), "Library", "Preferences", ".wrangler", "config", "default.toml");
			let apiToken = newConfig.apiToken as string | undefined;

			// If no API token, try wrangler's OAuth token
			if (!apiToken) {
				try {
					const configContent = readFileSync(wranglerConfigPath, "utf-8");
					const tokenMatch = configContent.match(/oauth_token\s*=\s*"([^"]+)"/);
					if (tokenMatch) apiToken = tokenMatch[1];
				} catch {}
			}

			if (apiToken && accountId) {
				const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`;
				const response = await fetch(apiUrl, {
					headers: { Authorization: `Bearer ${apiToken}` },
				});
				if (response.ok) {
					const data = (await response.json()) as {
						success: boolean;
						result?: { id: string; modified_on?: string }[];
					};
					if (data.success && data.result) {
						workerNames = data.result.map((w) => w.id);
					}
				}
			}
		} catch {
			// API call failed — skip worker listing
		}

		const options = ["Create a new Worker (default name: prime-agent-gateway)"];
		const workerOffset = options.length;
		for (const name of workerNames) {
			options.push(`Use existing Worker: ${name}`);
		}
		options.push("Skip (configure Worker name later)");

		const choice = await prompt.choose(
			"Cloudflare runtime needs a Worker for the agent gateway. What do you want to do?",
			options,
		);

		if (choice === 0) {
			// Create new Worker
			const workerName = await prompt.ask("Worker name:", "prime-agent-gateway");
			if (workerName) {
				newConfig.workerName = workerName;
			}
		} else if (choice >= workerOffset && choice < workerOffset + workerNames.length) {
			// Pick existing Worker
			newConfig.workerName = workerNames[choice - workerOffset];
		}
		// choice === last → skip, don't set workerName
	}

	const parts: string[] = [];
	if (accountId) parts.push(`account: ${accountId}`);
	if (newConfig.workersSubdomain) parts.push(`subdomain: ${newConfig.workersSubdomain}`);
	if (newConfig.workerName) parts.push(`worker: ${newConfig.workerName}`);
	if (newConfig.apiToken) parts.push("API token set");

	return {
		success: true,
		message: `Cloudflare runtime configured (${parts.join(", ")})`,
		config: newConfig,
	};
}
