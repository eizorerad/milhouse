/**
 * Unit tests for OpenCode UI Components
 *
 * Tests the status dashboard and attach instructions display functionality.
 *
 * @module tests/unit/engines/opencode-ui
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	type ServerInfo,
	displayAttachInstructions,
	displayServerInfo,
	displayTmuxCompletionSummary,
	displayTmuxLayoutCommand,
	displayTmuxModeHeader,
	formatServerStatusLine,
} from "../../../src/engines/opencode/ui/attach-instructions";
import {
	type AgentStatus,
	clearAgentStatuses,
	createProgressBar,
	displayAgentSummary,
	displayStatusDashboard,
	formatCompactStatus,
	formatTokenPair,
	formatTokens,
	getAllAgentStatuses,
	padString,
	updateAgentStatus,
} from "../../../src/engines/opencode/ui/status-dashboard";
import { stripAnsi } from "../../../src/utils/ansi-string";

describe("Status Dashboard UI", () => {
	describe("formatTokens", () => {
		it("should format small numbers as-is", () => {
			expect(formatTokens(500)).toBe("500");
			expect(formatTokens(999)).toBe("999");
		});

		it("should format thousands with k suffix", () => {
			expect(formatTokens(1000)).toBe("1.0k");
			expect(formatTokens(1500)).toBe("1.5k");
			expect(formatTokens(12500)).toBe("12.5k");
			expect(formatTokens(100000)).toBe("100.0k");
		});

		it("should handle zero", () => {
			expect(formatTokens(0)).toBe("-");
		});

		it("should handle edge cases", () => {
			expect(formatTokens(1)).toBe("1");
			expect(formatTokens(10)).toBe("10");
			expect(formatTokens(100)).toBe("100");
		});
	});

	describe("formatTokenPair", () => {
		it("should format input/output token pair", () => {
			expect(formatTokenPair(12500, 8200)).toBe("12.5k/8.2k");
			expect(formatTokenPair(500, 300)).toBe("500/300");
		});

		it("should handle zero values", () => {
			expect(formatTokenPair(0, 0)).toBe("-");
			expect(formatTokenPair(1000, 0)).toBe("1.0k/-");
			expect(formatTokenPair(0, 1000)).toBe("-/1.0k");
		});

		it("should handle mixed values", () => {
			expect(formatTokenPair(500, 1500)).toBe("500/1.5k");
			expect(formatTokenPair(2000, 500)).toBe("2.0k/500");
		});
	});

	describe("Agent Status Management", () => {
		beforeEach(() => {
			clearAgentStatuses();
		});

		afterEach(() => {
			clearAgentStatuses();
		});

		it("should update agent status", () => {
			updateAgentStatus("ISSUE-001", {
				status: "running",
				tasksCompleted: 2,
				tasksTotal: 5,
				inputTokens: 1000,
				outputTokens: 500,
				port: 4096,
			});

			const statuses = getAllAgentStatuses();
			expect(statuses.length).toBe(1);
			expect(statuses[0].issueId).toBe("ISSUE-001");
			expect(statuses[0].status).toBe("running");
		});

		it("should update existing agent status", () => {
			updateAgentStatus("ISSUE-001", {
				status: "running",
				tasksCompleted: 1,
				tasksTotal: 5,
				port: 4096,
			});

			updateAgentStatus("ISSUE-001", {
				tasksCompleted: 3,
				status: "completed",
			});

			const statuses = getAllAgentStatuses();
			expect(statuses.length).toBe(1);
			expect(statuses[0].tasksCompleted).toBe(3);
			expect(statuses[0].status).toBe("completed");
		});

		it("should clear all agent statuses", () => {
			updateAgentStatus("ISSUE-001", { status: "running", port: 4096 });
			updateAgentStatus("ISSUE-002", { status: "running", port: 4097 });

			expect(getAllAgentStatuses().length).toBe(2);

			clearAgentStatuses();

			expect(getAllAgentStatuses().length).toBe(0);
		});
	});

	describe("formatCompactStatus", () => {
		it("should format status with running agents", () => {
			const agents: AgentStatus[] = [
				{
					issueId: "ISSUE-001",
					status: "running",
					tasksCompleted: 2,
					tasksTotal: 5,
					inputTokens: 1000,
					outputTokens: 500,
					port: 4096,
				},
				{
					issueId: "ISSUE-002",
					status: "running",
					tasksCompleted: 1,
					tasksTotal: 3,
					inputTokens: 500,
					outputTokens: 200,
					port: 4097,
				},
			];

			const result = formatCompactStatus(agents);
			expect(result).toContain("●2");
			expect(result).toContain("/2]");
		});

		it("should format status with completed agents", () => {
			const agents: AgentStatus[] = [
				{
					issueId: "ISSUE-001",
					status: "completed",
					tasksCompleted: 5,
					tasksTotal: 5,
					inputTokens: 1000,
					outputTokens: 500,
					port: 4096,
				},
			];

			const result = formatCompactStatus(agents);
			expect(result).toContain("✓1");
		});

		it("should format status with failed agents", () => {
			const agents: AgentStatus[] = [
				{
					issueId: "ISSUE-001",
					status: "error",
					tasksCompleted: 2,
					tasksTotal: 5,
					inputTokens: 1000,
					outputTokens: 500,
					port: 4096,
					error: "Test error",
				},
			];

			const result = formatCompactStatus(agents);
			expect(result).toContain("✗1");
		});

		it("should handle empty agents array", () => {
			const result = formatCompactStatus([]);
			expect(result).toBe("[○0/0]");
		});
	});

	describe("createProgressBar", () => {
		it("should create progress bar for partial completion", () => {
			const bar = createProgressBar(5, 10, 10);
			expect(bar).toContain("50%");
		});

		it("should create progress bar for full completion", () => {
			const bar = createProgressBar(10, 10, 10);
			expect(bar).toContain("100%");
		});

		it("should create progress bar for zero progress", () => {
			const bar = createProgressBar(0, 10, 10);
			expect(bar).toContain("0%");
		});

		it("should handle zero total", () => {
			const bar = createProgressBar(0, 0, 10);
			expect(bar).toContain("░");
		});
	});

	describe("displayStatusDashboard", () => {
		let consoleSpy: ReturnType<typeof spyOn>;
		let output: string[];

		beforeEach(() => {
			output = [];
			consoleSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
				output.push(String(args[0]));
			});
		});

		afterEach(() => {
			consoleSpy.mockRestore();
		});

		it("should display dashboard with agents", () => {
			const agents: AgentStatus[] = [
				{
					issueId: "ISSUE-001",
					status: "running",
					tasksCompleted: 2,
					tasksTotal: 5,
					inputTokens: 12500,
					outputTokens: 8200,
					port: 4096,
				},
			];

			displayStatusDashboard(agents);

			const fullOutput = output.join("\n");
			expect(fullOutput).toContain("MILHOUSE AGENT STATUS");
			expect(fullOutput).toContain("ISSUE-001");
			expect(fullOutput).toContain("4096");
		});

		it("should handle empty agents array", () => {
			displayStatusDashboard([]);

			const fullOutput = output.join("\n");
			expect(fullOutput).toContain("No agents to display");
		});

		it("should respect showTokens option", () => {
			const agents: AgentStatus[] = [
				{
					issueId: "ISSUE-001",
					status: "running",
					tasksCompleted: 2,
					tasksTotal: 5,
					inputTokens: 12500,
					outputTokens: 8200,
					port: 4096,
				},
			];

			displayStatusDashboard(agents, { showTokens: false });

			const fullOutput = output.join("\n");
			expect(fullOutput).toContain("ISSUE-001");
			// Tokens column should not be present
			expect(fullOutput).not.toContain("12.5k");
		});
	});

	describe("displayAgentSummary", () => {
		let consoleSpy: ReturnType<typeof spyOn>;
		let output: string[];

		beforeEach(() => {
			output = [];
			consoleSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
				output.push(String(args[0]));
			});
		});

		afterEach(() => {
			consoleSpy.mockRestore();
		});

		it("should display summary with completed agents", () => {
			const agents: AgentStatus[] = [
				{
					issueId: "ISSUE-001",
					status: "completed",
					tasksCompleted: 5,
					tasksTotal: 5,
					inputTokens: 1000,
					outputTokens: 500,
					port: 4096,
				},
			];

			displayAgentSummary(agents);

			const fullOutput = output.join("\n");
			expect(fullOutput).toContain("Agent Execution Summary");
			expect(fullOutput).toContain("Completed: 1/1");
		});

		it("should display failed agents", () => {
			const agents: AgentStatus[] = [
				{
					issueId: "ISSUE-001",
					status: "error",
					tasksCompleted: 2,
					tasksTotal: 5,
					inputTokens: 1000,
					outputTokens: 500,
					port: 4096,
					error: "Test error message",
				},
			];

			displayAgentSummary(agents);

			const fullOutput = output.join("\n");
			expect(fullOutput).toContain("Failed:");
			expect(fullOutput).toContain("Test error message");
		});
	});

	describe("padString", () => {
		it("should pad plain text shorter than width", () => {
			const result = padString("hello", 10);
			expect(result).toBe("hello     ");
			expect(result.length).toBe(10);
		});

		it("should return plain text exactly at width unchanged", () => {
			const result = padString("hello", 5);
			expect(result).toBe("hello");
		});

		it("should truncate plain text longer than width with ellipsis", () => {
			const result = padString("hello world", 8);
			const visible = stripAnsi(result);
			expect(visible.length).toBeLessThanOrEqual(8);
			expect(visible).toContain("…");
		});

		it("should pad ANSI-colored text based on visible length", () => {
			const colored = "\x1b[32mhi\x1b[0m";
			const result = padString(colored, 10);
			const visible = stripAnsi(result);
			expect(visible.length).toBe(10);
			expect(visible).toBe("hi        ");
		});

		it("should truncate ANSI-colored text longer than width without broken sequences", () => {
			// "Hello World" is 11 visible chars, colored green
			const colored = "\x1b[32mHello World\x1b[0m";
			const result = padString(colored, 8);
			const visible = stripAnsi(result);
			expect(visible.length).toBeLessThanOrEqual(8);
			// Should not contain broken escape sequence fragments
			expect(result).not.toMatch(/\x1b\[[0-9;]*$/);
			expect(result).not.toMatch(/\x1b$/);
		});

		it("should not split ANSI escape sequence mid-sequence (color bleed prevention)", () => {
			// Build a string where naive slice would cut inside an escape sequence
			const colored = "\x1b[32mAB\x1b[31mCDEFGHIJ\x1b[0m";
			const result = padString(colored, 5);
			const visible = stripAnsi(result);
			expect(visible.length).toBeLessThanOrEqual(5);
			// Ensure no incomplete/dangling escape sequences (e.g. "\x1b[" without closing "m")
			expect(result).not.toMatch(/\x1b\[[0-9;]*$/);
			expect(result).not.toMatch(/\x1b$/);
			// The visible text should end with ellipsis from truncation
			expect(visible).toContain("…");
		});

		it("should right-align text", () => {
			const result = padString("hi", 6, "right");
			expect(result).toBe("    hi");
		});

		it("should center-align text", () => {
			const result = padString("hi", 6, "center");
			expect(result).toBe("  hi  ");
		});
	});
});

describe("Attach Instructions UI", () => {
	let consoleSpy: ReturnType<typeof spyOn>;
	let output: string[];

	beforeEach(() => {
		output = [];
		consoleSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			output.push(String(args[0]));
		});
	});

	afterEach(() => {
		consoleSpy.mockRestore();
	});

	describe("displayTmuxModeHeader", () => {
		it("should display tmux mode header", () => {
			displayTmuxModeHeader();

			const fullOutput = output.join("\n");
			expect(fullOutput).toContain("TMUX MODE ENABLED");
		});
	});

	describe("displayServerInfo", () => {
		it("should display server information", () => {
			const servers: ServerInfo[] = [
				{
					issueId: "ISSUE-001",
					port: 4096,
					sessionName: "milhouse-ISSUE-001",
					status: "running",
				},
			];

			displayServerInfo(servers);

			const fullOutput = output.join("\n");
			expect(fullOutput).toContain("ISSUE-001");
			expect(fullOutput).toContain("4096");
			expect(fullOutput).toContain("opencode attach");
		});

		it("should handle empty servers array", () => {
			displayServerInfo([]);

			const fullOutput = output.join("\n");
			expect(fullOutput).toContain("No servers running");
		});

		it("should display error for failed servers", () => {
			const servers: ServerInfo[] = [
				{
					issueId: "ISSUE-001",
					port: 4096,
					sessionName: "milhouse-ISSUE-001",
					status: "error",
					error: "Connection failed",
				},
			];

			displayServerInfo(servers);

			const fullOutput = output.join("\n");
			expect(fullOutput).toContain("Connection failed");
		});
	});

	describe("displayTmuxLayoutCommand", () => {
		it("should generate valid tmux commands for multiple servers", () => {
			const servers: ServerInfo[] = [
				{
					issueId: "ISSUE-001",
					port: 4096,
					sessionName: "milhouse-ISSUE-001",
					status: "running",
				},
				{
					issueId: "ISSUE-002",
					port: 4097,
					sessionName: "milhouse-ISSUE-002",
					status: "running",
				},
			];

			const cmd = displayTmuxLayoutCommand(servers);

			expect(cmd).toContain("tmux new-session -d -s milhouse-agents");
			expect(cmd).toContain("tmux split-window");
			expect(cmd).toContain("tmux send-keys -t 0");
			expect(cmd).toContain("tmux send-keys -t 1");
			expect(cmd).toContain("opencode attach http://localhost:4096");
			expect(cmd).toContain("opencode attach http://localhost:4097");
			expect(cmd).toContain("tmux attach -t milhouse-agents");
		});

		it("should handle single server", () => {
			const servers: ServerInfo[] = [
				{
					issueId: "ISSUE-001",
					port: 4096,
					sessionName: "milhouse-ISSUE-001",
					status: "running",
				},
			];

			const cmd = displayTmuxLayoutCommand(servers);

			expect(cmd).toContain("tmux new-session");
			expect(cmd).toContain("opencode attach http://localhost:4096");
			expect(cmd).not.toContain("split-window");
		});

		it("should return empty string for empty servers array", () => {
			const cmd = displayTmuxLayoutCommand([]);
			expect(cmd).toBe("");
		});

		it("should use custom URL if provided", () => {
			const servers: ServerInfo[] = [
				{
					issueId: "ISSUE-001",
					port: 4096,
					sessionName: "milhouse-ISSUE-001",
					status: "running",
					url: "http://custom-host:4096",
				},
			];

			const cmd = displayTmuxLayoutCommand(servers);

			expect(cmd).toContain("http://custom-host:4096");
		});
	});

	describe("formatServerStatusLine", () => {
		it("should format running server status", () => {
			const server: ServerInfo = {
				issueId: "ISSUE-001",
				port: 4096,
				sessionName: "milhouse-ISSUE-001",
				status: "running",
			};

			const line = formatServerStatusLine(server);

			expect(line).toContain("ISSUE-001");
			expect(line).toContain("4096");
		});

		it("should format completed server status", () => {
			const server: ServerInfo = {
				issueId: "ISSUE-001",
				port: 4096,
				sessionName: "milhouse-ISSUE-001",
				status: "completed",
			};

			const line = formatServerStatusLine(server);

			expect(line).toContain("ISSUE-001");
		});
	});

	describe("displayAttachInstructions", () => {
		it("should display full attach instructions", () => {
			const servers: ServerInfo[] = [
				{
					issueId: "ISSUE-001",
					port: 4096,
					sessionName: "milhouse-ISSUE-001",
					status: "running",
				},
			];

			displayAttachInstructions(servers);

			const fullOutput = output.join("\n");
			expect(fullOutput).toContain("TMUX MODE ENABLED");
			expect(fullOutput).toContain("ISSUE-001");
		});

		it("should show tmux layout command for multiple servers", () => {
			const servers: ServerInfo[] = [
				{
					issueId: "ISSUE-001",
					port: 4096,
					sessionName: "milhouse-ISSUE-001",
					status: "running",
				},
				{
					issueId: "ISSUE-002",
					port: 4097,
					sessionName: "milhouse-ISSUE-002",
					status: "running",
				},
			];

			displayAttachInstructions(servers);

			const fullOutput = output.join("\n");
			expect(fullOutput).toContain("attach all in tmux");
		});
	});

	describe("displayTmuxCompletionSummary", () => {
		it("should display completion summary", () => {
			const servers: ServerInfo[] = [
				{
					issueId: "ISSUE-001",
					port: 4096,
					sessionName: "milhouse-ISSUE-001",
					status: "completed",
				},
			];

			displayTmuxCompletionSummary(servers);

			const fullOutput = output.join("\n");
			expect(fullOutput).toContain("Tmux Mode Summary");
			expect(fullOutput).toContain("Completed: 1/1");
		});

		it("should display failed count", () => {
			const servers: ServerInfo[] = [
				{
					issueId: "ISSUE-001",
					port: 4096,
					sessionName: "milhouse-ISSUE-001",
					status: "error",
				},
			];

			displayTmuxCompletionSummary(servers);

			const fullOutput = output.join("\n");
			expect(fullOutput).toContain("Failed:");
		});

		it("should show preserved sessions", () => {
			const servers: ServerInfo[] = [
				{
					issueId: "ISSUE-001",
					port: 4096,
					sessionName: "milhouse-ISSUE-001",
					status: "completed",
				},
			];

			displayTmuxCompletionSummary(servers);

			const fullOutput = output.join("\n");
			expect(fullOutput).toContain("Tmux sessions preserved");
			expect(fullOutput).toContain("tmux attach -t milhouse-ISSUE-001");
		});
	});
});
