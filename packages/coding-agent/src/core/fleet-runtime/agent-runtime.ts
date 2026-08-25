/**
 * Agent runtime adapter interface.
 *
 * An AgentRuntime knows how to spawn a self-contained prime-agent instance
 * on a specific platform (SSH host, Cloudflare Worker, GitHub Action, etc.).
 *
 * Each spawned agent:
 * - Gets its own working directory (relative to HOME on the target)
 * - Gets its own session ID and identity
 * - Runs the plan/exec/review loop (delegator skill)
 * - Communicates back through the gateway
 * - Can request files from the fleet
 * - Can recursively spawn sub-agents on other hosts
 *
 * The adapter handles only: spawn, status, abort, file transfer.
 * All agent logic runs inside the spawned instance itself.
 */

/** Unique identity for a spawned agent. */
export interface AgentIdentity {
	/** Globally unique agent ID (UUID). */
	agentId: string;
	/** Hostname where the agent runs. */
	host: string;
	/** Session directory on the target host (relative to HOME). */
	sessionDir: string;
	/** Model the agent is configured with. */
	model: string;
	/** Human-readable label for the task. */
	label: string;
	/** Depth in the recursive agent tree. */
	depth: number;
	/** Parent agent ID (for recursive tracking). */
	parentAgentId?: string;
}

/** Spawn request — what the orchestrator sends to a runtime. */
export interface SpawnRequest {
	prompt: string;
	/** Target host (fleet hostname) or platform name. */
	host: string;
	/** Optional model override. */
	model?: string;
	/** Optional session name. */
	name?: string;
	/** Working directory on the target (relative to HOME). */
	workDir?: string;
	/** Files to sync from orchestrator to agent before start. */
	syncFiles?: string[];
	/** Environment variables to set. */
	env?: Record<string, string>;
	/** Parent agent identity (for recursive spawning). */
	parent?: AgentIdentity;
	/** Depth in the recursion tree. */
	depth: number;
}

/** Spawn result — what the runtime returns immediately. */
export interface SpawnResult {
	identity: AgentIdentity;
	/** How to check status / receive events. */
	statusEndpoint: AgentStatusEndpoint;
}

/** How the parent monitors the spawned agent. */
export interface AgentStatusEndpoint {
	/** Poll status (for SSH, GH Actions — pull-based). */
	poll?: () => Promise<AgentStatusInfo>;
	/** Subscribe to events (for gateway-connected — push-based). */
	subscribe?: (listener: (event: AgentEvent) => void) => () => void;
	/** Abort the agent. */
	abort?: () => Promise<void>;
	/** Request a file from the agent's workspace. */
	requestFile?: (path: string) => Promise<string>;
	/** Send a file to the agent's workspace. */
	sendFile?: (path: string, content: string) => Promise<void>;
}

/** Agent lifecycle status. */
export type AgentStatus = "queued" | "running" | "completed" | "error" | "aborted";

export interface AgentStatusInfo {
	status: AgentStatus;
	/** Elapsed time in ms. */
	durationMs?: number;
	/** Preview of the agent's answer (if completed). */
	answerPreview?: string;
	/** Error message (if error/aborted). */
	error?: string;
	/** Tool use count. */
	toolUseCount?: number;
	/** Token count. */
	tokenCount?: number;
}

/** Events streamed from the agent. */
export type AgentEvent =
	| { type: "status"; status: AgentStatus; info: AgentStatusInfo }
	| { type: "message"; content: string; role: "assistant" | "tool" }
	| { type: "file_request"; path: string; requestId: string }
	| { type: "file_response"; path: string; content: string; requestId: string }
	| { type: "child_spawn"; childIdentity: AgentIdentity }
	| { type: "log"; level: "info" | "warn" | "error"; message: string };

/**
 * Agent runtime adapter — one per platform.
 *
 * Implementations:
 * - LocalRuntime (in-process, existing behavior)
 * - SSHRuntime (ssh to a fleet host, run prime-agent --headless)
 * - CloudflareRuntime (deploy a Worker)
 * - GitHubActionsRuntime (trigger a workflow)
 */
export interface AgentRuntime {
	/** Platform name (e.g. "ssh", "cloudflare", "github-actions", "local"). */
	platform: string;

	/** Check if this runtime can handle the given host. */
	canSpawn(host: string): boolean;

	/** Spawn an agent on the target. Returns immediately with identity + status endpoint. */
	spawn(request: SpawnRequest): Promise<SpawnResult>;
}

/** Registry of available runtimes. The orchestrator picks the right one per host. */
export class RuntimeRegistry {
	private runtimes: AgentRuntime[] = [];

	register(runtime: AgentRuntime): void {
		this.runtimes.push(runtime);
	}

	/** Find a runtime that can handle the given host. */
	resolve(host: string): AgentRuntime | undefined {
		return this.runtimes.find((r) => r.canSpawn(host));
	}

	/** List all registered platforms. */
	platforms(): string[] {
		return this.runtimes.map((r) => r.platform);
	}
}
