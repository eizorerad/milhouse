/**
 * Unit tests for retry.ts
 *
 * Tests the retry behavior including:
 * - retryOnAnyFailure flag behavior
 * - maxRetries semantics (0→1 attempt, 1→2 attempts, etc.)
 * - Attempt X/Y logging format
 *
 * @module tests/unit/execution/retry.test.ts
 */

import { describe, expect, it, mock, spyOn, beforeEach, afterEach } from "bun:test";
import {
	executeWithRetry,
	isErrorRetryable,
	isRetryableError,
	calculateRetryDelay,
} from "../../../src/execution/runtime/retry.ts";
import type { MilhouseRetryConfig } from "../../../src/execution/runtime/types.ts";
import { DEFAULT_RETRY_CONFIG } from "../../../src/execution/runtime/types.ts";
import * as logger from "../../../src/ui/logger.ts";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a test retry config with minimal delays for fast tests
 */
function createTestConfig(overrides: Partial<MilhouseRetryConfig> = {}): MilhouseRetryConfig {
	return {
		...DEFAULT_RETRY_CONFIG,
		baseDelayMs: 1, // Minimal delay for fast tests
		maxDelayMs: 10,
		jitterFactor: 0, // No jitter for deterministic tests
		...overrides,
	};
}

/**
 * Create a function that fails N times then succeeds
 */
function createFailingFn<T>(
	failCount: number,
	successValue: T,
	errorMessage = "Test error",
): { fn: () => Promise<T>; attempts: number[] } {
	const state = { callCount: 0, attempts: [] as number[] };

	const fn = async () => {
		state.callCount++;
		state.attempts.push(state.callCount);
		if (state.callCount <= failCount) {
			throw new Error(errorMessage);
		}
		return successValue;
	};

	return { fn, get attempts() { return state.attempts; } };
}

/**
 * Create a function that always fails
 */
function createAlwaysFailingFn(
	errorMessage = "Test error",
): { fn: () => Promise<never>; attempts: number[] } {
	const state = { attempts: [] as number[] };

	const fn = async (): Promise<never> => {
		state.attempts.push(state.attempts.length + 1);
		throw new Error(errorMessage);
	};

	return { fn, get attempts() { return state.attempts; } };
}

// ============================================================================
// Tests
// ============================================================================

