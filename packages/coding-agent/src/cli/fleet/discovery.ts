/**
 * Device discovery — automatically find networked devices accessible from this machine.
 *
 * Sources (merged, deduplicated by hostname):
 * 1. Tailscale tailnet peers (if `tailscale` CLI is available)
 * 2. SSH config Host entries (~/.ssh/config)
 * 3. SSH known_hosts (~/.ssh/known_hosts)
 * 4. ARP table (local network, if `arp` is available)
 * 5. mDNS/Bonjour _ssh._tcp (if `dns-sd` is available, macOS only)
 *
 * Each discovered device is classified:
 * - online: responds to a quick TCP probe on port 22 (SSH) or Tailscale ping
 * - sshable: SSH connection succeeds (key-based auth)
 * - has_pi: prime-agent/pi is installed and on PATH
 * - in_fleet: already registered in fleet config
 */

import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface DiscoveredDevice {
	hostname: string;
	/** How we found this device. */
	source: "tailscale" | "ssh-config" | "known-hosts" | "arp" | "mdns";
	/** Best known address (Tailscale IP, hostname, or IP). */
	address: string;
	/** Tailscale IP if on tailnet. */
	tailscaleIp?: string;
	/** OS family if known. */
	os?: string;
	/** True if Tailscale reports it online. */
	tailscaleOnline?: boolean;
	/** SSH host alias from ~/.ssh/config, if any. */
	sshAlias?: string;
	/** Tags associated with this device. */
	tags: string[];
	/** Probed status. */
	online?: boolean;
	sshable?: boolean;
	hasPi?: boolean;
	piVersion?: string;
	inFleet?: boolean;
}

export interface DiscoveryOptions {
	/** Skip probing (SSH/Tailscale ping). Faster but less info. */
	skipProbe?: boolean;
	/** Timeout for each probe in ms. */
	probeTimeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT = 5000;

export async function discoverDevices(opts: DiscoveryOptions = {}): Promise<DiscoveredDevice[]> {
	const timeout = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT;
	const sources = await Promise.all([
		discoverTailscale().catch(() => []),
		discoverSshConfig().catch(() => []),
		discoverKnownHosts().catch(() => []),
		discoverArp().catch(() => []),
	]);

	const merged = mergeDevices(sources.flat());

	if (!opts.skipProbe) {
		await probeDevices(merged, timeout);
	}

	return merged.sort((a, b) => a.hostname.localeCompare(b.hostname));
}

// ─── Tailscale ─────────────────────────────────────────────────────

async function discoverTailscale(): Promise<DiscoveredDevice[]> {
	let stdout: string;
	try {
		stdout = (await execAsync("tailscale status --json", { timeout: 3000 })).stdout;
	} catch {
		return [];
	}

	const data = JSON.parse(stdout) as {
		Self?: { HostName: string; TailscaleIPs: string[]; OS: string };
		Peer?: Record<string, { HostName: string; TailscaleIPs: string[]; OS: string; Online: boolean }>;
	};

	const devices: DiscoveredDevice[] = [];

	// Add self
	if (data.Self) {
		devices.push({
			hostname: data.Self.HostName,
			source: "tailscale",
			address: data.Self.TailscaleIPs?.[0] ?? data.Self.HostName,
			tailscaleIp: data.Self.TailscaleIPs?.[0],
			os: data.Self.OS,
			tailscaleOnline: true,
			tags: ["self"],
		});
	}

	// Add peers
	for (const peer of Object.values(data.Peer ?? {})) {
		devices.push({
			hostname: peer.HostName,
			source: "tailscale",
			address: peer.TailscaleIPs?.[0] ?? peer.HostName,
			tailscaleIp: peer.TailscaleIPs?.[0],
			os: peer.OS,
			tailscaleOnline: peer.Online,
			tags: [],
		});
	}

	return devices;
}

// ─── SSH config ────────────────────────────────────────────────────

async function discoverSshConfig(): Promise<DiscoveredDevice[]> {
	const configPath = join(homedir(), ".ssh", "config");
	let content: string;
	try {
		content = await readFile(configPath, "utf-8");
	} catch {
		return [];
	}

	const devices: DiscoveredDevice[] = [];
	let currentHost: string | null = null;
	let currentHostName: string | null = null;

	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		const hostMatch = /^Host\s+(.+)$/i.exec(trimmed);
		const hostnameMatch = /^HostName\s+(.+)$/i.exec(trimmed);

		if (hostMatch) {
			if (currentHost && currentHostName) {
				devices.push({
					hostname: currentHost,
					source: "ssh-config",
					address: currentHostName,
					sshAlias: currentHost,
					tags: [],
				});
			}
			currentHost = hostMatch[1].trim();
			currentHostName = null;
		} else if (hostnameMatch && currentHost) {
			currentHostName = hostnameMatch[1].trim();
		}
	}

