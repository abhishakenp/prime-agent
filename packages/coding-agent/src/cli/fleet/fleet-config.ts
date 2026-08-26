/**
 * Fleet config — persistent storage of all fleet members.
 *
 * Unified: SSH hosts, Cloudflare Workers, GitHub Actions, custom transports —
 * all are fleet members with a transport type. The transport plugin (.mjs)
 * is the implementation; the fleet member is what the user sees.
 *
 * Stored at ~/.prime/agent/fleet.json
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Transport types supported by the fleet. */
export type FleetTransport = "ssh" | "cloudflare" | "github-actions" | "local" | "custom";

export interface FleetHost {
	/** Unique hostname identifier. */
	hostname: string;
	/** Custom display name (rename). */
	displayName?: string;
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

/** A unified fleet member — SSH host, cloud platform, or custom transport. */
export interface FleetMember {
	/** Unique member name (used as host= in rlm()). */
	name: string;
	/** Transport type — determines how agents are spawned. */
	transport: FleetTransport;
	/** Custom display name (rename). */
	displayName?: string;
	/** Transport-specific connection info (SSH address, CF account, GH repo, etc.). */
	address?: string;
	/** SSH user (for ssh transport). */
	user?: string;
	/** Tags for routing and grouping. */
	tags: string[];
	/** Capabilities (bash, ipython, browser, etc.). */
	capabilities?: string[];
	/** OS family. */
	os?: string;
	/** Whether this is the local machine. */
	isSelf?: boolean;
	/** When this member was added to the fleet. */
	addedAt: number;
	/** Last known connection status. */
	lastStatus?: "connected" | "disconnected" | "unreachable" | "active" | "inactive";
	/** Last seen timestamp. */
	lastSeen?: number;
	/** Installed prime-agent version (SSH hosts). */
	piVersion?: string;
	/** Transport-specific config (CF accountId, GH repo, etc.). */
	config?: Record<string, unknown>;
	/** Whether this member is enabled. */
	enabled?: boolean;
}

export interface FleetConfig {
	/** Legacy SSH hosts (migrated to members on load). */
	hosts?: FleetHost[];
	/** Unified fleet members — all transports. */
	members?: FleetMember[];
	/** Names of explicitly removed members — prevents re-import from plugin configs. */
	removed?: string[];
}

const FLEET_CONFIG_PATH = join(homedir(), ".prime", "agent", "fleet.json");

export async function loadFleetConfig(): Promise<FleetConfig> {
	try {
		const content = await readFile(FLEET_CONFIG_PATH, "utf-8");
		const config = JSON.parse(content) as FleetConfig;
		// Auto-migrate legacy hosts → members
		if (config.hosts && config.hosts.length > 0 && (!config.members || config.members.length === 0)) {
			config.members = config.hosts.map((h) => ({
				name: h.hostname,
				transport: "ssh" as FleetTransport,
				displayName: h.displayName,
				address: h.address,
				user: h.user,
				tags: h.tags,
				capabilities: h.capabilities,
				os: h.os,
				isSelf: h.isSelf,
				addedAt: h.addedAt,
				lastStatus: h.lastStatus,
				lastSeen: h.lastSeen,
				piVersion: h.piVersion,
				enabled: true,
			}));
			delete config.hosts;
			await saveFleetConfig(config);
		}
		return config;
	} catch {
		return { members: [] };
	}
}

export async function saveFleetConfig(config: FleetConfig): Promise<void> {
	await mkdir(dirname(FLEET_CONFIG_PATH), { recursive: true });
	const toSave: FleetConfig = {
		members: config.members ?? [],
		removed: config.removed,
	};
	await writeFile(FLEET_CONFIG_PATH, `${JSON.stringify(toSave, null, 2)}\n`, "utf-8");
}

// ─── Unified fleet member management ──────────────────────────────

export async function listFleetMembers(): Promise<FleetMember[]> {
	const config = await loadFleetConfig();
	return config.members ?? [];
}

export async function getFleetMember(name: string): Promise<FleetMember | undefined> {
	const members = await listFleetMembers();
	return members.find((m) => m.name === name || m.displayName === name);
}

export async function addFleetMember(member: FleetMember): Promise<void> {
	const config = await loadFleetConfig();
	const members = config.members ?? [];
	const existing = members.findIndex((m) => m.name === member.name);
	if (existing >= 0) {
		members[existing] = { ...members[existing], ...member };
	} else {
		members.push(member);
	}
	config.members = members;
	// Clear from removed list if re-added
	if (config.removed?.includes(member.name)) {
		config.removed = config.removed.filter((n) => n !== member.name);
	}
	await saveFleetConfig(config);
}

export async function removeFleetMember(name: string): Promise<boolean> {
	const config = await loadFleetConfig();
	const members = config.members ?? [];
	const before = members.length;
	config.members = members.filter((m) => m.name !== name);
	if (config.members.length === before) return false;
	// Track removal so importRuntimeMembers doesn't re-add it
	config.removed = [...new Set([...(config.removed ?? []), name])];
	await saveFleetConfig(config);
	return true;
}

export async function updateFleetMemberConfig(name: string, configPatch: Record<string, unknown>): Promise<boolean> {
	const config = await loadFleetConfig();
	const member = config.members?.find((m) => m.name === name);
	if (!member) return false;
	member.config = { ...(member.config ?? {}), ...configPatch };
	await saveFleetConfig(config);
	return true;
}

export async function renameFleetMember(name: string, displayName: string): Promise<boolean> {
	const config = await loadFleetConfig();
	const member = config.members?.find((m) => m.name === name);
	if (!member) return false;
	member.displayName = displayName;
	await saveFleetConfig(config);
	return true;
}

export async function addFleetMemberTag(name: string, tag: string): Promise<boolean> {
	const config = await loadFleetConfig();
	const member = config.members?.find((m) => m.name === name);
	if (!member) return false;
	member.tags = [...new Set([...member.tags, tag])];
	await saveFleetConfig(config);
	return true;
}

export async function removeFleetMemberTag(name: string, tag: string): Promise<boolean> {
	const config = await loadFleetConfig();
	const member = config.members?.find((m) => m.name === name);
	if (!member) return false;
	member.tags = member.tags.filter((t) => t !== tag);
	await saveFleetConfig(config);
	return true;
}

export async function setFleetMemberEnabled(name: string, enabled: boolean): Promise<boolean> {
	const config = await loadFleetConfig();
	const member = config.members?.find((m) => m.name === name);
	if (!member) return false;
	member.enabled = enabled;
	await saveFleetConfig(config);
	return true;
}

// ─── Legacy compatibility (delegate to unified member functions) ──

export async function addFleetHost(host: FleetHost): Promise<void> {
	await addFleetMember({
		name: host.hostname,
		transport: "ssh",
		displayName: host.displayName,
		address: host.address,
		user: host.user,
		tags: host.tags,
		capabilities: host.capabilities,
		os: host.os,
		isSelf: host.isSelf,
		addedAt: host.addedAt,
		lastStatus: host.lastStatus,
		lastSeen: host.lastSeen,
		piVersion: host.piVersion,
		enabled: true,
	});
}

export async function removeFleetHost(hostname: string): Promise<boolean> {
	return removeFleetMember(hostname);
}

export async function getFleetHost(hostname: string): Promise<FleetHost | undefined> {
	const member = await getFleetMember(hostname);
	if (!member || member.transport !== "ssh") return undefined;
	return {
		hostname: member.name,
		displayName: member.displayName,
		address: member.address ?? "",
		user: member.user,
		tags: member.tags,
		capabilities: member.capabilities ?? [],
		os: member.os,
		isSelf: member.isSelf,
		addedAt: member.addedAt,
		lastStatus: member.lastStatus as FleetHost["lastStatus"],
		lastSeen: member.lastSeen,
		piVersion: member.piVersion,
	};
}

export async function listFleetHosts(): Promise<FleetHost[]> {
	const members = await listFleetMembers();
	return members
		.filter((m) => m.transport === "ssh")
		.map((m) => ({
			hostname: m.name,
			displayName: m.displayName,
			address: m.address ?? "",
			user: m.user,
			tags: m.tags,
			capabilities: m.capabilities ?? [],
			os: m.os,
			isSelf: m.isSelf,
			addedAt: m.addedAt,
			lastStatus: m.lastStatus as FleetHost["lastStatus"],
			lastSeen: m.lastSeen,
			piVersion: m.piVersion,
		}));
}

export async function updateFleetHostStatus(
	hostname: string,
	status: FleetHost["lastStatus"],
	lastSeen?: number,
): Promise<void> {
	const config = await loadFleetConfig();
	const member = config.members?.find((m) => m.name === hostname);
	if (member) {
		member.lastStatus = status;
		member.lastSeen = lastSeen ?? Date.now();
		await saveFleetConfig(config);
	}
}

export async function renameFleetHost(hostname: string, displayName: string): Promise<boolean> {
	return renameFleetMember(hostname, displayName);
}

export async function addFleetHostTag(hostname: string, tag: string): Promise<boolean> {
	return addFleetMemberTag(hostname, tag);
}

export async function removeFleetHostTag(hostname: string, tag: string): Promise<boolean> {
	return removeFleetMemberTag(hostname, tag);
}

// ─── Runtime → fleet member migration ─────────────────────────────

/**
 * Import existing runtime plugin configs (~/.prime/runtimes/*.json) as fleet
 * members. Called once on startup to unify runtimes into the fleet.
 * Idempotent — skips members that already exist.
 */
export async function importRuntimeMembers(): Promise<number> {
	const config = await loadFleetConfig();
	const members = config.members ?? [];
	const existingNames = new Set(members.map((m) => m.name));
	const removedNames = new Set(config.removed ?? []);
	let imported = 0;

	// Map runtime plugin name → transport type
	const transportMap: Record<string, FleetTransport> = {
		cloudflare: "cloudflare",
		"github-actions": "github-actions",
		ssh: "ssh",
	};

	for (const [pluginName, transport] of Object.entries(transportMap)) {
		if (existingNames.has(pluginName)) continue;
		if (removedNames.has(pluginName)) continue; // explicitly removed — skip

		try {
			const { readFile } = await import("node:fs/promises");
			const { homedir: hd } = await import("node:os");
			const { join: jn } = await import("node:path");
			const configPath = jn(hd(), ".prime", "runtimes", `${pluginName}.json`);
			const content = await readFile(configPath, "utf-8");
			const raw = JSON.parse(content);

			// Extract config (support both flat and nested formats)
			const config: Record<string, unknown> = {};
			const enabled = raw.enabled !== false;
			if (raw.config && typeof raw.config === "object") {
				Object.assign(config, raw.config);
			} else {
				for (const [k, v] of Object.entries(raw)) {
					if (k !== "enabled") config[k] = v;
				}
			}

			if (Object.keys(config).length === 0) continue;

			await addFleetMember({
				name: pluginName,
				transport,
				tags: ["cloud", transport],
				addedAt: Date.now(),
				lastStatus: enabled ? "active" : "inactive",
				enabled,
				config,
			});
			imported++;
		} catch {
			// No config file for this plugin — skip
		}
	}

	return imported;
}
