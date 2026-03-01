/**
 * ANSI String Utilities
 *
 * Shared utilities for handling strings containing ANSI escape codes.
 * Extracted from src/ui/_legacy/spinners-deprecated.ts for reuse across modules.
 *
 * @module utils/ansi-string
 */

import pc from "picocolors";

/** Strip ANSI escape codes to get visible string length */
export function stripAnsi(str: string): string {
	// biome-ignore lint: regex is correct for ANSI stripping
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Truncate a string (which may contain ANSI codes) to fit within maxWidth visible characters.
 * Appends "…" if truncated.
 */
export function truncateToWidth(text: string, maxWidth: number): string {
	const visible = stripAnsi(text);
	if (visible.length <= maxWidth) return text;

	// Walk through the original string, tracking visible char count
	let visibleCount = 0;
	let i = 0;
	while (i < text.length && visibleCount < maxWidth - 1) {
		// Skip ANSI escape sequences
		if (text[i] === "\x1b" && text[i + 1] === "[") {
			const end = text.indexOf("m", i);
			if (end !== -1) {
				i = end + 1;
				continue;
			}
		}
		visibleCount++;
		i++;
	}

	// Include any trailing ANSI reset sequences so colors don't bleed
	return `${text.slice(0, i)}${pc.reset("…")}`;
}
