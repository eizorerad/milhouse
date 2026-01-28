import * as fs from "node:fs";
import * as path from "node:path";
import type { ProbeResult, ProbeType } from "../probes/types.ts";
import type { Issue } from "../state/types.ts";
import { logDebug, logInfo } from "../ui/logger.ts";
import {
	type EnvProbeRequirement,
	type GateConfig,
	type GateInput,
	type GateResult,
	type GateSeverity,
	type GateViolation,
	createGateResult,
	createGateViolation,
	getGateConfig,
} from "./types.ts";

/**
 * Environment component type - categories of infrastructure that require probe validation
 */
export type EnvComponentType = "database" | "cache" | "storage" | "queue" | "api";

/**
 * Mapping from environment component types to required probe types
 */
export const ENV_COMPONENT_TO_PROBE: Record<EnvComponentType, ProbeType[]> = {
	database: ["postgres"],
	cache: ["redis"],
	storage: ["storage"],
	queue: ["redis"], // Redis often used for queues
	api: ["compose"], // API issues often require topology inspection
};

/**
 * Keywords that indicate an issue relates to a specific environment component
 */
export const ENV_COMPONENT_KEYWORDS: Record<EnvComponentType, string[]> = {
	database: [
		"database",
		"db",
		"postgres",
		"postgresql",
		"mysql",
		"sqlite",
		"sql",
		"migration",
		"schema",
		"table",
		"column",
		"index",
		"query",
		"transaction",
		"deadlock",
		"connection pool",
		"prisma",
		"drizzle",
		"typeorm",
		"sequelize",
		"knex",
	],
	cache: [
		"cache",
		"redis",
		"memcached",
		"caching",
		"ttl",
		"expiration",
		"invalidation",
		"cache miss",
		"cache hit",
		"keyspace",
		"eviction",
	],
	storage: [
		"storage",
		"s3",
		"minio",
		"bucket",
		"blob",
		"file upload",
		"file storage",
		"object storage",
		"gcs",
		"azure blob",
		"cloudinary",
	],
	queue: [
		"queue",
		"message queue",
		"job queue",
		"worker",
		"celery",
		"bull",
		"bullmq",
		"rabbitmq",
		"sqs",
		"pub/sub",
		"pubsub",
		"kafka",
	],
	api: [
		"api",
		"endpoint",
		"route",
		"service",
		"microservice",
		"docker",
		"compose",
		"container",
		"kubernetes",
		"k8s",
		"deployment",
	],
};

/**
 * Configuration options for env-consistency gate
 */
export interface EnvConsistencyOptions {
	/** Environment component types that require probe validation */
	requireProbesFor: EnvComponentType[];
	/** Whether to require all applicable probes or just one */
	requireAllProbes: boolean;
	/** Custom keyword mappings for component detection */
	customKeywords: Partial<Record<EnvComponentType, string[]>>;
	/** Path to issues.json file (relative to workDir or absolute) */
	issuesPath: string;
	/** Path to probes directory (relative to workDir or absolute) */
	probesPath: string;
}

/**
 * Default env-consistency options
 */
export const DEFAULT_ENV_CONSISTENCY_OPTIONS: EnvConsistencyOptions = {
	requireProbesFor: ["database", "cache", "storage"],
	requireAllProbes: false,
	customKeywords: {},
	issuesPath: ".milhouse/state/issues.json",
	probesPath: ".milhouse/probes",
};

/**
 * Issue analysis result - detected environment components
 */
export interface IssueEnvAnalysis {
	/** Issue ID */
	issueId: string;
	/** Issue symptom */
	symptom: string;
	/** Issue hypothesis */
	hypothesis: string;
	/** Detected environment component types */
	detectedComponents: EnvComponentType[];
	/** Required probe types based on detected components */
	requiredProbes: ProbeType[];
	/** Probe types that have been run */
	probesRun: ProbeType[];
	/** Missing probe types */
	missingProbes: ProbeType[];
	/** Whether probe requirements are satisfied */
	satisfied: boolean;
}

