/**
 * @fileoverview Centralized User-Facing Messages
 *
 * All user-facing strings for the Milhouse CLI are defined here.
 * This enables:
 * - Consistent messaging across the application
 * - Easy localization if needed
 * - Clear separation of UI text from business logic
 * - Reduced similarity with other CLI tools
 *
 * @module ui/messages
 * @since 4.4.0
 */

import { MILHOUSE_BRANDING } from "../cli/types.ts";

/**
 * Message templates with parameter substitution support
 */
type MessageTemplate<T extends Record<string, unknown> = Record<string, never>> = T extends Record<
	string,
	never
>
	? string
	: (params: T) => string;

/**
 * Platform and binary resolution messages
 */
export const platformMessages = {
	/** Unsupported platform error */
	unsupportedPlatform: (params: { platform: string; arch: string }) =>
		`Platform not supported: ${params.platform} (${params.arch}). Milhouse requires macOS, Linux, or Windows.`,

	/** Binary not found error */
	binaryNotFound: (params: { path: string }) => `Compiled binary not available at: ${params.path}`,

	/** Development mode fallback hint */
	devModeFallback: "Running in development mode. For production, build with: bun run build",

	/** Missing runtime error */
	missingRuntime: "No compatible runtime found. Install one of: bun (recommended), tsx, or node",

	/** Build instructions */
	buildInstructions: "To compile for your platform, run: bun run build",

	/** Runtime installation hint */
	runtimeInstallHint: "For development, install bun: https://bun.sh or tsx: npm install -g tsx",
} as const;

/**
 * Configuration-related messages
 */
export const configMessages = {
	/** Config not initialized warning */
	notInitialized: `Configuration not found. Initialize with: ${MILHOUSE_BRANDING.shortName} --init`,

	/** Config load failure */
	loadFailed: "Unable to read configuration file. Check file permissions and YAML syntax.",

	/** Config save failure */
	saveFailed: (params: { reason: string }) => `Failed to save configuration: ${params.reason}`,

	/** Config file created */
	created: (params: { path: string }) => `Configuration created at: ${params.path}`,

	/** Config already exists */
	alreadyExists: (params: { path: string }) =>
		`Configuration already exists at: ${params.path}. Use --force to overwrite.`,

	/** Rule added successfully */
	ruleAdded: (params: { rule: string }) => `Rule added: "${params.rule}"`,

	/** No rules configured hint */
	noRulesHint: `No rules configured. Add with: ${MILHOUSE_BRANDING.shortName} --add-rule "your rule"`,

	/** Invalid rule format */
	invalidRule: "Rule cannot be empty. Provide a meaningful instruction for the AI.",

	/** Config directory info */
	configDirInfo: (params: { dir: string }) => `Milhouse configuration directory: ${params.dir}`,
} as const;

/**
 * Initialization messages
 */
export const initMessages = {
	/** Initialization started */
	starting: "Initializing Milhouse configuration...",

	/** Project detected */
	projectDetected: (params: { name: string; language: string; framework?: string }) =>
		`Detected: ${params.name} (${params.language}${params.framework ? `, ${params.framework}` : ""})`,

	/** Initialization complete */
	complete: (params: { configPath: string }) =>
		`Milhouse initialized. Configuration: ${params.configPath}`,

	/** Directories created */
	directoriesCreated: (params: { count: number }) =>
		`Created ${params.count} directories for state management`,

	/** Already initialized */
	alreadyInitialized: `Project already initialized. Use ${MILHOUSE_BRANDING.shortName} --config to view settings.`,
} as const;

/**
 * Error messages for various failure scenarios
 */
export const errorMessages = {
	/** Generic operation failed */
	operationFailed: (params: { operation: string; reason: string }) =>
		`${params.operation} failed: ${params.reason}`,

	/** File not found */
	fileNotFound: (params: { path: string }) => `File not found: ${params.path}`,

	/** Permission denied */
	permissionDenied: (params: { path: string }) => `Permission denied: ${params.path}`,

	/** Invalid YAML syntax */
	invalidYaml: (params: { file: string; line?: number }) =>
		`Invalid YAML in ${params.file}${params.line ? ` at line ${params.line}` : ""}`,

	/** Git not available */
	gitNotAvailable:
		"Git is not installed or not in PATH. Milhouse requires Git for version control operations.",

	/** Not a git repository */
	notGitRepo: "Current directory is not a Git repository. Initialize with: git init",

	/** GitHub CLI not available */
	ghNotAvailable:
		"GitHub CLI (gh) is not installed. Required for PR operations. Install: https://cli.github.com",

	/** Unexpected error */
	unexpected: (params: { message: string }) =>
		`Unexpected error: ${params.message}. Please report this issue.`,
} as const;

