/**
 * Milhouse Prompt Building Runtime
 *
 * Provides prompt construction for Milhouse AI execution.
 * Builds comprehensive prompts with project context, rules,
 * boundaries, and task-specific instructions.
 *
 * Features:
 * - Project context integration
 * - Rule and boundary loading
 * - Browser instruction injection
 * - Pipeline-aware prompt building
 * - Event emission for prompt lifecycle
 *
 * @module execution/runtime/prompt
 * @since 1.0.0
 */

import { getConfigService } from "../../services/config/index.ts";
import {
	createBrowserConfig,
	generateCompactBrowserInstructions,
	getBrowserInstructionsIfAvailable,
	legacyFlagToBrowserMode,
} from "./browser.ts";
import type {
	BrowserMode,
	MilhousePrompt,
	MilhousePromptOptions,
	MilhouseRuntimeContext,
} from "./types.ts";

// ============================================================================
// Prompt Section Builders
// ============================================================================

/**
 * Build project context section
 */
function buildProjectContextSection(workDir: string): string | null {
	const config = getConfigService(workDir).getConfig();
	if (!config?.project) {
		return null;
	}

	const parts: string[] = [];
	if (config.project.name) parts.push(`Project: ${config.project.name}`);
	if (config.project.language) parts.push(`Language: ${config.project.language}`);
	if (config.project.framework) parts.push(`Framework: ${config.project.framework}`);
	if (config.project.description) parts.push(`Description: ${config.project.description}`);

	if (parts.length === 0) {
		return null;
	}
	return `## Project Context\n${parts.join("\n")}`;
}

/**
 * Build rules section
 */
function buildRulesSection(workDir: string): string | null {
	const config = getConfigService(workDir).getConfig();
	const rules = config?.rules ?? [];
	if (rules.length === 0) {
		return null;
	}
	return `## Rules (you MUST follow these)\n${rules.join("\n")}`;
}

/**
 * Build boundaries section
 */
function buildBoundariesSection(workDir: string): string | null {
	const config = getConfigService(workDir).getConfig();
	const boundaries = config?.boundaries?.never_touch ?? [];
	if (boundaries.length === 0) {
		return null;
	}
	return `## Boundaries\nDo NOT modify these files/directories:\n${boundaries.join("\n")}`;
}

/**
 * Build task section
 */
function buildTaskSection(task: string): string {
	return `## Task\n${task}`;
}

/**
 * Build instructions section
 */
function buildInstructionsSection(options: {
	skipTests: boolean;
	skipLint: boolean;
	autoCommit: boolean;
	customInstructions?: string[];
}): string {
	const { skipTests, skipLint, autoCommit, customInstructions } = options;
	const instructions: string[] = [];

	let step = 1;
	instructions.push(`${step}. Implement the task described above`);
	step++;

	if (!skipTests) {
		instructions.push(`${step}. Write tests for the feature`);
		step++;
		instructions.push(`${step}. Run tests and ensure they pass before proceeding`);
		step++;
	}

	if (!skipLint) {
		instructions.push(`${step}. Run linting and ensure it passes`);
		step++;
	}

	instructions.push(`${step}. Ensure the code works correctly`);
	step++;

	if (autoCommit) {
		instructions.push(`${step}. Commit your changes with a descriptive message`);
		step++;
	}

	// Add custom instructions if provided
	if (customInstructions && customInstructions.length > 0) {
		for (const instruction of customInstructions) {
			instructions.push(`${step}. ${instruction}`);
			step++;
		}
	}

	return `## Instructions\n${instructions.join("\n")}`;
}

/**
 * Build final notes section
 */
function buildFinalNotesSection(): string {
	return "Keep changes focused and minimal. Do not refactor unrelated code.";
}

// ============================================================================
// Main Prompt Builder
// ============================================================================

/**
 * Build a complete Milhouse prompt with all sections
 *
 * @param options - Prompt building options
 * @returns Complete prompt with metadata
 */
export function buildMilhousePrompt(options: MilhousePromptOptions): MilhousePrompt {
	const {
		task,
		workDir,
		autoCommit,
		browser,
		skipTests,
		skipLint,
		additionalContext,
		customInstructions,
	} = options;

	const parts: string[] = [];
	const sections: string[] = [];

	// Add project context
	const contextSection = buildProjectContextSection(workDir);
	if (contextSection) {
		parts.push(contextSection);
		sections.push("project-context");
	}

	// Add rules
	const rulesSection = buildRulesSection(workDir);
	if (rulesSection) {
		parts.push(rulesSection);
		sections.push("rules");
	}

	// Add boundaries
	const boundariesSection = buildBoundariesSection(workDir);
	if (boundariesSection) {
		parts.push(boundariesSection);
		sections.push("boundaries");
	}

	// Add browser instructions if available
	const browserInstructions = getBrowserInstructionsIfAvailable(browser);
	if (browserInstructions) {
		parts.push(browserInstructions);
		sections.push("browser");
	}

	// Add additional context if provided
	if (additionalContext) {
		parts.push(`## Additional Context\n${additionalContext}`);
		sections.push("additional-context");
	}

	// Add task
	parts.push(buildTaskSection(task));
	sections.push("task");

	// Add instructions
	parts.push(
		buildInstructionsSection({
			skipTests,
			skipLint,
			autoCommit,
			customInstructions,
		}),
	);
	sections.push("instructions");

	// Add final notes
	parts.push(buildFinalNotesSection());
	sections.push("final-notes");

	const text = parts.join("\n\n");

	// Estimate tokens (rough approximation: ~4 chars per token)
	const estimatedTokens = Math.ceil(text.length / 4);

	return {
		text,
		sections,
		estimatedTokens,
		includesBrowser: browser.isAvailable,
	};
}

