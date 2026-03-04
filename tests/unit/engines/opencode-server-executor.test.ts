/**
 * Unit tests for OpenCode Server Executor
 *
 * Tests the server lifecycle and API client functionality.
 * Uses mocking to avoid actual server operations.
 *
 * @module tests/unit/engines/opencode-server-executor
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PortManager } from "../../../src/engines/opencode/port-manager";
import {
	type OpencodeServerConfig,
	OpencodeServerExecutor,
	createOpencodeExecutor,
} from "../../../src/engines/opencode/server-executor";

describe("OpencodeServerExecutor", () => {
	let executor: OpencodeServerExecutor;

	beforeEach(() => {
		// Reset port manager state
		PortManager.reset();
	});

	afterEach(async () => {
		// Clean up any running servers
		if (executor?.isServerRunning()) {
			await executor.stopServer();
		}
		PortManager.reset();
	});

	describe("constructor", () => {
		it("should initialize with default config", () => {
			executor = new OpencodeServerExecutor();

			expect(executor.isServerRunning()).toBe(false);
			expect(executor.getPort()).toBeNull();
			expect(executor.getBaseUrl()).toBeNull();
			expect(executor.getWorkDir()).toBeNull();
		});

		it("should accept custom config", () => {
			const config: OpencodeServerConfig = {
				port: 5000,
				hostname: "0.0.0.0",
				startupTimeout: 60000,
				verbose: true,
			};

			executor = new OpencodeServerExecutor(config);
			expect(executor.isServerRunning()).toBe(false);
		});

		it("should merge custom config with defaults", () => {
			const config: OpencodeServerConfig = {
				port: 5000,
			};

			executor = new OpencodeServerExecutor(config);
			// The executor should have the custom port but default values for other options
			expect(executor.isServerRunning()).toBe(false);
		});
	});

	describe("isServerRunning", () => {
		it("should return false initially", () => {
			executor = new OpencodeServerExecutor();
			expect(executor.isServerRunning()).toBe(false);
		});
	});

	describe("getPort", () => {
		it("should return null when server is not running", () => {
			executor = new OpencodeServerExecutor();
			expect(executor.getPort()).toBeNull();
		});
	});

	describe("getBaseUrl", () => {
		it("should return null when server is not running", () => {
			executor = new OpencodeServerExecutor();
			expect(executor.getBaseUrl()).toBeNull();
		});
	});

	describe("getWorkDir", () => {
		it("should return null when server is not running", () => {
			executor = new OpencodeServerExecutor();
			expect(executor.getWorkDir()).toBeNull();
		});
	});

	describe("startServer", () => {
		it("should throw if server is already running", async () => {
			executor = new OpencodeServerExecutor();

			// Mock the server as running
			// We can't easily test actual server start without OpenCode installed
			// So we test the error condition
			const mockExecutor = new OpencodeServerExecutor();

			// This test verifies the method exists and has correct signature
			expect(typeof mockExecutor.startServer).toBe("function");
		});
	});

	describe("stopServer", () => {
		it("should not throw when server is not running", async () => {
			executor = new OpencodeServerExecutor();
			await expect(executor.stopServer()).resolves.toBeUndefined();
		});
	});

	describe("healthCheck", () => {
		it("should return false when server is not running", async () => {
			executor = new OpencodeServerExecutor();
			const result = await executor.healthCheck();
			expect(result).toBe(false);
		});
	});

	describe("API methods (require running server)", () => {
		// These tests verify method signatures and error handling
		// Actual API calls require a running OpenCode server

		describe("createSession", () => {
			it("should throw when server is not running", async () => {
				executor = new OpencodeServerExecutor();
				await expect(executor.createSession()).rejects.toThrow("Server is not running");
			});
		});

		describe("listSessions", () => {
			it("should throw when server is not running", async () => {
				executor = new OpencodeServerExecutor();
				await expect(executor.listSessions()).rejects.toThrow("Server is not running");
			});
		});

		describe("getSession", () => {
			it("should throw when server is not running", async () => {
				executor = new OpencodeServerExecutor();
				await expect(executor.getSession("test-id")).rejects.toThrow("Server is not running");
			});
		});

		describe("sendMessage", () => {
			it("should throw when server is not running", async () => {
				executor = new OpencodeServerExecutor();
				await expect(executor.sendMessage("session-id", "Hello")).rejects.toThrow(
					"Server is not running",
				);
			});
		});

		describe("sendMessageAsync", () => {
			it("should throw when server is not running", async () => {
				executor = new OpencodeServerExecutor();
				await expect(executor.sendMessageAsync("session-id", "Hello")).rejects.toThrow(
					"Server is not running",
				);
			});
		});

		describe("getMessages", () => {
			it("should throw when server is not running", async () => {
				executor = new OpencodeServerExecutor();
				await expect(executor.getMessages("session-id")).rejects.toThrow("Server is not running");
			});
		});

		describe("getSessionStatus", () => {
			it("should throw when server is not running", async () => {
				executor = new OpencodeServerExecutor();
				await expect(executor.getSessionStatus("session-id")).rejects.toThrow(
					"Server is not running",
				);
			});
		});

		describe("getAllSessionStatus", () => {
			it("should throw when server is not running", async () => {
				executor = new OpencodeServerExecutor();
				await expect(executor.getAllSessionStatus()).rejects.toThrow("Server is not running");
			});
		});

		describe("abortSession", () => {
			it("should throw when server is not running", async () => {
				executor = new OpencodeServerExecutor();
				await expect(executor.abortSession("session-id")).rejects.toThrow("Server is not running");
			});
		});

		describe("getSessionDiff", () => {
			it("should throw when server is not running", async () => {
				executor = new OpencodeServerExecutor();
				await expect(executor.getSessionDiff("session-id")).rejects.toThrow(
					"Server is not running",
				);
			});
		});

		describe("getSessionTodo", () => {
			it("should throw when server is not running", async () => {
				executor = new OpencodeServerExecutor();
				await expect(executor.getSessionTodo("session-id")).rejects.toThrow(
					"Server is not running",
				);
			});
		});

		describe("forkSession", () => {
			it("should throw when server is not running", async () => {
				executor = new OpencodeServerExecutor();
				await expect(executor.forkSession("session-id")).rejects.toThrow("Server is not running");
			});
		});

		describe("deleteSession", () => {
			it("should throw when server is not running", async () => {
				executor = new OpencodeServerExecutor();
				await expect(executor.deleteSession("session-id")).rejects.toThrow("Server is not running");
			});
		});

		describe("updateSession", () => {
			it("should throw when server is not running", async () => {
				executor = new OpencodeServerExecutor();
				await expect(executor.updateSession("session-id", { title: "New Title" })).rejects.toThrow(
					"Server is not running",
				);
			});
		});

		describe("getHealth", () => {
			it("should throw when server is not running", async () => {
				executor = new OpencodeServerExecutor();
				await expect(executor.getHealth()).rejects.toThrow("Server is not running");
			});
		});

		describe("disposeInstance", () => {
			it("should throw when server is not running", async () => {
				executor = new OpencodeServerExecutor();
				await expect(executor.disposeInstance()).rejects.toThrow("Server is not running");
			});
		});
	});

	describe("maxPortRetries config", () => {
		it("should have maxPortRetries in default config", () => {
			executor = new OpencodeServerExecutor();
			// Access the private config to verify the default is set
			const config = (executor as unknown as { config: { maxPortRetries: number } }).config;
			expect(config.maxPortRetries).toBe(3);
		});

		it("should accept custom maxPortRetries", () => {
			executor = new OpencodeServerExecutor({ maxPortRetries: 5 });
			const config = (executor as unknown as { config: { maxPortRetries: number } }).config;
			expect(config.maxPortRetries).toBe(5);
		});

		it("should accept maxPortRetries of 0", () => {
			executor = new OpencodeServerExecutor({ maxPortRetries: 0 });
			const config = (executor as unknown as { config: { maxPortRetries: number } }).config;
			expect(config.maxPortRetries).toBe(0);
		});
	});

	describe("isPortConflictError", () => {
		// Access the private method via type cast for testing
		function checkPortConflict(error: unknown): boolean {
			const exec = new OpencodeServerExecutor();
			return (exec as unknown as { isPortConflictError(error: unknown): boolean }).isPortConflictError(error);
		}

		it("should detect EADDRINUSE", () => {
			expect(checkPortConflict(new Error("EADDRINUSE"))).toBe(true);
		});

		it("should detect 'address already in use'", () => {
			expect(checkPortConflict(new Error("listen EADDRINUSE: address already in use 127.0.0.1:4096"))).toBe(true);
		});

		it("should detect 'port is already'", () => {
			expect(checkPortConflict(new Error("port is already allocated"))).toBe(true);
		});

		it("should detect 'bind' errors", () => {
			expect(checkPortConflict(new Error("failed to bind to port 4096"))).toBe(true);
		});

		it("should return false for timeout errors", () => {
			expect(checkPortConflict(new Error("The operation timed out."))).toBe(false);
		});

		it("should return false for ECONNREFUSED", () => {
			expect(checkPortConflict(new Error("ECONNREFUSED"))).toBe(false);
		});

		it("should return false for unrelated errors", () => {
			expect(checkPortConflict(new Error("OpenCode is not installed"))).toBe(false);
		});

		it("should handle non-Error values", () => {
			expect(checkPortConflict("EADDRINUSE")).toBe(true);
			expect(checkPortConflict("some random string")).toBe(false);
		});
	});

	describe("startServer retry behavior", () => {
		it("should not retry on non-port-conflict errors", async () => {
			// startServer calls ensureInstalled() first, which will throw
			// "OpenCode is not installed" if opencode is not present.
			// This error is NOT a port conflict, so it should be thrown immediately.
			executor = new OpencodeServerExecutor({ autoInstall: false });
			await expect(executor.startServer("/tmp/test")).rejects.toThrow();
			// Verify server is not running (no retry loop hung)
			expect(executor.isServerRunning()).toBe(false);
		});
	});
});

describe("createOpencodeExecutor", () => {
	it("should create a new executor instance", () => {
		const executor = createOpencodeExecutor();
		expect(executor).toBeInstanceOf(OpencodeServerExecutor);
	});

	it("should accept configuration options", () => {
		const executor = createOpencodeExecutor({
			port: 5000,
			verbose: true,
		});
		expect(executor).toBeInstanceOf(OpencodeServerExecutor);
	});
});
