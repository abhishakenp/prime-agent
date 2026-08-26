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

import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	matchesKey,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { type DiscoveredDevice, discoverStream, inferTags } from "../../../cli/fleet/discovery.js";
import {
	type FleetHost,
	type FleetTransport,
	importRuntimeMembers,
	listFleetHosts,
	listFleetMembers,
	removeFleetMember,
} from "../../../cli/fleet/fleet-config.js";
import { addHostToFleet, renameHostInFleet, tagHostInFleet } from "../../../cli/fleet/fleet-operations.js";
import {
	installRuntimePlugin,
	listRuntimePlugins,
	runPluginSetupWithPath,
} from "../../../cli/fleet/runtime-operations.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { shouldTreatAsBack } from "./modal-back.js";

type FleetView = "main";

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
	/** Transport type for unified fleet (ssh, cloudflare, github-actions, custom). */
	transport?: string;
	/** Transport-specific config. */
	config?: Record<string, unknown>;
	/** Whether this is a cloud member (not an SSH host). */
	isCloud?: boolean;
	/** Whether setup/config is complete. */
	hasConfig?: boolean;
	/** Whether this is an available runtime template (not yet added to fleet). */
	isTemplate?: boolean;
}

export interface FleetSelectorOptions {
	/** Called when the selector is dismissed. */
	onDone: () => void;
	/** Called on cancel (Esc). Defaults to onDone. */
	onCancel?: () => void;
	/** Request a re-render of the parent TUI. */
	requestRender: () => void;
	/** The TUI instance — needed for showing setup overlays. */
	ui?: TUI;
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
	private spinnerFrame = 0;
	private spinnerTimer: ReturnType<typeof setInterval> | null = null;
	private _renaming = false;
	private _renameTarget = "";
	private _tagging = false;
	private _tagTarget = "";
	private backgroundRefreshInProgress = false;
	private readonly onDone: () => void;

	private static readonly SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

	private startSpinner(): void {
		if (this.spinnerTimer) return;
		this.spinnerFrame = 0;
		this.spinnerTimer = setInterval(() => {
			this.spinnerFrame = (this.spinnerFrame + 1) % FleetSelectorComponent.SPINNER_FRAMES.length;
			this.rebuildChildren();
		}, 80);
	}

	private stopSpinner(): void {
		if (this.spinnerTimer) {
			clearInterval(this.spinnerTimer);
			this.spinnerTimer = null;
		}
	}

	private getSpinner(): string {
		return FleetSelectorComponent.SPINNER_FRAMES[this.spinnerFrame] ?? "⠋";
	}
	private readonly onCancel: () => void;
	private readonly requestRender: () => void;
	private readonly ui: TUI | undefined;

	constructor(options: FleetSelectorOptions);
	/** @deprecated Legacy positional args — use FleetSelectorOptions. */
	constructor(onDone: () => void, onCancel?: () => void, requestRender?: () => void);
	constructor(...args: [FleetSelectorOptions] | [(() => void)?, (() => void)?, (() => void)?]) {
		super();
		if (typeof args[0] === "function") {
			this.onDone = args[0] ?? (() => {});
			this.onCancel = args[1] ?? this.onDone;
			this.requestRender = args[2] ?? (() => {});
			this.ui = undefined;
		} else {
			const opts = args[0]!;
			this.onDone = opts.onDone;
			this.onCancel = opts.onCancel ?? opts.onDone;
			this.requestRender = opts.requestRender;
			this.ui = opts.ui;
		}

		this.searchInput = new Input();
		this.isLoading = true;
		this.statusText = "Loading fleet...";

		this.rebuildChildren();
		void this.initDiscovery();
	}

	/** First load: fast config from disk, show immediately, then background network scan. */
	private async initDiscovery(): Promise<void> {
		this.setLoading("Loading fleet config...");
		this.startSpinner();
		this.entries = [];
		await this.loadFleetConfig();
		this.clearLoading();
		this.statusText = `${this.entries.length} members · scanning network...`;
		if (this.currentView === "main") {
			this.applyFilter();
		}
		await this.discoverNetwork();
		this.stopSpinner();
		this.statusText = `${this.entries.length} members`;
		if (this.currentView === "main") {
			this.applyFilter();
		}
	}

