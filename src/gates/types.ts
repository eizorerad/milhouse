import { z } from "zod";

/**
 * Gate type identifiers - quality and correctness checks
 */
export const GateTypeSchema = z.enum([
	"evidence", // No claims without file:lines or probe_id proof
	"diff-hygiene", // Flag silent refactors, extra files, whitespace bombs
	"placeholder", // Block TODO/mock/return true stubs
	"env-consistency", // Require probes for db/cache/storage issues
	"dod", // Definition of Done must be verifiable by commands
]);

export type GateType = z.infer<typeof GateTypeSchema>;

/**
 * Gate type descriptions
 */
export const GATE_TYPE_DESCRIPTIONS: Record<GateType, string> = {
	evidence: "Evidence Gate - No claims without file:lines or probe_id proof",
	"diff-hygiene": "Diff Hygiene Gate - Flag silent refactors, extra files, whitespace bombs",
	placeholder: "Placeholder Gate - Block TODO/mock/return true stubs",
	"env-consistency": "Environment Consistency Gate - Require probes for db/cache/storage issues",
	dod: "Definition of Done Gate - All acceptance criteria verifiable by commands",
};

/**
 * Gate status values
 */
export const GateStatusSchema = z.enum([
	"pending", // Gate is scheduled but not started
	"running", // Gate is currently executing
	"passed", // Gate completed successfully
	"failed", // Gate failed with issues
	"skipped", // Gate was skipped
	"warning", // Gate passed with warnings
]);

export type GateStatus = z.infer<typeof GateStatusSchema>;

/**
 * Gate severity for issues found
 */
export const GateSeveritySchema = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "WARNING", "INFO"]);

export type GateSeverity = z.infer<typeof GateSeveritySchema>;

/**
 * Gate violation - an issue discovered by a gate
 */
export const GateViolationSchema = z.object({
	/** Unique violation identifier */
	id: z.string(),
	/** Brief title of the violation */
	title: z.string(),
	/** Detailed description */
	description: z.string(),
	/** Severity level */
	severity: GateSeveritySchema,
	/** File location if applicable */
	file: z.string().optional(),
	/** Line number in file if applicable */
	line: z.number().optional(),
	/** End line number if applicable */
	line_end: z.number().optional(),
	/** Code snippet or content that caused the violation */
	snippet: z.string().optional(),
	/** Suggested fix or action */
	suggestion: z.string().optional(),
	/** Related task ID if applicable */
	task_id: z.string().optional(),
	/** Additional metadata */
	metadata: z.record(z.string(), z.unknown()).default({}),
});

export type GateViolation = z.infer<typeof GateViolationSchema>;

/**
 * Gate result - output from a gate execution
 */
export const GateResultSchema = z.object({
	/** Unique gate result identifier */
	gate_id: z.string(),
	/** Type of gate */
	gate_type: GateTypeSchema,
	/** Whether the gate passed */
	passed: z.boolean(),
	/** Human-readable status message */
	message: z.string().optional(),
	/** Violations discovered by the gate */
	violations: z.array(GateViolationSchema).default([]),
	/** Supporting evidence */
	evidence: z
		.array(
			z.object({
				type: z.enum(["file", "probe", "log", "command"]),
				file: z.string().optional(),
				line_start: z.number().optional(),
				line_end: z.number().optional(),
				probe_id: z.string().optional(),
				command: z.string().optional(),
				output: z.string().optional(),
				timestamp: z.string(),
			}),
		)
		.default([]),
	/** ISO timestamp of gate execution */
	timestamp: z.string(),
	/** Execution duration in milliseconds */
	duration_ms: z.number().optional(),
	/** Number of files checked */
	files_checked: z.number().default(0),
	/** Number of items checked (varies by gate type) */
	items_checked: z.number().default(0),
});

export type GateResult = z.infer<typeof GateResultSchema>;

/**
 * Gate input - common input for all gates
 */
