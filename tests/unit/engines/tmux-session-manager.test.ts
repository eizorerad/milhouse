/**
 * Unit tests for Tmux Session Manager
 *
 * Tests the tmux session management functionality.
 *
 * @module tests/unit/engines/tmux-session-manager
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	TmuxSessionManager,
	createTmuxManager,
	isTmuxAvailable,
} from "../../../src/engines/tmux/session-manager";
import type { TmuxConfig } from "../../../src/engines/tmux/types";

describe("TmuxSessionManager", () => {
	let manager: TmuxSessionManager;
	const testSessionPrefix = "test-milhouse";

	beforeEach(() => {
		manager = new TmuxSessionManager({
			sessionPrefix: testSessionPrefix,
			verbose: false,
		});
	});

	afterEach(async () => {
		// Clean up any test sessions
		try {
			await manager.killAllPrefixedSessions();
		} catch {
			// Ignore errors during cleanup
		}
	});

	describe("constructor", () => {
		it("should initialize with default config", () => {
			const defaultManager = new TmuxSessionManager();
			expect(defaultManager).toBeInstanceOf(TmuxSessionManager);
		});

		it("should accept custom config", () => {
			const config: TmuxConfig = {
				sessionPrefix: "custom-prefix",
				autoAttach: true,
				splitLayout: "vertical",
				verbose: true,
			};

			const customManager = new TmuxSessionManager(config);
			expect(customManager).toBeInstanceOf(TmuxSessionManager);
		});
	});

	describe("isTmuxAvailable", () => {
		it("should return boolean indicating tmux availability", async () => {
			const result = await manager.isTmuxAvailable();
			expect(typeof result).toBe("boolean");
		});
	});

	describe("getTmuxVersion", () => {
		it("should return version string or null", async () => {
			const result = await manager.getTmuxVersion();
			expect(result === null || typeof result === "string").toBe(true);
		});

		it("should return version in expected format when tmux is available", async () => {
			const isAvailable = await manager.isTmuxAvailable();
			if (isAvailable) {
				const version = await manager.getTmuxVersion();
				expect(version).not.toBeNull();
				// Version should be like "3.4" or "3.3a"
				expect(version).toMatch(/^\d+\.\d+[a-z]?$/);
			}
		});
	});

	describe("buildSessionName", () => {
		it("should add prefix to session name", () => {
			const result = manager.buildSessionName("issue-001");
			expect(result).toBe(`${testSessionPrefix}-issue-001`);
		});

		it("should not double-prefix session name", () => {
			const alreadyPrefixed = `${testSessionPrefix}-issue-001`;
			const result = manager.buildSessionName(alreadyPrefixed);
			expect(result).toBe(alreadyPrefixed);
		});

		it("should handle empty name", () => {
			const result = manager.buildSessionName("");
			expect(result).toBe(`${testSessionPrefix}-`);
		});
	});

	describe("getAttachCommand", () => {
		it("should return correct attach command", () => {
			const sessionName = "test-session";
			const result = manager.getAttachCommand(sessionName);
			expect(result).toBe(`tmux attach -t ${sessionName}`);
		});
	});

	describe("createSession (requires tmux)", () => {
		it("should return result with correct structure", async () => {
			const isAvailable = await manager.isTmuxAvailable();
			if (!isAvailable) {
				// Skip test if tmux is not available
				return;
			}

			const result = await manager.createSession({
				name: "test-create",
				command: "echo hello",
			});

			expect(typeof result.success).toBe("boolean");
			if (result.success) {
				expect(result.data).toBeDefined();
				expect(result.data?.sessionName).toContain(testSessionPrefix);
				expect(result.data?.attachCommand).toContain("tmux attach");
			}

			// Clean up
			if (result.success) {
				await manager.killSession("test-create");
			}
		});

		it("should fail when session already exists", async () => {
			const isAvailable = await manager.isTmuxAvailable();
			if (!isAvailable) {
				return;
			}

			// Create first session
			const result1 = await manager.createSession({
				name: "test-duplicate",
			});

			if (!result1.success) {
				return;
			}

			// Try to create duplicate
			const result2 = await manager.createSession({
				name: "test-duplicate",
			});

			expect(result2.success).toBe(false);
			expect(result2.error).toContain("already exists");

			// Clean up
			await manager.killSession("test-duplicate");
		});
	});

	describe("killSession (requires tmux)", () => {
		it("should kill existing session", async () => {
			const isAvailable = await manager.isTmuxAvailable();
			if (!isAvailable) {
				return;
			}

			// Create a session first
			const createResult = await manager.createSession({
				name: "test-kill",
			});

			if (!createResult.success) {
				return;
			}

			// Kill the session
			const killResult = await manager.killSession("test-kill");
			expect(killResult.success).toBe(true);

			// Verify it's gone
			const sessionName = manager.buildSessionName("test-kill");
			const exists = await manager.sessionExists(sessionName);
			expect(exists).toBe(false);
		});

		it("should handle non-existent session gracefully", async () => {
			const isAvailable = await manager.isTmuxAvailable();
			if (!isAvailable) {
				return;
			}

			const result = await manager.killSession("non-existent-session-xyz");
			expect(result.success).toBe(false);
			expect(result.error).toContain("does not exist");
		});
	});

	describe("listSessions (requires tmux)", () => {
		it("should return array of sessions", async () => {
			const isAvailable = await manager.isTmuxAvailable();
			if (!isAvailable) {
				return;
			}

			const sessions = await manager.listSessions();
			expect(Array.isArray(sessions)).toBe(true);
		});

		it("should filter by prefix when requested", async () => {
			const isAvailable = await manager.isTmuxAvailable();
			if (!isAvailable) {
				return;
			}

			// Create a test session
			const createResult = await manager.createSession({
				name: "test-list",
			});

			if (!createResult.success) {
				return;
			}

			// List with filter
			const filteredSessions = await manager.listSessions(true);
			const hasTestSession = filteredSessions.some((s) =>
				s.name.startsWith(testSessionPrefix),
			);
			expect(hasTestSession).toBe(true);

			// Clean up
			await manager.killSession("test-list");
		});

		it("should parse session info correctly", async () => {
			const isAvailable = await manager.isTmuxAvailable();
			if (!isAvailable) {
				return;
			}

			// Create a test session
			const createResult = await manager.createSession({
				name: "test-parse",
			});

			if (!createResult.success) {
				return;
			}

			const sessions = await manager.listSessions(true);
			const testSession = sessions.find((s) =>
				s.name.includes("test-parse"),
			);

			if (testSession) {
				expect(typeof testSession.name).toBe("string");
				expect(typeof testSession.id).toBe("string");
				expect(typeof testSession.windows).toBe("number");
				expect(typeof testSession.attached).toBe("boolean");
				expect(testSession.created).toBeInstanceOf(Date);
			}

			// Clean up
			await manager.killSession("test-parse");
		});
	});

	describe("sessionExists (requires tmux)", () => {
		it("should return true for existing session", async () => {
			const isAvailable = await manager.isTmuxAvailable();
			if (!isAvailable) {
				return;
			}

			// Create a session
			const createResult = await manager.createSession({
				name: "test-exists",
			});

			if (!createResult.success) {
				return;
			}

			const sessionName = manager.buildSessionName("test-exists");
			const exists = await manager.sessionExists(sessionName);
			expect(exists).toBe(true);

			// Clean up
			await manager.killSession("test-exists");
		});

		it("should return false for non-existent session", async () => {
			const isAvailable = await manager.isTmuxAvailable();
			if (!isAvailable) {
				return;
			}

			const exists = await manager.sessionExists("non-existent-session-xyz");
			expect(exists).toBe(false);
		});
	});

	describe("createWindow (requires tmux)", () => {
		it("should create window in existing session", async () => {
			const isAvailable = await manager.isTmuxAvailable();
			if (!isAvailable) {
				return;
			}

			// Create a session first
			const createResult = await manager.createSession({
				name: "test-window",
			});

			if (!createResult.success) {
				return;
			}

			const sessionName = manager.buildSessionName("test-window");
			const windowResult = await manager.createWindow({
				session: sessionName,
				name: "new-window",
			});

			expect(windowResult.success).toBe(true);

			// Clean up
			await manager.killSession("test-window");
		});
	});

	describe("listWindows (requires tmux)", () => {
		it("should return array of windows", async () => {
			const isAvailable = await manager.isTmuxAvailable();
			if (!isAvailable) {
				return;
			}

			// Create a session
			const createResult = await manager.createSession({
				name: "test-list-windows",
			});

			if (!createResult.success) {
				return;
			}

			const sessionName = manager.buildSessionName("test-list-windows");
			const windows = await manager.listWindows(sessionName);

			expect(Array.isArray(windows)).toBe(true);
			expect(windows.length).toBeGreaterThanOrEqual(1);

			if (windows.length > 0) {
				expect(typeof windows[0].name).toBe("string");
				expect(typeof windows[0].index).toBe("number");
				expect(typeof windows[0].active).toBe("boolean");
				expect(typeof windows[0].panes).toBe("number");
			}

			// Clean up
			await manager.killSession("test-list-windows");
		});
	});

	describe("listPanes (requires tmux)", () => {
		it("should return array of panes", async () => {
			const isAvailable = await manager.isTmuxAvailable();
			if (!isAvailable) {
				return;
			}

			// Create a session
			const createResult = await manager.createSession({
				name: "test-list-panes",
			});

			if (!createResult.success) {
				return;
			}

			const sessionName = manager.buildSessionName("test-list-panes");
			const panes = await manager.listPanes(sessionName);

			expect(Array.isArray(panes)).toBe(true);
			expect(panes.length).toBeGreaterThanOrEqual(1);

			if (panes.length > 0) {
				expect(typeof panes[0].index).toBe("number");
				expect(typeof panes[0].active).toBe("boolean");
				expect(typeof panes[0].width).toBe("number");
				expect(typeof panes[0].height).toBe("number");
			}

			// Clean up
			await manager.killSession("test-list-panes");
		});
	});

	describe("sendKeys (requires tmux)", () => {
		it("should send keys to session", async () => {
			const isAvailable = await manager.isTmuxAvailable();
			if (!isAvailable) {
				return;
			}

			// Create a session
			const createResult = await manager.createSession({
				name: "test-send-keys",
			});

			if (!createResult.success) {
				return;
			}

			const sessionName = manager.buildSessionName("test-send-keys");
			const result = await manager.sendKeys({
				session: sessionName,
				keys: "echo test",
			});

			expect(result.success).toBe(true);

			// Clean up
			await manager.killSession("test-send-keys");
		});
	});

	describe("splitWindow (requires tmux)", () => {
		it("should split window horizontally", async () => {
			const isAvailable = await manager.isTmuxAvailable();
			if (!isAvailable) {
				return;
			}

			// Create a session
			const createResult = await manager.createSession({
				name: "test-split",
			});

			if (!createResult.success) {
				return;
			}

			const sessionName = manager.buildSessionName("test-split");
			const result = await manager.splitWindow({
				session: sessionName,
				direction: "h",
			});

			expect(result.success).toBe(true);

			// Verify we now have 2 panes
			const panes = await manager.listPanes(sessionName);
			expect(panes.length).toBe(2);

			// Clean up
			await manager.killSession("test-split");
		});

		it("should split window vertically", async () => {
			const isAvailable = await manager.isTmuxAvailable();
			if (!isAvailable) {
				return;
			}

			// Create a session
			const createResult = await manager.createSession({
				name: "test-split-v",
			});

			if (!createResult.success) {
				return;
			}

			const sessionName = manager.buildSessionName("test-split-v");
			const result = await manager.splitWindow({
				session: sessionName,
				direction: "v",
			});

			expect(result.success).toBe(true);

			// Clean up
			await manager.killSession("test-split-v");
		});
	});

	describe("killAllPrefixedSessions (requires tmux)", () => {
		it("should kill all sessions with prefix", async () => {
			const isAvailable = await manager.isTmuxAvailable();
			if (!isAvailable) {
				return;
			}

			// Create multiple sessions
			await manager.createSession({ name: "test-kill-all-1" });
			await manager.createSession({ name: "test-kill-all-2" });

			// Kill all
			const killed = await manager.killAllPrefixedSessions();
			expect(killed).toBeGreaterThanOrEqual(0);

			// Verify they're gone
			const sessions = await manager.listSessions(true);
			const remaining = sessions.filter((s) =>
				s.name.includes("test-kill-all"),
			);
			expect(remaining.length).toBe(0);
		});
	});
});

describe("createTmuxManager", () => {
	it("should create a new manager instance", () => {
		const manager = createTmuxManager();
		expect(manager).toBeInstanceOf(TmuxSessionManager);
	});

	it("should accept configuration options", () => {
		const manager = createTmuxManager({
			sessionPrefix: "custom",
			verbose: true,
		});
		expect(manager).toBeInstanceOf(TmuxSessionManager);
	});
});

describe("isTmuxAvailable (standalone function)", () => {
	it("should return boolean", async () => {
		const result = await isTmuxAvailable();
		expect(typeof result).toBe("boolean");
	});
});
