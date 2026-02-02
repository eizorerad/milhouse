import pc from "picocolors";
import type { RuntimeOptions } from "../../config/index.ts";
import { getConfigService } from "../../services/config/ConfigService.ts";
import { createEngine, getPlugin } from "../../engines/index.ts";
import type { AIEngineName, AIResult } from "../../engines/types.ts";
import {
	OpencodeServerExecutor,
	PortManager,
	displayTmuxModeHeader,
	displayAttachInstructions,
	displayTmuxCompletionSummary,
	getMessageOptionsForPhase,
	type ServerInfo,
} from "../../engines/opencode/index.ts";
import { TmuxSessionManager, ensureTmuxInstalled, getInstallationInstructions } from "../../engines/tmux/index.ts";
import { saveIssuesForRun } from "../../state/issues.ts";
import {
	syncLegacyPlansView,
	writeProblemBriefForRun,
} from "../../state/plan-store.ts";
import { initializeDir } from "../../state/manager.ts";
import {
	createRun,
	updateRunPhaseInMeta,
	updateRunStats,
} from "../../state/runs.ts";
import { AGENT_ROLES, type Issue, type Severity } from "../../state/types.ts";
import {
	formatDuration,
	formatTokens,
	logDebug,
	logError,
	logInfo,
	logSuccess,
	logWarn,
	setVerbose,
} from "../../ui/logger.ts";
import { ProgressSpinner } from "../../ui/spinners.ts";
import { extractJsonFromResponse } from "../../utils/json-extractor.ts";

/**
 * Result of scanning for issues
 */
interface ScanResult {
	success: boolean;
	issuesFound: number;
	inputTokens: number;
	outputTokens: number;
	problemBriefPath?: string;
	error?: string;
	/** The run ID created by this scan - used by pipeline to ensure subsequent phases use the same run */
	runId?: string;
}

/**
 * Parsed issue from AI response
 */
interface ParsedIssue {
	symptom: string;
	hypothesis: string;
	severity: Severity;
	frequency?: string;
	blast_radius?: string;
	strategy?: string;
}

/**
 * Build the Lead Investigator prompt
 */
function buildLeadInvestigatorPrompt(workDir: string, scanFocus?: string): string {
	const parts: string[] = [];

	// Role definition
	parts.push(`## Role: Lead Investigator (LI)
${AGENT_ROLES.LI}

You are scanning this repository to identify potential problems, issues, or technical debt.`);

	// Add scan focus if specified
	if (scanFocus) {
		parts.push(`## SCAN FOCUS

**IMPORTANT**: Focus your investigation specifically on: ${scanFocus}

Limit your scan to issues related to this area. Do not report issues outside of this scope unless they directly impact the focused area.`);
	}

	// Add project context if available
	const configService = getConfigService(workDir);
	const config = configService.getConfig();
	
	if (config) {
		const contextParts: string[] = [];
		if (config.project.name) contextParts.push(`Project: ${config.project.name}`);
		if (config.project.language) contextParts.push(`Language: ${config.project.language}`);
		if (config.project.framework) contextParts.push(`Framework: ${config.project.framework}`);
		if (config.project.description) contextParts.push(`Description: ${config.project.description}`);
		
		if (contextParts.length > 0) {
			parts.push(`## Project Context
${contextParts.join("\n")}`);
		}
	}

	// Add config info if available
	if (config) {
		if (config.commands.test) {
			parts.push(`Test command: ${config.commands.test}`);
		}
		if (config.commands.lint) {
			parts.push(`Lint command: ${config.commands.lint}`);
		}
		if (config.commands.build) {
			parts.push(`Build command: ${config.commands.build}`);
		}
	}

	// Task instructions
	parts.push(`## Task

**IMPORTANT**: This is a THOROUGH code investigation. You must actively READ and analyze the code.

Scan the repository and identify candidate problems. For each issue found, provide:

1. **Symptom**: What observable behavior indicates a problem?
2. **Hypothesis**: What is the likely root cause?
3. **Severity**: CRITICAL | HIGH | MEDIUM | LOW
4. **Frequency**: How often does this occur? (optional)
5. **Blast Radius**: What is affected if this fails? (optional)
6. **Strategy**: Suggested fix approach (optional)

## Investigation Protocol

You MUST actively investigate the codebase:
1. **Read source files** - don't just scan file names, read the actual code
2. **Trace data flow** - follow how data moves through the application
3. **Check error handling** - look for missing try/catch, unhandled errors
4. **Examine async code** - look for race conditions, missing awaits
5. **Review state management** - check for proper updates and data consistency
6. **Look at API boundaries** - network calls, database queries, external services
7. **Check security** - authentication, authorization, input validation
8. **Find dead code** - unused functions, unreachable branches

## What to Look For (language-agnostic)

- **Logic Errors**: Incorrect conditions, wrong comparisons, off-by-one errors
- **Error Handling**: Silent failures, missing error propagation, uncaught exceptions
- **Concurrency Issues**: Race conditions, deadlocks, missing synchronization
- **Resource Leaks**: Unclosed connections, missing cleanup, memory leaks
- **Security Issues**: Input validation, authentication bypass, data exposure
- **Data Integrity**: Missing validation, inconsistent state, lost updates
- **Architecture Issues**: Tight coupling, circular dependencies, code duplication
- **Configuration Issues**: Hardcoded values, missing environment handling

## Output Format

Respond with a JSON array of issues in this exact format:

\`\`\`json
[
	 {
	   "symptom": "Description of the observable problem",
	   "hypothesis": "Root cause analysis",
	   "severity": "HIGH",
	   "frequency": "On every page load",
	   "blast_radius": "All user sessions",
	   "strategy": "Implement connection pooling"
	 }
]
\`\`\`

## Guidelines

- **Be thorough** - examine actual code, not just file names
- Focus on real, actionable issues (bugs, technical debt, security concerns, performance problems)
- Do NOT report style preferences or minor nitpicks
- Each issue should be independently fixable
- **Be specific** about file locations when possible
- Prioritize issues that block functionality or affect users

**NOTE**: An empty result \`[]\` should only be returned after thorough examination. Most real-world codebases have issues.

## Important

- Status of all issues will be UNVALIDATED (they need probe validation later)
- Do NOT make claims without evidence - you must have seen the problematic code
- **READ THE ACTUAL CODE** before reporting an issue`);

	return parts.join("\n\n");
}

