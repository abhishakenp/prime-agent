/**
 * Runtime plugin operations — list, install, enable, disable, configure.
 *
 * Used by:
 *   - `prime-agent fleet runtimes` (CLI)
 *   - Fleet TUI runtime management view
 *
 * Plugins live in:
 *   - ~/.prime/runtimes/*.mjs        (user plugins — active)
 *   - <installDir>/dist/plugins/runtimes/*.mjs  (built-in — SSH only)
 *   - <installDir>/dist/plugins/templates/*.mjs (templates — copy to activate)
 */

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** User plugin directory. */
export function userRuntimesDir(): string {
	return join(homedir(), ".prime", "runtimes");
}

/** Resolve the package directory from the current module URL. */
function resolvePkgDir(): string {
	try {
		const thisFile = fileURLToPath(import.meta.url);
		const dir = dirname(thisFile);
		// Bundled:   <pkgDir>/dist/bundle/cli.js → dir = dist/bundle → 3 levels up
		if (dir.endsWith("bundle")) {
			return dirname(dirname(dirname(thisFile)));
		}
		// Unbundled: <pkgDir>/dist/cli/fleet/runtime-operations.js → 4 levels up
		return dirname(dirname(dirname(dirname(thisFile))));
	} catch {
		return join(homedir(), ".prime", "agent");
	}
}

/** Built-in plugin directory. */
export function builtinRuntimesDir(): string {
	const pkgDir = resolvePkgDir();
	const dir = join(pkgDir, "dist", "plugins", "runtimes");
	if (existsSync(dir)) return dir;
	// Fallback: try common install locations
	const candidates = [
		join(homedir(), ".prime", "agent", "dist", "plugins", "runtimes"),
		"/usr/local/lib/prime-agent/dist/plugins/runtimes",
		"/opt/prime-agent/dist/plugins/runtimes",
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return dir;
}

/** Template plugin directory (not auto-loaded). */
export function templateRuntimesDir(): string {
	const pkgDir = resolvePkgDir();
	const dir = join(pkgDir, "dist", "plugins", "templates");
	if (existsSync(dir)) return dir;
	return join(homedir(), ".prime", "agent", "dist", "plugins", "templates");
}

export interface RuntimePluginInfo {
	/** Plugin name (filename without extension). */
	name: string;
	/** Platform name (from createRuntime export, or inferred from filename). */
	platform: string;
	/** Source: "builtin" | "user" | "template". */
	source: "builtin" | "user" | "template";
	/** Full path to the .mjs file. */
	path: string;
	/** Whether the plugin is currently active (loaded at runtime). */
	active: boolean;
	/** Whether a companion .json config exists. */
	hasConfig: boolean;
	/** Config content if present. */
	config?: Record<string, unknown>;
	/** Whether the plugin is explicitly disabled in its config. */
	enabled: boolean;
	/** File size in bytes. */
	size: number;
}

/** List all runtime plugins: built-in, user, and templates. */
export async function listRuntimePlugins(): Promise<RuntimePluginInfo[]> {
	const plugins: RuntimePluginInfo[] = [];
	const userDir = userRuntimesDir();
	const builtinDir = builtinRuntimesDir();
	const templateDir = templateRuntimesDir();

	const userNames = new Set<string>();

	// User plugins (active)
	for (const file of listPluginFiles(userDir)) {
		const name = basename(file);
		userNames.add(name);
		const config = readConfig(file);
		plugins.push({
			name,
			platform: name, // Platform inferred from name; loader uses createRuntime
			source: "user",
			path: file,
			active: config.enabled !== false,
			hasConfig: config.raw !== undefined,
			config: config.config,
			enabled: config.enabled !== false,
			size: statSync(file).size,
		});
	}

	// Built-in plugins (active)
	for (const file of listPluginFiles(builtinDir)) {
		const name = basename(file);
		plugins.push({
			name,
			platform: name,
			source: "builtin",
			path: file,
			active: true,
			hasConfig: false,
			enabled: true,
			size: statSync(file).size,
		});
	}

	// Template plugins (not active — need to be installed)
	for (const file of listPluginFiles(templateDir)) {
		const name = basename(file);
		if (userNames.has(name)) continue; // Already installed as user plugin
		plugins.push({
			name,
			platform: name,
			source: "template",
			path: file,
			active: false,
			hasConfig: false,
			enabled: false,
			size: statSync(file).size,
		});
	}

	return plugins;
}

/** Install a template plugin by copying it to ~/.prime/runtimes/. */
export function installRuntimePlugin(name: string): { success: boolean; message: string } {
	const templateDir = templateRuntimesDir();
	const templatePath = join(templateDir, `${name}.mjs`);

	if (!existsSync(templatePath)) {
		return { success: false, message: `Template plugin '${name}' not found in ${templateDir}` };
	}

	const userDir = userRuntimesDir();
	mkdirSync(userDir, { recursive: true });
	const destPath = join(userDir, `${name}.mjs`);

	copyFileSync(templatePath, destPath);

	return {
		success: true,
		message: `Installed ${name} runtime plugin → ${destPath}`,
	};
}

/** Uninstall a user plugin (remove from ~/.prime/runtimes/). */
export function uninstallRuntimePlugin(name: string): { success: boolean; message: string } {
	const userDir = userRuntimesDir();
	const pluginPath = join(userDir, `${name}.mjs`);
	const configPath = join(userDir, `${name}.json`);

	if (!existsSync(pluginPath)) {
		return { success: false, message: `Plugin '${name}' not found in ${userDir}` };
	}

	rmSync(pluginPath, { force: true });
	rmSync(configPath, { force: true });

	return { success: true, message: `Uninstalled ${name} runtime plugin` };
}

/** Enable or disable a user plugin via its companion JSON. */
export function toggleRuntimePlugin(name: string, enabled: boolean): { success: boolean; message: string } {
	const userDir = userRuntimesDir();
	const pluginPath = join(userDir, `${name}.mjs`);
	const configPath = join(userDir, `${name}.json`);

	if (!existsSync(pluginPath)) {
		return { success: false, message: `Plugin '${name}' not found in ${userDir}` };
	}

	// Read existing config or create new
	let config: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		try {
			config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
		} catch {}
	}

	config.enabled = enabled;
	writeFileSync(configPath, JSON.stringify(config, null, 2));

	return {
		success: true,
		message: `${enabled ? "Enabled" : "Disabled"} ${name} runtime plugin`,
	};
}

