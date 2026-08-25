/**
 * Runtime plugin loader — discovers and loads runtime adapters as plugins.
 *
 * Runtimes are plugins. LocalRuntime is always built-in (default).
 * All other runtimes (SSH, Cloudflare, GitHub Actions, custom) are plugins
 * loaded from two directories:
 *
 *   1. <installDir>/dist/plugins/runtimes/  ← built-in plugins (self-contained .mjs)
 *   2. ~/.prime/runtimes/                   ← user plugins (override built-ins)
 *
 * User plugins take precedence: if a user plugin has the same platform name
 * as a built-in plugin, the user's version wins.
 *
 * Each plugin is a self-contained ESM module (.mjs) that exports:
 *
 *   export function createRuntime({ config }) {
 *     return new MyRuntime(config);  // or a custom AgentRuntime impl
 *   }
 *
 * A companion `*.json` file (same basename) can provide config + enable/disable:
 *
 *   ~/.prime/runtimes/my-runtime.mjs       ← plugin code
 *   ~/.prime/runtimes/my-runtime.json      ← optional: { "config": {...}, "enabled": true }
 *
 * Plugins are fully self-contained — no imports from prime-agent internals.
 * Built-in plugins are bundled via esbuild (scripts/bundle-runtimes.mjs).
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
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntime } from "./agent-runtime.js";
import { RuntimeRegistry } from "./agent-runtime.js";

/** User plugin directory: ~/.prime/runtimes/ */
export function userRuntimesDir(): string {
	return join(homedir(), ".prime", "runtimes");
}

/** Built-in plugin directory: <installDir>/dist/plugins/runtimes/ */
export function builtinRuntimesDir(): string {
	try {
		const thisFile = fileURLToPath(import.meta.url);
		const dir = dirname(thisFile);
		// Bundled:   <pkgDir>/dist/bundle/cli.js → dir = dist/bundle → 3 levels up
		if (dir.endsWith("bundle")) {
			const pkgDir = dirname(dirname(dirname(thisFile)));
			return join(pkgDir, "dist", "plugins", "runtimes");
		}
		// Unbundled: <pkgDir>/dist/core/fleet-runtime/runtime-plugin-loader.js → 4 levels up
		const installDir = dirname(dirname(dirname(dirname(thisFile))));
		return join(installDir, "dist", "plugins", "runtimes");
	} catch {
		return join(homedir(), ".prime", "agent", "dist", "plugins", "runtimes");
	}
}

/** Context passed to createRuntime() and setup() in plugins. */
export interface PluginContext {
	/** Config from the companion JSON file. */
	config: Record<string, unknown>;
}

/** Result of a plugin setup() call. */
export interface SetupResult {
	/** Whether setup succeeded. */
	success: boolean;
	/** Human-readable status message. */
	message: string;
	/** Updated config to persist to the companion JSON. */
	config?: Record<string, unknown>;
}

/** Interactive prompt function passed to setup() for TUI/CLI interaction. */
export interface SetupPrompt {
	/**
	 * Prompt the user for text input.
	 * Returns the trimmed string, or undefined if cancelled.
	 */
	ask(question: string, defaultValue?: string): Promise<string | undefined>;
	/**
	 * Prompt the user for yes/no confirmation.
	 * Returns true for yes, false for no.
	 */
	confirm(question: string, defaultValue?: boolean): Promise<boolean>;
	/**
	 * Present a list of options and let the user choose.
	 * Returns the selected option index, or -1 if cancelled.
	 */
	choose(question: string, options: string[]): Promise<number>;
	/**
	 * Display a status message (non-blocking).
	 */
	status(message: string): void;
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
	/** Whether it was a user plugin (vs built-in). */
	isUserPlugin: boolean;
}

/** Plugin module exports — at least one runtime export must be present. */
interface PluginExports {
	default?: new (config?: Record<string, unknown>) => AgentRuntime;
	runtime?: AgentRuntime;
	createRuntime?: (ctx: PluginContext) => AgentRuntime | Promise<AgentRuntime>;
	/** Optional interactive setup — called when user enables/installs the plugin. */
	setup?: (ctx: PluginContext, prompt: SetupPrompt) => Promise<SetupResult>;
}

/** Read optional JSON config companion file for a plugin.
 *
 * Supports two formats:
 *   { "config": {...}, "enabled": true }   ← nested (legacy)
 *   { "repo": "...", "enabled": true }      ← flat (all keys except "enabled" are config)
 */