	// Last entry
	if (currentHost && currentHostName) {
		devices.push({
			hostname: currentHost,
			source: "ssh-config",
			address: currentHostName,
			sshAlias: currentHost,
			tags: [],
		});
	}

	return devices;
}

// ─── Known hosts ───────────────────────────────────────────────────

/** Hostnames that are clearly not fleet devices (Git hosts, CI, registries, etc.) */
const NON_DEVICE_HOSTS = new Set([
	"github.com",
	"bitbucket.org",
	"gitlab.com",
	"ssh.dev.azure.com",
	"vs-ssh.visualstudio.com",
	"registry.npmjs.org",
	"npm.pkg.github.com",
	"pypi.org",
	"crates.io",
	"docker.io",
	"index.docker.io",
	"ghcr.io",
	"gcr.io",
	"amazonaws.com",
	"cloudflare.com",
	"workers.dev",
]);

async function discoverKnownHosts(): Promise<DiscoveredDevice[]> {
	const path = join(homedir(), ".ssh", "known_hosts");
	let content: string;
	try {
		content = await readFile(path, "utf-8");
	} catch {
		return [];
	}

	const devices: DiscoveredDevice[] = [];
	const seen = new Set<string>();

	for (const line of content.split("\n")) {
		const host = line.trim().split(/\s+/)[0];
		if (!host || host.startsWith("#") || host === "*") continue;
		if (host.startsWith("|")) continue; // hashed
		for (const h of host.split(",")) {
			const clean = h.trim();
			if (!clean || seen.has(clean)) continue;
			seen.add(clean);
			// Skip Tailscale IPs (100.x.x.x) — come from Tailscale source
			if (/^100\.\d+\.\d+\.\d+$/.test(clean)) continue;
			// Skip known non-device hosts (GitHub, Bitbucket, etc.)
			if (NON_DEVICE_HOSTS.has(clean.toLowerCase())) continue;
			// Skip bare IPs that aren't Tailscale — not useful as fleet hosts
			if (/^\d+\.\d+\.\d+\.\d+$/.test(clean) && !clean.startsWith("100.")) continue;
			devices.push({
				hostname: clean,
				source: "known-hosts",
				address: clean,
				tags: [],
			});
		}
	}

	return devices;
}

// ─── ARP table ─────────────────────────────────────────────────────

async function discoverArp(): Promise<DiscoveredDevice[]> {
	let stdout: string;
	try {
		stdout = (await execAsync("arp -a", { timeout: 3000 })).stdout;
	} catch {
		return [];
	}

	const devices: DiscoveredDevice[] = [];
	// Format: hostname (ip) at mac on interface
	// macOS: "? (192.168.1.1) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]"
	// Linux: "? (192.168.1.1) at <incomplete> on en0"
	const lineRegex = /^(.+?)\s*\((.+?)\)\s+at\s+/;

	for (const line of stdout.split("\n")) {
		const match = lineRegex.exec(line.trim());
		if (!match) continue;
		const hostname = match[1].trim();
		const ip = match[2].trim();
		if (hostname === "?" || hostname === "incomplete") continue;
		// Skip local network gateways and self
		if (ip === "0.0.0.0" || ip.startsWith("224.") || ip.startsWith("239.")) continue;
		devices.push({
			hostname,
			source: "arp",
			address: ip,
			tags: [],
		});
	}

	return devices;
}

// ─── Merge ─────────────────────────────────────────────────────────

