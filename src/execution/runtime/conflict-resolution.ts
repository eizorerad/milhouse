/**
 * Milhouse Conflict Resolution Runtime
 *
 * Provides AI-assisted merge conflict resolution for Milhouse execution.
 * Uses AI engines to intelligently resolve git merge conflicts.
 *
 * Features:
 * - AI-powered conflict resolution
 * - Event emission for conflict lifecycle
 * - Pipeline-aware resolution
 * - Detailed result tracking
 *
 * @module execution/runtime/conflict-resolution
 * @since 1.0.0
 */

import type { AIEngine } from "../../engines/types.ts";
import { bus } from "../../events/index.ts";
import { completeMerge, getConflictedFiles } from "../../vcs/services/merge-service.ts";
import { logDebug, logError, logInfo } from "../../ui/logger.ts";
import type {
	ConflictResolutionResult,
	MergeConflict,
	MilhouseRuntimeContext,
	TokenUsage,
} from "./types.ts";
import { createEmptyTokenUsage } from "./types.ts";

// ============================================================================
// Conflict Detection
// ============================================================================

/**
 * Detect merge conflicts in a working directory
 *
 * @param workDir - Working directory to check
 * @returns Array of conflicted file paths
 */
export async function detectMergeConflicts(workDir: string): Promise<string[]> {
	const result = await getConflictedFiles(workDir);
	if (!result.ok) {
		logError(`Failed to detect merge conflicts: ${result.error.message}`);
		return [];
	}
	return result.value;
}

/**
 * Create merge conflict information objects
 *
 * @param files - Conflicted file paths
 * @param sourceBranch - Source branch being merged
 * @param targetBranch - Target branch
 * @returns Array of MergeConflict objects
 */
export function createMergeConflictInfo(
	files: string[],
	sourceBranch: string,
	targetBranch: string,
): MergeConflict[] {
	return files.map((filePath) => ({
		filePath,
		sourceBranch,
		targetBranch,
		hasMarkers: true, // Assume markers present if file is conflicted
	}));
}

// ============================================================================
// Prompt Building
// ============================================================================

/**
 * Build a prompt for AI-assisted conflict resolution
 *
 * @param conflicts - Array of merge conflicts
 * @returns Formatted prompt for AI
 */
export function buildConflictResolutionPrompt(conflicts: MergeConflict[]): string {
	const fileList = conflicts.map((c) => `  - \`${c.filePath}\``).join("\n");
	const branchName = conflicts[0]?.sourceBranch ?? "unknown";

	return `## Milhouse Conflict Resolution Task

You are resolving git merge conflicts as part of the Milhouse pipeline.
The following files have conflicts after merging branch "${branchName}":

${fileList}

### Resolution Protocol

For each conflicted file:

1. **Read** the file to see the conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`)
2. **Understand** what both versions are trying to accomplish
3. **Resolve** by combining both changes appropriately
4. **Clean** - Remove ALL conflict markers (file must be valid code)
5. **Verify** - Ensure the resulting code is syntactically valid and logically correct

### After Resolving All Conflicts

1. Run \`git add\` on each resolved file to stage it
2. Run \`git commit --no-edit\` to complete the merge

### Important Guidelines

- Do NOT create new commits for individual file resolutions
- Only run \`git commit --no-edit\` once at the very end
- Ensure ALL files are resolved and staged before committing
- The final code should preserve functionality from both branches
- When in doubt, prefer the incoming changes but preserve local modifications

### Conflict Count

Total files to resolve: ${conflicts.length}

Begin resolution now.`;
}

/**
 * Build a compact prompt for simple conflicts
 *
 * @param filePath - Single conflicted file
 * @param branchName - Source branch name
 * @returns Compact prompt
 */
export function buildSimpleConflictPrompt(filePath: string, branchName: string): string {
	return `Resolve merge conflict in \`${filePath}\` from branch "${branchName}".

Steps:
1. Read the file and understand both versions
2. Edit to combine changes, removing all conflict markers
3. Run \`git add ${filePath}\` then \`git commit --no-edit\`

Ensure the result is valid code with no markers remaining.`;
}

// ============================================================================
// AI Resolution
// ============================================================================

/**
 * Resolve merge conflicts using AI
 *
 * @param engine - AI engine to use
 * @param conflicts - Conflicts to resolve
 * @param workDir - Working directory
 * @param modelOverride - Optional model override
 * @returns Resolution result
 */