export const GateInputSchema = z.object({
	/** Working directory to run gate in */
	workDir: z.string(),
	/** Target files to check (optional, defaults to modified files) */
	targets: z.array(z.string()).default([]),
	/** Task IDs to scope the check to (optional) */
	taskIds: z.array(z.string()).default([]),
	/** Additional options for the gate */
	options: z.record(z.string(), z.unknown()).default({}),
	/** Whether to run in strict mode (fail on warnings) */
	strict: z.boolean().default(false),
	/** Timeout in milliseconds */
	timeout_ms: z.number().default(30000),
	/** Whether to run in verbose mode */
	verbose: z.boolean().default(false),
});

export type GateInput = z.infer<typeof GateInputSchema>;

/**
 * Gate configuration - settings for gate execution
 */
export const GateConfigSchema = z.object({
	/** Whether the gate is enabled */
	enabled: z.boolean().default(true),
	/** Default timeout in milliseconds */
	timeout_ms: z.number().default(30000),
	/** Whether to fail on warnings */
	strict: z.boolean().default(false),
	/** Patterns to exclude from checking */
	exclude_patterns: z.array(z.string()).default([]),
	/** Patterns to include in checking */
	include_patterns: z.array(z.string()).default([]),
	/** Custom options for the gate */
	options: z.record(z.string(), z.unknown()).default({}),
});

export type GateConfig = z.infer<typeof GateConfigSchema>;

/**
 * Default gate configurations per type
 */
export const DEFAULT_GATE_CONFIGS: Record<GateType, GateConfig> = {
	evidence: {
		enabled: true,
		timeout_ms: 30000,
		strict: true,
		exclude_patterns: [],
		include_patterns: [],
		options: {},
	},
	"diff-hygiene": {
		enabled: true,
		timeout_ms: 60000,
		strict: false,
		exclude_patterns: ["node_modules/**", "dist/**", "build/**", ".git/**"],
		include_patterns: [],
		options: {
			maxWhitespaceChanges: 10,
			checkFormatting: true,
		},
	},
	placeholder: {
		enabled: true,
		timeout_ms: 30000,
		strict: true,
		exclude_patterns: ["node_modules/**", "*.test.ts", "*.spec.ts", "**/__tests__/**"],
		include_patterns: [],
		options: {
			allowInTests: false,
			patterns: ["TODO", "FIXME", "HACK", "XXX", "Not implemented", "return true", "return false"],
		},
	},
	"env-consistency": {
		enabled: true,
		timeout_ms: 60000,
		strict: false,
		exclude_patterns: [],
		include_patterns: [],
		options: {
			requireProbesFor: ["database", "cache", "storage"],
		},
	},
	dod: {
		enabled: true,
		timeout_ms: 120000,
		strict: true,
		exclude_patterns: [],
		include_patterns: [],
		options: {
			requireVerifiableChecks: true,
		},
	},
};

/**
 * Get gate configuration for a type
 */
export function getGateConfig(gateType: GateType): GateConfig {
	return { ...DEFAULT_GATE_CONFIGS[gateType] };
}

/**
 * Gate execution metrics
 */
export const GateMetricsSchema = z.object({
	/** Execution duration in milliseconds */
	duration_ms: z.number(),
	/** Number of files checked */
	files_checked: z.number().default(0),
	/** Number of items checked */
	items_checked: z.number().default(0),
	/** Number of violations found */
	violations_count: z.number().default(0),
	/** Breakdown of violations by severity */
	violations_by_severity: z
		.object({
			CRITICAL: z.number().default(0),
			HIGH: z.number().default(0),
			MEDIUM: z.number().default(0),
			LOW: z.number().default(0),
			WARNING: z.number().default(0),
			INFO: z.number().default(0),
		})
		.default({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, WARNING: 0, INFO: 0 }),
});

export type GateMetrics = z.infer<typeof GateMetricsSchema>;

/**
 * Create empty metrics
 */
export function createEmptyGateMetrics(): GateMetrics {
	return {
		duration_ms: 0,
		files_checked: 0,
		items_checked: 0,
		violations_count: 0,
		violations_by_severity: {
			CRITICAL: 0,
			HIGH: 0,
			MEDIUM: 0,
			LOW: 0,
			WARNING: 0,
			INFO: 0,
		},
	};
}

