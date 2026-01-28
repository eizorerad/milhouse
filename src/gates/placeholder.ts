import * as fs from "node:fs";
import * as path from "node:path";
import {
	DEFAULT_PLACEHOLDER_PATTERNS,
	type GateConfig,
	type GateInput,
	type GateResult,
	type GateSeverity,
	type GateViolation,
	type PlaceholderPattern,
	createGateResult,
	createGateViolation,
	getGateConfig,
	isCodeFile,
	shouldExcludeFile,
} from "./types.ts";

/**
 * Placeholder match - a detected placeholder in code
 */
export interface PlaceholderMatch {
	/** Pattern that matched */
	pattern: PlaceholderPattern;
	/** File where the placeholder was found */
	file: string;
	/** Line number */
	line: number;
	/** Column position */
	column: number;
	/** The actual matched content */
	matchedContent: string;
	/** Surrounding context (line content) */
	context: string;
}

/**
 * Configuration options for placeholder gate
 */
export interface PlaceholderGateOptions {
	/** Whether to allow placeholders in test files */
	allowInTests: boolean;
	/** Custom patterns to detect */
	patterns: PlaceholderPattern[];
	/** File extensions to check */
	fileExtensions: string[];
	/** Whether to check for .skip() and .only() in tests */
	checkTestModifiers: boolean;
}

/**
 * Default placeholder gate options
 */
export const DEFAULT_PLACEHOLDER_OPTIONS: PlaceholderGateOptions = {
	allowInTests: false,
	patterns: DEFAULT_PLACEHOLDER_PATTERNS,
	fileExtensions: [
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
		".swift",
		".c",
		".cpp",
		".h",
		".hpp",
		".cs",
		".rb",
		".php",
	],
	checkTestModifiers: true,
};

/**
 * Patterns that indicate a file is a test file
 */
const TEST_FILE_PATTERNS = [
	/\.test\.[tj]sx?$/,
	/\.spec\.[tj]sx?$/,
	/_test\.[tj]sx?$/,
	/_spec\.[tj]sx?$/,
	/\.test\.py$/,
	/_test\.py$/,
	/test_.*\.py$/,
	/\.test\.go$/,
	/_test\.go$/,
	/\.test\.rs$/,
	/Test\.java$/,
	/\.test\.rb$/,
	/_spec\.rb$/,
];

/**
 * Directories that indicate test code
 */
const TEST_DIRECTORIES = [
	"__tests__",
	"test",
	"tests",
	"spec",
	"specs",
	"__mocks__",
	"__fixtures__",
	"fixtures",
];

/**
 * Generate a unique gate ID
 */
export function generateGateId(): string {
	const timestamp = Date.now();
	const random = Math.random().toString(36).substring(2, 8);
	return `placeholder-${timestamp}-${random}`;
}

/**
 * Check if a file is a test file
 */
export function isTestFile(filePath: string): boolean {
	const fileName = path.basename(filePath);
	const dirPath = path.dirname(filePath);

	// Check filename patterns
	for (const pattern of TEST_FILE_PATTERNS) {
		if (pattern.test(fileName)) {
			return true;
		}
	}

	// Check if in test directory
	const dirParts = dirPath.split(path.sep);
	for (const part of dirParts) {
		if (TEST_DIRECTORIES.includes(part.toLowerCase())) {
			return true;
		}
	}

	return false;
}

/**
 * Compile a pattern to regex
 */
export function compilePattern(pattern: PlaceholderPattern): RegExp {
	if (pattern.isRegex) {
		return new RegExp(pattern.pattern, "gi");
	}
	// Escape special regex characters for literal string match
	const escaped = pattern.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(escaped, "gi");
}

/**
 * Find placeholders in file content
 */
export function findPlaceholdersInContent(
	content: string,
	filePath: string,
	patterns: PlaceholderPattern[],
): PlaceholderMatch[] {
	const matches: PlaceholderMatch[] = [];
	const lines = content.split("\n");

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const lineNumber = lineIndex + 1;

		for (const pattern of patterns) {
			const regex = compilePattern(pattern);
			let match: RegExpExecArray | null = regex.exec(line);

			while (match !== null) {
				matches.push({
					pattern,
					file: filePath,
					line: lineNumber,
					column: match.index + 1,
					matchedContent: match[0],
					context: line.trim(),
				});
				match = regex.exec(line);
			}
		}
	}

	return matches;
}

/**
 * Filter patterns for test files
 */
export function getPatternForContext(
	patterns: PlaceholderPattern[],
	isTest: boolean,
	checkTestModifiers: boolean,
): PlaceholderPattern[] {
	if (isTest) {
		// In test files, filter out .skip() and .only() patterns if not checking test modifiers
		if (!checkTestModifiers) {
			return patterns.filter((p) => !p.pattern.includes(".skip") && !p.pattern.includes(".only"));
		}
	}
	return patterns;
}

