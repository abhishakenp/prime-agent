/**
 * Interactive fleet selector — grouped device list with search.
 *
 * Visual design: grouped headers (FLEET/ONLINE/OFFLINE),
 * OS badges, status badges, › cursor.
 *
 * Used in two contexts:
 * 1. `prime-agent fleet` — standalone TUI (ProcessTerminal)
 * 2. `/fleet` slash command — modal overlay in interactive chat
 *
 * All business logic delegates to fleet-operations.ts.
 */

import { createRequire } from "node:module";
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
import { type DiscoveredDevice, discoverStream, inferTags } from "../../../cli/fleet/discovery.js";
import { type FleetHost, listFleetHosts } from "../../../cli/fleet/fleet-config.js";
import {
	addHostToFleet,
	bootstrapFleetHost,
	checkFleetHostStatus,
	connectFleetHost,
	disconnectFleetHost,
	removeHostFromFleet,
	renameHostInFleet,
	sshIntoFleetHost,
	tagHostInFleet,
} from "../../../cli/fleet/fleet-operations.js";
import {
	installRuntimePlugin,
	listRuntimePlugins,
	pluginHasSetup,
	type RuntimePluginInfo,
	runPluginSetupWithPath,
	savePluginConfig,
	toggleRuntimePlugin,
	uninstallRuntimePlugin,
} from "../../../cli/fleet/runtime-operations.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { shouldTreatAsBack } from "./modal-back.js";

type FleetView = "main" | "host-actions" | "runtimes" | "runtime-actions";

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

export interface FleetSelectorOptions {
	/** Called when the selector is dismissed. */
	onDone: () => void;
	/** Called on cancel (Esc). Defaults to onDone. */
	onCancel?: () => void;
	/** Request a re-render of the parent TUI. */
	requestRender: () => void;
}

export class FleetSelectorComponent extends Container implements Focusable {
	focused = false;
	private searchInput: Input;
	private currentView: FleetView = "main";
	private entries: FleetEntry[] = [];
	private filteredEntries: FleetEntry[] = [];
	private selectedEntry: FleetEntry | null = null;
	private cursorIndex = 0;
	private statusText = "";
	private isLoading = false;
	private _renaming = false;
	private _renameTarget = "";
	private _tagging = false;
	private _tagTarget = "";
	private _runtimePlugins: RuntimePluginInfo[] = [];
	private _runtimeCursor = 0;
	private _selectedRuntime: RuntimePluginInfo | null = null;
	private readonly onDone: () => void;
	private readonly onCancel: () => void;
	private readonly requestRender: () => void;

	constructor(options: FleetSelectorOptions);
	/** @deprecated Legacy positional args — use FleetSelectorOptions. */
	constructor(onDone: () => void, onCancel?: () => void, requestRender?: () => void);
	constructor(...args: [FleetSelectorOptions] | [(() => void)?, (() => void)?, (() => void)?]) {
		super();
		if (typeof args[0] === "function") {
			this.onDone = args[0] ?? (() => {});
			this.onCancel = args[1] ?? this.onDone;
			this.requestRender = args[2] ?? (() => {});
		} else {
			const opts = args[0]!;
			this.onDone = opts.onDone;
			this.onCancel = opts.onCancel ?? opts.onDone;
			this.requestRender = opts.requestRender;
		}

		this.searchInput = new Input();
		this.isLoading = true;
		this.statusText = "Discovering networked devices...";

		this.rebuildChildren();
		void this.autoDiscover();
	}

