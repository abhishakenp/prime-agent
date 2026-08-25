/**
 * Interactive TUI component for managing the fleet.
 *
 * On open: auto-discovers networked devices and merges with registered hosts.
 * Shows a multi-select list where you can:
 * - Space: toggle selection (check/uncheck devices to add to fleet)
 * - Enter: confirm batch action (add all checked devices, remove checked hosts)
 * - r: refresh statuses
 * - q/esc: quit
 *
 * Checked devices that aren't in fleet yet → add on Enter.
 * Checked hosts that are in fleet → remove on Enter.
 */

import {
	Container,
	type Focusable,
	type MultiSelectItem,
	type MultiSelectLayoutOptions,
	MultiSelectList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { bootstrapHost, checkHostStatus, disconnectHost } from "../../../cli/fleet/bootstrap.js";
import { type DiscoveredDevice, discoverDevices, inferTags } from "../../../cli/fleet/discovery.js";
import {
	addFleetHost,
	type FleetHost,
	listFleetHosts,
	removeFleetHost,
	updateFleetHostStatus,
} from "../../../cli/fleet/fleet-config.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

type FleetView = "main" | "host-actions" | "batch-confirm";

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
	/** Original fleet host if in fleet. */
	fleetHost?: FleetHost;
	/** Original discovered device. */
	device?: DiscoveredDevice;
}

const FLEET_MS_LAYOUT: MultiSelectLayoutOptions = {
	minPrimaryColumnWidth: 16,
	maxPrimaryColumnWidth: 32,
};

export class FleetSelectorComponent extends Container implements Focusable {
	focused = false;
	private multiSelect: MultiSelectList;
	private currentView: FleetView = "main";
	private entries: FleetEntry[] = [];
	private selectedEntry: FleetEntry | null = null;
	private statusText = "";
	private isLoading = false;
	private readonly onDone: () => void;
	private readonly requestRender: () => void;

