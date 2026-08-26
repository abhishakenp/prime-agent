/**
 * TUI-based prompt provider — replaces readline prompts with interactive overlays.
 *
 * Implements the same prompt interface as readline-based setup but uses
 * the fleet TUI's overlay system: searchable lists, yes/no confirms,
 * text input — all with arrow keys, / to search, Enter to select.
 *
 * Used by fleet setup flows (cloudflare, github-actions, custom runtimes)
 * so setup stays in the TUI instead of dropping to a plain terminal.
 */

import {
	type Component,
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	type OverlayHandle,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { showFullPaneOverlay } from "./centered-overlay.js";

// ─── Prompt interface (same as readline-based one) ────────────────

export interface PromptProvider {
	ask: (q: string, def?: string) => Promise<string | undefined>;
	confirm: (q: string, def?: boolean) => Promise<boolean>;
	choose: (q: string, options: string[]) => Promise<number>;
	status: (msg: string) => void;
}

// ─── Searchable list overlay ──────────────────────────────────────

class SearchableListComponent extends Container implements Focusable {
	private _focused = false;
	private readonly searchInput = new Input();
	private filteredOptions: { label: string; index: number }[] = [];
	private cursorIndex = 0;
	private readonly title: string;
	private readonly options: string[];
	private readonly onSelect: (index: number) => void;
	private readonly statusText: string;
	private readonly requestRender: () => void;

	constructor(opts: {
		title: string;
		options: string[];
		statusText?: string;
		onSelect: (index: number) => void;
		requestRender: () => void;
	}) {
		super();
		this.title = opts.title;
		this.options = opts.options;
		this.statusText = opts.statusText ?? "";
		this.onSelect = opts.onSelect;
		this.requestRender = opts.requestRender;
		this.filteredOptions = opts.options.map((label, index) => ({ label, index }));
		this.rebuildChildren();
	}

	get focused() {
		return this._focused;
	}
	set focused(v: boolean) {
		this._focused = v;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			if (this.searchInput.getValue() !== "") {
				this.searchInput.setValue("");
				this.applyFilter();
				return;
			}
			this.onSelect(-1);
			return;
		}

		if (kb.matches(data, "tui.select.up")) {
			this.cursorIndex = this.cursorIndex === 0 ? this.filteredOptions.length - 1 : this.cursorIndex - 1;
			this.rebuildChildren();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.cursorIndex = this.cursorIndex === this.filteredOptions.length - 1 ? 0 : this.cursorIndex + 1;
			this.rebuildChildren();
			return;
		}

		if (kb.matches(data, "tui.select.confirm")) {
			const entry = this.filteredOptions[this.cursorIndex];
			this.onSelect(entry ? entry.index : -1);
			return;
		}

		// Search input
		if (data === "/" && this.searchInput.getValue() === "") {
			this.rebuildChildren();
			return;
		}
		this.searchInput.handleInput(data);
		this.applyFilter();
	}

	private applyFilter(): void {
		const query = this.searchInput.getValue().trim();
		const all = this.options.map((label, index) => ({ label, index }));
		this.filteredOptions = query ? fuzzyFilter(all, query, (e) => e.label) : all;
		if (this.cursorIndex >= this.filteredOptions.length) {
			this.cursorIndex = Math.max(0, this.filteredOptions.length - 1);
		}
		this.rebuildChildren();
	}

	private rebuildChildren(): void {
		this.children = [];
		this.addChild(new DynamicBorderTop());
		this.addChild(new Text(theme.bold(theme.fg("accent", ` ${this.title}`)), 1, 0));
		this.addChild(new Spacer(1));

		// Search bar
		const searchVal = this.searchInput.getValue();
		const searchPlaceholder = searchVal ? "" : "  Type to search...";
		this.addChild(new Text(theme.fg("dim", searchPlaceholder || `  Search: ${searchVal}`), 1, 0));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		// Options list
		if (this.filteredOptions.length === 0) {
			this.addChild(new Text(theme.fg("dim", "  No matches"), 1, 0));
		} else {
			const maxVisible = 20;
			const start = Math.max(0, this.cursorIndex - Math.floor(maxVisible / 2));
			const end = Math.min(this.filteredOptions.length, start + maxVisible);
			for (let i = start; i < end; i++) {
				const opt = this.filteredOptions[i];
				const isCursor = i === this.cursorIndex;
				const prefix = isCursor ? " › " : "   ";
				const label = truncateToWidth(opt.label, 80, "…");
				const line = isCursor
					? theme.bold(theme.fg("accent", `${prefix}${label}`))
					: theme.fg("dim", `${prefix}${label}`);
				this.addChild(new Text(line, 1, 0));
			}
			if (this.filteredOptions.length > maxVisible) {
				this.addChild(new Spacer(1));
				this.addChild(
					new Text(theme.fg("dim", `  Showing ${end - start} of ${this.filteredOptions.length}`), 1, 0),
				);
			}
		}

		this.addChild(new Spacer(1));
		if (this.statusText) {
			this.addChild(new Text(theme.fg("dim", `  ${this.statusText}`), 1, 0));
		}
		this.addChild(new Text(theme.fg("dim", "  ↑↓ navigate · / search · Enter select · Esc cancel"), 1, 0));
		this.addChild(new DynamicBorderTop());
		this.requestRender();
	}
}

// ─── Confirm overlay ──────────────────────────────────────────────

class ConfirmComponent extends Container implements Focusable {
	private _focused = false;
	private readonly question: string;
	private readonly defaultValue: boolean;
	private readonly onSelect: (result: boolean) => void;
	private readonly requestRender: () => void;

