/**
 * Shared fleet operations — single source of truth for all fleet actions.
 *
 * Used by:
 * - CLI commands (fleet-command.ts)
 * - TUI component (fleet-selector.ts)
 * - /fleet slash command (interactive-mode.ts)
 *
 * No UI logic here. No console.log. No rendering.
 * Each operation returns a result object the caller formats.
 */

import { bootstrapHost, checkHostStatus, disconnectHost } from "./bootstrap.js";
import { type DiscoveredDevice, inferTags } from "./discovery.js";
import {
	addFleetHost,
	addFleetHostTag,
	type FleetHost,
	getFleetHost,
	removeFleetHost,
	removeFleetHostTag,
	renameFleetHost,
	updateFleetHostStatus,
} from "./fleet-config.js";

export interface OperationResult {
	success: boolean;
	message: string;
	host?: FleetHost;
}

// ─── Add ───────────────────────────────────────────────────────────

export async function addHostToFleet(
	hostname: string,
	address?: string,
	tags?: string[],
	device?: DiscoveredDevice,
): Promise<OperationResult> {
	const existing = await getFleetHost(hostname);
	if (existing) {
		return { success: false, message: `Host "${hostname}" is already in the fleet.`, host: existing };
	}

	const finalTags = tags?.length ? tags : device ? inferTags(device) : [];
	const host: FleetHost = {
		hostname,
		address: address ?? device?.tailscaleIp ?? device?.address ?? hostname,
		tags: finalTags,
		capabilities: ["bash", "ipython", "browser"],
		os: device?.os,
		addedAt: Date.now(),
		lastStatus: device?.sshable ? "disconnected" : "unreachable",
		piVersion: device?.piVersion,
	};

	await addFleetHost(host);
	return { success: true, message: `Added "${hostname}" to fleet.`, host };
}

// ─── Remove ────────────────────────────────────────────────────────

export async function removeHostFromFleet(hostname: string): Promise<OperationResult> {
	const removed = await removeFleetHost(hostname);
	if (!removed) {
		return { success: false, message: `Host "${hostname}" not found in fleet.` };
	}
	return { success: true, message: `Removed "${hostname}" from fleet.` };
}

// ─── Rename ────────────────────────────────────────────────────────

export async function renameHostInFleet(hostname: string, displayName: string): Promise<OperationResult> {
	const ok = await renameFleetHost(hostname, displayName);
	if (!ok) {
		return { success: false, message: `Host "${hostname}" not found in fleet. Add it first.` };
	}
	return { success: true, message: `Renamed "${hostname}" → "${displayName}".` };
}

// ─── Tag / Untag ───────────────────────────────────────────────────

export async function tagHostInFleet(hostname: string, tag: string): Promise<OperationResult> {
	const ok = await addFleetHostTag(hostname, tag);
	if (!ok) {
		return { success: false, message: `Host "${hostname}" not found in fleet.` };
	}
	return { success: true, message: `Tagged "${hostname}" with "${tag}".` };
}

export async function untagHostInFleet(hostname: string, tag: string): Promise<OperationResult> {
	const ok = await removeFleetHostTag(hostname, tag);
	if (!ok) {
		return { success: false, message: `Host "${hostname}" not found in fleet.` };
	}
	return { success: true, message: `Removed tag "${tag}" from "${hostname}".` };
}

// ─── Connect / Disconnect ──────────────────────────────────────────

export async function connectFleetHost(hostname: string): Promise<OperationResult> {
	const host = await getFleetHost(hostname);
	if (!host) {
		return { success: false, message: `Host "${hostname}" not found in fleet.` };
	}
	await updateFleetHostStatus(hostname, "connected");
	return { success: true, message: `Connected "${hostname}".`, host };
}

export async function disconnectFleetHost(hostname: string): Promise<OperationResult> {
	const host = await getFleetHost(hostname);
	if (!host) {
		return { success: false, message: `Host "${hostname}" not found in fleet.` };
	}
	await disconnectHost(host.address);
	await updateFleetHostStatus(hostname, "disconnected");
	return { success: true, message: `Disconnected "${hostname}".`, host };
}

