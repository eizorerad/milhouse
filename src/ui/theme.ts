import pc from "picocolors";

/**
 * Convert a hex color string to an ANSI true-color formatter.
 * Uses the same \x1b[38;2;R;G;Bm escape sequence as chalk.hex(),
 * producing byte-identical output. Respects NO_COLOR / terminal capability.
 */
function hex(color: string): (text: string) => string {
	if (!pc.isColorSupported) {
		return (text: string) => text;
	}
	const h = color.replace("#", "");
	const r = Number.parseInt(h.substring(0, 2), 16);
	const g = Number.parseInt(h.substring(2, 4), 16);
	const b = Number.parseInt(h.substring(4, 6), 16);
	return (text: string) => `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

/** Strip ANSI escape codes to get the visible text */
export function stripAnsi(str: string): string {
	// biome-ignore lint: regex is correct for ANSI stripping
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Return the visible length of a string (excluding ANSI escape codes) */
export function visibleLength(str: string): number {
	return stripAnsi(str).length;
}

// Milhouse brand colors - distinct from any other CLI tool
export const theme = {
	// Primary colors
	primary: hex("#7C3AED"), // Purple - main brand color
	secondary: hex("#06B6D4"), // Cyan - accent color

	// Status colors
	success: hex("#10B981"), // Green
	warning: hex("#F59E0B"), // Amber
	error: hex("#EF4444"), // Red
	info: hex("#3B82F6"), // Blue

	// Text colors
	muted: pc.gray,
	dim: pc.dim,
	bold: pc.bold,

	// Pipeline phase colors
	phase: {
		scan: hex("#8B5CF6"), // Violet
		validate: hex("#06B6D4"), // Cyan
		plan: hex("#3B82F6"), // Blue
		consolidate: hex("#10B981"), // Green
		exec: hex("#F59E0B"), // Amber
		verify: hex("#EC4899"), // Pink
	},

	// Engine colors
	engine: {
		aider: hex("#14B8A6"), // Teal (Aider brand color)
		claude: hex("#D97706"), // Orange
		gemini: hex("#4285F4"), // Google Blue
		opencode: hex("#059669"), // Emerald
		cursor: hex("#7C3AED"), // Purple
		codex: hex("#2563EB"), // Blue
		qwen: hex("#DC2626"), // Red
		droid: hex("#65A30D"), // Lime
	},

	// Formatting helpers
	highlight: (text: string) => pc.bold(hex("#7C3AED")(text)),
	code: (text: string) => pc.cyan(`\`${text}\``),
	path: (text: string) => pc.underline(pc.blue(text)),
	number: (text: string | number) => pc.yellow(String(text)),
};

// ASCII art banner for Milhouse
export const banner = `
${theme.primary("╔═══════════════════════════════════════════╗")}
${theme.primary("║")}  ${pc.bold(hex("#7C3AED")("MILHOUSE"))} ${theme.muted("- Pipeline Orchestrator")}     ${theme.primary("║")}
${theme.primary("╚═══════════════════════════════════════════╝")}
`;

// Compact header for commands
export const header = (command: string) =>
	`${theme.primary("▸")} ${theme.bold("milhouse")} ${theme.secondary(command)}`;

// Phase-specific icons
export const phaseIcons = {
	scan: "🔍",
	validate: "✓",
	plan: "📋",
	consolidate: "🔗",
	exec: "⚡",
	verify: "🔒",
};

// Status icons
export const statusIcons = {
	success: "✔",
	error: "✖",
	warning: "⚠",
	info: "ℹ",
	pending: "○",
	running: "●",
};

// Format a phase name with its color and icon
export const formatPhase = (phase: keyof typeof theme.phase): string => {
	const color = theme.phase[phase];
	const icon = phaseIcons[phase];
	return `${icon} ${color(phase)}`;
};

// Format an engine name with its color
export const formatEngine = (engine: keyof typeof theme.engine): string => {
	const color = theme.engine[engine];
	return color(engine);
};

// Format a status with icon and color
export const formatStatus = (status: "success" | "error" | "warning" | "info"): string => {
	const icon = statusIcons[status];
	const color = theme[status];
	return color(icon);
};

// Box drawing helpers for structured output
export const box = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
	teeRight: "├",
	teeLeft: "┤",

	// Create a simple box around text
	wrap: (text: string, width = 50): string => {
		const lines = text.split("\n");
		const maxLen = Math.max(...lines.map((l) => visibleLength(l)), width);
		const top = `${box.topLeft}${box.horizontal.repeat(maxLen + 2)}${box.topRight}`;
		const bottom = `${box.bottomLeft}${box.horizontal.repeat(maxLen + 2)}${box.bottomRight}`;
		const middle = lines
			.map((l) => {
				const pad = " ".repeat(Math.max(0, maxLen - visibleLength(l)));
				return `${box.vertical} ${l}${pad} ${box.vertical}`;
			})
			.join("\n");
		return `${top}\n${middle}\n${bottom}`;
	},
};

// Progress bar helper
export const progressBar = (current: number, total: number, width = 20): string => {
	if (total === 0) {
		return theme.dim("░".repeat(width));
	}
	const filled = Math.round((current / total) * width);
	const empty = width - filled;
	const bar = theme.primary("█".repeat(filled)) + theme.dim("░".repeat(empty));
	const percent = Math.round((current / total) * 100);
	return `${bar} ${theme.number(percent)}%`;
};
