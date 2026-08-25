/**
 * Device discovery — find all devices accessible on the network using live protocols.
 *
 * Sources (all network-based, no config file parsing):
 * 1. Tailscale tailnet peers — `tailscale status --json` (live peer list with IPs, OS, online status)
 * 2. mDNS/Bonjour — `dns-sd -B` (discovers services advertising on local network)
 * 3. ARP table + ping sweep — discovers all IPs responding on local subnet
 * 4. SSH probe — `nc -z -w1 <ip> 22` (checks if SSH port is open)
 *
 * No hardcoded hostnames. No config file reading. Pure network discovery.
 */

import { exec } from "node:child_process";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface DiscoveredDevice {
	hostname: string;
	source: "tailscale" | "mdns" | "arp";
	address: string;
	tailscaleIp?: string;
	os?: string;
	tailscaleOnline?: boolean;
	tags: string[];
	online?: boolean;
	sshable?: boolean;
	hasPi?: boolean;
	piVersion?: string;
	inFleet?: boolean;
}

export interface DiscoveryOptions {
	/** Skip SSH/pi probing (fast discovery only). */
	skipProbe?: boolean;
	/** Probe timeout per host in ms. */
	probeTimeoutMs?: number;
}

// ─── Public API ─────────────────────────────────────────────────────

export async function discoverDevices(options: DiscoveryOptions = {}): Promise<DiscoveredDevice[]> {
	const { skipProbe = false, probeTimeoutMs = 3000 } = options;

	// Phase 1: fast discovery — Tailscale + mDNS (instant, no network scanning)
	const [tailscaleDevices, mdnsDevices] = await Promise.all([
		discoverTailscale().catch(() => []),
		discoverMdns().catch(() => []),
	]);

	let devices = mergeDevices([...tailscaleDevices, ...mdnsDevices]);

	// Phase 2: ARP ping sweep — slower, finds local LAN devices
	const arpDevices = await discoverArp().catch(() => []);
	devices = mergeDevices([...devices, ...arpDevices]);

	if (!skipProbe) {
		await probeDevices(devices, probeTimeoutMs);
	}

	return devices;
}

/**
 * Fast discovery only — Tailscale + mDNS, no ping sweep or SSH probing.
 * Use this for instant results, then call discoverDevices() for full discovery.
 */
export async function discoverDevicesFast(): Promise<DiscoveredDevice[]> {
	const [tailscaleDevices, mdnsDevices] = await Promise.all([
		discoverTailscale().catch(() => []),
		discoverMdns().catch(() => []),
	]);
	return mergeDevices([...tailscaleDevices, ...mdnsDevices]);
}

export function inferTags(device: DiscoveredDevice): string[] {
	const tags: string[] = [];
	if (device.source === "tailscale") tags.push("tailscale");
	if (device.os) {
		const osLower = device.os.toLowerCase();
		if (osLower.includes("mac") || osLower.includes("darwin")) tags.push("macos", "local");
		else if (osLower.includes("linux")) tags.push("linux", "cloud");
		else if (osLower.includes("android")) tags.push("android");
		else if (osLower.includes("windows")) tags.push("windows");
	}
	return [...new Set(tags)];
}

// ─── Tailscale — live peer API ──────────────────────────────────────

async function discoverTailscale(): Promise<DiscoveredDevice[]> {
	let stdout: string;
	try {
		stdout = (await execAsync("tailscale status --json", { timeout: 5000 })).stdout;
	} catch {
		return [];
	}

	const data = JSON.parse(stdout);
	const devices: DiscoveredDevice[] = [];

	// Self
	if (data.Self) {
		const self = data.Self;
		const ip = self.TailscaleIPs?.[0];
		if (ip && self.HostName) {
			devices.push({
				hostname: self.HostName,
				source: "tailscale",
				address: ip,
				tailscaleIp: ip,
				os: self.OS,
				tailscaleOnline: true,
				online: true,
				tags: inferTagsForOs(self.OS, "tailscale"),
			});
		}
	}

	// Peers
	if (data.Peer) {
		for (const peer of Object.values(data.Peer) as Array<{
			HostName: string;
			TailscaleIPs?: string[];
			Online?: boolean;
			OS?: string;
			LastSeen?: string;
		}>) {
			const ip = peer.TailscaleIPs?.[0];
			if (!ip || !peer.HostName) continue;
			devices.push({
				hostname: peer.HostName,
				source: "tailscale",
				address: ip,
				tailscaleIp: ip,
				os: peer.OS,
				tailscaleOnline: peer.Online ?? false,
				online: peer.Online ?? false,
				tags: inferTagsForOs(peer.OS, "tailscale"),
			});
		}
	}

	return devices;
}

