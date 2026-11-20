import { afterEach, describe, expect, it } from "bun:test";
import { CostTracker, emptyCost } from "../src/cost.ts";
import { EngineError } from "../src/engine.ts";
import { GiveUp, type Outcome, type PhaseDef, Skip, runPhase } from "../src/runner.ts";
import { RunStore } from "../src/state.ts";
import { sleep } from "../src/util.ts";
import {
	BASE,
	cleanupTempDirs,
	flag,
	resetFakeAgentEnv,
	tempDir,
	testConfig,
	useFakeAgent,
} from "./helpers.ts";

afterEach(() => {
	cleanupTempDirs();
	resetFakeAgentEnv();
});

interface Setup {
	store: RunStore;
	cost: CostTracker;
	config: ReturnType<typeof testConfig>;
}

function setup(configOverrides: Record<string, unknown> = {}, budget = 0): Setup {
	const store = RunStore.create(tempDir(), undefined, BASE);
	const config = testConfig({ budget, ...configOverrides });
	return { store, config, cost: new CostTracker(emptyCost(), budget, () => {}) };
}

/** A phase over numbers whose `run` is supplied by the test. */
function phase(
	run: PhaseDef<number, string>["run"],
	items = [1],
): PhaseDef<number, string> & { recorded: Array<[number, Outcome<string>]> } {
	const recorded: Array<[number, Outcome<string>]> = [];
	return {
		name: "validate",
		loadItems: () => items,
		label: (n) => `item ${n}`,
		run,
		record: (item, outcome) => {
			recorded.push([item, outcome]);
		},
		recorded,
	};
}

describe("runPhase after a failure that every call would share", () => {
	it("does not let a worker that was waiting to retry call the agent again", async () => {
		process.env.MILHOUSE_RETRY_DELAY_MS = "400"; // the first item waits 200-600 ms before its retry
		const { store, config, cost } = setup({ phases: { validate: { workers: 2, retries: 2 } } });
		let attemptsOfFirst = 0;
		const def = phase(
			async (n) => {
				if (n === 1) {
					attemptsOfFirst++;
					throw new EngineError("overloaded");
				}
				await sleep(80);
				throw new EngineError("Not logged in", { systemic: true });
			},
			[1, 2],
		);

		const outcomes = await runPhase(def, store, config, cost);
		expect(attemptsOfFirst).toBe(1);
		expect(outcomes[1]).toMatchObject({ ok: false, systemic: true });
		expect(outcomes[0]).toMatchObject({ ok: false, skipped: true }); // left for --resume
	});
});

describe("runPhase", () => {
	it("runs every item and records each result", async () => {
		const { store, config, cost } = setup();
		const def = phase(async (n) => `done ${n}`, [1, 2, 3]);
		const outcomes = await runPhase(def, store, config, cost);
		expect(outcomes).toEqual([1, 2, 3].map((n) => ({ ok: true, value: `done ${n}` })));
		expect(def.recorded.map(([item]) => item)).toEqual([1, 2, 3]);
	});

	it("does nothing when there is nothing to do", async () => {
		const { store, config, cost } = setup();
		const def = phase(async () => "x", []);
		expect(await runPhase(def, store, config, cost)).toEqual([]);
		expect(def.recorded).toEqual([]);
	});

	it("retries with the previous error as feedback", async () => {
		const { store, config, cost } = setup({ phases: { validate: { retries: 2 } } });
		const seen: Array<[number, string | undefined]> = [];
		const def = phase(async (_n, ctx) => {
			seen.push([ctx.attempt, ctx.lastError]);
			if (ctx.attempt < 2) throw new Error(`bad ${ctx.attempt}`);
			return "fixed";
		});
		const [outcome] = await runPhase(def, store, config, cost);
		expect(outcome).toEqual({ ok: true, value: "fixed" });
		expect(seen).toEqual([
			[0, undefined],
			[1, "bad 0"],
			[2, "bad 1"],
		]);
	});

	it("records the last error once the retries are used up", async () => {
		const { store, config, cost } = setup({ phases: { validate: { retries: 1 } } });
		let calls = 0;
		const def = phase(async () => {
			throw new Error(`failure ${++calls}`);
		});
		const [outcome] = await runPhase(def, store, config, cost);
		expect(outcome).toEqual({ ok: false, error: "failure 2" });
		expect(def.recorded).toEqual([[1, { ok: false, error: "failure 2" }]]);
	});

	it("stops at once when the phase gives up", async () => {
		const { store, config, cost } = setup({ phases: { validate: { retries: 5 } } });
		let calls = 0;
		const def = phase(async () => {
			calls++;
			throw new GiveUp("cannot work");
		});
		const [outcome] = await runPhase(def, store, config, cost);
		expect(calls).toBe(1);
		expect(outcome).toEqual({ ok: false, error: "cannot work" });
	});

	it("runs items in parallel up to the configured workers", async () => {
		const { store, config, cost } = setup({ phases: { validate: { workers: 3 } } });
		let running = 0;
		let peak = 0;
		const def = phase(async () => {
			peak = Math.max(peak, ++running);
			await sleep(30);
			running--;
			return "ok";
		}, [1, 2, 3, 4, 5, 6]);
		await runPhase(def, store, config, cost);
		expect(peak).toBe(3);
	});
});

