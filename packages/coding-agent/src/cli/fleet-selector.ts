/**
 * Standalone TUI launcher for `prime-agent fleet` (interactive mode).
 *
 * Creates a TUI with a FleetSelectorComponent, similar to how `pi config`
 * creates a TUI with ConfigSelectorComponent.
 */

import { ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { SettingsManager } from "../core/settings-manager.js";
import { FleetSelectorComponent } from "../modes/interactive/components/fleet-selector.js";
import { initTheme, stopThemeWatcher } from "../modes/interactive/theme/theme.js";

export async function selectFleetInteractive(): Promise<void> {
	const settingsManager = SettingsManager.create(process.cwd());
	initTheme(settingsManager.getTheme() || "prime", true);

	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal());
		let resolved = false;

		const selector = new FleetSelectorComponent(
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					stopThemeWatcher();
					resolve();
				}
			},
			() => {
				ui.stop();
				stopThemeWatcher();
				process.exit(0);
			},
			() => ui.requestRender(),
		);

		ui.addChild(selector);
		ui.setFocus(selector);
		ui.start();
	});
}