/**
 * Parse issues from AI response
 */
function parseIssuesFromResponse(response: string): ParsedIssue[] {
	// Extract JSON from response using robust multi-strategy extraction
	const jsonStr = extractJsonFromResponse(response);
	if (!jsonStr) {
		logDebug("Failed to extract JSON from scan response");
		return [];
	}

	try {
		const parsed = JSON.parse(jsonStr);

		if (!Array.isArray(parsed)) {
			logWarn("AI response is not an array, wrapping in array");
			return [parsed].filter(isValidParsedIssue);
		}

		return parsed.filter(isValidParsedIssue);
	} catch (error) {
		logDebug("Failed to parse JSON response:", error);

		// Try to find JSON array in the response
		const arrayMatch = response.match(/\[\s*\{[\s\S]*?\}\s*\]/);
		if (arrayMatch) {
			try {
				const parsed = JSON.parse(arrayMatch[0]);
				return parsed.filter(isValidParsedIssue);
			} catch {
				// Fall through
			}
		}

		return [];
	}
}

/**
 * Validate parsed issue has required fields
 */
function isValidParsedIssue(issue: unknown): issue is ParsedIssue {
	if (typeof issue !== "object" || issue === null) {
		return false;
	}

	const obj = issue as Record<string, unknown>;

	if (typeof obj.symptom !== "string" || obj.symptom.trim() === "") {
		return false;
	}

	if (typeof obj.hypothesis !== "string" || obj.hypothesis.trim() === "") {
		return false;
	}

	const validSeverities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
	if (typeof obj.severity !== "string" || !validSeverities.includes(obj.severity)) {
		// Default to MEDIUM if invalid
		obj.severity = "MEDIUM";
	}

	return true;
}

/**
 * Generate Problem Brief markdown
 */
