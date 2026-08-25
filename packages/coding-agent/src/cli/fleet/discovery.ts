/**
 * Device discovery — unconditional, streaming, pure network.
 *
 * One pipeline:
 *   addresses → probe → devices
 *
 * No conditionals about what tools are installed, what platform we're on,
 * or what IP ranges to skip. Every source just yields what it can.
 * Every address gets probed. Anything that responds is a device.
 *
 * Results stream in real-time via async generator — the TUI renders
 * devices as they're discovered, not in batches.
 */

import { exec } from "node:child_process";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface DiscoveredDevice {
	hostname: string;
	address: string;
	source: string;
	os?: string;
	online: boolean;
	sshable?: boolean;
	hasPi?: boolean;
	piVersion?: string;
	tailscaleIp?: string;
	tailscaleOnline?: boolean;
	tags: string[];
	inFleet?: boolean;
}

export interface DiscoveryOptions {
	probeTimeoutMs?: number;
	signal?: AbortSignal;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Streaming discovery. Yields devices as they're found — real-time.
 * No phases, no modes. One continuous stream.
 */
export async function* discoverStream(options: DiscoveryOptions = {}): AsyncGenerator<DiscoveredDevice> {
	const { probeTimeoutMs = 2000, signal } = options;
	const seen = new Set<string>();

	// Launch all address sources concurrently
	// Each is an async generator yielding addresses
	const sources = [fromTailscale(signal), fromRoutingTable(signal), fromNeighborCache(signal), fromMulticast(signal)];

	// Merge all sources into one stream, probe each address as it arrives
	const addressQueue: Promise<{ address: string; source: string; hints?: Partial<DiscoveredDevice> } | null>[] = [];

	for (const source of sources) {
		addressQueue.push(
			(async () => {
				const result = await source.next();
				return result.done ? null : result.value;
			})(),
		);
	}

	// Process addresses as they arrive from any source
	let activeSources = sources.length;
	while (activeSources > 0) {
		if (signal?.aborted) break;

		// Wait for any source to yield an address
		const result = await Promise.race(addressQueue.map((p, i) => p.then((v) => ({ v, i }))));

		if (result.v === null) {
			// Source exhausted — restart its slot with next() or mark done
			const source = sources[result.i];
			const next = await source.next();
			if (next.done) {
				activeSources--;
				addressQueue[result.i] = Promise.resolve(null);
			} else {
				addressQueue[result.i] = Promise.resolve(next.value);
			}
			continue;
		}

		// Got an address — probe it and yield the result
		const { address, source: src, hints } = result.v;
		const key = address.toLowerCase();

		if (seen.has(key)) {
			// Already discovered — restart source slot
			const source = sources[result.i];
			const next = await source.next();
			if (next.done) {
				activeSources--;
				addressQueue[result.i] = Promise.resolve(null);
			} else {
				addressQueue[result.i] = Promise.resolve(next.value);
			}
			continue;
		}

		seen.add(key);

		// Restart source slot for next iteration
		const source = sources[result.i];
		const next = await source.next();
		if (next.done) {
			activeSources--;
			addressQueue[result.i] = Promise.resolve(null);
		} else {
			addressQueue[result.i] = Promise.resolve(next.value);
		}

		// Probe and yield
		const device = await probeAddress(address, src, hints, probeTimeoutMs, signal);
		if (device) yield device;
	}
}

/**
 * Batch discovery — collects all results from the stream.
 * Convenience wrapper for CLI commands.
 */
export async function discoverDevices(options: DiscoveryOptions = {}): Promise<DiscoveredDevice[]> {
	const devices: DiscoveredDevice[] = [];
	for await (const device of discoverStream(options)) {
		devices.push(device);
	}
	return deduplicate(devices);
}

/**
 * Quick discovery — Tailscale + neighbor cache only, no ping sweep.
 * Probes all addresses in parallel. For when you need results in <2s.
 */
export async function discoverDevicesQuick(): Promise<DiscoveredDevice[]> {
	const addresses: AddressResult[] = [];

	for (const source of [fromTailscale(), fromNeighborCache()]) {
		for await (const addr of source) {
			addresses.push(addr);
		}
	}

	const probed = await Promise.allSettled(
		addresses.map((addr) => probeAddress(addr.address, addr.source, addr.hints, 1000)),
	);

	const devices: DiscoveredDevice[] = [];
	for (const result of probed) {
		if (result.status === "fulfilled" && result.value) {
			devices.push(result.value);
		}
	}

	return deduplicate(devices);
}

export function inferTags(device: DiscoveredDevice): string[] {
	const tags: string[] = [device.source];
	if (device.os) {
		const osLower = device.os.toLowerCase();
		if (osLower.includes("mac") || osLower.includes("darwin")) tags.push("macos", "local");
		else if (osLower.includes("linux")) tags.push("linux");
		else if (osLower.includes("android")) tags.push("android");
		else if (osLower.includes("windows")) tags.push("windows");
	}
	return [...new Set(tags)];
}

// ─── Address sources (all async generators, all unconditional) ──────

interface AddressResult {
	address: string;
	source: string;
	hints?: Partial<DiscoveredDevice>;
}

/** Tailscale peers — yields addresses from the Tailscale API */
async function* fromTailscale(signal?: AbortSignal): AsyncGenerator<AddressResult> {
	try {
		const { stdout } = await execAsync("tailscale status --json", { timeout: 5000, signal });
		const data = JSON.parse(stdout);

		if (data.Self?.TailscaleIPs?.[0] && data.Self?.HostName) {
			const selfDnsName = data.Self.DNSName?.replace(/\.ts\.net\.?$/, "").split(".")[0];
			yield {
				address: data.Self.TailscaleIPs[0],
				source: "tailscale",
				hints: {
					hostname: selfDnsName || data.Self.HostName,
					os: data.Self.OS,
					online: true,
					tailscaleIp: data.Self.TailscaleIPs[0],
					tailscaleOnline: true,
				},
			};
		}

		if (data.Peer) {
			for (const peer of Object.values(data.Peer) as Array<{
				HostName: string;
				DNSName?: string;
				TailscaleIPs?: string[];
				Online?: boolean;
				OS?: string;
			}>) {
				if (signal?.aborted) return;
				const ip = peer.TailscaleIPs?.[0];
				if (!ip || !peer.HostName) continue;
				// DNSName is the user-friendly Tailscale DNS name (e.g. "a2.tail98d74a.ts.net")
				// HostName is the machine's OS hostname (e.g. "AL-LINUX03")
				// Prefer the short DNS name — it's what the user sees in `tailscale status`
				const dnsName = peer.DNSName?.replace(/\.ts\.net\.?$/, "").split(".")[0];
				yield {
					address: ip,
					source: "tailscale",
					hints: {
						hostname: dnsName || peer.HostName,
						os: peer.OS,
						online: peer.Online ?? false,
						tailscaleIp: ip,
						tailscaleOnline: peer.Online ?? false,
					},
				};
			}
		}
	} catch {
		// Tailscale not installed or not running — empty stream
	}
}

/** Routing table → subnets → ping sweep → yields responding IPs */
async function* fromRoutingTable(signal?: AbortSignal): AsyncGenerator<AddressResult> {
	try {
		const subnets = await readRoutingTable();

		// Ping sweep all subnets in parallel
		const respondingIps = await pingSweepSubnets(subnets, signal);

		for (const ip of respondingIps) {
			if (signal?.aborted) return;
			yield { address: ip, source: "lan" };
		}
	} catch {
		// Can't read routing table — empty stream
	}
}

/** Neighbor cache (ARP + NDP) — yields already-known addresses */
async function* fromNeighborCache(signal?: AbortSignal): AsyncGenerator<AddressResult> {
	try {
		const { stdout } = await execAsync("arp -a", { timeout: 3000, signal });
		for (const line of stdout.split("\n")) {
			if (signal?.aborted) return;
			const ipMatch = line.match(/(\d+\.\d+\.\d+\.\d+)/);
			const macMatch = line.match(/([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}/);
			if (!ipMatch || !macMatch) continue;
			if (line.includes("incomplete")) continue;
			if (line.includes("permanent")) continue; // self
			yield { address: ipMatch[1], source: "lan", hints: { online: true } };
		}
	} catch {
		// Can't read ARP — empty stream
	}

	// NDP (IPv6 neighbor discovery)
	try {
		const { stdout } = await execAsync("ndp -an", { timeout: 3000, signal });
		for (const line of stdout.split("\n")) {
			if (signal?.aborted) return;
			// NDP format: "Neighbor MAC Address Interface"
			const ipMatch = line.match(/([0-9a-fA-F:]{2,})%/) || line.match(/^([0-9a-fA-F:]+)/);
			if (!ipMatch) continue;
			yield { address: ipMatch[1], source: "lan", hints: { online: true } };
		}
	} catch {
		// NDP not available or needs sudo — skip
	}
}

/** Multicast discovery — mDNS, SSDP/UPnP, NetBIOS */
async function* fromMulticast(signal?: AbortSignal): AsyncGenerator<AddressResult> {
	// mDNS — dns-sd on macOS, avahi on Linux
	const mdnsDevices = await discoverMdns(signal).catch(() => []);
	for (const device of mdnsDevices) {
		if (signal?.aborted) return;
		yield device;
	}

	// SSDP/UPnP — find routers, IoT devices, smart TVs
	const ssdpDevices = await discoverSsdp(signal).catch(() => []);
	for (const device of ssdpDevices) {
		if (signal?.aborted) return;
		yield device;
	}
}

// ─── Routing table reader ───────────────────────────────────────────

async function readRoutingTable(): Promise<{ subnet: string; cidr: number }[]> {
	const subnets: { subnet: string; cidr: number }[] = [];

	// Try macOS netstat first, then Linux ip route, then fallback to interfaces
	const commands = ["netstat -rn -f inet", "ip -4 route show"];

	for (const cmd of commands) {
		try {
			const { stdout } = await execAsync(cmd, { timeout: 3000 });
			for (const line of stdout.split("\n")) {
				const parsed = parseRouteLine(line, cmd.includes("netstat"));
				if (parsed) subnets.push(parsed);
			}
			if (subnets.length > 0) break; // First command that works wins
		} catch {}
	}

	// Fallback: derive subnets from network interfaces
	if (subnets.length === 0) {
		for (const addrs of Object.values(networkInterfaces())) {
			if (!addrs) continue;
			for (const addr of addrs) {
				if (addr.family === "IPv4" && !addr.internal) {
					const parts = addr.address.split(".");
					if (parts.length === 4) {
						subnets.push({ subnet: `${parts[0]}.${parts[1]}.${parts[2]}.0`, cidr: 24 });
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

function parseRouteLine(line: string, isMac: boolean): { subnet: string; cidr: number } | null {
	if (isMac) {
		// macOS: "192.168.100        link#11            UCS                   en0"
		const parts = line.trim().split(/\s+/);
		if (parts.length < 4) return null;
		const dest = parts[0];
		if (dest === "default" || dest.startsWith("169.254")) return null;

		if (dest.includes("/")) {
			const [ip, cidrStr] = dest.split("/");
			const cidr = Number.parseInt(cidrStr, 10);
			if (cidr < 22 || ip.startsWith("127.") || ip.startsWith("224.") || ip.startsWith("239.")) return null;
			return { subnet: ip, cidr };
		}

		// 3-octet network route → /24
		const octets = dest.split(".");
		if (octets.length === 3) {
			const ip = `${dest}.0`;
			if (ip.startsWith("127.") || ip.startsWith("224.") || ip.startsWith("239.")) return null;
			return { subnet: ip, cidr: 24 };
		}
		return null;
	}

	// Linux: "192.168.100.0/24 dev en0 proto kernel scope link src 192.168.100.81"
	const match = line.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)/);
	if (!match) return null;
	const [, ip, cidrStr] = match;
	const cidr = Number.parseInt(cidrStr, 10);
	if (
		cidr < 22 ||
		ip.startsWith("127.") ||
		ip.startsWith("169.254") ||
		ip.startsWith("224.") ||
		ip.startsWith("239.")
	) {
		return null;
	}
	return { subnet: ip, cidr };
}

// ─── Ping sweep ─────────────────────────────────────────────────────

async function pingSweepSubnets(subnets: { subnet: string; cidr: number }[], signal?: AbortSignal): Promise<string[]> {
	const allIps: string[] = [];
	for (const { subnet, cidr } of subnets) {
		allIps.push(...getHostsInSubnet(subnet, cidr));
	}

	// Ping all IPs in parallel, collect responders
	const pingBatch = 200; // concurrency limit
	const responders: string[] = [];

	for (let i = 0; i < allIps.length; i += pingBatch) {
		if (signal?.aborted) break;
		const batch = allIps.slice(i, i + pingBatch);
		const results = await Promise.allSettled(
			batch.map((ip) =>
				execAsync(`ping -c1 -W1 -t1 ${ip} 2>/dev/null && echo OK || true`, { timeout: 2000 })
					.then(({ stdout }) => (stdout.includes("OK") ? ip : null))
					.catch(() => null),
			),
		);
		for (const result of results) {
			if (result.status === "fulfilled" && result.value) {
				responders.push(result.value);
			}
		}
	}

	return responders;
}

function getHostsInSubnet(subnet: string, cidr: number): string[] {
	const parts = subnet.split(".").map(Number);
	if (parts.length !== 4) return [];

	const maxHosts = Math.min(254, 2 ** (32 - cidr) - 2);
	const hosts: string[] = [];
	for (let i = 1; i <= maxHosts; i++) {
		hosts.push(`${parts[0]}.${parts[1]}.${parts[2]}.${i}`);
	}
	return hosts;
}

// ─── mDNS ───────────────────────────────────────────────────────────

async function discoverMdns(signal?: AbortSignal): Promise<AddressResult[]> {
	const services = ["_ssh._tcp", "_workstation._tcp"];
	const devices: AddressResult[] = [];
	const seen = new Set<string>();

	// Try dns-sd (macOS) and avahi (Linux) in parallel
	const [macResult, linuxResult] = await Promise.allSettled([
		discoverMdnsMac(services, signal),
		discoverMdnsLinux(signal),
	]);

	if (macResult.status === "fulfilled") {
		for (const d of macResult.value) {
			const key = d.address.toLowerCase();
			if (!seen.has(key)) {
				seen.add(key);
				devices.push(d);
			}
		}
	}
	if (linuxResult.status === "fulfilled") {
		for (const d of linuxResult.value) {
			const key = d.address.toLowerCase();
			if (!seen.has(key)) {
				seen.add(key);
				devices.push(d);
			}
		}
	}

	return devices;
}

async function discoverMdnsMac(services: string[], signal?: AbortSignal): Promise<AddressResult[]> {
	const devices: AddressResult[] = [];
	const seen = new Set<string>();

	const results = await Promise.allSettled(
		services.map((service) =>
			execAsync(`dns-sd -B ${service} local.`, {
				timeout: 1500,
				killSignal: "SIGTERM",
				signal,
			}).catch(() => ({ stdout: "", stderr: "" })),
		),
	);

	for (const result of results) {
		if (result.status !== "fulfilled") continue;
		const output = result.value.stdout + result.value.stderr;
		for (const line of output.split("\n")) {
			const parts = line.trim().split(/\s+/);
			if (parts.length < 7 || !parts[0]?.match(/^\d+:\d+:\d+/)) continue;
			const instanceName = parts
				.slice(6)
				.join(" ")
				.replace(/\\[0-9]{3}/g, (m) => String.fromCharCode(Number.parseInt(m.slice(1), 8)));
			if (!instanceName || instanceName === "STARTING") continue;
			if (seen.has(instanceName.toLowerCase())) continue;
			seen.add(instanceName.toLowerCase());
			const hostname = instanceName.replace(/\.local\.?$/, "");
			devices.push({
				address: `${hostname}.local`,
				source: "mdns",
				hints: { hostname, online: true },
			});
		}
	}

	return devices;
}

async function discoverMdnsLinux(signal?: AbortSignal): Promise<AddressResult[]> {
	try {
		const result = await execAsync("avahi-browse -rtp _ssh._tcp", {
			timeout: 3000,
			killSignal: "SIGTERM",
			signal,
		});
		const devices: AddressResult[] = [];
		for (const line of result.stdout.split("\n")) {
			const parts = line.split(";");
			if (parts.length < 9 || parts[0] !== "=") continue;
			const hostname = parts[3].replace(/\.local\.?$/, "");
			const address = parts[7];
			if (hostname && address) {
				devices.push({ address, source: "mdns", hints: { hostname, online: true } });
			}
		}
		return devices;
	} catch {
		return [];
	}
}

// ─── SSDP/UPnP ──────────────────────────────────────────────────────

async function discoverSsdp(signal?: AbortSignal): Promise<AddressResult[]> {
	// SSDP uses UDP multicast to 239.255.255.250:1900
	// Works on any OS with raw UDP sockets — no tool dependency
	return new Promise((resolve) => {
		try {
			const dgram = require("node:dgram") as typeof import("node:dgram");
			const sock = dgram.createSocket("udp4");
			const devices: AddressResult[] = [];
			const seen = new Set<string>();

			sock.on("message", (msg, rinfo) => {
				const ip = rinfo.address;
				if (seen.has(ip)) return;
				seen.add(ip);
				const text = msg.toString("utf-8");
				// Extract SERVER or LOCATION header for device info
				let hostname = ip;
				for (const line of text.split("\r\n")) {
					const locMatch = line.match(/LOCATION:\s*http:\/\/([^:/]+)/i);
					if (locMatch) {
						hostname = locMatch[1];
						break;
					}
				}
				devices.push({ address: ip, source: "upnp", hints: { hostname, online: true } });
			});

			sock.on("error", () => {
				resolve([]);
			});

			sock.bind(0, () => {
				const msg = Buffer.from(
					'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n',
				);
				sock.setBroadcast(true);
				sock.send(msg, 1900, "239.255.255.250");

				// Collect responses for 2 seconds
				setTimeout(() => {
					sock.close();
					resolve(devices);
				}, 2000);
			});

			if (signal) {
				signal.addEventListener("abort", () => {
					sock.close();
					resolve(devices);
				});
			}
		} catch {
			resolve([]);
		}
	});
}

// ─── Probing ────────────────────────────────────────────────────────

async function probeAddress(
	address: string,
	source: string,
	hints?: Partial<DiscoveredDevice>,
	timeoutMs = 2000,
	signal?: AbortSignal,
): Promise<DiscoveredDevice | null> {
	// Resolve hostname — try reverse DNS, fall back to address
	let hostname = hints?.hostname ?? address;
	if (hostname === address) {
		try {
			const { stdout } = await execAsync(`dig +short -x ${address} 2>/dev/null || true`, {
				timeout: 1000,
				signal,
			});
			const dnsName = stdout
				.trim()
				.replace(/\.$/, "")
				.replace(/\.local\.?$/, "");
			if (dnsName && !dnsName.includes("in-addr")) hostname = dnsName;
		} catch {
			// use address as hostname
		}
	}

	const device: DiscoveredDevice = {
		hostname,
		address,
		source,
		online: hints?.online ?? false,
		os: hints?.os,
		tailscaleIp: hints?.tailscaleIp,
		tailscaleOnline: hints?.tailscaleOnline,
		tags: hints?.tags ?? [source],
	};

	// TCP probe port 22 (SSH)
	const sshOpen = await probePort(address, 22, Math.min(timeoutMs, 1500));
	device.sshable = sshOpen;
	if (sshOpen) device.online = true;

	// If SSH is open, check for pi/prime-agent
	if (sshOpen) {
		try {
			const sshTarget = hostname.includes(".") ? address : hostname;
			const { stdout } = await execAsync(
				`ssh -o ConnectTimeout=2 -o StrictHostKeyChecking=no -o BatchMode=yes ${sshTarget} "command -v pi && pi --version 2>/dev/null || command -v prime-agent && prime-agent --version 2>/dev/null || echo NOT_FOUND" 2>/dev/null`,
				{ timeout: timeoutMs, signal },
			).catch(() => ({ stdout: "NOT_FOUND" }));

			if (!stdout.includes("NOT_FOUND")) {
				device.hasPi = true;
				const versionMatch = stdout.trim().match(/(\d+\.\d+\.\d+)/);
				if (versionMatch) device.piVersion = versionMatch[1];
			}
		} catch {
			// SSH auth failed — still sshable
		}
	}

	// If we got no online signal from any source, do a quick ping
	if (!device.online && !hints?.online) {
		const pingOk = await pingAddress(address, 1000);
		device.online = pingOk;
	}

	return device;
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

function pingAddress(host: string, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		execAsync(`ping -c1 -W1 -t1 ${host} 2>/dev/null && echo OK || echo FAIL`, {
			timeout: timeoutMs + 1000,
		})
			.then(({ stdout }) => resolve(stdout.includes("OK")))
			.catch(() => resolve(false));
	});
}

// ─── Deduplication ──────────────────────────────────────────────────

function deduplicate(devices: DiscoveredDevice[]): DiscoveredDevice[] {
	const byHostname = new Map<string, DiscoveredDevice>();
	const hostnameByIp = new Map<string, string>();

	const priority: Record<string, number> = { tailscale: 3, mdns: 2, upnp: 2, lan: 1 };
	const sorted = [...devices].sort((a, b) => (priority[b.source] ?? 0) - (priority[a.source] ?? 0));

	for (const device of sorted) {
		const hostnameKey = device.hostname.toLowerCase();
		const ipKey = device.address;

		const existingByHostname = byHostname.get(hostnameKey);
		const existingByIp = hostnameByIp.get(ipKey) ? byHostname.get(hostnameByIp.get(ipKey)!) : undefined;
		const existing = existingByHostname ?? existingByIp;

		if (!existing) {
			byHostname.set(hostnameKey, { ...device });
			if (ipKey && ipKey !== hostnameKey) hostnameByIp.set(ipKey, hostnameKey);
			continue;
		}

		// Merge — higher priority source wins
		if ((priority[device.source] ?? 0) > (priority[existing.source] ?? 0)) {
			byHostname.set(hostnameKey, {
				...device,
				tags: [...new Set([...device.tags, ...existing.tags])],
				online: device.online || existing.online,
				os: device.os ?? existing.os,
				sshable: device.sshable ?? existing.sshable,
				hasPi: device.hasPi ?? existing.hasPi,
				piVersion: device.piVersion ?? existing.piVersion,
			});
		} else {
			existing.tags = [...new Set([...existing.tags, ...device.tags])];
			if (!existing.os && device.os) existing.os = device.os;
			if (!existing.sshable && device.sshable) existing.sshable = device.sshable;
			if (!existing.hasPi && device.hasPi) existing.hasPi = device.hasPi;
			if (!existing.piVersion && device.piVersion) existing.piVersion = device.piVersion;
			if (!existing.online && device.online) existing.online = true;
		}
	}

	return Array.from(byHostname.values());
}