/**
 * Create metrics from gate result
 */
export function createMetricsFromGateResult(result: GateResult): GateMetrics {
	const violationsBySeverity: Record<GateSeverity, number> = {
		CRITICAL: 0,
		HIGH: 0,
		MEDIUM: 0,
		LOW: 0,
		WARNING: 0,
		INFO: 0,
	};

	for (const violation of result.violations) {
		violationsBySeverity[violation.severity]++;
	}

	return {
		duration_ms: result.duration_ms ?? 0,
		files_checked: result.files_checked,
		items_checked: result.items_checked,
		violations_count: result.violations.length,
		violations_by_severity: violationsBySeverity,
	};
}

/**
 * Placeholder gate specific types
 */

export const PlaceholderPatternSchema = z.object({
	/** Pattern to match (string or regex) */
	pattern: z.string(),
	/** Whether the pattern is a regex */
	isRegex: z.boolean().default(false),
	/** Severity when this pattern is found */
	severity: GateSeveritySchema.default("HIGH"),
	/** Description of what this pattern indicates */
	description: z.string().optional(),
});

export type PlaceholderPattern = z.infer<typeof PlaceholderPatternSchema>;

/**
 * Default placeholder patterns to detect
 */
export const DEFAULT_PLACEHOLDER_PATTERNS: PlaceholderPattern[] = [
	{
		pattern: "TODO\\s*[:([\\]]?",
		isRegex: true,
		severity: "HIGH",
		description: "TODO comment found",
	},
	{
		pattern: "FIXME\\s*[:([\\]]?",
		isRegex: true,
		severity: "HIGH",
		description: "FIXME comment found",
	},
	{
		pattern: "HACK\\s*[:([\\]]?",
		isRegex: true,
		severity: "MEDIUM",
		description: "HACK comment found",
	},
	{
		pattern: "XXX\\s*[:([\\]]?",
		isRegex: true,
		severity: "MEDIUM",
		description: "XXX marker found",
	},
	{
		pattern: "\\breturn\\s+true\\s*;?\\s*//.*placeholder",
		isRegex: true,
		severity: "CRITICAL",
		description: "Placeholder return true found",
	},
	{
		pattern: "\\breturn\\s+false\\s*;?\\s*//.*placeholder",
		isRegex: true,
		severity: "CRITICAL",
		description: "Placeholder return false found",
	},
	{
		pattern: "\\breturn\\s+null\\s*;?\\s*//.*placeholder",
		isRegex: true,
		severity: "CRITICAL",
		description: "Placeholder return null found",
	},
	{
		pattern: "\\bthrow\\s+new\\s+Error\\s*\\(\\s*[\"']Not implemented[\"']\\s*\\)",
		isRegex: true,
		severity: "CRITICAL",
		description: "Not implemented error thrown",
	},
	{
		pattern: "\\bthrow\\s+new\\s+Error\\s*\\(\\s*[\"']TODO[\"']\\s*\\)",
		isRegex: true,
		severity: "CRITICAL",
		description: "TODO error thrown",
	},
	{
		pattern: "\\.skip\\s*\\(",
		isRegex: true,
		severity: "HIGH",
		description: "Test skip found",
	},
	{
		pattern: "\\.only\\s*\\(",
		isRegex: true,
		severity: "HIGH",
		description: "Test only found",
	},
];

/**
 * Diff hygiene gate specific types
 */

export const DiffChangeTypeSchema = z.enum([
	"whitespace", // Pure whitespace changes
	"formatting", // Code formatting changes
	"rename", // Variable/function renames
	"move", // Code movement without changes
	"refactor", // Structural refactoring
	"feature", // New feature code
	"fix", // Bug fix
	"unknown", // Cannot categorize
]);

export type DiffChangeType = z.infer<typeof DiffChangeTypeSchema>;

