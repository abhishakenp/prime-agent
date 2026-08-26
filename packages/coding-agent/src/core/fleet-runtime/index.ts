/**
 * Fleet runtime — distributed agent execution across the fleet.
 *
 * This module provides the infrastructure for spawning self-contained
 * agent instances on any fleet host or cloud platform. Each agent:
 *
 * - Has its own identity (UUID, host, hardware ID)
 * - Runs in its own working directory (~/<session-dir>)
 * - Has its own IPython kernel and RLM loop
 * - Can request files from other fleet members
 * - Can recursively spawn sub-agents on other hosts
 * - Communicates back through the gateway
 *
 * Core runtime adapters (built-in):
 * - LocalRuntime: in-process (existing behavior, default)
 * - SSHRuntime: SSH to a fleet host, run prime-agent --headless
 *
 * Plugin runtimes (loaded from ~/.prime/runtimes/ or dist/plugins/):
 * - CloudflareRuntime: deploy a CF Worker
 * - GitHubActionsRuntime: trigger a GH Actions workflow
 * - Custom runtimes: any .mjs plugin implementing AgentRuntime
 *
 * Usage from RLM:
 *   handle = await rlm("task", host="a2")        # SSH to VPS
 *   handle = await rlm("task", host="cloudflare") # CF Workers (plugin)
 *   handle = await rlm("task")                    # local (existing)
 */

export {
	type AgentIdentityRecord,
	AgentTree,
	type AgentTreeNode,
	createChildIdentity,
	createOrchestratorIdentity,
} from "./agent-identity.js";
export {
	type AgentEvent,
	type AgentIdentity,
	type AgentRuntime,
	type AgentStatus,
	type AgentStatusEndpoint,
	type AgentStatusInfo,
	RuntimeRegistry,
	type SpawnRequest,
	type SpawnResult,
} from "./agent-runtime.js";
export {
	type FileSyncHandler,
	type FileSyncRequest,
	type FileSyncResponse,
	LocalFileSync,
	resolveSessionPath,
	validateSyncPath,
} from "./file-sync.js";
export { type FleetRlmChild, type FleetRlmSpawnParams, spawnFleetChild } from "./fleet-rlm-spawn.js";
export { LocalRuntime, type LocalSpawnHandlers } from "./local-runtime.js";
export {
	ensureAccount,
	isProvisionerAlive,
	type LeasedAccount,
	leaseAccount,
	leaseAccounts,
	listAccounts,
	type ProvisionResult,
	provisionAccounts,
	releaseAccount,
} from "./provisioner-client.js";
export {
	buildRuntimeRegistry,
	builtinRuntimesDir,
	type LoadedPlugin,
	loadRuntimePlugins,
	type PluginContext,
	runPluginSetup,
	type SetupPrompt,
	type SetupResult,
	userRuntimesDir,
} from "./runtime-plugin-loader.js";
export { SSHRuntime } from "./ssh-runtime.js";
