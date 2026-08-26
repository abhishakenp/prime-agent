/**
 * Fleet command — CLI entry point for managing networked devices.
 *
 * All business logic lives in fleet-operations.ts.
 * This file is only: arg parsing + output formatting.
 * Same operations are reused by the TUI component and /fleet slash command.
 *
 * Usage:
 *   prime-agent fleet                    Interactive TUI: list, add, remove, connect
 *   prime-agent fleet list               List all fleet hosts (non-interactive)
 *   prime-agent fleet discover           Scan network for accessible devices
 *   prime-agent fleet add <host>         Add a host to the fleet
 *   prime-agent fleet remove <host>      Remove a host from the fleet
 *   prime-agent fleet rename <host> <name>  Rename a host in the fleet
 *   prime-agent fleet tag <host> <tag>      Add a tag to a host
 *   prime-agent fleet untag <host> <tag>    Remove a tag from a host
 *   prime-agent fleet connect <host>     Connect a host to the gateway
 *   prime-agent fleet disconnect <host>  Disconnect a host from the gateway
 *   prime-agent fleet ssh <host>         SSH into a host
 *   prime-agent fleet status <host>      Check a host's status
 *   prime-agent fleet bootstrap <host>   Install pi on a host and add to fleet
 */

import chalk from "chalk";
import { discoverDevices, discoverDevicesQuick } from "./discovery.js";
import {
	addFleetMember,
	addFleetMemberTag,
	type FleetMember,
	type FleetTransport,
	getFleetMember,
	importRuntimeMembers,
	listFleetHosts,
	listFleetMembers,
	removeFleetMember,
	removeFleetMemberTag,
	renameFleetMember,
	updateFleetMemberConfig,
} from "./fleet-config.js";
import {
	addHostToFleet,
	bootstrapFleetHost,
	checkFleetHostStatus,
	connectFleetHost,
	disconnectFleetHost,
	sshIntoFleetHost,
} from "./fleet-operations.js";
import {
	configureRuntimePlugin,
	installRuntimePlugin,
	listRuntimePlugins,
	toggleRuntimePlugin,
	uninstallRuntimePlugin,
} from "./runtime-operations.js";

type FleetSubcommand =
	| "list"
	| "discover"
	| "add"
	| "remove"
	| "rm"
	| "rename"
	| "tag"
	| "untag"
	| "config"
	| "connect"
	| "disconnect"
	| "ssh"
	| "status"
	| "bootstrap"
	| "runtimes"
	| "setup"
	| undefined;

export async function handleFleetCommand(args: string[]): Promise<void> {
	const subcommand = args[0] as FleetSubcommand;
	const rest = args.slice(1);

	switch (subcommand) {
		case undefined:
			await interactiveFleetTUI();
			break;
		case "list":
			await listFleet(rest);
			break;
		case "discover":
			await discoverFleet(rest);
			break;
		case "add":
			await addHost(rest);
			break;
		case "remove":
		case "rm":
			await removeHost(rest);
			break;
		case "rename":
			await renameHost(rest);
			break;
		case "tag":
			await tagHost(rest);
			break;
		case "untag":
			await untagHost(rest);
			break;
		case "config":
			await configMember(rest);
			break;
		case "connect":
			await connectHost(rest);
			break;
		case "disconnect":
			await disconnectHostCmd(rest);
			break;
		case "ssh":
			await sshHost(rest);
			break;
		case "status":
			await statusHost(rest);
			break;
		case "bootstrap":
			await bootstrapHostCmd(rest);
			break;
		case "runtimes":
			await runtimesCmd(rest);
			break;
		case "setup":
			await setupCmd(rest);
			break;
		default:
			console.error(chalk.red(`Unknown fleet command: ${subcommand}`));
			console.error('Run "prime-agent help fleet" for usage.');
			process.exitCode = 1;
	}
}

// ─── list ──────────────────────────────────────────────────────────

