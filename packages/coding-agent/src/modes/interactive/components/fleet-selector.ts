/**
 * Interactive TUI component for managing the fleet.
 *
 * Uses the same MenuPanel infrastructure as the model picker —
 * surface backgrounds, selection highlighting, scroll indicators,
 * responsive layout.
 */

import { Container, type Focusable, fuzzyFilter, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { type DiscoveredDevice, discoverStream, inferTags } from "../../../cli/fleet/discovery.js";
import { type FleetHost, listFleetHosts } from "../../../cli/fleet/fleet-config.js";
import {
	addHostToFleet,
	batchAddRemove,
	bootstrapFleetHost,
	checkFleetHostStatus,
	connectFleetHost,
	disconnectFleetHost,
	removeHostFromFleet,
	renameHostInFleet,
	sshIntoFleetHost,
	tagHostInFleet,
} from "../../../cli/fleet/fleet-operations.js";
import { theme } from "../theme/theme.js";
import { getMenuListLayout, MenuList, MenuPanel, MenuRow, MenuSearchInput } from "./menu-panel.js";
import { shouldTreatAsBack } from "./modal-back.js";

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

const PREFERRED_VISIBLE = 10;
const RESERVED_ROWS = 7;

/**
 * Fleet selector — same visual language as ModelSelectorComponent.
 */
export class FleetSelectorComponent extends Container implements Focusable {
	focused = false;
	private searchInput: MenuSearchInput;
	private currentView: FleetView = "main";
	private entries: FleetEntry[] = [];
	private filteredEntries: FleetEntry[] = [];
	private selectedEntry: FleetEntry | null = null;
	private selectedIndex = 0;
	private checkedSet = new Set<string>();
	private statusText = "";
	private isLoading = false;
	private _renaming = false;
	private _renameTarget = "";
	private _tagging = false;
	private _tagTarget = "";
	private readonly onDone: () => void;
	private readonly requestRender: () => void;

	private panel: MenuPanel;
	private listContainer: MenuList;
	private headerContainer: Container;
	private listLayout = getMenuListLayout({
		preferredVisibleItems: PREFERRED_VISIBLE,
		reservedRows: RESERVED_ROWS,
		comfortableItemRows: 3,
		compactItemRows: 2,
	});
	private responsiveLayoutKey = "";

	constructor(onDone: () => void, _onCancel: () => void, requestRender: () => void) {
		super();
		this.onDone = onDone;
		this.requestRender = requestRender;

		this.isLoading = true;
		this.statusText = "Discovering networked devices...";

		this.panel = new MenuPanel({
			title: "Fleet",
			subtitle: "Networked devices across all reachable networks.",
		});
		this.addChild(this.panel);

		this.headerContainer = new Container();
		this.panel.addChild(this.headerContainer);

		this.searchInput = new MenuSearchInput("Search devices");
		this.searchInput.onSubmit = () => {
			this.handleConfirm();
		};
		this.panel.addChild(this.searchInput);
		this.panel.addChild(new Spacer(1));

		this.listContainer = new MenuList({ compact: () => this.listLayout.compact });
		this.panel.addChild(this.listContainer);

		this.updateHeader();
		this.updateList();
		void this.autoDiscover();
	}

	getSearchInput(): MenuSearchInput {
		return this.searchInput;
	}

	// ─── Auto-discover — single streaming pipeline ───────────────────

	private async autoDiscover(): Promise<void> {
		this.setLoading("Discovering networked devices...");

		const fleetHosts = await listFleetHosts();
		this.clearLoading();
		this.entries = mergeHostsAndDevices(fleetHosts, []);
		this.applyFilter();

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

		this.statusText = `${this.entries.length} devices found`;
		if (this.currentView === "main") {
			this.updateHeader();
			this.updateList();
			this.requestRender();
		}
	}

	private mergeDevice(device: DiscoveredDevice): void {
		const existing = this.entries.find(
			(e) => e.hostname.toLowerCase() === device.hostname.toLowerCase() || e.address === device.address,
		);

		if (existing) {
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
		if (this.selectedIndex >= this.filteredEntries.length) {
			this.selectedIndex = Math.max(0, this.filteredEntries.length - 1);
		}
		this.updateHeader();
		this.updateList();
		this.requestRender();
	}

	// ─── Rendering ────────────────────────────────────────────────────

	private updateHeader(): void {
		this.headerContainer.clear();
		if (this.statusText) {
			this.headerContainer.addChild(new Text(theme.fg("muted", this.statusText), 0, 0));
			this.headerContainer.addChild(new Spacer(1));
		}
	}

	override render(width: number): string[] {
		const prevKey = this.responsiveLayoutKey;
		this.updateResponsiveLayout();
		if (this.responsiveLayoutKey !== prevKey) {
			this.updateList();
		}
		return super.render(width);
	}

	private updateResponsiveLayout(): void {
		this.listLayout = getMenuListLayout({
			preferredVisibleItems: PREFERRED_VISIBLE,
			reservedRows: RESERVED_ROWS,
			comfortableItemRows: 3,
			compactItemRows: 2,
			totalItems: this.filteredEntries.length,
		});
		this.responsiveLayoutKey = `${this.listLayout.compact}:${this.listLayout.visibleItems}`;
	}

	private updateList(): void {
		this.updateResponsiveLayout();
		this.listContainer.clear();

		if (this.currentView === "host-actions") {
			this.renderHostActions();
			return;
		}

		if (this.isLoading) {
			this.listContainer.addChild(new Text(theme.fg("muted", this.statusText), 0, 0));
			return;
		}

		if (this.filteredEntries.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "No devices found"), 0, 0));
			return;
		}

		const maxVisible = this.listLayout.visibleItems;
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredEntries.length - maxVisible),
		);
		const end = Math.min(start + maxVisible, this.filteredEntries.length);

		for (let i = start; i < end; i++) {
			const entry = this.filteredEntries[i];
			if (!entry) continue;
			const isSelected = i === this.selectedIndex;
			this.listContainer.addChild(this.makeDeviceRow(entry, isSelected));
		}

		// Scroll indicator
		if (start > 0 || end < this.filteredEntries.length) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredEntries.length})`), 0, 0),
			);
		}
	}

	private makeDeviceRow(entry: FleetEntry, selected: boolean): MenuRow {
		const displayName = entry.fleetHost?.displayName ?? entry.hostname;
		const isChecked = this.checkedSet.has(entry.hostname);
		const check = isChecked ? "✓ " : "";
		const primary = `${check}${displayName}`;

		// Secondary line: address + os
		const osLabel = entry.os ? this.formatOs(entry.os) : "?";
		const secondary = `${entry.address} · ${osLabel}`;

		// Meta: status badges
		const meta = this.formatMeta(entry);

		return new MenuRow({ primary, secondary, meta, selected });
	}

	private formatOs(os: string): string {
		const l = os.toLowerCase();
		if (l.includes("mac") || l.includes("darwin")) return "macOS";
		if (l.includes("linux")) return "Linux";
		if (l.includes("android")) return "Android";
		if (l.includes("windows")) return "Windows";
		return os;
	}

	private formatMeta(entry: FleetEntry): string {
		const parts: string[] = [];
		if (entry.inFleet) parts.push("fleet");
		else if (entry.online) parts.push("online");
		else parts.push("offline");
		if (entry.sshable) parts.push("ssh");
		if (entry.hasPi) parts.push("pi");
		return parts.join(" · ");
	}

	private renderHostActions(): void {
		const entry = this.selectedEntry;
		if (!entry) return;

		const displayName = entry.fleetHost?.displayName ?? entry.hostname;
		const actions: { key: string; label: string; desc: string }[] = [
			{ key: "s", label: "Check status", desc: "Probe SSH, pi, daemon" },
			{
				key: "b",
				label: "Bootstrap",
				desc: entry.piVersion ? `Pi ${entry.piVersion} installed` : "Install pi + start daemon",
			},
			{ key: "c", label: "Connect", desc: "Mark as connected" },
			{ key: "d", label: "Disconnect", desc: "Stop daemon on host" },
			{ key: "e", label: "SSH", desc: "Open SSH session" },
		];
		if (entry.inFleet) {
			actions.push({ key: "n", label: "Rename", desc: "Set custom display name" });
			actions.push({ key: "t", label: "Add tag", desc: "Tag this host" });
			actions.push({ key: "x", label: "Remove from fleet", desc: "Unregister this host" });
		} else {
			actions.push({ key: "a", label: "Add to fleet", desc: `Tags: ${entry.tags.join(", ")}` });
		}

		// Header row for the device
		this.listContainer.addChild(
			new MenuRow({
				primary: displayName,
				secondary: `${entry.address} · ${entry.os ?? "?"}`,
				meta: this.formatMeta(entry),
				selected: false,
			}),
		);
		this.listContainer.addChild(new Spacer(1));

		for (const action of actions) {
			this.listContainer.addChild(
				new MenuRow({
					primary: `${action.key}  ${action.label}`,
					secondary: action.desc,
					selected: false,
				}),
			);
		}

		this.listContainer.addChild(new Spacer(1));
		this.listContainer.addChild(new Text(theme.fg("muted", "  Press key to execute · esc to go back"), 0, 0));
	}

	// ─── Keyboard ─────────────────────────────────────────────────────

	handleInput(data: string): void {
		const kb = getKeybindings();

		// Rename/tag input mode — capture text, Enter confirms, Esc cancels
		if (this._renaming || this._tagging) {
			if (kb.matches(data, "tui.select.confirm")) {
				const value = this.searchInput.getValue().trim();
				if (this._renaming && value) {
					void this.confirmRename(value);
				} else if (this._tagging && value) {
					void this.confirmTag(value);
				}
				return;
			}
			if (kb.matches(data, "tui.select.cancel")) {
				this._renaming = false;
				this._tagging = false;
				this.searchInput.setValue("");
				this.statusText = "";
				this.updateHeader();
				this.updateList();
				return;
			}
			this.searchInput.handleInput(data);
			this.requestRender();
			return;
		}

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
		if (kb.matches(data, "tui.select.cancel") || shouldTreatAsBack(data, this.searchInput)) {
			if (this.searchInput.getValue() !== "") {
				this.searchInput.setValue("");
				this.applyFilter();
				return;
			}
			this.onDone();
			return;
		}

		// Navigation
		if (kb.matches(data, "tui.select.up")) {
			const count = this.filteredEntries.length;
			if (count === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
			this.updateList();
			this.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			const count = this.filteredEntries.length;
			if (count === 0) return;
			this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			this.requestRender();
			return;
		}

		// Space: toggle checkbox
		if (data === " ") {
			const entry = this.filteredEntries[this.selectedIndex];
			if (entry) {
				if (this.checkedSet.has(entry.hostname)) {
					this.checkedSet.delete(entry.hostname);
				} else {
					this.checkedSet.add(entry.hostname);
				}
				this.updateList();
				this.requestRender();
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
		const entry = this.filteredEntries[this.selectedIndex];
		if (entry) {
			this.currentView = "host-actions";
			this.selectedEntry = entry;
			this.updateList();
			this.requestRender();
		}
	}

	private handleConfirm(): void {
		void this.handleEnter();
	}

	private handleHostActionsInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.currentView = "main";
			this.selectedEntry = null;
			this.updateList();
			this.requestRender();
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
			case "n":
				void this.hostAction("rename");
				break;
			case "t":
				void this.hostAction("tag");
				break;
			case "e":
				void this.hostAction("ssh");
				break;
		}
	}

	private async confirmRename(newName: string): Promise<void> {
		const hostname = this._renameTarget;
		this._renaming = false;
		this.searchInput.setValue("");
		const result = await renameHostInFleet(hostname, newName);
		this.statusText = result.success ? `✓ ${result.message}` : `✗ ${result.message}`;
		this.currentView = "main";
		this.selectedEntry = null;
		await this.autoDiscover();
	}

	private async confirmTag(tag: string): Promise<void> {
		const hostname = this._tagTarget;
		this._tagging = false;
		this.searchInput.setValue("");
		const result = await tagHostInFleet(hostname, tag);
		this.statusText = result.success ? `✓ ${result.message}` : `✗ ${result.message}`;
		this.currentView = "main";
		this.selectedEntry = null;
		await this.autoDiscover();
	}

	// ─── Actions ──────────────────────────────────────────────────────

	private async batchAddRemove(): Promise<void> {
		const toAdd: {
			hostname: string;
			address: string;
			tags?: string[];
			device?: DiscoveredDevice;
			sshable?: boolean;
			piVersion?: string;
			os?: string;
		}[] = [];
		const toRemove: string[] = [];

		for (const hostname of this.checkedSet) {
			const entry = this.entries.find((e) => e.hostname === hostname);
			if (!entry) continue;
			if (entry.inFleet) {
				toRemove.push(hostname);
			} else {
				toAdd.push({
					hostname: entry.hostname,
					address: entry.address,
					tags: entry.tags.length > 0 ? entry.tags : undefined,
					device: entry.device,
					sshable: entry.sshable,
					piVersion: entry.piVersion,
					os: entry.os,
				});
			}
		}

		this.checkedSet.clear();
		if (toAdd.length === 0 && toRemove.length === 0) return;

		this.setLoading(`Adding ${toAdd.length}, removing ${toRemove.length}...`);
		const result = await batchAddRemove(toAdd, toRemove);
		this.clearLoading();

		const parts: string[] = [];
		if (result.added.length > 0) parts.push(`added ${result.added.length}`);
		if (result.removed.length > 0) parts.push(`removed ${result.removed.length}`);
		this.statusText = `✓ ${parts.join(", ")}`;
		await this.autoDiscover();
	}

	private async hostAction(action: string): Promise<void> {
		const entry = this.selectedEntry;
		if (!entry) return;

		switch (action) {
			case "status": {
				this.setLoading(`Probing ${entry.hostname}...`);
				const result = await checkFleetHostStatus(entry.hostname);
				this.clearLoading();
				this.statusText = result.success ? result.message : `✗ ${result.message}`;
				if (entry.fleetHost && result.piVersion) entry.fleetHost.piVersion = result.piVersion;
				this.updateHeader();
				this.updateList();
				this.requestRender();
				break;
			}
			case "bootstrap": {
				this.setLoading(`Bootstrapping ${entry.hostname}...`);
				const result = await bootstrapFleetHost(entry.hostname, entry.address, entry.tags);
				this.clearLoading();
				this.statusText = result.success ? `✓ ${result.message}` : `✗ ${result.message}`;
				this.currentView = "main";
				this.selectedEntry = null;
				await this.autoDiscover();
				break;
			}
			case "connect": {
				if (entry.inFleet) {
					const result = await connectFleetHost(entry.hostname);
					this.statusText = result.success ? `✓ ${result.message}` : `✗ ${result.message}`;
				}
				this.currentView = "main";
				this.selectedEntry = null;
				this.updateList();
				this.requestRender();
				break;
			}
			case "disconnect": {
				this.setLoading(`Disconnecting ${entry.hostname}...`);
				const result = await disconnectFleetHost(entry.hostname);
				this.clearLoading();
				this.statusText = result.success ? `✓ ${result.message}` : `✗ ${result.message}`;
				this.currentView = "main";
				this.selectedEntry = null;
				this.updateList();
				this.requestRender();
				break;
			}
			case "remove": {
				const result = await removeHostFromFleet(entry.hostname);
				this.statusText = result.success ? `✓ ${result.message}` : `✗ ${result.message}`;
				this.currentView = "main";
				this.selectedEntry = null;
				await this.autoDiscover();
				break;
			}
			case "add": {
				const result = await addHostToFleet(entry.hostname, entry.address, entry.tags, entry.device);
				this.statusText = result.success ? `✓ ${result.message}` : `✗ ${result.message}`;
				this.currentView = "main";
				this.selectedEntry = null;
				await this.autoDiscover();
				break;
			}
			case "rename": {
				if (!entry.inFleet) {
					this.statusText = `Add ${entry.hostname} to fleet first to rename`;
					this.updateHeader();
					this.updateList();
					this.requestRender();
					break;
				}
				this.searchInput.setValue("");
				this.statusText = `Enter new name for ${entry.hostname} (Enter to confirm, Esc to cancel):`;
				this.updateHeader();
				this.updateList();
				this._renameTarget = entry.hostname;
				this._renaming = true;
				break;
			}
			case "tag": {
				if (!entry.inFleet) {
					this.statusText = `Add ${entry.hostname} to fleet first to tag`;
					this.updateHeader();
					this.updateList();
					this.requestRender();
					break;
				}
				this.searchInput.setValue("");
				this.statusText = `Enter tag for ${entry.hostname} (Enter to add, Esc to cancel):`;
				this.updateHeader();
				this.updateList();
				this._tagTarget = entry.hostname;
				this._tagging = true;
				break;
			}
			case "ssh": {
				this.statusText = `SSH to ${entry.address}...`;
				this.updateHeader();
				this.updateList();
				this.requestRender();
				await sshIntoFleetHost(entry.hostname);
				this.statusText = `SSH session ended`;
				this.updateHeader();
				this.updateList();
				this.requestRender();
				break;
			}
		}
	}

	// ─── Helpers ──────────────────────────────────────────────────────

	private setLoading(text: string): void {
		this.isLoading = true;
		this.statusText = text;
		this.updateHeader();
		this.updateList();
		this.requestRender();
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
