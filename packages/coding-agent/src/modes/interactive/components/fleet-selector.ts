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
import { installRuntimePlugin, listRuntimePlugins } from "../../../cli/fleet/runtime-operations.js";
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
		this.setLoading("Discovering fleet members...");

		// Import runtime configs as fleet members (idempotent)
		await importRuntimeMembers();

		// Load SSH hosts (legacy, still works)
		const fleetHosts = await listFleetHosts();
		this.clearLoading();
		this.entries = mergeHostsAndDevices(fleetHosts, []);

		// Load cloud members (cloudflare, github-actions, custom)
		const members = await listFleetMembers();
		const addedTransports = new Set<string>();
		for (const m of members) {
			if (m.transport === "ssh") continue; // Already in fleetHosts
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

		// Add available runtime plugins (templates + removed user plugins)
		// ssh is the core transport, not a cloud compute platform — skip it
		const plugins = await listRuntimePlugins();
		for (const p of plugins) {
			if (addedTransports.has(p.name)) continue;
			if (p.name === "ssh") continue; // core transport, not a compute platform
			if (p.name === "example-custom") continue; // demo file, not a real runtime
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

		this.statusText = `Discovery complete · ${this.entries.length} members`;
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
		} else if (this.isLoading) {
			this.addChild(new Text(theme.fg("dim", `  ${this.statusText}`), 1, 0));
		} else if (this.filteredEntries.length === 0) {
			this.addChild(new Text(theme.fg("dim", "  No devices found"), 1, 0));
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
		return `${theme.fg("dim", `  ${total} devices · ${online} online · ${fleet} in fleet`)}  ${theme.fg("dim", "Enter add/remove · / search · r reconfigure · Ctrl+R rename · Ctrl+T tag · q quit")}`;
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
			this.onDone();
			return;
		}

		if (data === "r" && this.searchInput.getValue() === "") {
			// r on active cloud member → reconfigure (run setup)
			const entry = this.filteredEntries[this.cursorIndex];
			if (entry && entry.isCloud && entry.inFleet && entry.hasConfig) {
				this.selectedEntry = entry;
				void this.cloudAction("setup");
				return;
			}
			// Otherwise → refresh
			void this.autoDiscover();
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
			await this.autoDiscover();
			return;
		}

		// In fleet → remove from fleet
		const removed = await removeFleetMember(entry.hostname);
		this.statusText = removed ? `✓ Removed ${entry.hostname}` : `✗ Failed to remove`;
		await this.autoDiscover();
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
		await this.autoDiscover();
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
		await this.cloudAction("setup");

		// Refresh list
		await this.autoDiscover();
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

	private async cloudAction(action: string): Promise<void> {
		const entry = this.selectedEntry;
		if (!entry || !entry.isCloud) return;
		const transport = entry.transport ?? "custom";

		if (action !== "setup") return;

		this.setLoading(`Running ${transport} setup...`);
		try {
			const { runPluginSetupWithPath, savePluginConfig, pluginHasSetup } = await import(
				"../../../cli/fleet/runtime-operations.js"
			);
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

			if (!pluginHasSetup(pluginPath)) {
				this.clearLoading();
				this.statusText = `✗ ${transport} has no setup flow`;
				this.rebuildChildren();
				return;
			}

			// Run interactive setup (OAuth, repo creation, project selection, etc.)
			const result = await runPluginSetupWithPath(pluginPath, {
				ask: async (msg: string, defaultValue?: string) => {
					this.statusText = `Setup: ${msg} → ${defaultValue ?? ""}`;
					this.rebuildChildren();
					return defaultValue ?? "";
				},
				confirm: async (msg: string, def?: boolean) => {
					this.statusText = `Setup: ${msg} → ${def ?? true}`;
					this.rebuildChildren();
					return def ?? true;
				},
				choose: async (msg: string, options: string[]) => {
					this.statusText = `Setup: ${msg} → ${options[0]}`;
					this.rebuildChildren();
					return 0;
				},
				status: (msg: string) => {
					this.statusText = `Setup: ${msg}`;
					this.rebuildChildren();
				},
			});

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