/**
 * Generate a unique gate ID
 */
export function generateGateId(): string {
	const timestamp = Date.now();
	const random = Math.random().toString(36).substring(2, 8);
	return `env-consistency-${timestamp}-${random}`;
}

/**
 * Detect environment components from text
 */
export function detectEnvComponents(
	text: string,
	customKeywords: Partial<Record<EnvComponentType, string[]>> = {},
): EnvComponentType[] {
	const lowerText = text.toLowerCase();
	const detected: EnvComponentType[] = [];

	for (const [componentType, keywords] of Object.entries(ENV_COMPONENT_KEYWORDS) as Array<
		[EnvComponentType, string[]]
	>) {
		const allKeywords = [...keywords, ...(customKeywords[componentType] ?? [])];

		for (const keyword of allKeywords) {
			if (lowerText.includes(keyword.toLowerCase())) {
				if (!detected.includes(componentType)) {
					detected.push(componentType);
				}
				break;
			}
		}
	}

	return detected;
}

/**
 * Get required probe types for environment components
 */
export function getRequiredProbes(
	components: EnvComponentType[],
	requireAllProbes: boolean,
): ProbeType[] {
	const probeSet = new Set<ProbeType>();

	for (const component of components) {
		const probes = ENV_COMPONENT_TO_PROBE[component] ?? [];
		for (const probe of probes) {
			probeSet.add(probe);
		}
	}

	return Array.from(probeSet);
}

/**
 * Load issues from issues.json file
 */
export function loadIssues(workDir: string, issuesPath: string): Issue[] {
	const fullPath = path.isAbsolute(issuesPath) ? issuesPath : path.join(workDir, issuesPath);

	if (!fs.existsSync(fullPath)) {
		return [];
	}

	try {
		const content = fs.readFileSync(fullPath, "utf-8");
		const data = JSON.parse(content);

		// Handle both array format and object with issues array
		if (Array.isArray(data)) {
			return data as Issue[];
		}
		if (data.issues && Array.isArray(data.issues)) {
			return data.issues as Issue[];
		}
		return [];
	} catch {
		return [];
	}
}

/**
 * Get probe results from probes directory
 */
export function getProbeResults(
	workDir: string,
	probesPath: string,
): Map<ProbeType, ProbeResult[]> {
	const fullPath = path.isAbsolute(probesPath) ? probesPath : path.join(workDir, probesPath);
	const results = new Map<ProbeType, ProbeResult[]>();

	logDebug(`env-consistency: Looking for probe results in ${fullPath}`);

	if (!fs.existsSync(fullPath)) {
		logDebug(`env-consistency: Probes directory does not exist: ${fullPath}`);
		return results;
	}

	try {
		const entries = fs.readdirSync(fullPath, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.isDirectory()) {
				const probeType = entry.name as ProbeType;
				const probeDirPath = path.join(fullPath, entry.name);
				const probeResults: ProbeResult[] = [];

				// Read all JSON files in the probe directory
				const probeFiles = fs.readdirSync(probeDirPath);
				for (const file of probeFiles) {
					if (file.endsWith(".json")) {
						try {
							const filePath = path.join(probeDirPath, file);
							const content = fs.readFileSync(filePath, "utf-8");
							const result = JSON.parse(content) as ProbeResult;
							probeResults.push(result);
						} catch {
							// Skip invalid probe result files
						}
					}
				}

				if (probeResults.length > 0) {
					results.set(probeType, probeResults);
				}
			}
		}
	} catch {
		// Return empty results on error
	}

	// Log summary of probe results found
	if (results.size > 0) {
		const probeTypes = Array.from(results.keys());
		const totalResults = Array.from(results.values()).reduce((sum, r) => sum + r.length, 0);
		logInfo(
			`env-consistency: Found probe results for ${probeTypes.length} probe types: ${probeTypes.join(", ")} (${totalResults} total results)`,
		);
	} else {
		logDebug("env-consistency: No probe results found in probes directory");
	}

	return results;
}

/**
 * Check if a probe type has been run successfully
 */