	getSearchInput(): Input {
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
		if (this._renaming || this._tagging) {
			this.addChild(new Text(theme.fg("accent", `  ${this.statusText}`), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "  Type and press Enter · Esc to cancel"), 1, 0));
		} else if (this.isLoading && this.currentView !== "runtimes" && this.currentView !== "runtime-actions") {
			this.addChild(new Text(theme.fg("dim", `  ${this.statusText}`), 1, 0));
		} else if (this.currentView === "runtimes") {
			this.renderRuntimesList();
		} else if (this.currentView === "runtime-actions") {
			this.renderRuntimeActions();
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

		const displayName = entry.fleetHost?.displayName ?? entry.hostname;
		const hostnameColor = entry.inFleet ? "accent" : entry.online ? "text" : "dim";
		const hostname = theme.fg(hostnameColor, truncateToWidth(displayName, 22, ""));
		const osBadge = entry.os ? this.formatOsBadge(entry.os) : "";
		const badges = this.formatBadges(entry);
		const prefix = isSelected ? theme.fg("accent", "›") : " ";

		const padding = " ".repeat(Math.max(1, 27 - visibleWidth(displayName)));
		const row = `${prefix} ${hostname}${padding}${osBadge} ${badges}`;
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

		const displayName = entry.fleetHost?.displayName ?? entry.hostname;
		this.addChild(new Text(theme.fg("accent", ` ${displayName}`), 1, 0));
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
			{ key: "e", label: "SSH", desc: "Open SSH session" },
		];
		if (entry.inFleet) {
			actions.push({ key: "n", label: "Rename", desc: "Set custom display name" });
			actions.push({ key: "t", label: "Add tag", desc: "Tag this host" });
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

	// ─── Runtimes view ──────────────────────────────────────────────

	private renderRuntimesList(): void {
		if (this._runtimePlugins.length === 0) {
			this.addChild(new Text(theme.fg("dim", "  No runtime plugins found"), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(
				new Text(
					theme.fg("dim", "  Built-in: SSH only. Install templates with 'fleet runtimes install <name>'"),
					1,
					0,
				),
			);
			return;
		}

		const builtin = this._runtimePlugins.filter((p) => p.source === "builtin");
		const user = this._runtimePlugins.filter((p) => p.source === "user");
		const templates = this._runtimePlugins.filter((p) => p.source === "template");

		let virtualIndex = 0;

		if (builtin.length > 0) {
			this.addChild(new Text(theme.fg("accent", theme.bold(` BUILT-IN (${builtin.length})`)), 1, 0));
			for (const plugin of builtin) {
				this.addRuntimeRow(plugin, virtualIndex);
				virtualIndex++;
			}
			this.addChild(new Spacer(1));
		}

		if (user.length > 0) {
			this.addChild(new Text(theme.fg("success", theme.bold(` USER INSTALLED (${user.length})`)), 1, 0));
			for (const plugin of user) {
				this.addRuntimeRow(plugin, virtualIndex);
				virtualIndex++;
			}
		}

		if (templates.length > 0) {
			if (user.length > 0 || builtin.length > 0) this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", theme.bold(` AVAILABLE TEMPLATES (${templates.length})`)), 1, 0));
			for (const plugin of templates) {
				this.addRuntimeRow(plugin, virtualIndex);
				virtualIndex++;
			}
		}

		if (this.statusText) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("accent", `  ${this.statusText}`), 1, 0));
		}
	}

	private addRuntimeRow(plugin: RuntimePluginInfo, virtualIndex: number): void {
		const isSelected = virtualIndex === this._runtimeCursor;
		const prefix = isSelected ? theme.fg("accent", "›") : " ";

		let statusIcon: string;
		let statusColor: "dim" | "success" | "warning";
		if (plugin.source === "template") {
			statusIcon = "○";
			statusColor = "dim";
		} else if (plugin.active) {
			statusIcon = "●";
			statusColor = "success";
		} else {
			statusIcon = "○";
			statusColor = "warning";
		}

		const nameColor: "accent" | "success" | "dim" =
			plugin.source === "builtin" ? "accent" : plugin.source === "user" ? "success" : "dim";
		const name = theme.fg(nameColor, plugin.name.padEnd(18));
		const status = theme.fg(statusColor, statusIcon);
		const source = theme.fg("dim", plugin.source.padEnd(10));
		const config = plugin.hasConfig ? theme.fg("success", "cfg") : theme.fg("dim", "   ");
		const size = theme.fg("dim", `${(plugin.size / 1024).toFixed(0)}KB`.padEnd(8));

		this.addChild(new Text(` ${prefix} ${status} ${name}${source}${config} ${size}`, 1, 0));
	}