/**
 * Build prompt using runtime context
 *
 * @param task - Task description
 * @param context - Milhouse runtime context
 * @param options - Additional options
 * @returns Complete prompt with metadata
 */
export function buildPromptWithContext(
	task: string,
	context: MilhouseRuntimeContext,
	options: {
		autoCommit?: boolean;
		browserMode?: BrowserMode;
		skipTests?: boolean;
		skipLint?: boolean;
		additionalContext?: string;
		customInstructions?: string[];
	} = {},
): MilhousePrompt {
	const browserConfig = createBrowserConfig(options.browserMode ?? "auto");

	const prompt = buildMilhousePrompt({
		task,
		workDir: context.environment.workDir,
		autoCommit: options.autoCommit ?? true,
		browser: browserConfig,
		skipTests: options.skipTests ?? false,
		skipLint: options.skipLint ?? false,
		additionalContext: options.additionalContext,
		customInstructions: options.customInstructions,
	});

	// Emit event for prompt building
	context.emitEvent("task:progress", {
		taskId: context.currentTaskId ?? "unknown",
		step: "prompt-built",
		detail: `${prompt.sections.length} sections, ~${prompt.estimatedTokens} tokens`,
	});

	return prompt;
}

// ============================================================================
// Parallel Execution Prompt Builder
// ============================================================================

/**
 * Options for parallel prompt building
 */
export interface ParallelPromptOptions {
	/** Task description */
	task: string;
	/** Progress file path */
	progressFile: string;
	/** Skip tests */
	skipTests?: boolean;
	/** Skip linting */
	skipLint?: boolean;
	/** Browser mode */
	browserMode?: BrowserMode;
	/** Task ID for tracking */
	taskId?: string;
}

/**
 * Build a prompt for parallel agent execution
 *
 * Parallel prompts are more focused and include:
 * - Task-specific instructions
 * - Progress file updates
 * - Compact browser instructions
 *
 * @param options - Parallel prompt options
 * @returns Formatted prompt string
 */
export function buildParallelExecutionPrompt(options: ParallelPromptOptions): string {
	const { task, progressFile, skipTests = false, skipLint = false, browserMode = "auto" } = options;

	const browserConfig = createBrowserConfig(browserMode);
	const browserSection = browserConfig.isAvailable
		? `\n\n${generateCompactBrowserInstructions()}`
		: "";

	const instructions: string[] = [];
	let step = 1;

	instructions.push(`${step}. Implement this specific task completely`);
	step++;

	if (!skipTests) {
		instructions.push(`${step}. Write tests for the feature`);
		step++;
		instructions.push(`${step}. Run tests and ensure they pass before proceeding`);
		step++;
	}

	if (!skipLint) {
		instructions.push(`${step}. Run linting and ensure it passes`);
		step++;
	}

	instructions.push(`${step}. Update ${progressFile} with what you did`);
	step++;
	instructions.push(`${step}. Commit your changes with a descriptive message`);

	return `You are working on a specific task as part of the Milhouse pipeline.
Focus ONLY on this task:

TASK: ${task}${browserSection}

Instructions:
${instructions.join("\n")}

Do NOT modify PRD.md or mark tasks complete - that will be handled separately.
Focus only on implementing: ${task}`;
}

// ============================================================================
// Backward Compatibility Exports
// ============================================================================

/**
 * Legacy prompt options interface
 * @deprecated Use MilhousePromptOptions instead
 */
interface LegacyPromptOptions {
	task: string;
	autoCommit?: boolean;
	workDir?: string;
	browserEnabled?: "auto" | "true" | "false";
	skipTests?: boolean;
	skipLint?: boolean;
}

/**
 * Build the full prompt with project context, rules, boundaries, and task
 * @deprecated Use buildMilhousePrompt() instead
 */
export function buildPrompt(options: LegacyPromptOptions): string {
	const {
		task,
		autoCommit = true,
		workDir = process.cwd(),
		browserEnabled = "auto",
		skipTests = false,
		skipLint = false,
	} = options;

	const browserMode = legacyFlagToBrowserMode(browserEnabled);
	const browserConfig = createBrowserConfig(browserMode);

	const prompt = buildMilhousePrompt({
		task,
		workDir,
		autoCommit,
		browser: browserConfig,
		skipTests,
		skipLint,
	});

	return prompt.text;
}

/**
 * Legacy parallel prompt options interface
 * @deprecated Use ParallelPromptOptions instead
 */
interface LegacyParallelPromptOptions {
	task: string;
	progressFile: string;
	skipTests?: boolean;
	skipLint?: boolean;
	browserEnabled?: "auto" | "true" | "false";
}

/**
 * Build a prompt for parallel agent execution
 * @deprecated Use buildParallelExecutionPrompt() instead
 */
export function buildParallelPrompt(options: LegacyParallelPromptOptions): string {
	const {
		task,
		progressFile,
		skipTests = false,
		skipLint = false,
		browserEnabled = "auto",
	} = options;

	return buildParallelExecutionPrompt({
		task,
		progressFile,
		skipTests,
		skipLint,
		browserMode: legacyFlagToBrowserMode(browserEnabled),
	});
}