export function hasProbeRun(
	probeResults: Map<ProbeType, ProbeResult[]>,
	probeType: ProbeType,
): boolean {
	const results = probeResults.get(probeType);
	if (!results || results.length === 0) {
		return false;
	}

	// At least one successful probe of this type
	return results.some((r) => r.success);
}

/**
 * Analyze an issue for environment component requirements
 */
export function analyzeIssue(
	issue: Issue,
	probeResults: Map<ProbeType, ProbeResult[]>,
	options: EnvConsistencyOptions,
): IssueEnvAnalysis {
	// Combine symptom and hypothesis for analysis
	const textToAnalyze = `${issue.symptom} ${issue.hypothesis} ${issue.corrected_description ?? ""}`;

	// Detect environment components
	const detectedComponents = detectEnvComponents(textToAnalyze, options.customKeywords);

	// Filter to only components we're checking
	const relevantComponents = detectedComponents.filter((c) => options.requireProbesFor.includes(c));

	// Get required probes
	const requiredProbes = getRequiredProbes(relevantComponents, options.requireAllProbes);

	// Check which probes have been run
	const probesRun: ProbeType[] = [];
	const missingProbes: ProbeType[] = [];

	for (const probeType of requiredProbes) {
		if (hasProbeRun(probeResults, probeType)) {
			probesRun.push(probeType);
		} else {
			missingProbes.push(probeType);
		}
	}

	// Determine if satisfied
	const satisfied = options.requireAllProbes
		? missingProbes.length === 0
		: requiredProbes.length === 0 || probesRun.length > 0;

	return {
		issueId: issue.id,
		symptom: issue.symptom,
		hypothesis: issue.hypothesis,
		detectedComponents: relevantComponents,
		requiredProbes,
		probesRun,
		missingProbes,
		satisfied,
	};
}

/**
 * Get severity for missing probe violation
 */
export function getSeverityForMissingProbe(
	component: EnvComponentType,
	issueSeverity: string,
): GateSeverity {
	// Database issues without probes are more critical
	if (component === "database") {
		return issueSeverity === "CRITICAL" ? "CRITICAL" : "HIGH";
	}

	// Cache and storage issues are generally high severity
	if (component === "cache" || component === "storage") {
		return issueSeverity === "CRITICAL" ? "HIGH" : "MEDIUM";
	}

	// Other components are medium severity
	return "MEDIUM";
}

/**
 * Create requirement from analysis
 */
export function createEnvProbeRequirement(
	analysis: IssueEnvAnalysis,
	probeType: ProbeType,
): EnvProbeRequirement {
	const component = (Object.entries(ENV_COMPONENT_TO_PROBE).find(([, probes]) =>
		probes.includes(probeType),
	)?.[0] ?? "database") as EnvComponentType;

	const probeRan = analysis.probesRun.includes(probeType);

	return {
		type: component,
		probeType,
		probeRan,
		probeId: undefined, // Would be set if we tracked specific probe IDs
		probeSuccess: probeRan ? true : undefined,
	};
}

/**
 * Environment Consistency Gate
 *
 * Verifies that issues related to environment components (database, cache, storage)
 * have had the appropriate probes run before being considered validated.
 *
 * Purpose: Ensure that claims about infrastructure issues are backed by
 * actual probe data rather than assumptions.
 *
 * What it checks:
 * - Issues mentioning database/SQL/migration terms → require postgres probe
 * - Issues mentioning cache/redis/TTL terms → require redis probe
 * - Issues mentioning storage/S3/bucket terms → require storage probe
 * - Issues mentioning queue/worker terms → require redis probe (often used for queues)
 * - Issues mentioning API/service/container terms → require compose probe
 */