export const DiffAnalysisSchema = z.object({
	/** File path */
	file: z.string(),
	/** Type of change detected */
	changeType: DiffChangeTypeSchema,
	/** Number of lines added */
	linesAdded: z.number().default(0),
	/** Number of lines removed */
	linesRemoved: z.number().default(0),
	/** Whether the change was declared in a task */
	isDeclared: z.boolean().default(false),
	/** Related task ID if declared */
	taskId: z.string().optional(),
	/** Detailed description of changes */
	description: z.string().optional(),
});

export type DiffAnalysis = z.infer<typeof DiffAnalysisSchema>;

/**
 * Evidence gate specific types
 */

export const EvidenceRequirementSchema = z.object({
	/** Type of evidence required */
	type: z.enum(["file", "probe", "command", "test"]),
	/** Description of what evidence is needed */
	description: z.string(),
	/** Whether this evidence was provided */
	satisfied: z.boolean().default(false),
	/** The actual evidence if provided */
	evidence: z
		.object({
			type: z.enum(["file", "probe", "log", "command"]),
			file: z.string().optional(),
			line_start: z.number().optional(),
			line_end: z.number().optional(),
			probe_id: z.string().optional(),
			command: z.string().optional(),
			output: z.string().optional(),
			timestamp: z.string(),
		})
		.optional(),
});

export type EvidenceRequirement = z.infer<typeof EvidenceRequirementSchema>;

/**
 * DoD gate specific types
 */

export const DoDCheckResultSchema = z.object({
	/** Criteria description */
	criteria: z.string(),
	/** Whether the criteria was met */
	met: z.boolean(),
	/** Command used to verify (if any) */
	check_command: z.string().optional(),
	/** Command exit code */
	exit_code: z.number().optional(),
	/** Command output */
	output: z.string().optional(),
	/** Failure reason if not met */
	failure_reason: z.string().optional(),
});

export type DoDCheckResult = z.infer<typeof DoDCheckResultSchema>;

/**
 * Environment consistency gate specific types
 */

export const EnvProbeRequirementSchema = z.object({
	/** Type of environment component */
	type: z.enum(["database", "cache", "storage", "queue", "api"]),
	/** Probe type required */
	probeType: z.string(),
	/** Whether a probe was run */
	probeRan: z.boolean().default(false),
	/** Probe ID if ran */
	probeId: z.string().optional(),
	/** Probe success status */
	probeSuccess: z.boolean().optional(),
});

export type EnvProbeRequirement = z.infer<typeof EnvProbeRequirementSchema>;

/**
 * Gate run summary - aggregates all gate results
 */
export const GateRunSummarySchema = z.object({
	/** Unique run identifier */
	run_id: z.string(),
	/** ISO timestamp when gates started */
	started_at: z.string(),
	/** ISO timestamp when gates completed */
	completed_at: z.string().optional(),
	/** Overall pass/fail status */
	overall_pass: z.boolean(),
	/** Number of gates run */
	gates_run: z.number().default(0),
	/** Number of gates passed */
	gates_passed: z.number().default(0),
	/** Number of gates failed */
	gates_failed: z.number().default(0),
	/** Number of gates skipped */
	gates_skipped: z.number().default(0),
	/** Number of gates with warnings */
	gates_warned: z.number().default(0),
	/** Total violations across all gates */
	total_violations: z.number().default(0),
	/** Violations by severity */
	violations_by_severity: z
		.object({
			CRITICAL: z.number().default(0),
			HIGH: z.number().default(0),
			MEDIUM: z.number().default(0),
			LOW: z.number().default(0),
			WARNING: z.number().default(0),
			INFO: z.number().default(0),
		})
		.default({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, WARNING: 0, INFO: 0 }),
	/** Individual gate results */
	results: z.array(GateResultSchema).default([]),
	/** Total duration in milliseconds */
	duration_ms: z.number().optional(),
});

export type GateRunSummary = z.infer<typeof GateRunSummarySchema>;

/**
 * Helper functions
 */

/**
 * Check if a string is a valid gate type
 */
export function isValidGateType(value: string): value is GateType {
	return GateTypeSchema.safeParse(value).success;
}