export async function resolveConflictsWithEngine(
	engine: AIEngine,
	conflicts: MergeConflict[],
	workDir: string,
	modelOverride?: string,
): Promise<ConflictResolutionResult> {
	if (conflicts.length === 0) {
		return {
			success: true,
			resolvedFiles: [],
			unresolvedFiles: [],
			tokenUsage: createEmptyTokenUsage(),
		};
	}

	logInfo(
		`Milhouse: Attempting AI-assisted conflict resolution for ${conflicts.length} file(s)...`,
	);
	logDebug(`Conflicted files: ${conflicts.map((c) => c.filePath).join(", ")}`);

	// Emit event for conflict resolution start
	bus.emit("git:merge:conflict", {
		source: conflicts[0]?.sourceBranch ?? "unknown",
		target: conflicts[0]?.targetBranch ?? "unknown",
		files: conflicts.map((c) => c.filePath),
	});

	const prompt = buildConflictResolutionPrompt(conflicts);
	const engineOptions = modelOverride ? { modelOverride } : undefined;

	try {
		const result = await engine.execute(prompt, workDir, engineOptions);

		const tokenUsage: TokenUsage = {
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			totalTokens: result.inputTokens + result.outputTokens,
		};

		if (result.success) {
			// Check if AI successfully resolved all conflicts
			const remainingConflicts = await detectMergeConflicts(workDir);

			if (remainingConflicts.length > 0) {
				logError(`AI did not resolve all conflicts. Remaining: ${remainingConflicts.join(", ")}`);
				return {
					success: false,
					resolvedFiles: conflicts
						.map((c) => c.filePath)
						.filter((f) => !remainingConflicts.includes(f)),
					unresolvedFiles: remainingConflicts,
					tokenUsage,
					error: `${remainingConflicts.length} conflict(s) remain unresolved`,
				};
			}

			// Try to complete the merge (AI may have staged but not committed)
			const conflictedFiles = conflicts.map((c) => c.filePath);
			const completedResult = await completeMerge(workDir, conflictedFiles);
			const completed = completedResult.ok && completedResult.value;

			if (completed) {
				logInfo("Milhouse: AI successfully resolved merge conflicts");
				bus.emit("git:merge:complete", {
					source: conflicts[0]?.sourceBranch ?? "unknown",
					target: conflicts[0]?.targetBranch ?? "unknown",
				});
				return {
					success: true,
					resolvedFiles: conflictedFiles,
					unresolvedFiles: [],
					tokenUsage,
				};
			}

			// If completeMerge returned false but no conflicts remain,
			// the AI likely already committed
			logDebug("Merge appears to be already completed by AI");
			return {
				success: true,
				resolvedFiles: conflictedFiles,
				unresolvedFiles: [],
				tokenUsage,
			};
		}

		logError(`AI conflict resolution failed: ${result.error || "Unknown error"}`);
		return {
			success: false,
			resolvedFiles: [],
			unresolvedFiles: conflicts.map((c) => c.filePath),
			tokenUsage,
			error: result.error || "AI execution failed",
		};
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		logError(`AI conflict resolution error: ${errorMsg}`);
		return {
			success: false,
			resolvedFiles: [],
			unresolvedFiles: conflicts.map((c) => c.filePath),
			tokenUsage: createEmptyTokenUsage(),
			error: errorMsg,
		};
	}
}

/**
 * Resolve conflicts with runtime context
 *
 * @param context - Milhouse runtime context
 * @param engine - AI engine to use
 * @param conflicts - Conflicts to resolve
 * @param modelOverride - Optional model override
 * @returns Resolution result
 */
export async function resolveConflictsWithContext(
	context: MilhouseRuntimeContext,
	engine: AIEngine,
	conflicts: MergeConflict[],
	modelOverride?: string,
): Promise<ConflictResolutionResult> {
	// Emit progress event
	context.emitEvent("task:progress", {
		taskId: context.currentTaskId ?? "conflict-resolution",
		step: "resolving-conflicts",
		detail: `${conflicts.length} file(s)`,
	});

	const result = await resolveConflictsWithEngine(
		engine,
		conflicts,
		context.environment.workDir,
		modelOverride,
	);

	// Emit completion event
	if (result.success) {
		context.emitEvent("task:progress", {
			taskId: context.currentTaskId ?? "conflict-resolution",
			step: "conflicts-resolved",
			detail: `${result.resolvedFiles.length} file(s) resolved`,
		});
	} else {
		context.emitEvent("task:error", {
			taskId: context.currentTaskId ?? "conflict-resolution",
			error: new Error(result.error ?? "Conflict resolution failed"),
		});
	}

	return result;
}

// ============================================================================
// Backward Compatibility Exports
// ============================================================================

/**
 * Attempt to resolve merge conflicts using AI
 * Returns true if conflicts were successfully resolved
 *
 * @deprecated Use resolveConflictsWithEngine() instead
 */
export async function resolveConflictsWithAI(
	engine: AIEngine,
	conflictedFiles: string[],
	branchName: string,
	workDir: string,
	modelOverride?: string,
): Promise<boolean> {
	const conflicts = createMergeConflictInfo(conflictedFiles, branchName, "HEAD");
	const result = await resolveConflictsWithEngine(engine, conflicts, workDir, modelOverride);
	return result.success;
}