describe("runPhase edge cases", () => {
	const oneWorkerTwoRetries = { phases: { validate: { retries: 2, workers: 1 } } };

	it("leaves a skipped item alone: nothing is recorded and it is not a failure to retry", async () => {
		const { store, config, cost } = setup(oneWorkerTwoRetries);
		const def = phase(
			async (n) => {
				if (n === 1) throw new Skip("waiting for something");
				return "done";
			},
			[1, 2],
		);
		const outcomes = await runPhase(def, store, config, cost);
		expect(outcomes[0]).toEqual({ ok: false, error: "waiting for something", skipped: true });
		expect(outcomes[1]).toEqual({ ok: true, value: "done" });
		expect(def.recorded.map(([item]) => item)).toEqual([2]);
	});

	it("keeps the real error when the budget runs out between attempts", async () => {
		const { store, config, cost } = setup(oneWorkerTwoRetries, 0.5);
		const def = phase(async () => {
			cost.add("validate", 1); // this attempt spends the whole budget and fails
			throw new Error("tests failed: boom");
		});
		const [outcome] = await runPhase(def, store, config, cost);
		expect(outcome.ok).toBe(false);
		const error = (outcome as { error: string }).error;
		expect(error).toContain("tests failed: boom");
		expect(error).toContain("budget is used up");
		expect((outcome as { skipped?: boolean }).skipped).toBe(false); // it was attempted: record it
		expect(def.recorded.map(([item]) => item)).toEqual([1]);
	});

	it("refuses to start an agent call without budget instead of spawning one that cannot run", async () => {
		const fake = useFakeAgent({});
		const { store, config, cost } = setup(oneWorkerTwoRetries, 1);
		const def = phase(async (_n, ctx) => {
			cost.add("validate", 1); // budget gone before the call
			return ctx.ask("## Role: Planner");
		});
		const [outcome] = await runPhase(def, store, config, cost);
		expect(outcome.ok).toBe(false);
		expect(fake.journal()).toHaveLength(0);
	});

	it("strips terminal escape sequences from error messages it reports", async () => {
		const { store, config, cost } = setup(oneWorkerTwoRetries);
		const def = phase(async () => {
			throw new Error("bad \u001b[2J news");
		});
		const [outcome] = await runPhase(def, store, config, cost);
		expect((outcome as Outcome<string> & { error: string }).error).toBe("bad [2J news");
	});
});

describe("runPhase and the time limit", () => {
	it("starts no call once the limit has passed, even when it passed while the attempt got ready", async () => {
		const fake = useFakeAgent({});
		const { store, config } = setup();
		const cost = new CostTracker(emptyCost(), 0, () => {}, 30); // 30 ms
		const def = phase(async (_n, ctx) => {
			await sleep(60);
			return ctx.ask("## Role: Planner");
		});
		const [outcome] = await runPhase(def, store, config, cost);
		expect(outcome.ok).toBe(false);
		expect((outcome as { error: string }).error).toContain("time limit");
		expect(fake.journal()).toHaveLength(0);
	});
});

describe("runPhase and the time that is left", () => {
	it("reads it once, so that it cannot reach zero between the check and the timer of the call", async () => {
		useFakeAgent({ sleep: { Planner: 1_200 } });
		const { store, config } = setup();
		const cost = new CostTracker(emptyCost(), 0, () => {}, 100);
		let reads = 0;
		cost.remainingMs = () => (++reads <= 2 ? 1 : 0); // the clock ticks once more after the check
		const def = phase((_n, ctx) => ctx.ask("## Role: Planner"));
		const started = Date.now();
		const [outcome] = await runPhase(def, store, config, cost);
		expect(outcome.ok).toBe(false); // cut short at once, not run to its end
		expect(Date.now() - started).toBeLessThan(900);
	});
});

