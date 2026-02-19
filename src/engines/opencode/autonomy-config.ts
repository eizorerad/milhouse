/**
 * OpenCode Autonomy Configuration
 *
 * Provides configuration for autonomous operation of OpenCode in Milhouse pipeline.
 * This module defines system prompts and tool restrictions for different pipeline phases.
 *
 * Key features:
 * - AUTONOMY_SYSTEM_PROMPT: Prevents OpenCode from asking questions and waiting for input
 * - READ_ONLY_TOOLS: Restricts tools to read-only operations for analysis phases
 * - EXECUTION_TOOLS: Full tool access for execution phase
 *
 * @see https://opencode.ai/docs/server
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Pipeline phases in Milhouse.
 */
export type PipelinePhase = "scan" | "validate" | "plan" | "consolidate" | "exec" | "verify";

/**
 * Tools record type - maps tool names to enabled status.
 * OpenCode API expects tools as a record, not an array.
 */
export type ToolsRecord = Record<string, boolean>;

/**
 * Message options for OpenCode sendMessage API.
 */
export interface AutonomyMessageOptions {
	/** Model override in "providerID/modelID" format */
	model?: string;
	/** System prompt override for autonomous operation */
	system: string;
	/** Tools to enable for this message (record of tool name to enabled status) */
	tools: ToolsRecord;
}

// ============================================================================
// System Prompts
// ============================================================================

/**
 * System prompt for autonomous operation.
 * Prevents OpenCode from asking questions and waiting for user input.
 *
 * This prompt is critical for automated pipelines where:
 * - No human is available to answer questions
 * - The agent must make decisions autonomously
 * - Hanging on questions would block the entire pipeline
 */
export const AUTONOMY_SYSTEM_PROMPT = `⚠️ CRITICAL: AUTONOMOUS OPERATION MODE

You are running in a fully automated pipeline. You MUST:
- NEVER ask questions - make reasonable decisions based on available information
- NEVER wait for user input - proceed with the best available option
- NEVER request clarification - use your judgment and document assumptions
- NEVER pause execution - complete the task or report failure
- NEVER suggest alternatives and ask which to choose - pick the best one yourself

If you encounter ambiguity:
1. Make a reasonable assumption based on context
2. Document your assumption in the output
3. Proceed with execution

If you cannot proceed:
1. Report the specific blocker in your response
2. Do NOT ask how to resolve it
3. Provide your best analysis with available information

Remember: This is an automated pipeline. Any question or pause will cause the system to hang indefinitely.`;

/**
 * System prompt specifically for analysis phases (scan, validate, plan, consolidate).
 * Emphasizes read-only behavior and analysis focus.
 */
export const ANALYSIS_SYSTEM_PROMPT = `${AUTONOMY_SYSTEM_PROMPT}

📋 ANALYSIS MODE RESTRICTIONS:
- You are in ANALYSIS mode - your job is to READ and ANALYZE, not to modify code
- Do NOT write, edit, or create any files
- Do NOT execute commands that modify the filesystem
- Focus on understanding the codebase and providing insights
- Output your findings in the requested JSON format

If you feel the urge to fix something:
1. Document the issue in your analysis output
2. Do NOT attempt to fix it yourself
3. The execution phase will handle fixes later`;

/**
 * System prompt specifically for execution phase.
 * Allows full modification capabilities.
 */
export const EXECUTION_SYSTEM_PROMPT = `${AUTONOMY_SYSTEM_PROMPT}

🔧 EXECUTION MODE:
- You are in EXECUTION mode - you CAN and SHOULD modify code to complete the task
- Make the necessary changes to fix the issue
- Run tests to verify your changes work
- Commit your changes when complete
- If tests fail, fix the issues and try again

Work autonomously until the task is complete or you've exhausted all reasonable approaches.`;

// ============================================================================
// Tool Sets
// ============================================================================

/**
 * Read-only tools for analysis phases (scan, validate, plan, consolidate).
 * These tools can only READ the codebase, not modify it.
 *
 * Available tools in OpenCode:
 * - read: Read file contents
 * - glob: Find files by pattern
 * - grep: Search file contents with regex
 * - ls: List directory contents
 * - tree: Show directory tree structure
 * - bash: Execute shell commands (restricted to read-only in analysis)
 *
 * Note: bash is included because some analysis requires running commands
 * like `npm test`, `git status`, `git log`, etc. The system prompt
 * instructs the agent not to use bash for modifications.
 *
 * OpenCode API expects tools as a record of {toolName: boolean}, not an array.
 */
