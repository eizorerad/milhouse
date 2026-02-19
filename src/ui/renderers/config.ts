/**
 * @fileoverview Configuration Display Renderer
 *
 * Handles formatting and rendering of Milhouse configuration
 * to the console. Separates display logic from business logic.
 *
 * @module ui/renderers/config
 * @since 4.4.0
 */

import pc from "picocolors";
import type { MilhouseConfigDisplay } from "../../cli/types.ts";
import { MILHOUSE_BRANDING } from "../../cli/types.ts";
import { configLabels } from "../messages.ts";

/**
 * Configuration rendering options
 */
export interface ConfigRenderOptions {
	/** Path to the config file (for display) */
	configPath?: string;
	/** Use colors in output */
	useColors?: boolean;
	/** Compact output mode */
	compact?: boolean;
}

/**
 * Render a section header
 */
function renderSectionHeader(title: string): string {
	return pc.bold(title);
}

/**
 * Render a field with label and value
 */
function renderField(label: string, value: string | undefined, indent = 2): string {
	const spaces = " ".repeat(indent);
	const displayValue = value || pc.dim(configLabels.placeholders.notSet);
	return `${spaces}${label}:${" ".repeat(Math.max(1, 10 - label.length))}${displayValue}`;
}

/**
 * Render a list item with bullet
 */
function renderListItem(item: string, indent = 2): string {
	const spaces = " ".repeat(indent);
	return `${spaces}• ${item}`;
}

/**
 * Render the project section
 */
function renderProjectSection(project: MilhouseConfigDisplay["project"]): string[] {
	const lines: string[] = [];
	lines.push(renderSectionHeader(configLabels.sections.project + ":"));
	lines.push(
		renderField(configLabels.fields.name, project.name || configLabels.placeholders.unknown),
	);
	if (project.language) {
		lines.push(renderField(configLabels.fields.language, project.language));
	}
	if (project.framework) {
		lines.push(renderField(configLabels.fields.framework, project.framework));
	}
	if (project.description) {
		lines.push(renderField(configLabels.fields.description, project.description));
	}
	return lines;
}

/**
 * Render the commands section
 */
function renderCommandsSection(commands: MilhouseConfigDisplay["commands"]): string[] {
	const lines: string[] = [];
	lines.push(renderSectionHeader(configLabels.sections.commands + ":"));
	lines.push(renderField(configLabels.fields.test, commands.test));
	lines.push(renderField(configLabels.fields.lint, commands.lint));
	lines.push(renderField(configLabels.fields.build, commands.build));
	return lines;
}

/**
 * Render the rules section
 */
function renderRulesSection(rules: string[]): string[] {
	const lines: string[] = [];
	lines.push(renderSectionHeader(configLabels.sections.rules + ":"));
	if (rules.length > 0) {
		for (const rule of rules) {
			lines.push(renderListItem(rule));
		}
	} else {
		lines.push(
			`  ${pc.dim(`(${configLabels.placeholders.noRules.slice(1, -1)} - add with: ${MILHOUSE_BRANDING.shortName} --add-rule "...")`)}`,
		);
	}
	return lines;
}

/**
 * Render the boundaries section
 */
function renderBoundariesSection(boundaries: MilhouseConfigDisplay["boundaries"]): string[] {
	const lines: string[] = [];
	if (boundaries.neverTouch.length > 0) {
		lines.push(renderSectionHeader(configLabels.sections.neverTouch + ":"));
		for (const path of boundaries.neverTouch) {
			lines.push(renderListItem(path));
		}
	}
	return lines;
}

/**
 * Render the full configuration display
 *
 * @param config - Configuration to display
 * @param options - Rendering options
 * @returns Formatted string for console output
 */
export function renderConfig(
	config: MilhouseConfigDisplay,
	options: ConfigRenderOptions = {},
): string {
	const lines: string[] = [];

	// Header
	lines.push("");
	const headerText = `${MILHOUSE_BRANDING.name} Configuration`;
	if (options.configPath) {
		lines.push(`${pc.bold(headerText)} (${options.configPath})`);
	} else {
		lines.push(pc.bold(headerText));
	}
	lines.push("");

	// Project section
	lines.push(...renderProjectSection(config.project));
	lines.push("");

	// Commands section
	lines.push(...renderCommandsSection(config.commands));
	lines.push("");

	// Rules section
	lines.push(...renderRulesSection(config.rules));
	lines.push("");

	// Boundaries section (only if non-empty)
	const boundariesLines = renderBoundariesSection(config.boundaries);
	if (boundariesLines.length > 0) {
		lines.push(...boundariesLines);
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Print configuration to console
 *
 * @param config - Configuration to display
 * @param options - Rendering options
 */
export function printConfig(
	config: MilhouseConfigDisplay,
	options: ConfigRenderOptions = {},
): void {
	console.log(renderConfig(config, options));
}

/**
 * Render a compact single-line config summary
 *
 * @param config - Configuration to summarize
 * @returns Single-line summary string
 */
export function renderConfigSummary(config: MilhouseConfigDisplay): string {
	const parts: string[] = [];

	if (config.project.name) {
		parts.push(config.project.name);
	}
	if (config.project.language) {
		parts.push(config.project.language);
	}
	if (config.project.framework) {
		parts.push(config.project.framework);
	}

	const rulesCount = config.rules.length;
	if (rulesCount > 0) {
		parts.push(`${rulesCount} rule${rulesCount === 1 ? "" : "s"}`);
	}

	return parts.join(" | ");
}

/**
 * Render configuration as JSON (for --json flag support)
 *
 * @param config - Configuration to serialize
 * @param pretty - Whether to pretty-print
 * @returns JSON string
 */
export function renderConfigJson(config: MilhouseConfigDisplay, pretty = true): string {
	return JSON.stringify(config, null, pretty ? 2 : 0);
}
