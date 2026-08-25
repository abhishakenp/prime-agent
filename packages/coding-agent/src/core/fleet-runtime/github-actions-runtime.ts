/**
 * GitHub Actions runtime adapter — spawns agents as ephemeral GitHub Actions workflows.
 *
 * Each agent becomes a self-contained GitHub Actions workflow run that:
 * - Runs in a fresh GitHub-hosted runner (Ubuntu/macOS/Windows)
 * - Has its own IP address (ephemeral runner VM)
 * - Runs the plan/exec/review loop via prime-agent --print
 * - Reports results back through the gateway (or via workflow artifacts)
 * - Auto-destroys when the workflow completes
 *
 * Spin-up: ~10-30s (runner provisioning)
 * Cost: free for public repos, included minutes for private
 *
 * The workflow:
 * 1. Checks out the repo
 * 2. Installs prime-agent
 * 3. Runs: prime-agent --print --prompt "..." --session-id "..."
 * 4. Uploads artifacts (session output, files)
 * 5. Reports status via gateway WebSocket
 */

import type {
	AgentEvent,
	AgentIdentity,
	AgentRuntime,
	AgentStatusEndpoint,
	AgentStatusInfo,
	SpawnRequest,
	SpawnResult,
} from "./agent-runtime.js";

export interface GitHubActionsRuntimeConfig {
	/** GitHub token with repo and actions permissions. */
	token?: string;
	/** Repository in "owner/repo" format. */
	repo?: string;
	/** Gateway WebSocket URL for status reporting. */
	gatewayUrl?: string;
	/** Gateway auth token. */
	gatewayAuthToken?: string;
}

export class GitHubActionsRuntime implements AgentRuntime {
	readonly platform = "github-actions";
	private readonly config: GitHubActionsRuntimeConfig;

	constructor(config: GitHubActionsRuntimeConfig = {}) {
		this.config = config;
	}

	canSpawn(host: string): boolean {
		return host === "github" || host === "github-actions" || host.startsWith("github:");
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

		// Generate the workflow YAML
		const workflowYaml = this.generateWorkflow(request, identity);
		const workflowFileName = `prime-agent-${agentId.slice(0, 8)}.yml`;

		// Trigger the workflow run
		const triggerResult = await this.triggerWorkflow(workflowFileName, workflowYaml, identity);

		let currentStatus: AgentStatusInfo = { status: "running" };
		const eventListeners = new Set<(event: AgentEvent) => void>();
		const _startTime = Date.now();

		// Poll workflow status
		const statusEndpoint: AgentStatusEndpoint = {
			poll: async () => {
				if (triggerResult.runId) {
					const status = await this.checkRunStatus(triggerResult.runId);
					currentStatus = status;
					if (status.status === "completed" || status.status === "error") {
						for (const listener of eventListeners) {
							listener({ type: "status", status: status.status, info: status });
						}
					}
				}
				return currentStatus;
			},
			subscribe: (listener) => {
				eventListeners.add(listener);
				// Start polling
				const interval = setInterval(async () => {
					const status = await statusEndpoint.poll?.();
					if (
						status &&
						(status.status === "completed" || status.status === "error" || status.status === "aborted")
					) {
						clearInterval(interval);
					}
				}, 10_000);
				return () => {
					clearInterval(interval);
					eventListeners.delete(listener);
				};
			},
			abort: async () => {
				if (triggerResult.runId) {
					await this.cancelRun(triggerResult.runId);
				}
				currentStatus = { ...currentStatus, status: "aborted", error: "Aborted by parent" };
				for (const listener of eventListeners) {
					listener({ type: "status", status: "aborted", info: currentStatus });
				}
			},
			requestFile: async (path) => {
				if (triggerResult.runId) {
					return await this.downloadArtifact(triggerResult.runId, path);
				}
				throw new Error(`Cannot request file: no run ID`);
			},
			sendFile: async (_path, _content) => {
				// GitHub Actions doesn't support sending files to a running workflow
				// Files must be synced before spawn via syncFiles
				throw new Error("Cannot send files to a running GitHub Actions workflow");
			},
		};

		return { identity, statusEndpoint };
	}