	private renderRuntimeActions(): void {
		const plugin = this._selectedRuntime;
		if (!plugin) return;

		this.addChild(new Text(theme.fg("accent", ` ${plugin.name}`), 1, 0));
		this.addChild(new Text(theme.fg("dim", ` ${plugin.source} · ${plugin.path}`), 1, 0));
		this.addChild(new Spacer(1));

		const actions: { key: string; label: string; desc: string }[] = [];

		if (plugin.source === "template") {
			actions.push({ key: "i", label: "Install + Setup", desc: "Copy to ~/.prime/runtimes/ and configure" });
		} else if (plugin.source === "user") {
			actions.push({ key: "s", label: "Reconfigure", desc: "Run setup again (login, repo, etc.)" });
			if (plugin.active) {
				actions.push({ key: "d", label: "Disable", desc: "Disable this plugin" });
			} else {
				actions.push({ key: "e", label: "Enable", desc: "Enable this plugin" });
			}
			actions.push({ key: "x", label: "Uninstall", desc: "Remove from ~/.prime/runtimes/" });
		} else if (plugin.source === "builtin") {
			actions.push({ key: "i", label: "Override", desc: "Copy as user plugin to customize" });
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
		if (this.currentView === "runtimes") {
			return theme.fg("dim", "  ↑↓ navigate · Enter actions · R refresh · esc back · q quit");
		}
		if (this.currentView === "runtime-actions") {
			return theme.fg("dim", "  Runtime actions · esc to go back");
		}
		const total = this.entries.length;
		const online = this.entries.filter((e) => e.online).length;
		const fleet = this.entries.filter((e) => e.inFleet).length;
		return `${theme.fg("dim", `  ${total} devices · ${online} online · ${fleet} in fleet`)}  ${theme.fg("dim", "Enter actions · / search · Ctrl+R rename · Ctrl+T tag · P runtimes · q quit")}`;
	}

	// ─── Keyboard ─────────────────────────────────────────────────────

	handleInput(data: string): void {
		const kb = getKeybindings();

		// Rename/tag input mode
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
				this.rebuildChildren();
				return;
			}
			this.searchInput.handleInput(data);
			this.rebuildChildren();
			return;
		}

		if (this.currentView === "host-actions") {
			this.handleHostActionsInput(data);
			return;
		}

		if (this.currentView === "runtimes") {
			this.handleRuntimesInput(data);
			return;
		}

		if (this.currentView === "runtime-actions") {
			this.handleRuntimeActionsInput(data);
			return;
		}

		if (data === "q" && this.searchInput.getValue() === "") {
			this.onDone();
			return;
		}

		if (data === "r" && this.searchInput.getValue() === "") {
			void this.autoDiscover();
			return;
		}

		// P — open runtimes management view
		if (data === "P" && this.searchInput.getValue() === "") {
			void this.openRuntimesView();
			return;
		}

		// Ctrl+R — quick rename selected device (if in fleet)
		if (data === "\x12" && this.searchInput.getValue() === "") {
			const entry = this.filteredEntries[this.cursorIndex];
			if (entry && entry.inFleet) {
				this.searchInput.setValue("");
				this.statusText = `Enter new name for ${entry.hostname} (Enter to confirm, Esc to cancel):`;
				this._renameTarget = entry.hostname;
				this._renaming = true;
				this.rebuildChildren();
			} else if (entry) {
				this.statusText = `Add ${entry.hostname} to fleet first to rename`;
				this.rebuildChildren();
			}
			return;
		}

		// Ctrl+T — quick tag selected device (if in fleet)
		if (data === "\x14" && this.searchInput.getValue() === "") {
			const entry = this.filteredEntries[this.cursorIndex];
			if (entry && entry.inFleet) {
				this.searchInput.setValue("");
				this.statusText = `Enter tag for ${entry.hostname} (Enter to add, Esc to cancel):`;
				this._tagTarget = entry.hostname;
				this._tagging = true;
				this.rebuildChildren();
			} else if (entry) {
				this.statusText = `Add ${entry.hostname} to fleet first to tag`;
				this.rebuildChildren();
			}
			return;
		}

		if (kb.matches(data, "tui.select.cancel") || shouldTreatAsBack(data, this.searchInput)) {
			if (this.searchInput.getValue() !== "") {
				this.searchInput.setValue("");
				this.applyFilter();
				return;
			}
			this.onCancel();
			return;
		}

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