// ─── Status ────────────────────────────────────────────────────────

export interface HostStatusResult extends OperationResult {
	online?: boolean;
	piInstalled?: boolean;
	daemonRunning?: boolean;
	piVersion?: string;
}

export async function checkFleetHostStatus(hostname: string): Promise<HostStatusResult> {
	const host = await getFleetHost(hostname);
	const address = host?.address ?? hostname;
	const status = await checkHostStatus(address);

	const online = status.online;
	const piInstalled = status.piInstalled;
	const daemonRunning = status.daemonRunning;

	if (host) {
		const fleetStatus = online ? (daemonRunning ? "connected" : "disconnected") : "unreachable";
		await updateFleetHostStatus(hostname, fleetStatus);
	}

	return {
		success: true,
		message: `${hostname}: ${online ? "online" : "offline"} · pi ${piInstalled ? "yes" : "no"} · daemon ${daemonRunning ? "yes" : "no"}`,
		host,
		online,
		piInstalled,
		daemonRunning,
		piVersion: status.piVersion,
	};
}

// ─── Bootstrap ─────────────────────────────────────────────────────

export interface BootstrapResult extends OperationResult {
	piVersion?: string;
}

export async function bootstrapFleetHost(
	hostname: string,
	address?: string,
	tags?: string[],
): Promise<BootstrapResult> {
	const host = await getFleetHost(hostname);
	const target = address ?? host?.address ?? hostname;
	const finalTags = tags ?? host?.tags ?? [];

	const result = await bootstrapHost({
		target,
		hostname,
		tags: finalTags,
		capabilities: ["bash", "ipython", "browser"],
	});

	if (!result.success) {
		return { success: false, message: `Bootstrap failed: ${result.error}` };
	}

	// Add to fleet if not already there
	if (!host) {
		const addResult = await addHostToFleet(hostname, target, finalTags);
		if (!addResult.success) {
			return { success: false, message: `Bootstrap succeeded but failed to add to fleet: ${addResult.message}` };
		}
	}

	await updateFleetHostStatus(hostname, "connected");
	return {
		success: true,
		message: `Bootstrap complete: ${hostname}`,
		piVersion: result.piVersion,
	};
}

// ─── SSH ───────────────────────────────────────────────────────────

export async function sshIntoFleetHost(hostname: string): Promise<OperationResult> {
	const host = await getFleetHost(hostname);
	const target = host?.address ?? hostname;
	const user = host?.user ? `${host.user}@` : "";

	const { spawn } = await import("node:child_process");
	return new Promise((resolve) => {
		const ssh = spawn("ssh", [`${user}${target}`], { stdio: "inherit" });
		ssh.on("exit", (code) => {
			resolve({
				success: code === 0,
				message: `SSH session to ${hostname} ended (exit ${code})`,
				host,
			});
		});
	});
}

// ─── Batch add/remove ──────────────────────────────────────────────

export interface BatchResult {
	added: string[];
	removed: string[];
	errors: string[];
}

export async function batchAddRemove(
	toAdd: {
		hostname: string;
		address: string;
		tags?: string[];
		device?: DiscoveredDevice;
		sshable?: boolean;
		piVersion?: string;
		os?: string;
	}[],
	toRemove: string[],
): Promise<BatchResult> {
	const added: string[] = [];
	const removed: string[] = [];
	const errors: string[] = [];

	for (const entry of toAdd) {
		const result = await addHostToFleet(entry.hostname, entry.address, entry.tags, entry.device);
		if (result.success) {
			added.push(entry.hostname);
		} else {
			errors.push(result.message);
		}
	}

	for (const hostname of toRemove) {
		const result = await removeHostFromFleet(hostname);
		if (result.success) {
			removed.push(hostname);
		} else {
			errors.push(result.message);
		}
	}

	return { added, removed, errors };
}