/** Set config for a user plugin (merges with existing). */
export function configureRuntimePlugin(
	name: string,
	configUpdate: Record<string, unknown>,
): { success: boolean; message: string } {
	const userDir = userRuntimesDir();
	const pluginPath = join(userDir, `${name}.mjs`);
	const configPath = join(userDir, `${name}.json`);

	if (!existsSync(pluginPath)) {
		return { success: false, message: `Plugin '${name}' not found in ${userDir}` };
	}

	let config: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		try {
			config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
		} catch {}
	}

	// Merge: existing config + update
	const merged = { ...config, ...configUpdate };
	// Ensure enabled stays true unless explicitly set
	if (merged.enabled === undefined) merged.enabled = true;

	writeFileSync(configPath, JSON.stringify(merged, null, 2));

	return {
		success: true,
		message: `Configured ${name} runtime plugin`,
	};
}

/** Check if a plugin has a setup() export. */
export async function pluginHasSetup(pluginPath: string): Promise<boolean> {
	try {
		const mod = await import(pluginPath);
		return typeof mod.setup === "function";
	} catch {
		return false;
	}
}

/** Prompt interface for plugin setup(). */
export interface SetupPromptInterface {
	ask: (q: string, def?: string) => Promise<string | undefined>;
	confirm: (q: string, def?: boolean) => Promise<boolean>;
	choose: (q: string, options: string[]) => Promise<number>;
	status: (msg: string) => void;
}

/** Result of a plugin setup() call. */
export interface SetupResultData {
	success: boolean;
	message: string;
	config?: Record<string, unknown>;
}

/** Run a plugin's setup() with a given prompt interface. */
export async function runPluginSetupWithPath(
	pluginPath: string,
	prompt: SetupPromptInterface,
): Promise<SetupResultData> {
	try {
		const mod = (await import(pluginPath)) as {
			setup?: (config: Record<string, unknown>, prompt: SetupPromptInterface) => Promise<SetupResultData>;
		};
		if (!mod.setup) {
			return { success: true, message: "No setup required" };
		}
		const config = readConfig(pluginPath).config ?? {};
		return await mod.setup(config, prompt);
	} catch (err) {
		return { success: false, message: `Setup failed: ${err}` };
	}
}

/** Persist config to a plugin's companion JSON (flat format). */
export function savePluginConfig(name: string, config: Record<string, unknown>): void {
	const userDir = userRuntimesDir();
	const configPath = join(userDir, `${name}.json`);
	const existing = existsSync(configPath)
		? (JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>)
		: {};
	// Merge: keep existing keys, update with new config, ensure enabled
	const merged = { ...existing, ...config, enabled: true };
	writeFileSync(configPath, JSON.stringify(merged, null, 2));
}

// ─── Helpers ────────────────────────────────────────────────────────

function listPluginFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((f) => /\.(mjs|js|cjs)$/.test(f) && !f.endsWith(".json"))
			.map((f) => join(dir, f))
			.filter((f) => statSync(f).isFile())
			.sort();
	} catch {
		return [];
	}
}

function basename(path: string): string {
	return (
		path
			.split("/")
			.pop()
			?.replace(/\.(mjs|js|cjs)$/, "") ?? "unknown"
	);
}

function readConfig(pluginPath: string): {
	config?: Record<string, unknown>;
	enabled: boolean;
	raw?: string;
} {
	const base = pluginPath.replace(/\.(mjs|js|cjs)$/, "");
	const configPath = `${base}.json`;
	if (!existsSync(configPath)) return { enabled: true };
	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		// Nested format: { "config": {...}, "enabled": true }
		if (parsed.config && typeof parsed.config === "object") {
			return {
				config: parsed.config as Record<string, unknown>,
				enabled: parsed.enabled !== false,
				raw,
			};
		}
		// Flat format: all keys except "enabled" are config
		const { enabled, ...config } = parsed;
		return { config, enabled: enabled !== false, raw };
	} catch {
		return { enabled: true };
	}
}
