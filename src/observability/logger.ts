import pino from "pino";

// Determine if we're in development mode (only when explicitly set)
const isDev = process.env.NODE_ENV === "development";

// Create pino logger with appropriate transport
export const logger = pino({
	name: "milhouse",
	level: process.env.LOG_LEVEL || "warn",
	transport: isDev
		? {
				target: "pino-pretty",
				options: {
					colorize: true,
					translateTime: "HH:MM:ss",
					ignore: "pid,hostname",
				},
			}
		: undefined,
});

// Create child loggers for different components
export const createLogger = (component: string) => logger.child({ component });

// Pre-created loggers for common components
export const loggers = {
	pipeline: createLogger("pipeline"),
	engine: createLogger("engine"),
	task: createLogger("task"),
	git: createLogger("git"),
	gate: createLogger("gate"),
	probe: createLogger("probe"),
	cli: createLogger("cli"),
};