/**
 * Get severity for a placeholder match
 */
export function getSeverityForMatch(match: PlaceholderMatch): GateSeverity {
	// Use the pattern's configured severity
	return match.pattern.severity;
}

/**
 * Get suggestion for fixing a placeholder
 */
export function getSuggestionForMatch(match: PlaceholderMatch): string {
	const patternType = match.pattern.description?.toLowerCase() ?? "";

	if (patternType.includes("todo") || patternType.includes("fixme")) {
		return "Address the TODO/FIXME comment and remove the placeholder";
	}

	if (patternType.includes("hack") || patternType.includes("xxx")) {
		return "Refactor the hack to a proper implementation";
	}

	if (patternType.includes("not implemented")) {
		return "Implement the functionality instead of throwing an error";
	}

	if (patternType.includes("placeholder return")) {
		return "Replace the placeholder return with actual implementation";
	}

	if (patternType.includes("test skip")) {
		return "Remove .skip() and fix the test or delete it if no longer needed";
	}

	if (patternType.includes("test only")) {
		return "Remove .only() before committing - tests should run completely";
	}

	return "Remove or replace the placeholder with actual implementation";
}

/**
 * Find code files recursively
 */
export function findCodeFilesRecursive(
	dir: string,
	excludePatterns: string[],
	fileExtensions: string[],
): string[] {
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
				files.push(...findCodeFilesRecursive(fullPath, excludePatterns, fileExtensions));
			}
		} else if (entry.isFile()) {
			const ext = path.extname(entry.name).toLowerCase();
			if (fileExtensions.includes(ext) || isCodeFile(entry.name)) {
				files.push(fullPath);
			}
		}
	}

	return files;
}

/**
 * Placeholder Gate
 *
 * Detects and blocks placeholder code that shouldn't be committed:
 * - TODO and FIXME comments
 * - HACK and XXX markers
 * - "Not implemented" errors
 * - Placeholder return values (return true/false/null with placeholder comment)
 * - Test .skip() and .only() calls
 *
 * Purpose: Ensure that all code is complete and production-ready
 * before being committed. Placeholders indicate incomplete work
 * that should be addressed before merge.
 */