async function listFleet(args: string[]): Promise<void> {
	const json = args.includes("--json");
	// Import runtime configs as fleet members (idempotent)
	await importRuntimeMembers();
	const members = await listFleetMembers();

	if (json) {
		console.log(JSON.stringify({ members }, null, 2));
		return;
	}

	if (members.length === 0) {
		console.log(chalk.dim("No fleet members. Run `prime-agent fleet discover` to find devices."));
		console.log(
			chalk.dim("Add cloud members: `prime-agent fleet add cloudflare` or `prime-agent fleet add github-actions`"),
		);
		return;
	}

	console.log(chalk.bold("\n  Fleet Members\n"));
	console.log(
		`  ${"NAME".padEnd(18)} ${"TRANSPORT".padEnd(16)} ${"ADDRESS".padEnd(20)} ${"TAGS".padEnd(20)} ${"STATUS".padEnd(12)} ${"CONFIG"}`,
	);
	console.log(
		`  ${"─".repeat(18)} ${"─".repeat(16)} ${"─".repeat(20)} ${"─".repeat(20)} ${"─".repeat(12)} ${"─".repeat(8)}`,
	);

	for (const m of members) {
		const name = m.displayName ?? m.name;
		const nameCol = m.displayName ? chalk.cyan(name) : m.transport === "ssh" ? chalk.green(name) : name;
		const transportCol = chalk.dim(m.transport);
		const address = m.address ?? (m.config?.repo as string) ?? (m.config?.accountId as string) ?? "-";
		const tags = m.tags.join(",") || "-";
		const status = m.lastStatus ?? (m.enabled === false ? "inactive" : "unknown");
		const statusColor =
			status === "connected" || status === "active"
				? chalk.green
				: status === "disconnected" || status === "inactive"
					? chalk.yellow
					: chalk.dim;
		const hasConfig = m.config && Object.keys(m.config).length > 0 ? chalk.green("✓") : "-";
		console.log(
			`  ${nameCol.padEnd(18)} ${transportCol.padEnd(16)} ${address.padEnd(20)} ${tags.padEnd(20)} ${statusColor(status.padEnd(12))} ${hasConfig}`,
		);
	}
	console.log();
	console.log(chalk.dim("  Spawn: host='<name>' in rlm(). SSH hosts use hostname, cloud members use transport name."));
	console.log(chalk.dim("  Manage: prime-agent fleet add/remove/rename/tag/config <name>"));
	console.log(chalk.dim("  Add cloud: prime-agent fleet add cloudflare | prime-agent fleet add github-actions"));
	console.log();
}

// ─── discover ──────────────────────────────────────────────────────

async function discoverFleet(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const quick = args.includes("--no-probe");
	const fleetHosts = await listFleetHosts();
	const fleetNames = new Set(fleetHosts.map((h) => h.hostname.toLowerCase()));

	console.log(chalk.dim("Scanning for networked devices..."));

	const devices = quick ? await discoverDevicesQuick() : await discoverDevices({});

	if (json) {
		console.log(JSON.stringify({ devices }, null, 2));
		return;
	}

	const online = devices.filter((d) => d.online);
	const offline = devices.filter((d) => !d.online);
	console.log(`\n  Discovered ${devices.length} devices (${online.length} online, ${offline.length} offline)\n`);

	console.log(
		`  ${"HOSTNAME".padEnd(20)} ${"SOURCE".padEnd(12)} ${"OS".padEnd(8)} ${"SSH".padEnd(5)} ${"PI".padEnd(5)} ${"FLEET".padEnd(6)} ${"ADDRESS"}`,
	);
	console.log(
		`  ${"─".repeat(20)} ${"─".repeat(12)} ${"─".repeat(8)} ${"─".repeat(5)} ${"─".repeat(5)} ${"─".repeat(6)} ${"─".repeat(16)}`,
	);

	for (const device of devices) {
		const inFleet = fleetNames.has(device.hostname.toLowerCase());
		const ssh = device.sshable ? chalk.green("✓") : chalk.red("✗");
		const pi = device.hasPi ? chalk.green("✓") : "-";
		const fleet = inFleet ? chalk.green("✓") : "-";
		const os = device.os ?? "?";
		console.log(
			`  ${device.hostname.padEnd(20)} ${device.source.padEnd(12)} ${os.padEnd(8)} ${ssh.padEnd(5)} ${pi.padEnd(5)} ${fleet.padEnd(6)} ${device.tailscaleIp ?? device.address}`,
		);
	}

	const addable = devices.filter((d) => !fleetNames.has(d.hostname.toLowerCase()) && d.sshable);
	if (addable.length > 0) {
		console.log(
			chalk.cyan(`\n  ${addable.length} device(s) can be added. Run \`prime-agent fleet add <hostname>\` to add.`),
		);
	}
	console.log();
}

// ─── add ───────────────────────────────────────────────────────────

async function addHost(args: string[]): Promise<void> {
	const target = args[0];
	if (!target) {
		console.error(
			chalk.red(
				"Usage: prime-agent fleet add <hostname|transport> [name] [--tags ...] [--address ...] [--config k=v]",
			),
		);
		console.error(chalk.red("  SSH: prime-agent fleet add a2 --address 100.94.97.42"));
		console.error(chalk.red("  Cloud: prime-agent fleet add cloudflare"));
		console.error(chalk.red("  Cloud: prime-agent fleet add github-actions --config=repo=owner/repo"));
		process.exitCode = 1;
		return;
	}

	// Check if target is a transport type (cloudflare, github-actions, custom)
	const cloudTransports: FleetTransport[] = ["cloudflare", "github-actions", "custom"];
	if (cloudTransports.includes(target as FleetTransport)) {
		await addCloudMember(target as FleetTransport, args.slice(1));
		return;
	}

	// Otherwise treat as SSH host
	const hostname = target;
	const tagsIdx = args.indexOf("--tags");
	const tags = tagsIdx >= 0 ? (args[tagsIdx + 1]?.split(",") ?? []) : [];
	const addrIdx = args.indexOf("--address");
	const address = addrIdx >= 0 ? args[addrIdx + 1] : undefined;

	// Probe the host — use quick discovery (Tailscale + ARP cache, no ping sweep)
	console.log(chalk.dim(`Probing ${hostname}...`));
	const devices = await discoverDevicesQuick();
	const device = devices.find((d) => d.hostname.toLowerCase() === hostname.toLowerCase());

	const result = await addHostToFleet(hostname, address, tags, device);
	if (result.success) {
		console.log(chalk.green(`✓ ${result.message}`));
		if (result.host?.tags.length) console.log(chalk.dim(`  Tags: ${result.host.tags.join(", ")}`));
		if (result.host?.os) console.log(chalk.dim(`  OS: ${result.host.os}`));
		if (result.host?.piVersion) console.log(chalk.dim(`  Pi version: ${result.host.piVersion}`));
		console.log(chalk.dim(`  Run \`prime-agent fleet bootstrap ${hostname}\` to install pi and start daemon.`));
	} else {
		console.error(chalk.red(result.message));
		process.exitCode = 1;
	}
}