describe("executeWithRetry", () => {
	let logInfoSpy: ReturnType<typeof spyOn>;
	let logWarnSpy: ReturnType<typeof spyOn>;
	let logDebugSpy: ReturnType<typeof spyOn>;
	let loggedMessages: string[];

	beforeEach(() => {
		loggedMessages = [];
		logInfoSpy = spyOn(logger, "logInfo").mockImplementation((...args: unknown[]) => {
			loggedMessages.push(String(args[0]));
		});
		logWarnSpy = spyOn(logger, "logWarn").mockImplementation((...args: unknown[]) => {
			loggedMessages.push(String(args[0]));
		});
		logDebugSpy = spyOn(logger, "logDebug").mockImplementation((...args: unknown[]) => {
			loggedMessages.push(String(args[0]));
		});
	});

	afterEach(() => {
		logInfoSpy.mockRestore();
		logWarnSpy.mockRestore();
		logDebugSpy.mockRestore();
	});

	describe("retryOnAnyFailure behavior", () => {
		it("retryOnAnyFailure=true - task with non-retryable error is retried at least 2 times", async () => {
			// Non-retryable error (syntax error - doesn't match any retryable pattern)
			const nonRetryableError = "SyntaxError: Unexpected token";
			const { fn, attempts } = createAlwaysFailingFn(nonRetryableError);

			const config = createTestConfig({
				maxRetries: 2, // Should result in 3 total attempts
				retryOnAnyFailure: true,
			});

			const result = await executeWithRetry(fn, config);

			expect(result.success).toBe(false);
			expect(attempts.length).toBeGreaterThanOrEqual(2);
			expect(attempts.length).toBe(3); // 1 initial + 2 retries = 3 total
		});

		it("retryOnAnyFailure=false - task with non-retryable error is NOT retried (only 1 attempt)", async () => {
			// Non-retryable error (syntax error - doesn't match any retryable pattern)
			const nonRetryableError = "SyntaxError: Unexpected token";
			const { fn, attempts } = createAlwaysFailingFn(nonRetryableError);

			const config = createTestConfig({
				maxRetries: 2, // Would allow 3 total attempts if retryable
				retryOnAnyFailure: false, // Strict mode - only retry retryable errors
			});

			const result = await executeWithRetry(fn, config);

			expect(result.success).toBe(false);
			expect(attempts.length).toBe(1); // Only 1 attempt - no retries for non-retryable errors
		});

		it("retryOnAnyFailure=true logs 'Retrying: --retry-on-any-failure enabled' for non-retryable errors", async () => {
			const nonRetryableError = "SyntaxError: Unexpected token";
			const { fn } = createAlwaysFailingFn(nonRetryableError);

			const config = createTestConfig({
				maxRetries: 1,
				retryOnAnyFailure: true,
			});

			await executeWithRetry(fn, config);

			const retryReasonLog = loggedMessages.find((msg) =>
				msg.includes("Retrying: --retry-on-any-failure enabled")
			);
			expect(retryReasonLog).toBeDefined();
		});

		it("retryOnAnyFailure=false logs 'Not retrying: error is not retryable' for non-retryable errors", async () => {
			const nonRetryableError = "SyntaxError: Unexpected token";
			const { fn } = createAlwaysFailingFn(nonRetryableError);

			const config = createTestConfig({
				maxRetries: 2,
				retryOnAnyFailure: false,
			});

			await executeWithRetry(fn, config);

			const notRetryingLog = loggedMessages.find((msg) =>
				msg.includes("Not retrying: error is not retryable")
			);
			expect(notRetryingLog).toBeDefined();
		});

		it("retryOnAnyFailure=false still retries retryable errors", async () => {
			// Retryable error (rate limit)
			const retryableError = "Rate limit exceeded";
			const { fn, attempts } = createAlwaysFailingFn(retryableError);

			const config = createTestConfig({
				maxRetries: 2,
				retryOnAnyFailure: false, // Strict mode
			});

			const result = await executeWithRetry(fn, config);

			expect(result.success).toBe(false);
			expect(attempts.length).toBe(3); // 1 initial + 2 retries = 3 total
		});
	});

	describe("maxRetries semantics", () => {
		it("maxRetries=0 results in exactly 1 attempt", async () => {
			const { fn, attempts } = createAlwaysFailingFn("Rate limit exceeded");

			const config = createTestConfig({
				maxRetries: 0, // No retries - only initial attempt
				retryOnAnyFailure: true,
			});

			const result = await executeWithRetry(fn, config);

			expect(result.success).toBe(false);
			expect(attempts.length).toBe(1); // Only 1 attempt
		});

		it("maxRetries=1 results in exactly 2 attempts (for retryable errors)", async () => {
			const { fn, attempts } = createAlwaysFailingFn("Rate limit exceeded");

			const config = createTestConfig({
				maxRetries: 1, // 1 retry = 2 total attempts
				retryOnAnyFailure: true,
			});

			const result = await executeWithRetry(fn, config);

			expect(result.success).toBe(false);
			expect(attempts.length).toBe(2); // 1 initial + 1 retry = 2 total
		});

		it("maxRetries=2 results in exactly 3 attempts (for retryable errors)", async () => {
			const { fn, attempts } = createAlwaysFailingFn("Rate limit exceeded");

			const config = createTestConfig({
				maxRetries: 2, // 2 retries = 3 total attempts
				retryOnAnyFailure: true,
			});

			const result = await executeWithRetry(fn, config);

			expect(result.success).toBe(false);
			expect(attempts.length).toBe(3); // 1 initial + 2 retries = 3 total
		});

		it("maxRetries=3 results in exactly 4 attempts (default config)", async () => {
			const { fn, attempts } = createAlwaysFailingFn("Rate limit exceeded");

			const config = createTestConfig({
				maxRetries: 3, // 3 retries = 4 total attempts
				retryOnAnyFailure: true,
			});

			const result = await executeWithRetry(fn, config);

			expect(result.success).toBe(false);
			expect(attempts.length).toBe(4); // 1 initial + 3 retries = 4 total
		});

		it("succeeds on second attempt when maxRetries=1", async () => {
			const { fn, attempts } = createFailingFn(1, "success", "Rate limit exceeded");

			const config = createTestConfig({
				maxRetries: 1,
				retryOnAnyFailure: true,
			});

			const result = await executeWithRetry(fn, config);

			expect(result.success).toBe(true);
			expect(result.value).toBe("success");
			expect(attempts.length).toBe(2); // Failed once, succeeded on retry
		});

		it("succeeds on third attempt when maxRetries=2", async () => {
			const { fn, attempts } = createFailingFn(2, "success", "Rate limit exceeded");

			const config = createTestConfig({
				maxRetries: 2,
				retryOnAnyFailure: true,
			});

			const result = await executeWithRetry(fn, config);

			expect(result.success).toBe(true);
			expect(result.value).toBe("success");
			expect(attempts.length).toBe(3); // Failed twice, succeeded on second retry
		});
	});

	describe("Attempt X/Y logging format", () => {
		it("logs 'Attempt 1/1' when maxRetries=0", async () => {
			const { fn } = createAlwaysFailingFn("Test error");

			const config = createTestConfig({
				maxRetries: 0,
				retryOnAnyFailure: true,
			});

			await executeWithRetry(fn, config);

			const attemptLog = loggedMessages.find((msg) => msg.includes("Attempt 1/1"));
			expect(attemptLog).toBeDefined();
		});

		it("logs 'Attempt 1/2' and 'Attempt 2/2' when maxRetries=1", async () => {
			const { fn } = createAlwaysFailingFn("Rate limit exceeded");

			const config = createTestConfig({
				maxRetries: 1,
				retryOnAnyFailure: true,
			});

			await executeWithRetry(fn, config);

			const attempt1Log = loggedMessages.find((msg) => msg.includes("Attempt 1/2"));
			const attempt2Log = loggedMessages.find((msg) => msg.includes("Attempt 2/2"));

			expect(attempt1Log).toBeDefined();
			expect(attempt2Log).toBeDefined();
		});

		it("logs 'Attempt 1/3', 'Attempt 2/3', 'Attempt 3/3' when maxRetries=2", async () => {
			const { fn } = createAlwaysFailingFn("Rate limit exceeded");

			const config = createTestConfig({
				maxRetries: 2,
				retryOnAnyFailure: true,
			});

			await executeWithRetry(fn, config);

			const attempt1Log = loggedMessages.find((msg) => msg.includes("Attempt 1/3"));
			const attempt2Log = loggedMessages.find((msg) => msg.includes("Attempt 2/3"));
			const attempt3Log = loggedMessages.find((msg) => msg.includes("Attempt 3/3"));

			expect(attempt1Log).toBeDefined();
			expect(attempt2Log).toBeDefined();
			expect(attempt3Log).toBeDefined();
		});

		it("logs correct attempt format for successful early exit", async () => {
			const { fn } = createFailingFn(1, "success", "Rate limit exceeded");

			const config = createTestConfig({
				maxRetries: 3, // Would allow 4 attempts
				retryOnAnyFailure: true,
			});

			await executeWithRetry(fn, config);

			// Should log Attempt 1/4 and Attempt 2/4 (success on 2nd attempt)
			const attempt1Log = loggedMessages.find((msg) => msg.includes("Attempt 1/4"));
			const attempt2Log = loggedMessages.find((msg) => msg.includes("Attempt 2/4"));
			const attempt3Log = loggedMessages.find((msg) => msg.includes("Attempt 3/4"));

			expect(attempt1Log).toBeDefined();
			expect(attempt2Log).toBeDefined();
			expect(attempt3Log).toBeUndefined(); // Should not reach attempt 3
		});
	});

	describe("success scenarios", () => {
		it("returns success on first attempt without retries", async () => {
			const fn = async () => "immediate success";

			const config = createTestConfig({
				maxRetries: 3,
			});

			const result = await executeWithRetry(fn, config);

			expect(result.success).toBe(true);
			expect(result.value).toBe("immediate success");
			expect(result.attempts.length).toBe(0); // No failed attempts recorded
		});

		it("records attempt history for failed attempts", async () => {
			const { fn } = createFailingFn(2, "success", "Rate limit exceeded");

			const config = createTestConfig({
				maxRetries: 3,
				retryOnAnyFailure: true,
			});

			const result = await executeWithRetry(fn, config);

			expect(result.success).toBe(true);
			expect(result.attempts.length).toBe(2); // 2 failed attempts recorded
			expect(result.attempts[0].attempt).toBe(1);
			expect(result.attempts[1].attempt).toBe(2);
		});
	});

	describe("abort signal handling", () => {
		it("stops retrying when abort signal is triggered", async () => {
			const controller = new AbortController();
			const { fn, attempts } = createAlwaysFailingFn("Rate limit exceeded");

			const config = createTestConfig({
				maxRetries: 5,
				retryOnAnyFailure: true,
			});

			// Abort after first attempt
			setTimeout(() => controller.abort(), 5);

			const result = await executeWithRetry(fn, config, {
				environment: {
					workDir: process.cwd(),
					engine: "claude",
					runId: "test-run",
					dryRun: false,
					verbose: false,
				},
				emitEvent: () => {},
				startedAt: new Date(),
				abortSignal: controller.signal,
			});

			expect(result.success).toBe(false);
			// Should have stopped early due to abort
			expect(attempts.length).toBeLessThan(6);
		});
	});
});

