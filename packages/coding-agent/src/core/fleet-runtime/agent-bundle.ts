/**
 * AgentBundle — the self-contained agent package.
 *
 * Like Cactus Needle: "single dependency-free binary that runs anywhere."
 * The AgentBundle is the equivalent for prime-agent. Everything sealed inside:
 *
 * - Runtime: the prime-agent bundle (cli.js + chunks)
 * - Agent spec: prompt, identity, model config, depth, parent info
 * - Files: working files the agent needs (synced from orchestrator)
 * - Credentials: API keys, auth tokens (auto-included from orchestrator env)
 * - Config: settings.json, fleet config, skills
 * - Manifest: self-describing metadata (what's inside, how to run)
 *
 * The orchestrator calls `assembleBundle()` to create it, then the runtime
 * adapter ships it to the target and runs it. The target doesn't need
 * prime-agent pre-installed — the bundle IS prime-agent + everything else.
 *
 * Bundle structure:
 *   /manifest.json          — self-describing metadata
 *   /runtime/               — prime-agent bundle (cli.js + chunks)
 *   /runtime/package.json   — { "type": "module" } + external deps
 *   /agent/                 — agent spec (prompt, identity, config)
 *   /agent/prompt.txt       — the task prompt
 *   /agent/identity.json    — agent identity (UUID, host, depth, parent)
 *   /agent/settings.json    — prime-agent settings (model, provider, etc.)
 *   /agent/env.json         — environment variables (API keys, etc.)
 *   /files/                 — working files synced from orchestrator
 *   /skills/                — skills the agent needs
 *   /themes/                — theme files (needed by runtime)
 *   /run.sh                 — entry point: sets env, installs deps, runs agent
 *
 * The bundle is a directory that gets tarred and shipped. On the target:
 *   tar xzf bundle.tar.gz && cd bundle && ./run.sh
 *
 * For Cloudflare Workers: the bundle is embedded in the Worker script itself.
 * For GitHub Actions: the bundle is uploaded as an artifact.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { arch, homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** What goes into the bundle. */
export interface BundleSpec {
	/** Task prompt. */
	prompt: string;
	/** Agent identity. */
	identity: AgentIdentitySpec;
	/** Model override (optional). */
	model?: string;
	/** Provider override (optional). */
	provider?: string;
	/** Session name. */
	name?: string;
	/** Working directory on target (relative to HOME or absolute). */
	workDir?: string;
	/** Files to include (paths relative to orchestrator cwd). */
	files?: string[];
	/** Skills to include (skill names). */
	skills?: string[];
	/** Additional env vars to include. */
	env?: Record<string, string>;
	/** Whether to auto-include API keys from the orchestrator's env. */
	includeCredentials?: boolean;
	/** The orchestrator's cwd (for resolving file paths). */
	cwd: string;
}

export interface AgentIdentitySpec {
	agentId: string;
	host: string;
	hardwareId: string;
	depth: number;
	parentAgentId?: string;
	parentHost?: string;
}

export interface BundleManifest {
	/** Bundle format version. */
	version: 1;
	/** Bundle ID (UUID). */
	bundleId: string;
	/** When the bundle was assembled. */
	assembledAt: number;
	/** Agent identity. */
	identity: AgentIdentitySpec;
	/** Model config. */
	model?: string;
	provider?: string;
	/** Prompt preview (first 200 chars). */
	promptPreview: string;
	/** Files included. */
	files: string[];
	/** Skills included. */
	skills: string[];
	/** Env vars included (keys only, not values). */
	envKeys: string[];
	/** The runtime entry point. */
	entryPoint: string;
	/** Platform target. */
	platform: string;
	/** Hardware arch. */
	arch: string;
}

