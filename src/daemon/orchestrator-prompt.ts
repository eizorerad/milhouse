/**
 * Orchestrator context builder
 *
 * Collects context from specs, run reports, and session state
 * to build the input for the orchestrator agent prompt.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { OrchestratorPromptContext } from "../agents/prompts/orchestrator.ts";
import { loadRunsIndex } from "../state/runs.ts";
import type { DaemonState } from "./types.ts";

const MAX_SPEC_CHARS = 8000; // Cap spec content to keep prompt manageable

/**
 * Build the orchestrator prompt context from session state and filesystem.
 */
export function buildOrchestratorContext(
	state: DaemonState,
	workDir: string,
	options: {
		budgetLimit: number;
		maxRuns: number;
		timeLimit: string;
		availableEngines?: string[];
	},
): OrchestratorPromptContext {
	const now = Date.now();
	const sessionStart = new Date(state.startedAt).getTime();
	const elapsed = formatDuration(now - sessionStart);

	// Load spec documents if inputPath is set
	const specContents = state.inputPath
		? loadSpecContents(state.inputPath, workDir)
		: "";

	// Find last incomplete run
	const index = loadRunsIndex(workDir);
	const incompletePhases = new Set(["scan", "validate", "plan", "consolidate", "exec", "verify"]);
	const lastIncomplete = [...index.runs]
		.reverse()
		.find((r) => incompletePhases.has(r.phase));

	return {
		userScope: state.scope,
		specContents,
		completedRuns: state.totalRuns,
		maxRuns: options.maxRuns,
		budgetSpent: state.totalCost,
		budgetLimit: options.budgetLimit,
		elapsedTime: elapsed,
		timeLimit: options.timeLimit,
		consecutiveFailures: state.consecutiveFailures,
		runHistory: state.runs,
		previousDecisions: state.orchestratorDecisions,
		availableEngines: options.availableEngines ?? ["claude", "gemini", "aider"],
		lastIncompleteRunId: lastIncomplete?.id,
		lastIncompletePhase: lastIncomplete?.phase,
	};
}

/**
 * Load and concatenate spec/PRD documents from a file or directory.
 * Truncates total content to MAX_SPEC_CHARS.
 */
function loadSpecContents(inputPath: string, workDir: string): string {
	const fullPath = inputPath.startsWith("/") || inputPath.includes(":")
		? inputPath
		: join(workDir, inputPath);

	if (!existsSync(fullPath)) return "";

	const stat = statSync(fullPath);
	const chunks: string[] = [];
	let totalLen = 0;

	if (stat.isFile()) {
		const content = safeRead(fullPath);
		if (content) {
			chunks.push(`### ${inputPath}\n${content}`);
		}
	} else if (stat.isDirectory()) {
		const files = readdirSync(fullPath)
			.filter((f) => f.endsWith(".md") || f.endsWith(".txt") || f.endsWith(".yaml") || f.endsWith(".yml"))
			.sort();

		for (const file of files) {
			if (totalLen >= MAX_SPEC_CHARS) {
				chunks.push(`\n... (${files.length - chunks.length} more files truncated)`);
				break;
			}

			const content = safeRead(join(fullPath, file));
			if (content) {
				const remaining = MAX_SPEC_CHARS - totalLen;
				const truncated =
					content.length > remaining
						? `${content.slice(0, remaining)}\n... (truncated)`
						: content;
				chunks.push(`### ${file}\n${truncated}`);
				totalLen += truncated.length;
			}
		}
	}

	const result = chunks.join("\n\n");
	return result.length > MAX_SPEC_CHARS
		? `${result.slice(0, MAX_SPEC_CHARS)}\n... (truncated)`
		: result;
}

function safeRead(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

function formatDuration(ms: number): string {
	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.floor((ms % 3_600_000) / 60_000);

	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}