function generateProblemBrief(issues: Issue[], runId: string): string {
	const timestamp = new Date().toISOString();
	const parts: string[] = [];

	parts.push(`# Problem Brief v0

> **Status**: UNVALIDATED
> **Run ID**: ${runId}
> **Generated**: ${timestamp}
> **Issues Found**: ${issues.length}

---

## Overview

This Problem Brief was generated by the Lead Investigator (LI) agent during the initial scan phase.
All issues are currently **UNVALIDATED** and require probe validation before planning.

---

## Issues
`);

	if (issues.length === 0) {
		parts.push("No significant issues were identified during the scan.\n");
	} else {
		for (const issue of issues) {
			parts.push(`### ${issue.id}: ${issue.symptom}

| Field | Value |
|-------|-------|
| **Status** | ${issue.status} |
| **Severity** | ${issue.severity} |
| **Hypothesis** | ${issue.hypothesis} |
${issue.frequency ? `| **Frequency** | ${issue.frequency} |` : ""}
${issue.blast_radius ? `| **Blast Radius** | ${issue.blast_radius} |` : ""}
${issue.strategy ? `| **Strategy** | ${issue.strategy} |` : ""}
| **Created** | ${issue.created_at} |

---
`);
		}
	}

	parts.push(`## Next Steps

1. Run \`milhouse validate\` to validate each issue with probes
2. Issues will be marked as CONFIRMED, FALSE, PARTIAL, or MISDIAGNOSED
3. Run \`milhouse plan\` to generate WBS for confirmed issues
`);

	return parts.join("\n");
}

/**
 * Run the scan command - Lead Investigator agent
 *
 * Creates Problem Brief v0 (UNVALIDATED) by scanning the repository
 * for potential issues and technical debt.
 *
 * IMPORTANT: Each scan creates a NEW run with isolated state.
 */