describe("isErrorRetryable", () => {
	const config = DEFAULT_RETRY_CONFIG;

	it("returns true for rate limit errors", () => {
		expect(isErrorRetryable("Rate limit exceeded", config)).toBe(true);
		expect(isErrorRetryable("Too many requests", config)).toBe(true);
		expect(isErrorRetryable("Error 429: Rate limited", config)).toBe(true);
	});

	it("returns true for timeout errors", () => {
		expect(isErrorRetryable("Request timeout", config)).toBe(true);
		expect(isErrorRetryable("ETIMEDOUT", config)).toBe(true);
	});

	it("returns true for network errors", () => {
		expect(isErrorRetryable("Network error", config)).toBe(true);
		expect(isErrorRetryable("Connection refused", config)).toBe(true);
		expect(isErrorRetryable("ECONNRESET", config)).toBe(true);
		expect(isErrorRetryable("ENOTFOUND", config)).toBe(true);
	});

	it("returns true for service unavailable errors", () => {
		expect(isErrorRetryable("Service unavailable", config)).toBe(true);
		expect(isErrorRetryable("Error 503", config)).toBe(true);
		expect(isErrorRetryable("Server overloaded", config)).toBe(true);
	});

	it("returns false for non-retryable patterns", () => {
		expect(isErrorRetryable("Invalid API key", config)).toBe(false);
		expect(isErrorRetryable("Authentication failed", config)).toBe(false);
		expect(isErrorRetryable("Unauthorized", config)).toBe(false);
		expect(isErrorRetryable("Error 401", config)).toBe(false);
		expect(isErrorRetryable("Forbidden", config)).toBe(false);
		expect(isErrorRetryable("Error 403", config)).toBe(false);
	});

	it("returns false for generic errors", () => {
		expect(isErrorRetryable("SyntaxError: Unexpected token", config)).toBe(false);
		expect(isErrorRetryable("TypeError: undefined is not a function", config)).toBe(false);
		expect(isErrorRetryable("Some random error", config)).toBe(false);
	});
});

