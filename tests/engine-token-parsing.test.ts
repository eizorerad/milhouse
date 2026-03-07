/**
 * Tests for Gemini and Aider token parsing.
 */

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { execute } from "../src/engine.ts";
import { parseGeminiOutput, parseAiderOutput } from "../src/engine.ts";
import type { Config } from "../src/types.ts";

function makeFakeProc(stdout: string, stderr: string, exitCode: number) {
	const stdoutBlob = new Blob([stdout]);
	const stderrBlob = new Blob([stderr]);
	return {
		stdin: null,
		stdout: stdoutBlob.stream(),
		stderr: stderrBlob.stream(),
		exited: Promise.resolve(exitCode),
		kill: mock(() => {}),
		pid: 12345,
	};
}

describe("parseGeminiOutput", () => {
	it("extracts token counts from Gemini-formatted output", () => {
		const raw = [
			"Here is my response to your question.",
			"prompt_token_count: 150",
			"candidates_token_count: 320",
		].join("\n");

		const result = parseGeminiOutput(raw);
		expect(result.response).toBe(raw.trim());
		expect(result.inputTokens).toBe(150);
		expect(result.outputTokens).toBe(320);
	});

	it("falls back to character estimation when no token stats present", () => {
		const raw = "Just a plain text response from Gemini.";
		const result = parseGeminiOutput(raw);
		expect(result.response).toBe(raw.trim());
		expect(result.inputTokens).toBe(0);
		expect(result.outputTokens).toBe(Math.ceil(raw.trim().length / 4));
		expect(result.outputTokens).toBeGreaterThan(0);
	});

	it("returns zeros for empty output", () => {
		const result = parseGeminiOutput("");
		expect(result.response).toBe("");
		expect(result.inputTokens).toBe(0);
		expect(result.outputTokens).toBe(0);
	});
});

describe("parseAiderOutput", () => {
	it("returns estimated tokens for plain text", () => {
		const raw = "Here is some output from Aider with code changes applied.";
		const result = parseAiderOutput(raw);
		expect(result.response).toBe(raw.trim());
		expect(result.inputTokens).toBe(0);
		expect(result.outputTokens).toBe(Math.ceil(raw.trim().length / 4));
		expect(result.outputTokens).toBeGreaterThan(0);
	});

	it("returns zeros for empty output", () => {
		const result = parseAiderOutput("");
		expect(result.response).toBe("");
		expect(result.inputTokens).toBe(0);
		expect(result.outputTokens).toBe(0);
	});
});

describe("engine integration with token parsing", () => {
	let spawnMock: ReturnType<typeof spyOn>;

	afterEach(() => {
		spawnMock?.mockRestore?.();
	});

	it("gemini engine uses parseGeminiOutput", async () => {
		const stdout = "Response text\nprompt_token_count: 100\ncandidates_token_count: 200";
		const fakeProc = makeFakeProc(stdout, "", 0);
		spawnMock = spyOn(Bun, "spawn").mockReturnValue(fakeProc as never);

		const config = { engine: "gemini", model: "test" } as Config;
		const result = await execute("test", "/tmp", config, { timeout: 5000 });

		expect(result.inputTokens).toBe(100);
		expect(result.outputTokens).toBe(200);
	});

	it("aider engine uses parseAiderOutput", async () => {
		const stdout = "Applied changes to src/main.ts";
		const fakeProc = makeFakeProc(stdout, "", 0);
		spawnMock = spyOn(Bun, "spawn").mockReturnValue(fakeProc as never);

		const config = { engine: "aider", model: "test" } as Config;
		const result = await execute("test", "/tmp", config, { timeout: 5000 });

		expect(result.inputTokens).toBe(0);
		expect(result.outputTokens).toBe(Math.ceil(stdout.length / 4));
	});
});
