/**
 * Prompt Validation Utility
 *
 * Validates prompts before sending to AI engines to catch common issues early.
 * This helps prevent wasted API calls and improves debugging.
 *
 * Checks performed:
 * - Minimum length (prompts too short often fail)
 * - Role section presence (## Role: expected for structured prompts)
 * - Role conflicts (wrong role markers)
 * - Duplicate sections (indicates prompt construction bugs)
 */

/**
 * Result of prompt validation
 */
export interface PromptValidationResult {
	/** Whether the prompt passes all critical checks */
	valid: boolean;
	/** Non-blocking issues that may affect quality */
	warnings: string[];
	/** Blocking issues that prevent execution */
	errors: string[];
}

/**
 * Options for prompt validation
 */
export interface PromptValidationOptions {
	/** Expected role marker (e.g., "LI", "IV", "PL", "EX", "TV", "CDM", "PR") */
	expectedRole?: string;
	/** Minimum prompt length (default: 100) */
	minLength?: number;
	/** Whether to check for role section (default: true) */
	checkRoleSection?: boolean;
	/** Whether to check for duplicate sections (default: true) */
	checkDuplicateSections?: boolean;
}

/**
 * Known agent roles
 */
const KNOWN_ROLES = ["LI", "IV", "PL", "EX", "TV", "CDM", "PR"];

/**
 * Section header regex pattern
 */
const SECTION_HEADER_PATTERN = /^##\s+(.+)$/gm;

/**
 * Role section pattern
 */
const ROLE_SECTION_PATTERN = /^##\s+Role:\s*(.+)$/m;

/**
 * Validate a prompt before sending to AI engine
 *
 * @param prompt - The prompt string to validate
 * @param options - Validation options
 * @returns Validation result with errors and warnings
 */
export function validatePrompt(
	prompt: string,
	options: PromptValidationOptions = {},
): PromptValidationResult {
	const {
		expectedRole,
		minLength = 100,
		checkRoleSection = true,
		checkDuplicateSections = true,
	} = options;

	const errors: string[] = [];
	const warnings: string[] = [];

	// Check for null/undefined/non-string
	if (!prompt || typeof prompt !== "string") {
		errors.push("Prompt is empty or not a string");
		return { valid: false, warnings, errors };
	}

	const trimmedPrompt = prompt.trim();

	// Check 1: Minimum length
	if (trimmedPrompt.length < minLength) {
		errors.push(
			`Prompt is too short (${trimmedPrompt.length} chars, minimum ${minLength}). Short prompts often lead to poor AI responses.`,
		);
	}

	// Check 2: Role section presence
	if (checkRoleSection) {
		const roleMatch = trimmedPrompt.match(ROLE_SECTION_PATTERN);
		if (!roleMatch) {
			warnings.push(
				"Prompt does not contain a '## Role:' section. Structured prompts should define the agent role.",
			);
		} else {
			// Check 3: Role conflicts
			if (expectedRole) {
				const foundRole = roleMatch[1].trim();
				const hasExpectedRole =
					foundRole.includes(`(${expectedRole})`) || foundRole.startsWith(expectedRole);

				if (!hasExpectedRole) {
					// Check if any other known role is present instead
					const otherRoles = KNOWN_ROLES.filter((r) => r !== expectedRole);
					for (const otherRole of otherRoles) {
						if (foundRole.includes(`(${otherRole})`) || foundRole.startsWith(otherRole)) {
							errors.push(
								`Role conflict detected: Expected role '${expectedRole}' but found '${otherRole}' in prompt. This indicates a prompt construction bug.`,
							);
							break;
						}
					}
				}
			}
		}
	}

	// Check 4: Duplicate sections
	if (checkDuplicateSections) {
		const sections = extractSectionHeaders(trimmedPrompt);
		const duplicates = findDuplicates(sections);
		if (duplicates.length > 0) {
			warnings.push(
				`Duplicate sections found: ${duplicates.join(", ")}. This may indicate prompt construction issues.`,
			);
		}
	}

	// Check 5: Empty sections (## Header followed immediately by another ## Header)
	const emptySections = detectEmptySections(trimmedPrompt);
	if (emptySections.length > 0) {
		warnings.push(
			`Empty sections found: ${emptySections.join(", ")}. Sections should have content.`,
		);
	}

	// Check 6: Unbalanced code blocks
	const codeBlockCount = (trimmedPrompt.match(/```/g) || []).length;
	if (codeBlockCount % 2 !== 0) {
		warnings.push(
			"Unbalanced code blocks (odd number of ``` markers). This may cause parsing issues.",
		);
	}

	return {
		valid: errors.length === 0,
		warnings,
		errors,
	};
}

