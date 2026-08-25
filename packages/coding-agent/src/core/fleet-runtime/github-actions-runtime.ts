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
			includeCredentials: true,
			cwd: process.cwd(),
		};

		const bundleDir = await assembleBundle(bundleSpec);
		const tarPath = await tarBundle(bundleDir);

		// Read bundle contents for embedding in the workflow
		const envVars = JSON.parse(readFileSync(join(bundleDir, "agent", "env.json"), "utf-8")) as Record<string, string>;
		const settings = JSON.parse(readFileSync(join(bundleDir, "agent", "settings.json"), "utf-8")) as Record<
			string,
			unknown
		>;
		const prompt = readFileSync(join(bundleDir, "agent", "prompt.txt"), "utf-8");

		// Read the tarball as base64 for embedding in the workflow
		const tarBase64 = readFileSync(tarPath, "base64");

		// Generate the workflow YAML — the bundle is embedded as base64
		const workflowYaml = this.generateWorkflowYaml(identity, prompt, envVars, settings, tarBase64, request);

		// Deploy the workflow and trigger it
		const token = this.config.token ?? process.env.GITHUB_TOKEN ?? this.getGhToken();
		const repo = this.config.repo ?? this.detectRepo();

		if (!token) throw new Error("No GitHub token. Set GITHUB_TOKEN or run `gh auth login`.");
		if (!repo) throw new Error("No repo specified. Set repo in config or run from a git repo.");

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

	/**
	 * Generate the workflow YAML with the bundle embedded as base64.
	 * The runner decodes the bundle, extracts it, and runs run.sh.
	 */
	private generateWorkflowYaml(
		identity: AgentIdentity,
		_prompt: string,
		envVars: Record<string, string>,
		_settings: Record<string, unknown>,
		tarBase64: string,
		_request: SpawnRequest,
	): string {
		// The bundle is embedded as a base64-encoded tarball in a script step
		// We split it into chunks to avoid YAML line-length issues
		const chunkSize = 70000;
		const chunks: string[] = [];
		for (let i = 0; i < tarBase64.length; i += chunkSize) {
			chunks.push(tarBase64.slice(i, i + chunkSize));
		}

		const bundleScript = chunks.map((chunk) => `          echo '${chunk}' >> /tmp/bundle.b64`).join("\n");

		// Build YAML without template literals to avoid ${{ }} conflicts
		const lines: string[] = [
			// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions syntax
			"name: Prime Agent ${{ github.run_id }}",
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

		// Add env vars from secrets
		for (const k of Object.keys(envVars)) {
			lines.push(`      ${k}: \${{ secrets.${k} }}`);
		}

		lines.push(
			"    steps:",
			"      - name: Setup Node",
			"        uses: actions/setup-node@v4",
			"        with:",
			"          node-version: '22'",
			"",
			"      - name: Extract Agent Bundle",
			"        run: |",
		);

		// Add base64 chunks
		for (const line of bundleScript.split("\n")) {
			lines.push(line);
		}

		lines.push(
			"          base64 -d /tmp/bundle.b64 > /tmp/bundle.tar.gz",
			"          mkdir -p /tmp/agent-bundle",
			"          tar xzf /tmp/bundle.tar.gz -C /tmp/agent-bundle",
			"          BUNDLE_DIR=$(ls /tmp/agent-bundle)",
			'          echo "BUNDLE_DIR=/tmp/agent-bundle/$BUNDLE_DIR" >> $GITHUB_ENV',
			"",
			"      - name: Run Agent",
			"        run: |",
			"          bash $BUNDLE_DIR/run.sh",
			"        env:",
			`          AGENT_ID: ${identity.agentId}`,
		);

		// Add actual env var values for the run step
		for (const [k, v] of Object.entries(envVars)) {
			lines.push(`          ${k}: "${v.replace(/"/g, '\\"')}"`);
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
			"            $HOME/.prime/agent/sessions/",
			"            /tmp/agent-bundle/",
		);

		return `${lines.join("\n")}\n`;
	}

	private getGhToken(): string | undefined {
		try {
			const { execSync } = require("node:child_process");
			return execSync("gh auth token", { encoding: "utf-8" }).trim() || undefined;
		} catch {
			return undefined;
		}
	}

	private detectRepo(): string | undefined {
		try {
			const { execSync } = require("node:child_process");
			const remote = execSync("git remote get-url origin", { encoding: "utf-8" }).trim();
			const match = remote.match(/github\.com[:/]([^/]+\/[^/\s]+)/);
			return match?.[1]?.replace(/\.git$/, "");
		} catch {
			return undefined;
		}
	}

	private async triggerWorkflow(repo: string, token: string, workflowYaml: string, agentId: string): Promise<number> {
		// Create a workflow file in the repo and trigger it
		const branch = `agent-${agentId.slice(0, 8)}`;
		const workflowFile = `.github/workflows/agent-${agentId.slice(0, 8)}.yml`;

		// Get the default branch SHA
		const repoResp = await fetch(`https://api.github.com/repos/${repo}`, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
		});
		const repoData = (await repoResp.json()) as { default_branch: string };
		const defaultBranch = repoData.default_branch;

		// Get the SHA of the default branch
		const refResp = await fetch(`https://api.github.com/repos/${repo}/git/refs/heads/${defaultBranch}`, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
		});
		const refData = (await refResp.json()) as { object: { sha: string } };
		const baseSha = refData.object.sha;

		// Create a new branch
		await fetch(`https://api.github.com/repos/${repo}/git/refs`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
			body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
		});

		// Create the workflow file on the branch
		await fetch(`https://api.github.com/repos/${repo}/contents/${workflowFile}`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
			body: JSON.stringify({
				message: `Deploy agent ${agentId.slice(0, 8)}`,
				content: Buffer.from(workflowYaml).toString("base64"),
				branch,
			}),
		});

		// Trigger workflow_dispatch
		const triggerResp = await fetch(
			`https://api.github.com/repos/${repo}/actions/workflows/${workflowFile.split("/").pop()}/dispatches`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
				body: JSON.stringify({ ref: branch, inputs: { agent_id: agentId } }),
			},
		);

		if (!triggerResp.ok) {
			throw new Error(`Failed to trigger workflow: ${triggerResp.status}`);
		}

		// Poll for the run ID
		await new Promise((r) => setTimeout(r, 3000));
		const runsResp = await fetch(`https://api.github.com/repos/${repo}/actions/runs?branch=${branch}&per_page=1`, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
		});
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
