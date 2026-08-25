#!/usr/bin/env node
/**
 * Bundles each runtime adapter into a self-contained ESM plugin (.mjs).
 *
 * Output: dist/plugins/runtimes/<platform>.mjs
 *
 * Each plugin is fully self-contained — all dependencies (agent-bundle,
 * fleet-config, etc.) are bundled in. No imports from dist/ at runtime.
 *
 * Plugin export format:
 *   export function createRuntime({ config }) { return new SSHRuntime(config); }
 *
 * The loader scans:
 *   1. ~/.prime/runtimes/         (user plugins — override built-ins)
 *   2. <installDir>/plugins/runtimes/  (built-in plugins, shipped with prime-agent)
 */
import { rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(packageDir, "dist", "plugins", "runtimes");

// Runtime entry points — each becomes a self-contained plugin
const runtimes = [
	{ name: "ssh", entry: "ssh-runtime.ts" },
	{ name: "cloudflare", entry: "cloudflare-runtime.ts" },
	{ name: "github-actions", entry: "github-actions-runtime.ts" },
];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const { name, entry } of runtimes) {
	const entryPath = join(packageDir, "src", "core", "fleet-runtime", entry);
	const outFile = join(outDir, `${name}.mjs`);

	await build({
		entryPoints: [entryPath],
		outfile: outFile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		// Everything bundled — no external imports needed at runtime
		external: [],
		// Wrap in createRuntime export so the plugin loader can use it
		footer: {
			js: `
// Plugin entry point — exported for the runtime plugin loader
export function createRuntime({ config }) {
  return new ${className(name)}(config);
}
`,
		},
		logLevel: "warning",
	});

	console.log(`  bundled ${entry} -> dist/plugins/runtimes/${name}.mjs`);
}

console.log(`Done: ${runtimes.length} runtime plugins built`);

function className(name) {
	// Explicit mapping — handles SSH (not Ssh), GitHubActions (not GithubActions)
	const map = {
		ssh: "SSHRuntime",
		cloudflare: "CloudflareRuntime",
		"github-actions": "GitHubActionsRuntime",
	};
	return map[name] ?? `${name.charAt(0).toUpperCase() + name.slice(1)}Runtime`;
}