/**
 * Get all gate types
 */
export function getAllGateTypes(): GateType[] {
	return GateTypeSchema.options.slice();
}

/**
 * Get enabled gate types based on configuration
 */
export function getEnabledGateTypes(configs?: Partial<Record<GateType, GateConfig>>): GateType[] {
	const mergedConfigs = { ...DEFAULT_GATE_CONFIGS, ...configs };
	return getAllGateTypes().filter((type) => mergedConfigs[type]?.enabled !== false);
}

/**
 * Create a gate violation
 */
export function createGateViolation(
	id: string,
	title: string,
	description: string,
	severity: GateSeverity,
	options?: Partial<Omit<GateViolation, "id" | "title" | "description" | "severity">>,
): GateViolation {
	return {
		id,
		title,
		description,
		severity,
		metadata: options?.metadata ? { ...options.metadata } : {},
		file: options?.file,
		line: options?.line,
		line_end: options?.line_end,
		snippet: options?.snippet,
		suggestion: options?.suggestion,
		task_id: options?.task_id,
	};
}

/**
 * Create a gate result
 */
export function createGateResult(
	gateId: string,
	gateType: GateType,
	passed: boolean,
	options?: Partial<Omit<GateResult, "gate_id" | "gate_type" | "passed" | "timestamp">>,
): GateResult {
	return {
		gate_id: gateId,
		gate_type: gateType,
		passed,
		timestamp: new Date().toISOString(),
		violations: options?.violations ? options.violations.map((v) => ({ ...v })) : [],
		evidence: options?.evidence ? options.evidence.map((e) => ({ ...e })) : [],
		message: options?.message,
		duration_ms: options?.duration_ms,
		files_checked: options?.files_checked ?? 0,
		items_checked: options?.items_checked ?? 0,
	};
}

/**
 * Count violations by severity in a gate result
 */
export function countViolationsBySeverity(result: GateResult): Record<GateSeverity, number> {
	const counts: Record<GateSeverity, number> = {
		CRITICAL: 0,
		HIGH: 0,
		MEDIUM: 0,
		LOW: 0,
		WARNING: 0,
		INFO: 0,
	};

	for (const violation of result.violations) {
		counts[violation.severity]++;
	}

	return counts;
}

/**
 * Check if gate result has blocking violations (CRITICAL or HIGH)
 */
export function hasBlockingViolations(result: GateResult): boolean {
	return result.violations.some((v) => v.severity === "CRITICAL" || v.severity === "HIGH");
}

/**
 * Get violations filtered by severity
 */
export function getViolationsBySeverity(
	result: GateResult,
	severity: GateSeverity,
): GateViolation[] {
	return result.violations.filter((v) => v.severity === severity);
}

/**
 * Get all critical violations from a gate result
 */
export function getCriticalViolations(result: GateResult): GateViolation[] {
	return getViolationsBySeverity(result, "CRITICAL");
}

/**
 * Get all high severity violations from a gate result
 */
export function getHighViolations(result: GateResult): GateViolation[] {
	return getViolationsBySeverity(result, "HIGH");
}

/**
 * Create a gate run summary from results
 */
export function createGateRunSummary(
	runId: string,
	results: GateResult[],
	startedAt: string,
): GateRunSummary {
	const violationsBySeverity: Record<GateSeverity, number> = {
		CRITICAL: 0,
		HIGH: 0,
		MEDIUM: 0,
		LOW: 0,
		WARNING: 0,
		INFO: 0,
	};

	let totalViolations = 0;
	let gatesPassed = 0;
	let gatesFailed = 0;
	let gatesWarned = 0;
	let totalDuration = 0;

	for (const result of results) {
		totalViolations += result.violations.length;
		totalDuration += result.duration_ms ?? 0;

		if (result.passed) {
			if (result.violations.some((v) => v.severity === "WARNING")) {
				gatesWarned++;
			} else {
				gatesPassed++;
			}
		} else {
			gatesFailed++;
		}

		for (const violation of result.violations) {
			violationsBySeverity[violation.severity]++;
		}
	}

	const overallPass = gatesFailed === 0;

	return {
		run_id: runId,
		started_at: startedAt,
		completed_at: new Date().toISOString(),
		overall_pass: overallPass,
		gates_run: results.length,
		gates_passed: gatesPassed,
		gates_failed: gatesFailed,
		gates_skipped: 0,
		gates_warned: gatesWarned,
		total_violations: totalViolations,
		violations_by_severity: violationsBySeverity,
		results: results.map((r) => ({ ...r })),
		duration_ms: totalDuration,
	};
}

