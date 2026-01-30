/**
 * Port Manager for OpenCode Server
 *
 * Manages port allocation for OpenCode server instances to avoid conflicts
 * when running multiple milhouse instances concurrently.
 *
 * @see https://opencode.ai/docs/server
 */

import { createServer, type Server } from "node:net";
import { logger } from "../../observability/logger";

/**
 * Default base port for OpenCode servers.
 * OpenCode's default port is 4096.
 */
const DEFAULT_BASE_PORT = 4096;

/**
 * Maximum port number to try before giving up.
 */
const MAX_PORT = 65535;

/**
 * Port range to scan before giving up.
 */
const MAX_PORT_RANGE = 100;

/**
 * Port Manager for OpenCode server instances.
 *
 * Handles port allocation and release to prevent conflicts between
 * concurrent milhouse executions. Uses a static set to track ports
 * used by the current process, and checks actual port availability
 * using TCP connection attempts.
 *
 * @example
 * ```typescript
 * // Acquire a port for a new server
 * const port = await PortManager.acquirePort();
 * console.log(`Starting server on port ${port}`);
 *
 * // When done, release the port
 * PortManager.releasePort(port);
 * ```
 */
export class PortManager {
	/**
	 * Set of ports currently in use by this process.
	 * This prevents the same port from being assigned to multiple servers
	 * within the same milhouse instance.
	 */
	private static usedPorts = new Set<number>();

	/**
	 * Base port to start scanning from.
	 */
	private static basePort = DEFAULT_BASE_PORT;

	/**
	 * Set the base port for port allocation.
	 *
	 * @param port - The base port to use
	 */
	static setBasePort(port: number): void {
		if (port < 1 || port > MAX_PORT) {
			throw new Error(`Invalid base port: ${port}. Must be between 1 and ${MAX_PORT}`);
		}
		PortManager.basePort = port;
	}

	/**
	 * Get the current base port.
	 *
	 * @returns The current base port
	 */
	static getBasePort(): number {
		return PortManager.basePort;
	}

	/**
	 * Acquire an available port for a new OpenCode server.
	 *
	 * Starts from the base port (4096) and increments until finding
	 * an available port that is:
	 * 1. Not already tracked as used by this process
	 * 2. Not bound by any other process on the system
	 *
	 * @param preferredPort - Optional preferred port to try first
	 * @returns An available port number
	 * @throws Error if no available port is found within the range
	 *
	 * @example
	 * ```typescript
	 * // Get any available port
	 * const port = await PortManager.acquirePort();
	 *
	 * // Try a specific port first
	 * const port = await PortManager.acquirePort(4100);
	 * ```
	 */
	static async acquirePort(preferredPort?: number): Promise<number> {
		// If a preferred port is specified, try it first
		if (preferredPort !== undefined) {
			if (await PortManager.tryAcquirePort(preferredPort)) {
				return preferredPort;
			}
			logger.debug(`Preferred port ${preferredPort} is not available, scanning for alternatives`);
		}

		// Scan for an available port starting from base port
		const startPort = PortManager.basePort;
		const endPort = Math.min(startPort + MAX_PORT_RANGE, MAX_PORT);

		for (let port = startPort; port <= endPort; port++) {
			if (await PortManager.tryAcquirePort(port)) {
				return port;
			}
		}

		throw new Error(
			`No available port found in range ${startPort}-${endPort}. ` +
				`All ports are either in use by this process or bound by other processes.`,
		);
	}

	/**
	 * Try to acquire a specific port.
	 *
	 * @param port - The port to try to acquire
	 * @returns true if the port was acquired, false otherwise
	 */
	private static async tryAcquirePort(port: number): Promise<boolean> {
		// Check if already tracked as used by this process
		if (PortManager.usedPorts.has(port)) {
			return false;
		}

		// Check if the port is actually available on the system
		const isAvailable = await PortManager.isPortAvailable(port);
		if (!isAvailable) {
			return false;
		}

		// Mark the port as used
		PortManager.usedPorts.add(port);
		logger.debug(`Acquired port ${port} for OpenCode server`);
		return true;
	}

	/**
	 * Release a port back to the pool.
	 *
	 * Should be called when an OpenCode server is stopped to allow
	 * the port to be reused by other servers.
	 *
	 * @param port - The port to release
	 *
	 * @example
	 * ```typescript
	 * // After stopping the server
	 * PortManager.releasePort(4096);
	 * ```
	 */
	static releasePort(port: number): void {
		if (PortManager.usedPorts.has(port)) {
			PortManager.usedPorts.delete(port);
			logger.debug(`Released port ${port}`);
		}
	}

	/**
	 * Check if a port is available for use.
	 *
	 * Tests port availability by attempting to create a TCP server
	 * on the port. If the server can be created, the port is available.
	 *
	 * @param port - The port to check
	 * @returns true if the port is available, false otherwise
	 *
	 * @example
	 * ```typescript
	 * if (await PortManager.isPortAvailable(4096)) {
	 *   console.log('Port 4096 is available');
	 * }
	 * ```
	 */
	static async isPortAvailable(port: number): Promise<boolean> {
		return new Promise((resolve) => {
			const server: Server = createServer();

			server.once("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "EADDRINUSE" || err.code === "EACCES") {
					resolve(false);
				} else {
					// Other errors might indicate the port is available but something else is wrong
					logger.debug(`Port ${port} check error: ${err.message}`);
					resolve(false);
				}
			});

			server.once("listening", () => {
				// Port is available, close the server
				server.close(() => {
					resolve(true);
				});
			});

			// Try to listen on the port
			server.listen(port, "127.0.0.1");
		});
	}

	/**
	 * Get all ports currently tracked as used by this process.
	 *
	 * @returns Array of port numbers currently in use
	 */
	static getUsedPorts(): number[] {
		return Array.from(PortManager.usedPorts);
	}

	/**
	 * Get the number of ports currently in use.
	 *
	 * @returns Count of ports in use
	 */
	static getUsedPortCount(): number {
		return PortManager.usedPorts.size;
	}

	/**
	 * Check if a specific port is tracked as used by this process.
	 *
	 * Note: This only checks the internal tracking, not actual system availability.
	 * Use `isPortAvailable()` to check actual system availability.
	 *
	 * @param port - The port to check
	 * @returns true if the port is tracked as used
	 */
	static isPortTracked(port: number): boolean {
		return PortManager.usedPorts.has(port);
	}

	/**
	 * Release all tracked ports.
	 *
	 * Useful for cleanup during shutdown or testing.
	 */
	static releaseAllPorts(): void {
		const count = PortManager.usedPorts.size;
		PortManager.usedPorts.clear();
		if (count > 0) {
			logger.debug(`Released all ${count} tracked ports`);
		}
	}

	/**
	 * Reset the port manager to its initial state.
	 *
	 * Releases all ports and resets the base port to default.
	 * Primarily useful for testing.
	 */
	static reset(): void {
		PortManager.releaseAllPorts();
		PortManager.basePort = DEFAULT_BASE_PORT;
	}
}
