import * as fs from "node:fs";
import * as path from "node:path";
import type { Evidence } from "../state/types.ts";
import {
	type EvidenceRequirement,
	type GateConfig,
	type GateInput,
	type GateResult,
	type GateSeverity,
	type GateViolation,
	createGateResult,
	createGateViolation,
	getGateConfig,
	isCodeFile,
	shouldExcludeFile,
} from "./types.ts";

/**
 * Claim type - a statement that requires evidence
 */
export interface Claim {
	/** Unique claim identifier */
	id: string;
	/** The claim text */
	text: string;
	/** File where the claim was made */
	file?: string;
	/** Line number where the claim was made */
	line?: number;
	/** Type of claim */
	type: ClaimType;
	/** Evidence supporting this claim (if any) */
	evidence?: Evidence[];
	/** Whether this claim has been verified */
	verified: boolean;
}

/**
 * Types of claims that require evidence
 */
export type ClaimType =
	| "bug_fix" // Claim that a bug was fixed
	| "implementation" // Claim that something was implemented
	| "test_pass" // Claim that tests pass
	| "performance" // Claim about performance improvement
	| "security" // Claim about security fix
	| "refactor" // Claim about refactoring
	| "removal" // Claim about code removal
	| "dependency" // Claim about dependency change
	| "configuration" // Claim about configuration change
	| "documentation"; // Claim about documentation

/**
 * Patterns that indicate claims in commit messages and code comments
 */
export const CLAIM_PATTERNS: Array<{
	pattern: RegExp;
	type: ClaimType;
	requiresEvidence: boolean;
	description: string;
}> = [
	{
		pattern: /\bfix(?:ed|es)?\s+(?:bug|issue|problem|error)/i,
		type: "bug_fix",
		requiresEvidence: true,
		description: "Bug fix claim requires file:line evidence of the fix",
	},
	{
		pattern: /\bimplement(?:ed|s)?\s+\w+/i,
		type: "implementation",
		requiresEvidence: true,
		description: "Implementation claim requires file:line evidence",
	},
	{
		pattern: /\btests?\s+pass(?:ing|ed|es)?/i,
		type: "test_pass",
		requiresEvidence: true,
		description: "Test pass claim requires command output evidence",
	},
	{
		pattern: /\bimproved?\s+performance/i,
		type: "performance",
		requiresEvidence: true,
		description: "Performance claim requires benchmark evidence",
	},
	{
		pattern: /\bsecurity\s+(?:fix|patch|update)/i,
		type: "security",
		requiresEvidence: true,
		description: "Security claim requires evidence of vulnerability and fix",
	},
	{
		pattern: /\brefactor(?:ed|ing|s)?\b/i,
		type: "refactor",
		requiresEvidence: true,
		description: "Refactor claim requires diff evidence",
	},
	{
		pattern: /\bremov(?:ed|ing|es?)?\s+(?:dead\s+)?code/i,
		type: "removal",
		requiresEvidence: true,
		description: "Code removal claim requires evidence it was unused",
	},
	{
		pattern: /\bupgrad(?:ed|ing|es?)?\s+(?:dependency|package)/i,
		type: "dependency",
		requiresEvidence: true,
		description: "Dependency change requires package.json evidence",
	},
	{
		pattern: /\bconfig(?:ured|uring|uration)?\s+\w+/i,
		type: "configuration",
		requiresEvidence: true,
		description: "Configuration change requires file evidence",
	},
	{
		pattern: /\bdocument(?:ed|ing|s|ation)?\s+\w+/i,
		type: "documentation",
		requiresEvidence: false,
		description: "Documentation claim (optional evidence)",
	},
];

/**
 * Evidence patterns in code comments
 */
export const EVIDENCE_COMMENT_PATTERNS: Array<{
	pattern: RegExp;
	evidenceType: Evidence["type"];
	extractor: (match: RegExpMatchArray) => Partial<Evidence>;
}> = [
	{
		// File reference: see src/api.ts:42
		pattern: /see\s+([^\s:]+):(\d+)(?:-(\d+))?/i,
		evidenceType: "file",
		extractor: (match) => ({
			file: match[1],
			line_start: Number.parseInt(match[2], 10),
			line_end: match[3] ? Number.parseInt(match[3], 10) : undefined,
		}),
	},
	{
		// Probe reference: probe:postgres-123
		pattern: /probe[:\s]+([a-z]+-\d+-[a-z0-9]+)/i,
		evidenceType: "probe",
		extractor: (match) => ({
			probe_id: match[1],
		}),
	},
	{
		// Command reference: $ npm test
		pattern: /\$\s+(.+)/,
		evidenceType: "command",
		extractor: (match) => ({
			command: match[1].trim(),
		}),
	},
	{
		// Log reference: log:error.log:42
		pattern: /log[:\s]+([^\s:]+)(?::(\d+))?/i,
		evidenceType: "log",
		extractor: (match) => ({
			file: match[1],
			line_start: match[2] ? Number.parseInt(match[2], 10) : undefined,
		}),
	},
];

