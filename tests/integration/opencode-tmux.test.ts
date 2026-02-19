/**
 * Integration tests for OpenCode tmux Mode
 *
 * Tests the full execution flow with OpenCode server and tmux sessions.
 * These tests require OpenCode and tmux to be installed.
 *
 * @module tests/integration/opencode-tmux
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { OpencodeServerExecutor } from "../../src/engines/opencode/server-executor";
import { TmuxSessionManager, isTmuxAvailable } from "../../src/engines/tmux/session-manager";
import { OpencodeInstaller } from "../../src/engines/opencode/installer";
import { PortManager } from "../../src/engines/opencode/port-manager";

// Skip integration tests if environment variable is set
const skipIntegrationTests = process.env.SKIP_OPENCODE_TESTS === "true";

describe("OpenCode tmux Integration", () => {
	let isOpencodeInstalled = false;
	let isTmuxInstalled = false;
	let installer: OpencodeInstaller;
	let tmuxManager: TmuxSessionManager;

	beforeAll(async () => {
		// Check prerequisites
		installer = new OpencodeInstaller();
		isOpencodeInstalled = await installer.isInstalled();

		tmuxManager = new TmuxSessionManager({ sessionPrefix: "test-integration" });
		isTmuxInstalled = await isTmuxAvailable();

		// Reset port manager
		PortManager.reset();
	});

	afterAll(async () => {
		// Clean up any test sessions
		if (isTmuxInstalled) {
			await tmuxManager.killAllPrefixedSessions();
		}
		PortManager.reset();
	});

	describe("Prerequisites check", () => {
		it("should detect OpenCode installation status", async () => {
			expect(typeof isOpencodeInstalled).toBe("boolean");
			if (isOpencodeInstalled) {
				const version = await installer.getVersion();
				expect(version).not.toBeNull();
				console.log(`OpenCode version: ${version}`);
			} else {
				console.log("OpenCode is not installed - some tests will be skipped");
			}
		});

		it("should detect tmux installation status", async () => {
			expect(typeof isTmuxInstalled).toBe("boolean");
			if (isTmuxInstalled) {
				const version = await tmuxManager.getTmuxVersion();
				expect(version).not.toBeNull();
				console.log(`tmux version: ${version}`);
			} else {
				console.log("tmux is not installed - some tests will be skipped");
			}
		});
	});

	describe("Full execution flow", () => {
		it.skipIf(skipIntegrationTests || !isOpencodeInstalled)(
			"should start server and execute task",
			async () => {
				const executor = new OpencodeServerExecutor({
					startupTimeout: 60000,
					verbose: false,
				});

				try {
					// Start server
					const port = await executor.startServer(process.cwd());
					expect(port).toBeGreaterThanOrEqual(4096);
					expect(executor.isServerRunning()).toBe(true);

					// Health check
					const isHealthy = await executor.healthCheck();
					expect(isHealthy).toBe(true);

					// Create session
					const session = await executor.createSession({ title: "Test Session" });
					expect(session.id).toBeDefined();

					// Get session status
					const status = await executor.getSessionStatus(session.id);
					expect(status.status).toBe("idle");

					// Clean up session
					await executor.deleteSession(session.id);
				} finally {
					// Always stop server
					await executor.stopServer();
					expect(executor.isServerRunning()).toBe(false);
				}
			},
		);

		it.skipIf(skipIntegrationTests || !isOpencodeInstalled || !isTmuxInstalled)(
			"should create tmux session with opencode attach",
			async () => {
				const executor = new OpencodeServerExecutor({
					startupTimeout: 60000,
					verbose: false,
				});

				try {
					// Start server
					const port = await executor.startServer(process.cwd());
					const baseUrl = executor.getBaseUrl();

					// Create tmux session with attach command
					const result = await tmuxManager.createSession({
						name: "test-attach",
						command: `echo "Would attach to ${baseUrl}"`,
					});

					expect(result.success).toBe(true);
					expect(result.data?.sessionName).toContain("test-integration");

					// Verify session exists
					const exists = await tmuxManager.sessionExists(result.data!.sessionName);
					expect(exists).toBe(true);

					// Clean up tmux session
					await tmuxManager.killSession("test-attach");
				} finally {
					await executor.stopServer();
				}
			},
		);
	});

	describe("Multiple concurrent agents", () => {
		it.skipIf(skipIntegrationTests || !isOpencodeInstalled)(
			"should handle multiple concurrent servers",
			async () => {
				const executors: OpencodeServerExecutor[] = [];
				const ports: number[] = [];

				try {
					// Start multiple servers
					for (let i = 0; i < 2; i++) {
						const executor = new OpencodeServerExecutor({
							startupTimeout: 60000,
							verbose: false,
						});
						const port = await executor.startServer(process.cwd());
						executors.push(executor);
						ports.push(port);
					}

					// Verify all servers are running on different ports
					expect(ports.length).toBe(2);
					expect(new Set(ports).size).toBe(2); // All ports unique

					// Verify all servers are healthy
					for (const executor of executors) {
						const isHealthy = await executor.healthCheck();
						expect(isHealthy).toBe(true);
					}
				} finally {
					// Stop all servers
					for (const executor of executors) {
						await executor.stopServer();
					}
				}
			},
		);

		it.skipIf(skipIntegrationTests || !isTmuxInstalled)(
			"should create multiple tmux sessions",
			async () => {
				const sessionNames: string[] = [];

				try {
					// Create multiple sessions
					for (let i = 0; i < 3; i++) {
						const result = await tmuxManager.createSession({
							name: `test-multi-${i}`,
							command: `echo "Session ${i}"`,
						});

						if (result.success) {
							sessionNames.push(`test-multi-${i}`);
						}
					}

					// Verify all sessions exist
					const sessions = await tmuxManager.listSessions(true);
					const testSessions = sessions.filter((s) =>
						s.name.includes("test-multi"),
					);
					expect(testSessions.length).toBe(sessionNames.length);
				} finally {
					// Clean up
					for (const name of sessionNames) {
						await tmuxManager.killSession(name);
					}
				}
			},
		);
	});

	describe("Graceful shutdown", () => {
		it.skipIf(skipIntegrationTests || !isOpencodeInstalled)(
			"should cleanup on graceful shutdown",
			async () => {
				const executor = new OpencodeServerExecutor({
					startupTimeout: 60000,
					verbose: false,
				});

				// Start server
				const port = await executor.startServer(process.cwd());
				expect(executor.isServerRunning()).toBe(true);
				expect(PortManager.isPortTracked(port)).toBe(true);

				// Stop server
				await executor.stopServer();

				// Verify cleanup
				expect(executor.isServerRunning()).toBe(false);
				expect(executor.getPort()).toBeNull();
				expect(executor.getBaseUrl()).toBeNull();
				expect(PortManager.isPortTracked(port)).toBe(false);
			},
		);

		it.skipIf(skipIntegrationTests || !isTmuxInstalled)(
			"should kill all prefixed sessions on cleanup",
			async () => {
				// Create some sessions
				await tmuxManager.createSession({ name: "cleanup-1" });
				await tmuxManager.createSession({ name: "cleanup-2" });

				// Verify they exist
				let sessions = await tmuxManager.listSessions(true);
				const beforeCount = sessions.filter((s) =>
					s.name.includes("cleanup-"),
				).length;
				expect(beforeCount).toBe(2);

				// Kill all
				const killed = await tmuxManager.killAllPrefixedSessions();
				expect(killed).toBeGreaterThanOrEqual(2);

				// Verify they're gone
				sessions = await tmuxManager.listSessions(true);
				const afterCount = sessions.filter((s) =>
					s.name.includes("cleanup-"),
				).length;
				expect(afterCount).toBe(0);
			},
		);
	});

	describe("Error handling", () => {
		it.skipIf(skipIntegrationTests || !isOpencodeInstalled)(
			"should handle server startup failure gracefully",
			async () => {
				const executor = new OpencodeServerExecutor({
					startupTimeout: 1, // Very short timeout to force failure
					verbose: false,
				});

				try {
					await executor.startServer(process.cwd());
					// If we get here, the server started (unlikely with 1ms timeout)
					await executor.stopServer();
				} catch (error) {
					// Expected - server should fail to start with such short timeout
					expect(error).toBeDefined();
					expect(executor.isServerRunning()).toBe(false);
				}
			},
		);

		it.skipIf(skipIntegrationTests || !isTmuxInstalled)(
			"should handle invalid session operations gracefully",
			async () => {
				// Try to kill non-existent session
				const result = await tmuxManager.killSession("non-existent-session-xyz");
				expect(result.success).toBe(false);
				expect(result.error).toBeDefined();

				// Try to send keys to non-existent session
				const keysResult = await tmuxManager.sendKeys({
					session: "non-existent-session-xyz",
					keys: "test",
				});
				expect(keysResult.success).toBe(false);
			},
		);
	});

	describe("Port management integration", () => {
		it.skipIf(skipIntegrationTests || !isOpencodeInstalled)(
			"should properly manage ports across multiple executors",
			async () => {
				PortManager.reset();

				const executor1 = new OpencodeServerExecutor({ verbose: false });
				const executor2 = new OpencodeServerExecutor({ verbose: false });

				try {
					// Start first server
					const port1 = await executor1.startServer(process.cwd());
					expect(PortManager.getUsedPortCount()).toBe(1);

					// Start second server
					const port2 = await executor2.startServer(process.cwd());
					expect(PortManager.getUsedPortCount()).toBe(2);

					// Ports should be different
					expect(port1).not.toBe(port2);

					// Stop first server
					await executor1.stopServer();
					expect(PortManager.getUsedPortCount()).toBe(1);
					expect(PortManager.isPortTracked(port1)).toBe(false);
					expect(PortManager.isPortTracked(port2)).toBe(true);
				} finally {
					await executor1.stopServer();
					await executor2.stopServer();
				}
			},
		);
	});
});