export async function runEnvConsistencyGate(
	input: GateInput,
	configOverrides?: Partial<GateConfig>,
): Promise<GateResult> {
	const startTime = Date.now();
	const gateId = generateGateId();
	const config = { ...getGateConfig("env-consistency"), ...configOverrides };

	const options: EnvConsistencyOptions = {
		...DEFAULT_ENV_CONSISTENCY_OPTIONS,
		...(config.options as Partial<EnvConsistencyOptions>),
	};

	const violations: GateViolation[] = [];
	let issuesChecked = 0;
	let requirementsChecked = 0;
	const gateEvidence: GateResult["evidence"] = [];

	try {
		// Load issues
		const issues = loadIssues(input.workDir, options.issuesPath);

		if (issues.length === 0) {
			const durationMs = Date.now() - startTime;
			return createGateResult(gateId, "env-consistency", true, {
				message: "No issues found to check",
				violations: [],
				evidence: [],
				duration_ms: durationMs,
				files_checked: 0,
				items_checked: 0,
			});
		}

		// Get probe results
		const probeResults = getProbeResults(input.workDir, options.probesPath);

		// Record what probes we found
		const probeTypesFound = Array.from(probeResults.keys());
		if (probeTypesFound.length > 0) {
			gateEvidence.push({
				type: "probe",
				probe_id: probeTypesFound.join(","),
				output: `Found probe results for: ${probeTypesFound.join(", ")}`,
				timestamp: new Date().toISOString(),
			});
		}

		// Filter to relevant issues if task IDs provided
		let issuesToCheck = issues;
		if (input.taskIds.length > 0) {
			issuesToCheck = issues.filter(
				(issue) =>
					input.taskIds.some((tid) => issue.related_task_ids.includes(tid)) ||
					input.taskIds.includes(issue.id),
			);
		}

		// Analyze each issue
		for (const issue of issuesToCheck) {
			issuesChecked++;

			const analysis = analyzeIssue(issue, probeResults, options);
			requirementsChecked += analysis.requiredProbes.length;

			// Create violations for missing probes
			if (!analysis.satisfied && analysis.missingProbes.length > 0) {
				for (const missingProbe of analysis.missingProbes) {
					const componentType = (Object.entries(ENV_COMPONENT_TO_PROBE).find(([, probes]) =>
						probes.includes(missingProbe),
					)?.[0] ?? "database") as EnvComponentType;

					const severity = getSeverityForMissingProbe(componentType, issue.severity);

					const violation = createGateViolation(
						`missing-probe-${issue.id}-${missingProbe}`,
						`Missing ${missingProbe} probe for ${componentType} issue`,
						`Issue "${issue.id}" mentions ${componentType} components but no ${missingProbe} probe has been run. ` +
							`Run "milhouse probe ${missingProbe}" to gather evidence before validating this issue.`,
						severity,
						{
							suggestion: `Run the ${missingProbe} probe to gather evidence for this ${componentType}-related issue`,
							metadata: {
								issueId: issue.id,
								issueSymptom: issue.symptom,
								detectedComponents: analysis.detectedComponents,
								missingProbe,
								requiredProbes: analysis.requiredProbes,
								probesRun: analysis.probesRun,
							},
						},
					);

					violations.push(violation);
				}
			}

			// Record evidence for satisfied requirements
			if (analysis.satisfied && analysis.probesRun.length > 0) {
				gateEvidence.push({
					type: "probe",
					probe_id: `issue-${issue.id}`,
					output: `Issue ${issue.id} has required probes: ${analysis.probesRun.join(", ")}`,
					timestamp: new Date().toISOString(),
				});
			}
		}

		const durationMs = Date.now() - startTime;
		const passed = config.strict
			? violations.length === 0
			: !violations.some((v) => v.severity === "CRITICAL" || v.severity === "HIGH");

		return createGateResult(gateId, "env-consistency", passed, {
			message: passed
				? `Checked ${issuesChecked} issues - all environment probe requirements satisfied`
				: `Found ${violations.length} missing probe requirements in ${issuesChecked} issues`,
			violations,
			evidence: gateEvidence,
			duration_ms: durationMs,
			files_checked: issuesChecked,
			items_checked: requirementsChecked,
		});
	} catch (error) {
		const durationMs = Date.now() - startTime;
		const errorMessage = error instanceof Error ? error.message : String(error);

		return createGateResult(gateId, "env-consistency", false, {
			message: `Environment consistency gate failed: ${errorMessage}`,
			violations: [
				createGateViolation("gate-error", "Gate execution error", errorMessage, "CRITICAL"),
			],
			duration_ms: durationMs,
			files_checked: issuesChecked,
			items_checked: requirementsChecked,
		});
	}
}

