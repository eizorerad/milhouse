import { afterEach, describe, expect, it } from "bun:test";
import { EngineError, buildArgs, runAgent } from "../src/engine.ts";
import { cleanupTempDirs, resetFakeAgentEnv, tempDir, useFakeAgent } from "./helpers.ts";

afterEach(() => {
	cleanupTempDirs();
	resetFakeAgentEnv();
});

const base = { cwd: "", timeoutMs: 20_000, tools: "read" as const };

describe("buildArgs", () => {
	it("always isolates the agent from the user's MCP servers and from session files", () => {
		const args = buildArgs({ tools: "read" });
		expect(args).toContain("--strict-mcp-config");
		expect(args).toContain("--no-session-persistence");
		expect(args.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
	});

	it("gives read-only phases read-only tools and no permission bypass", () => {
		const args = buildArgs({ tools: "read" });
		expect(args.join(" ")).toContain("--tools Read,Grep,Glob");
		expect(args).not.toContain("--dangerously-skip-permissions");
	});

	it("bypasses permissions only when the agent must edit and run things", () => {
		const args = buildArgs({ tools: "all" });
		expect(args).toContain("--dangerously-skip-permissions");
		expect(args).not.toContain("--tools");
	});

	it("passes model, schema, turn limit and the per-call budget", () => {
		const args = buildArgs({
			tools: "read",
			model: "opus",
			schema: { type: "object" },
			maxTurns: 7,
			maxBudgetUsd: 1.23456,
		});
		expect(args.join(" ")).toContain("--model opus");
		expect(args).toContain('{"type":"object"}');
		expect(args.join(" ")).toContain("--max-turns 7");
		expect(args.join(" ")).toContain("--max-budget-usd 1.2346");
	});

	it("omits optional flags when not given", () => {
		const joined = buildArgs({ tools: "read" }).join(" ");
		for (const flag of ["--model", "--json-schema", "--max-turns", "--max-budget-usd"])
			expect(joined).not.toContain(flag);
	});
});

describe("runAgent", () => {
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