function readPluginConfig(pluginPath: string): { config?: Record<string, unknown>; enabled?: boolean } {
	const base = pluginPath.replace(/\.(mjs|js|cjs)$/, "");
	const configPath = `${base}.json`;
	if (!existsSync(configPath)) return { enabled: true };
	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		// If "config" key exists, use nested format
		if (parsed.config && typeof parsed.config === "object") {
			return { config: parsed.config as Record<string, unknown>, enabled: parsed.enabled as boolean | undefined };
		}
		// Flat format: all keys except "enabled" are config
		const { enabled, ...config } = parsed;
		return { config, enabled: enabled as boolean | undefined };
	} catch {
		return { enabled: true };
	}
}

/** Discover plugin files in a directory. */
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
async function loadPlugin(pluginPath: string, isUserPlugin: boolean): Promise<LoadedPlugin | null> {
	try {
		const mod = (await import(pluginPath)) as PluginExports;
		const { config, enabled } = readPluginConfig(pluginPath);

		if (enabled === false) return null;

		const ctx: PluginContext = { config: config ?? {} };

		let runtime: AgentRuntime | null = null;

		if (mod.createRuntime) {
			runtime = await mod.createRuntime(ctx);
		} else if (mod.runtime) {
			runtime = mod.runtime;
		} else if (mod.default) {
			runtime = new mod.default(config);
		} else {
			console.warn(`[fleet-runtime] Plugin ${pluginPath} has no valid export (createRuntime, runtime, or default)`);
			return null;
		}

		if (!runtime || !runtime.platform) {
			console.warn(`[fleet-runtime] Plugin ${pluginPath} returned invalid runtime (missing platform)`);
			return null;
		}

		return {
			name:
				pluginPath
					.split("/")
					.pop()
					?.replace(/\.(mjs|js|cjs)$/, "") ?? "unknown",
			platform: runtime.platform,
			runtime,
			path: pluginPath,
			isUserPlugin,
		};
	} catch (err) {
		console.warn(`[fleet-runtime] Failed to load plugin ${pluginPath}:`, err);
		return null;
	}
}

/**
 * Load all runtime plugins.
 *
 * Scans:
 *   1. <installDir>/dist/plugins/runtimes/  (built-in, self-contained)
 *   2. ~/.prime/runtimes/                   (user plugins — override built-ins)
 *
 * User plugins with the same platform name as a built-in replace it.
 */
export async function loadRuntimePlugins(
	builtinDir: string = builtinRuntimesDir(),
	userDir: string = userRuntimesDir(),
): Promise<LoadedPlugin[]> {
	const platformToPlugin = new Map<string, LoadedPlugin>();

	// 1. Load built-in plugins first
	for (const file of discoverPluginFiles(builtinDir)) {
		const plugin = await loadPlugin(file, false);
		if (plugin) {
			platformToPlugin.set(plugin.platform, plugin);
		}
	}

	// 2. Load user plugins — override built-ins with same platform name
	for (const file of discoverPluginFiles(userDir)) {
		const plugin = await loadPlugin(file, true);
		if (plugin) {
			platformToPlugin.set(plugin.platform, plugin);
		}
	}

	return [...platformToPlugin.values()];
}

/**
 * Run the interactive setup() for a plugin at a given path.
 * Returns the setup result including updated config to persist.
 * If the plugin has no setup() export, returns success with no config changes.
 */
export async function runPluginSetup(pluginPath: string, prompt: SetupPrompt): Promise<SetupResult> {
	try {
		const mod = (await import(pluginPath)) as PluginExports;
		const { config } = readPluginConfig(pluginPath);
		const ctx: PluginContext = { config: config ?? {} };

		if (!mod.setup) {
			return { success: true, message: "No setup required" };
		}

		return await mod.setup(ctx, prompt);
	} catch (err) {
		return { success: false, message: `Setup failed: ${err}` };
	}
}

/**
 * Build a complete RuntimeRegistry:
 *   1. Register LocalRuntime (always first — default)
 *   2. Load built-in plugins from <installDir>/dist/plugins/runtimes/
 *   3. Load user plugins from ~/.prime/runtimes/ (override built-ins)
 *
 * No hardcoded fallbacks. Everything except LocalRuntime is a plugin.
 */
export async function buildRuntimeRegistry(
	localRuntime: AgentRuntime,
	builtinDir: string = builtinRuntimesDir(),
	userDir: string = userRuntimesDir(),
): Promise<{ registry: RuntimeRegistry; plugins: LoadedPlugin[] }> {
	const registry = new RuntimeRegistry();

	// 1. Local is always first (default)
	registry.register(localRuntime);

	// 2. Load all plugins (built-in + user overrides)
	const plugins = await loadRuntimePlugins(builtinDir, userDir);
	for (const plugin of plugins) {
		registry.register(plugin.runtime);
	}

	return { registry, plugins };
}