	constructor(opts: {
		question: string;
		defaultValue: boolean;
		onSelect: (result: boolean) => void;
		requestRender: () => void;
	}) {
		super();
		this.question = opts.question;
		this.defaultValue = opts.defaultValue;
		this.onSelect = opts.onSelect;
		this.requestRender = opts.requestRender;
		this.rebuildChildren();
	}

	get focused() {
		return this._focused;
	}
	set focused(v: boolean) {
		this._focused = v;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.onSelect(false);
			return;
		}
		const first = data[0];
		if (first === "y" || first === "Y") {
			this.onSelect(true);
			return;
		}
		if (first === "n" || first === "N") {
			this.onSelect(false);
			return;
		}
		if (first === "\r" || first === "\n") {
			this.onSelect(this.defaultValue);
			return;
		}
	}

	private rebuildChildren(): void {
		this.children = [];
		this.addChild(new DynamicBorderTop());
		this.addChild(new Text(theme.bold(theme.fg("accent", " Confirm")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(`  ${this.question}`, 1, 0));
		this.addChild(new Spacer(1));
		const hint = this.defaultValue ? " [Y/n]" : " [y/N]";
		this.addChild(new Text(theme.fg("dim", `  ${hint} — y=yes, n=no, Enter=default`), 1, 0));
		this.addChild(new DynamicBorderTop());
		this.requestRender();
	}
}

// ─── Ask (text input) overlay ─────────────────────────────────────

class AskComponent extends Container implements Focusable {
	private _focused = false;
	private readonly question: string;
	private readonly defaultValue: string | undefined;
	private readonly input = new Input();
	private readonly onSelect: (result: string | undefined) => void;
	private readonly requestRender: () => void;

	constructor(opts: {
		question: string;
		defaultValue?: string;
		onSelect: (result: string | undefined) => void;
		requestRender: () => void;
	}) {
		super();
		this.question = opts.question;
		this.defaultValue = opts.defaultValue;
		this.onSelect = opts.onSelect;
		this.requestRender = opts.requestRender;
		if (opts.defaultValue) {
			this.input.setValue(opts.defaultValue);
		}
		this.rebuildChildren();
	}

	get focused() {
		return this._focused;
	}
	set focused(v: boolean) {
		this._focused = v;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.onSelect(undefined);
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || data[0] === "\r" || data[0] === "\n") {
			const val = this.input.getValue().trim();
			this.onSelect(val || this.defaultValue);
			return;
		}
		this.input.handleInput(data);
		this.rebuildChildren();
	}

	private rebuildChildren(): void {
		this.children = [];
		this.addChild(new DynamicBorderTop());
		this.addChild(new Text(theme.bold(theme.fg("accent", " Input")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(`  ${this.question}`, 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Type value · Enter to confirm · Esc to cancel"), 1, 0));
		this.addChild(new DynamicBorderTop());
		this.requestRender();
	}
}

// ─── Status line (non-blocking) ───────────────────────────────────

class StatusComponent extends Container implements Focusable {
	private _focused = false;
	private message: string;
	private readonly requestRender: () => void;

	constructor(message: string, requestRender: () => void) {
		super();
		this.message = message;
		this.requestRender = requestRender;
		this.rebuildChildren();
	}

	get focused() {
		return this._focused;
	}
	set focused(v: boolean) {
		this._focused = v;
	}

	handleInput(_data: string): void {
		// Status is non-interactive — any key dismisses
	}

	update(msg: string): void {
		this.message = msg;
		this.rebuildChildren();
	}

	private rebuildChildren(): void {
		this.children = [];
		this.addChild(new DynamicBorderTop());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", `  ${this.message}`), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorderTop());
		this.requestRender();
	}
}

// ─── Simple border components ─────────────────────────────────────

class DynamicBorderTop implements Component {
	invalidate(): void {}

	render(width: number): string[] {
		return [theme.fg("accent", "─".repeat(width))];
	}
}

// ─── TUI Prompt Provider ──────────────────────────────────────────

export function createTuiPromptProvider(ui: TUI): PromptProvider {
	const requestRender = () => ui.requestRender();

	let statusHandle: OverlayHandle | undefined;
	let statusComponent: StatusComponent | undefined;

	const showOverlay = (component: Component): OverlayHandle => {
		return showFullPaneOverlay(ui, component, 96);
	};

	const hideStatus = () => {
		if (statusHandle) {
			statusHandle.hide();
			statusHandle = undefined;
			statusComponent = undefined;
		}
	};

	return {
		async ask(q: string, def?: string): Promise<string | undefined> {
			hideStatus();
			return new Promise((resolve) => {
				let handle: OverlayHandle | undefined;
				const component = new AskComponent({
					question: q,
					defaultValue: def,
					onSelect: (result) => {
						handle?.hide();
						resolve(result);
					},
					requestRender,
				});
				handle = showOverlay(component);
			});
		},

		async confirm(q: string, def?: boolean): Promise<boolean> {
			hideStatus();
			return new Promise((resolve) => {
				let handle: OverlayHandle | undefined;
				const component = new ConfirmComponent({
					question: q,
					defaultValue: def ?? false,
					onSelect: (result) => {
						handle?.hide();
						resolve(result);
					},
					requestRender,
				});
				handle = showOverlay(component);
			});
		},

		async choose(q: string, options: string[]): Promise<number> {
			hideStatus();
			return new Promise((resolve) => {
				let handle: OverlayHandle | undefined;
				const component = new SearchableListComponent({
					title: q,
					options,
					onSelect: (index) => {
						handle?.hide();
						resolve(index);
					},
					requestRender,
				});
				handle = showOverlay(component);
			});
		},

		status(msg: string): void {
			// Update or create status overlay
			if (statusComponent) {
				statusComponent.update(msg);
			} else {
				statusComponent = new StatusComponent(msg, requestRender);
				statusHandle = showOverlay(statusComponent);
			}
		},
	};
}
