import { loggers } from "../observability";

// User-facing output functions (pretty terminal output)
// These wrap both console output AND pino logging

export const output = {
	// Informational messages
	info: (message: string, data?: Record<string, unknown>) => {
		console.log(`ℹ ${message}`);
		loggers.cli.info(data || {}, message);
	},

	// Success messages
	success: (message: string, data?: Record<string, unknown>) => {
		console.log(`✓ ${message}`);
		loggers.cli.info({ success: true, ...data }, message);
	},

	// Warning messages
	warn: (message: string, data?: Record<string, unknown>) => {
		console.warn(`⚠ ${message}`);
		loggers.cli.warn(data || {}, message);
	},

	// Error messages
	error: (message: string, error?: Error, data?: Record<string, unknown>) => {
		console.error(`✗ ${message}`);
		if (error) {
			console.error(`  ${error.message}`);
		}
		loggers.cli.error({ err: error, ...data }, message);
	},

	// Debug messages (only in verbose mode)
	debug: (message: string, data?: Record<string, unknown>) => {
		if (process.env.VERBOSE || process.env.DEBUG) {
			console.log(`  ${message}`);
		}
		loggers.cli.debug(data || {}, message);
	},

	// Phase announcements
	phase: (name: string, status: "start" | "complete" | "skip") => {
		const icons = { start: "▶", complete: "✓", skip: "⏭" };
		console.log(`\n${icons[status]} Phase: ${name}`);
		loggers.pipeline.info({ phase: name, status }, `Phase ${status}: ${name}`);
	},

	// Task announcements
	task: (title: string, status: "start" | "complete" | "error") => {
		const icons = { start: "○", complete: "●", error: "✗" };
		console.log(`  ${icons[status]} ${title}`);
		loggers.task.info({ title, status }, `Task ${status}: ${title}`);
	},
};
