/**
 * Milhouse Conflict Resolution Runtime
 *
 * Provides AI-assisted merge conflict resolution for Milhouse execution.
 * Uses AI engines to intelligently resolve git merge conflicts and rebase conflicts.
 *
 * Features:
 * - AI-powered conflict resolution
 * - **Auto-detection** of git state (merge vs rebase) — no hardcoding required
 * - Event emission for conflict lifecycle
 * - Pipeline-aware resolution
 * - Smart prompt that tells the AI to verify git state before finalization
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
	isRebaseInProgress,
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
 * - 'auto': queries git state at runtime to determine the correct mode automatically
 *
 * Default is 'auto' — callers should prefer this to avoid bugs from wrong mode.
 */
export type ConflictMode = "merge" | "rebase" | "auto";

/**
 * Resolved conflict mode — guaranteed to be 'merge' or 'rebase' (never 'auto').
 */
type ResolvedConflictMode = "merge" | "rebase";

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
// Git State Detection
// ============================================================================

/**
 * Auto-detect the current git conflict state by querying git.
 *
 * Checks REBASE_HEAD first (more specific), then MERGE_HEAD.
 * This eliminates the need for callers to manually specify the mode,
 * preventing bugs where the wrong mode is passed.
 *
 * @param workDir - Working directory to check
 * @returns 'rebase' if a rebase is in progress, 'merge' otherwise
 */
export async function detectConflictMode(workDir: string): Promise<ResolvedConflictMode> {
	// Check rebase first — it's the more specific state
	const rebaseResult = await isRebaseInProgress(workDir);
	if (rebaseResult.ok && rebaseResult.value) {
		logDebug("detectConflictMode: REBASE_HEAD detected — using rebase mode");
		return "rebase";
	}

	// Check merge state
	const mergeResult = await isMergeInProgress(workDir);
	if (mergeResult.ok && mergeResult.value) {
		logDebug("detectConflictMode: MERGE_HEAD detected — using merge mode");
		return "merge";
	}

	// Neither detected — default to merge (safest fallback)
	logDebug("detectConflictMode: no active rebase or merge detected — defaulting to merge");
	return "merge";
}

/**
 * Resolve 'auto' mode to a concrete mode by querying git state.
 * If mode is already 'merge' or 'rebase', returns it unchanged.
 *
 * @param mode - Input conflict mode (may be 'auto')
 * @param workDir - Working directory to check git state
 * @returns Resolved mode ('merge' or 'rebase')
 */
