/**
 * Milhouse Conflict Resolution Runtime
 *
 * Provides AI-assisted merge conflict resolution for Milhouse execution.
 * Uses AI engines to intelligently resolve git merge conflicts and rebase conflicts.
 *
 * Features:
 * - AI-powered conflict resolution
 * - Event emission for conflict lifecycle
 * - Pipeline-aware resolution
 * - Rebase-aware: uses correct git commands (rebase --continue vs commit)
 * - Detailed result tracking
 *
 * @module execution/runtime/conflict-resolution
 * @since 1.0.0
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AIEngine } from "../../engines/types.ts";
import { bus } from "../../events/index.ts";
import { logDebug, logError, logInfo, logWarn } from "../../ui/logger.ts";
import { runGitCommand } from "../../vcs/backends/git-cli.ts";
import {
	completeMerge,
	continueRebase,
	getConflictedFiles,
	isMergeInProgress,
	verifyMergeCompleted,
} from "../../vcs/services/merge-service.ts";
import type {
	ConflictResolutionResult,
	MergeConflict,
	MilhouseRuntimeContext,
	TokenUsage,
} from "./types.ts";
import { createEmptyTokenUsage } from "./types.ts";

/**
 * Whether the conflict arose during a merge or a rebase.
 * Determines which git commands are used to finalize resolution:
 * - 'merge': git add + git commit --no-edit
 * - 'rebase': git add + git rebase --continue
 */
export type ConflictMode = "merge" | "rebase";

/**
 * Optional issue context passed to the conflict resolver for better AI decisions
 */
export interface ConflictIssueContext {
	/** Issue ID */
	id: string;
	/** Human-readable title/description */
	title: string;
}

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
 * Read file content safely, returning null if unreadable
 */
function safeReadFile(workDir: string, filePath: string): string | null {
	try {
		const fullPath = join(workDir, filePath);
		return readFileSync(fullPath, "utf-8");
	} catch {
		return null;
	}
}

/**
 * Truncate file content if too large for prompt inclusion
 */
const MAX_FILE_CONTENT_LENGTH = 15_000;
function truncateContent(content: string): string {
	if (content.length <= MAX_FILE_CONTENT_LENGTH) return content;
	return `${content.slice(0, MAX_FILE_CONTENT_LENGTH)}\n\n... (truncated, ${content.length} chars total — read the full file to see the rest)`;
}

/**
 * Build a prompt for AI-assisted conflict resolution.
 *
 * Includes actual file contents with conflict markers so the AI
 * can resolve without needing to read files via tool calls.
 *
 * @param conflicts - Array of merge conflicts
 * @param workDir - Working directory to read files from
 * @param issueContext - Optional issue context for semantic understanding
 * @param mode - Whether this is a 'merge' or 'rebase' conflict (affects git finalization commands)
 * @returns Formatted prompt for AI
 */
export function buildConflictResolutionPrompt(
	conflicts: MergeConflict[],
	workDir?: string,
	issueContext?: ConflictIssueContext,
	mode: ConflictMode = "merge",
): string {
	const branchName = conflicts[0]?.sourceBranch ?? "unknown";
	const targetName = conflicts[0]?.targetBranch ?? "unknown";
	const isRebase = mode === "rebase";

	const parts: string[] = [];

	parts.push(`## Milhouse Conflict Resolution Task

You are resolving git ${isRebase ? "rebase" : "merge"} conflicts as part of the Milhouse pipeline.
${isRebase ? "Rebasing" : "Merging"} branch \`${branchName}\` ${isRebase ? "onto" : "into"} \`${targetName}\`.`);

	// Include issue context if available
	if (issueContext) {
		parts.push(`### Issue Context

**${issueContext.id}**: ${issueContext.title}

The incoming branch implements the fix/change described above. Preserve its intent while keeping any non-conflicting changes from the target branch.`);
	}

	parts.push(`### Conflicted Files (${conflicts.length})\n`);

	// Include file contents inline
	for (const conflict of conflicts) {
		const content = workDir ? safeReadFile(workDir, conflict.filePath) : null;

		if (content) {
			parts.push(`#### \`${conflict.filePath}\`

\`\`\`
${truncateContent(content)}
\`\`\`
`);
		} else {
			parts.push(`#### \`${conflict.filePath}\`
*(Could not read file — use \`Read\` tool to inspect it)*
`);
		}
	}

	// Finalization command depends on whether we're in merge or rebase state
	const finalizeCommand = isRebase
		? "Run `git rebase --continue` to advance the rebase"
		: "Run `git commit --no-edit` to complete the merge";

	parts.push(`### Resolution Protocol

For each conflicted file above:

1. **Understand** what both versions (between \`<<<<<<<\` and \`>>>>>>>\` markers) are trying to accomplish
2. **Resolve** by combining both changes — keep additions from BOTH sides
3. **Clean** — remove ALL conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`). The file must be valid code.
4. **Write** the resolved file using the Edit or Write tool

### After Resolving All Conflicts

1. Run \`git add\` on each resolved file to stage it
2. ${finalizeCommand}

### Important Guidelines

- Do NOT create new commits for individual file resolutions
- Ensure ALL files are resolved and staged before finalizing
- The final code should preserve functionality from BOTH branches
- Keep all imports, type definitions, and function signatures from both sides
- When in doubt, prefer the incoming changes (source branch) but preserve target modifications that don't conflict semantically
- **AUTONOMOUS MODE**: Do NOT ask questions or request clarification. Make the best decision and proceed immediately.

Begin resolution now.`);

	return parts.join("\n\n");
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
 * Resolve merge or rebase conflicts using AI.
 *
 * The `mode` parameter controls which git commands are used to finalize:
 * - 'merge' (default): uses `git add` + `git commit --no-edit`
 * - 'rebase': uses `git add` + `git rebase --continue`
 *
 * @param engine - AI engine to use
 * @param conflicts - Conflicts to resolve
 * @param workDir - Working directory
 * @param modelOverride - Optional model override
 * @param issueContext - Optional issue context for better AI decisions
 * @param mode - Whether this is a 'merge' or 'rebase' conflict (default: 'merge')
 * @returns Resolution result
 */
