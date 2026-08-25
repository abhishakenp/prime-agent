/**
 * Fleet-aware RLM spawn — bridges rlm() calls to the fleet runtime.
 *
 * When the model calls `rlm("task")`:
 * - No host specified → LocalRuntime (existing behavior, in-process)
 * - host="a2" → SSHRuntime (spawns on VPS via SSH)
 * - host="cloudflare" → CloudflareRuntime (spawns on CF Workers)
 * - host="github" → GitHubActionsRuntime (triggers GH Actions workflow)
 *
 * The child appears in the parent's RLM child registry exactly like a
 * local child. Events flow back through the status endpoint.
 *
 * Recursive: a child spawned on a2 can itself call rlm("subtask", host="genesis")
 * and that spawns on genesis, routed through the gateway.
 */

import type { AgentIdentity, AgentStatusEndpoint, RuntimeRegistry } from "./agent-runtime.js";

export interface FleetRlmSpawnParams {
	/** Target host. If omitted, spawns locally. */
	host?: string;
	/** Model override. */
	model?: string;
	/** Session name. */
	name?: string;
	/** Files to sync from parent to child. */
	syncFiles?: string[];
	/** Working directory on the target (relative to HOME). */
	workDir?: string;
}

export interface FleetRlmChild {
	identity: AgentIdentity;
	statusEndpoint: AgentStatusEndpoint;
}

/**
 * Spawn a fleet-aware RLM child.
 *
 * Called by the rlm.run host handler when a host= parameter is present.
 * If no host is specified, returns null (caller falls back to local spawn).
 */
export async function spawnFleetChild(
	registry: RuntimeRegistry,
	prompt: string,
	kwargs: Record<string, unknown>,
	parentIdentity: AgentIdentity | undefined,
): Promise<FleetRlmChild | null> {
	const host = kwargs.host as string | undefined;
	if (!host || host === "local" || host === "self") {
		return null; // Let the caller use the default local spawn
	}

	const runtime = registry.resolve(host);
	if (!runtime) {
		throw new Error(
			`No runtime adapter can handle host "${host}". Available platforms: ${registry.platforms().join(", ")}. Run \`prime-agent fleet list\` to see available hosts.`,
		);
	}

	const { host: _host, model, name, syncFiles, workDir, ...unsupported } = kwargs;
	const unsupportedKeys = Object.keys(unsupported);
	if (unsupportedKeys.length > 0) {
		throw new Error(`Unsupported rlm.run kwargs for fleet spawn: ${unsupportedKeys.join(", ")}`);
	}

	const result = await runtime.spawn({
		prompt,
		host,
		model: model as string | undefined,
		name: name as string | undefined,
		syncFiles: syncFiles as string[] | undefined,
		workDir: workDir as string | undefined,
		depth: (parentIdentity?.depth ?? 0) + 1,
		parent: parentIdentity,
	});

	return {
		identity: result.identity,
		statusEndpoint: result.statusEndpoint,
	};
}
