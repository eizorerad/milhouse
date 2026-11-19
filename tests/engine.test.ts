import { afterEach, describe, expect, it } from "bun:test";
import { EngineError, runAgent } from "../src/engine.ts";
import type { HarnessName } from "../src/types.ts";
import { cleanupTempDirs, resetFakeAgentEnv, tempDir, useFakeAgent } from "./helpers.ts";

afterEach(() => {
	cleanupTempDirs();
	resetFakeAgentEnv();
});

const base = {
	harness: "claude" as HarnessName,
	cwd: "",
	timeoutMs: 20_000,
	tools: "read" as const,
};
const codexBase = { ...base, harness: "codex" as HarnessName };

describe("runAgent with Claude", () => {
	it("returns the structured answer as JSON text with the reported cost", async () => {
		useFakeAgent({ cost: 0.42, scan: [{ title: "Found it" }] });
		const result = await runAgent("## Role: Lead Investigator\nscan", { ...base, cwd: tempDir() });
		expect(result.costUsd).toBe(0.42);
		expect(JSON.parse(result.text).items[0].title).toBe("Found it");
	});

	it("returns plain text when there is no structured output", async () => {
		useFakeAgent({});
		const result = await runAgent("## Role: Executor\n## Tasks to do, in this order\n", {
			...base,
			cwd: tempDir(),
		});
		expect(result.text).toBe("implemented");
	});

	it("sends the prompt on stdin, however long it is", async () => {
		const fake = useFakeAgent({});
		const long = `## Role: Executor\n${"x".repeat(300_000)}`;
		await runAgent(long, { ...base, cwd: tempDir() });
		expect(fake.journal()[0].prompt.length).toBe(long.length);
	});

	it("turns an error result into an EngineError that still carries the cost", async () => {
		useFakeAgent({
			fail: { "Lead Investigator": { message: "Reached maximum number of turns (1)", cost: 0.3 } },
		});
		const error = await runAgent("## Role: Lead Investigator", { ...base, cwd: tempDir() }).catch(
			(e) => e,
		);
		expect(error).toBeInstanceOf(EngineError);
		expect(error.message).toContain("maximum number of turns");
		expect(error.costUsd).toBe(0.3);
		expect(error.fatal).toBe(false);
		expect(error.systemic).toBe(false);
	});

	it("marks a used-up call budget as fatal (retrying cannot help)", async () => {
		useFakeAgent({
			fail: {
				Planner: {
					message: "Reached maximum budget ($0.5)",
					cost: 0.5,
					subtype: "error_max_budget_usd",
				},
			},
		});
		const error = await runAgent("## Role: Planner", { ...base, cwd: tempDir() }).catch((e) => e);
		expect(error.costUsd).toBe(0.5);
		expect(error.fatal).toBe(true);
		expect(error.systemic).toBe(false);
	});

	it("recognises that Claude is logged out: no other call would work either", async () => {
		useFakeAgent({
			fail: { Planner: { message: "Not logged in · Please run /login", result: true } },
		});
		const error = await runAgent("## Role: Planner", { ...base, cwd: tempDir() }).catch((e) => e);
		expect(error.systemic).toBe(true);
		expect(error.message).toContain("Not logged in");
	});

	it("fails clearly when the agent prints no result", async () => {
		useFakeAgent({ garbage: ["Planner"] });
		const error = await runAgent("## Role: Planner", { ...base, cwd: tempDir() }).catch((e) => e);
		expect(error).toBeInstanceOf(EngineError);
		expect(error.message).toContain("no result");
	});

	it("gives up on a hanging agent and counts an estimate for its unknown cost, never the whole budget", async () => {
		useFakeAgent({ sleep: { Planner: 30_000 } });
		const started = Date.now();
		const run = (maxBudgetUsd?: number) =>
			runAgent("## Role: Planner", { ...base, cwd: tempDir(), timeoutMs: 400, maxBudgetUsd }).catch(
				(e) => e,
			);
		const error = await run(50); // a sequential step may hold all that is left of the budget
		expect(error.message).toContain("timed out");
		expect(error.costUsd).toBe(1);
		expect((await run(0.25)).costUsd).toBe(0.25); // but never more than the call was allowed
		expect((await run()).costUsd).toBe(1); // unlimited budget: still an estimate, not zero
		expect(Date.now() - started).toBeLessThan(15_000);
	});

	it("fails clearly when the binary does not exist", async () => {
		process.env.MILHOUSE_CLAUDE = "/nonexistent/claude";
		const error = await runAgent("hi", { ...base, cwd: tempDir() }).catch((e) => e);
		expect(error).toBeInstanceOf(EngineError);
	});
});

describe("runAgent with Codex", () => {
	it("returns the answer and the tokens, and no dollars", async () => {
		const fake = useFakeAgent({ cost: 0.42, scan: [{ title: "Found it" }] });
		const result = await runAgent("## Role: Lead Investigator\nscan", {
			...codexBase,
			cwd: tempDir(),
			schema: { type: "object" },
		});
		expect(JSON.parse(result.text).items[0].title).toBe("Found it");
		expect(result.costUsd).toBe(0);
		expect(result.tokens).toEqual({ input: 42_000, output: 100 });
		expect(fake.journal()[0].harness).toBe("codex");
		expect(fake.journal()[0].prompt).toContain("matches this JSON Schema"); // asked for in the prompt
	});

	it("turns a failed turn into an EngineError, and knows a failure every call would share", async () => {
		useFakeAgent({
			fail: {
				Planner: {
					message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication",
				},
				"Lead Investigator": { message: "stream disconnected before completion" },
			},
		});
		const login = await runAgent("## Role: Planner", { ...codexBase, cwd: tempDir() }).catch(
			(e) => e,
		);
		expect(login).toBeInstanceOf(EngineError);
		expect(login.message).toContain("401");
		expect(login.systemic).toBe(true);

		const flaky = await runAgent("## Role: Lead Investigator", {
			...codexBase,
			cwd: tempDir(),
		}).catch((e) => e);
		expect(flaky.systemic).toBe(false);
		expect(flaky.costUsd).toBe(0);
	});

	it("counts no money for a call that timed out: Codex reports none", async () => {
		useFakeAgent({ sleep: { Planner: 30_000 } });
		const error = await runAgent("## Role: Planner", {
			...codexBase,
			cwd: tempDir(),
			timeoutMs: 400,
		}).catch((e) => e);
		expect(error.message).toContain("timed out");
		expect(error.costUsd).toBe(0);
	});

	it("fails clearly when the binary does not exist", async () => {
		process.env.MILHOUSE_CODEX = "/nonexistent/codex";
		const error = await runAgent("hi", { ...codexBase, cwd: tempDir() }).catch((e) => e);
		expect(error).toBeInstanceOf(EngineError);
	});
});
