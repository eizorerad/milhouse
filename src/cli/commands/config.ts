/**
 * @fileoverview Milhouse Configuration Command
 *
 * Handles the --config command to display and modify Milhouse configuration.
 * Uses the config service for business logic and renderers for output.
 *
 * @module cli/commands/config
 * @since 4.4.0
 */

import { type ConfigService, getConfigService } from "../../services/config/ConfigService.ts";
import { logError, logSuccess, logWarn } from "../../ui/logger.ts";
import { configMessages, errorMessages } from "../../ui/messages.ts";
import { printConfig } from "../../ui/renderers/config.ts";
import type { MilhouseConfigDisplay } from "../types.ts";

/**
 * Options for config command
 */
export interface ConfigCommandOptions {
	/** Working directory */
	workDir?: string;
	/** Rule to add */
	addRule?: string;
}

/**
 * Result of config command
 */
export interface ConfigCommandResult {
	/** Whether the command succeeded */
	success: boolean;
	/** Human-readable message */
	message?: string;
	/** Error details */
	error?: string;
	/** Configuration data (if showing) */
	config?: MilhouseConfigDisplay;
	/** Rule that was added */
	addedRule?: string;
	/** Path to config file */
	configPath?: string;
}

/**
 * Transform internal config to display format
 */
function toDisplayConfig(
	config: ReturnType<ConfigService["getConfig"]>,
): MilhouseConfigDisplay | null {
	if (!config) return null;

	return {
		project: {
			name: config.project.name || "Unknown",
			language: config.project.language || undefined,
			framework: config.project.framework || undefined,
			description: config.project.description || undefined,
		},
		commands: {
			test: config.commands.test || undefined,
			lint: config.commands.lint || undefined,
			build: config.commands.build || undefined,
		},
		rules: config.rules,
		boundaries: {
			neverTouch: config.boundaries.never_touch,
		},
	};
}

/**
 * Handle --config command (show configuration)
 *
 * @param workDir - Working directory
 * @returns Command result
 */
export async function showConfig(workDir = process.cwd()): Promise<ConfigCommandResult> {
	const service = getConfigService(workDir);

	// Check if initialized
	if (!service.isInitialized()) {
		logWarn(configMessages.notInitialized);
		return {
			success: false,
			error: "Not initialized",
			message: configMessages.notInitialized,
		};
	}

	// Load config
	const config = service.getConfig();
	if (!config) {
		logError(configMessages.loadFailed);
		return {
			success: false,
			error: "Failed to load config",
			message: configMessages.loadFailed,
		};
	}

	// Transform and display
	const displayConfig = toDisplayConfig(config);
	if (!displayConfig) {
		logError(configMessages.loadFailed);
		return {
			success: false,
			error: "Failed to transform config",
			message: configMessages.loadFailed,
		};
	}

	// Render output
	printConfig(displayConfig, { configPath: service.getConfigPath() });

	return {
		success: true,
		config: displayConfig,
		configPath: service.getConfigPath(),
		message: "Configuration displayed",
	};
}

/**
 * Handle --add-rule command
 *
 * @param rule - Rule text to add
 * @param workDir - Working directory
 * @returns Command result
 */
export async function addRule(rule: string, workDir = process.cwd()): Promise<ConfigCommandResult> {
	const service = getConfigService(workDir);

	// Check if initialized
	if (!service.isInitialized()) {
		logError(configMessages.notInitialized);
		return {
			success: false,
			error: "Not initialized",
			message: configMessages.notInitialized,
		};
	}

	// Add rule via service
	const result = service.addRule(rule);

	if (!result.success) {
		const errorMsg =
			"type" in result.error && result.error.type === "invalid_rule"
				? configMessages.invalidRule
				: errorMessages.operationFailed({ operation: "Add rule", reason: String(result.error) });

		logError(errorMsg);
		return {
			success: false,
			error: String(result.error),
			message: errorMsg,
		};
	}

	// Success
	const successMsg = configMessages.ruleAdded({ rule });
	logSuccess(successMsg);

	return {
		success: true,
		addedRule: rule,
		message: successMsg,
	};
}

/**
 * Main config command handler
 *
 * Routes to appropriate sub-command based on options.
 *
 * @param options - Command options
 * @returns Command result
 */
export async function configCommand(
	options: ConfigCommandOptions = {},
): Promise<ConfigCommandResult> {
	const workDir = options.workDir ?? process.cwd();

	if (options.addRule) {
		return addRule(options.addRule, workDir);
	}

	return showConfig(workDir);
}