	getSearchInput(): Input {
		return this.searchInput;
	}

	// ─── Discovery: fast config load + background network scan ───────

	/** Fast: load fleet config + runtime plugins from disk (no network). */
	private async loadFleetConfig(): Promise<void> {
		await importRuntimeMembers();

		const fleetHosts = await listFleetHosts();
		this.entries = mergeHostsAndDevices(fleetHosts, []);

		const members = await listFleetMembers();
		const addedTransports = new Set<string>();
		for (const m of members) {
			if (m.transport === "ssh") continue;
			addedTransports.add(m.transport);
			const existing = this.entries.find((e) => e.hostname === m.name);
			if (existing) {
				existing.transport = m.transport;
				existing.config = m.config;
				existing.isCloud = true;
				existing.hasConfig = !!(m.config && Object.keys(m.config).length > 0);
				existing.inFleet = true;
			} else {
				this.entries.push({
					hostname: m.name,
					address: (m.config?.repo as string) ?? (m.config?.accountId as string) ?? m.address ?? "-",
					tags: m.tags,
					source: "fleet",
					online: m.enabled !== false,
					sshable: false,
					hasPi: false,
					inFleet: true,
					transport: m.transport,
					config: m.config,
					isCloud: true,
					hasConfig: !!(m.config && Object.keys(m.config).length > 0),
				});
			}
		}

		const plugins = await listRuntimePlugins();
		for (const p of plugins) {
			if (addedTransports.has(p.name)) continue;
			if (p.name === "ssh") continue;
			if (p.name === "example-custom") continue;
			this.entries.push({
				hostname: p.name,
				address: p.hasConfig ? "configured" : "not configured",
				tags: ["available"],
				source: "discovered",
				online: false,
				sshable: false,
				hasPi: false,
				inFleet: false,
				transport: p.name,
				isCloud: true,
				isTemplate: true,
				hasConfig: p.hasConfig,
				config: p.config,
			});
		}
	}

	/** Slow: scan network for devices. Merges into entries live. */
	private async discoverNetwork(): Promise<void> {
		try {
			const DISCOVERY_TIMEOUT_MS = 8000;
			const discoveryPromise = (async () => {
				for await (const device of discoverStream({ probeTimeoutMs: 2000 })) {
					this.mergeDevice(device);
				}
			})();
			await Promise.race([discoveryPromise, new Promise((resolve) => setTimeout(resolve, DISCOVERY_TIMEOUT_MS))]);
		} catch {
			// Discovery interrupted — keep what we have
		}
	}

	/** Background refresh: re-scan network without blocking UI. */
	private refreshInBackground(): void {
		if (this.backgroundRefreshInProgress) return;
		this.backgroundRefreshInProgress = true;
		this.statusText = "Scanning network for devices...";
		this.startSpinner();
		this.rebuildChildren();

		void (async () => {
			await this.loadFleetConfig();
			await this.discoverNetwork();
			this.stopSpinner();
			this.backgroundRefreshInProgress = false;
			this.statusText = `Refreshed · ${this.entries.length} members`;
			if (this.currentView === "main") {
				this.applyFilter();
			}
		})();
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
		// Sort must match renderGroupedList order exactly:
		// FLEET → AVAILABLE RUNTIMES → ONLINE → OFFLINE
		this.filteredEntries.sort((a, b) => {
			const aGroup = a.inFleet ? 0 : a.isTemplate ? 1 : a.online ? 2 : 3;
			const bGroup = b.inFleet ? 0 : b.isTemplate ? 1 : b.online ? 2 : 3;
			if (aGroup !== bGroup) return aGroup - bGroup;
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
		} else if (this.isLoading || this.backgroundRefreshInProgress) {
			this.addChild(new Text(theme.fg("accent", `  ${this.getSpinner()} ${this.statusText}`), 1, 0));
		} else if (this.filteredEntries.length === 0 && this.searchInput.getValue().trim()) {
			this.addChild(new Text(theme.fg("dim", `  No devices match "${this.searchInput.getValue().trim()}"`), 1, 0));
		} else if (this.filteredEntries.length === 0) {
			this.addChild(new Text(theme.fg("dim", "  No devices found on network"), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "  Press r to scan again · add runtimes with Enter"), 1, 0));
		} else {
			this.renderGroupedList();
		}

		this.addChild(new Spacer(1));
		this.addChild(new Text(this.getStatusLine(), 1, 0));
		this.addChild(new DynamicBorder());
		this.requestRender();
	}

