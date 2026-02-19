/**
 * E2E Integration tests for verify command - DoD gate behavior
 *
 * These tests verify that the `verify` command correctly handles check_commands:
 * - Commands with metacharacters (pipes, &&) generate warnings but are NOT skipped
 * - DoD gate updates criterion.verified=true for valid commands
 * - Only truly dangerous commands are skipped
 *
 * @module cli/commands/e2e/verify-dod-integration.test
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateCheckCommand } from "../../../gates/dod.ts";
import { runDoDGate } from "../verify.ts";
import { loadTasksForRun, saveTasksForRun } from "../../../state/tasks.ts";
import type { Task } from "../../../state/types.ts";

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Creates a unique temporary directory for test isolation
 */
function createTempDir(): string {
	const tempBase = join(tmpdir(), "verify-dod-e2e-");
	const tempDir = `${tempBase}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

/**
 * Initialize a git repository in the given directory
 */
function initGitRepo(dir: string): void {
	execSync("git init", { cwd: dir, stdio: "pipe" });
	execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
	execSync('git config user.name "Test User"', { cwd: dir, stdio: "pipe" });

	// Create initial commit
	writeFileSync(join(dir, "README.md"), "# Test Project\n\nThis is a test project.");
	execSync("git add .", { cwd: dir, stdio: "pipe" });
	execSync('git commit -m "Initial commit"', { cwd: dir, stdio: "pipe" });
}

/**
 * Sets up a mock run with tasks
 */
function setupMockRun(
	workDir: string,
	runId: string,
	tasks: Task[],
): void {
	const milhouseDir = join(workDir, ".milhouse");
	const runsDir = join(milhouseDir, "runs", runId);
	const stateDir = join(runsDir, "state");

	// Create directory structure
	mkdirSync(stateDir, { recursive: true });

	// Create runs-index.json
	const runsIndex = {
		current_run: runId,
		runs: [{ id: runId, created_at: new Date().toISOString(), phase: "exec" }],
	};
	writeFileSync(join(milhouseDir, "runs-index.json"), JSON.stringify(runsIndex, null, 2));

	// Create run meta
	const runMeta = {
		id: runId,
		created_at: new Date().toISOString(),
		phase: "exec",
		scope: "test",
	};
	writeFileSync(join(runsDir, "run-meta.json"), JSON.stringify(runMeta, null, 2));

	// Save tasks
	writeFileSync(join(stateDir, "tasks.json"), JSON.stringify(tasks, null, 2));
}

/**
 * Creates a task with acceptance criteria
 */
function createTask(
	id: string,
	title: string,
	acceptance: Array<{ description: string; check_command?: string; verified?: boolean }>,
): Task {
	return {
		id,
		title,
		files: [],
		status: "done",
		acceptance: acceptance.map((a) => ({
			description: a.description,
			check_command: a.check_command,
			verified: a.verified ?? false,
		})),
		depends_on: [],
		checks: [],
		parallel_group: 0,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	};
}

// ============================================================================
// TEST SUITES
// ============================================================================

describe("Verify DoD Integration - E2E Smoke Tests", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
		initGitRepo(tempDir);
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// ==========================================================================
	// Validation Policy Tests
	// ==========================================================================

	describe("validateCheckCommand policy", () => {
		test("commands with pipes generate warnings but are valid", () => {
			const command = "grep -n 'pattern' file.txt | head -5";
			const result = validateCheckCommand(command);

			expect(result.valid).toBe(true);
			expect(result.issues).toHaveLength(0);
			expect(result.warnings.length).toBeGreaterThan(0);
			expect(result.warnings.some((w) => w.includes("pipe"))).toBe(true);
		});

		test("commands with && generate warnings but are valid", () => {
			const command = "npm run build && npm test";
			const result = validateCheckCommand(command);

			expect(result.valid).toBe(true);
			expect(result.issues).toHaveLength(0);
			expect(result.warnings.length).toBeGreaterThan(0);
			expect(result.warnings.some((w) => w.includes("&&"))).toBe(true);
		});

		test("commands with || generate warnings but are valid", () => {
			const command = "test -f file.txt || echo 'not found'";
			const result = validateCheckCommand(command);

			expect(result.valid).toBe(true);
			expect(result.issues).toHaveLength(0);
			expect(result.warnings.length).toBeGreaterThan(0);
			expect(result.warnings.some((w) => w.includes("||"))).toBe(true);
		});

		test("commands with semicolons generate warnings but are valid", () => {
			const command = "cd src; npm test";
			const result = validateCheckCommand(command);

			expect(result.valid).toBe(true);
			expect(result.issues).toHaveLength(0);
			expect(result.warnings.length).toBeGreaterThan(0);
			expect(result.warnings.some((w) => w.includes(";"))).toBe(true);
		});

		test("commands with redirects generate warnings but are valid", () => {
			const command = "npm test > output.log";
			const result = validateCheckCommand(command);

			expect(result.valid).toBe(true);
			expect(result.issues).toHaveLength(0);
			expect(result.warnings.length).toBeGreaterThan(0);
			expect(result.warnings.some((w) => w.includes("redirect"))).toBe(true);
		});

		test("truly dangerous commands are blocked (sudo)", () => {
			const command = "sudo rm -rf /tmp/test";
			const result = validateCheckCommand(command);

			expect(result.valid).toBe(false);
			expect(result.issues.length).toBeGreaterThan(0);
			expect(result.issues.some((i) => i.includes("dangerous"))).toBe(true);
		});

		test("truly dangerous commands are blocked (rm -rf /)", () => {
			const command = "rm -rf /";
			const result = validateCheckCommand(command);

			expect(result.valid).toBe(false);
			expect(result.issues.length).toBeGreaterThan(0);
		});

		test("interactive commands are blocked (vim)", () => {
			const command = "vim file.txt";
			const result = validateCheckCommand(command);

			expect(result.valid).toBe(false);
			expect(result.issues.length).toBeGreaterThan(0);
			expect(result.issues.some((i) => i.includes("interactive"))).toBe(true);
		});

		test("safe commands with allowed prefixes have no warnings", () => {
			const command = "npm test";
			const result = validateCheckCommand(command);

			expect(result.valid).toBe(true);
			expect(result.issues).toHaveLength(0);
			expect(result.warnings).toHaveLength(0);
		});

		test("grep command is allowed", () => {
			const command = "grep -n 'pattern' src/file.ts";
			const result = validateCheckCommand(command);

			expect(result.valid).toBe(true);
			expect(result.issues).toHaveLength(0);
		});

		test("bun test command is allowed", () => {
			const command = "bun test src/file.test.ts";
			const result = validateCheckCommand(command);

			expect(result.valid).toBe(true);
			expect(result.issues).toHaveLength(0);
		});
	});

	// ==========================================================================
	// DoD Gate Execution Tests
	// ==========================================================================

	describe("runDoDGate execution", () => {
		test("DoD gate updates criterion.verified=true for passing commands", () => {
			const runId = "run-test-dod-verified";

			// Create a task with a check_command that will pass (echo always succeeds)
			const tasks = [
				createTask("T1", "Test task with passing check", [
					{
						description: "Echo test passes",
						check_command: "echo 'test passed'",
						verified: false,
					},
				]),
			];

			setupMockRun(tempDir, runId, tasks);

			// Run DoD gate
			const result = runDoDGate(runId, tempDir);

			// Verify gate passed
			expect(result.passed).toBe(true);
			expect(result.gate).toBe("dod");

			// Load tasks and verify criterion.verified was updated
			const updatedTasks = loadTasksForRun(runId, tempDir);
			expect(updatedTasks[0].acceptance[0].verified).toBe(true);
		});

		test("DoD gate does NOT skip commands with pipes (warnings only)", () => {
			const runId = "run-test-pipe-not-skipped";

			// Create a task with a pipe command that should execute (not skip)
			// Using echo | cat which will always succeed
			const tasks = [
				createTask("T1", "Test task with pipe command", [
					{
						description: "Pipe command executes",
						check_command: "echo 'test' | cat",
						verified: false,
					},
				]),
			];

			setupMockRun(tempDir, runId, tasks);

			// Run DoD gate
			const result = runDoDGate(runId, tempDir);

			// Verify gate passed - command was executed, not skipped
			expect(result.passed).toBe(true);

			// Load tasks and verify criterion.verified was updated (command ran)
			const updatedTasks = loadTasksForRun(runId, tempDir);
			expect(updatedTasks[0].acceptance[0].verified).toBe(true);
		});

		test("DoD gate does NOT skip commands with && (warnings only)", () => {
			const runId = "run-test-and-not-skipped";

			// Create a task with && command that should execute
			const tasks = [
				createTask("T1", "Test task with && command", [
					{
						description: "Chained command executes",
						check_command: "echo 'first' && echo 'second'",
						verified: false,
					},
				]),
			];

			setupMockRun(tempDir, runId, tasks);

			// Run DoD gate
			const result = runDoDGate(runId, tempDir);

			// Verify gate passed - command was executed, not skipped
			expect(result.passed).toBe(true);

			// Load tasks and verify criterion.verified was updated
			const updatedTasks = loadTasksForRun(runId, tempDir);
			expect(updatedTasks[0].acceptance[0].verified).toBe(true);
		});

		test("DoD gate DOES skip truly dangerous commands (sudo)", () => {
			const runId = "run-test-sudo-skipped";

			// Create a task with a dangerous command that should be skipped
			const tasks = [
				createTask("T1", "Test task with dangerous command", [
					{
						description: "Sudo command should be skipped",
						check_command: "sudo echo 'test'",
						verified: false,
					},
				]),
			];

			setupMockRun(tempDir, runId, tasks);

			// Run DoD gate
			const result = runDoDGate(runId, tempDir);

			// Verify gate did NOT pass (command was skipped/failed validation)
			expect(result.passed).toBe(false);

			// Load tasks and verify criterion.verified was NOT updated
			const updatedTasks = loadTasksForRun(runId, tempDir);
			expect(updatedTasks[0].acceptance[0].verified).toBe(false);
		});

		test("DoD gate handles multiple criteria with mixed results", () => {
			const runId = "run-test-mixed-criteria";

			// Create a task with multiple criteria
			const tasks = [
				createTask("T1", "Test task with multiple criteria", [
					{
						description: "Passing check",
						check_command: "echo 'pass'",
						verified: false,
					},
					{
						description: "Pipe check (should also pass)",
						check_command: "echo 'test' | grep test",
						verified: false,
					},
					{
						description: "Failing check",
						check_command: "exit 1",
						verified: false,
					},
				]),
			];

			setupMockRun(tempDir, runId, tasks);

			// Run DoD gate
			const result = runDoDGate(runId, tempDir);

			// Gate should fail because one check failed
			expect(result.passed).toBe(false);

			// Load tasks and verify verified status
			const updatedTasks = loadTasksForRun(runId, tempDir);
			expect(updatedTasks[0].acceptance[0].verified).toBe(true); // echo pass
			expect(updatedTasks[0].acceptance[1].verified).toBe(true); // pipe command executed
			expect(updatedTasks[0].acceptance[2].verified).toBe(false); // exit 1 failed
		});

		test("DoD gate with no acceptance criteria passes", () => {
			const runId = "run-test-no-criteria";

			const tasks = [
				createTask("T1", "Test task with no criteria", []),
			];

			setupMockRun(tempDir, runId, tasks);

			// Run DoD gate
			const result = runDoDGate(runId, tempDir);

			expect(result.passed).toBe(true);
			expect(result.message).toContain("No acceptance criteria");
		});

		test("DoD gate with already verified criteria does not re-run", () => {
			const runId = "run-test-already-verified";

			// Create a task with already verified criteria
			const tasks = [
				createTask("T1", "Test task with verified criteria", [
					{
						description: "Already verified",
						check_command: "exit 1", // Would fail if run, but should be skipped
						verified: true,
					},
				]),
			];

			setupMockRun(tempDir, runId, tasks);

			// Run DoD gate
			const result = runDoDGate(runId, tempDir);

			// Gate should pass because criterion is already verified
			expect(result.passed).toBe(true);
		});
	});

	// ==========================================================================
	// Real-world Command Pattern Tests
	// ==========================================================================

	describe("real-world command patterns from fix_pipeline.md", () => {
		test("grep with pipe pattern from existing runs is executed", () => {
			// This pattern was found in the existing run: T3, T4, T5
			const command = "grep -n 'readFile' src/state/tasks.ts | grep -v 'Sync'";
			const result = validateCheckCommand(command);

			// Should be valid (not blocked), just warnings
			expect(result.valid).toBe(true);
			expect(result.issues).toHaveLength(0);
			// Should have warning about pipe
			expect(result.warnings.some((w) => w.includes("pipe"))).toBe(true);
		});

		test("grep with -A and pipe pattern is executed", () => {
			// This pattern was found in the existing run: T14
			const command = "grep -A2 '@deprecated' src/state/tasks.ts | grep -c 'Async'";
			const result = validateCheckCommand(command);

			// Should be valid (not blocked), just warnings
			expect(result.valid).toBe(true);
			expect(result.issues).toHaveLength(0);
		});

		test("bun test command is fully allowed", () => {
			const command = "bun test src/cli/commands/verify.test.ts";
			const result = validateCheckCommand(command);

			expect(result.valid).toBe(true);
			expect(result.issues).toHaveLength(0);
			expect(result.warnings).toHaveLength(0);
		});

		test("npm run test is fully allowed", () => {
			const command = "npm run test";
			const result = validateCheckCommand(command);

			expect(result.valid).toBe(true);
			expect(result.issues).toHaveLength(0);
			expect(result.warnings).toHaveLength(0);
		});
	});

	// ==========================================================================
	// Edge Cases
	// ==========================================================================

	describe("edge cases", () => {
		test("empty command is blocked", () => {
			const result = validateCheckCommand("");
			expect(result.valid).toBe(false);
			expect(result.issues.some((i) => i.includes("empty"))).toBe(true);
		});

		test("whitespace-only command is blocked", () => {
			const result = validateCheckCommand("   ");
			expect(result.valid).toBe(false);
		});

		test("command with unrecognized prefix generates warning but is valid", () => {
			const command = "customtool --check";
			const result = validateCheckCommand(command);

			expect(result.valid).toBe(true);
			expect(result.warnings.some((w) => w.includes("unrecognized prefix"))).toBe(true);
		});

		test("sed -i is NOT blocked (in-place edit, not interactive)", () => {
			// sed -i is safe (in-place edit), unlike rm -i (interactive prompt)
			const command = "sed -i 's/old/new/g' file.txt";
			const result = validateCheckCommand(command);

			// sed is not in the allowed prefixes, so it will have a warning
			// but it should NOT be blocked as interactive
			expect(result.valid).toBe(true);
			expect(result.issues.filter((i) => i.includes("interactive"))).toHaveLength(0);
		});
	});
});
