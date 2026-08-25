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
import { listFleetHosts } from "./fleet-config.js";
import {
	addHostToFleet,
	bootstrapFleetHost,
	checkFleetHostStatus,
	connectFleetHost,
	disconnectFleetHost,
	removeHostFromFleet,
	renameHostInFleet,
	sshIntoFleetHost,
	tagHostInFleet,
	untagHostInFleet,
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
	| "connect"
	| "disconnect"
	| "ssh"
	| "status"
	| "bootstrap"
	| "runtimes"
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
		default:
			console.error(chalk.red(`Unknown fleet command: ${subcommand}`));
			console.error('Run "prime-agent help fleet" for usage.');
			process.exitCode = 1;
	}
}

// ─── list ──────────────────────────────────────────────────────────

async function listFleet(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const hosts = await listFleetHosts();

	if (json) {
		console.log(JSON.stringify({ hosts }, null, 2));
		return;
	}

	if (hosts.length === 0) {
		console.log(chalk.dim("No hosts in fleet. Run `prime-agent fleet discover` to find devices."));
		return;
	}

	console.log(chalk.bold("\n  Fleet Hosts\n"));
	console.log(
		`  ${"NAME".padEnd(20)} ${"HOSTNAME".padEnd(20)} ${"ADDRESS".padEnd(20)} ${"TAGS".padEnd(20)} ${"STATUS".padEnd(12)} ${"PI"}`,
	);
	console.log(
		`  ${"─".repeat(20)} ${"─".repeat(20)} ${"─".repeat(20)} ${"─".repeat(20)} ${"─".repeat(12)} ${"─".repeat(10)}`,
	);

	for (const host of hosts) {
		const status = host.lastStatus ?? "unknown";
		const statusColor = status === "connected" ? chalk.green : status === "disconnected" ? chalk.yellow : chalk.dim;
		const tags = host.tags.join(",") || "-";
		const name = host.displayName ?? host.hostname;
		const nameCol = host.displayName ? chalk.cyan(name) : name;
		console.log(
			`  ${nameCol.padEnd(20)} ${host.hostname.padEnd(20)} ${host.address.padEnd(20)} ${tags.padEnd(20)} ${statusColor(status.padEnd(12))} ${host.piVersion ?? "-"}`,
		);
	}
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
	const hostname = args[0];
	if (!hostname) {
		console.error(chalk.red("Usage: prime-agent fleet add <hostname> [--tags tag1,tag2] [--address <ip>]"));
		process.exitCode = 1;
		return;
	}

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

// ─── remove ────────────────────────────────────────────────────────

async function removeHost(args: string[]): Promise<void> {
	const hostname = args[0];
	if (!hostname) {
		console.error(chalk.red("Usage: prime-agent fleet remove <hostname>"));
		process.exitCode = 1;
		return;
	}
	const result = await removeHostFromFleet(hostname);
	if (result.success) {
		console.log(chalk.green(`✓ ${result.message}`));
	} else {
		console.error(chalk.red(result.message));
		process.exitCode = 1;
	}
}

// ─── rename ────────────────────────────────────────────────────────

async function renameHost(args: string[]): Promise<void> {
	const [hostname, ...nameParts] = args;
	const displayName = nameParts.join(" ").trim();
	if (!hostname || !displayName) {
		console.error(chalk.red("Usage: prime-agent fleet rename <hostname> <new-name>"));
		process.exitCode = 1;
		return;
	}
	const result = await renameHostInFleet(hostname, displayName);
	if (result.success) {
		console.log(chalk.green(`✓ ${result.message}`));
	} else {
		console.error(chalk.red(result.message));
		process.exitCode = 1;
	}
}

// ─── tag / untag ────────────────────────────────────────────────────

async function tagHost(args: string[]): Promise<void> {
	const [hostname, tag] = args;
	if (!hostname || !tag) {
		console.error(chalk.red("Usage: prime-agent fleet tag <hostname> <tag>"));
		process.exitCode = 1;
		return;
	}
	const result = await tagHostInFleet(hostname, tag);
	if (result.success) {
		console.log(chalk.green(`✓ ${result.message}`));
	} else {
		console.error(chalk.red(result.message));
		process.exitCode = 1;
	}
}

async function untagHost(args: string[]): Promise<void> {
	const [hostname, tag] = args;
	if (!hostname || !tag) {
		console.error(chalk.red("Usage: prime-agent fleet untag <hostname> <tag>"));
		process.exitCode = 1;
		return;
	}
	const result = await untagHostInFleet(hostname, tag);
	if (result.success) {
		console.log(chalk.green(`✓ ${result.message}`));
	} else {
		console.error(chalk.red(result.message));
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
		console.log(chalk.dim(`\n  Install: prime-agent fleet runtimes install <name>`));
		console.log(chalk.dim(`  Enable:  prime-agent fleet runtimes enable <name>`));
		console.log(chalk.dim(`  Disable: prime-agent fleet runtimes disable <name>`));
		console.log(chalk.dim(`  Config:  prime-agent fleet runtimes config <name> <key> <value>\n`));
		return;
	}

	if (action === "install") {
		const name = args[1];
		if (!name) {
			console.error(chalk.red("Usage: prime-agent fleet runtimes install <name>"));
			process.exitCode = 1;
			return;
		}
		const result = installRuntimePlugin(name);
		if (!result.success) {
			console.error(chalk.red(result.message));
			process.exitCode = 1;
			return;
		}
		console.log(chalk.green(`✓ ${result.message}`));

		// Check if plugin has setup() and run it interactively
		const { join } = await import("node:path");
		const { homedir } = await import("node:os");
		const { pluginHasSetup, runPluginSetupWithPath, savePluginConfig } = await import("./runtime-operations.js");
		const pluginPath = join(homedir(), ".prime", "runtimes", `${name}.mjs`);
		const hasSetup = await pluginHasSetup(pluginPath);
		if (hasSetup) {
			console.log(chalk.dim(`\n  Running setup for ${name}...`));
			const { createInterface } = await import("node:readline");
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			// Handle EOF — resolve pending question with undefined
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
