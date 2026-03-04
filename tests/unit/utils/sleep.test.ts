/**
 * Unit tests for portable sleepSync utility
 */

import { describe, expect, it } from "bun:test";
import { sleepSync } from "../../../src/utils/sleep";

describe("sleepSync", () => {
	it("should block for approximately the specified duration", () => {
		const start = performance.now();
		sleepSync(50);
		const elapsed = performance.now() - start;
		// Allow some tolerance — should be at least 40ms and no more than 200ms
		expect(elapsed).toBeGreaterThanOrEqual(40);
		expect(elapsed).toBeLessThan(200);
	});

	it("should return immediately for 0ms", () => {
		const start = performance.now();
		sleepSync(0);
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(50);
	});
});
