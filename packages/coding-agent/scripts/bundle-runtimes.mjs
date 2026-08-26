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

// Runtime entry points — only SSH is built-in (lives in core/fleet-runtime/).
// CF, GH Actions, and all other runtimes are plugins (live in src/plugins/runtimes/).
// Templates for those are generated to dist/plugins/templates/ for users/agents
// to copy into ~/.prime/runtimes/ when needed.
const builtInRuntimes = [
	{ name: "ssh", entry: "core/fleet-runtime/ssh-runtime.ts", setupExport: null },
];

const templateRuntimes = [
	{ name: "cloudflare", entry: "plugins/runtimes/cloudflare-runtime.ts", setupExport: "setupCloudflare" },
	{ name: "github-actions", entry: "plugins/runtimes/github-actions-runtime.ts", setupExport: "setupGitHubActions" },
];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. Build built-in plugins (only SSH)
for (const { name, entry, setupExport } of builtInRuntimes) {
	const entryPath = join(packageDir, "src", entry);
	const outFile = join(outDir, `${name}.mjs`);

	// esbuild bundles everything into one file — the setup function is already
	// included. We just need to re-export it with the name `setup`.
	const setupLine = setupExport ? `export { ${setupExport} as setup };` : "";

	await build({
		entryPoints: [entryPath],
		outfile: outFile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		external: [],
		footer: {
			js: `
// Plugin entry point — exported for the runtime plugin loader
export function createRuntime({ config }) {
  return new ${className(name)}(config);
}
${setupLine}
`,
		},
		logLevel: "warning",
	});

	console.log(`  built-in: ${entry} -> dist/plugins/runtimes/${name}.mjs`);
}

// 2. Build template plugins (CF, GH, etc.) — not loaded automatically.
// Users or agents copy these to ~/.prime/runtimes/ to enable the platform.
const templateDir = join(packageDir, "dist", "plugins", "templates");
mkdirSync(templateDir, { recursive: true });

for (const { name, entry, setupExport } of templateRuntimes) {
	const entryPath = join(packageDir, "src", entry);
	const outFile = join(templateDir, `${name}.mjs`);

	const setupLine = setupExport ? `export { ${setupExport} as setup };` : "";

	await build({
		entryPoints: [entryPath],
		outfile: outFile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		external: [],
		footer: {
			js: `
// Plugin entry point — exported for the runtime plugin loader
export function createRuntime({ config }) {
  return new ${className(name)}(config);
}
${setupLine}
`,
		},
		logLevel: "warning",
	});

	console.log(`  template: ${entry} -> dist/plugins/templates/${name}.mjs`);
}

console.log(`Done: ${builtInRuntimes.length} built-in + ${templateRuntimes.length} template plugins`);

function className(name) {
	// Explicit mapping — handles SSH (not Ssh), GitHubActions (not GithubActions)
	const map = {
		ssh: "SSHRuntime",
		cloudflare: "CloudflareRuntime",
		"github-actions": "GitHubActionsRuntime",
	};
	return map[name] ?? `${name.charAt(0).toUpperCase() + name.slice(1)}Runtime`;
}