		if (kb.matches(data, "tui.select.confirm")) {
			void this.handleEnter();
			return;
		}

		this.searchInput.handleInput(data);
		this.applyFilter();
	}

	private async handleEnter(): Promise<void> {
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

	// ─── Runtimes keyboard ──────────────────────────────────────────

	private async openRuntimesView(): Promise<void> {
		this.currentView = "runtimes";
		this.statusText = "Loading runtime plugins...";
		this.rebuildChildren();
		this._runtimePlugins = await listRuntimePlugins();
		this._runtimeCursor = 0;
		this.statusText = "";
		this.rebuildChildren();
	}

	private handleRuntimesInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel") || data === "q") {
			this.currentView = "main";
			this.statusText = "";
			this.rebuildChildren();
			return;
		}

		if (data === "R") {
			void this.openRuntimesView();
			return;
		}

		if (kb.matches(data, "tui.select.up")) {
			this._runtimeCursor = this._runtimeCursor === 0 ? this._runtimePlugins.length - 1 : this._runtimeCursor - 1;
			this.rebuildChildren();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this._runtimeCursor = this._runtimeCursor === this._runtimePlugins.length - 1 ? 0 : this._runtimeCursor + 1;
			this.rebuildChildren();
			return;
		}

		if (kb.matches(data, "tui.select.confirm")) {
			const plugin = this._runtimePlugins[this._runtimeCursor];
			if (plugin) {
				this._selectedRuntime = plugin;
				this.currentView = "runtime-actions";
				this.rebuildChildren();
			}
			return;
		}
	}

	private handleRuntimeActionsInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.currentView = "runtimes";
			this._selectedRuntime = null;
			this.rebuildChildren();
			return;
		}

		const plugin = this._selectedRuntime;
		if (!plugin) return;

		switch (data) {
			case "i":
				void this.runtimeAction("install", plugin);
				break;
			case "s":
				void this.runtimeAction("reconfigure", plugin);
				break;
			case "e":
				void this.runtimeAction("enable", plugin);
				break;
			case "d":
				void this.runtimeAction("disable", plugin);
				break;
			case "x":
				void this.runtimeAction("uninstall", plugin);
				break;
		}
	}

	private async runtimeAction(action: string, plugin: RuntimePluginInfo): Promise<void> {
		switch (action) {
			case "install": {
				// Install the plugin file first
				const result = installRuntimePlugin(plugin.name);
				if (!result.success) {
					this.statusText = `✗ ${result.message}`;
					break;
				}

				// Check if the installed plugin has a setup() function
				const { join } = await import("node:path");
				const { homedir } = await import("node:os");
				const pluginPath = join(homedir(), ".prime", "runtimes", `${plugin.name}.mjs`);
				const hasSetup = await pluginHasSetup(pluginPath);

				if (hasSetup) {
					// Run interactive setup — uses readline for TUI prompts
					this.statusText = `Setting up ${plugin.name}...`;
					this.rebuildChildren();

					const setupResult = await runPluginSetupWithPath(pluginPath, this.createSetupPrompt());

					if (setupResult.success && setupResult.config) {
						savePluginConfig(plugin.name, setupResult.config);
					}
					this.statusText = setupResult.success ? `✓ ${setupResult.message}` : `✗ ${setupResult.message}`;
				} else {
					this.statusText = `✓ ${result.message}`;
				}
				break;
			}
			case "enable": {
				const result = toggleRuntimePlugin(plugin.name, true);
				this.statusText = result.success ? `✓ ${result.message}` : `✗ ${result.message}`;
				break;
			}
			case "reconfigure": {
				const { join } = await import("node:path");
				const { homedir } = await import("node:os");
				const pluginPath = join(homedir(), ".prime", "runtimes", `${plugin.name}.mjs`);
				const hasSetup = await pluginHasSetup(pluginPath);
				if (!hasSetup) {
					this.statusText = `${plugin.name} has no setup flow`;
					break;
				}
				this.statusText = `Reconfiguring ${plugin.name}...`;
				this.rebuildChildren();
				const setupResult = await runPluginSetupWithPath(pluginPath, this.createSetupPrompt());
				if (setupResult.success && setupResult.config) {
					savePluginConfig(plugin.name, setupResult.config);
				}
				this.statusText = setupResult.success ? `✓ ${setupResult.message}` : `✗ ${setupResult.message}`;
				break;
			}
			case "disable": {
				const result = toggleRuntimePlugin(plugin.name, false);
				this.statusText = result.success ? `✓ ${result.message}` : `✗ ${result.message}`;
				break;
			}
			case "uninstall": {
				const result = uninstallRuntimePlugin(plugin.name);
				this.statusText = result.success ? `✓ ${result.message}` : `✗ ${result.message}`;
				break;
			}
		}

		this.currentView = "runtimes";
		this._selectedRuntime = null;
		this._runtimePlugins = await listRuntimePlugins();
		this.rebuildChildren();
	}

	/** Create a SetupPrompt implementation using readline for terminal I/O. */
	private createSetupPrompt() {
		const req = createRequire(import.meta.url);
		const { createInterface } = req("node:readline") as typeof import("node:readline");
		const rl = createInterface({ input: process.stdin, output: process.stdout });

		const ask = (q: string, def?: string): Promise<string | undefined> =>
			new Promise((resolve) => {
				const prompt = def ? `${q} [${def}]: ` : `${q}: `;
				rl.question(prompt, (answer: string) => {
					const trimmed = answer.trim();
					if (!trimmed && def) return resolve(def);
					resolve(trimmed || undefined);
				});
			});

		const confirm = (q: string, def?: boolean): Promise<boolean> =>
			new Promise((resolve) => {
				const hint = def ? "Y/n" : "y/N";
				rl.question(`${q} [${hint}]: `, (answer: string) => {
					const a = answer.trim().toLowerCase();
					if (!a) return resolve(def ?? false);
					resolve(a === "y" || a === "yes");
				});
			});

		const choose = (q: string, options: string[]): Promise<number> =>
			new Promise((resolve) => {
				console.log(`\n${q}`);
				options.forEach((opt, i) => {
					console.log(`  ${i + 1}. ${opt}`);
				});
				rl.question(`Choose (1-${options.length}): `, (answer: string) => {
					const n = Number.parseInt(answer.trim(), 10);
					if (n >= 1 && n <= options.length) return resolve(n - 1);
					resolve(-1);
				});
			});

		const status = (msg: string) => {
			console.log(`  ${msg}`);
		};

		return { ask, confirm, choose, status };
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

	// ─── Actions — all delegate to fleet-operations.ts ────────────────

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
				this.rebuildChildren();
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
				this.rebuildChildren();
				break;
			}
			case "disconnect": {
				this.setLoading(`Disconnecting ${entry.hostname}...`);
				const result = await disconnectFleetHost(entry.hostname);
				this.clearLoading();
				this.statusText = result.success ? `✓ ${result.message}` : `✗ ${result.message}`;
				this.currentView = "main";
				this.selectedEntry = null;
				this.rebuildChildren();
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
					this.rebuildChildren();
					break;
				}
				this.searchInput.setValue("");
				this.statusText = `Enter new name for ${entry.hostname} (Enter to confirm, Esc to cancel):`;
				this._renameTarget = entry.hostname;
				this._renaming = true;
				this.rebuildChildren();
				break;
			}
			case "tag": {
				if (!entry.inFleet) {
					this.statusText = `Add ${entry.hostname} to fleet first to tag`;
					this.rebuildChildren();
					break;
				}
				this.searchInput.setValue("");
				this.statusText = `Enter tag for ${entry.hostname} (Enter to add, Esc to cancel):`;
				this._tagTarget = entry.hostname;
				this._tagging = true;
				this.rebuildChildren();
				break;
			}
			case "ssh": {
				this.statusText = `SSH to ${entry.address}...`;
				this.rebuildChildren();
				await sshIntoFleetHost(entry.hostname);
				this.statusText = `SSH session ended`;
				this.rebuildChildren();
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

// ─── Merge ────────────────────────────────────────────────────────

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