export const READ_ONLY_TOOLS: ToolsRecord = {
	read: true,
	glob: true,
	grep: true,
	ls: true,
	tree: true,
	bash: true, // For read-only commands like 'npm test', 'git status', 'cat', etc.
};

/**
 * Full tools for execution phase (exec).
 * These tools can modify the codebase.
 *
 * Additional tools beyond READ_ONLY_TOOLS:
 * - write: Write/create new files
 * - edit: Edit existing files (apply diffs)
 * - patch: Apply patches to files
 *
 * bash is included with full capabilities for:
 * - Running builds
 * - Running tests
 * - Git operations (commit, push)
 * - Package management (npm install, etc.)
 *
 * OpenCode API expects tools as a record of {toolName: boolean}, not an array.
 */
export const EXECUTION_TOOLS: ToolsRecord = {
	read: true,
	write: true,
	edit: true,
	patch: true,
	glob: true,
	grep: true,
	ls: true,
	tree: true,
	bash: true,
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the appropriate system prompt for a pipeline phase.
 *
 * @param phase - The pipeline phase
 * @returns The system prompt to use
 */
export function getSystemPromptForPhase(phase: PipelinePhase): string {
	switch (phase) {
		case "scan":
		case "validate":
		case "plan":
		case "consolidate":
		case "verify":
			return ANALYSIS_SYSTEM_PROMPT;
		case "exec":
			return EXECUTION_SYSTEM_PROMPT;
		default:
			return AUTONOMY_SYSTEM_PROMPT;
	}
}

/**
 * Get the appropriate tools for a pipeline phase.
 *
 * @param phase - The pipeline phase
 * @returns Record of tool names to enabled status
 */
export function getToolsForPhase(phase: PipelinePhase): ToolsRecord {
	switch (phase) {
		case "scan":
		case "validate":
		case "plan":
		case "consolidate":
		case "verify":
			return READ_ONLY_TOOLS;
		case "exec":
			return EXECUTION_TOOLS;
		default:
			return READ_ONLY_TOOLS;
	}
}

/**
 * Check if a phase is an analysis phase (read-only).
 *
 * @param phase - The pipeline phase
 * @returns true if the phase is analysis-only
 */
export function isAnalysisPhase(phase: PipelinePhase): boolean {
	return phase !== "exec";
}

/**
 * Get message options for OpenCode sendMessage API based on pipeline phase.
 *
 * This is the main helper function to use when calling sendMessage().
 * It returns the appropriate system prompt and tools for the phase.
 *
 * @param phase - The pipeline phase
 * @param modelOverride - Optional model override in "providerID/modelID" format
 * @returns Message options for sendMessage()
 *
 * @example
 * ```typescript
 * // In scan.ts
 * const response = await executor.sendMessage(
 *   sessionId,
 *   prompt,
 *   getMessageOptionsForPhase('scan', options.modelOverride)
 * );
 *
 * // In exec
 * const response = await executor.sendMessage(
 *   sessionId,
 *   prompt,
 *   getMessageOptionsForPhase('exec', options.modelOverride)
 * );
 * ```
 */
export function getMessageOptionsForPhase(
	phase: PipelinePhase,
	modelOverride?: string,
): AutonomyMessageOptions {
	const options: AutonomyMessageOptions = {
		system: getSystemPromptForPhase(phase),
		tools: getToolsForPhase(phase),
	};

	if (modelOverride) {
		options.model = modelOverride;
	}

	return options;
}

/**
 * Merge user-provided options with autonomy defaults.
 *
 * Use this when you need to preserve other options while adding autonomy config.
 *
 * @param phase - The pipeline phase
 * @param userOptions - User-provided options (e.g., model override)
 * @returns Merged options with autonomy config
 */
export function mergeWithAutonomyConfig(
	phase: PipelinePhase,
	userOptions?: { model?: string; [key: string]: unknown },
): AutonomyMessageOptions & Record<string, unknown> {
	const autonomyOptions = getMessageOptionsForPhase(phase, userOptions?.model);

	return {
		...userOptions,
		...autonomyOptions,
	};
}