function inferTagsForOs(os: string | undefined, source: string): string[] {
	const tags = [source];
	if (os) {
		const osLower = os.toLowerCase();
		if (osLower.includes("mac") || osLower.includes("darwin")) tags.push("macos", "local");
		else if (osLower.includes("linux")) tags.push("linux", "cloud");
		else if (osLower.includes("android")) tags.push("android");
	}
	return tags;
}

// ─── mDNS/Bonjour — service discovery on local network ──────────────

async function discoverMdns(): Promise<DiscoveredDevice[]> {
	// dns-sd is macOS-only. On Linux, avahi-browse can be used.
	const isMac = process.platform === "darwin";
	if (!isMac) return discoverMdnsLinux();

	// Only browse _ssh._tcp and _workstation._tcp — most relevant for fleet
	// Other services (afp, smb, airplay) are not useful for SSH-based fleet management
	const services = ["_ssh._tcp", "_workstation._tcp"];

	const devices: DiscoveredDevice[] = [];
	const seen = new Set<string>();

	// Browse all services in parallel (each has 1.5s timeout)
	const results = await Promise.allSettled(
		services.map((service) =>
			execAsync(`dns-sd -B ${service} local.`, {
				timeout: 1500,
				killSignal: "SIGTERM",
			}).catch(() => ({ stdout: "", stderr: "" })),
		),
	);

	for (const result of results) {
		if (result.status !== "fulfilled") continue;
		const output = result.value.stdout + result.value.stderr;
		for (const line of output.split("\n")) {
			const parts = line.trim().split(/\s+/);
			if (parts.length < 7) continue;
			if (!parts[0]?.match(/^\d+:\d+:\d+/)) continue;
			const instanceName = parts
				.slice(6)
				.join(" ")
				.replace(/\\[0-9]{3}/g, (m) => String.fromCharCode(Number.parseInt(m.slice(1), 8)));
			if (!instanceName || instanceName === "STARTING") continue;
			if (seen.has(instanceName.toLowerCase())) continue;
			seen.add(instanceName.toLowerCase());

			const hostname = instanceName.replace(/\.local\.?$/, "");
			devices.push({
				hostname,
				source: "mdns",
				address: `${hostname}.local`,
				tags: ["local", "mdns"],
				online: true,
			});
		}
	}

	return devices;
}

async function discoverMdnsLinux(): Promise<DiscoveredDevice[]> {
	try {
		const result = await execAsync("avahi-browse -rtp _ssh._tcp", {
			timeout: 3000,
			killSignal: "SIGTERM",
		}).catch(() => ({ stdout: "" }));

		const devices: DiscoveredDevice[] = [];
		for (const line of result.stdout.split("\n")) {
			// avahi-browse -p output: =;eth0;IPv4;hostname;_ssh._tcp;local;hostname.local;192.168.x.x;22;
			const parts = line.split(";");
			if (parts.length < 9 || parts[0] !== "=") continue;
			const hostname = parts[3].replace(/\.local\.?$/, "");
			const address = parts[7];
			if (!hostname || !address) continue;
			devices.push({
				hostname,
				source: "mdns",
				address,
				tags: ["local", "mdns"],
				online: true,
			});
		}
		return devices;
	} catch {
		return [];
	}
}

// ─── Routing table + ARP — all reachable IPs on ALL connected networks ─

/**
 * Read the routing table to find ALL directly-connected networks.
 * This catches local LAN (en0), VPN interfaces (utun0, wg0, tailscale0),
 * Docker bridges (docker0), and any other interface the kernel knows about.
 *
 * Pure network — no config files, no platform-specific APIs.
 */
