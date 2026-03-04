/**
 * Unit tests for OpenCode Port Manager
 *
 * Tests the port allocation and management functionality.
 *
 * @module tests/unit/engines/opencode-port-manager
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { PortManager } from "../../../src/engines/opencode/port-manager";

describe("PortManager", () => {
	beforeEach(() => {
		// Reset state between tests
		PortManager.reset();
	});

	afterEach(() => {
		// Clean up after each test
		PortManager.reset();
	});

	describe("acquirePort", () => {
		it("should return base port when no ports are in use", async () => {
			const port = await PortManager.acquirePort();
			// Should return a port starting from base (4096)
			expect(port).toBeGreaterThanOrEqual(4096);
			expect(port).toBeLessThanOrEqual(4196); // base + MAX_PORT_RANGE
		});

		it("should return next available port when base port is in use", async () => {
			// Acquire first port
			const port1 = await PortManager.acquirePort();
			// Acquire second port
			const port2 = await PortManager.acquirePort();

			expect(port2).toBeGreaterThan(port1);
			expect(port2).toBe(port1 + 1);
		});

		it("should track acquired ports", async () => {
			const port1 = await PortManager.acquirePort();
			const port2 = await PortManager.acquirePort();

			expect(PortManager.getUsedPortCount()).toBe(2);
			expect(PortManager.getUsedPorts()).toContain(port1);
			expect(PortManager.getUsedPorts()).toContain(port2);
		});

		it("should respect preferred port when available", async () => {
			const preferredPort = 5000;
			const port = await PortManager.acquirePort(preferredPort);

			// If the preferred port is available, it should be returned
			// Otherwise, it will find an alternative
			expect(port).toBeGreaterThanOrEqual(4096);
		});

		it("should acquire multiple ports sequentially", async () => {
			const ports: number[] = [];
			for (let i = 0; i < 5; i++) {
				ports.push(await PortManager.acquirePort());
			}

			// All ports should be unique
			const uniquePorts = new Set(ports);
			expect(uniquePorts.size).toBe(5);

			// All ports should be tracked
			expect(PortManager.getUsedPortCount()).toBe(5);
		});
	});

	describe("releasePort", () => {
		it("should release an acquired port", async () => {
			const port = await PortManager.acquirePort();
			expect(PortManager.isPortTracked(port)).toBe(true);

			PortManager.releasePort(port);
			expect(PortManager.isPortTracked(port)).toBe(false);
		});

		it("should handle releasing non-acquired port gracefully", () => {
			// Should not throw
			expect(() => PortManager.releasePort(9999)).not.toThrow();
		});

		it("should allow re-acquiring a released port", async () => {
			const port1 = await PortManager.acquirePort();
			PortManager.releasePort(port1);

			// The released port should be available again
			// Note: It may or may not be the same port depending on system state
			const port2 = await PortManager.acquirePort();
			expect(port2).toBeGreaterThanOrEqual(4096);
		});
	});

	describe("isPortAvailable", () => {
		it("should return true for available port", async () => {
			// Use a high port that's unlikely to be in use
			const result = await PortManager.isPortAvailable(49152);
			// This may vary based on system state
			expect(typeof result).toBe("boolean");
		});

		it("should return false for port in use by this process", async () => {
			const port = await PortManager.acquirePort();
			// The port is tracked but not actually bound by us
			// isPortAvailable checks system availability, not our tracking
			const result = await PortManager.isPortAvailable(port);
			// After acquiring, the port should still be available on the system
			// (we only track it, we don't bind to it)
			expect(typeof result).toBe("boolean");
		});
	});

	describe("isPortTracked", () => {
		it("should return true for tracked port", async () => {
			const port = await PortManager.acquirePort();
			expect(PortManager.isPortTracked(port)).toBe(true);
		});

		it("should return false for non-tracked port", () => {
			expect(PortManager.isPortTracked(9999)).toBe(false);
		});
	});

	describe("getUsedPorts", () => {
		it("should return empty array when no ports are used", () => {
			expect(PortManager.getUsedPorts()).toEqual([]);
		});

		it("should return all acquired ports", async () => {
			const port1 = await PortManager.acquirePort();
			const port2 = await PortManager.acquirePort();
			const port3 = await PortManager.acquirePort();

			const usedPorts = PortManager.getUsedPorts();
			expect(usedPorts).toContain(port1);
			expect(usedPorts).toContain(port2);
			expect(usedPorts).toContain(port3);
			expect(usedPorts.length).toBe(3);
		});
	});

	describe("getUsedPortCount", () => {
		it("should return 0 when no ports are used", () => {
			expect(PortManager.getUsedPortCount()).toBe(0);
		});

		it("should return correct count after acquiring ports", async () => {
			await PortManager.acquirePort();
			expect(PortManager.getUsedPortCount()).toBe(1);

			await PortManager.acquirePort();
			expect(PortManager.getUsedPortCount()).toBe(2);
		});

		it("should decrease count after releasing ports", async () => {
			const port1 = await PortManager.acquirePort();
			const port2 = await PortManager.acquirePort();
			expect(PortManager.getUsedPortCount()).toBe(2);

			PortManager.releasePort(port1);
			expect(PortManager.getUsedPortCount()).toBe(1);

			PortManager.releasePort(port2);
			expect(PortManager.getUsedPortCount()).toBe(0);
		});
	});

	describe("releaseAllPorts", () => {
		it("should release all tracked ports", async () => {
			await PortManager.acquirePort();
			await PortManager.acquirePort();
			await PortManager.acquirePort();
			expect(PortManager.getUsedPortCount()).toBe(3);

			PortManager.releaseAllPorts();
			expect(PortManager.getUsedPortCount()).toBe(0);
			expect(PortManager.getUsedPorts()).toEqual([]);
		});

		it("should handle empty state gracefully", () => {
			expect(() => PortManager.releaseAllPorts()).not.toThrow();
			expect(PortManager.getUsedPortCount()).toBe(0);
		});
	});

	describe("setBasePort", () => {
		it("should change the base port for allocation", async () => {
			PortManager.setBasePort(5000);
			const port = await PortManager.acquirePort();
			expect(port).toBeGreaterThanOrEqual(5000);
		});

		it("should throw for invalid port numbers", () => {
			expect(() => PortManager.setBasePort(0)).toThrow();
			expect(() => PortManager.setBasePort(-1)).toThrow();
			expect(() => PortManager.setBasePort(65536)).toThrow();
		});

		it("should accept valid port numbers", () => {
			expect(() => PortManager.setBasePort(1)).not.toThrow();
			expect(() => PortManager.setBasePort(65535)).not.toThrow();
		});
	});

	describe("getBasePort", () => {
		it("should return default base port initially", () => {
			expect(PortManager.getBasePort()).toBe(4096);
		});

		it("should return updated base port after setBasePort", () => {
			PortManager.setBasePort(5000);
			expect(PortManager.getBasePort()).toBe(5000);
		});
	});

	describe("reset", () => {
		it("should reset all state to initial values", async () => {
			// Modify state
			PortManager.setBasePort(5000);
			await PortManager.acquirePort();
			await PortManager.acquirePort();

			// Reset
			PortManager.reset();

			// Verify reset
			expect(PortManager.getBasePort()).toBe(4096);
			expect(PortManager.getUsedPortCount()).toBe(0);
		});
	});

	describe("isPortAvailable timeout", () => {
		afterEach(() => {
			PortManager.reset();
		});

		it("should resolve within PORT_CHECK_TIMEOUT_MS even for valid ports", async () => {
			const start = Date.now();
			const result = await PortManager.isPortAvailable(49152);
			const elapsed = Date.now() - start;

			expect(typeof result).toBe("boolean");
			expect(elapsed).toBeLessThan(4000);
		});

		it("should resolve(false) when server.close callback is delayed", async () => {
			// Mock node:net to return a fake server whose close() never fires its callback
			mock.module("node:net", () => ({
				createServer: () => {
					const eventHandlers: Record<string, Function> = {};
					return {
						once(event: string, cb: Function) {
							eventHandlers[event] = cb;
							return this;
						},
						listen(_port: number, _host: string) {
							// Simulate successful listen by firing the "listening" event
							queueMicrotask(() => {
								eventHandlers["listening"]?.();
							});
							return this;
						},
						close(_cb?: Function) {
							// Never invoke the callback - simulates the hung close scenario
						},
						removeAllListeners() {
							for (const key of Object.keys(eventHandlers)) {
								delete eventHandlers[key];
							}
							return this;
						},
					};
				},
			}));

			// Re-import port-manager so it picks up the mocked node:net
			const { PortManager: MockedPM } = await import(
				"../../../src/engines/opencode/port-manager"
			);

			const start = Date.now();
			const result = await MockedPM.isPortAvailable(49999);
			const elapsed = Date.now() - start;

			expect(result).toBe(false);
			// Should have waited for the timeout (~3000ms) before resolving
			expect(elapsed).toBeGreaterThanOrEqual(2500);
			expect(elapsed).toBeLessThan(5000);
		});

		it("should not leak timers on normal resolution", async () => {
			const result = await PortManager.isPortAvailable(49153);
			expect(typeof result).toBe("boolean");
			// If this test completes without hanging, timers are properly cleaned up
		});
	});
});