/**
 * Success messages for completed operations
 */
export const successMessages = {
	/** Generic success */
	operationComplete: (params: { operation: string }) =>
		`${params.operation} completed successfully`,

	/** Config updated */
	configUpdated: "Configuration updated",

	/** Task completed */
	taskCompleted: (params: { taskId: string }) => `Task ${params.taskId} completed`,

	/** Pipeline phase complete */
	phaseComplete: (params: { phase: string; duration: number }) =>
		`${params.phase} phase completed in ${params.duration}ms`,
} as const;

/**
 * Warning messages for non-critical issues
 */
export const warningMessages = {
	/** Config missing optional field */
	missingOptionalField: (params: { field: string }) =>
		`Optional configuration field not set: ${params.field}`,

	/** Deprecated feature */
	deprecated: (params: { feature: string; alternative: string }) =>
		`${params.feature} is deprecated. Use ${params.alternative} instead.`,

	/** Skipping operation */
	skipping: (params: { operation: string; reason: string }) =>
		`Skipping ${params.operation}: ${params.reason}`,
} as const;

/**
 * Help and hint messages
 */
export const helpMessages = {
	/** Getting started hint */
	gettingStarted: `Get started with: ${MILHOUSE_BRANDING.shortName} --init`,

	/** Documentation link */
	documentation: `Documentation: ${MILHOUSE_BRANDING.docsUrl}`,

	/** Report issue hint */
	reportIssue: `Report issues: ${MILHOUSE_BRANDING.repoUrl}/issues`,

	/** Version info */
	version: (params: { version: string }) => `${MILHOUSE_BRANDING.name} v${params.version}`,
} as const;

/**
 * Deprecation warning messages
 * @since 4.5.0
 */
export const deprecationMessages = {
	/** Generic flag deprecation warning */
	flagDeprecated: (params: { oldFlag: string; newFlag: string }) =>
		`Warning: ${params.oldFlag} is deprecated. Use ${params.newFlag} instead.`,

	/** Flag deprecation with removal version */
	flagDeprecatedWithVersion: (params: {
		oldFlag: string;
		newFlag: string;
		version: string;
	}) =>
		`Warning: ${params.oldFlag} is deprecated and will be removed in v${params.version}. Use ${params.newFlag} instead.`,

	/** Suppress warnings hint */
	suppressHint: "Use --no-deprecation-warnings to suppress these messages.",

	/** Flag migration guide */
	migrationGuide: `
Flag Migration Guide (v4.5.0):
  --parallel        → --workers
  --max-parallel    → --workers <n>
  --prd             → --input or --tasks
  --create-pr       → --pr
  --draft-pr        → --pr --draft
  --branch-per-task → --isolate or --worktree-per-task
`,
} as const;

/**
 * Labels for configuration display
 */
export const configLabels = {
	/** Section headers */
	sections: {
		project: "Project",
		commands: "Commands",
		rules: "Rules",
		boundaries: "Boundaries",
		neverTouch: "Protected Paths",
	},

	/** Field labels */
	fields: {
		name: "Name",
		language: "Language",
		framework: "Framework",
		description: "Description",
		test: "Test",
		lint: "Lint",
		build: "Build",
	},

	/** Placeholder text */
	placeholders: {
		notSet: "(not configured)",
		unknown: "Unknown",
		noRules: "(no rules defined)",
		noBoundaries: "(no protected paths)",
	},
} as const;

/**
 * Format a message template with parameters
 */
export function formatMessage<T extends Record<string, unknown>>(
	template: MessageTemplate<T>,
	params?: T,
): string {
	if (typeof template === "function") {
		return template(params as T);
	}
	return template;
}

/**
 * All messages grouped by category for easy access
 */
export const messages = {
	platform: platformMessages,
	config: configMessages,
	init: initMessages,
	error: errorMessages,
	success: successMessages,
	warning: warningMessages,
	help: helpMessages,
	deprecation: deprecationMessages,
	labels: configLabels,
} as const;

export default messages;
