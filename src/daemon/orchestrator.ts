/**
 * AI Orchestrator
 *
 * Makes a lightweight AI call to decide what the daemon should do next.
 * Returns a RunDirective. Falls back to hardcoded logic on any failure.
 */

import { buildOrchestratorPrompt } from "../agents/prompts/orchestrator.ts";
import { logWarn } from "../ui/logger.ts";
import { hardcodedDecision } from "./hardcoded-fallback.ts";
import { buildOrchestratorContext } from "./orchestrator-prompt.ts";
import { appendLog } from "./session-state.ts";
import type {
	DaemonConfig,
	DaemonStartOptions,
	DaemonState,
	RunDirective,
} from "./types.ts";
import { spawnWithWatchdog } from "./watchdog.ts";

/**
 * Call the AI orchestrator to get a RunDirective.
 *
 * On success, returns the AI's decision.
 * On any failure (parse error, timeout, budget), falls back to hardcoded logic.
 */
export async function getOrchestratorDirective(
	state: DaemonState,
	config: DaemonConfig,
	options: DaemonStartOptions,
): Promise<RunDirective> {
	const { workDir } = options;

	try {
		const context = buildOrchestratorContext(state, workDir, {
			budgetLimit: options.budget ?? config.safety.budgetLimit,
			maxRuns: options.maxRuns ?? config.safety.maxRuns,
			timeLimit: config.safety.maxSessionDuration,
		});

		const prompt = buildOrchestratorPrompt(context);

		// Use the orchestrator's configured engine to make a lightweight call.
		// We spawn the engine CLI with a simple prompt and parse the JSON response.
		const engine = config.orchestrator.engine;
		const model = config.orchestrator.model;

		const args = buildOrchestratorArgs(engine, model, prompt);

		const result = await spawnWithWatchdog(
			args,
			{
				// Short timeouts for orchestrator — it should be fast
				activityTimeout: 5,
				runTimeout: 10,
				onTimeout: "kill-and-retry",
			},
			{
				workDir,
				entryPoint: getEngineBinary(engine),
			},
		);

		if (result.exitCode !== 0) {
			throw new Error(`Orchestrator engine exited with code ${result.exitCode}`);
		}

		const directive = parseDirective(result.stdout);

		appendLog(workDir, "orchestrator:decision", {
			action: directive.action,
			reasoning: directive.reasoning,
			engine,
			model,
		});

		return directive;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logWarn(`Orchestrator failed: ${msg} — using fallback logic`);

		appendLog(workDir, "orchestrator:error", { error: msg });

		return hardcodedDecision(state, workDir, options.minSeverity);
	}
}

/**
 * Parse the orchestrator's JSON response into a RunDirective.
 * Handles common AI output quirks (markdown fences, extra text).
 */
function parseDirective(raw: string): RunDirective {
	// Strip markdown code fences if present
	let json = raw.trim();

	const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenceMatch) {
		json = fenceMatch[1].trim();
	}

	// Try to find JSON object in the output
	const objectMatch = json.match(/\{[\s\S]*\}/);
	if (!objectMatch) {
		throw new Error("No JSON object found in orchestrator response");
	}

	const parsed = JSON.parse(objectMatch[0]);

	// Validate required fields
	if (!parsed.action || !["run", "stop"].includes(parsed.action)) {
		throw new Error(`Invalid action: ${parsed.action}`);
	}
	if (!parsed.reasoning || typeof parsed.reasoning !== "string") {
		throw new Error("Missing reasoning field");
	}

	return {
		action: parsed.action,
		reasoning: parsed.reasoning,
		scope: parsed.scope ?? undefined,
		strategy: parsed.strategy ?? undefined,
		phases: parsed.phases ?? undefined,
		startPhase: parsed.startPhase ?? undefined,
		resume: parsed.resume ?? undefined,
		runId: parsed.runId ?? undefined,
		minSeverity: parsed.minSeverity ?? undefined,
		issueIds: parsed.issueIds ?? undefined,
		excludeIssueIds: parsed.excludeIssueIds ?? undefined,
		stopReason: parsed.stopReason ?? undefined,
		summary: parsed.summary ?? undefined,
	};
}

/**
 * Build CLI args for the orchestrator's engine call.
 * This is NOT a milhouse call — it's a direct call to claude/gemini/etc.
 */
function buildOrchestratorArgs(
	engine: string,
	model: string,
	prompt: string,
): string[] {
	switch (engine) {
		case "claude":
			return [
				"-p", prompt,
				"--model", model,
				"--output-format", "text",
				"--dangerously-skip-permissions",
			];

		case "gemini":
			return [
				"-p", prompt,
				"--model", model,
			];

		default:
			// Generic: assume the CLI accepts -p for prompt
			return [
				"-p", prompt,
				"--model", model,
			];
	}
}

/**
 * Get the binary name for the orchestrator engine.
 */
function getEngineBinary(engine: string): string {
	switch (engine) {
		case "claude":
			return "claude";
		case "gemini":
			return "gemini";
		case "aider":
			return "aider";
		case "opencode":
			return "opencode";
		default:
			return engine;
	}
}
