/**
 * Local runtime adapter — wraps the existing in-process RLM spawn.
 *
 * This is the default: when no host is specified, or host is "local",
 * the agent spawns in-process exactly as it does today.
 *
 * This adapter exists so the orchestrator treats all runtimes uniformly.
 */

import type {
	AgentEvent,
	AgentIdentity,
	AgentRuntime,
	AgentStatusEndpoint,
	SpawnRequest,
	SpawnResult,
} from "./agent-runtime.js";

export interface LocalSpawnHandlers {
	/** Called to actually spawn the child locally (delegates to AgentSession.runRlmChild). */
	spawnLocal: (
		prompt: string,
		kwargs: Record<string, unknown>,
	) => Promise<{
		rlm_child_id: string;
		name: string;
		session_dir: string;
		model: string;
	}>;
	/** Subscribe to child events from the local session. */
	subscribeToLocal: (childId: string, listener: (event: AgentEvent) => void) => () => void;
	/** Abort a local child. */
	abortLocal: (childId: string) => Promise<void>;
}

export class LocalRuntime implements AgentRuntime {
	readonly platform = "local";
	private readonly handlers: LocalSpawnHandlers;

	constructor(handlers: LocalSpawnHandlers) {
		this.handlers = handlers;
	}

	canSpawn(host: string): boolean {
		return host === "local" || host === "" || host === "localhost" || host === "self";
	}

	async spawn(request: SpawnRequest): Promise<SpawnResult> {
		const kwargs: Record<string, unknown> = {};
		if (request.name) kwargs.name = request.name;
		if (request.model) kwargs.model = request.model;

		const handle = await this.handlers.spawnLocal(request.prompt, kwargs);

		const identity: AgentIdentity = {
			agentId: handle.rlm_child_id,
			host: "local",
			sessionDir: handle.session_dir,
			model: handle.model,
			label: handle.name,
			depth: request.depth,
			parentAgentId: request.parent?.agentId,
		};

		const statusEndpoint: AgentStatusEndpoint = {
			subscribe: (listener) => {
				return this.handlers.subscribeToLocal(handle.rlm_child_id, listener);
			},
			abort: () => this.handlers.abortLocal(handle.rlm_child_id),
		};

		return { identity, statusEndpoint };
	}
}
