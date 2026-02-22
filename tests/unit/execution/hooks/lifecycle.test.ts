import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { withTimeout } from "../../../../src/execution/hooks/lifecycle";
import type { ExecutionHooks } from "../../../../src/execution/strategies/types";

describe("withTimeout", () => {
	let clearTimeoutSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
	});

	afterEach(() => {
		clearTimeoutSpy.mockRestore();
	});

	it("returns hook result when hook completes before timeout", async () => {
		const hooks: ExecutionHooks = {
			onTaskStart: async () => {
				// Completes immediately
			},
		};

		const wrapped = withTimeout(hooks, 5000);
		await expect(wrapped.onTaskStart!({} as any, {} as any)).resolves.toBeUndefined();
	});

	it("clears the timer when hook completes before timeout", async () => {
		const hooks: ExecutionHooks = {
			onTaskStart: async () => {
				// Completes immediately
			},
		};

		const wrapped = withTimeout(hooks, 5000);
		await wrapped.onTaskStart!({} as any, {} as any);

		expect(clearTimeoutSpy).toHaveBeenCalled();
	});

	it("throws timeout error when hook exceeds timeout", async () => {
		const hooks: ExecutionHooks = {
			onTaskStart: async () => {
				await new Promise((resolve) => setTimeout(resolve, 500));
			},
		};

		const wrapped = withTimeout(hooks, 50);
		await expect(wrapped.onTaskStart!({} as any, {} as any)).rejects.toThrow(
			"Hook onTaskStart timed out after 50ms",
		);
	});

	it("propagates hook errors and cleans up timer", async () => {
		const hooks: ExecutionHooks = {
			onTaskStart: async () => {
				throw new Error("hook failure");
			},
		};

		const wrapped = withTimeout(hooks, 5000);
		await expect(wrapped.onTaskStart!({} as any, {} as any)).rejects.toThrow("hook failure");

		expect(clearTimeoutSpy).toHaveBeenCalled();
	});

	it("calls clearTimeout after each invocation", async () => {
		const hooks: ExecutionHooks = {
			onTaskStart: async () => {},
			onTaskComplete: async () => {},
		};

		const wrapped = withTimeout(hooks, 5000);
		await wrapped.onTaskStart!({} as any, {} as any);
		await wrapped.onTaskComplete!({} as any, {} as any);

		expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
	});
});