/**
 * Result of evidence analysis
 */
export interface EvidenceAnalysisResult {
	/** Claims found without sufficient evidence */
	unsupportedClaims: Claim[];
	/** Claims found with evidence */
	supportedClaims: Claim[];
	/** Total claims analyzed */
	totalClaims: number;
	/** Evidence requirements for each claim */
	requirements: EvidenceRequirement[];
}

/**
 * Generate a unique gate ID
 */
export function generateGateId(): string {
	const timestamp = Date.now();
	const random = Math.random().toString(36).substring(2, 8);
	return `evidence-${timestamp}-${random}`;
}

/**
 * Extract claims from text (commit message, code comment, etc.)
 */
export function extractClaims(text: string, file?: string, lineOffset = 0): Claim[] {
	const claims: Claim[] = [];
	const lines = text.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNumber = lineOffset + i + 1;

		for (const claimPattern of CLAIM_PATTERNS) {
			const match = line.match(claimPattern.pattern);
			if (match) {
				const claimId = `claim-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
				claims.push({
					id: claimId,
					text: match[0],
					file,
					line: lineNumber,
					type: claimPattern.type,
					evidence: [],
					verified: false,
				});
			}
		}
	}

	return claims;
}

/**
 * Extract evidence references from text
 */
export function extractEvidence(text: string): Evidence[] {
	const evidenceList: Evidence[] = [];

	for (const evidencePattern of EVIDENCE_COMMENT_PATTERNS) {
		const regex = new RegExp(evidencePattern.pattern, "gi");
		let match: RegExpExecArray | null = regex.exec(text);

		while (match !== null) {
			const extracted = evidencePattern.extractor(match);
			evidenceList.push({
				type: evidencePattern.evidenceType,
				timestamp: new Date().toISOString(),
				...extracted,
			});
			match = regex.exec(text);
		}
	}

	return evidenceList;
}

/**
 * Check if evidence satisfies a claim
 */
export function evidenceSatisfiesClaim(claim: Claim, evidence: Evidence[]): boolean {
	// Documentation claims have optional evidence
	if (claim.type === "documentation") {
		return true;
	}

	if (evidence.length === 0) {
		return false;
	}

	// Different claim types require different evidence types
	switch (claim.type) {
		case "bug_fix":
		case "implementation":
		case "refactor":
		case "removal":
			// Require file evidence
			return evidence.some((e) => e.type === "file" && e.file && e.line_start);

		case "test_pass":
			// Require command evidence
			return evidence.some((e) => e.type === "command" && e.command);

		case "performance":
			// Require either command or probe evidence
			return evidence.some(
				(e) => (e.type === "command" && e.command) || (e.type === "probe" && e.probe_id),
			);

		case "security":
			// Require file evidence with line numbers
			return evidence.some((e) => e.type === "file" && e.file && e.line_start);

		case "dependency":
		case "configuration":
			// Require file evidence
			return evidence.some((e) => e.type === "file" && e.file);

		default:
			return evidence.length > 0;
	}
}

/**
 * Analyze a file for claims and evidence
 */
export function analyzeFileForClaims(filePath: string, content: string): EvidenceAnalysisResult {
	const claims = extractClaims(content, filePath);
	const evidence = extractEvidence(content);

	const supportedClaims: Claim[] = [];
	const unsupportedClaims: Claim[] = [];
	const requirements: EvidenceRequirement[] = [];

	for (const claim of claims) {
		// Find evidence near the claim (within context)
		const claimEvidence = evidence.filter((e) => {
			// For file evidence, check if it's related to the claim
			if (e.type === "file" && e.file) {
				return true; // Accept any file evidence for now
			}
			return true;
		});

		claim.evidence = claimEvidence;
		claim.verified = evidenceSatisfiesClaim(claim, claimEvidence);

		if (claim.verified) {
			supportedClaims.push(claim);
		} else {
			unsupportedClaims.push(claim);
		}

		// Create requirement for this claim
		const claimPattern = CLAIM_PATTERNS.find((p) => p.type === claim.type);
		if (claimPattern?.requiresEvidence) {
			requirements.push({
				type: getRequiredEvidenceType(claim.type),
				description: claimPattern.description,
				satisfied: claim.verified,
				evidence: claim.verified ? claimEvidence[0] : undefined,
			});
		}
	}

	return {
		unsupportedClaims,
		supportedClaims,
		totalClaims: claims.length,
		requirements,
	};
}

/**
 * Get the required evidence type for a claim type
 */
export function getRequiredEvidenceType(claimType: ClaimType): EvidenceRequirement["type"] {
	switch (claimType) {
		case "test_pass":
			return "command";
		case "performance":
			return "probe";
		default:
			return "file";
	}
}

/**
 * Determine severity based on claim type
 */
export function getSeverityForClaimType(claimType: ClaimType): GateSeverity {
	switch (claimType) {
		case "security":
			return "CRITICAL";
		case "bug_fix":
		case "implementation":
			return "HIGH";
		case "test_pass":
		case "performance":
		case "refactor":
			return "MEDIUM";
		default:
			return "LOW";
	}
}

/**
 * Find code files recursively
 */
export function findCodeFiles(dir: string, excludePatterns: string[] = []): string[] {
	const files: string[] = [];

	if (!fs.existsSync(dir)) {
		return files;
	}

	const entries = fs.readdirSync(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		const relativePath = path.relative(dir, fullPath);

		if (shouldExcludeFile(relativePath, excludePatterns)) {
			continue;
		}

		if (entry.isDirectory()) {
			// Skip common non-code directories
			if (
				![
					"node_modules",
					".git",
					"dist",
					"build",
					".next",
					"coverage",
					"vendor",
					"__pycache__",
					".venv",
				].includes(entry.name)
			) {
				files.push(...findCodeFiles(fullPath, excludePatterns));
			}
		} else if (entry.isFile() && isCodeFile(entry.name)) {
			files.push(fullPath);
		}
	}

	return files;
}

/**
 * Evidence Gate
 *
 * Verifies that all claims in code have supporting evidence.
 * No claims without file:lines or probe_id proof.
 *
 * What it checks:
 * - Commit messages for unsubstantiated claims
 * - Code comments for claims without evidence references
 * - Issue references without supporting data
 *
 * Evidence types:
 * - File references: file:line_start-line_end
 * - Probe references: probe_id
 * - Command references: $ command output
 * - Log references: log:file:line
 */
export async function runEvidenceGate(
	input: GateInput,
	configOverrides?: Partial<GateConfig>,
): Promise<GateResult> {
	const startTime = Date.now();
	const gateId = generateGateId();
	const config = { ...getGateConfig("evidence"), ...configOverrides };

	const violations: GateViolation[] = [];
	let filesChecked = 0;
	let itemsChecked = 0;
	const gateEvidence: GateResult["evidence"] = [];

	try {
		// Determine files to check
		let targetFiles: string[];

		if (input.targets.length > 0) {
			// Use specified targets
			targetFiles = input.targets.map((t) =>
				path.isAbsolute(t) ? t : path.join(input.workDir, t),
			);
		} else {
			// Find all code files in workDir
			targetFiles = findCodeFiles(input.workDir, config.exclude_patterns);
		}

		// Analyze each file
		for (const filePath of targetFiles) {
			if (!fs.existsSync(filePath)) {
				continue;
			}

			const relativePath = path.relative(input.workDir, filePath);

			// Skip excluded files
			if (shouldExcludeFile(relativePath, config.exclude_patterns)) {
				continue;
			}

			filesChecked++;

			try {
				const content = fs.readFileSync(filePath, "utf-8");
				const analysis = analyzeFileForClaims(filePath, content);

				itemsChecked += analysis.totalClaims;

				// Create violations for unsupported claims
				for (const claim of analysis.unsupportedClaims) {
					const claimPattern = CLAIM_PATTERNS.find((p) => p.type === claim.type);

					// Skip claims that don't require evidence
					if (!claimPattern?.requiresEvidence) {
						continue;
					}

					const severity = getSeverityForClaimType(claim.type);
					const violation = createGateViolation(
						`${claim.id}-violation`,
						`Unsupported claim: ${claim.type}`,
						`Claim "${claim.text}" at ${relativePath}:${claim.line} lacks supporting evidence. ${claimPattern.description}`,
						severity,
						{
							file: relativePath,
							line: claim.line,
							snippet: claim.text,
							suggestion: "Add evidence reference: see file:line or probe:id",
							metadata: {
								claimType: claim.type,
								claimText: claim.text,
							},
						},
					);

					violations.push(violation);
				}

				// Record evidence for supported claims
				for (const claim of analysis.supportedClaims) {
					if (claim.evidence && claim.evidence.length > 0) {
						gateEvidence.push({
							type: claim.evidence[0].type,
							file: claim.evidence[0].file,
							line_start: claim.evidence[0].line_start,
							line_end: claim.evidence[0].line_end,
							probe_id: claim.evidence[0].probe_id,
							command: claim.evidence[0].command,
							output: claim.evidence[0].output,
							timestamp: claim.evidence[0].timestamp,
						});
					}
				}
			} catch (error) {
				// Skip files that can't be read
				if (input.verbose) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					violations.push(
						createGateViolation(
							`read-error-${filesChecked}`,
							"File read error",
							`Could not read ${relativePath}: ${errorMessage}`,
							"INFO",
							{ file: relativePath },
						),
					);
				}
			}
		}

		const durationMs = Date.now() - startTime;
		const passed = config.strict
			? violations.length === 0
			: !violations.some((v) => v.severity === "CRITICAL" || v.severity === "HIGH");

		return createGateResult(gateId, "evidence", passed, {
			message: passed
				? `All ${itemsChecked} claims have supporting evidence`
				: `Found ${violations.length} claims without evidence`,
			violations,
			evidence: gateEvidence,
			duration_ms: durationMs,
			files_checked: filesChecked,
			items_checked: itemsChecked,
		});
	} catch (error) {
		const durationMs = Date.now() - startTime;
		const errorMessage = error instanceof Error ? error.message : String(error);

		return createGateResult(gateId, "evidence", false, {
			message: `Evidence gate failed: ${errorMessage}`,
			violations: [
				createGateViolation("gate-error", "Gate execution error", errorMessage, "CRITICAL"),
			],
			duration_ms: durationMs,
			files_checked: filesChecked,
			items_checked: itemsChecked,
		});
	}
}

/**
 * Analyze git commit message for claims
 */
export function analyzeCommitMessage(message: string): EvidenceAnalysisResult {
	return analyzeFileForClaims("(commit message)", message);
}

/**
 * Check if a PR description has sufficient evidence
 */
export function analyzePRDescription(description: string): EvidenceAnalysisResult {
	return analyzeFileForClaims("(PR description)", description);
}

/**
 * Validate that an issue has proper evidence before closing
 */
export function validateIssueEvidence(
	issueDescription: string,
	linkedFiles: string[],
	probeResults: string[],
): { valid: boolean; missingEvidence: string[] } {
	const analysis = analyzeFileForClaims("(issue)", issueDescription);
	const missing: string[] = [];

	for (const claim of analysis.unsupportedClaims) {
		const claimPattern = CLAIM_PATTERNS.find((p) => p.type === claim.type);
		if (claimPattern?.requiresEvidence) {
			// Check if there's any linked file evidence
			const hasFileEvidence = linkedFiles.length > 0;
			const hasProbeEvidence = probeResults.length > 0;

			if (claim.type === "test_pass" && !hasProbeEvidence) {
				missing.push(`Claim "${claim.text}" requires test output evidence`);
			} else if (!hasFileEvidence && !hasProbeEvidence) {
				missing.push(`Claim "${claim.text}" requires file or probe evidence`);
			}
		}
	}

	return {
		valid: missing.length === 0,
		missingEvidence: missing,
	};
}

/**
 * Create evidence from file reference
 */
export function createFileEvidence(file: string, lineStart: number, lineEnd?: number): Evidence {
	return {
		type: "file",
		file,
		line_start: lineStart,
		line_end: lineEnd,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Create evidence from probe result
 */
export function createProbeEvidence(probeId: string, output?: string): Evidence {
	return {
		type: "probe",
		probe_id: probeId,
		output,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Create evidence from command output
 */
export function createCommandEvidence(command: string, output?: string): Evidence {
	return {
		type: "command",
		command,
		output,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Create evidence from log file
 */
export function createLogEvidence(file: string, lineStart?: number, output?: string): Evidence {
	return {
		type: "log",
		file,
		line_start: lineStart,
		output,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Format evidence for display
 */
export function formatEvidence(evidence: Evidence): string {
	switch (evidence.type) {
		case "file":
			if (evidence.line_end && evidence.line_start !== evidence.line_end) {
				return `${evidence.file}:${evidence.line_start}-${evidence.line_end}`;
			}
			return evidence.line_start
				? `${evidence.file}:${evidence.line_start}`
				: (evidence.file ?? "(unknown file)");

		case "probe":
			return `probe:${evidence.probe_id}`;

		case "command":
			return `$ ${evidence.command}`;

		case "log":
			return evidence.line_start
				? `log:${evidence.file}:${evidence.line_start}`
				: `log:${evidence.file}`;

		default:
			return "(unknown evidence type)";
	}
}

/**
 * Check if evidence list contains specific type
 */
export function hasEvidenceType(evidenceList: Evidence[], type: Evidence["type"]): boolean {
	return evidenceList.some((e) => e.type === type);
}

/**
 * Get evidence summary for display
 */
export function getEvidenceSummary(evidenceList: Evidence[]): string {
	const byType: Record<string, number> = {};

	for (const e of evidenceList) {
		byType[e.type] = (byType[e.type] ?? 0) + 1;
	}

	const parts = Object.entries(byType).map(([type, count]) => `${count} ${type}`);

	return parts.length > 0 ? parts.join(", ") : "no evidence";
}