async function addCloudMember(transport: FleetTransport, args: string[]): Promise<void> {
	// Parse optional name (defaults to transport name)
	const name = args[0] && !args[0].startsWith("--") ? args[0] : transport;
	const configArgs = args.filter((a) => a.startsWith("--config="));
	const inlineConfig: Record<string, unknown> = {};
	for (const ca of configArgs) {
		const kv = ca.slice("--config=".length);
		const eq = kv.indexOf("=");
		if (eq > 0) {
			const key = kv.slice(0, eq);
			let val: unknown = kv.slice(eq + 1);
			try {
				val = JSON.parse(val as string);
			} catch {}
			inlineConfig[key] = val;
		}
	}

	// Install the transport plugin if not already installed
	const plugins = await listRuntimePlugins();
	const existing = plugins.find((p) => p.name === transport);
	if (!existing) {
		console.log(chalk.dim(`Installing ${transport} transport...`));
		const result = installRuntimePlugin(transport);
		if (!result.success) {
			console.error(chalk.red(result.message));
			process.exitCode = 1;
			return;
		}
		console.log(chalk.green(`✓ ${result.message}`));
	}

	// If inline config provided, save it
	if (Object.keys(inlineConfig).length > 0) {
		const { savePluginConfig } = await import("./runtime-operations.js");
		savePluginConfig(transport, inlineConfig);
		console.log(chalk.dim(`  Config saved: ${JSON.stringify(inlineConfig)}`));
	}

	// Add as fleet member
	await importRuntimeMembers(); // Import any existing config first
	const member: FleetMember = {
		name,
		transport,
		tags: ["cloud", transport],
		addedAt: Date.now(),
		lastStatus: "active",
		enabled: true,
		config: Object.keys(inlineConfig).length > 0 ? inlineConfig : undefined,
	};
	await addFleetMember(member);
	console.log(chalk.green(`✓ Added fleet member: ${name} (transport: ${transport})`));
	if (Object.keys(inlineConfig).length > 0) {
		console.log(chalk.dim(`  Config: ${JSON.stringify(inlineConfig)}`));
	} else {
		// Check if there's existing config from the plugin
		const existingMember = await getFleetMember(name);
		if (existingMember?.config && Object.keys(existingMember.config).length > 0) {
			console.log(chalk.dim(`  Config: ${JSON.stringify(existingMember.config)}`));
		} else {
			console.log(chalk.dim(`  No config yet. Run: prime-agent fleet config ${name} <key> <value>`));
			if (transport === "github-actions") {
				console.log(
					chalk.dim(
						`  Or: gh repo create prime-agent-runs --public && prime-agent fleet config ${name} repo "owner/prime-agent-runs"`,
					),
				);
			} else if (transport === "cloudflare") {
				console.log(chalk.dim(`  Or: npx wrangler whoami && prime-agent fleet config ${name} accountId <id>`));
			}
		}
	}
	console.log(chalk.dim(`  Spawn with: host='${name}' in rlm()`));
}

// ─── remove ────────────────────────────────────────────────────────

async function removeHost(args: string[]): Promise<void> {
	const name = args[0];
	if (!name) {
		console.error(chalk.red("Usage: prime-agent fleet remove <name>"));
		process.exitCode = 1;
		return;
	}
	const removed = await removeFleetMember(name);
	if (removed) {
		console.log(chalk.green(`✓ Removed fleet member: ${name}`));
	} else {
		console.error(chalk.red(`No fleet member named "${name}"`));
		process.exitCode = 1;
	}
}

// ─── rename ────────────────────────────────────────────────────────