describe("isRetryableError (simplified)", () => {
	it("returns true for rate limit errors", () => {
		expect(isRetryableError("Rate limit exceeded")).toBe(true);
		expect(isRetryableError("Too many requests")).toBe(true);
		expect(isRetryableError("Error 429")).toBe(true);
	});

	it("returns true for timeout/network errors", () => {
		expect(isRetryableError("Request timeout")).toBe(true);
		expect(isRetryableError("Network error")).toBe(true);
		expect(isRetryableError("Connection refused")).toBe(true);
	});

	it("returns false for generic errors", () => {
		expect(isRetryableError("SyntaxError")).toBe(false);
		expect(isRetryableError("Invalid input")).toBe(false);
	});
});

describe("calculateRetryDelay", () => {
	it("calculates exponential backoff correctly", () => {
		const config = createTestConfig({
			baseDelayMs: 1000,
			maxDelayMs: 30000,
			exponentialBackoff: true,
			jitterFactor: 0,
		});

		expect(calculateRetryDelay(1, config)).toBe(1000); // 1000 * 2^0 = 1000
		expect(calculateRetryDelay(2, config)).toBe(2000); // 1000 * 2^1 = 2000
		expect(calculateRetryDelay(3, config)).toBe(4000); // 1000 * 2^2 = 4000
		expect(calculateRetryDelay(4, config)).toBe(8000); // 1000 * 2^3 = 8000
	});

	it("calculates linear delay correctly", () => {
		const config = createTestConfig({
			baseDelayMs: 1000,
			maxDelayMs: 30000,
			exponentialBackoff: false,
			jitterFactor: 0,
		});

		expect(calculateRetryDelay(1, config)).toBe(1000); // 1000 * 1 = 1000
		expect(calculateRetryDelay(2, config)).toBe(2000); // 1000 * 2 = 2000
		expect(calculateRetryDelay(3, config)).toBe(3000); // 1000 * 3 = 3000
	});

	it("respects maxDelayMs cap", () => {
		const config = createTestConfig({
			baseDelayMs: 1000,
			maxDelayMs: 5000,
			exponentialBackoff: true,
			jitterFactor: 0,
		});

		expect(calculateRetryDelay(5, config)).toBe(5000); // Would be 16000, capped to 5000
		expect(calculateRetryDelay(10, config)).toBe(5000); // Would be huge, capped to 5000
	});
});
