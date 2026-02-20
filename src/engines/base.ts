import type { ProgressCallback } from "./types.ts";

/**
 * Detailed step information from AI engine output
 */
export interface DetailedStep {
	/** Category of the action */
	category:
		| "reading"
		| "writing"
		| "testing"
		| "linting"
		| "command"
		| "committing"
		| "staging"
		| "thinking";
	/** Full detail (e.g., full file path or command) */
	detail?: string;
	/** Short detail for compact display (e.g., just filename) */
	shortDetail?: string;
	/** Whether this is a test file */
	isTestFile?: boolean;
}

/**
 * Format a DetailedStep for display in the terminal
 * @param step The detailed step to format
 * @param mode Display mode: "compact" shows short version, "full" shows detail
 */
export function formatStepForDisplay(
	step: DetailedStep,
	mode: "compact" | "full" = "compact",
): string {
	const categoryLabels: Record<DetailedStep["category"], string> = {
		reading: "Reading",
		writing: "Writing",
		testing: "Testing",
		linting: "Linting",
		command: "Running",
		committing: "Committing",
		staging: "Staging",
		thinking: "Thinking",
	};

	const label = categoryLabels[step.category];

	if (mode === "full" && step.detail) {
		return `${label} ${step.detail}`;
	}

	if (step.shortDetail) {
		return `${label} ${step.shortDetail}`;
	}

	return label;
}