describe("runPhase and the agent", () => {
	it("charges failed calls too, retries engine errors and keeps the real error text", async () => {
		useFakeAgent({ fail: { Planner: { message: "overloaded", cost: 0.3 } } });
		const { store, config, cost } = setup({ phases: { validate: { retries: 1 } } });
		const def = phase((_n, ctx) => ctx.ask("## Role: Planner"));
		const [outcome] = await runPhase(def, store, config, cost);
		expect(outcome.ok).toBe(false);
		expect((outcome as { error: string }).error).toContain("overloaded");
		expect(cost.current.total).toBeCloseTo(0.6); // two failed attempts
		expect(cost.current.byPhase.validate).toBeCloseTo(0.6);
	});

	it("does not retry when the per-call budget is used up", async () => {
		useFakeAgent({
			fail: {
				Planner: { message: "Reached maximum budget", cost: 0.5, subtype: "error_max_budget_usd" },
			},
		});
		const { store, config, cost } = setup({ phases: { validate: { retries: 3 } } });
		const def = phase((_n, ctx) => ctx.ask("## Role: Planner"));
		await runPhase(def, store, config, cost);
		expect(cost.current.total).toBeCloseTo(0.5); // one call only
	});

	it("skips what is left once the budget is gone, and records nothing for skipped items", async () => {
		useFakeAgent({ cost: 0.01 });
		const { store, config, cost } = setup({ phases: { validate: { workers: 1 } } }, 0.015);
		const def = phase((_n, ctx) => ctx.ask("## Role: Planner"), [1, 2, 3]);
		const outcomes = await runPhase(def, store, config, cost);
		expect(outcomes.map((o) => o.ok)).toEqual([true, true, false]);
		expect(outcomes[2]).toMatchObject({ ok: false, skipped: true });
		expect(def.recorded.map(([item]) => item)).toEqual([1, 2]);
		expect(cost.exceeded()).toBe(true);
	});

	it("splits the remaining budget between parallel workers", async () => {
		const fake = useFakeAgent({ cost: 0.01 });
		const { store, config, cost } = setup({ phases: { validate: { workers: 2 } } }, 10);
		const def = phase((_n, ctx) => ctx.ask("## Role: Planner"), [1, 2]);
		await runPhase(def, store, config, cost);
		const caps = fake.journal().map((call) => flag(call.args, "--max-budget-usd"));
		expect(caps).toEqual(["5.0000", "5.0000"]);
	});

	it("passes no budget cap when the budget is unlimited", async () => {
		const fake = useFakeAgent({});
		const { store, config, cost } = setup();
		await runPhase(
			phase((_n, ctx) => ctx.ask("## Role: Planner")),
			store,
			config,
			cost,
		);
		expect(fake.journal()[0].args).not.toContain("--max-budget-usd");
	});

	it("uses the model and the cost line of the step that was asked", async () => {
		const fake = useFakeAgent({});
		const { store, config, cost } = setup({
			model: "sonnet",
			phases: { verify: { model: "opus" } },
		});
		const def = phase(async (_n, ctx) => {
			await ctx.ask("## Role: Planner");
			await ctx.ask("## Role: Planner", { step: "verify" });
			return "ok";
		});
		await runPhase(def, store, config, cost);
		const models = fake.journal().map((call) => flag(call.args, "--model"));
		expect(models).toEqual(["sonnet", "opus"]);
		expect(Object.keys(cost.current.byPhase).sort()).toEqual(["validate", "verify"]);
	});

	it("runs read-only unless the phase asks for every tool", async () => {
		const fake = useFakeAgent({});
		const { store, config, cost } = setup();
		const def = phase(async (_n, ctx) => {
			await ctx.ask("## Role: Planner");
			await ctx.ask("## Role: Planner", { tools: "all" });
			return "ok";
		});
		await runPhase(def, store, config, cost);
		const [first, second] = fake.journal();
		expect(first.args).toContain("--tools");
		expect(second.args).toContain("--dangerously-skip-permissions");
	});
});
