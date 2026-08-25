/**
 * Interactive TUI component for managing the fleet.
 *
 * Features:
 * - Auto-discovers on open (fast first, background probe second)
 * - Search/filter with fuzzy matching
 * - Grouped display: FLEET → ONLINE → OFFLINE with colored headers
 * - Multi-select with checkboxes: Space toggles, Enter batch-adds/removes
 * - Enter on unchecked item opens host action menu
 * - Color-coded status: green=online, red=offline, accent=fleet, dim=muted
 * - Aligned columns: checkbox | hostname | os | tags | status badges
 */

import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { bootstrapHost, checkHostStatus, disconnectHost } from "../../../cli/fleet/bootstrap.js";
import { type DiscoveredDevice, discoverStream, inferTags } from "../../../cli/fleet/discovery.js";
import {
	addFleetHost,
	type FleetHost,
	listFleetHosts,
	removeFleetHost,
	updateFleetHostStatus,
} from "../../../cli/fleet/fleet-config.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

type FleetView = "main" | "host-actions";

interface FleetEntry {
	hostname: string;
	address: string;
	os?: string;
	tags: string[];
	source: "fleet" | "discovered";
	online: boolean;
	sshable: boolean;
	hasPi: boolean;
	piVersion?: string;
	inFleet: boolean;
	fleetHost?: FleetHost;
	device?: DiscoveredDevice;
}

export class FleetSelectorComponent extends Container implements Focusable {
	focused = false;
	private searchInput: Input;
	private currentView: FleetView = "main";
	private entries: FleetEntry[] = [];
	private filteredEntries: FleetEntry[] = [];
	private selectedEntry: FleetEntry | null = null;
	private cursorIndex = 0;
	private checkedSet = new Set<string>();
	private statusText = "";
	private isLoading = false;
	private readonly onDone: () => void;
	private readonly requestRender: () => void;

