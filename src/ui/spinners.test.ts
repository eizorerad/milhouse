import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { bus } from "../events";
import { initSpinnerEventHandlers, spinners } from "./spinners";
import * as spinnersModule from "./spinners";

describe("initSpinnerEventHandlers", () => {
	let startSpy: ReturnType<typeof spyOn>;
	let succeedSpy: ReturnType<typeof spyOn>;
	let failSpy: ReturnType<typeof spyOn>;
	let warnSpy: ReturnType<typeof spyOn>;
	let updateSpy: ReturnType<typeof spyOn>;
	let stopAllSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		startSpy = spyOn(spinners, "start").mockImplementation((() => ({})) as any);
		succeedSpy = spyOn(spinners, "succeed").mockImplementation((() => {}) as any);
		failSpy = spyOn(spinners, "fail").mockImplementation((() => {}) as any);
		warnSpy = spyOn(spinners, "warn").mockImplementation((() => {}) as any);
		updateSpy = spyOn(spinners, "update").mockImplementation((() => {}) as any);
		stopAllSpy = spyOn(spinners, "stopAll").mockImplementation((() => {}) as any);
	});

	afterEach(() => {
		// Clean up all event handlers to avoid test pollution
		bus.clear();
		startSpy.mockRestore();
		succeedSpy.mockRestore();
		failSpy.mockRestore();
		warnSpy.mockRestore();
		updateSpy.mockRestore();
		stopAllSpy.mockRestore();
	});

	// =========================================================================
	// Single init: handlers respond to events
	// =========================================================================

	describe("single init registers handlers", () => {
		test("pipeline:phase:start triggers spinners.start", () => {
			initSpinnerEventHandlers();
			bus.emit("pipeline:phase:start", { runId: "r1", phase: "scan" });
			expect(startSpy).toHaveBeenCalledTimes(1);
		});

		test("pipeline:phase:complete triggers spinners.succeed", () => {
			initSpinnerEventHandlers();
			bus.emit("pipeline:phase:complete", { runId: "r1", phase: "scan", duration: 1000 });
			expect(succeedSpy).toHaveBeenCalledTimes(1);
		});

		test("pipeline:phase:error triggers spinners.fail", () => {
			initSpinnerEventHandlers();
			bus.emit("pipeline:phase:error", { runId: "r1", phase: "scan", error: new Error("boom") });
			expect(failSpy).toHaveBeenCalledTimes(1);
		});

		test("task:start triggers spinners.start", () => {
			initSpinnerEventHandlers();
			bus.emit("task:start", { taskId: "t1", title: "Test task" });
			expect(startSpy).toHaveBeenCalledTimes(1);
		});

		test("task:progress triggers spinners.update", () => {
			initSpinnerEventHandlers();
			bus.emit("task:progress", { taskId: "t1", step: "step1" });
			expect(updateSpy).toHaveBeenCalledTimes(1);
		});

		test("task:complete with success triggers spinners.succeed", () => {
			initSpinnerEventHandlers();
			bus.emit("task:complete", { taskId: "t1", duration: 500, success: true });
			expect(succeedSpy).toHaveBeenCalledTimes(1);
		});

		test("task:complete with failure triggers spinners.fail", () => {
			initSpinnerEventHandlers();
			bus.emit("task:complete", { taskId: "t1", duration: 500, success: false });
			expect(failSpy).toHaveBeenCalledTimes(1);
		});

		test("task:error triggers spinners.fail", () => {
			initSpinnerEventHandlers();
			bus.emit("task:error", { taskId: "t1", error: new Error("fail") });
			expect(failSpy).toHaveBeenCalledTimes(1);
		});

		test("engine:start triggers spinners.start", () => {
			initSpinnerEventHandlers();
			bus.emit("engine:start", { engine: "claude", taskId: "t1" });
			expect(startSpy).toHaveBeenCalledTimes(1);
		});

		test("engine:complete triggers spinners.succeed", () => {
			initSpinnerEventHandlers();
			bus.emit("engine:complete", { engine: "claude", taskId: "t1", result: {} });
			expect(succeedSpy).toHaveBeenCalledTimes(1);
		});

		test("engine:error triggers spinners.fail", () => {
			initSpinnerEventHandlers();
			bus.emit("engine:error", { engine: "claude", taskId: "t1", error: new Error("err") });
			expect(failSpy).toHaveBeenCalledTimes(1);
		});

		test("git:worktree:create triggers spinners.start", () => {
			initSpinnerEventHandlers();
			bus.emit("git:worktree:create", { path: "/tmp/wt", branch: "main" });
			expect(startSpy).toHaveBeenCalledTimes(1);
		});

		test("git:worktree:cleanup triggers spinners.succeed", () => {
			initSpinnerEventHandlers();
			bus.emit("git:worktree:cleanup", { path: "/tmp/wt" });
			expect(succeedSpy).toHaveBeenCalledTimes(1);
		});

		test("git:merge:start triggers spinners.start", () => {
			initSpinnerEventHandlers();
			bus.emit("git:merge:start", { source: "feature", target: "main" });
			expect(startSpy).toHaveBeenCalledTimes(1);
		});

		test("git:merge:complete triggers spinners.succeed", () => {
			initSpinnerEventHandlers();
			bus.emit("git:merge:complete", { source: "feature", target: "main" });
			expect(succeedSpy).toHaveBeenCalledTimes(1);
		});

		test("git:merge:conflict triggers spinners.warn", () => {
			initSpinnerEventHandlers();
			bus.emit("git:merge:conflict", { source: "feature", target: "main", files: ["a.ts"] });
			expect(warnSpy).toHaveBeenCalledTimes(1);
		});

		test("probe:start triggers spinners.start", () => {
			initSpinnerEventHandlers();
			bus.emit("probe:start", { name: "health" });
			expect(startSpy).toHaveBeenCalledTimes(1);
		});

		test("probe:complete triggers spinners.succeed", () => {
			initSpinnerEventHandlers();
			bus.emit("probe:complete", { name: "health", result: {} });
			expect(succeedSpy).toHaveBeenCalledTimes(1);
		});

		test("probe:error triggers spinners.fail", () => {
			initSpinnerEventHandlers();
			bus.emit("probe:error", { name: "health", error: new Error("err") });
			expect(failSpy).toHaveBeenCalledTimes(1);
		});
	});

	// =========================================================================
	// Bug: handlers accumulate on repeated init (documents the defect)
	// =========================================================================

	describe("handler accumulation bug", () => {
		test("handlers accumulate when init called twice", () => {
			initSpinnerEventHandlers();
			initSpinnerEventHandlers();
			bus.emit("pipeline:phase:start", { runId: "r1", phase: "scan" });
			// Bug: each init adds another handler, so event fires twice
			expect(startSpy).toHaveBeenCalledTimes(2);
		});

		test("handlers accumulate across all event types", () => {
			initSpinnerEventHandlers();
			initSpinnerEventHandlers();
			initSpinnerEventHandlers();

			bus.emit("task:start", { taskId: "t1", title: "Test" });
			expect(startSpy).toHaveBeenCalledTimes(3);

			bus.emit("task:error", { taskId: "t1", error: new Error("fail") });
			expect(failSpy).toHaveBeenCalledTimes(3);
		});
	});

	// =========================================================================
	// Idempotency: repeated init should not duplicate handlers (after fix)
	// These tests will pass once Task 2 applies the idempotency guard.
	// =========================================================================

	describe("idempotent init", () => {
		test("idempotent: repeated init does not cause duplicate handlers", () => {
			initSpinnerEventHandlers();
			initSpinnerEventHandlers();
			bus.emit("pipeline:phase:start", { runId: "r1", phase: "scan" });
			expect(startSpy).toHaveBeenCalledTimes(1);
		});

		test("idempotent: triple init still fires handlers once", () => {
			initSpinnerEventHandlers();
			initSpinnerEventHandlers();
			initSpinnerEventHandlers();
			bus.emit("task:start", { taskId: "t1", title: "Test" });
			expect(startSpy).toHaveBeenCalledTimes(1);
		});
	});

	// =========================================================================
	// Cleanup: teardown removes all handlers (after fix)
	// These tests will pass once Task 2 exports teardownSpinnerEventHandlers.
	// =========================================================================

	describe("cleanup via teardownSpinnerEventHandlers", () => {
		test("cleanup: teardownSpinnerEventHandlers is exported", () => {
			const teardown = (spinnersModule as Record<string, unknown>).teardownSpinnerEventHandlers;
			expect(typeof teardown).toBe("function");
		});

		test("cleanup: teardown removes all handlers so events no longer trigger spinners", () => {
			const teardown = (spinnersModule as Record<string, unknown>).teardownSpinnerEventHandlers as () => void;
			if (typeof teardown !== "function") {
				throw new Error("teardownSpinnerEventHandlers not yet exported");
			}

			initSpinnerEventHandlers();
			bus.emit("pipeline:phase:start", { runId: "r1", phase: "scan" });
			expect(startSpy).toHaveBeenCalledTimes(1);

			teardown();
			startSpy.mockClear();

			// After teardown, events should not trigger spinners
			bus.emit("pipeline:phase:start", { runId: "r1", phase: "scan" });
			expect(startSpy).toHaveBeenCalledTimes(0);

			bus.emit("task:start", { taskId: "t1", title: "Test" });
			expect(startSpy).toHaveBeenCalledTimes(0);

			bus.emit("probe:start", { name: "health" });
			expect(startSpy).toHaveBeenCalledTimes(0);
		});

		test("cleanup: teardown then re-init works correctly", () => {
			const teardown = (spinnersModule as Record<string, unknown>).teardownSpinnerEventHandlers as () => void;
			if (typeof teardown !== "function") {
				throw new Error("teardownSpinnerEventHandlers not yet exported");
			}

			initSpinnerEventHandlers();
			teardown();

			// Re-init should work and register handlers again
			initSpinnerEventHandlers();
			bus.emit("pipeline:phase:start", { runId: "r1", phase: "scan" });
			expect(startSpy).toHaveBeenCalledTimes(1);
		});
	});
});