async function resolveMode(mode: ConflictMode, workDir: string): Promise<ResolvedConflictMode> {
	if (mode === "merge" || mode === "rebase") return mode;
	return detectConflictMode(workDir);
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
 * The prompt is **git-state-adaptive**: it tells the AI which mode we detected
 * AND instructs the AI to verify the git state before running finalization
 * commands, so even if detection was wrong, the AI can self-correct.
 *
 * @param conflicts - Array of merge conflicts
 * @param workDir - Working directory to read files from
 * @param issueContext - Optional issue context for semantic understanding
 * @param mode - Resolved conflict mode ('merge' or 'rebase') — should NOT be 'auto' at this point
 * @returns Formatted prompt for AI
 */
export function buildConflictResolutionPrompt(
	conflicts: MergeConflict[],
	workDir?: string,
	issueContext?: ConflictIssueContext,
	mode: ResolvedConflictMode | ConflictMode = "merge",
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

	// Adaptive finalization instructions that tell the AI to verify state
	parts.push(`### Resolution Protocol

For each conflicted file above:

1. **Understand** what both versions (between \`<<<<<<<\` and \`>>>>>>>\` markers) are trying to accomplish
2. **Resolve** by combining both changes — keep additions from BOTH sides
3. **Clean** — remove ALL conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`). The file must be valid code.
4. **Write** the resolved file using the Edit or Write tool

### After Resolving All Conflicts

1. Run \`git add\` on each resolved file to stage it
2. **Detect git state and finalize correctly:**
   - Run \`git rev-parse --verify REBASE_HEAD 2>/dev/null\` to check if a rebase is active
   - **If rebase is active** (command succeeds): run \`git rebase --continue\` to advance the rebase
   - **If rebase is NOT active** (command fails): run \`git commit --no-edit\` to complete the merge
   - **CRITICAL:** Using the wrong command will corrupt git state. ${isRebase ? "We detected a **rebase** in progress." : "We detected a **merge** in progress."}

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
3. Run \`git add ${filePath}\`
4. Detect git state: run \`git rev-parse --verify REBASE_HEAD 2>/dev/null\`
   - If exit 0 (rebase active): run \`git rebase --continue\`
   - If exit non-0 (merge): run \`git commit --no-edit\`

Ensure the result is valid code with no markers remaining.`;
}

// ============================================================================
// AI Resolution
// ============================================================================

/**
 * Resolve merge or rebase conflicts using AI.
 *
 * The `mode` parameter controls which git commands are used to finalize.
 * **Default is 'auto'** — the function queries git state (REBASE_HEAD /
 * MERGE_HEAD) to determine the correct mode automatically. This eliminates
 * the class of bugs where callers pass the wrong mode.
 *
 * Explicit modes ('merge' / 'rebase') are still supported for cases where
 * the caller has authoritative knowledge of the git state.
 *
 * @param engine - AI engine to use
 * @param conflicts - Conflicts to resolve
 * @param workDir - Working directory
 * @param modelOverride - Optional model override
 * @param issueContext - Optional issue context for better AI decisions
 * @param mode - Conflict mode: 'auto' (default), 'merge', or 'rebase'
 * @returns Resolution result
 */
export async function resolveConflictsWithEngine(
	engine: AIEngine,
	conflicts: MergeConflict[],
	workDir: string,
	modelOverride?: string,
	issueContext?: ConflictIssueContext,
	mode: ConflictMode = "auto",
): Promise<ConflictResolutionResult> {
	if (conflicts.length === 0) {
		return {
			success: true,
			resolvedFiles: [],
			unresolvedFiles: [],
			tokenUsage: createEmptyTokenUsage(),
		};
	}

	// Resolve 'auto' to concrete mode by querying git state
	const resolvedMode = await resolveMode(mode, workDir);
	const modeLabel = resolvedMode === "rebase" ? "rebase" : "merge";

	if (mode === "auto") {
		logInfo(`Milhouse: Auto-detected git state: ${modeLabel}`);
	}

	logInfo(
		`Milhouse: Attempting AI-assisted ${modeLabel} conflict resolution for ${conflicts.length} file(s)...`,
	);
	logDebug(`Conflicted files: ${conflicts.map((c) => c.filePath).join(", ")}`);
	logDebug(`Resolution mode: ${modeLabel} (requested: ${mode})`);

	// Emit event for conflict resolution start
	bus.emit("git:merge:conflict", {
		source: conflicts[0]?.sourceBranch ?? "unknown",
		target: conflicts[0]?.targetBranch ?? "unknown",
		files: conflicts.map((c) => c.filePath),
	});

	const prompt = buildConflictResolutionPrompt(conflicts, workDir, issueContext, resolvedMode);
	// Conflict resolution needs ~5-10 turns: read conflicted files, edit them, git add, git commit/rebase --continue
	const engineOptions: Record<string, unknown> = {
		...(modelOverride ? { modelOverride } : {}),
		metadata: { maxTurns: 15 },
	};

	// Capture HEAD before AI execution so we can verify it advanced after merge
	let preAiHeadSha: string | undefined;
	if (resolvedMode === "merge") {
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

			// Re-detect git state AFTER AI execution — the AI may have already
			// run git commit / rebase --continue, changing the state.
			const postAiMode = await detectConflictMode(workDir);
			const conflictedFiles = conflicts.map((c) => c.filePath);

			// If neither rebase nor merge is active anymore, the AI likely
			// already finalized. Verify via merge commit or rebase completion.
			const rebaseActive = await isRebaseInProgress(workDir);
			const mergeActive = await isMergeInProgress(workDir);
			const isRebaseStillActive = rebaseActive.ok && rebaseActive.value;
			const isMergeStillActive = mergeActive.ok && mergeActive.value;

			if (!isRebaseStillActive && !isMergeStillActive) {
				// AI already finalized — verify the result
				if (resolvedMode === "merge") {
					const verified = await verifyMergeCompleted(workDir, preAiHeadSha);
					if (verified.ok && verified.value) {
						logDebug("AI already completed the merge (verified via merge commit)");
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
					// No merge commit found — AI may have aborted
					logWarn("Neither merge nor rebase active, but no merge commit — AI may have aborted");
					return {
						success: false,
						resolvedFiles: conflictedFiles,
						unresolvedFiles: [],
						tokenUsage,
						error: "Merge not in progress but no merge commit found — merge may have been aborted",
					};
				}

				// For rebase: if no rebase is active, AI completed it
				logDebug("AI already completed the rebase (no REBASE_HEAD found)");
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

			// Git operation still in progress — finalize it ourselves
			if (isRebaseStillActive) {
				const rebaseResult = await continueRebase(workDir);
				if (rebaseResult.ok && rebaseResult.value) {
					logInfo(`Milhouse: AI resolved conflicts, rebase finalized`);
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

			if (isMergeStillActive) {
				const completedResult = await completeMerge(workDir);
				const completed = completedResult.ok && completedResult.value;

				if (completed) {
					logInfo(`Milhouse: AI resolved conflicts, merge finalized`);
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

				logWarn("Milhouse: AI resolved files but merge commit failed");
				return {
					success: false,
					resolvedFiles: conflictedFiles,
					unresolvedFiles: [],
					tokenUsage,
					error: "Merge commit failed after AI resolution",
				};
			}
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
 * @param mode - Conflict mode: 'auto' (default), 'merge', or 'rebase'
 * @returns Resolution result
 */
export async function resolveConflictsWithContext(
	context: MilhouseRuntimeContext,
	engine: AIEngine,
	conflicts: MergeConflict[],
	modelOverride?: string,
	mode: ConflictMode = "auto",
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