	constructor(onDone: () => void, _onCancel: () => void, requestRender: () => void) {
		super();
		this.onDone = onDone;
		this.requestRender = requestRender;
		this.searchInput = new Input();
		this.isLoading = true;
		this.statusText = "Discovering networked devices...";

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", " Fleet Manager")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", this.statusText), 1, 0));
		this.addChild(new DynamicBorder());

		void this.autoDiscover();
	}

	getSearchInput(): Input {
		return this.searchInput;
	}

	// ─── Auto-discover — single streaming pipeline ───────────────────

	private async autoDiscover(): Promise<void> {
		this.setLoading("Discovering networked devices...");

		// Load fleet hosts first — they appear instantly
		const fleetHosts = await listFleetHosts();
		this.clearLoading();
		this.entries = mergeHostsAndDevices(fleetHosts, []);
		this.applyFilter();

		// Stream devices as they're discovered — no phases, no batches
		// Each device appears in the TUI the moment it's found
		try {
			for await (const device of discoverStream({ probeTimeoutMs: 2000 })) {
				this.mergeDevice(device);
				if (this.currentView === "main") {
					this.applyFilter();
				}
			}
		} catch {
			// Discovery interrupted — keep what we have
		}

		this.statusText = `Discovery complete · ${this.entries.length} devices`;
		if (this.currentView === "main") {
			this.applyFilter();
		}
	}

	private mergeDevice(device: DiscoveredDevice): void {
		const existing = this.entries.find(
			(e) => e.hostname.toLowerCase() === device.hostname.toLowerCase() || e.address === device.address,
		);

		if (existing) {
			// Enrich existing entry with new info
			existing.online = device.online || existing.online;
			existing.sshable = device.sshable ?? existing.sshable;
			existing.hasPi = device.hasPi ?? existing.hasPi;
			existing.piVersion = device.piVersion ?? existing.piVersion;
			if (!existing.os && device.os) existing.os = device.os;
			existing.tags = [...new Set([...existing.tags, ...inferTags(device)])];
			existing.device = device;
		} else {
			this.entries.push({
				hostname: device.hostname,
				address: device.tailscaleIp ?? device.address,
				os: device.os,
				tags: inferTags(device),
				source: "discovered",
				online: device.online,
				sshable: device.sshable ?? false,
				hasPi: device.hasPi ?? false,
				piVersion: device.piVersion,
				inFleet: false,
				device,
			});
		}
	}

	// ─── Filtering ────────────────────────────────────────────────────

	private applyFilter(): void {
		const query = this.searchInput.getValue().trim();
		if (!query) {
			this.filteredEntries = [...this.entries];
		} else {
			this.filteredEntries = fuzzyFilter(this.entries, query, (e) => e.hostname);
		}
		// Sort: fleet first, then online, then offline, then alpha
		this.filteredEntries.sort((a, b) => {
			if (a.inFleet !== b.inFleet) return a.inFleet ? -1 : 1;
			if (a.online !== b.online) return a.online ? -1 : 1;
			return a.hostname.localeCompare(b.hostname);
		});
		if (this.cursorIndex >= this.filteredEntries.length) {
			this.cursorIndex = Math.max(0, this.filteredEntries.length - 1);
		}
		this.rebuildChildren();
	}

	// ─── Rendering ────────────────────────────────────────────────────

	private rebuildChildren(): void {
		this.children = [];
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", " Fleet Manager")), 1, 0));
		this.addChild(new Spacer(1));

		// Search bar
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		// Device list with group headers
		if (this.isLoading) {
			this.addChild(new Text(theme.fg("dim", `  ${this.statusText}`), 1, 0));
		} else if (this.filteredEntries.length === 0) {
			this.addChild(new Text(theme.fg("dim", "  No devices found"), 1, 0));
		} else if (this.currentView === "main") {
			this.renderGroupedList();
		} else {
			this.renderHostActions();
		}

		this.addChild(new Spacer(1));
		this.addChild(new Text(this.getStatusLine(), 1, 0));
		this.addChild(new DynamicBorder());
		this.requestRender();
	}

	private renderGroupedList(): void {
		const fleetItems = this.filteredEntries.filter((e) => e.inFleet);
		const onlineItems = this.filteredEntries.filter((e) => !e.inFleet && e.online);
		const offlineItems = this.filteredEntries.filter((e) => !e.inFleet && !e.online);

		let virtualIndex = 0;

		if (fleetItems.length > 0) {
			this.addChild(new Text(theme.fg("accent", theme.bold(` FLEET (${fleetItems.length})`)), 1, 0));
			for (const entry of fleetItems) {
				this.addDeviceRow(entry, virtualIndex);
				virtualIndex++;
			}
			this.addChild(new Spacer(1));
		}

		if (onlineItems.length > 0) {
			this.addChild(new Text(theme.fg("success", theme.bold(` ONLINE (${onlineItems.length})`)), 1, 0));
			for (const entry of onlineItems) {
				this.addDeviceRow(entry, virtualIndex);
				virtualIndex++;
			}
		}

		if (offlineItems.length > 0) {
			if (onlineItems.length > 0 || fleetItems.length > 0) {
				this.addChild(new Spacer(1));
			}
			this.addChild(new Text(theme.fg("dim", theme.bold(` OFFLINE (${offlineItems.length})`)), 1, 0));
			for (const entry of offlineItems) {
				this.addDeviceRow(entry, virtualIndex);
				virtualIndex++;
			}
		}
	}

	private addDeviceRow(entry: FleetEntry, virtualIndex: number): void {
		const isSelected = virtualIndex === this.cursorIndex;
		const isChecked = this.checkedSet.has(entry.hostname);

		// Checkbox
		const checkbox = isChecked ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");

		// Hostname with color
		const hostnameColor = entry.inFleet ? "accent" : entry.online ? "text" : "dim";
		const hostname = theme.fg(hostnameColor, truncateToWidth(entry.hostname, 22, ""));

		// OS badge
		const osBadge = entry.os ? this.formatOsBadge(entry.os) : "";

		// Status badges
		const badges = this.formatBadges(entry);

		// Cursor prefix
		const prefix = isSelected ? theme.fg("accent", "›") : " ";

		const padding = " ".repeat(Math.max(1, 24 - visibleWidth(entry.hostname)));
		const row = `${prefix} ${checkbox} ${hostname}${padding}${osBadge} ${badges}`;
		this.addChild(new Text(row, 1, 0));
	}

	private formatOsBadge(os: string): string {
		const osLower = os.toLowerCase();
		if (osLower.includes("mac") || osLower.includes("darwin")) {
			return theme.fg("warning", "macOS".padEnd(7));
		}
		if (osLower.includes("linux")) {
			return theme.fg("success", "Linux ".padEnd(7));
		}
		if (osLower.includes("android")) {
			return theme.fg("muted", "Andrd ".padEnd(7));
		}
		return theme.fg("dim", "?     ".padEnd(7));
	}

	private formatBadges(entry: FleetEntry): string {
		const parts: string[] = [];
		if (entry.sshable) parts.push(theme.fg("success", "ssh"));
		if (entry.hasPi) parts.push(theme.fg("success", "pi"));
		if (entry.inFleet) parts.push(theme.fg("accent", "●fleet"));
		if (!entry.online && !entry.inFleet) parts.push(theme.fg("error", "offline"));
		if (entry.tags.length > 0 && !entry.inFleet) {
			parts.push(theme.fg("dim", entry.tags.slice(0, 2).join(",")));
		}
		return parts.length > 0 ? parts.join(" ") : "";
	}

	private renderHostActions(): void {
		const entry = this.selectedEntry;
		if (!entry) return;

		this.addChild(new Text(theme.fg("accent", ` ${entry.hostname}`), 1, 0));
		this.addChild(new Text(theme.fg("dim", ` ${entry.address} · ${entry.os ?? "?"}`), 1, 0));
		this.addChild(new Spacer(1));

		const actions: { key: string; label: string; desc: string }[] = [
			{ key: "s", label: "Check status", desc: "Probe SSH, pi, daemon" },
			{
				key: "b",
				label: "Bootstrap",
				desc: entry.piVersion ? `Pi ${entry.piVersion} installed` : "Install pi + start daemon",
			},
			{ key: "c", label: "Connect", desc: "Mark as connected" },
			{ key: "d", label: "Disconnect", desc: "Stop daemon on host" },
		];
		if (entry.inFleet) {
			actions.push({ key: "x", label: "Remove from fleet", desc: "Unregister this host" });
		} else {
			actions.push({ key: "a", label: "Add to fleet", desc: `Tags: ${entry.tags.join(", ")}` });
		}

		for (const action of actions) {
			this.addChild(
				new Text(`  ${theme.fg("accent", action.key)}  ${action.label}  ${theme.fg("dim", action.desc)}`, 1, 0),
			);
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Press key to execute · esc to go back"), 1, 0));
	}

	private getStatusLine(): string {
		if (this.currentView === "host-actions") {
			return theme.fg("dim", "  Action mode · esc to go back");
		}
		const total = this.entries.length;
		const online = this.entries.filter((e) => e.online).length;
		const fleet = this.entries.filter((e) => e.inFleet).length;
		const checked = this.checkedSet.size;
		const checkInfo = checked > 0 ? theme.fg("accent", ` ${checked} selected`) : "";
		return `${theme.fg("dim", `  ${total} devices · ${online} online · ${fleet} in fleet`)}${checkInfo}  ${theme.fg("dim", "Space select · Enter add/remove · / search · q quit")}`;
	}

	// ─── Keyboard ─────────────────────────────────────────────────────

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (this.currentView === "host-actions") {
			this.handleHostActionsInput(data);
			return;
		}

		// 'q' to quit (only when search is empty)
		if (data === "q" && this.searchInput.getValue() === "") {
			this.onDone();
			return;
		}

		// 'r' to refresh
		if (data === "r" && this.searchInput.getValue() === "") {
			void this.autoDiscover();
			return;
		}

		// Escape: if search has text, clear it; otherwise quit
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.searchInput.getValue() !== "") {
				this.searchInput.setValue("");
				this.applyFilter();
				return;
			}
			this.onDone();
			return;
		}

		// Navigation keys (when not typing search)
		if (kb.matches(data, "tui.select.up")) {
			this.cursorIndex = this.cursorIndex === 0 ? this.filteredEntries.length - 1 : this.cursorIndex - 1;
			this.rebuildChildren();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.cursorIndex = this.cursorIndex === this.filteredEntries.length - 1 ? 0 : this.cursorIndex + 1;
			this.rebuildChildren();
			return;
		}

		// Space: toggle checkbox
		if (data === " ") {
			const entry = this.filteredEntries[this.cursorIndex];
			if (entry) {
				if (this.checkedSet.has(entry.hostname)) {
					this.checkedSet.delete(entry.hostname);
				} else {
					this.checkedSet.add(entry.hostname);
				}
				this.rebuildChildren();
			}
			return;
		}

		// Enter: batch confirm or open host actions
		if (kb.matches(data, "tui.select.confirm")) {
			void this.handleEnter();
			return;
		}

		// All other input goes to search
		this.searchInput.handleInput(data);
		this.applyFilter();
	}

	private async handleEnter(): Promise<void> {
		if (this.checkedSet.size > 0) {
			await this.batchAddRemove();
			return;
		}
		// No items checked — open host actions
		const entry = this.filteredEntries[this.cursorIndex];
		if (entry) {
			this.currentView = "host-actions";
			this.selectedEntry = entry;
			this.rebuildChildren();
		}
	}

	private handleHostActionsInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.currentView = "main";
			this.selectedEntry = null;
			this.rebuildChildren();
			return;
		}
		const entry = this.selectedEntry;
		if (!entry) return;

		switch (data) {
			case "s":
				void this.hostAction("status");
				break;
			case "b":
				void this.hostAction("bootstrap");
				break;
			case "c":
				void this.hostAction("connect");
				break;
			case "d":
				void this.hostAction("disconnect");
				break;
			case "x":
				void this.hostAction("remove");
				break;
			case "a":
				void this.hostAction("add");
				break;
		}
	}

	// ─── Actions ──────────────────────────────────────────────────────

	private async batchAddRemove(): Promise<void> {
		const toAdd: FleetEntry[] = [];
		const toRemove: string[] = [];

		for (const hostname of this.checkedSet) {
			const entry = this.entries.find((e) => e.hostname === hostname);
			if (!entry) continue;
			if (entry.inFleet) {
				toRemove.push(hostname);
			} else {
				toAdd.push(entry);
			}
		}

		this.checkedSet.clear();

		if (toAdd.length === 0 && toRemove.length === 0) return;

		this.setLoading(`Adding ${toAdd.length}, removing ${toRemove.length}...`);

		for (const entry of toAdd) {
			const tags = entry.tags.length > 0 ? entry.tags : inferTags(entry.device ?? entryAsDevice(entry));
			const host: FleetHost = {
				hostname: entry.hostname,
				address: entry.address,
				tags,
				capabilities: ["bash", "ipython", "browser"],
				os: entry.os,
				addedAt: Date.now(),
				lastStatus: entry.sshable ? "disconnected" : "unreachable",
				piVersion: entry.piVersion,
			};
			await addFleetHost(host);
		}

		for (const hostname of toRemove) {
			await removeFleetHost(hostname);
		}

		this.clearLoading();
		const parts: string[] = [];
		if (toAdd.length > 0) parts.push(`added ${toAdd.length}`);
		if (toRemove.length > 0) parts.push(`removed ${toRemove.length}`);
		this.statusText = `✓ ${parts.join(", ")}`;
		await this.autoDiscover();
	}

	private async hostAction(action: string): Promise<void> {
		const entry = this.selectedEntry;
		if (!entry) return;

		switch (action) {
			case "status": {
				this.setLoading(`Probing ${entry.hostname}...`);
				const status = await checkHostStatus(entry.address);
				this.clearLoading();
				this.statusText = `${entry.hostname}: ${status.online ? "✓ online" : "✗ offline"} · pi ${status.piInstalled ? "✓" : "✗"} · daemon ${status.daemonRunning ? "✓" : "✗"}`;
				if (entry.inFleet && entry.fleetHost) {
					entry.fleetHost.piVersion = status.piVersion;
					entry.fleetHost.lastStatus = status.online
						? status.daemonRunning
							? "connected"
							: "disconnected"
						: "unreachable";
					await updateFleetHostStatus(entry.hostname, entry.fleetHost.lastStatus);
				}
				this.rebuildChildren();
				break;
			}
			case "bootstrap": {
				this.setLoading(`Bootstrapping ${entry.hostname}...`);
				const result = await bootstrapHost({
					target: entry.address,
					hostname: entry.hostname,
					tags: entry.tags,
					capabilities: ["bash", "ipython", "browser"],
				});
				this.clearLoading();
				if (result.success) {
					this.statusText = `✓ Bootstrap complete: ${entry.hostname}`;
					if (!entry.inFleet) {
						const host: FleetHost = {
							hostname: entry.hostname,
							address: entry.address,
							tags: entry.tags,
							capabilities: ["bash", "ipython", "browser"],
							os: entry.os,
							addedAt: Date.now(),
							lastStatus: "connected",
							piVersion: result.piVersion,
						};
						await addFleetHost(host);
					} else if (entry.fleetHost) {
						entry.fleetHost.piVersion = result.piVersion;
						await updateFleetHostStatus(entry.hostname, "connected");
					}
				} else {
					this.statusText = `✗ Bootstrap failed: ${result.error}`;
				}
				this.currentView = "main";
				this.selectedEntry = null;
				await this.autoDiscover();
				break;
			}
			case "connect": {
				if (entry.inFleet) {
					await updateFleetHostStatus(entry.hostname, "connected");
					this.statusText = `✓ ${entry.hostname} connected`;
				}
				this.currentView = "main";
				this.selectedEntry = null;
				this.rebuildChildren();
				break;
			}
			case "disconnect": {
				this.setLoading(`Disconnecting ${entry.hostname}...`);
				await disconnectHost(entry.address);
				this.clearLoading();
				if (entry.inFleet) await updateFleetHostStatus(entry.hostname, "disconnected");
				this.statusText = `✓ ${entry.hostname} disconnected`;
				this.currentView = "main";
				this.selectedEntry = null;
				this.rebuildChildren();
				break;
			}
			case "remove": {
				await removeFleetHost(entry.hostname);
				this.statusText = `✓ Removed ${entry.hostname}`;
				this.currentView = "main";
				this.selectedEntry = null;
				await this.autoDiscover();
				break;
			}
			case "add": {
				const tags = entry.tags.length > 0 ? entry.tags : inferTags(entry.device ?? entryAsDevice(entry));
				const host: FleetHost = {
					hostname: entry.hostname,
					address: entry.address,
					tags,
					capabilities: ["bash", "ipython", "browser"],
					os: entry.os,
					addedAt: Date.now(),
					lastStatus: entry.sshable ? "disconnected" : "unreachable",
					piVersion: entry.piVersion,
				};
				await addFleetHost(host);
				this.statusText = `✓ Added ${entry.hostname}`;
				this.currentView = "main";
				this.selectedEntry = null;
				await this.autoDiscover();
				break;
			}
		}
	}

	// ─── Helpers ──────────────────────────────────────────────────────

	private setLoading(text: string): void {
		this.isLoading = true;
		this.statusText = text;
		this.rebuildChildren();
	}

	private clearLoading(): void {
		this.isLoading = false;
	}
}

