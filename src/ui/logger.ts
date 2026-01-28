import pc from "picocolors";
import { loggers } from "../observability";

let verboseMode = false;

/**
 * Set verbose mode
 */
export function setVerbose(verbose: boolean): void {
	verboseMode = verbose;
}

/**
 * Check if verbose mode is enabled
 */
export function isVerbose(): boolean {
	return verboseMode;
}

/**
 * Log info message
 */
export function logInfo(...args: unknown[]): void {
	console.log(pc.blue("[INFO]"), ...args);
	loggers.cli.info({ args }, args.join(" "));
}

/**
 * Log success message
 */
export function logSuccess(...args: unknown[]): void {
	console.log(pc.green("[OK]"), ...args);
	loggers.cli.info({ success: true, args }, args.join(" "));
}

/**
 * Log warning message
 */
export function logWarn(...args: unknown[]): void {
	console.log(pc.yellow("[WARN]"), ...args);
	loggers.cli.warn({ args }, args.join(" "));
}

/**
 * Log error message
 */
export function logError(...args: unknown[]): void {
	console.error(pc.red("[ERROR]"), ...args);
	loggers.cli.error({ args }, args.join(" "));
}

/**
 * Log debug message (only in verbose mode)
 */
export function logDebug(...args: unknown[]): void {
	if (verboseMode) {
		console.log(pc.dim("[DEBUG]"), ...args);
	}
	loggers.cli.debug({ args }, args.join(" "));
}

/**
 * Format a task name for display (truncate if too long)
 */
export function formatTask(task: string, maxLen = 40): string {
	if (task.length <= maxLen) return task;
	return `${task.slice(0, maxLen - 3)}...`;
}

/**
 * Format duration in human readable format
 */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const secs = Math.floor(ms / 1000);
	const mins = Math.floor(secs / 60);
	const remainingSecs = secs % 60;
	if (mins === 0) return `${secs}s`;
	return `${mins}m ${remainingSecs}s`;
}

/**
 * Format token count
 */
export function formatTokens(input: number, output: number): string {
	const total = input + output;
	if (total === 0) return "";
	return pc.dim(`(${input.toLocaleString()} in / ${output.toLocaleString()} out)`);
}