export async function runPlaceholderGate(
	input: GateInput,
	configOverrides?: Partial<GateConfig>,
): Promise<GateResult> {
	const startTime = Date.now();
	const gateId = generateGateId();
	const config = { ...getGateConfig("placeholder"), ...configOverrides };

	// Build options, ensuring patterns are proper PlaceholderPattern objects
	const configOptions = config.options as Partial<PlaceholderGateOptions>;
	const options: PlaceholderGateOptions = {
		...DEFAULT_PLACEHOLDER_OPTIONS,
		...configOptions,
		// Always use DEFAULT_PLACEHOLDER_PATTERNS unless explicitly overridden with proper pattern objects
		patterns:
			configOptions?.patterns &&
			Array.isArray(configOptions.patterns) &&
			configOptions.patterns.length > 0
				? typeof configOptions.patterns[0] === "object" && "pattern" in configOptions.patterns[0]
					? (configOptions.patterns as PlaceholderPattern[])
					: DEFAULT_PLACEHOLDER_PATTERNS
				: DEFAULT_PLACEHOLDER_PATTERNS,
	};

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
			targetFiles = findCodeFilesRecursive(
				input.workDir,
				config.exclude_patterns,
				options.fileExtensions,
			);
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

			// Check if this is a test file
			const fileIsTest = isTestFile(relativePath);

			// Skip test files if allowed
			if (fileIsTest && options.allowInTests) {
				continue;
			}

			filesChecked++;

			try {
				const content = fs.readFileSync(filePath, "utf-8");

				// Get appropriate patterns for this file context
				const patternsToUse = getPatternForContext(
					options.patterns,
					fileIsTest,
					options.checkTestModifiers,
				);

				// Find placeholders
				const matches = findPlaceholdersInContent(content, relativePath, patternsToUse);

				itemsChecked += matches.length;

				// Create violations for each match
				for (const match of matches) {
					const severity = getSeverityForMatch(match);
					const suggestion = getSuggestionForMatch(match);
					const description = match.pattern.description ?? "Placeholder detected";

					const violation = createGateViolation(
						`placeholder-${match.file}-${match.line}-${match.column}`,
						description,
						`Found "${match.matchedContent}" at ${relativePath}:${match.line}:${match.column}`,
						severity,
						{
							file: relativePath,
							line: match.line,
							snippet: match.context,
							suggestion,
							metadata: {
								pattern: match.pattern.pattern,
								matchedContent: match.matchedContent,
								column: match.column,
								isTestFile: fileIsTest,
							},
						},
					);

					violations.push(violation);
				}

				// Record file as checked in evidence
				if (matches.length > 0) {
					gateEvidence.push({
						type: "file",
						file: relativePath,
						line_start: matches[0].line,
						timestamp: new Date().toISOString(),
					});
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

		return createGateResult(gateId, "placeholder", passed, {
			message: passed
				? `Checked ${filesChecked} files with no placeholders found`
				: `Found ${violations.length} placeholders in ${filesChecked} files`,
			violations,
			evidence: gateEvidence,
			duration_ms: durationMs,
			files_checked: filesChecked,
			items_checked: itemsChecked,
		});
	} catch (error) {
		const durationMs = Date.now() - startTime;
		const errorMessage = error instanceof Error ? error.message : String(error);

		return createGateResult(gateId, "placeholder", false, {
			message: `Placeholder gate failed: ${errorMessage}`,
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
 * Check a single file for placeholders
 */
export async function checkFileForPlaceholders(
	filePath: string,
	options?: Partial<PlaceholderGateOptions>,
): Promise<PlaceholderMatch[]> {
	const fullOptions: PlaceholderGateOptions = {
		...DEFAULT_PLACEHOLDER_OPTIONS,
		...options,
	};

	if (!fs.existsSync(filePath)) {
		return [];
	}

	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const fileIsTest = isTestFile(filePath);

		// Skip if test file and allowed
		if (fileIsTest && fullOptions.allowInTests) {
			return [];
		}

		const patternsToUse = getPatternForContext(
			fullOptions.patterns,
			fileIsTest,
			fullOptions.checkTestModifiers,
		);

		return findPlaceholdersInContent(content, filePath, patternsToUse);
	} catch {
		return [];
	}
}

/**
 * Check content string for placeholders
 */
export function checkContentForPlaceholders(
	content: string,
	options?: Partial<PlaceholderGateOptions>,
): PlaceholderMatch[] {
	const fullOptions: PlaceholderGateOptions = {
		...DEFAULT_PLACEHOLDER_OPTIONS,
		...options,
	};

	return findPlaceholdersInContent(content, "(inline)", fullOptions.patterns);
}

/**
 * Get placeholder summary for display
 */
export function getPlaceholderSummary(matches: PlaceholderMatch[]): {
	total: number;
	bySeverity: Record<GateSeverity, number>;
	byType: Record<string, number>;
	files: string[];
} {
	const bySeverity: Record<GateSeverity, number> = {
		CRITICAL: 0,
		HIGH: 0,
		MEDIUM: 0,
		LOW: 0,
		WARNING: 0,
		INFO: 0,
	};

	const byType: Record<string, number> = {};
	const filesSet = new Set<string>();

	for (const match of matches) {
		bySeverity[match.pattern.severity]++;
		const typeKey = match.pattern.description ?? "unknown";
		byType[typeKey] = (byType[typeKey] ?? 0) + 1;
		filesSet.add(match.file);
	}

	return {
		total: matches.length,
		bySeverity,
		byType,
		files: Array.from(filesSet),
	};
}

/**
 * Format placeholder summary for display
 */
export function formatPlaceholderSummary(matches: PlaceholderMatch[]): string {
	const summary = getPlaceholderSummary(matches);
	const lines: string[] = [];

	lines.push(`Total placeholders: ${summary.total}`);
	lines.push(`Files affected: ${summary.files.length}`);

	const severityCounts = Object.entries(summary.bySeverity)
		.filter(([, count]) => count > 0)
		.map(([severity, count]) => `${severity}: ${count}`)
		.join(", ");

	if (severityCounts) {
		lines.push(`By severity: ${severityCounts}`);
	}

	const typeCounts = Object.entries(summary.byType)
		.filter(([, count]) => count > 0)
		.map(([type, count]) => `${type}: ${count}`)
		.join(", ");

	if (typeCounts) {
		lines.push(`By type: ${typeCounts}`);
	}

	return lines.join("\n");
}

/**
 * Create a custom placeholder pattern
 */
export function createPlaceholderPattern(
	pattern: string,
	options?: {
		isRegex?: boolean;
		severity?: GateSeverity;
		description?: string;
	},
): PlaceholderPattern {
	return {
		pattern,
		isRegex: options?.isRegex ?? false,
		severity: options?.severity ?? "HIGH",
		description: options?.description,
	};
}

/**
 * Merge custom patterns with defaults
 */
export function mergePatterns(
	customPatterns: PlaceholderPattern[],
	includeDefaults = true,
): PlaceholderPattern[] {
	if (includeDefaults) {
		return [...DEFAULT_PLACEHOLDER_PATTERNS, ...customPatterns];
	}
	return customPatterns;
}