async function renameHost(args: string[]): Promise<void> {
	const [name, ...nameParts] = args;
	const displayName = nameParts.join(" ").trim();
	if (!name || !displayName) {
		console.error(chalk.red("Usage: prime-agent fleet rename <name> <new-display-name>"));
		process.exitCode = 1;
		return;
	}
	const result = await renameFleetMember(name, displayName);
	if (result) {
		console.log(chalk.green(`✓ Renamed ${name} → ${displayName}`));
	} else {
		console.error(chalk.red(`No fleet member named "${name}"`));
		process.exitCode = 1;
	}
}

// ─── tag / untag ────────────────────────────────────────────────────

async function tagHost(args: string[]): Promise<void> {
	const [name, tag] = args;
	if (!name || !tag) {
		console.error(chalk.red("Usage: prime-agent fleet tag <name> <tag>"));
		process.exitCode = 1;
		return;
	}
	const result = await addFleetMemberTag(name, tag);
	if (result) {
		console.log(chalk.green(`✓ Tagged ${name}: ${tag}`));
	} else {
		console.error(chalk.red(`No fleet member named "${name}"`));
		process.exitCode = 1;
	}
}

async function untagHost(args: string[]): Promise<void> {
	const [name, tag] = args;
	if (!name || !tag) {
		console.error(chalk.red("Usage: prime-agent fleet untag <name> <tag>"));
		process.exitCode = 1;
		return;
	}
	const result = await removeFleetMemberTag(name, tag);
	if (result) {
		console.log(chalk.green(`✓ Untagged ${name}: ${tag}`));
	} else {
		console.error(chalk.red(`No fleet member named "${name}"`));
		process.exitCode = 1;
	}
}

// ─── config ────────────────────────────────────────────────────────

async function configMember(args: string[]): Promise<void> {
	const [name, key, ...valParts] = args;
	if (!name) {
		// Show config for all members
		await importRuntimeMembers();
		const members = await listFleetMembers();
		for (const m of members) {
			if (m.config && Object.keys(m.config).length > 0) {
				console.log(chalk.bold(`  ${m.name}:`));
				for (const [k, v] of Object.entries(m.config)) {
					console.log(chalk.dim(`    ${k} = ${JSON.stringify(v)}`));
				}
			}
		}
		return;
	}
	if (!key) {
		// Show config for one member
		const member = await getFleetMember(name);
		if (!member) {
			console.error(chalk.red(`No fleet member named "${name}"`));
			process.exitCode = 1;
			return;
		}
		console.log(chalk.bold(`  ${member.name} (${member.transport}):`));
		if (member.config && Object.keys(member.config).length > 0) {
			for (const [k, v] of Object.entries(member.config)) {
				console.log(chalk.dim(`    ${k} = ${JSON.stringify(v)}`));
			}
		} else {
			console.log(chalk.dim("    (no config)"));
		}
		return;
	}
	const value = valParts.join(" ").trim();
	if (!value) {
		console.error(chalk.red("Usage: prime-agent fleet config <name> <key> <value>"));
		process.exitCode = 1;
		return;
	}
	// Try to parse JSON values
	let parsed: unknown = value;
	try {
		parsed = JSON.parse(value);
	} catch {}
	const updated = await updateFleetMemberConfig(name, { [key]: parsed });
	if (updated) {
		// Also sync to runtime plugin config for backward compat
		const member = await getFleetMember(name);
		if (member?.transport && member.transport !== "ssh") {
			const { savePluginConfig } = await import("./runtime-operations.js");
			savePluginConfig(member.transport, member.config ?? {});
		}
		console.log(chalk.green(`✓ Set ${name}.${key} = ${JSON.stringify(parsed)}`));
	} else {
		console.error(chalk.red(`No fleet member named "${name}"`));
		process.exitCode = 1;
	}
}

// ─── ssh ────────────────────────────────────────────────────────────

async function sshHost(args: string[]): Promise<void> {
	const hostname = args[0];
	if (!hostname) {
		console.error(chalk.red("Usage: prime-agent fleet ssh <hostname>"));
		process.exitCode = 1;
		return;
	}
	const result = await sshIntoFleetHost(hostname);
	if (!result.success) {
		console.error(chalk.red(result.message));
		process.exitCode = 1;
	}
}

// ─── connect ───────────────────────────────────────────────────────

async function connectHost(args: string[]): Promise<void> {
	const hostname = args[0];
	if (!hostname) {
		console.error(chalk.red("Usage: prime-agent fleet connect <hostname>"));
		process.exitCode = 1;
		return;
	}
	const result = await connectFleetHost(hostname);
	if (result.success) {
		console.log(chalk.green(`✓ ${result.message}`));
	} else {
		console.error(chalk.red(result.message));
		process.exitCode = 1;
	}
}

// ─── disconnect ────────────────────────────────────────────────────

async function disconnectHostCmd(args: string[]): Promise<void> {
	const hostname = args[0];
	if (!hostname) {
		console.error(chalk.red("Usage: prime-agent fleet disconnect <hostname>"));
		process.exitCode = 1;
		return;
	}
	const result = await disconnectFleetHost(hostname);
	if (result.success) {
		console.log(chalk.green(`✓ ${result.message}`));
	} else {
		console.error(chalk.red(result.message));
		process.exitCode = 1;
	}
}

