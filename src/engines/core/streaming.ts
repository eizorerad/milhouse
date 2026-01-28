import { bus } from "../../events";
import { loggers } from "../../observability";
import type { ExecutionStep } from "../../schemas/engine.schema";
import { StreamJsonParser } from "./parsers/stream-json";
import type { StepCallback, StreamChunk, StreamHandler } from "./types";

/**
 * Stream collector that accumulates chunks into a complete output.
 */
export class StreamCollector {
	private chunks: StreamChunk[] = [];
	private stdout = "";
	private stderr = "";
	private exitCode: number | null = null;

	/**
	 * Handle an incoming stream chunk.
	 */
	handle(chunk: StreamChunk): void {
		this.chunks.push(chunk);

		switch (chunk.type) {
			case "stdout":
				this.stdout += chunk.data;
				break;
			case "stderr":
				this.stderr += chunk.data;
				break;
			case "exit":
				this.exitCode = chunk.data as number;
				break;
		}
	}

	/**
	 * Get collected stdout.
	 */
	getStdout(): string {
		return this.stdout;
	}

	/**
	 * Get collected stderr.
	 */
	getStderr(): string {
		return this.stderr;
	}

	/**
	 * Get combined output.
	 */
	getOutput(): string {
		return this.stdout + this.stderr;
	}

	/**
	 * Get exit code.
	 */
	getExitCode(): number | null {
		return this.exitCode;
	}

	/**
	 * Get all chunks.
	 */
	getChunks(): StreamChunk[] {
		return [...this.chunks];
	}

	/**
	 * Reset collector.
	 */
	reset(): void {
		this.chunks = [];
		this.stdout = "";
		this.stderr = "";
		this.exitCode = null;
	}
}

/**
 * Stream multiplexer that forwards chunks to multiple handlers.
 */
export class StreamMultiplexer {
	private handlers: StreamHandler[] = [];

	/**
	 * Add a handler to receive stream chunks.
	 */
	addHandler(handler: StreamHandler): () => void {
		this.handlers.push(handler);

		// Return unsubscribe function
		return () => {
			const index = this.handlers.indexOf(handler);
			if (index !== -1) {
				this.handlers.splice(index, 1);
			}
		};
	}

	/**
	 * Send a chunk to all handlers.
	 */
	send(chunk: StreamChunk): void {
		for (const handler of this.handlers) {
			try {
				handler(chunk);
			} catch (error) {
				loggers.engine.warn({ error }, "Stream handler threw error");
			}
		}
	}

	/**
	 * Get number of handlers.
	 */
	get handlerCount(): number {
		return this.handlers.length;
	}
}

/**
 * Stream transformer that processes chunks through a pipeline.
 */
export type StreamTransformer = (chunk: StreamChunk) => StreamChunk | null;

/**
 * Create a filtering transformer.
 */
export function createFilterTransformer(
	predicate: (chunk: StreamChunk) => boolean,
): StreamTransformer {
	return (chunk) => (predicate(chunk) ? chunk : null);
}

/**
 * Create a mapping transformer.
 */
export function createMapTransformer(
	mapper: (chunk: StreamChunk) => StreamChunk,
): StreamTransformer {
	return mapper;
}

/**
 * Stream pipeline that applies transformers in sequence.
 */
export class StreamPipeline {
	private transformers: StreamTransformer[] = [];
	private handler: StreamHandler | null = null;

	/**
	 * Add a transformer to the pipeline.
	 */
	pipe(transformer: StreamTransformer): this {
		this.transformers.push(transformer);
		return this;
	}

	/**
	 * Set the final handler.
	 */
	to(handler: StreamHandler): this {
		this.handler = handler;
		return this;
	}

	/**
	 * Process a chunk through the pipeline.
	 */
	process(chunk: StreamChunk): void {
		let current: StreamChunk | null = chunk;

		for (const transformer of this.transformers) {
			if (!current) break;
			current = transformer(current);
		}

		if (current && this.handler) {
			this.handler(current);
		}
	}
}

/**
 * Real-time stream processor that emits parsed steps.
 */
export class RealtimeStreamProcessor {
	private readonly parser: StreamJsonParser;
	private readonly collector: StreamCollector;
	private readonly steps: ExecutionStep[] = [];
	private readonly taskId: string;
	private readonly engineName: string;

	constructor(options: {
		taskId: string;
		engineName: string;
		onStep?: StepCallback;
	}) {
		this.taskId = options.taskId;
		this.engineName = options.engineName;
		this.collector = new StreamCollector();

		this.parser = new StreamJsonParser((step) => {
			this.steps.push(step);

			// Emit step event
			bus.emit("engine:streaming", {
				engine: this.engineName,
				taskId: this.taskId,
				chunk: step.content,
			});

			// Call custom handler
			if (options.onStep) {
				options.onStep(step);
			}
		});
	}

	/**
	 * Process a stream chunk.
	 */
	processChunk(chunk: StreamChunk): void {
		this.collector.handle(chunk);

		if (chunk.type === "stdout") {
			this.parser.feed(chunk.data as string);
		}
	}

	/**
	 * Finalize processing.
	 */
	finalize(): {
		output: string;
		steps: ExecutionStep[];
		exitCode: number | null;
	} {
		this.parser.flush();

		return {
			output: this.collector.getOutput(),
			steps: [...this.steps],
			exitCode: this.collector.getExitCode(),
		};
	}

	/**
	 * Get current steps.
	 */
	getSteps(): ExecutionStep[] {
		return [...this.steps];
	}
}

/**
 * Create a stream handler that logs chunks.
 */
export function createLoggingStreamHandler(
	taskId: string,
	level: "debug" | "info" = "debug",
): StreamHandler {
	return (chunk) => {
		loggers.engine[level](
			{
				taskId,
				type: chunk.type,
				dataLength: typeof chunk.data === "string" ? chunk.data.length : chunk.data,
			},
			"Stream chunk received",
		);
	};
}

/**
 * Create a stream handler that emits events.
 */
export function createEventEmittingStreamHandler(
	engineName: string,
	taskId: string,
): StreamHandler {
	return (chunk) => {
		if (chunk.type === "stdout" || chunk.type === "stderr") {
			bus.emit("engine:streaming", {
				engine: engineName,
				taskId,
				chunk: chunk.data as string,
			});
		}
	};
}

/**
 * Async iterator for streaming output.
 */
export async function* streamToAsyncIterator(proc: {
	stdout: ReadableStream<Uint8Array>;
}): AsyncGenerator<string, void, unknown> {
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			yield decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Collect all output from an async iterator.
 */
export async function collectStream(iterator: AsyncIterable<string>): Promise<string> {
	let output = "";
	for await (const chunk of iterator) {
		output += chunk;
	}
	return output;
}
