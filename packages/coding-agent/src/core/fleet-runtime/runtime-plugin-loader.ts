/**
 * Runtime plugin loader — discovers and loads runtime adapters from ~/.prime/runtimes/.
 *
 * Runtimes are plugins. LocalRuntime is always built-in (default).
 * All other runtimes (SSH, Cloudflare, GitHub Actions, custom) are loaded from:
 *
 *   ~/.prime/runtimes/*.mjs   (or .js, .cjs)
 *
 * Each plugin module exports one of:
 *   - default class implementing AgentRuntime
 *   - named export `runtime` — an AgentRuntime instance
 *   - named export `createRuntime` — (ctx: PluginContext) => AgentRuntime | Promise<AgentRuntime>
 *
 * A companion `*.json` file (same basename) can provide config:
 *
 *   ~/.prime/runtimes/my-runtime.mjs       ← plugin code
 *   ~/.prime/runtimes/my-runtime.json      ← optional config
 *
 * Config JSON format:
 *   { "config": { ... }, "enabled": true }
 *
 * PluginContext (passed to createRuntime):
 *   - config: the config object from the companion JSON
 *   - primeAgentDir: path to the prime-agent installation (for importing built-ins)
 *
 * Plugin resolution order:
 *   1. Built-in LocalRuntime (always registered first)
 *   2. Plugins from ~/.prime/runtimes/ (sorted by filename)
 *   3. Built-in fallbacks (SSH, Cloudflare, GitHub Actions) if no plugin
 *      registered for that platform yet
 *
 * This lets users override built-ins by placing a plugin with the same
 * platform name in ~/.prime/runtimes/.
 *
 * Example custom plugin (~/.prime/runtimes/my-runtime.mjs):
 *
 *   export function createRuntime({ config }) {
 *     return {
 *       platform: "my-platform",
 *       canSpawn: (host) => host === "my-platform",
 *       async spawn(request) {
 *         // ... your logic
 *         return { identity, statusEndpoint };
 *       }
 *     };
 *   }
 *
 * Example overriding a built-in with custom config:
 *
 *   export async function createRuntime({ config, primeAgentDir }) {
 *     const { SSHRuntime } = await import(
 *       join(primeAgentDir, "dist/core/fleet-runtime/ssh-runtime.js")
 *     );
 *     return new SSHRuntime(config);
 *   }
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntime } from "./agent-runtime.js";
import { RuntimeRegistry } from "./agent-runtime.js";

/** Directory where runtime plugins live. */
export function runtimesDir(): string {
	return join(homedir(), ".prime", "runtimes");
}

/** Resolve the prime-agent installation directory (for plugin imports). */
function resolvePrimeAgentDir(): string {
	// This file is at: <primeAgentDir>/dist/core/fleet-runtime/runtime-plugin-loader.js
	// Go up 4 levels: dist/core/fleet-runtime -> dist/core -> dist -> <primeAgentDir>
	try {
		const thisFile = fileURLToPath(import.meta.url);
		return dirname(dirname(dirname(dirname(thisFile))));
	} catch {
		// Fallback: try common locations
		const candidates = [join(homedir(), ".prime", "agent"), "/usr/local/lib/prime-agent", "/opt/prime-agent"];
		for (const c of candidates) {
			if (existsSync(join(c, "dist", "cli.js"))) return c;
		}
		return join(homedir(), ".prime", "agent");
	}
}

/** Context passed to createRuntime() in plugins. */
export interface PluginContext {
	/** Config from the companion JSON file. */
	config: Record<string, unknown>;
	/** Path to the prime-agent installation (for importing built-ins). */
	primeAgentDir: string;
}

/** A loaded runtime plugin. */
export interface LoadedPlugin {
	/** Filename without extension. */
	name: string;
	/** Platform name from the runtime. */
	platform: string;
	/** The loaded runtime instance. */
	runtime: AgentRuntime;
	/** Source path. */
	path: string;
	/** Whether it was enabled. */
	enabled: boolean;
}

