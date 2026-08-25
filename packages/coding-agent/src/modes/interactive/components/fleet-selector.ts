/**
 * Interactive TUI component for managing the fleet.
 *
 * Shows a list of fleet hosts with their status. Actions:
 * - Enter: open host actions (connect/disconnect/bootstrap/remove/status)
 * - d: discover new devices
 * - r: refresh host statuses
 * - q/esc: quit
 */

import {
	Container,
	type Focusable,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
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

type FleetView = "hosts" | "actions" | "discover" | "discover-actions";

const FLEET_SELECT_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 16,
	maxPrimaryColumnWidth: 30,
};

export class FleetSelectorComponent extends Container implements Focusable {
	focused = false;
	private selectList: SelectList;
	private currentView: FleetView = "hosts";
	private hosts: FleetHost[] = [];
	private discoveredDevices: DiscoveredDevice[] = [];
	private selectedHost: FleetHost | null = null;
	private selectedDevice: DiscoveredDevice | null = null;
	private statusText = "";
	private isLoading = false;
	private readonly onDone: () => void;
	private readonly requestRender: () => void;

	constructor(onDone: () => void, _onCancel: () => void, requestRender: () => void) {
		super();
		this.onDone = onDone;
		this.requestRender = requestRender;
		this.selectList = new SelectList([], 15, getFleetSelectListTheme(), FLEET_SELECT_LAYOUT);
		this.selectList.onSelect = (item) => {
			void this.handleSelect(item);
		};
		this.selectList.onCancel = () => this.handleCancel();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "Fleet Manager")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text("", 1, 0));
		this.addChild(new DynamicBorder());
		void this.refreshHosts();
	}

	getSelectList(): SelectList {
		return this.selectList;
	}

	// ─── View rendering ───────────────────────────────────────────────

	private async refreshHosts(): Promise<void> {
		this.setLoading("Loading fleet...");
		this.hosts = await listFleetHosts();
		this.clearLoading();
		this.showHostsView();
	}

	private showHostsView(): void {
		this.currentView = "hosts";
		const items: SelectItem[] = this.hosts.map((host) => ({
			value: host.hostname,
			label: host.hostname,
			description: formatHostDescription(host),
		}));
		items.push({
			value: "__discover__",
			label: "Discover devices",
			description: "Scan network for accessible hosts",
		});
		items.push({ value: "__refresh__", label: "Refresh statuses", description: "Re-probe all fleet hosts" });
		// Set status BEFORE updateSelectList so the Text is created with correct content
		this.statusText =
			this.hosts.length > 0
				? `${this.hosts.length} host(s) · Enter to manage · d to discover · q to quit`
				: "No hosts · d to discover · q to quit";
		this.updateSelectList(items);
	}

	private showActionsView(host: FleetHost): void {
		this.currentView = "actions";
		this.selectedHost = host;
		const items: SelectItem[] = [
			{ value: "status", label: "Check status", description: "Probe SSH, pi, and daemon" },
			{
				value: "bootstrap",
				label: "Bootstrap (install pi + start daemon)",
				description: host.piVersion ? `Pi ${host.piVersion} already installed` : "Install pi via npm",
			},
			{ value: "connect", label: "Connect to gateway", description: "Mark as connected" },
			{ value: "disconnect", label: "Disconnect", description: "Stop daemon on host" },
			{ value: "remove", label: `Remove "${host.hostname}" from fleet`, description: "Unregister this host" },
			{ value: "__back__", label: "← Back to hosts", description: "" },
		];
		this.statusText = `Managing "${host.hostname}" · esc to go back`;
		this.updateSelectList(items);
	}

	private showDiscoverView(): void {
		this.currentView = "discover";
		const online = this.discoveredDevices.filter((d) => d.online !== false);
		const inFleet = new Set(this.hosts.map((h) => h.hostname.toLowerCase()));

		const items: SelectItem[] = online.map((device) => ({
			value: device.hostname,
			label: device.hostname,
			description: formatDeviceDescription(device, inFleet.has(device.hostname.toLowerCase())),
		}));

		if (items.length === 0) {
			this.statusText = "No online devices found · esc to go back";
			this.updateSelectList([{ value: "__back__", label: "← Back", description: "" }]);
			return;
		}

		items.push({ value: "__back__", label: "← Back to hosts", description: "" });
		this.statusText = `${online.length} online device(s) · Enter to add · esc to go back`;
		this.updateSelectList(items);
	}

	private showDiscoverActionsView(device: DiscoveredDevice): void {
		this.currentView = "discover-actions";
		this.selectedDevice = device;
		const inFleet = this.hosts.some((h) => h.hostname.toLowerCase() === device.hostname.toLowerCase());

		const items: SelectItem[] = [];

		if (!inFleet) {
			items.push({
				value: "add",
				label: `Add "${device.hostname}" to fleet`,
				description: `Tags: ${inferTags(device).join(", ")}`,
			});
		} else {
			items.push({
				value: "already",
				label: `"${device.hostname}" is already in fleet`,
				description: "",
			});
		}

		if (device.sshable && !device.hasPi) {
			items.push({
				value: "bootstrap",
				label: "Bootstrap (install pi + start daemon)",
				description: "Install pi via npm on this device",
			});
		}

		items.push({ value: "__back__", label: "← Back to devices", description: "" });
		this.statusText = `Device: ${device.hostname} (${device.os ?? "?"}) · esc to go back`;
		this.updateSelectList(items);
	}

	// ─── Event handling ───────────────────────────────────────────────

	private async handleSelect(item: SelectItem): Promise<void> {
		const value = item.value;

		if (this.currentView === "hosts") {
			if (value === "__discover__") {
				await this.runDiscover();
				return;
			}
			if (value === "__refresh__") {
				await this.runRefreshAll();
				return;
			}
			const host = this.hosts.find((h) => h.hostname === value);
			if (host) {
				this.showActionsView(host);
			}
			return;
		}

		if (this.currentView === "actions" && this.selectedHost) {
			await this.handleHostAction(value);
			return;
		}

		if (this.currentView === "discover") {
			if (value === "__back__") {
				this.showHostsView();
				return;
			}
			const device = this.discoveredDevices.find((d) => d.hostname === value);
			if (device) {
				this.showDiscoverActionsView(device);
			}
			return;
		}

		if (this.currentView === "discover-actions" && this.selectedDevice) {
			await this.handleDiscoverAction(value);
			return;
		}
	}

	private async handleHostAction(action: string): Promise<void> {
		const host = this.selectedHost;
		if (!host) return;

		switch (action) {
			case "status": {
				this.setLoading(`Probing ${host.hostname}...`);
				const status = await checkHostStatus(host.address);
				this.clearLoading();
				this.setStatus(
					`${host.hostname}: ${status.online ? "✓ online" : "✗ offline"} · pi ${status.piInstalled ? "✓" : "✗"} · daemon ${status.daemonRunning ? "✓" : "✗"}`,
				);
				if (status.piVersion) host.piVersion = status.piVersion;
				host.lastStatus = status.online ? (status.daemonRunning ? "connected" : "disconnected") : "unreachable";
				await updateFleetHostStatus(host.hostname, host.lastStatus);
				this.showActionsView(host);
				break;
			}
			case "bootstrap": {
				this.setLoading(`Bootstrapping ${host.hostname}...`);
				const result = await bootstrapHost({
					target: host.address,
					hostname: host.hostname,
					tags: host.tags,
					capabilities: host.capabilities,
				});
				this.clearLoading();
				if (result.success) {
					this.setStatus(`✓ Bootstrap complete: ${host.hostname}`);
					if (result.piVersion) host.piVersion = result.piVersion;
					await updateFleetHostStatus(host.hostname, "connected");
				} else {
					this.setStatus(`✗ Bootstrap failed: ${result.error}`);
				}
				this.showActionsView(host);
				break;
			}
			case "connect": {
				await updateFleetHostStatus(host.hostname, "connected");
				this.setStatus(`✓ ${host.hostname} marked connected`);
				this.showActionsView(host);
				break;
			}
			case "disconnect": {
				this.setLoading(`Disconnecting ${host.hostname}...`);
				await disconnectHost(host.address);
				this.clearLoading();
				await updateFleetHostStatus(host.hostname, "disconnected");
				this.setStatus(`✓ ${host.hostname} disconnected`);
				this.showActionsView(host);
				break;
			}
			case "remove": {
				await removeFleetHost(host.hostname);
				this.setStatus(`✓ Removed ${host.hostname}`);
				this.selectedHost = null;
				await this.refreshHosts();
				break;
			}
			case "__back__":
				this.selectedHost = null;
				this.showHostsView();
				break;
		}
	}

	private async handleDiscoverAction(action: string): Promise<void> {
		const device = this.selectedDevice;
		if (!device) return;

		switch (action) {
			case "add": {
				const tags = inferTags(device);
				const host: FleetHost = {
					hostname: device.hostname,
					address: device.tailscaleIp ?? device.address,
					tags,
					capabilities: ["bash", "ipython", "browser"],
					os: device.os,
					addedAt: Date.now(),
					lastStatus: device.sshable ? "disconnected" : "unreachable",
					piVersion: device.piVersion,
				};
				await addFleetHost(host);
				this.setStatus(`✓ Added ${device.hostname} (tags: ${tags.join(", ")})`);
				this.selectedDevice = null;
				await this.refreshHosts();
				break;
			}
			case "bootstrap": {
				this.setLoading(`Bootstrapping ${device.hostname}...`);
				const result = await bootstrapHost({
					target: device.tailscaleIp ?? device.address,
					hostname: device.hostname,
					tags: inferTags(device),
					capabilities: ["bash", "ipython", "browser"],
				});
				this.clearLoading();
				if (result.success) {
					const host: FleetHost = {
						hostname: device.hostname,
						address: device.tailscaleIp ?? device.address,
						tags: inferTags(device),
						capabilities: ["bash", "ipython", "browser"],
						os: device.os,
						addedAt: Date.now(),
						lastStatus: "connected",
						piVersion: result.piVersion,
					};
					await addFleetHost(host);
					this.setStatus(`✓ Bootstrapped and added ${device.hostname}`);
				} else {
					this.setStatus(`✗ Bootstrap failed: ${result.error}`);
				}
				this.selectedDevice = null;
				await this.refreshHosts();
				break;
			}
			case "__back__":
				this.selectedDevice = null;
				this.showDiscoverView();
				break;
		}
	}

	private async runDiscover(): Promise<void> {
		this.setLoading("Scanning network for devices...");
		this.discoveredDevices = await discoverDevices({});
		this.clearLoading();
		const online = this.discoveredDevices.filter((d) => d.online !== false);
		this.setStatus(`Found ${this.discoveredDevices.length} devices (${online.length} online)`);
		this.showDiscoverView();
	}

	private async runRefreshAll(): Promise<void> {
		this.setLoading("Refreshing all hosts...");
		for (const host of this.hosts) {
			const status = await checkHostStatus(host.address);
			host.lastStatus = status.online ? (status.daemonRunning ? "connected" : "disconnected") : "unreachable";
			if (status.piVersion) host.piVersion = status.piVersion;
			await updateFleetHostStatus(host.hostname, host.lastStatus);
		}
		this.clearLoading();
		this.showHostsView();
	}

	private handleCancel(): void {
		if (this.currentView === "hosts") {
			this.onDone();
		} else if (this.currentView === "actions") {
			this.selectedHost = null;
			this.showHostsView();
		} else if (this.currentView === "discover") {
			this.showHostsView();
		} else if (this.currentView === "discover-actions") {
			this.selectedDevice = null;
			this.showDiscoverView();
		}
	}

	// ─── Keyboard ─────────────────────────────────────────────────────

	handleInput(data: string): void {
		// 'd' to discover from hosts view
		if (this.currentView === "hosts" && (data === "d" || data === "\x04")) {
			void this.runDiscover();
			return;
		}
		// 'q' to quit from hosts view
		if (this.currentView === "hosts" && data === "q") {
			this.onDone();
			return;
		}
		// 'r' to refresh from hosts view
		if (this.currentView === "hosts" && data === "r") {
			void this.runRefreshAll();
			return;
		}
		// Delegate to select list
		this.selectList.handleInput?.(data);
	}

	// ─── Helpers ──────────────────────────────────────────────────────

	private updateSelectList(items: SelectItem[]): void {
		this.selectList = new SelectList(items, 15, getFleetSelectListTheme(), FLEET_SELECT_LAYOUT);
		this.selectList.onSelect = (item) => {
			void this.handleSelect(item);
		};
		this.selectList.onCancel = () => this.handleCancel();
		this.children = [];
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "Fleet Manager")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.selectList);
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

	private setStatus(text: string): void {
		this.statusText = text;
		this.requestRender();
	}
}

// ─── Theme ─────────────────────────────────────────────────────────

function getFleetSelectListTheme() {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", `> ${text}`),
		selectedText: (text: string) => theme.bold(text),
		description: (text: string) => theme.fg("dim", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("dim", text),
	};
}

// ─── Formatting ────────────────────────────────────────────────────

function formatHostDescription(host: FleetHost): string {
	const parts: string[] = [];
	if (host.os) parts.push(host.os);
	if (host.tags.length > 0) parts.push(host.tags.join(","));
	const status = host.lastStatus ?? "unknown";
	const statusIcon = status === "connected" ? "●" : status === "disconnected" ? "○" : "✗";
	parts.push(`${statusIcon} ${status}`);
	if (host.piVersion) parts.push(`pi ${host.piVersion}`);
	return parts.join(" · ");
}

function formatDeviceDescription(device: DiscoveredDevice, inFleet: boolean): string {
	const parts: string[] = [];
	parts.push(device.os ?? "?");
	if (device.sshable) parts.push("ssh ✓");
	if (device.hasPi) parts.push("pi ✓");
	if (inFleet) parts.push("in fleet");
	parts.push(device.source);
	return parts.join(" · ");
}