// ─── Merge & format ────────────────────────────────────────────────

function mergeHostsAndDevices(fleetHosts: FleetHost[], devices: DiscoveredDevice[]): FleetEntry[] {
	const entries: FleetEntry[] = [];
	const seen = new Set<string>();

	for (const host of fleetHosts) {
		const key = host.hostname.toLowerCase();
		seen.add(key);
		entries.push({
			hostname: host.hostname,
			address: host.address,
			os: host.os,
			tags: host.tags,
			source: "fleet",
			online: host.lastStatus !== "unreachable",
			sshable: false,
			hasPi: Boolean(host.piVersion),
			piVersion: host.piVersion,
			inFleet: true,
			fleetHost: host,
		});
	}

	for (const device of devices) {
		const key = device.hostname.toLowerCase();
		if (seen.has(key)) {
			const existing = entries.find((e) => e.hostname.toLowerCase() === key);
			if (existing && existing.source === "fleet") {
				existing.online = device.online ?? existing.online;
				existing.sshable = device.sshable ?? existing.sshable;
				existing.hasPi = device.hasPi ?? existing.hasPi;
				existing.piVersion = device.piVersion ?? existing.piVersion;
				existing.os = device.os ?? existing.os;
				existing.device = device;
			}
			continue;
		}
		seen.add(key);
		entries.push({
			hostname: device.hostname,
			address: device.tailscaleIp ?? device.address,
			os: device.os,
			tags: inferTags(device),
			source: "discovered",
			online: device.online ?? false,
			sshable: device.sshable ?? false,
			hasPi: device.hasPi ?? false,
			piVersion: device.piVersion,
			inFleet: false,
			device,
		});
	}

	return entries;
}

function entryAsDevice(entry: FleetEntry): DiscoveredDevice {
	return {
		hostname: entry.hostname,
		source: "arp",
		address: entry.address,
		os: entry.os,
		online: entry.online,
		sshable: entry.sshable,
		hasPi: entry.hasPi,
		piVersion: entry.piVersion,
		tags: entry.tags,
	};
}