/** Plugin module exports — at least one must be present. */
interface PluginExports {
	default?: new (config?: Record<string, unknown>) => AgentRuntime;
	runtime?: AgentRuntime;
	createRuntime?: (ctx: PluginContext) => AgentRuntime | Promise<AgentRuntime>;
}

/** Read optional JSON config companion file for a plugin. */
function readPluginConfig(pluginPath: string): { config?: Record<string, unknown>; enabled?: boolean } {
	const base = pluginPath.replace(/\.(mjs|js|cjs)$/, "");
	const configPath = `${base}.json`;
	if (!existsSync(configPath)) return { enabled: true };
	try {
		const raw = readFileSync(configPath, "utf-8");
		return JSON.parse(raw) as { config?: Record<string, unknown>; enabled?: boolean };
	} catch {
		return { enabled: true };
	}
}

/** Discover plugin files in ~/.prime/runtimes/. */
function discoverPluginFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	try {
		const entries = readdirSync(dir);
		return entries
			.filter((f) => /\.(mjs|js|cjs)$/.test(f))
			.filter((f) => !f.endsWith(".json"))
			.map((f) => join(dir, f))
			.filter((f) => statSync(f).isFile())
			.sort();
	} catch {
		return [];
	}
}

/** Load a single plugin module. */
async function loadPlugin(pluginPath: string, primeAgentDir: string): Promise<AgentRuntime | null> {
	try {
		const mod = (await import(pluginPath)) as PluginExports;
		const { config, enabled } = readPluginConfig(pluginPath);

		if (enabled === false) return null;

		const ctx: PluginContext = { config: config ?? {}, primeAgentDir };

		// Three supported export patterns
		if (mod.createRuntime) {
			return await mod.createRuntime(ctx);
		}
		if (mod.runtime) {
			return mod.runtime;
		}
		if (mod.default) {
			return new mod.default(config);
		}

		console.warn(`[fleet-runtime] Plugin ${pluginPath} has no valid export (default, runtime, or createRuntime)`);
		return null;
	} catch (err) {
		console.warn(`[fleet-runtime] Failed to load plugin ${pluginPath}:`, err);
		return null;
	}
}

/**
 * Load all runtime plugins from ~/.prime/runtimes/ and register them.
 * Returns the list of successfully loaded plugins.
 */
export async function loadRuntimePlugins(dir: string = runtimesDir()): Promise<LoadedPlugin[]> {
	const files = discoverPluginFiles(dir);
	const plugins: LoadedPlugin[] = [];
	const primeAgentDir = resolvePrimeAgentDir();

	for (const file of files) {
		const runtime = await loadPlugin(file, primeAgentDir);
		if (runtime && runtime.platform) {
			plugins.push({
				name:
					file
						.split("/")
						.pop()
						?.replace(/\.(mjs|js|cjs)$/, "") ?? "unknown",
				platform: runtime.platform,
				runtime,
				path: file,
				enabled: true,
			});
		}
	}

	return plugins;
}

/**
 * Build a complete RuntimeRegistry:
 *   1. Register LocalRuntime (caller provides handlers)
 *   2. Load plugins from ~/.prime/runtimes/
 *   3. Register built-in fallbacks for any platform not covered by plugins
 *
 * This is the single entry point used by agent-session.ts.
 */
export async function buildRuntimeRegistry(
	localRuntime: AgentRuntime,
	builtInFallbacks: AgentRuntime[] = [],
	pluginsDir: string = runtimesDir(),
): Promise<{ registry: RuntimeRegistry; plugins: LoadedPlugin[] }> {
	const registry = new RuntimeRegistry();

	// 1. Local is always first (default)
	registry.register(localRuntime);

	// 2. Load plugins
	const plugins = await loadRuntimePlugins(pluginsDir);
	const pluginPlatforms = new Set<string>();

	for (const plugin of plugins) {
		registry.register(plugin.runtime);
		pluginPlatforms.add(plugin.platform);
	}

	// 3. Register built-in fallbacks that aren't overridden by plugins
	for (const fallback of builtInFallbacks) {
		if (!pluginPlatforms.has(fallback.platform)) {
			registry.register(fallback);
		}
	}

	return { registry, plugins };
}
