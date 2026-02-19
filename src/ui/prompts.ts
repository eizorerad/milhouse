import prompts from "prompts";
import { theme } from "./theme";

// Configure prompts styling
const onCancel = () => {
	console.log(theme.warning("\nOperation cancelled"));
	process.exit(0);
};

export const prompt = {
	// Confirm action
	confirm: async (message: string, initial = false): Promise<boolean> => {
		const response = await prompts(
			{
				type: "confirm",
				name: "value",
				message: `${theme.primary("?")} ${message}`,
				initial,
			},
			{ onCancel },
		);
		return response.value;
	},

	// Select from options
	select: async <T extends string>(
		message: string,
		choices: Array<{ title: string; value: T; description?: string }>,
	): Promise<T> => {
		const response = await prompts(
			{
				type: "select",
				name: "value",
				message: `${theme.primary("?")} ${message}`,
				choices: choices.map((c) => ({
					title: c.title,
					value: c.value,
					description: c.description,
				})),
			},
			{ onCancel },
		);
		return response.value;
	},

	// Multi-select
	multiselect: async <T extends string>(
		message: string,
		choices: Array<{ title: string; value: T; selected?: boolean }>,
	): Promise<T[]> => {
		const response = await prompts(
			{
				type: "multiselect",
				name: "value",
				message: `${theme.primary("?")} ${message}`,
				choices,
				hint: "- Space to select. Return to submit",
			},
			{ onCancel },
		);
		return response.value;
	},

	// Text input
	text: async (message: string, initial?: string): Promise<string> => {
		const response = await prompts(
			{
				type: "text",
				name: "value",
				message: `${theme.primary("?")} ${message}`,
				initial,
			},
			{ onCancel },
		);
		return response.value;
	},

	// Number input
	number: async (
		message: string,
		initial?: number,
		min?: number,
		max?: number,
	): Promise<number> => {
		const response = await prompts(
			{
				type: "number",
				name: "value",
				message: `${theme.primary("?")} ${message}`,
				initial,
				min,
				max,
			},
			{ onCancel },
		);
		return response.value;
	},

	// Password input (hidden)
	password: async (message: string): Promise<string> => {
		const response = await prompts(
			{
				type: "password",
				name: "value",
				message: `${theme.primary("?")} ${message}`,
			},
			{ onCancel },
		);
		return response.value;
	},

	// Autocomplete with suggestions
	autocomplete: async <T extends string>(
		message: string,
		choices: Array<{ title: string; value: T }>,
		limit = 10,
	): Promise<T> => {
		const response = await prompts(
			{
				type: "autocomplete",
				name: "value",
				message: `${theme.primary("?")} ${message}`,
				choices,
				limit,
				suggest: (input: string, allChoices: prompts.Choice[]) => {
					const inputLower = input.toLowerCase();
					return Promise.resolve(
						allChoices.filter((c) => c.title.toLowerCase().includes(inputLower)),
					);
				},
			},
			{ onCancel },
		);
		return response.value;
	},

	// Engine selection with themed colors
	selectEngine: async (): Promise<string> => {
		return prompt.select("Select AI engine:", [
			{
				title: theme.engine.claude("Claude Code"),
				value: "claude",
				description: "Anthropic Claude",
			},
			{ title: theme.engine.opencode("OpenCode"), value: "opencode", description: "Open source" },
			{ title: theme.engine.cursor("Cursor"), value: "cursor", description: "Cursor AI" },
			{ title: theme.engine.codex("Codex"), value: "codex", description: "OpenAI Codex" },
			{ title: theme.engine.qwen("Qwen"), value: "qwen", description: "Alibaba Qwen" },
			{ title: theme.engine.droid("Droid"), value: "droid", description: "Android AI" },
		]);
	},

	// Phase selection with themed colors
	selectPhase: async (): Promise<string> => {
		return prompt.select("Select pipeline phase:", [
			{ title: theme.phase.scan("Scan"), value: "scan", description: "Discover issues" },
			{
				title: theme.phase.validate("Validate"),
				value: "validate",
				description: "Validate issues",
			},
			{ title: theme.phase.plan("Plan"), value: "plan", description: "Create execution plan" },
			{
				title: theme.phase.consolidate("Consolidate"),
				value: "consolidate",
				description: "Consolidate plans",
			},
			{ title: theme.phase.exec("Execute"), value: "exec", description: "Execute tasks" },
			{ title: theme.phase.verify("Verify"), value: "verify", description: "Verify results" },
		]);
	},

	// Run selection
	selectRun: async (runs: Array<{ id: string; name: string; status: string }>): Promise<string> => {
		return prompt.select(
			"Select run:",
			runs.map((r) => ({
				title: `${r.name} ${theme.dim(`(${r.status})`)}`,
				value: r.id,
			})),
		);
	},

	// Task selection
	selectTask: async (
		tasks: Array<{ id: string; title: string; status: string }>,
	): Promise<string> => {
		return prompt.select(
			"Select task:",
			tasks.map((t) => ({
				title: `${t.title} ${theme.dim(`[${t.id}]`)}`,
				value: t.id,
				description: t.status,
			})),
		);
	},

	// Multiple phases selection
	selectPhases: async (): Promise<string[]> => {
		return prompt.multiselect("Select phases to run:", [
			{ title: theme.phase.scan("Scan"), value: "scan", selected: true },
			{ title: theme.phase.validate("Validate"), value: "validate", selected: true },
			{ title: theme.phase.plan("Plan"), value: "plan", selected: true },
			{ title: theme.phase.consolidate("Consolidate"), value: "consolidate", selected: true },
			{ title: theme.phase.exec("Execute"), value: "exec", selected: true },
			{ title: theme.phase.verify("Verify"), value: "verify", selected: true },
		]);
	},

	// Confirm destructive action with typed confirmation
	confirmDestructive: async (action: string, confirmText: string): Promise<boolean> => {
		console.log(theme.warning(`\n⚠️  This action will ${action}`));
		console.log(theme.dim(`Type "${confirmText}" to confirm:`));

		const response = await prompts(
			{
				type: "text",
				name: "value",
				message: theme.error("Confirm"),
			},
			{ onCancel },
		);

		return response.value === confirmText;
	},

	// Toggle option
	toggle: async (
		message: string,
		active: string,
		inactive: string,
		initial = false,
	): Promise<boolean> => {
		const response = await prompts(
			{
				type: "toggle",
				name: "value",
				message: `${theme.primary("?")} ${message}`,
				initial,
				active,
				inactive,
			},
			{ onCancel },
		);
		return response.value;
	},
};

// Export prompts types for external use
export type { prompts };