/**
 * Merge multiple gate run summaries
 */
export function mergeGateRunSummaries(summaries: GateRunSummary[]): {
	total_runs: number;
	overall_pass: boolean;
	total_gates_run: number;
	total_gates_passed: number;
	total_gates_failed: number;
	total_violations: number;
	violations_by_severity: Record<GateSeverity, number>;
	total_duration_ms: number;
} {
	const violationsBySeverity: Record<GateSeverity, number> = {
		CRITICAL: 0,
		HIGH: 0,
		MEDIUM: 0,
		LOW: 0,
		WARNING: 0,
		INFO: 0,
	};

	let totalGatesRun = 0;
	let totalGatesPassed = 0;
	let totalGatesFailed = 0;
	let totalViolations = 0;
	let totalDuration = 0;
	let overallPass = true;

	for (const summary of summaries) {
		totalGatesRun += summary.gates_run;
		totalGatesPassed += summary.gates_passed;
		totalGatesFailed += summary.gates_failed;
		totalViolations += summary.total_violations;
		totalDuration += summary.duration_ms ?? 0;

		if (!summary.overall_pass) {
			overallPass = false;
		}

		for (const severity of Object.keys(violationsBySeverity) as GateSeverity[]) {
			violationsBySeverity[severity] += summary.violations_by_severity[severity] ?? 0;
		}
	}

	return {
		total_runs: summaries.length,
		overall_pass: overallPass,
		total_gates_run: totalGatesRun,
		total_gates_passed: totalGatesPassed,
		total_gates_failed: totalGatesFailed,
		total_violations: totalViolations,
		violations_by_severity: violationsBySeverity,
		total_duration_ms: totalDuration,
	};
}

/**
 * File extensions considered as code files for gate checking
 */
export const CODE_FILE_EXTENSIONS = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".java",
	".kt",
	".kts",
	".swift",
	".c",
	".cpp",
	".h",
	".hpp",
	".cs",
	".rb",
	".php",
	".scala",
	".clj",
	".ex",
	".exs",
] as const;

/**
 * Check if a file extension is a code file
 */
export function isCodeFile(filePath: string): boolean {
	const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
	return CODE_FILE_EXTENSIONS.includes(ext as (typeof CODE_FILE_EXTENSIONS)[number]);
}

/**
 * Patterns to exclude from gate checking by default
 */
export const DEFAULT_EXCLUDE_PATTERNS = [
	"node_modules/**",
	"dist/**",
	"build/**",
	".git/**",
	"coverage/**",
	".next/**",
	".nuxt/**",
	"vendor/**",
	"__pycache__/**",
	".venv/**",
	"*.min.js",
	"*.min.css",
	"*.map",
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
] as const;

/**
 * Check if a file path should be excluded based on patterns
 */
export function shouldExcludeFile(filePath: string, patterns: string[] = []): boolean {
	const allPatterns = [...DEFAULT_EXCLUDE_PATTERNS, ...patterns];

	for (const pattern of allPatterns) {
		if (pattern.endsWith("/**")) {
			const dir = pattern.slice(0, -3);
			if (filePath.startsWith(`${dir}/`) || filePath === dir) {
				return true;
			}
		} else if (pattern.startsWith("*.")) {
			const ext = pattern.slice(1);
			if (filePath.endsWith(ext)) {
				return true;
			}
		} else if (filePath === pattern || filePath.endsWith(`/${pattern}`)) {
			return true;
		}
	}

	return false;
}
