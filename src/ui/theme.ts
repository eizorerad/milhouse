import chalk from "chalk";

// Milhouse brand colors - distinct from any other CLI tool
export const theme = {
	// Primary colors
	primary: chalk.hex("#7C3AED"), // Purple - main brand color
	secondary: chalk.hex("#06B6D4"), // Cyan - accent color

	// Status colors
	success: chalk.hex("#10B981"), // Green
	warning: chalk.hex("#F59E0B"), // Amber
	error: chalk.hex("#EF4444"), // Red
	info: chalk.hex("#3B82F6"), // Blue

	// Text colors
	muted: chalk.gray,
	dim: chalk.dim,
	bold: chalk.bold,

	// Pipeline phase colors
	phase: {
		scan: chalk.hex("#8B5CF6"), // Violet
		validate: chalk.hex("#06B6D4"), // Cyan
		plan: chalk.hex("#3B82F6"), // Blue
		consolidate: chalk.hex("#10B981"), // Green
		exec: chalk.hex("#F59E0B"), // Amber
		verify: chalk.hex("#EC4899"), // Pink
	},

	// Engine colors
	engine: {
		aider: chalk.hex("#14B8A6"), // Teal (Aider brand color)
		claude: chalk.hex("#D97706"), // Orange
		gemini: chalk.hex("#4285F4"), // Google Blue
		opencode: chalk.hex("#059669"), // Emerald
		cursor: chalk.hex("#7C3AED"), // Purple
		codex: chalk.hex("#2563EB"), // Blue
		qwen: chalk.hex("#DC2626"), // Red
		droid: chalk.hex("#65A30D"), // Lime
	},

	// Formatting helpers
	highlight: (text: string) => chalk.bold.hex("#7C3AED")(text),
	code: (text: string) => chalk.cyan(`\`${text}\``),
	path: (text: string) => chalk.underline.blue(text),
	number: (text: string | number) => chalk.yellow(String(text)),
};

// ASCII art banner for Milhouse
export const banner = `
${theme.primary("╔═══════════════════════════════════════════╗")}
${theme.primary("║")}  ${chalk.bold.hex("#7C3AED")("MILHOUSE")} ${theme.muted("- Pipeline Orchestrator")}     ${theme.primary("║")}
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
		const maxLen = Math.max(...lines.map((l) => l.length), width);
		const top = `${box.topLeft}${box.horizontal.repeat(maxLen + 2)}${box.topRight}`;
		const bottom = `${box.bottomLeft}${box.horizontal.repeat(maxLen + 2)}${box.bottomRight}`;
		const middle = lines
			.map((l) => `${box.vertical} ${l.padEnd(maxLen)} ${box.vertical}`)
			.join("\n");
		return `${top}\n${middle}\n${bottom}`;
	},
};

// Progress bar helper
export const progressBar = (current: number, total: number, width = 20): string => {
	const filled = Math.round((current / total) * width);
	const empty = width - filled;
	const bar = theme.primary("█".repeat(filled)) + theme.dim("░".repeat(empty));
	const percent = Math.round((current / total) * 100);
	return `${bar} ${theme.number(percent)}%`;
};
