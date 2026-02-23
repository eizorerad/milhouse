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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AIEngine } from "../../engines/types.ts";
import { bus } from "../../events/index.ts";
import { logDebug, logError, logInfo, logWarn } from "../../ui/logger.ts";
import { completeMerge, getConflictedFiles } from "../../vcs/services/merge-service.ts";
import type {
	ConflictResolutionResult,
	MergeConflict,
	MilhouseRuntimeContext,
	TokenUsage,
} from "./types.ts";
import { createEmptyTokenUsage } from "./types.ts";

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
 * @returns Formatted prompt for AI
 */
export function buildConflictResolutionPrompt(
	conflicts: MergeConflict[],
	workDir?: string,
	issueContext?: ConflictIssueContext,
): string {
	const branchName = conflicts[0]?.sourceBranch ?? "unknown";
	const targetName = conflicts[0]?.targetBranch ?? "unknown";

	const parts: string[] = [];

	parts.push(`## Milhouse Conflict Resolution Task

You are resolving git merge conflicts as part of the Milhouse pipeline.
Merging branch \`${branchName}\` into \`${targetName}\`.`);

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

	parts.push(`### Resolution Protocol

For each conflicted file above:

1. **Understand** what both versions (between \`<<<<<<<\` and \`>>>>>>>\` markers) are trying to accomplish
2. **Resolve** by combining both changes — keep additions from BOTH sides
3. **Clean** — remove ALL conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`). The file must be valid code.
4. **Write** the resolved file using the Edit or Write tool

### After Resolving All Conflicts

1. Run \`git add\` on each resolved file to stage it
2. Run \`git commit --no-edit\` to complete the merge

### Important Guidelines

- Do NOT create new commits for individual file resolutions
- Only run \`git commit --no-edit\` once at the very end
- Ensure ALL files are resolved and staged before committing
- The final code should preserve functionality from BOTH branches
- Keep all imports, type definitions, and function signatures from both sides
- When in doubt, prefer the incoming changes (source branch) but preserve target modifications that don't conflict semantically

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
 * Resolve merge conflicts using AI
 *
 * @param engine - AI engine to use
 * @param conflicts - Conflicts to resolve
 * @param workDir - Working directory
 * @param modelOverride - Optional model override
 * @param issueContext - Optional issue context for better AI decisions
 * @returns Resolution result
 */
export async function resolveConflictsWithEngine(
	engine: AIEngine,
	conflicts: MergeConflict[],
	workDir: string,
	modelOverride?: string,
	issueContext?: ConflictIssueContext,
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

	const prompt = buildConflictResolutionPrompt(conflicts, workDir, issueContext);
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
