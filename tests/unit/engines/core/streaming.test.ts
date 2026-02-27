import { describe, expect, it, spyOn } from "bun:test";
import {
	StreamCollector,
	StreamMultiplexer,
	StreamPipeline,
	createFilterTransformer,
	createMapTransformer,
} from "../../../../src/engines/core/streaming";
import type { StreamChunk } from "../../../../src/schemas/engine.schema";

function makeChunk(
	type: "stdout" | "stderr" | "exit",
	data: string | number,
): StreamChunk {
	return { type, data, timestamp: new Date() };
}

describe("StreamCollector", () => {
	it("accumulates stdout chunks in order", () => {
		const collector = new StreamCollector();
		collector.handle(makeChunk("stdout", "hello "));
		collector.handle(makeChunk("stdout", "world"));
		expect(collector.getStdout()).toBe("hello world");
	});

	it("accumulates stderr chunks in order", () => {
		const collector = new StreamCollector();
		collector.handle(makeChunk("stderr", "warn1 "));
		collector.handle(makeChunk("stderr", "warn2"));
		expect(collector.getStderr()).toBe("warn1 warn2");
	});

	it("getOutput returns combined stdout + stderr", () => {
		const collector = new StreamCollector();
		collector.handle(makeChunk("stdout", "out"));
		collector.handle(makeChunk("stderr", "err"));
		expect(collector.getOutput()).toBe("outerr");
	});

	it("getExitCode returns the exit code from exit chunk", () => {
		const collector = new StreamCollector();
		collector.handle(makeChunk("exit", 0));
		expect(collector.getExitCode()).toBe(0);
	});

	it("getExitCode returns non-zero exit codes", () => {
		const collector = new StreamCollector();
		collector.handle(makeChunk("exit", 1));
		expect(collector.getExitCode()).toBe(1);
	});

	it("getExitCode returns null when no exit chunk received", () => {
		const collector = new StreamCollector();
		collector.handle(makeChunk("stdout", "data"));
		expect(collector.getExitCode()).toBeNull();
	});

	it("empty collector returns defaults", () => {
		const collector = new StreamCollector();
		expect(collector.getStdout()).toBe("");
		expect(collector.getStderr()).toBe("");
		expect(collector.getOutput()).toBe("");
		expect(collector.getExitCode()).toBeNull();
		expect(collector.getChunks()).toEqual([]);
	});

	it("getChunks returns copies of all received chunks", () => {
		const collector = new StreamCollector();
		const c1 = makeChunk("stdout", "a");
		const c2 = makeChunk("stderr", "b");
		collector.handle(c1);
		collector.handle(c2);
		const chunks = collector.getChunks();
		expect(chunks.length).toBe(2);
		expect(chunks[0].type).toBe("stdout");
		expect(chunks[1].type).toBe("stderr");
	});

	it("reset clears all state", () => {
		const collector = new StreamCollector();
		collector.handle(makeChunk("stdout", "data"));
		collector.handle(makeChunk("stderr", "err"));
		collector.handle(makeChunk("exit", 0));
		collector.reset();
		expect(collector.getStdout()).toBe("");
		expect(collector.getStderr()).toBe("");
		expect(collector.getExitCode()).toBeNull();
		expect(collector.getChunks()).toEqual([]);
	});
});

describe("StreamMultiplexer", () => {
	it("forwards chunks to all registered handlers", () => {
		const mux = new StreamMultiplexer();
		const received1: StreamChunk[] = [];
		const received2: StreamChunk[] = [];
		mux.addHandler((chunk) => received1.push(chunk));
		mux.addHandler((chunk) => received2.push(chunk));
		const chunk = makeChunk("stdout", "test");
		mux.send(chunk);
		expect(received1.length).toBe(1);
		expect(received2.length).toBe(1);
		expect(received1[0]).toBe(chunk);
		expect(received2[0]).toBe(chunk);
	});

	it("unsubscribe removes handler", () => {
		const mux = new StreamMultiplexer();
		const received: StreamChunk[] = [];
		const unsub = mux.addHandler((chunk) => received.push(chunk));
		mux.send(makeChunk("stdout", "before"));
		expect(received.length).toBe(1);
		unsub();
		mux.send(makeChunk("stdout", "after"));
		expect(received.length).toBe(1); // No new chunk
	});

	it("handler errors do not crash multiplexer", () => {
		const mux = new StreamMultiplexer();
		const received: StreamChunk[] = [];
		mux.addHandler(() => {
			throw new Error("handler error");
		});
		mux.addHandler((chunk) => received.push(chunk));

		// Should not throw despite first handler throwing
		expect(() => mux.send(makeChunk("stdout", "test"))).not.toThrow();
		// Second handler still receives the chunk
		expect(received.length).toBe(1);
	});

	it("handlerCount tracks registered handlers", () => {
		const mux = new StreamMultiplexer();
		expect(mux.handlerCount).toBe(0);
		const unsub1 = mux.addHandler(() => {});
		expect(mux.handlerCount).toBe(1);
		mux.addHandler(() => {});
		expect(mux.handlerCount).toBe(2);
		unsub1();
		expect(mux.handlerCount).toBe(1);
	});

	it("multiple handlers receive same chunks", () => {
		const mux = new StreamMultiplexer();
		const results: string[] = [];
		mux.addHandler((c) => results.push(`h1:${c.data}`));
		mux.addHandler((c) => results.push(`h2:${c.data}`));
		mux.addHandler((c) => results.push(`h3:${c.data}`));
		mux.send(makeChunk("stdout", "x"));
		expect(results).toEqual(["h1:x", "h2:x", "h3:x"]);
	});
});

describe("StreamPipeline", () => {
	it("applies transformers in sequence", () => {
		const received: StreamChunk[] = [];
		const pipeline = new StreamPipeline()
			.pipe(
				createMapTransformer((chunk) => ({
					...chunk,
					data: `[${chunk.data}]`,
				})),
			)
			.to((chunk) => received.push(chunk));

		pipeline.process(makeChunk("stdout", "hello"));
		expect(received.length).toBe(1);
		expect(received[0].data).toBe("[hello]");
	});

	it("filter transformer drops non-matching chunks", () => {
		const received: StreamChunk[] = [];
		const pipeline = new StreamPipeline()
			.pipe(createFilterTransformer((chunk) => chunk.type === "stdout"))
			.to((chunk) => received.push(chunk));

		pipeline.process(makeChunk("stdout", "keep"));
		pipeline.process(makeChunk("stderr", "drop"));
		expect(received.length).toBe(1);
		expect(received[0].data).toBe("keep");
	});

	it("does not call handler when no handler is set", () => {
		const pipeline = new StreamPipeline();
		// Should not throw
		expect(() => pipeline.process(makeChunk("stdout", "test"))).not.toThrow();
	});
});
