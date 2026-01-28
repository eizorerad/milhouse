/**
 * Legacy Execution Runtime Exports
 *
 * This module re-exports deprecated functions for backward compatibility.
 * All exports are deprecated and should be migrated to modern APIs.
 *
 * @deprecated Use modern APIs from '../index.ts' instead
 * @module execution/runtime/_legacy
 * @since 1.0.0
 */

// Retry deprecated exports - now available from main retry.ts
export {
	withRetry,
	withRetryAndFollowUp,
	type RetryWithFollowUpOptions,
	type RetryWithFollowUpResult,
	type FollowUpTaskConfig,
	sleep,
	createFollowUpTask,
} from "../retry.ts";

/**
 * Legacy retry options interface
 * @deprecated Use MilhouseRetryConfig instead
 */
export interface LegacyRetryOptions {
	maxRetries: number;
	retryDelay: number;
	onRetry?: (attempt: number, error: string) => void;
}

// Prompt deprecated exports - now available from main prompt.ts
export {
	buildPrompt,
	buildParallelPrompt,
} from "../prompt.ts";

/**
 * Legacy prompt options interface
 * @deprecated Use MilhousePromptOptions instead
 */
export interface LegacyPromptOptions {
	task: string;
	autoCommit?: boolean;
	workDir?: string;
	browserEnabled?: "auto" | "true" | "false";
	skipTests?: boolean;
	skipLint?: boolean;
}

/**
 * Legacy parallel prompt options interface
 * @deprecated Use ParallelPromptOptions instead
 */
export interface LegacyParallelPromptOptions {
	task: string;
	progressFile: string;
	skipTests?: boolean;
	skipLint?: boolean;
	browserEnabled?: "auto" | "true" | "false";
}

// Browser deprecated exports - now available from main browser.ts
export {
	isBrowserAvailable,
	isAgentBrowserInstalled,
	getBrowserInstructions,
} from "../browser.ts";

// Conflict resolution deprecated exports - now available from main conflict-resolution.ts
export { resolveConflictsWithAI } from "../conflict-resolution.ts";