/**
 * Check a single issue for environment consistency
 */
export async function checkIssueEnvConsistency(
	workDir: string,
	issue: Issue,
	options?: Partial<EnvConsistencyOptions>,
): Promise<IssueEnvAnalysis> {
	const fullOptions: EnvConsistencyOptions = {
		...DEFAULT_ENV_CONSISTENCY_OPTIONS,
		...options,
	};

	const probeResults = getProbeResults(workDir, fullOptions.probesPath);
	return analyzeIssue(issue, probeResults, fullOptions);
}

/**
 * Get summary of environment consistency analysis
 */
export function getEnvConsistencySummary(analyses: IssueEnvAnalysis[]): {
	totalIssues: number;
	issuesWithEnvComponents: number;
	satisfiedIssues: number;
	unsatisfiedIssues: number;
	componentCounts: Record<EnvComponentType, number>;
	missingProbeCounts: Record<string, number>;
} {
	const componentCounts: Record<EnvComponentType, number> = {
		database: 0,
		cache: 0,
		storage: 0,
		queue: 0,
		api: 0,
	};

	const missingProbeCounts: Record<string, number> = {};
	let issuesWithEnvComponents = 0;
	let satisfiedIssues = 0;
	let unsatisfiedIssues = 0;

	for (const analysis of analyses) {
		if (analysis.detectedComponents.length > 0) {
			issuesWithEnvComponents++;

			for (const component of analysis.detectedComponents) {
				componentCounts[component]++;
			}

			if (analysis.satisfied) {
				satisfiedIssues++;
			} else {
				unsatisfiedIssues++;
				for (const probe of analysis.missingProbes) {
					missingProbeCounts[probe] = (missingProbeCounts[probe] ?? 0) + 1;
				}
			}
		}
	}

	return {
		totalIssues: analyses.length,
		issuesWithEnvComponents,
		satisfiedIssues,
		unsatisfiedIssues,
		componentCounts,
		missingProbeCounts,
	};
}

/**
 * Format environment consistency summary for display
 */
export function formatEnvConsistencySummary(analyses: IssueEnvAnalysis[]): string {
	const summary = getEnvConsistencySummary(analyses);
	const lines: string[] = [];

	lines.push(`Total issues: ${summary.totalIssues}`);
	lines.push(`Issues with env components: ${summary.issuesWithEnvComponents}`);

	if (summary.issuesWithEnvComponents > 0) {
		lines.push(`Satisfied: ${summary.satisfiedIssues}`);
		lines.push(`Unsatisfied: ${summary.unsatisfiedIssues}`);

		const componentList = Object.entries(summary.componentCounts)
			.filter(([, count]) => count > 0)
			.map(([type, count]) => `${type}: ${count}`)
			.join(", ");

		if (componentList) {
			lines.push(`Components: ${componentList}`);
		}

		const missingList = Object.entries(summary.missingProbeCounts)
			.filter(([, count]) => count > 0)
			.map(([probe, count]) => `${probe}: ${count}`)
			.join(", ");

		if (missingList) {
			lines.push(`Missing probes: ${missingList}`);
		}
	}

	return lines.join("\n");
}

/**
 * Get probe recommendation for an issue
 */
export function getProbeRecommendation(analysis: IssueEnvAnalysis): string | null {
	if (analysis.satisfied || analysis.missingProbes.length === 0) {
		return null;
	}

	const probeCommands = analysis.missingProbes.map((p) => `milhouse probe ${p}`);

	if (probeCommands.length === 1) {
		return `Run: ${probeCommands[0]}`;
	}

	return `Run the following probes:\n${probeCommands.map((c) => `  - ${c}`).join("\n")}`;
}