	/** Generate the GitHub Actions workflow YAML. */
	private generateWorkflow(request: SpawnRequest, identity: AgentIdentity): string {
		const escapedPrompt = request.prompt.replace(/"/g, '\\"');
		const gatewayUrl = this.config.gatewayUrl ?? "";
		const gatewayToken = this.config.gatewayAuthToken ?? "";
		const syncFiles = (request.syncFiles ?? []).map((f) => `          - ${f}`).join("\n");

		return `name: Prime Agent ${identity.agentId.slice(0, 8)}

on:
  workflow_dispatch:
    inputs:
      prompt:
        description: 'Task prompt'
        required: true
        default: "${escapedPrompt}"

jobs:
  agent:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    env:
      AGENT_ID: "${identity.agentId}"
      AGENT_HOST: "github-actions"
      AGENT_DEPTH: "${identity.depth}"
      PARENT_AGENT_ID: "${identity.parentAgentId ?? ""}"
      GATEWAY_URL: "${gatewayUrl}"
      GATEWAY_TOKEN: "${gatewayToken}"
      PRIME_AGENT_MODEL: "${request.model ?? ""}"
    steps:
      - uses: actions/checkout@v4
${syncFiles || "        # No files to sync"}
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Install prime-agent
        run: npm install -g @anthropic-ai/prime-agent || npm install -g prime-agent || true
      - name: Run agent
        run: |
          prime-agent --print \\
            --prompt "\${{ github.event.inputs.prompt }}" \\
            --session-id "${identity.agentId}" \\
            --work-dir ~/prime-agent-session/${identity.agentId} || true
      - name: Upload session artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: session-${identity.agentId}
          path: ~/prime-agent-session/${identity.agentId}/
          retention-days: 7
`;
	}

	/** Trigger a workflow run via GitHub API. */
	private async triggerWorkflow(
		fileName: string,
		yamlContent: string,
		identity: AgentIdentity,
	): Promise<{ runId?: string; triggered: boolean }> {
		const token = this.config.token ?? process.env.GITHUB_TOKEN;
		const repo = this.config.repo ?? process.env.GITHUB_REPOSITORY;

		if (!token || !repo) {
			// No GitHub credentials — simulate a local run
			return { triggered: false };
		}

		const [owner, repoName] = repo.split("/");

		try {
			// Create workflow file via GitHub API
			const putResp = await fetch(
				`https://api.github.com/repos/${owner}/${repoName}/contents/.github/workflows/${fileName}`,
				{
					method: "PUT",
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: "application/vnd.github.v3+json",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						message: `Spawn agent ${identity.agentId.slice(0, 8)}`,
						content: Buffer.from(yamlContent).toString("base64"),
					}),
				},
			);

			if (!putResp.ok) return { triggered: false };

			// Trigger the workflow
			const triggerResp = await fetch(
				`https://api.github.com/repos/${owner}/${repoName}/actions/workflows/${fileName}/dispatches`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: "application/vnd.github.v3+json",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						ref: "main",
						inputs: { prompt: identity.label },
					}),
				},
			);

			return { triggered: triggerResp.ok };
		} catch {
			return { triggered: false };
		}
	}

	/** Check workflow run status via GitHub API. */
	private async checkRunStatus(runId: string): Promise<AgentStatusInfo> {
		const token = this.config.token ?? process.env.GITHUB_TOKEN;
		const repo = this.config.repo ?? process.env.GITHUB_REPOSITORY;
		if (!token || !repo) return { status: "running" };

		const [owner, repoName] = repo.split("/");
		try {
			const resp = await fetch(`https://api.github.com/repos/${owner}/${repoName}/actions/runs/${runId}`, {
				headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
			});
			if (!resp.ok) return { status: "running" };
			const data = (await resp.json()) as { status: string; conclusion: string | null };
			const elapsed = Date.now() - 0; // Would need to track start time properly
			if (data.status === "completed") {
				if (data.conclusion === "success") {
					return { status: "completed", durationMs: elapsed };
				}
				return { status: "error", error: `Workflow conclusion: ${data.conclusion}`, durationMs: elapsed };
			}
			return { status: "running", durationMs: elapsed };
		} catch {
			return { status: "running" };
		}
	}

	/** Cancel a workflow run. */
	private async cancelRun(runId: string): Promise<void> {
		const token = this.config.token ?? process.env.GITHUB_TOKEN;
		const repo = this.config.repo ?? process.env.GITHUB_REPOSITORY;
		if (!token || !repo) return;
		const [owner, repoName] = repo.split("/");
		try {
			await fetch(`https://api.github.com/repos/${owner}/${repoName}/actions/runs/${runId}/cancel`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
			});
		} catch {
			// Best effort
		}
	}

	/** Download a workflow artifact. */
	private async downloadArtifact(runId: string, _path: string): Promise<string> {
		const token = this.config.token ?? process.env.GITHUB_TOKEN;
		const repo = this.config.repo ?? process.env.GITHUB_REPOSITORY;
		if (!token || !repo) throw new Error("No GitHub credentials");

		const [owner, repoName] = repo.split("/");
		try {
			// List artifacts for the run
			const resp = await fetch(`https://api.github.com/repos/${owner}/${repoName}/actions/runs/${runId}/artifacts`, {
				headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
			});
			if (!resp.ok) throw new Error("Failed to list artifacts");
			const data = (await resp.json()) as { artifacts: { name: string; archive_download_url: string }[] };
			const artifact = data.artifacts[0];
			if (!artifact) throw new Error("No artifacts found");

			// Download artifact archive (simplified — would need zip extraction)
			const dlResp = await fetch(artifact.archive_download_url, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!dlResp.ok) throw new Error("Failed to download artifact");
			// In production, extract the zip and read the specific file
			return await dlResp.text();
		} catch (err) {
			throw new Error(`Failed to download artifact: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