function mergeDevices(devices: DiscoveredDevice[]): DiscoveredDevice[] {
	const byHostname = new Map<string, DiscoveredDevice>();
	// Track short names to deduplicate Tailscale FQDNs (a2 vs a2.tail98d74a.ts.net)
	const shortNameToKey = new Map<string, string>();

	for (const device of devices) {
		const key = device.hostname.toLowerCase();

		// If this is a Tailscale FQDN (xxx.tailXXXX.ts.net), check if short name already exists
		const tsMatch = /^([^.]+)\..*\.ts\.net$/.exec(key);
		if (tsMatch) {
			const shortName = tsMatch[1];
			if (shortNameToKey.has(shortName)) {
				continue;
			}
		}

		// If this is a short name and a FQDN version exists, replace it
		const existingFqdnKey = Array.from(byHostname.keys()).find(
			(k) => k.startsWith(`${key}.`) && k.endsWith(".ts.net"),
		);
		if (existingFqdnKey) {
			byHostname.delete(existingFqdnKey);
		}

		const existing = byHostname.get(key);
		if (!existing) {
			byHostname.set(key, { ...device });
			const shortMatch = /^([^.]+)\..*\.ts\.net$/.exec(key);
			if (shortMatch) {
				shortNameToKey.set(shortMatch[1], key);
			} else {
				shortNameToKey.set(key, key);
			}
			continue;
		}
		// Merge: prefer Tailscale source, then ssh-config, then known-hosts, then arp
		const priority = { tailscale: 4, "ssh-config": 3, "known-hosts": 2, arp: 1, mdns: 1 };
		if (priority[device.source] > priority[existing.source]) {
			byHostname.set(key, {
				...device,
				tags: [...new Set([...device.tags, ...existing.tags])],
				sshAlias: device.sshAlias ?? existing.sshAlias,
			});
		} else {
			existing.tags = [...new Set([...existing.tags, ...device.tags])];
			if (!existing.sshAlias && device.sshAlias) existing.sshAlias = device.sshAlias;
			if (!existing.tailscaleIp && device.tailscaleIp) existing.tailscaleIp = device.tailscaleIp;
			if (!existing.os && device.os) existing.os = device.os;
			if (existing.tailscaleOnline === undefined && device.tailscaleOnline !== undefined) {
				existing.tailscaleOnline = device.tailscaleOnline;
			}
		}
	}

	return Array.from(byHostname.values());
}

// ─── Probing ───────────────────────────────────────────────────────

async function probeDevices(devices: DiscoveredDevice[], timeoutMs: number): Promise<void> {
	// Probe in parallel with a concurrency limit
	const CONCURRENCY = 10;
	const queue = [...devices];

	async function worker(): Promise<void> {
		while (queue.length > 0) {
			const device = queue.shift();
			if (!device) break;
			// Skip self
			if (device.tags.includes("self")) {
				device.online = true;
				device.sshable = true;
				device.hasPi = true;
				continue;
			}
			// Skip Tailscale-offline devices
			if (device.tailscaleOnline === false) {
				device.online = false;
				continue;
			}
			await probeDevice(device, timeoutMs);
		}
	}

	await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
}

async function probeDevice(device: DiscoveredDevice, timeoutMs: number): Promise<void> {
	const target = device.sshAlias ?? device.tailscaleIp ?? device.address;

	// Quick SSH probe: check if we can connect and run a simple command
	try {
		const result = await execAsync(
			`ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "${target}" 'echo ONLINE; which pi 2>/dev/null || which prime-agent 2>/dev/null; pi --version 2>/dev/null || prime-agent --version 2>/dev/null'`,
			{ timeout: timeoutMs },
		);
		const lines = result.stdout.trim().split("\n");
		device.online = lines[0] === "ONLINE";
		device.sshable = device.online;
		const piPath = lines[1];
		device.hasPi = Boolean(piPath);
		// Version might be on line 2 or 3
		const versionLine = lines.find((l) => /\d+\.\d+\.\d+/.test(l));
		device.piVersion = versionLine?.trim();
	} catch {
		// SSH failed — try a simple TCP connect to check if host is up
		if (device.tailscaleIp) {
			try {
				await execAsync(`tailscale ping --timeout=2s "${device.tailscaleIp}"`, { timeout: 4000 });
				device.online = true;
				device.sshable = false;
			} catch {
				device.online = false;
			}
		} else {
			device.online = false;
		}
	}
}

// ─── Helpers ───────────────────────────────────────────────────────

export function inferTags(device: DiscoveredDevice): string[] {
	const tags: string[] = [];
	if (device.os === "linux") tags.push("linux", "cloud");
	if (device.os === "macOS" || device.os === "darwin") tags.push("macos", "local");
	if (device.os === "android") tags.push("android");
	if (device.tailscaleIp) tags.push("tailscale");
	return tags;
}