	constructor(onDone: () => void, _onCancel: () => void, requestRender: () => void) {
		super();
		this.onDone = onDone;
		this.requestRender = requestRender;
		this.multiSelect = new MultiSelectList([], 20, getFleetMsTheme(), FLEET_MS_LAYOUT);
		this.multiSelect.onConfirm = (items) => {
			void this.handleBatchConfirm(items);
		};
		this.multiSelect.onCancel = () => this.handleCancel();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "Fleet Manager")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.multiSelect);
		this.addChild(new Spacer(1));
		this.addChild(new Text("", 1, 0));
		this.addChild(new DynamicBorder());
		void this.autoDiscover();
	}

	getMultiSelect(): MultiSelectList {
		return this.multiSelect;
	}

	// ─── Auto-discover on open ────────────────────────────────────────

	private async autoDiscover(): Promise<void> {
		this.setLoading("Discovering networked devices...");
		const [fleetHosts, devices] = await Promise.all([
			listFleetHosts(),
			discoverDevices({}).catch(() => [] as DiscoveredDevice[]),
		]);
		this.clearLoading();
		this.entries = mergeHostsAndDevices(fleetHosts, devices);
		this.showMainView();
	}

	// ─── Views ────────────────────────────────────────────────────────

	private showMainView(): void {
		this.currentView = "main";
		const fleetNames = new Set(this.entries.filter((e) => e.inFleet).map((e) => e.hostname.toLowerCase()));
		const items: MultiSelectItem[] = this.entries.map((entry) => ({
			value: entry.hostname,
			label: entry.hostname,
			description: formatEntryDescription(entry),
			checked: false,
			disabled: false,
		}));

		const onlineCount = this.entries.filter((e) => e.online).length;
		const fleetCount = fleetNames.size;
		this.statusText = `${this.entries.length} devices (${onlineCount} online, ${fleetCount} in fleet) · Space to select · Enter to add/remove · r to refresh · q to quit`;
		this.rebuildChildren(items);
	}

	private showHostActionsView(entry: FleetEntry): void {
		this.currentView = "host-actions";
		this.selectedEntry = entry;
		// Use multiSelect as a simple action list (single-select via Enter)
		const items: MultiSelectItem[] = [
			{ value: "status", label: "Check status", description: "Probe SSH, pi, daemon", disabled: true },
			{
				value: "bootstrap",
				label: "Bootstrap (install pi + start daemon)",
				description: entry.piVersion ? `Pi ${entry.piVersion} installed` : "Install pi via npm",
				disabled: true,
			},
			{ value: "connect", label: "Connect to gateway", description: "Mark as connected", disabled: true },
			{ value: "disconnect", label: "Disconnect", description: "Stop daemon on host", disabled: true },
			{
				value: "remove",
				label: `Remove "${entry.hostname}" from fleet`,
				description: "Unregister",
				disabled: !entry.inFleet,
			},
			{
				value: "add",
				label: `Add "${entry.hostname}" to fleet`,
				description: `Tags: ${entry.tags.join(", ")}`,
				disabled: entry.inFleet,
			},
			{ value: "__back__", label: "← Back", description: "", disabled: true },
		];
		this.statusText = `${entry.hostname} · Enter to execute · esc to go back`;
		this.rebuildChildren(items);
	}

	// ─── Event handling ───────────────────────────────────────────────

	private async handleBatchConfirm(checkedItems: MultiSelectItem[]): Promise<void> {
		if (this.currentView !== "main") {
			// In host-actions view, Enter executes the selected action
			const selected = this.multiSelect["items" as unknown as keyof MultiSelectList] as unknown as MultiSelectItem[];
			const current =
				selected[this.multiSelect["selectedIndex" as unknown as keyof MultiSelectList] as unknown as number];
			if (current) {
				await this.handleHostAction(current.value);
			}
			return;
		}

		if (checkedItems.length === 0) {
			// No items checked — open host actions for the highlighted item
			const currentItem = this.entries[this.getCurrentIndex()];
			if (currentItem) {
				this.showHostActionsView(currentItem);
			}
			return;
		}

		// Batch: add checked non-fleet devices, remove checked fleet hosts
		const toAdd = checkedItems.filter((item) => {
			const entry = this.entries.find((e) => e.hostname === item.value);
			return entry && !entry.inFleet;
		});
		const toRemove = checkedItems.filter((item) => {
			const entry = this.entries.find((e) => e.hostname === item.value);
			return entry && entry.inFleet;
		});

		this.setLoading(`Processing ${toAdd.length} add(s), ${toRemove.length} remove(s)...`);

		for (const item of toAdd) {
			const entry = this.entries.find((e) => e.hostname === item.value);
			if (!entry) continue;
			const host: FleetHost = {
				hostname: entry.hostname,
				address: entry.address,
				tags: entry.tags.length > 0 ? entry.tags : inferTags(entry.device ?? entryAsDevice(entry)),
				capabilities: ["bash", "ipython", "browser"],
				os: entry.os,
				addedAt: Date.now(),
				lastStatus: entry.sshable ? "disconnected" : "unreachable",
				piVersion: entry.piVersion,
			};
			await addFleetHost(host);
		}

		for (const item of toRemove) {
			await removeFleetHost(item.value);
		}

		this.clearLoading();
		const actions: string[] = [];
		if (toAdd.length > 0) actions.push(`added ${toAdd.length}`);
		if (toRemove.length > 0) actions.push(`removed ${toRemove.length}`);
		this.statusText = `✓ ${actions.join(", ")}`;
		// Refresh
		await this.autoDiscover();
	}

	private async handleHostAction(action: string): Promise<void> {
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
				this.showHostActionsView(entry);
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
				await this.autoDiscover();
				break;
			}
			case "connect": {
				if (entry.inFleet) {
					await updateFleetHostStatus(entry.hostname, "connected");
					this.statusText = `✓ ${entry.hostname} connected`;
				}
				this.showHostActionsView(entry);
				break;
			}
			case "disconnect": {
				this.setLoading(`Disconnecting ${entry.hostname}...`);
				await disconnectHost(entry.address);
				this.clearLoading();
				if (entry.inFleet) {
					await updateFleetHostStatus(entry.hostname, "disconnected");
				}
				this.statusText = `✓ ${entry.hostname} disconnected`;
				this.showHostActionsView(entry);
				break;
			}
			case "remove": {
				await removeFleetHost(entry.hostname);
				this.statusText = `✓ Removed ${entry.hostname}`;
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
				this.selectedEntry = null;
				await this.autoDiscover();
				break;
			}
			case "__back__":
				this.selectedEntry = null;
				this.showMainView();
				break;
		}
	}

	private handleCancel(): void {
		if (this.currentView === "main") {
			this.onDone();
		} else {
			this.selectedEntry = null;
			this.showMainView();
		}
	}

	// ─── Keyboard ─────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (this.currentView === "main" && data === "r") {
			void this.autoDiscover();
			return;
		}
		if (this.currentView === "main" && data === "q") {
			this.onDone();
			return;
		}
		this.multiSelect.handleInput(data);
	}

	// ─── Helpers ──────────────────────────────────────────────────────

	private getCurrentIndex(): number {
		return (this.multiSelect as unknown as { selectedIndex: number }).selectedIndex;
	}

	private rebuildChildren(items: MultiSelectItem[]): void {
		this.multiSelect.setItems(items);
		this.children = [];
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "Fleet Manager")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.multiSelect);
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.isLoading ? theme.fg("dim", this.statusText) : this.statusText, 1, 0));
		this.addChild(new DynamicBorder());
		this.requestRender();
	}

	private setLoading(text: string): void {
		this.isLoading = true;
		this.statusText = text;
		this.requestRender();
	}

	private clearLoading(): void {
		this.isLoading = false;
	}
}

// ─── Theme ─────────────────────────────────────────────────────────

function getFleetMsTheme() {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.bold(text),
		description: (text: string) => theme.fg("dim", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("dim", text),
		checkbox: (checked: boolean, selected: boolean) => {
			const box = checked ? "[✓]" : "[ ]";
			if (selected) return theme.fg("accent", box);
			return theme.fg("dim", box);
		},
		hint: (text: string) => theme.fg("dim", text),
	};
}

// ─── Merge & format ────────────────────────────────────────────────

function mergeHostsAndDevices(fleetHosts: FleetHost[], devices: DiscoveredDevice[]): FleetEntry[] {
	const entries: FleetEntry[] = [];
	const seen = new Set<string>();

	// Add fleet hosts first
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

	// Add discovered devices not already in fleet
	for (const device of devices) {
		const key = device.hostname.toLowerCase();
		if (seen.has(key)) {
			// Enrich existing fleet entry with discovery info
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

	// Sort: fleet hosts first, then online discovered, then offline
	return entries.sort((a, b) => {
		if (a.inFleet !== b.inFleet) return a.inFleet ? -1 : 1;
		if (a.online !== b.online) return a.online ? -1 : 1;
		return a.hostname.localeCompare(b.hostname);
	});
}

function formatEntryDescription(entry: FleetEntry): string {
	const parts: string[] = [];
	if (entry.os) parts.push(entry.os);
	if (entry.tags.length > 0) parts.push(entry.tags.join(","));
	if (entry.sshable) parts.push("ssh ✓");
	if (entry.hasPi) parts.push("pi ✓");
	if (entry.inFleet) parts.push("● fleet");
	else if (!entry.online) parts.push("✗ offline");
	return parts.join(" · ");
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
