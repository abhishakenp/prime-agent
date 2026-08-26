/**
 * GitHub Actions runtime adapter — deploys self-contained agent bundles as workflow runs.
 *
 * The bundle is committed to a temp branch or uploaded as a workflow artifact.
 * The workflow:
 * - Checks out the bundle
 * - Runs ./run.sh
 * - Uploads results as artifacts
 *
 * Spin-up: ~10-30s (runner allocation)
 * The target (GH Actions) needs nothing — the bundle IS the workflow.
 */

import { execSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

export interface GitHubActionsRuntimeConfig {
	token?: string;
	repo?: string;
	gatewayUrl?: string;
	gatewayAuthToken?: string;
}

export class GitHubActionsRuntime implements AgentRuntime {
	readonly platform = "github-actions";
	private readonly config: GitHubActionsRuntimeConfig;

	constructor(config: GitHubActionsRuntimeConfig = {}) {
		this.config = config;
	}

	canSpawn(host: string): boolean {
		return host === "github-actions" || host === "github" || host === "gha" || host.startsWith("github:");
	}

	async spawn(request: SpawnRequest): Promise<SpawnResult> {
		const agentId = crypto.randomUUID();
		const sessionDir = request.workDir ?? `.prime/agent/sessions/gha/${agentId}`;

		const identity: AgentIdentity = {
			agentId,
			host: "github-actions",
			sessionDir,
			model: request.model ?? "default",
			label: request.name ?? request.prompt.slice(0, 60),
			depth: request.depth,
			parentAgentId: request.parent?.agentId,
		};

		// Assemble the bundle
		const identitySpec: AgentIdentitySpec = {
			agentId,
			host: "github-actions",
			hardwareId: "github-runner",
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
			// Credentials are NOT embedded in the tarball — they're passed via GitHub secrets
			includeCredentials: false,
			cwd: process.cwd(),
		};

		const bundleDir = await assembleBundle(bundleSpec);
		const tarPath = await tarBundle(bundleDir);

		// Read bundle contents
		const settings = JSON.parse(readFileSync(join(bundleDir, "agent", "settings.json"), "utf-8")) as Record<
			string,
			unknown
		>;
		const prompt = readFileSync(join(bundleDir, "agent", "prompt.txt"), "utf-8");

		// Collect credential key names from the local environment
		const credentialKeys = this.collectCredentialKeys();

		// Upload the bundle as a GitHub Gist (avoids 3.8MB YAML issue)
		const gistUrl = await this.uploadBundleGist(tarPath, agentId);

		// Generate a small workflow YAML that downloads the bundle from the Gist
		const workflowYaml = this.generateWorkflowYaml(identity, prompt, credentialKeys, settings, gistUrl, request);

		// Deploy the workflow and trigger it
		const token = this.config.token ?? process.env.GITHUB_TOKEN ?? this.getGhToken();
		// Use config repo (dedicated runs repo) — do NOT fall back to cwd repo.
		// The setup() flow creates a dedicated private repo for agent runs.
		const repo = this.config.repo;

		if (!token) throw new Error("No GitHub token. Set GITHUB_TOKEN or run `gh auth login`.");
		if (!repo)
			throw new Error(
				"No repo configured. Run `prime-agent fleet runtimes install github-actions` to set up a dedicated repo.",
			);

		// Set credentials as GitHub repository secrets (not embedded in YAML)
		await this.setRepositorySecrets(repo, token, credentialKeys);

		const runId = await this.triggerWorkflow(repo, token, workflowYaml, agentId);

		let currentStatus: AgentStatusInfo = { status: "running" };
		const eventListeners = new Set<(event: AgentEvent) => void>();

		// Start polling for status
		this.pollRunStatus(repo, token, runId, (status, info) => {
			currentStatus = info;
			for (const listener of eventListeners) {
				listener({ type: "status", status, info });
			}
		});

		const statusEndpoint: AgentStatusEndpoint = {
			poll: async () => currentStatus,
			subscribe: (listener) => {
				eventListeners.add(listener);
				return () => eventListeners.delete(listener);
			},
			abort: async () => {
				currentStatus = { ...currentStatus, status: "aborted", error: "Aborted by parent" };
				await this.cancelRun(repo, token, runId);
				for (const listener of eventListeners) {
					listener({ type: "status", status: "aborted", info: currentStatus });
				}
			},
			requestFile: async (path) => {
				const artifacts = await this.downloadArtifacts(repo, token, runId);
				return artifacts[path] ?? "";
			},
			sendFile: async () => {
				// GH Actions doesn't support sending files to a running workflow
				throw new Error("Cannot send files to a running GitHub Actions workflow");
			},
		};

		return { identity, statusEndpoint };
	}

	/** Upload the bundle tarball as a secret Gist and return the raw URL. */
	private async uploadBundleGist(tarPath: string, agentId: string): Promise<string> {
		const tarBase64 = readFileSync(tarPath, "base64");
		const filename = `bundle-${agentId.slice(0, 8)}.tar.gz.b64`;

		const resp = await fetch("https://api.github.com/gists", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.getGhToken()}`,
				Accept: "application/vnd.github+json",
			},
			body: JSON.stringify({
				description: `Prime Agent bundle ${agentId.slice(0, 8)}`,
				public: false,
				files: {
					[filename]: { content: tarBase64 },
				},
			}),
		});

		if (!resp.ok) {
			throw new Error(`Failed to upload gist: ${resp.status}`);
		}

		const data = (await resp.json()) as { files: Record<string, { raw_url: string }> };
		return data.files[filename].raw_url;
	}

	private generateWorkflowYaml(
		identity: AgentIdentity,
		_prompt: string,
		credentialKeys: string[],
		_settings: Record<string, unknown>,
		gistUrl: string,
		_request: SpawnRequest,
	): string {
		const lines: string[] = [
			"name: Prime Agent",
			"on:",
			"  workflow_dispatch:",
			"    inputs:",
			"      agent_id:",
			"        description: 'Agent ID'",
			"        required: true",
			`        default: '${identity.agentId}'`,
			"",
			"jobs:",
			"  agent:",
			"    runs-on: ubuntu-latest",
			"    env:",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions syntax
			"      AGENT_ID: ${{ github.event.inputs.agent_id }}",
		];

		for (const k of credentialKeys) {
			lines.push(`      ${k}: \${{ secrets.${k} }}`);
		}

		lines.push(
			"    steps:",
			"      - name: Setup Node",
			"        uses: actions/setup-node@v4",
			"        with:",
			"          node-version: '22'",
			"",
			"      - name: Download and Extract Agent Bundle",
			"        run: |",
			`          curl -sL "${gistUrl}" -o /tmp/bundle.b64`,
			"          base64 -d /tmp/bundle.b64 > /tmp/bundle.tar.gz",
			"          mkdir -p /tmp/agent-bundle",
			"          tar xzf /tmp/bundle.tar.gz -C /tmp/agent-bundle",
			"          BUNDLE_DIR=$(ls /tmp/agent-bundle)",
			'          echo "BUNDLE_DIR=/tmp/agent-bundle/$BUNDLE_DIR" >> $GITHUB_ENV',
			"          mkdir -p $BUNDLE_DIR/agent",
			`          BUNDLE_DIR=$BUNDLE_DIR node -e 'const fs=require("fs");const keys=${JSON.stringify(credentialKeys)};const env={};for(const k of keys){env[k]=process.env[k]||"";}fs.writeFileSync(process.env.BUNDLE_DIR+"/agent/env.json",JSON.stringify(env,null,2));'`,
			"",
			"      - name: Run Agent",
			"        run: |",
			"          bash $BUNDLE_DIR/run.sh",
			"        env:",
			`          AGENT_ID: ${identity.agentId}`,
		);

		for (const k of credentialKeys) {
			lines.push(`          ${k}: \${{ secrets.${k} }}`);
		}

		lines.push(
			"",
			"      - name: Upload Results",
			"        if: always()",
			"        uses: actions/upload-artifact@v4",
			"        with:",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions syntax
			"          name: agent-results-${{ github.run_id }}",
			"          path: |",
			"            /tmp/agent-bundle/",
		);

		return `${lines.join("\n")}\n`;
	}

	private getGhToken(): string | undefined {
		try {
			return execSync("gh auth token", { encoding: "utf-8" }).trim() || undefined;
		} catch {
			return undefined;
		}
	}

	/** Collect API key names from the local environment — values are NOT embedded. */
	private collectCredentialKeys(): string[] {
		const keyPatterns = [/.*_API_KEY$/, /.*_TOKEN$/, /.*_SECRET$/, /.*_OAUTH_TOKEN$/];
		return Object.keys(process.env)
			.filter((k) => keyPatterns.some((p) => p.test(k)) && process.env[k])
			.slice(0, 20); // Limit to avoid hitting GitHub secret limits
	}

	/** Set credentials as GitHub repository secrets using gh CLI. */
	private async setRepositorySecrets(repo: string, _token: string, keys: string[]): Promise<void> {
		for (const keyName of keys) {
			const value = process.env[keyName];
			if (!value) continue;
			try {
				execSync(`gh secret set ${keyName} --repo ${repo}`, {
					input: value,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
					env: process.env,
				});
			} catch (err) {
				console.error(`Failed to set secret ${keyName}:`, err);
			}
		}
	}

	// detectRepo() removed — GitHub Actions runtime now requires a dedicated
	// repo configured via setup(). No more cwd repo fallback.

	private async triggerWorkflow(repo: string, token: string, workflowYaml: string, agentId: string): Promise<number> {
		// Push workflow to the default branch (required for workflow_dispatch)
		const workflowFile = `.github/workflows/agent-${agentId.slice(0, 8)}.yml`;

		// Get the default branch
		const repoResp = await fetch(`https://api.github.com/repos/${repo}`, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
		});
		const repoData = (await repoResp.json()) as { default_branch: string };
		const defaultBranch = repoData.default_branch;

		// Create or update the workflow file on the default branch
		// First check if it already exists
		const checkResp = await fetch(
			`https://api.github.com/repos/${repo}/contents/${workflowFile}?ref=${defaultBranch}`,
			{
				headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
			},
		);
		const existingSha = checkResp.ok ? ((await checkResp.json()) as { sha?: string }).sha : undefined;

		const fileResp = await fetch(`https://api.github.com/repos/${repo}/contents/${workflowFile}`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
			body: JSON.stringify({
				message: `Deploy agent ${agentId.slice(0, 8)}`,
				content: Buffer.from(workflowYaml).toString("base64"),
				branch: defaultBranch,
				...(existingSha ? { sha: existingSha } : {}),
			}),
		});
		if (!fileResp.ok) {
			const errText = await fileResp.text();
			throw new Error(`Failed to create workflow file: ${fileResp.status} ${errText}`);
		}

		// Wait for GitHub to index the workflow
		await new Promise((r) => setTimeout(r, 15000));

		// Trigger workflow_dispatch on the default branch
		const workflowFilename = workflowFile.split("/").pop();
		const triggerResp = await fetch(
			`https://api.github.com/repos/${repo}/actions/workflows/${workflowFilename}/dispatches`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
				body: JSON.stringify({ ref: defaultBranch, inputs: { agent_id: agentId } }),
			},
		);

		if (!triggerResp.ok) {
			const errText = await triggerResp.text();
			throw new Error(`Failed to trigger workflow: ${triggerResp.status} ${errText}`);
		}

		// Poll for the run ID
		await new Promise((r) => setTimeout(r, 5000));
		const runsResp = await fetch(
			`https://api.github.com/repos/${repo}/actions/workflows/${workflowFilename}/runs?per_page=1`,
			{ headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
		);
		const runsData = (await runsResp.json()) as { workflow_runs: Array<{ id: number }> };
		return runsData.workflow_runs[0]?.id ?? 0;
	}

	private async pollRunStatus(
		repo: string,
		token: string,
		runId: number,
		callback: (status: AgentStatus, info: AgentStatusInfo) => void,
	): Promise<void> {
		const startTime = Date.now();
		const poll = async () => {
			if (!runId) return;
			try {
				const resp = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}`, {
					headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
				});
				if (!resp.ok) return;
				const data = (await resp.json()) as {
					status: string;
					conclusion: string | null;
					created_at: string;
				};

				const statusMap: Record<string, AgentStatus> = {
					queued: "running",
					in_progress: "running",
					completed: data.conclusion === "success" ? "completed" : "error",
				};
				const status = statusMap[data.status] ?? "running";
				const info: AgentStatusInfo = {
					status,
					durationMs: Date.now() - startTime,
					error: data.conclusion && data.conclusion !== "success" ? `Workflow ${data.conclusion}` : undefined,
				};
				callback(status, info);

				if (data.status !== "completed") {
					setTimeout(poll, 5000);
				}
			} catch {}
		};
		setTimeout(poll, 3000);
	}

	private async cancelRun(repo: string, token: string, runId: number): Promise<void> {
		if (!runId) return;
		try {
			await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/cancel`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
			});
		} catch {}
	}

	private async downloadArtifacts(repo: string, token: string, runId: number): Promise<Record<string, string>> {
		if (!runId) return {};
		try {
			const resp = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/artifacts`, {
				headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
			});
			const data = (await resp.json()) as { artifacts: Array<{ name: string; archive_download_url: string }> };
			const files: Record<string, string> = {};
			for (const artifact of data.artifacts) {
				const dlResp = await fetch(artifact.archive_download_url, {
					headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
				});
				if (dlResp.ok) {
					// Would need to unzip and read — placeholder
					files[artifact.name] = "artifact downloaded";
				}
			}
			return files;
		} catch {
			return {};
		}
	}
}

// ─── Plugin setup (interactive) ────────────────────────────────────

/**
 * Interactive setup for the GitHub Actions runtime.
 *
 * Flow:
 * 1. Check `gh auth status` — if not logged in, prompt user to run `gh auth login`
 * 2. Check for a dedicated repo in config — if missing, offer to create one or use existing
 * 3. Create a private repo (default: `prime-agent-runs`) if user chooses
 * 4. Save repo + token to config
 *
 * This is called when the user enables/installs the plugin from the fleet menu.
 * It does NOT use the current working directory's repo — agents need a dedicated
 * private repo to avoid polluting other repos' config and workflow history.
 */
export async function setupGitHubActions(
	config: Record<string, unknown>,
	prompt: {
		ask: (q: string, def?: string) => Promise<string | undefined>;
		confirm: (q: string, def?: boolean) => Promise<boolean>;
		choose: (q: string, options: string[]) => Promise<number>;
		status: (msg: string) => void;
	},
): Promise<{ success: boolean; message: string; config?: Record<string, unknown> }> {
	const newConfig = { ...config };

	// 1. Check gh auth
	prompt.status("Checking GitHub authentication...");
	let authed = false;
	try {
		const output = execSync("gh auth status 2>&1", {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		// gh auth status may exit non-zero if one account is invalid,
		// but as long as one account is active, we're authed
		authed = output.includes("✓ Logged in") && output.includes("Active account: true");
	} catch (err) {
		// Check stdout even on failure — gh may exit 1 with valid auth
		const output = (err as { stdout?: string }).stdout ?? "";
		authed = output.includes("✓ Logged in") && output.includes("Active account: true");
	}

	if (!authed) {
		prompt.status("Not logged in to GitHub. Please run: gh auth login");
		const confirmed = await prompt.confirm("Open GitHub login in browser? (runs: gh auth login --web)", true);
		if (confirmed) {
			prompt.status("Running: gh auth login --web (follow prompts in terminal)...");
			try {
				// Use spawn (async) so the event loop isn't blocked and
				// interactive prompts from gh auth login work properly
				await new Promise<void>((resolve, reject) => {
					const child = spawn("gh", ["auth", "login", "--web"], {
						stdio: "inherit",
						env: { ...process.env },
					});
					child.on("error", reject);
					child.on("exit", (code) => {
						if (code === 0) resolve();
						else reject(new Error(`gh auth login exited with code ${code}`));
					});
				});
				authed = true;
			} catch (err) {
				return {
					success: false,
					message: `GitHub login failed: ${err instanceof Error ? err.message : String(err)}. Run \`gh auth login\` manually and retry.`,
				};
			}
		} else {
			return {
				success: false,
				message: "GitHub login required. Run `gh auth login` and retry.",
			};
		}
	}

	// 2. Get token
	let token: string | undefined;
	try {
		token = execSync("gh auth token", { encoding: "utf-8" }).trim();
	} catch {}

	if (!token) {
		return { success: false, message: "Could not get GitHub token. Run `gh auth login`." };
	}

	// 3. Check for existing repo in config
	const existingRepo = newConfig.repo as string | undefined;
	if (existingRepo) {
		// Verify repo exists and user has write access
		prompt.status(`Checking repo ${existingRepo}...`);
		try {
			const resp = execSync(`gh repo view ${existingRepo} --json name,visibility,viewerPermission`, {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			const info = JSON.parse(resp) as {
				name: string;
				visibility: string;
				viewerPermission: string;
			};
			if (info.viewerPermission === "READ" || info.viewerPermission === "TRIAGE") {
				const overwrite = await prompt.confirm(
					`Repo ${existingRepo} is ${info.visibility} with ${info.viewerPermission} access. Use anyway?`,
					false,
				);
				if (!overwrite) {
					// Fall through to repo selection
				} else {
					newConfig.token = token;
					return {
						success: true,
						message: `GitHub Actions runtime configured with repo: ${existingRepo}`,
						config: newConfig,
					};
				}
			} else {
				newConfig.token = token;
				return {
					success: true,
					message: `GitHub Actions runtime configured with repo: ${existingRepo} (${info.visibility})`,
					config: newConfig,
				};
			}
		} catch {
			prompt.status(`Repo ${existingRepo} not accessible. Let's set up a new one.`);
		}
	}

	// 4. Offer: create new repo (public or private), or use existing
	const choice = await prompt.choose("GitHub Actions needs a dedicated repo for agent runs. What do you want to do?", [
		"Create a new public repo (unlimited Actions compute)",
		"Create a new private repo (limited but hidden)",
		"Use an existing repo (enter name)",
	]);

	if (choice === 0 || choice === 1) {
		// Create new repo
		const isPublic = choice === 0;
		const defaultName = "prime-agent-runs";
		const repoName = await prompt.ask("Repo name:", defaultName);
		if (!repoName) {
			return { success: false, message: "Setup cancelled" };
		}

		// Get username
		let username: string | undefined;
		try {
			username = execSync("gh api user --jq .login", { encoding: "utf-8" }).trim();
		} catch {
			return { success: false, message: "Could not get GitHub username. Run `gh auth login`." };
		}

		const fullRepo = `${username}/${repoName}`;
		const visibilityFlag = isPublic ? "--public" : "--private";
		prompt.status(`Creating ${isPublic ? "public" : "private"} repo ${fullRepo}...`);

		try {
			execSync(`gh repo create ${repoName} ${visibilityFlag} --description "Prime Agent runtime runs"`, {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (err) {
			// Repo might already exist
			const exists = await prompt.confirm(
				`Could not create repo (may already exist). Use ${fullRepo} anyway?`,
				true,
			);
			if (!exists) {
				return { success: false, message: `Repo creation failed: ${err}` };
			}
		}

		newConfig.repo = fullRepo;
		newConfig.token = token;
		return {
			success: true,
			message: `Created ${isPublic ? "public" : "private"} repo ${fullRepo} for GitHub Actions runs`,
			config: newConfig,
		};
	} else if (choice === 2) {
		// Use existing repo
		const repoInput = await prompt.ask("Enter repo (owner/name):");
		if (!repoInput) {
			return { success: false, message: "Setup cancelled" };
		}

		// Verify access
		prompt.status(`Checking repo ${repoInput}...`);
		try {
			const resp = execSync(`gh repo view ${repoInput} --json name,visibility,viewerPermission`, {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			const info = JSON.parse(resp) as { visibility: string; viewerPermission: string };
			if (info.viewerPermission === "READ" || info.viewerPermission === "TRIAGE") {
				return {
					success: false,
					message: `No write access to ${repoInput}. Choose a repo you own or have admin access to.`,
				};
			}
			if (info.visibility === "PUBLIC") {
				const confirmPublic = await prompt.confirm(
					`${repoInput} is public. Public repos have unlimited Actions runs but anyone can see workflow files. Continue?`,
					false,
				);
				if (!confirmPublic) {
					return { success: false, message: "Setup cancelled" };
				}
			}
		} catch {
			return { success: false, message: `Could not access repo ${repoInput}. Check the name and your access.` };
		}

		newConfig.repo = repoInput;
		newConfig.token = token;
		return {
			success: true,
			message: `GitHub Actions runtime configured with repo: ${repoInput}`,
			config: newConfig,
		};
	}

	return { success: false, message: "Setup cancelled" };
}