/**
 * Extract section headers from prompt
 */
function extractSectionHeaders(prompt: string): string[] {
	const headers: string[] = [];
	let match: RegExpExecArray | null;

	const pattern = new RegExp(SECTION_HEADER_PATTERN.source, "gm");
	while ((match = pattern.exec(prompt)) !== null) {
		headers.push(match[1].trim());
	}

	return headers;
}

/**
 * Find duplicates in an array
 */
function findDuplicates(arr: string[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();

	for (const item of arr) {
		const normalized = item.toLowerCase();
		if (seen.has(normalized)) {
			duplicates.add(item);
		}
		seen.add(normalized);
	}

	return Array.from(duplicates);
}

/**
 * Detect empty sections (header with no content before next header)
 */
function detectEmptySections(prompt: string): string[] {
	const emptySections: string[] = [];
	const lines = prompt.split("\n");

	for (let i = 0; i < lines.length - 1; i++) {
		const currentLine = lines[i].trim();
		const headerMatch = currentLine.match(/^##\s+(.+)$/);

		if (headerMatch) {
			// Check if next non-empty line is also a header
			let j = i + 1;
			while (j < lines.length && lines[j].trim() === "") {
				j++;
			}

			if (j < lines.length) {
				const nextNonEmpty = lines[j].trim();
				if (nextNonEmpty.match(/^##\s+/)) {
					emptySections.push(headerMatch[1].trim());
				}
			}
		}
	}

	return emptySections;
}

/**
 * Quick check if a prompt is valid (no errors)
 */
export function isPromptValid(prompt: string, options?: PromptValidationOptions): boolean {
	return validatePrompt(prompt, options).valid;
}

/**
 * Validate and throw if invalid (for strict mode)
 */
export function validatePromptOrThrow(prompt: string, options?: PromptValidationOptions): void {
	const result = validatePrompt(prompt, options);
	if (!result.valid) {
		throw new Error(`Invalid prompt: ${result.errors.join("; ")}`);
	}
}

/**
 * Format validation result for logging
 */
export function formatValidationResult(result: PromptValidationResult): string {
	const lines: string[] = [];

	if (result.valid) {
		lines.push("✓ Prompt validation passed");
	} else {
		lines.push("✗ Prompt validation failed");
	}

	if (result.errors.length > 0) {
		lines.push("\nErrors:");
		for (const error of result.errors) {
			lines.push(`  ✗ ${error}`);
		}
	}

	if (result.warnings.length > 0) {
		lines.push("\nWarnings:");
		for (const warning of result.warnings) {
			lines.push(`  ⚠ ${warning}`);
		}
	}

	return lines.join("\n");
}

/**
 * Get role from prompt
 */
export function extractRoleFromPrompt(prompt: string): string | null {
	const match = prompt.match(ROLE_SECTION_PATTERN);
	if (!match) {
		return null;
	}

	const roleText = match[1].trim();

	// Try to extract role code from parentheses (e.g., "Lead Investigator (LI)")
	const parenMatch = roleText.match(/\(([A-Z]+)\)/);
	if (parenMatch) {
		return parenMatch[1];
	}

	// Try to match known roles at start
	for (const role of KNOWN_ROLES) {
		if (roleText.startsWith(role)) {
			return role;
		}
	}

	return null;
}

/**
 * Check if prompt contains expected output format section
 */
export function hasOutputFormatSection(prompt: string): boolean {
	return /##\s+Output\s+Format/i.test(prompt);
}

/**
 * Check if prompt contains task section
 */
export function hasTaskSection(prompt: string): boolean {
	return /##\s+Task\b/i.test(prompt);
}

/**
 * Check if prompt contains guidelines section
 */
export function hasGuidelinesSection(prompt: string): boolean {
	return /##\s+Guidelines/i.test(prompt);
}