export async function runScan(options: RuntimeOptions): Promise<ScanResult> {
	const workDir = process.cwd();
	const startTime = Date.now();

	// Set verbose mode
	setVerbose(options.verbose);

	// Initialize milhouse directory if needed
	initializeDir(workDir);

	// Create a NEW run for this scan
	// This is the key change - each scan creates isolated state
	const runMeta = createRun({
		scope: options.scanFocus,
		workDir,
	});

	logInfo(`Created new run: ${pc.cyan(runMeta.id)}`);
	if (options.scanFocus) {
		logInfo(`Scope: ${pc.dim(options.scanFocus)}`);
	}

	// Update phase to scanning
	updateRunPhaseInMeta(runMeta.id, "scan", workDir);

	// Check engine availability
	const engine = await createEngine(options.aiEngine as AIEngineName);
	let available = false;
	try {
		const plugin = getPlugin(options.aiEngine as AIEngineName);
		available = await plugin.isAvailable();
	} catch {
		available = false;
	}

	if (!available) {
		logError(`${engine.name} CLI not found. Make sure '${engine.cliCommand}' is in your PATH.`);
		return {
			success: false,
			issuesFound: 0,
			inputTokens: 0,
			outputTokens: 0,
			error: `${engine.name} not available`,
			runId: runMeta.id,
		};
	}

	logInfo(`Starting scan with ${engine.name} (engine: ${options.aiEngine})`);
	logInfo(`Role: ${AGENT_ROLES.LI}`);
	if (options.scanFocus) {
		logInfo(`Focus: ${options.scanFocus}`);
	}

	// ============================================================================
	// TMUX MODE CHECK: Validate tmux mode requirements
	// ============================================================================
	let tmuxManager: TmuxSessionManager | null = null;
	let tmuxEnabled = false;
	let opencodeExecutor: OpencodeServerExecutor | null = null;

	if (options.tmux) {
		// Check if using OpenCode engine (tmux mode only works with OpenCode)
		if (options.aiEngine !== "opencode") {
			logWarn("Tmux mode is only supported with --opencode engine. Falling back to standard execution.");
		} else {
			// Try to ensure tmux is installed (with auto-install if possible)
			const tmuxResult = await ensureTmuxInstalled({ autoInstall: true, verbose: true });
			
			if (!tmuxResult.installed) {
				// Installation failed or not possible (e.g., Windows)
				logWarn("tmux is not available and could not be installed automatically.");
				if (tmuxResult.error) {
					logInfo(tmuxResult.error);
				}
				logInfo("Falling back to standard execution.");
				logInfo("");
				logInfo(getInstallationInstructions());
			} else {
				// tmux is available (either was already installed or just installed)
				if (tmuxResult.installedNow) {
					logSuccess(`tmux ${tmuxResult.version ?? "unknown"} was installed successfully via ${tmuxResult.method}`);
				} else {
					logDebug(`tmux ${tmuxResult.version ?? "unknown"} is already installed`);
				}
				
				// Initialize tmux manager
				tmuxManager = new TmuxSessionManager({
					sessionPrefix: "milhouse",
					verbose: options.verbose,
				});
				tmuxEnabled = true;
				logInfo("Tmux mode enabled - OpenCode server will be started with TUI attachment");
			}
		}
	}

	console.log("");

	// Build the Lead Investigator prompt
	const prompt = buildLeadInvestigatorPrompt(workDir, options.scanFocus);
	logDebug("Prompt built:", `${prompt.slice(0, 200)}...`);

	// Create progress spinner
	const spinner = new ProgressSpinner("Scanning repository", ["LI"]);

	// Execute the scan
	let result: AIResult;
	try {
		// ============================================================================
		// EXECUTION: Choose between tmux mode and standard mode
		// ============================================================================
		if (tmuxEnabled && tmuxManager) {
			// TMUX MODE: Use OpenCode server with tmux session
			logDebug("Executing scan in tmux mode");
			spinner.updateStep("Starting OpenCode server");

			opencodeExecutor = new OpencodeServerExecutor({
				autoInstall: options.autoInstall ?? true,
				verbose: options.verbose,
			});

			// Start the OpenCode server
			const port = await opencodeExecutor.startServer(workDir);
			const url = `http://localhost:${port}`;

			// Create the session FIRST via the API so we have the session ID
			const session = await opencodeExecutor.createSession({
				title: `Milhouse Scan: ${runMeta.id}`,
			});

			// Create tmux session with opencode attach, including the session ID
			const tmuxSessionBaseName = `scan-${runMeta.id.slice(0, 8)}`;
			const sessionName = tmuxManager.buildSessionName(tmuxSessionBaseName);
			const attachCmd = `opencode attach ${url} -s ${session.id}`;

			// Kill existing session if it exists (handles retry case)
			await tmuxManager.killSessionIfExists(tmuxSessionBaseName);

			const tmuxResult = await tmuxManager.createSession({
				name: tmuxSessionBaseName,
				command: attachCmd,
				workDir,
			});

			if (!tmuxResult.success) {
				logWarn(`Failed to create tmux session: ${tmuxResult.error}`);
			}

			// Display tmux mode header and attach instructions
			displayTmuxModeHeader();
			const serverInfo: ServerInfo = {
				issueId: `scan-${runMeta.id.slice(0, 8)}`,
				port,
				sessionName,
				status: "running",
				url,
			};
			displayAttachInstructions([serverInfo]);
			console.log("");

			spinner.updateStep("Executing scan via OpenCode server");

			// Send the prompt and wait for completion
			// Use autonomy config to prevent questions and restrict to read-only tools
			const response = await opencodeExecutor.sendMessage(
				session.id,
				prompt,
				getMessageOptionsForPhase("scan", options.modelOverride)
			);

			// Calculate tokens from response
			const inputTokens = response.info.inputTokens ?? 0;
			const outputTokens = response.info.outputTokens ?? 0;

			// Extract text from response parts
			const responseText = response.parts
				.filter((p) => p.type === "text")
				.map((p) => (p as { type: "text"; text: string }).text)
				.join("");

			result = {
				success: true,
				response: responseText,
				inputTokens,
				outputTokens,
			};

			// Display completion summary
			const completedServerInfo: ServerInfo = {
				...serverInfo,
				status: "completed",
			};
			displayTmuxCompletionSummary([completedServerInfo]);

			// Cleanup: Stop the server but keep tmux session for inspection
			logInfo("Stopping OpenCode server (tmux session preserved for inspection)");
			await opencodeExecutor.stopServer();
			PortManager.releaseAllPorts();
		} else {
			// STANDARD MODE: Use engine.execute directly
			if (engine.executeStreaming) {
				result = await engine.executeStreaming(
					prompt,
					workDir,
					(step) => {
						// Handle both DetailedStep and string (legacy fallback)
						if (step) {
							spinner.updateStep(step);
						} else {
							spinner.updateStep("Analyzing");
						}
					},
					{ modelOverride: options.modelOverride },
				);
			} else {
				spinner.updateStep("Executing");
				result = await engine.execute(prompt, workDir, {
					modelOverride: options.modelOverride,
				});
			}
		}
	} catch (error) {
		spinner.error("Scan failed");
		const errorMsg = error instanceof Error ? error.message : String(error);
		logError("Scan execution failed:", errorMsg);

		// Cleanup tmux resources on error
		if (opencodeExecutor) {
			try {
				await opencodeExecutor.stopServer();
				PortManager.releaseAllPorts();
			} catch {
				// Ignore cleanup errors
			}
		}

		// Update run state to failed
		updateRunPhaseInMeta(runMeta.id, "failed", workDir);

		return {
			success: false,
			issuesFound: 0,
			inputTokens: 0,
			outputTokens: 0,
			error: errorMsg,
			runId: runMeta.id,
		};
	}

	if (!result.success) {
		spinner.error("Scan failed");
		logError("Scan failed:", result.error || "Unknown error");

		// Cleanup tmux resources on error
		if (opencodeExecutor) {
			try {
				await opencodeExecutor.stopServer();
				PortManager.releaseAllPorts();
			} catch {
				// Ignore cleanup errors
			}
		}

		// Update run state to failed
		updateRunPhaseInMeta(runMeta.id, "failed", workDir);

		return {
			success: false,
			issuesFound: 0,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			error: result.error,
			runId: runMeta.id,
		};
	}

	spinner.updateStep("Parsing results");

	// Parse issues from response
	const parsedIssues = parseIssuesFromResponse(result.response);
	logDebug(`Parsed ${parsedIssues.length} issues from response`);

	// Build issues with proper IDs and save to run-specific state directory
	const savedIssues: Issue[] = [];
	const now = new Date().toISOString();

	for (const parsed of parsedIssues) {
		const timestamp = Date.now().toString(36);
		const random = Math.random().toString(36).substring(2, 8);
		const issue: Issue = {
			id: `P-${timestamp}-${random}`,
			symptom: parsed.symptom,
			hypothesis: parsed.hypothesis,
			severity: parsed.severity,
			frequency: parsed.frequency,
			blast_radius: parsed.blast_radius,
			strategy: parsed.strategy,
			status: "UNVALIDATED",
			evidence: [],
			related_task_ids: [],
			created_at: now,
			updated_at: now,
		};
		savedIssues.push(issue);
	}

	// Save issues to the run's state directory using run-aware function
	saveIssuesForRun(runMeta.id, savedIssues, workDir);

	// Generate Problem Brief using PlanStore (run-aware)
	const problemBriefContent = generateProblemBrief(savedIssues, runMeta.id);
	const problemBriefPath = writeProblemBriefForRun(workDir, runMeta.id, problemBriefContent);
	logDebug(`Problem Brief written to: ${problemBriefPath}`);

	// Sync legacy plans view for backward compatibility
	syncLegacyPlansView(workDir);
	logDebug("Legacy plans view synced");

	// Update run metadata with stats
	updateRunStats(runMeta.id, { issues_found: savedIssues.length }, workDir);
	const finalPhase = savedIssues.length > 0 ? "validate" : "completed";
	updateRunPhaseInMeta(runMeta.id, finalPhase, workDir);

	const duration = Date.now() - startTime;
	spinner.success(`Scan complete ${formatTokens(result.inputTokens, result.outputTokens)}`);

	// Summary
	console.log("");
	console.log("=".repeat(50));
	logInfo("Scan Summary:");
	console.log(`  Run:          ${pc.cyan(runMeta.id)}`);
	console.log(`  Issues found: ${pc.cyan(String(savedIssues.length))}`);
	console.log(`  Duration:     ${formatDuration(duration)}`);
	console.log(`  Problem Brief: ${pc.cyan(problemBriefPath)}`);
	console.log("=".repeat(50));

	if (savedIssues.length > 0) {
		console.log("");
		logInfo("Issues (UNVALIDATED):");
		for (const issue of savedIssues) {
			const severityColor =
				issue.severity === "CRITICAL"
					? pc.red
					: issue.severity === "HIGH"
						? pc.yellow
						: issue.severity === "MEDIUM"
							? pc.blue
							: pc.dim;
			console.log(`  ${pc.cyan(issue.id)} [${severityColor(issue.severity)}] ${issue.symptom}`);
		}
		console.log("");
		logSuccess(`Run ${pc.cyan("milhouse --validate")} to validate issues with probes`);
	} else {
		console.log("");
		logSuccess("No significant issues found in the repository");
	}

	return {
		success: true,
		issuesFound: savedIssues.length,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		problemBriefPath,
		runId: runMeta.id,
	};
}
