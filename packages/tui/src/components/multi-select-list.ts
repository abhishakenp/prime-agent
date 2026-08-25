/**
 * MultiSelectList — list component with toggleable checkboxes.
 *
 * Keys:
 * - up/down: navigate
 * - space: toggle selection on current item
 * - enter: confirm (calls onConfirm with all selected items)
 * - esc: cancel
 * - a: select all
 * - n: select none
 *
 * Built on the same rendering pattern as SelectList from pi-tui.
 */

import { getKeybindings } from "../keybindings.js";
import type { Component } from "../tui.js";
import { truncateToWidth, visibleWidth } from "../utils.js";

export interface MultiSelectItem {
	value: string;
	label: string;
	description?: string;
	/** Pre-selected (checked) on init. */
	checked?: boolean;
	/** Disabled — cannot be toggled. */
	disabled?: boolean;
}

export interface MultiSelectTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
	checkbox: (checked: boolean, selected: boolean) => string;
	hint: (text: string) => string;
}

export interface MultiSelectLayoutOptions {
	minPrimaryColumnWidth?: number;
	maxPrimaryColumnWidth?: number;
}

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

export class MultiSelectList implements Component {
	private items: MultiSelectItem[] = [];
	private selectedIndex = 0;
	private maxVisible: number;
	private theme: MultiSelectTheme;
	private layout: MultiSelectLayoutOptions;
	private checkedSet = new Set<string>();

	public onConfirm?: (selected: MultiSelectItem[]) => void;
	public onCancel?: () => void;
	public onToggle?: (item: MultiSelectItem, checked: boolean) => void;

	constructor(
		items: MultiSelectItem[],
		maxVisible: number,
		theme: MultiSelectTheme,
		layout: MultiSelectLayoutOptions = {},
	) {
		this.items = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.layout = layout;
		for (const item of items) {
			if (item.checked && !item.disabled) {
				this.checkedSet.add(item.value);
			}
		}
	}

	setItems(items: MultiSelectItem[]): void {
		this.items = items;
		this.checkedSet.clear();
		for (const item of items) {
			if (item.checked && !item.disabled) {
				this.checkedSet.add(item.value);
			}
		}
		this.selectedIndex = 0;
	}

	isChecked(value: string): boolean {
		return this.checkedSet.has(value);
	}

	toggle(value: string): void {
		const item = this.items.find((i) => i.value === value);
		if (!item || item.disabled) return;
		if (this.checkedSet.has(value)) {
			this.checkedSet.delete(value);
			this.onToggle?.(item, false);
		} else {
			this.checkedSet.add(value);
			this.onToggle?.(item, true);
		}
	}

	getCheckedItems(): MultiSelectItem[] {
		return this.items.filter((i) => this.checkedSet.has(i.value));
	}

	selectAll(): void {
		for (const item of this.items) {
			if (!item.disabled) this.checkedSet.add(item.value);
		}
	}

	selectNone(): void {
		this.checkedSet.clear();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.items.length === 0) {
			lines.push(this.theme.noMatch("  No items"));
			return lines;
		}

		const primaryColumnWidth = this.getPrimaryColumnWidth();
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.items.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.items.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.items[i];
			if (!item) continue;
			const isSelected = i === this.selectedIndex;
			const isChecked = this.checkedSet.has(item.value);
			lines.push(this.renderItem(item, isSelected, isChecked, width, primaryColumnWidth));
		}

		if (startIndex > 0 || endIndex < this.items.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.items.length})`;
			lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
		} else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + this.maxVisible);
		} else if (keyData === " " || keyData === "space") {
			const item = this.items[this.selectedIndex];
			if (item && !item.disabled) {
				this.toggle(item.value);
			}
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			if (this.onConfirm) {
				this.onConfirm(this.getCheckedItems());
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel?.();
		} else if (keyData === "a") {
			this.selectAll();
		} else if (keyData === "n") {
			this.selectNone();
		}
	}

	private renderItem(
		item: MultiSelectItem,
		isSelected: boolean,
		isChecked: boolean,
		width: number,
		primaryColumnWidth: number,
	): string {
		const checkbox = this.theme.checkbox(isChecked, isSelected);
		const prefix = isSelected ? "› " : "  ";
		const prefixWidth = visibleWidth(prefix) + visibleWidth(checkbox) + 1;
		const descriptionSingleLine = item.description?.replace(/[\r\n]+/g, " ").trim();

		const styledPrefix = isSelected ? this.theme.selectedPrefix(prefix) : prefix;

		if (descriptionSingleLine && width > 50) {
			const effectivePrimaryColumnWidth = Math.max(1, Math.min(primaryColumnWidth, width - prefixWidth - 4));
			const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
			const truncatedValue = truncateToWidth(item.label, maxPrimaryWidth, "");
			const truncatedValueWidth = visibleWidth(truncatedValue);
			const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
			const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
			const remainingWidth = width - descriptionStart - 2;

			if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
				const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "…");
				if (isSelected) {
					return this.theme.selectedText(`${styledPrefix}${checkbox} ${truncatedValue}${spacing}${truncatedDesc}`);
				}
				return `${styledPrefix}${checkbox} ${truncatedValue}${this.theme.description(spacing + truncatedDesc)}`;
			}
		}

		const maxWidth = width - prefixWidth - 2;
		const truncatedValue = truncateToWidth(item.label, maxWidth, "");
		if (isSelected) {
			return this.theme.selectedText(`${styledPrefix}${checkbox} ${truncatedValue}`);
		}
		return `${styledPrefix}${checkbox} ${truncatedValue}`;
	}

	private getPrimaryColumnWidth(): number {
		const min = this.layout.minPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
		const max = this.layout.maxPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
		const widest = this.items.reduce((w, item) => Math.max(w, visibleWidth(item.label) + PRIMARY_COLUMN_GAP), 0);
		return clamp(widest, Math.max(1, min), Math.max(1, max));
	}
}