export async function resolveConflictsWithEngine(
	engine: AIEngine,
	conflicts: MergeConflict[],
	workDir: string,
	modelOverride?: string,
	issueContext?: ConflictIssueContext,
	mode: ConflictMode = "merge",
): Promise<ConflictResolutionResult> {
	if (conflicts.length === 0) {
		return {
			success: true,
			resolvedFiles: [],
			unresolvedFiles: [],
			tokenUsage: createEmptyTokenUsage(),
		};
	}

	const modeLabel = mode === "rebase" ? "rebase" : "merge";
	logInfo(
		`Milhouse: Attempting AI-assisted ${modeLabel} conflict resolution for ${conflicts.length} file(s)...`,
	);
	logDebug(`Conflicted files: ${conflicts.map((c) => c.filePath).join(", ")}`);
	logDebug(`Resolution mode: ${modeLabel}`);

	// Emit event for conflict resolution start
	bus.emit("git:merge:conflict", {
		source: conflicts[0]?.sourceBranch ?? "unknown",
		target: conflicts[0]?.targetBranch ?? "unknown",
		files: conflicts.map((c) => c.filePath),
	});

	const prompt = buildConflictResolutionPrompt(conflicts, workDir, issueContext, mode);
	// Conflict resolution needs ~5-10 turns: read conflicted files, edit them, git add, git commit/rebase --continue
	const engineOptions: Record<string, unknown> = {
		...(modelOverride ? { modelOverride } : {}),
		metadata: { maxTurns: 15 },
	};

	// Capture HEAD before AI execution so we can verify it advanced after merge
	let preAiHeadSha: string | undefined;
	if (mode === "merge") {
		const headResult = await runGitCommand(["rev-parse", "HEAD"], workDir);
		if (headResult.ok && headResult.value.exitCode === 0) {
			preAiHeadSha = headResult.value.stdout.trim();
		}
	}

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

			// Finalize based on mode — merge uses commit, rebase uses rebase --continue
			const conflictedFiles = conflicts.map((c) => c.filePath);

			if (mode === "rebase") {
				// For rebase: stage resolved files and continue the rebase
				const rebaseResult = await continueRebase(workDir);
				if (rebaseResult.ok && rebaseResult.value) {
					logInfo(`Milhouse: AI successfully resolved ${modeLabel} conflicts`);
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

				// continueRebase failed — AI resolved files but rebase couldn't proceed
				const rebaseError = !rebaseResult.ok
					? rebaseResult.error.message
					: "rebase --continue returned false after AI resolution";
				logWarn(`Milhouse: AI resolved files but rebase --continue failed: ${rebaseError}`);
				return {
					success: false,
					resolvedFiles: conflictedFiles,
					unresolvedFiles: [],
					tokenUsage,
					error: `Rebase continue failed: ${rebaseError}`,
				};
			}

			// For merge: stage and commit
			const completedResult = await completeMerge(workDir);
			const completed = completedResult.ok && completedResult.value;

			if (completed) {
				logInfo(`Milhouse: AI successfully resolved ${modeLabel} conflicts`);
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

			// completeMerge failed — check if the AI already completed the merge.
			// First check if merge is still in progress (quick discriminator).
			const mergeStillActive = await isMergeInProgress(workDir);
			if (mergeStillActive.ok && !mergeStillActive.value) {
				// Merge is no longer in progress. Verify it actually completed
				// rather than being aborted or interrupted.
				const verified = await verifyMergeCompleted(workDir, preAiHeadSha);
				if (verified.ok && verified.value) {
					logDebug("Merge verified complete by AI (HEAD is a merge commit that advanced)");
					return {
						success: true,
						resolvedFiles: conflictedFiles,
						unresolvedFiles: [],
						tokenUsage,
					};
				}

				// Merge not in progress but no merge commit found
				logWarn("Merge not in progress but no merge commit found — merge may have been aborted");
				return {
					success: false,
					resolvedFiles: conflictedFiles,
					unresolvedFiles: [],
					tokenUsage,
					error: "Merge not in progress but no merge commit found — merge may have been aborted",
				};
			}

			// Merge still in progress but completeMerge failed — genuine failure
			logWarn("Milhouse: AI resolved files but merge commit failed");
			return {
				success: false,
				resolvedFiles: conflictedFiles,
				unresolvedFiles: [],
				tokenUsage,
				error: "Merge commit failed after AI resolution",
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
 * @param mode - Whether this is a 'merge' or 'rebase' conflict (default: 'merge')
 * @returns Resolution result
 */
export async function resolveConflictsWithContext(
	context: MilhouseRuntimeContext,
	engine: AIEngine,
	conflicts: MergeConflict[],
	modelOverride?: string,
	mode: ConflictMode = "merge",
): Promise<ConflictResolutionResult> {
	// Emit progress event
	context.emitEvent("task:progress", {
		taskId: context.currentTaskId ?? "conflict-resolution",
		step: "resolving-conflicts",
		detail: `${conflicts.length} file(s) [${mode}]`,
	});

	const result = await resolveConflictsWithEngine(
		engine,
		conflicts,
		context.environment.workDir,
		modelOverride,
		undefined,
		mode,
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