// ─── status ────────────────────────────────────────────────────────

async function statusHost(args: string[]): Promise<void> {
	const hostname = args[0];
	if (!hostname) {
		console.error(chalk.red("Usage: prime-agent fleet status <hostname>"));
		process.exitCode = 1;
		return;
	}
	const json = args.includes("--json");
	const result = await checkFleetHostStatus(hostname);

	if (!result.success) {
		console.error(chalk.red(result.message));
		process.exitCode = 1;
		return;
	}

	if (json) {
		console.log(
			JSON.stringify(
				{
					hostname,
					online: result.online,
					piInstalled: result.piInstalled,
					daemonRunning: result.daemonRunning,
					piVersion: result.piVersion,
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(chalk.bold(`\n  ${hostname}`));
	if (result.host) {
		console.log(`  Address:      ${result.host.address}`);
		console.log(`  Tags:         ${result.host.tags.join(", ") || "-"}`);
	}
	console.log(`  Online:       ${result.online ? chalk.green("✓") : chalk.red("✗")}`);
	console.log(`  Pi installed: ${result.piInstalled ? chalk.green("✓") : chalk.red("✗")}`);
	if (result.piVersion) console.log(`  Pi version:   ${result.piVersion}`);
	console.log(`  Daemon:       ${result.daemonRunning ? chalk.green("running") : chalk.red("not running")}`);
	console.log();
}

// ─── bootstrap ─────────────────────────────────────────────────────

async function bootstrapHostCmd(args: string[]): Promise<void> {
	const hostname = args[0];
	if (!hostname) {
		console.error(chalk.red("Usage: prime-agent fleet bootstrap <hostname>"));
		process.exitCode = 1;
		return;
	}

	console.log(chalk.dim(`Bootstrapping ${hostname}...`));
	const result = await bootstrapFleetHost(hostname);
	if (result.success) {
		console.log(chalk.green(`✓ ${result.message}`));
		if (result.piVersion) console.log(chalk.dim(`  Version: ${result.piVersion}`));
	} else {
		console.error(chalk.red(`✗ ${result.message}`));
		process.exitCode = 1;
	}
}

// ─── interactive TUI ───────────────────────────────────────────────

async function interactiveFleetTUI(): Promise<void> {
	const { selectFleetInteractive } = await import("../fleet-selector.js");
	await selectFleetInteractive();
}

// ─── runtimes ──────────────────────────────────────────────────────

async function runtimesCmd(args: string[]): Promise<void> {
	const action = args[0];
	const json = args.includes("--json");

	if (action === "list" || !action) {
		const plugins = await listRuntimePlugins();
		if (json) {
			console.log(JSON.stringify({ plugins }, null, 2));
			return;
		}
		console.log(chalk.bold("\n  Runtime Plugins\n"));
		console.log(
			`  ${"NAME".padEnd(18)} ${"SOURCE".padEnd(10)} ${"STATUS".padEnd(10)} ${"CONFIG".padEnd(8)} ${"SIZE"}`,
		);
		console.log(`  ${"─".repeat(18)} ${"─".repeat(10)} ${"─".repeat(10)} ${"─".repeat(8)} ${"─".repeat(10)}`);
		for (const p of plugins) {
			const status = p.active
				? chalk.green("● active")
				: p.source === "template"
					? chalk.dim("○ available")
					: chalk.yellow("○ disabled");
			const config = p.hasConfig ? chalk.green("✓") : "-";
			const size = `${(p.size / 1024).toFixed(0)}KB`;
			const name =
				p.source === "builtin" ? chalk.cyan(p.name) : p.source === "user" ? chalk.green(p.name) : chalk.dim(p.name);
			console.log(`  ${name.padEnd(18)} ${p.source.padEnd(10)} ${status.padEnd(10)} ${config.padEnd(8)} ${size}`);
		}
		console.log(chalk.dim(`\n  Install: prime-agent fleet runtimes install <name> [--no-setup] [--config k=v]`));
		console.log(chalk.dim(`  Setup:   prime-agent fleet runtimes setup <name> [--config k=v]`));
		console.log(chalk.dim(`  Enable:  prime-agent fleet runtimes enable <name>`));
		console.log(chalk.dim(`  Disable: prime-agent fleet runtimes disable <name>`));
		console.log(chalk.dim(`  Config:  prime-agent fleet runtimes config <name> <key> <value>\n`));
		return;
	}

	if (action === "install") {
		const name = args[1];
		if (!name) {
			console.error(
				chalk.red("Usage: prime-agent fleet runtimes install <name> [--no-setup] [--config key=value...]"),
			);
			process.exitCode = 1;
			return;
		}
		const noSetup = args.includes("--no-setup");
		const configArgs = args.filter((a) => a.startsWith("--config=") || a === "--config");
		const inlineConfig: Record<string, unknown> = {};
		for (const ca of configArgs) {
			if (ca === "--config") continue;
			const kv = ca.slice("--config=".length);
			const eq = kv.indexOf("=");
			if (eq > 0) {
				const key = kv.slice(0, eq);
				let val: unknown = kv.slice(eq + 1);
				// Try to parse JSON values (numbers, booleans, null)
				try {
					val = JSON.parse(val as string);
				} catch {}
				inlineConfig[key] = val;
			}
		}

		const result = installRuntimePlugin(name);
		if (!result.success) {
			console.error(chalk.red(result.message));
			process.exitCode = 1;
			return;
		}
		console.log(chalk.green(`✓ ${result.message}`));

		// Save inline config if provided (agent-friendly, no prompts)
		if (Object.keys(inlineConfig).length > 0) {
			const { savePluginConfig } = await import("./runtime-operations.js");
			savePluginConfig(name, inlineConfig);
			console.log(chalk.dim(`  Config saved: ${JSON.stringify(inlineConfig)}`));
		}

		// Run interactive setup unless --no-setup or inline config was provided
		if (noSetup || Object.keys(inlineConfig).length > 0) {
			if (noSetup) console.log(chalk.dim("  Skipped setup (--no-setup)"));
			return;
		}

		const { join } = await import("node:path");
		const { homedir } = await import("node:os");
		const { pluginHasSetup, runPluginSetupWithPath, savePluginConfig } = await import("./runtime-operations.js");
		const pluginPath = join(homedir(), ".prime", "runtimes", `${name}.mjs`);
		const hasSetup = await pluginHasSetup(pluginPath);
		if (hasSetup) {
			console.log(chalk.dim(`\n  Running setup for ${name}...`));
			const { createInterface } = await import("node:readline");
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			let eofResolve: ((val: unknown) => void) | null = null;
			rl.on("close", () => {
				if (eofResolve) eofResolve(undefined);
			});
			const prompt = {
				ask: (q: string, def?: string) =>
					new Promise<string | undefined>((resolve) => {
						eofResolve = resolve as (val: unknown) => void;
						rl.question(def ? `${q} [${def}]: ` : `${q}: `, (answer) => {
							eofResolve = null;
							const t = answer.trim();
							resolve(t || def);
						});
					}),
				confirm: (q: string, def?: boolean) =>
					new Promise<boolean>((resolve) => {
						eofResolve = resolve as (val: unknown) => void;
						rl.question(`${q} [${def ? "Y/n" : "y/N"}]: `, (answer) => {
							eofResolve = null;
							const a = answer.trim().toLowerCase();
							resolve(!a ? (def ?? false) : a === "y" || a === "yes");
						});
					}),
				choose: (q: string, options: string[]) =>
					new Promise<number>((resolve) => {
						eofResolve = resolve as (val: unknown) => void;
						console.log(`\n${q}`);
						options.forEach((opt, i) => {
							console.log(`  ${i + 1}. ${opt}`);
						});
						rl.question(`Choose (1-${options.length}): `, (answer) => {
							eofResolve = null;
							const n = Number.parseInt(answer.trim(), 10);
							resolve(n >= 1 && n <= options.length ? n - 1 : -1);
						});
					}),
				status: (msg: string) => console.log(chalk.dim(`  ${msg}`)),
			};
			const setupResult = await runPluginSetupWithPath(pluginPath, prompt);
			rl.close();
			if (setupResult.success) {
				console.log(chalk.green(`✓ ${setupResult.message}`));
				if (setupResult.config) {
					savePluginConfig(name, setupResult.config);
					console.log(chalk.dim(`  Config saved to ~/.prime/runtimes/${name}.json`));
				}
			} else {
				console.error(chalk.red(`✗ ${setupResult.message}`));
				process.exitCode = 1;
			}
		}
		return;
	}

	if (action === "setup") {
		const name = args[1];
		if (!name) {
			console.error(chalk.red("Usage: prime-agent fleet runtimes setup <name> [--config key=value...]"));
			process.exitCode = 1;
			return;
		}
		const { join } = await import("node:path");
		const { pluginHasSetup, runPluginSetupWithPath, savePluginConfig } = await import("./runtime-operations.js");
		const { homedir } = await import("node:os");
		const pluginPath = join(homedir(), ".prime", "runtimes", `${name}.mjs`);
		const hasSetup = await pluginHasSetup(pluginPath);
		if (!hasSetup) {
			console.log(chalk.dim(`${name} has no setup flow`));
			return;
		}

		// Check for inline config (non-interactive mode)
		const configArgs = args.filter((a) => a.startsWith("--config="));
		if (configArgs.length > 0) {
			// Non-interactive: save config directly, skip prompts
			const inlineConfig: Record<string, unknown> = {};
			for (const ca of configArgs) {
				const kv = ca.slice("--config=".length);
				const eq = kv.indexOf("=");
				if (eq > 0) {
					const key = kv.slice(0, eq);
					let val: unknown = kv.slice(eq + 1);
					try {
						val = JSON.parse(val as string);
					} catch {}
					inlineConfig[key] = val;
				}
			}
			savePluginConfig(name, inlineConfig);
			console.log(chalk.green(`✓ Configured ${name}: ${JSON.stringify(inlineConfig)}`));
			return;
		}

		// Interactive setup
		console.log(chalk.dim(`\n  Running setup for ${name}...`));
		const { createInterface } = await import("node:readline");
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		let eofResolve: ((val: unknown) => void) | null = null;
		rl.on("close", () => {
			if (eofResolve) eofResolve(undefined);
		});
		const prompt = {
			ask: (q: string, def?: string) =>
				new Promise<string | undefined>((resolve) => {
					eofResolve = resolve as (val: unknown) => void;
					rl.question(def ? `${q} [${def}]: ` : `${q}: `, (answer) => {
						eofResolve = null;
						const t = answer.trim();
						resolve(t || def);
					});
				}),
			confirm: (q: string, def?: boolean) =>
				new Promise<boolean>((resolve) => {
					eofResolve = resolve as (val: unknown) => void;
					rl.question(`${q} [${def ? "Y/n" : "y/N"}]: `, (answer) => {
						eofResolve = null;
						const a = answer.trim().toLowerCase();
						resolve(!a ? (def ?? false) : a === "y" || a === "yes");
					});
				}),
			choose: (q: string, options: string[]) =>
				new Promise<number>((resolve) => {
					eofResolve = resolve as (val: unknown) => void;
					console.log(`\n${q}`);
					options.forEach((opt, i) => {
						console.log(`  ${i + 1}. ${opt}`);
					});
					rl.question(`Choose (1-${options.length}): `, (answer) => {
						eofResolve = null;
						const n = Number.parseInt(answer.trim(), 10);
						resolve(n >= 1 && n <= options.length ? n - 1 : -1);
					});
				}),
			status: (msg: string) => console.log(chalk.dim(`  ${msg}`)),
		};
		const setupResult = await runPluginSetupWithPath(pluginPath, prompt);
		rl.close();
		if (setupResult.success) {
			console.log(chalk.green(`✓ ${setupResult.message}`));
			if (setupResult.config) {
				savePluginConfig(name, setupResult.config);
				console.log(chalk.dim(`  Config saved to ~/.prime/runtimes/${name}.json`));
			}
		} else {
			console.error(chalk.red(`✗ ${setupResult.message}`));
			process.exitCode = 1;
		}
		return;
	}

	if (action === "uninstall") {
		const name = args[1];
		if (!name) {
			console.error(chalk.red("Usage: prime-agent fleet runtimes uninstall <name>"));
			process.exitCode = 1;
			return;
		}
		const result = uninstallRuntimePlugin(name);
		if (result.success) console.log(chalk.green(`✓ ${result.message}`));
		else console.error(chalk.red(result.message));
		process.exitCode = result.success ? 0 : 1;
		return;
	}

	if (action === "enable") {
		const name = args[1];
		if (!name) {
			console.error(chalk.red("Usage: prime-agent fleet runtimes enable <name>"));
			process.exitCode = 1;
			return;
		}
		const result = toggleRuntimePlugin(name, true);
		if (result.success) console.log(chalk.green(`✓ ${result.message}`));
		else console.error(chalk.red(result.message));
		process.exitCode = result.success ? 0 : 1;
		return;
	}

	if (action === "disable") {
		const name = args[1];
		if (!name) {
			console.error(chalk.red("Usage: prime-agent fleet runtimes disable <name>"));
			process.exitCode = 1;
			return;
		}
		const result = toggleRuntimePlugin(name, false);
		if (result.success) console.log(chalk.green(`✓ ${result.message}`));
		else console.error(chalk.red(result.message));
		process.exitCode = result.success ? 0 : 1;
		return;
	}

	if (action === "config") {
		const [name, key, ...valueParts] = args.slice(1);
		const value = valueParts.join(" ");
		if (!name || !key || !value) {
			console.error(chalk.red("Usage: prime-agent fleet runtimes config <name> <key> <value>"));
			process.exitCode = 1;
			return;
		}
		// Try to parse value as JSON, fall back to string
		let parsed: unknown = value;
		try {
			parsed = JSON.parse(value);
		} catch {}
		const result = configureRuntimePlugin(name, { [key]: parsed });
		if (result.success) console.log(chalk.green(`✓ ${result.message}`));
		else console.error(chalk.red(result.message));
		process.exitCode = result.success ? 0 : 1;
		return;
	}

	console.error(chalk.red(`Unknown runtimes subcommand: ${action}`));
	console.error(chalk.dim("Available: list, install, uninstall, enable, disable, config"));
	process.exitCode = 1;
}

// ─── setup ─────────────────────────────────────────────────────────

/**
 * Run setup for a fleet member's transport.
 *
 * Agent-friendly: accepts --config k=v flags for non-interactive setup.
 * Without --config flags, runs interactive readline-based setup.
 *
 * Usage:
 *   prime-agent fleet setup <name>                    Interactive setup
 *   prime-agent fleet setup <name> --config=repo=owner/repo  Non-interactive
 *   prime-agent fleet setup github-actions --config=repo=owner/repo
 */
async function setupCmd(args: string[]): Promise<void> {
	const name = args[0];
	if (!name) {
		console.error(chalk.red("Usage: prime-agent fleet setup <name> [--config key=value...]"));
		console.error(chalk.dim("  Interactive: prime-agent fleet setup github-actions"));
		console.error(chalk.dim("  Agent:       prime-agent fleet setup github-actions --config=repo=owner/repo"));
		process.exitCode = 1;
		return;
	}

	// Resolve the fleet member to find its transport
	const member = await getFleetMember(name);
	const transport = member?.transport ?? name;

	// Find plugin path
	const { join } = await import("node:path");
	const { existsSync } = await import("node:fs");
	const { userRuntimesDir, builtinRuntimesDir } = await import("../../core/fleet-runtime/runtime-plugin-loader.js");
	const { pluginHasSetup, runPluginSetupWithPath, savePluginConfig } = await import("./runtime-operations.js");

	const userPath = join(userRuntimesDir(), `${transport}.mjs`);
	const builtinPath = join(builtinRuntimesDir(), `${transport}.mjs`);
	const pluginPath = existsSync(userPath) ? userPath : existsSync(builtinPath) ? builtinPath : null;

	if (!pluginPath) {
		console.error(chalk.red(`No plugin found for ${transport}`));
		process.exitCode = 1;
		return;
	}

	const hasSetup = await pluginHasSetup(pluginPath);
	if (!hasSetup) {
		console.log(chalk.dim(`${transport} has no setup flow`));
		return;
	}

	// Parse --config flags for non-interactive mode
	const configArgs = args.filter((a) => a.startsWith("--config="));
	if (configArgs.length > 0) {
		const inlineConfig: Record<string, unknown> = {};
		for (const ca of configArgs) {
			const kv = ca.slice("--config=".length);
			const eq = kv.indexOf("=");
			if (eq > 0) {
				const key = kv.slice(0, eq);
				let val: unknown = kv.slice(eq + 1);
				try {
					val = JSON.parse(val as string);
				} catch {}
				inlineConfig[key] = val;
			}
		}
		savePluginConfig(transport, inlineConfig);
		// Also update fleet member config
		if (member) {
			await updateFleetMemberConfig(name, inlineConfig);
		}
		console.log(chalk.green(`✓ Configured ${transport}: ${JSON.stringify(inlineConfig)}`));
		return;
	}

	// Interactive setup (readline-based)
	console.log(chalk.dim(`\n  Running setup for ${transport}...`));
	const { createInterface } = await import("node:readline");
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let eofResolve: ((val: unknown) => void) | null = null;
	rl.on("close", () => {
		if (eofResolve) eofResolve(undefined);
	});
	const prompt = {
		ask: (q: string, def?: string) =>
			new Promise<string | undefined>((resolve) => {
				eofResolve = resolve as (val: unknown) => void;
				rl.question(def ? `${q} [${def}]: ` : `${q}: `, (answer) => {
					eofResolve = null;
					const t = answer.trim();
					resolve(t || def);
				});
			}),
		confirm: (q: string, def?: boolean) =>
			new Promise<boolean>((resolve) => {
				eofResolve = resolve as (val: unknown) => void;
				rl.question(`${q} [${def ? "Y/n" : "y/N"}]: `, (answer) => {
					eofResolve = null;
					const a = answer.trim().toLowerCase();
					resolve(!a ? (def ?? false) : a === "y" || a === "yes");
				});
			}),
		choose: (q: string, options: string[]) =>
			new Promise<number>((resolve) => {
				eofResolve = resolve as (val: unknown) => void;
				console.log(`\n${q}`);
				options.forEach((opt, i) => {
					console.log(`  ${i + 1}. ${opt}`);
				});
				rl.question(`Choose (1-${options.length}): `, (answer) => {
					eofResolve = null;
					const n = Number.parseInt(answer.trim(), 10);
					resolve(n >= 1 && n <= options.length ? n - 1 : -1);
				});
			}),
		status: (msg: string) => console.log(chalk.dim(`  ${msg}`)),
	};
	const setupResult = await runPluginSetupWithPath(pluginPath, prompt);
	rl.close();
	if (setupResult.success) {
		console.log(chalk.green(`✓ ${setupResult.message}`));
		if (setupResult.config) {
			savePluginConfig(transport, setupResult.config);
			if (member) {
				await updateFleetMemberConfig(name, setupResult.config);
			}
			console.log(chalk.dim(`  Config saved to ~/.prime/runtimes/${transport}.json`));
		}
	} else {
		console.error(chalk.red(`✗ ${setupResult.message}`));
		process.exitCode = 1;
	}
}