async function getConnectedSubnets(): Promise<{ subnet: string; cidr: number; interface: string }[]> {
	// macOS: netstat -rn
	// Linux: ip route
	const isMac = process.platform === "darwin";
	const subnets: { subnet: string; cidr: number; interface: string }[] = [];

	try {
		if (isMac) {
			const { stdout } = await execAsync("netstat -rn -f inet", { timeout: 3000 });
			for (const line of stdout.split("\n")) {
				// macOS netstat format:
				// "192.168.100        link#11            UCS                   en0"  ← network route (3 octets)
				// "192.168.100.1      f8:28:c9:..        UHLWIir               en0"  ← host route (4 octets)
				// "100.64/10           link#21            UCS                 utun0"  ← CIDR route
				const parts = line.trim().split(/\s+/);
				if (parts.length < 4) continue;
				const dest = parts[0];
				const iface = parts[parts.length - 1];

				// Skip default routes, link-local
				if (dest === "default" || dest.startsWith("169.254")) continue;

				let ip: string;
				let cidr: number;

				if (dest.includes("/")) {
					const [ipPart, cidrPart] = dest.split("/");
					ip = ipPart;
					cidr = Number.parseInt(cidrPart, 10);
				} else {
					// No CIDR — on macOS, network routes show 3 octets (e.g. "192.168.100")
					// Host routes show 4 octets (e.g. "192.168.100.1") — skip those
					const octets = dest.split(".");
					if (octets.length === 3) {
						// Network route like "192.168.100" → /24
						ip = `${dest}.0`;
						cidr = 24;
					} else if (octets.length === 4) {
						// Host route — skip (individual host, not a network)
						continue;
					} else {
						continue;
					}
				}

				// Skip very large ranges (too slow to sweep)
				if (cidr < 22) continue;
				// Skip loopback
				if (ip.startsWith("127.")) continue;
				// Skip Tailscale 100.x — handled by Tailscale API
				if (ip.startsWith("100.")) continue;
				// Skip multicast
				if (ip.startsWith("224.") || ip.startsWith("239.")) continue;

				subnets.push({ subnet: ip, cidr, interface: iface });
			}
		} else {
			// Linux: ip route
			const { stdout } = await execAsync("ip -4 route show", { timeout: 3000 });
			for (const line of stdout.split("\n")) {
				// Format: "192.168.100.0/24 dev en0 proto kernel scope link src 192.168.100.81"
				const match = line.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+).*dev\s+(\S+)/);
				if (!match) continue;
				const [, ip, cidrStr, iface] = match;
				const cidr = Number.parseInt(cidrStr, 10);
				if (cidr < 22) continue;
				if (ip.startsWith("127.") || ip.startsWith("169.254")) continue;
				if (ip.startsWith("100.")) continue;
				subnets.push({ subnet: ip, cidr, interface: iface });
			}
		}
	} catch {
		// Fallback: use networkInterfaces()
		const interfaces = networkInterfaces();
		for (const [name, addrs] of Object.entries(interfaces)) {
			if (!addrs) continue;
			for (const addr of addrs) {
				if (addr.family === "IPv4" && !addr.internal) {
					const parts = addr.address.split(".");
					if (parts.length === 4) {
						subnets.push({ subnet: `${parts[0]}.${parts[1]}.${parts[2]}.0`, cidr: 24, interface: name });
					}
				}
			}
		}
	}

	// Deduplicate
	const seen = new Set<string>();
	return subnets.filter((s) => {
		const key = `${s.subnet}/${s.cidr}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

async function discoverArp(): Promise<DiscoveredDevice[]> {
	const subnets = await getConnectedSubnets();
	if (subnets.length === 0) return [];

	// Ping sweep all subnets in parallel to populate ARP table
	await pingSweep(subnets);

	// Read ARP table — all IPs that responded
	const arpDevices = await readArpTable();
	return arpDevices;
}

async function pingSweep(subnets: { subnet: string; cidr: number }[]): Promise<void> {
	const pings: Promise<void>[] = [];

	for (const { subnet, cidr } of subnets) {
		const hosts = getHostsInSubnet(subnet, cidr);
		for (const ip of hosts) {
			pings.push(
				execAsync(`ping -c1 -W1 -t1 ${ip} 2>/dev/null || true`, { timeout: 2000 }).then(
					() => {},
					() => {},
				),
			);
		}
	}

	await Promise.allSettled(pings);
}

/**
 * Generate all host IPs in a subnet (excluding network and broadcast).
 * Only supports /24 to /30 (smaller subnets — larger ones skipped earlier).
 */
function getHostsInSubnet(subnet: string, cidr: number): string[] {
	const parts = subnet.split(".").map(Number);
	if (parts.length !== 4) return [];

	if (cidr === 24) {
		const hosts: string[] = [];
		for (let i = 1; i <= 254; i++) hosts.push(`${parts[0]}.${parts[1]}.${parts[2]}.${i}`);
		return hosts;
	}
	if (cidr === 25) {
		const base = parts[3] & 0xfe;
		return [`${parts[0]}.${parts[1]}.${parts[2]}.${base + 1}`, `${parts[0]}.${parts[1]}.${parts[2]}.${base + 2}`];
	}
	if (cidr === 26) {
		const base = parts[3] & 0xfc;
		const hosts: string[] = [];
		for (let i = 1; i <= 62; i++) hosts.push(`${parts[0]}.${parts[1]}.${parts[2]}.${base + i}`);
		return hosts;
	}
	if (cidr === 27) {
		const base = parts[3] & 0xf8;
		const hosts: string[] = [];
		for (let i = 1; i <= 30; i++) hosts.push(`${parts[0]}.${parts[1]}.${parts[2]}.${base + i}`);
		return hosts;
	}
	if (cidr === 28) {
		const base = parts[3] & 0xf0;
		const hosts: string[] = [];
		for (let i = 1; i <= 14; i++) hosts.push(`${parts[0]}.${parts[1]}.${parts[2]}.${base + i}`);
		return hosts;
	}
	if (cidr === 30) {
		const base = parts[3] & 0xfc;
		return [`${parts[0]}.${parts[1]}.${parts[2]}.${base + 1}`, `${parts[0]}.${parts[1]}.${parts[2]}.${base + 2}`];
	}
	// /22 or larger — cap at 512 hosts
	if (cidr <= 22) {
		const hosts: string[] = [];
		for (let i = 1; i <= 512 && i <= 1022; i++) hosts.push(`${parts[0]}.${parts[1]}.${parts[2]}.${i}`);
		return hosts;
	}
	return [];
}

async function readArpTable(): Promise<DiscoveredDevice[]> {
	try {
		const { stdout } = await execAsync("arp -a", { timeout: 3000 });
		const devices: DiscoveredDevice[] = [];

		for (const line of stdout.split("\n")) {
			// macOS: "? (192.168.100.1) at f8:28:c9:7:96:94 on en0 ifscope [ethernet]"
			// Linux: "192.168.100.1 ether f8:28:c9:7:96:94 C en0"
			const macMatch = line.match(
				/([0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2})/,
			);
			const ipMatch = line.match(/(\d+\.\d+\.\d+\.\d+)/);

			if (!macMatch || !ipMatch) continue;
			const mac = macMatch[1];
			const ip = ipMatch[1];

			// Skip incomplete MACs (device didn't respond)
			if (mac.includes("incomplete") || mac === "0:0:0:0:0:0") continue;

			// Skip multicast/broadcast addresses
			if (ip.startsWith("224.") || ip.startsWith("239.") || ip === "255.255.255.255") continue;

			// Skip self (local interfaces have "permanent" flag on macOS)
			if (line.includes("permanent")) continue;

			// Generate hostname from MAC — try reverse DNS first, fall back to IP
			let hostname = ip;
			try {
				const { stdout: dnsResult } = await execAsync(`dig +short -x ${ip} 2>/dev/null || true`, {
					timeout: 1000,
				});
				const dnsName = dnsResult.trim().replace(/\.$/, "");
				if (dnsName && !dnsName.includes("in-addr")) {
					hostname = dnsName.replace(/\.local\.?$/, "");
				}
			} catch {
				// Use IP as hostname
			}

			devices.push({
				hostname,
				source: "arp",
				address: ip,
				tags: ["local", "lan"],
				online: true, // In ARP table = responded to ARP = online
			});
		}

		return devices;
	} catch {
		return [];
	}
}

// ─── Merge & deduplicate ────────────────────────────────────────────

function mergeDevices(devices: DiscoveredDevice[]): DiscoveredDevice[] {
	// Use a single map keyed by hostname, with IP-based cross-referencing
	const byHostname = new Map<string, DiscoveredDevice>();
	const hostnameByIp = new Map<string, string>(); // ip -> hostname key

	const priority: Record<string, number> = { tailscale: 3, mdns: 2, arp: 1 };
	const sorted = [...devices].sort((a, b) => (priority[b.source] ?? 0) - (priority[a.source] ?? 0));

	for (const device of sorted) {
		const hostnameKey = device.hostname.toLowerCase();
		const ipKey = device.address;

		// Find existing by hostname or by IP cross-reference
		const existingByHostname = byHostname.get(hostnameKey);
		const existingHostnameByIp = hostnameByIp.get(ipKey);
		const existingByIp = existingHostnameByIp ? byHostname.get(existingHostnameByIp) : undefined;
		const existing = existingByHostname ?? existingByIp;

		if (!existing) {
			const entry = { ...device };
			byHostname.set(hostnameKey, entry);
			if (ipKey && ipKey !== hostnameKey) {
				hostnameByIp.set(ipKey, hostnameKey);
			}
			continue;
		}

		// Merge — higher priority source wins, enrich with lower priority info
		if (priority[device.source] > priority[existing.source]) {
			const replacement = {
				...device,
				tags: [...new Set([...device.tags, ...existing.tags])],
				online: device.online ?? existing.online,
				os: device.os ?? existing.os,
			};
			byHostname.set(hostnameKey, replacement);
			if (ipKey && ipKey !== hostnameKey) {
				hostnameByIp.set(ipKey, hostnameKey);
			}
		} else {
			existing.tags = [...new Set([...existing.tags, ...device.tags])];
			if (!existing.os && device.os) existing.os = device.os;
			if (existing.online === undefined && device.online !== undefined) {
				existing.online = device.online;
			}
			// Cross-reference IP if we don't have it
			if (ipKey && !hostnameByIp.has(ipKey)) {
				hostnameByIp.set(ipKey, hostnameKey);
			}
		}
	}

	return Array.from(byHostname.values());
}

// ─── Probing — SSH + pi detection ───────────────────────────────────

async function probeDevices(devices: DiscoveredDevice[], timeoutMs: number): Promise<void> {
	const probeConcurrency = 10;
	const chunks: DiscoveredDevice[][] = [];
	for (let i = 0; i < devices.length; i += probeConcurrency) {
		chunks.push(devices.slice(i, i + probeConcurrency));
	}

	for (const chunk of chunks) {
		await Promise.allSettled(chunk.map((d) => probeSingleDevice(d, timeoutMs)));
	}
}

async function probeSingleDevice(device: DiscoveredDevice, timeoutMs: number): Promise<void> {
	const address = device.tailscaleIp ?? device.address;
	if (!address) return;

	// Quick TCP connect to port 22 (SSH)
	const sshOpen = await probePort(address, 22, Math.min(timeoutMs, 2000));
	device.sshable = sshOpen;
	if (sshOpen && device.online === undefined) device.online = true;

	// If SSH is open, try to detect pi
	if (sshOpen) {
		try {
			const sshTarget = device.hostname.includes(".") ? address : device.hostname;
			const { stdout } = await execAsync(
				`ssh -o ConnectTimeout=2 -o StrictHostKeyChecking=no -o BatchMode=yes ${sshTarget} "command -v pi && pi --version 2>/dev/null || command -v prime-agent && prime-agent --version 2>/dev/null || echo NOT_FOUND" 2>/dev/null`,
				{ timeout: timeoutMs },
			).catch(() => ({ stdout: "NOT_FOUND" }));

			if (!stdout.includes("NOT_FOUND")) {
				device.hasPi = true;
				const versionMatch = stdout.trim().match(/(\d+\.\d+\.\d+)/);
				if (versionMatch) device.piVersion = versionMatch[1];
			}
		} catch {
			// SSH auth failed — still sshable (port is open), just can't check pi
		}
	}
}

function probePort(host: string, port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const cmd =
			process.platform === "darwin"
				? `nc -z -w${Math.ceil(timeoutMs / 1000)} ${host} ${port} 2>/dev/null && echo OK || echo FAIL`
				: `timeout ${Math.ceil(timeoutMs / 1000)} bash -c "echo > /dev/tcp/${host}/${port}" 2>/dev/null && echo OK || echo FAIL`;

		execAsync(cmd, { timeout: timeoutMs + 1000 })
			.then(({ stdout }) => resolve(stdout.includes("OK")))
			.catch(() => resolve(false));
	});
}