	private renderGroupedList(): void {
		const fleetItems = this.filteredEntries.filter((e) => e.inFleet);
		const templateItems = this.filteredEntries.filter((e) => e.isTemplate);
		const onlineItems = this.filteredEntries.filter((e) => !e.inFleet && !e.isTemplate && e.online);
		const offlineItems = this.filteredEntries.filter((e) => !e.inFleet && !e.isTemplate && !e.online);

		let virtualIndex = 0;

		if (fleetItems.length > 0) {
			this.addChild(new Text(theme.fg("accent", theme.bold(` FLEET (${fleetItems.length})`)), 1, 0));
			for (const entry of fleetItems) {
				this.addDeviceRow(entry, virtualIndex);
				virtualIndex++;
			}
			this.addChild(new Spacer(1));
		}

		if (templateItems.length > 0) {
			this.addChild(new Text(theme.fg("dim", theme.bold(` AVAILABLE RUNTIMES (${templateItems.length})`)), 1, 0));
			for (const entry of templateItems) {
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
		const hostnameColor = entry.isTemplate ? "dim" : entry.inFleet ? "accent" : entry.online ? "text" : "dim";
		const hostname = theme.fg(hostnameColor, truncateToWidth(displayName, 22, ""));
		let transportBadge: string;
		if (entry.isTemplate) {
			transportBadge = theme.fg("dim", (entry.transport ?? "runtime").padEnd(7));
		} else if (entry.isCloud) {
			transportBadge = theme.fg("accent", (entry.transport ?? "cloud").padEnd(7));
		} else if (entry.os) {
			transportBadge = this.formatOsBadge(entry.os);
		} else {
			transportBadge = "";
		}
		const badges = entry.isTemplate ? theme.fg("dim", "○ add") : this.formatBadges(entry);
		const prefix = isSelected ? theme.fg("accent", "›") : " ";

		const padding = " ".repeat(Math.max(1, 27 - visibleWidth(displayName)));
		const row = `${prefix} ${hostname}${padding}${transportBadge} ${badges}`;
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

	private getStatusLine(): string {
		const total = this.entries.length;
		const online = this.entries.filter((e) => e.online).length;
		const fleet = this.entries.filter((e) => e.inFleet).length;
		const selected = this.filteredEntries[this.cursorIndex];
		const rHint = selected?.isCloud ? "r reconfigure" : "r refresh";
		return `${theme.fg("dim", `  ${total} devices · ${online} online · ${fleet} in fleet`)}  ${theme.fg("dim", `Enter add/remove · / search · ${rHint} · Ctrl+R rename · Ctrl+T tag · q quit`)}`;
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

		if (data === "q" && this.searchInput.getValue() === "") {
			this.stopSpinner();
			this.onDone();
			return;
		}

		if (data === "r" && this.searchInput.getValue() === "") {
			const list = this.filteredEntries.length > 0 ? this.filteredEntries : this.entries;
			const entry = list[this.cursorIndex];
			if (entry && entry.isCloud) {
				this.selectedEntry = entry;
				void this.cloudAction("setup");
				return;
			}
			if (this.entries.length > 0 && !this.isLoading && !this.backgroundRefreshInProgress) {
				this.refreshInBackground();
			}
			return;
		}

		// Ctrl+R — quick rename selected device (if in fleet)
		if (matchesKey(data, "ctrl+r") && this.searchInput.getValue() === "") {
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
		if (matchesKey(data, "ctrl+t") && this.searchInput.getValue() === "") {
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
			this.stopSpinner();
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
		if (!entry) return;

		// Available runtime (template or removed plugin) → add to fleet
		if (entry.isTemplate) {
			if (entry.hasConfig) {
				// Was configured before (removed plugin) — just re-add, no setup needed
				await this.reAddRuntime(entry);
			} else {
				// New runtime → add + auto-setup
				await this.addAndSetupRuntime(entry);
			}
			return;
		}

		// Cloud member without config → auto-setup
		if (entry.isCloud && entry.inFleet && !entry.hasConfig) {
			this.selectedEntry = entry;
			await this.cloudAction("setup");
			return;
		}

		// Not in fleet → add to fleet
		if (!entry.inFleet) {
			const result = await addHostToFleet(entry.hostname, entry.address, entry.tags, entry.device);
			this.statusText = result.success ? `✓ ${result.message}` : `✗ ${result.message}`;
			if (result.success) {
				entry.inFleet = true;
				entry.isTemplate = false;
			}
			this.applyFilter();
			return;
		}

		// In fleet → remove from fleet
		const removed = await removeFleetMember(entry.hostname);
		this.statusText = removed ? `✓ Removed ${entry.hostname}` : `✗ Failed to remove`;
		if (removed) {
			entry.inFleet = false;
			if (entry.isCloud) entry.isTemplate = true;
		}
		this.applyFilter();
	}

	private async reAddRuntime(entry: FleetEntry): Promise<void> {
		const transport = entry.transport ?? entry.hostname;
		const { addFleetMember } = await import("../../../cli/fleet/fleet-config.js");
		await addFleetMember({
			name: transport,
			transport: transport as FleetTransport,
			tags: ["cloud", transport],
			addedAt: Date.now(),
			lastStatus: "active",
			enabled: true,
			config: entry.config,
		});
		this.statusText = `✓ Re-added ${transport}`;
		entry.inFleet = true;
		entry.isTemplate = false;
		this.applyFilter();
	}

	private async addAndSetupRuntime(entry: FleetEntry): Promise<void> {
		const transport = entry.transport ?? entry.hostname;
		this.setLoading(`Adding ${transport}...`);

		// Install the plugin
		const result = installRuntimePlugin(transport);
		if (!result.success) {
			this.clearLoading();
			this.statusText = `✗ ${result.message}`;
			this.rebuildChildren();
			return;
		}

		// Add as fleet member
		const { addFleetMember } = await import("../../../cli/fleet/fleet-config.js");
		await addFleetMember({
			name: transport,
			transport: transport as FleetTransport,
			tags: ["cloud", transport],
			addedAt: Date.now(),
			lastStatus: "inactive",
			enabled: true,
		});

		this.clearLoading();

		// Auto-run setup
		this.selectedEntry = { ...entry, inFleet: true, isTemplate: false };
		entry.inFleet = true;
		entry.isTemplate = false;
		this.applyFilter();
		await this.cloudAction("setup");
	}

	private async confirmRename(newName: string): Promise<void> {
		const hostname = this._renameTarget;
		this._renaming = false;
		this.searchInput.setValue("");
		const result = await renameHostInFleet(hostname, newName);
		this.statusText = result.success ? `✓ ${result.message}` : `✗ ${result.message}`;
		this.currentView = "main";
		this.selectedEntry = null;
		if (result.success) {
			const entry = this.entries.find((e) => e.hostname === hostname);
			if (entry) {
				if (entry.fleetHost) entry.fleetHost.displayName = newName;
				else entry.fleetHost = { hostname, displayName: newName } as FleetHost;
			}
		}
		this.applyFilter();
	}

	private async confirmTag(tag: string): Promise<void> {
		const hostname = this._tagTarget;
		this._tagging = false;
		this.searchInput.setValue("");
		const result = await tagHostInFleet(hostname, tag);
		this.statusText = result.success ? `✓ ${result.message}` : `✗ ${result.message}`;
		this.currentView = "main";
		this.selectedEntry = null;
		if (result.success) {
			const entry = this.entries.find((e) => e.hostname === hostname);
			if (entry && !entry.tags.includes(tag)) entry.tags.push(tag);
		}
		this.applyFilter();
	}

	// ─── Actions — all delegate to fleet-operations.ts ────────────────

	private async cloudAction(action: string): Promise<void> {
		const entry = this.selectedEntry;
		if (!entry || !entry.isCloud) return;
		const transport = entry.transport ?? "custom";

		if (action !== "setup") return;

		this.setLoading(`Running ${transport} setup...`);
		try {
			const { savePluginConfig, pluginHasSetup } = await import("../../../cli/fleet/runtime-operations.js");
			const { userRuntimesDir, builtinRuntimesDir } = await import(
				"../../../core/fleet-runtime/runtime-plugin-loader.js"
			);
			const { join } = await import("node:path");
			const { existsSync } = await import("node:fs");

			// Find plugin path
			const userPath = join(userRuntimesDir(), `${transport}.mjs`);
			const builtinPath = join(builtinRuntimesDir(), `${transport}.mjs`);
			const pluginPath = existsSync(userPath) ? userPath : existsSync(builtinPath) ? builtinPath : null;

			if (!pluginPath) {
				this.clearLoading();
				this.statusText = `✗ No plugin found for ${transport}`;
				this.rebuildChildren();
				return;
			}

			const hasSetup = await pluginHasSetup(pluginPath);
			if (!hasSetup) {
				this.clearLoading();
				this.statusText = `✗ ${transport} has no setup flow`;
				this.rebuildChildren();
				return;
			}

			// Use TUI prompt provider - interactive overlays with search
			// instead of dropping to a plain readline terminal.
			if (!this.ui) {
				// No TUI available - fall back to readline-based setup
				const result = await this.runInteractiveSetup(pluginPath);
				this.clearLoading();
				if (result.success && result.config) {
					savePluginConfig(transport, result.config);
					const { updateFleetMemberConfig } = await import("../../../cli/fleet/fleet-config.js");
					await updateFleetMemberConfig(entry.hostname, result.config);
					entry.config = result.config;
					entry.hasConfig = true;
					this.statusText = `\u2713 ${transport} configured`;
				} else if (result.message) {
					this.statusText = result.success ? `\u2713 ${result.message}` : `\u2717 ${result.message}`;
				} else {
					this.statusText = `\u2713 ${transport} setup complete`;
				}
				this.rebuildChildren();
				return;
			}

			const { createTuiPromptProvider } = await import("./tui-prompt.js");
			const prompt = createTuiPromptProvider(this.ui);

			const result = await this.runPluginSetupWithTui(pluginPath, prompt);

			this.clearLoading();
			if (result.success && result.config) {
				savePluginConfig(transport, result.config);
				const { updateFleetMemberConfig } = await import("../../../cli/fleet/fleet-config.js");
				await updateFleetMemberConfig(entry.hostname, result.config);
				entry.config = result.config;
				entry.hasConfig = true;
				this.statusText = `✓ ${transport} configured`;
			} else if (result.message) {
				this.statusText = result.success ? `✓ ${result.message}` : `✗ ${result.message}`;
			} else {
				this.statusText = `✓ ${transport} setup complete`;
			}
			this.rebuildChildren();
		} catch (err) {
			this.clearLoading();
			this.statusText = `✗ Setup failed: ${err instanceof Error ? err.message : String(err)}`;
			this.rebuildChildren();
		}
	}

	/**
	 * Run plugin setup using TUI overlays for prompts.
	 * The setup function uses execSync for gh/wrangler commands (captured,
	 * no terminal I/O needed). For browser login (gh auth login --web,
	 * wrangler login), spawn with stdio: "inherit" writes to the alt screen
	 * buffer; the browser opens externally. After the child exits, the TUI
	 * re-renders automatically.
	 */
	private async runPluginSetupWithTui(
		pluginPath: string,
		prompt: {
			ask: (q: string, def?: string) => Promise<string | undefined>;
			confirm: (q: string, def?: boolean) => Promise<boolean>;
			choose: (q: string, options: string[]) => Promise<number>;
			status: (msg: string) => void;
		},
	): Promise<{ success: boolean; message: string; config?: Record<string, unknown> }> {
		return runPluginSetupWithPath(pluginPath, prompt);
	}

	/**
	 * Run plugin setup with real readline-based interactive prompts.
	 * Suspends TUI raw mode so readline + child processes (wrangler login,
	 * gh auth login --web) work with proper terminal I/O.
	 * Restores TUI raw mode after setup completes.
	 */
	private async runInteractiveSetup(pluginPath: string): Promise<{
		success: boolean;
		message: string;
		config?: Record<string, unknown>;
	}> {
		const { createInterface } = await import("node:readline");

		// Suspend TUI completely:
		// 1. Remove all stdin data listeners (TUI's input handler)
		// 2. Exit raw mode so readline + child processes get proper terminal I/O
		// 3. Leave alt screen so setup output goes to the main terminal buffer
		//    (child processes like `gh auth login --web` need the real terminal,
		//    not the alt screen buffer)
		const stdin = process.stdin;

		// Save and remove all existing data listeners (TUI's input handler)
		const originalListeners = stdin.listeners("data") as ((chunk: Buffer) => void)[];
		stdin.removeAllListeners("data");
		stdin.pause();

		// Exit raw mode
		if (stdin.setRawMode) {
			stdin.setRawMode(false);
		}

		// Leave alt screen — setup runs in the main terminal buffer
		process.stdout.write("\x1b[?1049l");

		// Clear screen + print separator
		process.stdout.write("\x1b[2J\x1b[H");
		process.stdout.write("--- Setup ---\n\n");

		const rl = createInterface({ input: stdin, output: process.stdout });

		const prompt = {
			ask: (q: string, def?: string): Promise<string | undefined> =>
				new Promise((resolve) => {
					const hint = def ? ` [${def}]: ` : ": ";
					rl.question(`${q}${hint}`, (answer: string) => {
						const trimmed = answer.trim();
						if (!trimmed && def) return resolve(def);
						resolve(trimmed || undefined);
					});
				}),
			confirm: (q: string, def?: boolean): Promise<boolean> =>
				new Promise((resolve) => {
					const hint = def ? " [Y/n]: " : " [y/N]: ";
					rl.question(`${q}${hint}`, (answer: string) => {
						const a = answer.trim().toLowerCase();
						if (!a) return resolve(def ?? false);
						resolve(a === "y" || a === "yes");
					});
				}),
			choose: (q: string, options: string[]): Promise<number> =>
				new Promise((resolve) => {
					console.log(`\n${q}`);
					for (let i = 0; i < options.length; i++) {
						console.log(`  ${i + 1}. ${options[i]}`);
					}
					rl.question(`Choose (1-${options.length}): `, (answer: string) => {
						const n = Number.parseInt(answer.trim(), 10);
						if (n >= 1 && n <= options.length) return resolve(n - 1);
						resolve(-1);
					});
				}),
			status: (msg: string) => {
				console.log(`  ${msg}`);
			},
		};

		try {
			const result = await runPluginSetupWithPath(pluginPath, prompt);
			rl.close();

			// Show result + wait for Enter BEFORE restoring TUI
			// (we're still in main buffer, not raw mode — readline just closed)
			process.stdout.write(`\n${result.success ? "✓" : "✗"} ${result.message}\n`);
			process.stdout.write("\nPress Enter to return to fleet manager...\n");

			await new Promise<void>((resolve) => {
				const handler = () => {
					stdin.removeListener("data", handler);
					stdin.pause();
					resolve();
				};
				stdin.once("data", handler);
				stdin.resume();
			});

			return result;
		} finally {
			// Restore TUI: re-enter alt screen, re-attach listeners, raw mode
			stdin.pause();
			// Re-enter alt screen for clean TUI rendering
			process.stdout.write("\x1b[?1049h");
			// Clear the alt screen buffer
			process.stdout.write("\x1b[2J\x1b[H");
			for (const listener of originalListeners) {
				stdin.on("data", listener);
			}
			if (stdin.setRawMode) {
				stdin.setRawMode(true);
			}
			stdin.resume();
			// Force full re-render
			this.requestRender();
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