/** Assemble a self-contained agent bundle. */
export async function assembleBundle(spec: BundleSpec): Promise<string> {
	const bundleId = randomUUID();
	const bundleDir = join(homedir(), ".prime", "agent", "bundles", bundleId);
	mkdirSync(bundleDir, { recursive: true });

	// 1. Copy the runtime (prime-agent bundle)
	// Try: spec.cwd/packages/coding-agent/dist/bundle (repo root)
	//      spec.cwd/dist/bundle (already in packages/coding-agent)
	//      installed global location
	const runtimeDest = join(bundleDir, "runtime");
	let runtimeSrc: string | null = resolve(spec.cwd, "packages/coding-agent/dist/bundle");
	if (!existsSync(runtimeSrc)) {
		runtimeSrc = resolve(spec.cwd, "dist/bundle");
	}
	if (!existsSync(runtimeSrc)) {
		const installedBundle = findInstalledBundle();
		if (installedBundle) {
			runtimeSrc = installedBundle;
		} else {
			throw new Error("Cannot find prime-agent bundle. Run `npm run build` first.");
		}
	}
	copyDirSync(runtimeSrc, runtimeDest);

	// Add package.json with type: module to avoid Node warnings
	writeFileSync(join(runtimeDest, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`, "utf-8");

	// 2. Copy themes (needed by runtime)
	// Themes live next to the bundle in dist/modes/interactive/theme/
	const themesSrc = join(runtimeSrc, "..", "modes", "interactive", "theme");
	const themesDest = join(runtimeDest, "dist", "modes", "interactive", "theme");
	if (existsSync(themesSrc)) {
		mkdirSync(dirname(themesDest), { recursive: true });
		copyDirSync(themesSrc, themesDest);
	} else {
		// Try installed location
		const installedBundle = findInstalledBundle();
		if (installedBundle) {
			const installedThemes = join(installedBundle, "..", "modes", "interactive", "theme");
			if (existsSync(installedThemes)) {
				mkdirSync(dirname(themesDest), { recursive: true });
				copyDirSync(installedThemes, themesDest);
			}
		}
	}

	// 3. Copy skills
	const skillsDest = join(bundleDir, "skills");
	mkdirSync(skillsDest, { recursive: true });
	const skillsSrc = join(runtimeSrc, "..", "skills");
	if (existsSync(skillsSrc)) {
		copyDirSync(skillsSrc, skillsDest);
	}
	// Also copy specific skills if requested
	if (spec.skills) {
		for (const skillName of spec.skills) {
			const skillSrc = join(runtimeSrc, "..", "..", "skills", skillName);
			if (existsSync(skillSrc)) {
				copyDirSync(skillSrc, join(skillsDest, skillName));
			}
		}
	}

	// 4. Write agent spec
	const agentDir = join(bundleDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "prompt.txt"), spec.prompt, "utf-8");
	writeFileSync(join(agentDir, "identity.json"), JSON.stringify(spec.identity, null, 2), "utf-8");

	// 5. Write settings (model config)
	const settingsSrc = join(homedir(), ".prime", "agent", "settings.json");
	const agentSettings = existsSync(settingsSrc) ? JSON.parse(readFileSync(settingsSrc, "utf-8")) : {};
	if (spec.model) agentSettings.defaultModel = spec.model;
	// Don't set defaultProvider — let the CLI find whatever provider has the model + a key.
	// OmniRoute (if reachable) handles routing. On remote runners, the CLI auto-selects
	// the first available provider that has the model and a valid API key in env.
	if (spec.provider) agentSettings.defaultProvider = spec.provider;
	else delete agentSettings.defaultProvider;
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(agentSettings, null, 2), "utf-8");

	// 5b. Copy models.json (registers OmniRoute as a custom provider)
	const modelsJsonSrc = join(homedir(), ".prime", "agent", "models.json");
	if (existsSync(modelsJsonSrc)) {
		copyFileSync(modelsJsonSrc, join(agentDir, "models.json"));
	}

	// 6. Collect env vars (credentials + config)
	const envVars: Record<string, string> = {};
	if (spec.includeCredentials !== false) {
		// Auto-include all API keys from the orchestrator's env
		for (const [key, value] of Object.entries(process.env)) {
			if (
				key.endsWith("_API_KEY") ||
				key.endsWith("_TOKEN") ||
				key.endsWith("_SECRET") ||
				key.startsWith("PRIME_") ||
				key.startsWith("PI_") ||
				key === "OPENROUTER_API_KEY" ||
				key === "ANTHROPIC_API_KEY" ||
				key === "OPENAI_API_KEY" ||
				key === "GEMINI_API_KEY" ||
				key === "DEEPSEEK_API_KEY" ||
				key === "DASHSCOPE_API_KEY" ||
				key === "MIMO_API_KEY"
			) {
				if (typeof value === "string" && value.length > 0) {
					envVars[key] = value;
				}
			}
		}
	}
	// Merge explicit env vars
	if (spec.env) {
		Object.assign(envVars, spec.env);
	}
	writeFileSync(join(agentDir, "env.json"), JSON.stringify(envVars, null, 2), "utf-8");

	// 7. Copy files
	const filesDir = join(bundleDir, "files");
	mkdirSync(filesDir, { recursive: true });
	const includedFiles: string[] = [];
	if (spec.files) {
		for (const filePath of spec.files) {
			const src = resolve(spec.cwd, filePath);
			if (existsSync(src)) {
				const dest = join(filesDir, filePath);
				mkdirSync(dirname(dest), { recursive: true });
				const stat = statSync(src);
				if (stat.isDirectory()) {
					copyDirSync(src, dest);
				} else {
					copyFileSync(src, dest);
				}
				includedFiles.push(filePath);
			}
		}
	}

	// 8. Write manifest
	const manifest: BundleManifest = {
		version: 1,
		bundleId,
		assembledAt: Date.now(),
		identity: spec.identity,
		model: spec.model,
		provider: spec.provider,
		promptPreview: spec.prompt.slice(0, 200),
		files: includedFiles,
		skills: spec.skills ?? [],
		envKeys: Object.keys(envVars),
		entryPoint: "run.sh",
		platform: platform(),
		arch: arch(),
	};
	writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

	// 8b. Write a package.json for the runtime dir listing external deps
	// These are native/interop packages that can't be bundled — they must be npm-installed on the target.
	const runtimePkgJson = {
		name: "prime-agent-bundle-runtime",
		version: "1.0.0",
		private: true,
		type: "module",
		dependencies: {
			zeromq: "^6.1.2",
			koffi: "^2.12.0",
			undici: "^7.0.0",
		},
	};
	writeFileSync(join(bundleDir, "runtime", "package.json"), JSON.stringify(runtimePkgJson, null, 2), "utf-8");

	// 9. Write the entry point script
	const workDir = spec.workDir ?? `.prime/agent/sessions/fleet/${spec.identity.agentId}`;
	const settingsPath = join(homedir(), ".prime", "agent", "settings.json");
	const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {};
	const model = spec.model ?? settings.defaultModel ?? "";

	// OmniRoute is the primary router when available.
	// It handles: multi-provider failover, key rotation, combo routing,
	// free-model discovery, and the provisioner auto-adds keys to it.
	// The bundle's models.json registers OmniRoute as a custom provider.
	// If OmniRoute is down, fall back to the explicit/default provider.
	// No hardcoded provider prefixes — OmniRoute routes, we just point at it.
	const omnirouteUrl = process.env.OMNIROUTE_URL ?? "http://localhost:20128";
	const runScript = `#!/bin/bash
# AgentBundle entry point — self-contained, runs anywhere with Node.js
# Note: no set -e — we want to try multiple providers and continue on failure
BUNDLE_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load environment variables from env.json
if [ -f "$BUNDLE_DIR/agent/env.json" ]; then
  while IFS= read -r -d '' pair; do
    export "\${pair%%=*}=\${pair#*=}"
  done < <(node -e "
    const env = JSON.parse(require('fs').readFileSync('$BUNDLE_DIR/agent/env.json', 'utf-8'));
    for (const [k, v] of Object.entries(env)) process.stdout.write(k + '=' + v + '\\0');
  ")
fi

# Install external deps if missing
cd "$BUNDLE_DIR/runtime"
if [ ! -d "node_modules" ]; then
  npm install --production 2>/dev/null || true
fi

# Create work directory
WORK_DIR="${workDir.startsWith("/") ? workDir : `$HOME/${workDir}`}"
mkdir -p "$WORK_DIR"

# Copy synced files to work directory
if [ -d "$BUNDLE_DIR/files" ]; then
  cp -r "$BUNDLE_DIR/files/"* "$WORK_DIR/" 2>/dev/null || true
fi

# Run the agent in print mode.
# OmniRoute is the primary router — it handles multi-provider failover,
# key rotation, combo routing, and free-model discovery.
# The provisioner auto-adds keys to OmniRoute; OmniRoute routes across them.
# If OmniRoute is unreachable, fall back to the explicit/default provider.
OMNIROUTE_URL="${omnirouteUrl}"
# Point the CLI at the bundle's agent dir so it finds models.json (OmniRoute provider)
export PI_CODING_AGENT_DIR="$BUNDLE_DIR/agent"
EXIT_CODE=1

# Check if OmniRoute is alive (2s timeout)
if curl -s --max-time 2 "$OMNIROUTE_URL/" >/dev/null 2>&1; then
  echo "[agent] Using OmniRoute at $OMNIROUTE_URL"
  node "$BUNDLE_DIR/runtime/cli.js" \\
    --print \\
    --prompt "$(cat "$BUNDLE_DIR/agent/prompt.txt")" \\
    --session-id "${spec.identity.agentId}" \\
    --cwd "$WORK_DIR" \\
    --provider omniroute \\
    ${model ? `--model ${model}` : "--model auto/best-free"} \\
    ${spec.identity.parentAgentId ? `--parent-agent-id ${spec.identity.parentAgentId}` : ""} \\
    ${spec.identity.parentHost ? `--parent-host ${spec.identity.parentHost}` : ""} \\
    "$@" && EXIT_CODE=0
fi

# Fallback: no OmniRoute — let the CLI auto-select whatever provider has the model + a key.
# The bundle carries all API keys in env.json, so the CLI can try google, deepseek, openrouter, etc.
if [ $EXIT_CODE -ne 0 ]; then
  echo "[agent] OmniRoute unavailable, auto-selecting provider with available key"
  node "$BUNDLE_DIR/runtime/cli.js" \\
    --print \\
    --prompt "$(cat "$BUNDLE_DIR/agent/prompt.txt")" \\
    --session-id "${spec.identity.agentId}" \\
    --cwd "$WORK_DIR" \\
    ${model ? `--model ${model}` : ""} \\
    ${spec.identity.parentAgentId ? `--parent-agent-id ${spec.identity.parentAgentId}` : ""} \\
    ${spec.identity.parentHost ? `--parent-host ${spec.identity.parentHost}` : ""} \\
    "$@" && EXIT_CODE=0
fi

exit $EXIT_CODE
`;
	writeFileSync(join(bundleDir, "run.sh"), runScript, "utf-8");
	chmodSync(join(bundleDir, "run.sh"), 0o755);

	return bundleDir;
}

/** Create a tarball of the bundle for transport. */
export async function tarBundle(bundleDir: string, outputPath?: string): Promise<string> {
	const out = outputPath ?? `${bundleDir}.tar.gz`;
	return new Promise((resolve, reject) => {
		const tar = spawn("tar", ["czf", out, "-C", dirname(bundleDir), basename(bundleDir)], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		tar.on("exit", (code) => {
			if (code === 0) resolve(out);
			else reject(new Error(`tar failed with code ${code}`));
		});
		tar.stderr?.on("data", (d) => process.stderr.write(d));
	});
}

/** Find the installed prime-agent bundle (global install). */
function findInstalledBundle(): string | null {
	// Check common global install locations
	const candidates = [join(homedir(), ".local/share/fnm/node-versions")];
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			// Search for prime-agent bundle in fnm installations
			try {
				const versions = readdirSync(candidate);
				for (const version of versions) {
					const bundlePath = join(candidate, version, "installation/lib/node_modules/prime-agent/dist/bundle");
					if (existsSync(bundlePath)) return bundlePath;
				}
			} catch {}
		}
	}
	// Check npx cache
	const npxCache = join(homedir(), ".npm/_npx");
	if (existsSync(npxCache)) {
		try {
			for (const dir of readdirSync(npxCache)) {
				const bundlePath = join(npxCache, dir, "node_modules/prime-agent/dist/bundle");
				if (existsSync(bundlePath)) return bundlePath;
			}
		} catch {}
	}
	return null;
}

/** Recursively copy a directory. */
function copyDirSync(src: string, dest: string): void {
	mkdirSync(dest, { recursive: true });
	const entries = readdirSync(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDirSync(srcPath, destPath);
		} else if (entry.isFile()) {
			copyFileSync(srcPath, destPath);
		}
	}
}
