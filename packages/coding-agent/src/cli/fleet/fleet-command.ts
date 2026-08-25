/**
 * Fleet command — manage networked devices as a compute fleet.
 *
 * Usage:
 *   prime-agent fleet                    Interactive TUI: list, add, remove, connect
 *   prime-agent fleet list               List all fleet hosts (non-interactive)
 *   prime-agent fleet discover           Scan network for accessible devices
 *   prime-agent fleet add <host>         Add a host to the fleet
 *   prime-agent fleet remove <host>      Remove a host from the fleet
 *   prime-agent fleet connect <host>     Connect a host to the gateway
 *   prime-agent fleet disconnect <host>  Disconnect a host from the gateway
 *   prime-agent fleet status <host>      Check a host's status
 *   prime-agent fleet bootstrap <host>   Install pi on a host and add to fleet
 */

import chalk from "chalk";
import { bootstrapHost, checkHostStatus, disconnectHost } from "./bootstrap.js";
import { discoverDevices, discoverDevicesQuick, inferTags } from "./discovery.js";
import {
	addFleetHost,
	type FleetHost,
	getFleetHost,
	listFleetHosts,
	removeFleetHost,
	updateFleetHostStatus,
} from "./fleet-config.js";

type FleetSubcommand =
	| "list"
	| "discover"
	| "add"
	| "remove"
	| "rm"
	| "connect"
	| "disconnect"
	| "status"
	| "bootstrap"
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
		case "connect":
			await connectHost(rest);
			break;
		case "disconnect":
			await disconnectHostCmd(rest);
			break;
		case "status":
			await statusHost(rest);
			break;
		case "bootstrap":
			await bootstrapHostCmd(rest);
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
		`  ${"HOSTNAME".padEnd(20)} ${"ADDRESS".padEnd(20)} ${"TAGS".padEnd(20)} ${"STATUS".padEnd(12)} ${"PI VERSION"}`,
	);
	console.log(`  ${"─".repeat(20)} ${"─".repeat(20)} ${"─".repeat(20)} ${"─".repeat(12)} ${"─".repeat(10)}`);

	for (const host of hosts) {
		const status = host.lastStatus ?? "unknown";
		const statusColor = status === "connected" ? chalk.green : status === "disconnected" ? chalk.yellow : chalk.dim;
		const tags = host.tags.join(",") || "-";
		console.log(
			`  ${host.hostname.padEnd(20)} ${host.address.padEnd(20)} ${tags.padEnd(20)} ${statusColor(status.padEnd(12))} ${host.piVersion ?? "-"}`,
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

	// Mark in-fleet devices
	for (const device of devices) {
		device.inFleet = fleetNames.has(device.hostname.toLowerCase());
	}

	if (json) {
		console.log(JSON.stringify({ devices }, null, 2));
		return;
	}

	const online = devices.filter((d) => d.online !== false);
	const offline = devices.filter((d) => d.online === false);

	console.log(
		chalk.bold(`\n  Discovered ${devices.length} devices (${online.length} online, ${offline.length} offline)\n`),
	);

	if (online.length > 0) {
		console.log(
			`  ${"HOSTNAME".padEnd(22)} ${"SOURCE".padEnd(12)} ${"OS".padEnd(8)} ${"SSH".padEnd(5)} ${"PI".padEnd(5)} ${"FLEET".padEnd(6)} ${"ADDRESS"}`,
		);
		console.log(
			`  ${"─".repeat(22)} ${"─".repeat(12)} ${"─".repeat(8)} ${"─".repeat(5)} ${"─".repeat(5)} ${"─".repeat(6)} ${"─".repeat(16)}`,
		);

		for (const device of online) {
			const ssh = device.sshable ? chalk.green("✓") : chalk.red("✗");
			const pi = device.hasPi ? chalk.green("✓") : chalk.dim("-");
			const fleet = device.inFleet ? chalk.green("✓") : chalk.dim("-");
			const os = device.os ?? "?";
			console.log(
				`  ${device.hostname.padEnd(22)} ${device.source.padEnd(12)} ${os.padEnd(8)} ${ssh}    ${pi}    ${fleet}    ${device.address}`,
			);
		}
	}

	if (offline.length > 0) {
		console.log(chalk.dim(`\n  Offline devices (${offline.length}):`));
		for (const device of offline) {
			console.log(
				chalk.dim(
					`  ${device.hostname.padEnd(22)} ${device.source.padEnd(12)} ${device.os ?? "?"}   ${device.address}`,
				),
			);
		}
	}

	const addable = online.filter((d) => d.sshable && !d.inFleet && !d.tags.includes("self"));
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
	const address = addrIdx >= 0 ? args[addrIdx + 1] : hostname;

	// Check if already in fleet
	const existing = await getFleetHost(hostname);
	if (existing) {
		console.error(chalk.red(`Host "${hostname}" is already in the fleet.`));
		process.exitCode = 1;
		return;
	}

	// Probe the host
	console.log(chalk.dim(`Probing ${hostname}...`));
	const devices = await discoverDevices({});
	const device = devices.find((d) => d.hostname.toLowerCase() === hostname.toLowerCase());

	const host: FleetHost = {
		hostname,
		address: address ?? device?.address ?? hostname,
		tags: tags.length > 0 ? tags : device ? inferTags(device) : [],
		capabilities: ["bash", "ipython", "browser"],
		os: device?.os,
		addedAt: Date.now(),
		lastStatus: device?.sshable ? "disconnected" : "unreachable",
	};

	// If we discovered the device, use its info
	if (device) {
		host.os = device.os;
		host.piVersion = device.piVersion;
		if (device.sshable) host.lastStatus = "disconnected";
	}

	await addFleetHost(host);
	console.log(chalk.green(`✓ Added "${hostname}" to fleet.`));
	if (host.tags.length > 0) console.log(chalk.dim(`  Tags: ${host.tags.join(", ")}`));
	if (host.os) console.log(chalk.dim(`  OS: ${host.os}`));
	if (host.piVersion) console.log(chalk.dim(`  Pi version: ${host.piVersion}`));
	console.log(chalk.dim(`  Run \`prime-agent fleet bootstrap ${hostname}\` to install pi and start daemon.`));
}

// ─── remove ────────────────────────────────────────────────────────

async function removeHost(args: string[]): Promise<void> {
	const hostname = args[0];
	if (!hostname) {
		console.error(chalk.red("Usage: prime-agent fleet remove <hostname>"));
		process.exitCode = 1;
		return;
	}
	const removed = await removeFleetHost(hostname);
	if (removed) {
		console.log(chalk.green(`✓ Removed "${hostname}" from fleet.`));
	} else {
		console.error(chalk.red(`Host "${hostname}" not found in fleet.`));
		process.exitCode = 1;
	}
}

// ─── connect ───────────────────────────────────────────────────────

async function connectHost(args: string[]): Promise<void> {
	const hostname = args[0];
	if (!hostname) {
		console.error(
			chalk.red("Usage: prime-agent fleet connect <hostname> [--gateway-url <url>] [--gateway-token <token>]"),
		);
		process.exitCode = 1;
		return;
	}
	const host = await getFleetHost(hostname);
	if (!host) {
		console.error(
			chalk.red(`Host "${hostname}" not found in fleet. Run \`prime-agent fleet add ${hostname}\` first.`),
		);
		process.exitCode = 1;
		return;
	}
	// This would start the gateway client on the remote host
	// For now, just update status
	await updateFleetHostStatus(hostname, "connected");
	console.log(chalk.green(`✓ Marked "${hostname}" as connected.`));
	console.log(chalk.dim("  (Full gateway client startup will be implemented in the next phase.)"));
}

// ─── disconnect ────────────────────────────────────────────────────

async function disconnectHostCmd(args: string[]): Promise<void> {
	const hostname = args[0];
	if (!hostname) {
		console.error(chalk.red("Usage: prime-agent fleet disconnect <hostname>"));
		process.exitCode = 1;
		return;
	}
	const host = await getFleetHost(hostname);
	if (!host) {
		console.error(chalk.red(`Host "${hostname}" not found in fleet.`));
		process.exitCode = 1;
		return;
	}
	await disconnectHost(host.address);
	await updateFleetHostStatus(hostname, "disconnected");
	console.log(chalk.green(`✓ Disconnected "${hostname}".`));
}

// ─── status ────────────────────────────────────────────────────────

async function statusHost(args: string[]): Promise<void> {
	const hostname = args[0];
	if (!hostname) {
		console.error(chalk.red("Usage: prime-agent fleet status <hostname>"));
		process.exitCode = 1;
		return;
	}
	const host = await getFleetHost(hostname);
	if (!host) {
		console.error(chalk.red(`Host "${hostname}" not found in fleet.`));
		process.exitCode = 1;
		return;
	}
	const json = args.includes("--json");
	const status = await checkHostStatus(host.address);

	if (json) {
		console.log(JSON.stringify({ hostname, ...status }, null, 2));
		return;
	}

	console.log(chalk.bold(`\n  ${hostname}`));
	console.log(`  Address:    ${host.address}`);
	console.log(`  Tags:       ${host.tags.join(", ") || "-"}`);
	console.log(`  Online:     ${status.online ? chalk.green("✓") : chalk.red("✗")}`);
	console.log(`  Pi installed: ${status.piInstalled ? chalk.green("✓") : chalk.red("✗")}`);
	if (status.piVersion) console.log(`  Pi version: ${status.piVersion}`);
	console.log(`  Daemon:     ${status.daemonRunning ? chalk.green("running") : chalk.red("not running")}`);
	console.log();
}

// ─── bootstrap ─────────────────────────────────────────────────────

async function bootstrapHostCmd(args: string[]): Promise<void> {
	const hostname = args[0];
	if (!hostname) {
		console.error(chalk.red("Usage: prime-agent fleet bootstrap <hostname> [--npm-package <pkg>]"));
		process.exitCode = 1;
		return;
	}
	const host = await getFleetHost(hostname);
	if (!host) {
		console.error(
			chalk.red(`Host "${hostname}" not found in fleet. Run \`prime-agent fleet add ${hostname}\` first.`),
		);
		process.exitCode = 1;
		return;
	}
	const pkgIdx = args.indexOf("--npm-package");
	const npmPackage = pkgIdx >= 0 ? args[pkgIdx + 1] : undefined;

	console.log(chalk.dim(`Bootstrapping ${hostname}...`));
	const result = await bootstrapHost({
		target: host.address,
		hostname: host.hostname,
		tags: host.tags,
		capabilities: host.capabilities,
		npmPackage,
	});

	if (result.success) {
		console.log(chalk.green(`✓ Bootstrap complete: ${hostname}`));
		if (result.alreadyInstalled) {
			console.log(chalk.dim("  Pi was already installed."));
		} else {
			console.log(chalk.dim("  Pi installed via npm."));
		}
		if (result.piVersion) console.log(chalk.dim(`  Version: ${result.piVersion}`));
		await updateFleetHostStatus(hostname, "connected");
	} else {
		console.error(chalk.red(`✗ Bootstrap failed: ${result.error}`));
		process.exitCode = 1;
	}
}

// ─── interactive TUI ───────────────────────────────────────────────

async function interactiveFleetTUI(): Promise<void> {
	const { selectFleetInteractive } = await import("../fleet-selector.js");
	await selectFleetInteractive();
}
