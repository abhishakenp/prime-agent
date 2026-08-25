/**
 * Fleet config — persistent storage of registered fleet hosts.
 *
 * Stored at ~/.prime/agent/fleet.json
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface FleetHost {
	/** Unique hostname identifier. */
	hostname: string;
	/** SSH alias or IP address for SSH access. */
	address: string;
	/** SSH user (defaults to current user). */
	user?: string;
	/** Tags for routing (linux, macos, cloud, local, etc.). */
	tags: string[];
	/** Capabilities (bash, ipython, browser, ios-sim, etc.). */
	capabilities: string[];
	/** OS family. */
	os?: string;
	/** Whether this host is the local machine. */
	isSelf?: boolean;
	/** When this host was added to the fleet. */
	addedAt: number;
	/** Last known connection status. */
	lastStatus?: "connected" | "disconnected" | "unreachable";
	/** Last seen timestamp. */
	lastSeen?: number;
	/** Installed pi/prime-agent version. */
	piVersion?: string;
}

export interface FleetConfig {
	hosts: FleetHost[];
}

const FLEET_CONFIG_PATH = join(homedir(), ".prime", "agent", "fleet.json");

export async function loadFleetConfig(): Promise<FleetConfig> {
	try {
		const content = await readFile(FLEET_CONFIG_PATH, "utf-8");
		return JSON.parse(content) as FleetConfig;
	} catch {
		return { hosts: [] };
	}
}

export async function saveFleetConfig(config: FleetConfig): Promise<void> {
	await mkdir(dirname(FLEET_CONFIG_PATH), { recursive: true });
	await writeFile(FLEET_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export async function addFleetHost(host: FleetHost): Promise<void> {
	const config = await loadFleetConfig();
	const existing = config.hosts.findIndex((h) => h.hostname === host.hostname);
	if (existing >= 0) {
		config.hosts[existing] = { ...config.hosts[existing], ...host };
	} else {
		config.hosts.push(host);
	}
	await saveFleetConfig(config);
}

export async function removeFleetHost(hostname: string): Promise<boolean> {
	const config = await loadFleetConfig();
	const before = config.hosts.length;
	config.hosts = config.hosts.filter((h) => h.hostname !== hostname);
	if (config.hosts.length === before) return false;
	await saveFleetConfig(config);
	return true;
}

export async function getFleetHost(hostname: string): Promise<FleetHost | undefined> {
	const config = await loadFleetConfig();
	return config.hosts.find((h) => h.hostname === hostname);
}

export async function listFleetHosts(): Promise<FleetHost[]> {
	const config = await loadFleetConfig();
	return config.hosts;
}

export async function updateFleetHostStatus(
	hostname: string,
	status: FleetHost["lastStatus"],
	lastSeen?: number,
): Promise<void> {
	const config = await loadFleetConfig();
	const host = config.hosts.find((h) => h.hostname === hostname);
	if (host) {
		host.lastStatus = status;
		host.lastSeen = lastSeen ?? Date.now();
		await saveFleetConfig(config);
	}
}
