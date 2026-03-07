/**
 * Tests for exec phase saveResults with per-task status granularity.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { IssueGroup, PhaseResult, Task } from "../../src/types.ts";

// Mock git functions before importing exec
const mockGetCommittedTaskNumbers = mock<(issueId: string, branch: string, cwd: string) => Promise<Set<number>>>();
const mockBranchExists = mock<(branch: string, cwd: string) => Promise<boolean>>();

mock.module("../../src/git.ts", () => ({
	getCommittedTaskNumbers: mockGetCommittedTaskNumbers,
	branchExists: mockBranchExists,
}));

// Import after mocking
const { execPhase } = await import("../../src/phases/exec.ts");

function makeTask(id: string, issueId: string, group: number): Task {
	return {
		id, issue_id: issueId, title: `Task ${id}`, files: [], depends_on: [],
		checks: [], acceptance: [], parallel_group: group, status: "pending" as const,
		created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
	};
}

function makeGroup(issueId: string, tasks: Task[]): IssueGroup {
	return {
		issueId,
		issue: {
			id: issueId, type: "improvement", title: "Test issue", rationale: "",
			severity: "MEDIUM", status: "CONFIRMED", evidence: [],
			created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
		},
		tasks,
	};
}

function makeResult(group: IssueGroup, success: boolean, error?: string): PhaseResult {
	return {
		item: group,
		result: { issueId: group.issueId, taskIds: group.tasks.map(t => t.id) },
		success,
		error,
		tokens: { response: "", inputTokens: 0, outputTokens: 0 },
	};
}

describe("exec saveResults", () => {
	let savedTasks: Task[];
	let savedStats: Record<string, number>;
	let mockStore: { workDir: string; loadTasks: () => Task[]; saveTasks: (t: Task[]) => void; refreshStats: () => void };

	beforeEach(() => {
		savedTasks = [];
		savedStats = {};
		mockGetCommittedTaskNumbers.mockReset();
		mockBranchExists.mockReset();
	});

	function setupStore(tasks: Task[]) {
		mockStore = {
			workDir: "/tmp/test",
			loadTasks: () => structuredClone(tasks),
			saveTasks: (t: Task[]) => { savedTasks = t; },
			refreshStats: () => {
				savedStats = {
					tasks_completed: savedTasks.filter((task) => task.status === "done").length,
					tasks_failed: savedTasks.filter((task) => task.status === "failed").length,
				};
			},
		};
	}

	it("all tasks committed → all done", async () => {
		const tasks = [makeTask("t1", "ISS-1", 0), makeTask("t2", "ISS-1", 1), makeTask("t3", "ISS-1", 2)];
		const group = makeGroup("ISS-1", tasks);
		setupStore(tasks);

		mockGetCommittedTaskNumbers.mockResolvedValue(new Set([1, 2, 3]));

		await execPhase.saveResults([makeResult(group, true)], mockStore);

		expect(savedTasks.filter(t => t.status === "done").length).toBe(3);
		expect(savedStats.tasks_completed).toBe(3);
		expect(savedStats.tasks_failed).toBe(0);
	});

	it("partial commits on success → only committed tasks done", async () => {
		const tasks = [makeTask("t1", "ISS-1", 0), makeTask("t2", "ISS-1", 1), makeTask("t3", "ISS-1", 2)];
		const group = makeGroup("ISS-1", tasks);
		setupStore(tasks);

		// Only tasks 1 and 2 committed
		mockGetCommittedTaskNumbers.mockResolvedValue(new Set([1, 2]));

		await execPhase.saveResults([makeResult(group, true)], mockStore);

		const done = savedTasks.filter(t => t.status === "done");
		const pending = savedTasks.filter(t => t.status === "pending");
		expect(done.length).toBe(2);
		expect(pending.length).toBe(1);
		expect(pending[0].id).toBe("t3");
		expect(savedStats.tasks_completed).toBe(2);
		expect(savedStats.tasks_failed).toBe(0);
	});

	it("process failure with partial commits → committed done + rest failed", async () => {
		const tasks = [makeTask("t1", "ISS-1", 0), makeTask("t2", "ISS-1", 1), makeTask("t3", "ISS-1", 2)];
		const group = makeGroup("ISS-1", tasks);
		setupStore(tasks);

		mockBranchExists.mockResolvedValue(true);
		mockGetCommittedTaskNumbers.mockResolvedValue(new Set([1]));

		await execPhase.saveResults([makeResult(group, false, "Process crashed")], mockStore);

		const done = savedTasks.filter(t => t.status === "done");
		const failedTasks = savedTasks.filter(t => t.status === "failed");
		expect(done.length).toBe(1);
		expect(done[0].id).toBe("t1");
		expect(failedTasks.length).toBe(2);
		expect(failedTasks.every(t => t.error === "Process crashed")).toBe(true);
		expect(savedStats.tasks_completed).toBe(1);
		expect(savedStats.tasks_failed).toBe(2);
	});

	it("process failure with no commits → all failed", async () => {
		const tasks = [makeTask("t1", "ISS-1", 0), makeTask("t2", "ISS-1", 1)];
		const group = makeGroup("ISS-1", tasks);
		setupStore(tasks);

		mockBranchExists.mockResolvedValue(false);

		await execPhase.saveResults([makeResult(group, false, "Engine timeout")], mockStore);

		const failedTasks = savedTasks.filter(t => t.status === "failed");
		expect(failedTasks.length).toBe(2);
		expect(failedTasks.every(t => t.error === "Engine timeout")).toBe(true);
		expect(savedStats.tasks_completed).toBe(0);
		expect(savedStats.tasks_failed).toBe(2);
	});
});
