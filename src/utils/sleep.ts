/**
 * Portable synchronous sleep that works in both Node.js and Bun runtimes.
 *
 * Uses Atomics.wait on a SharedArrayBuffer — standard ES2017, supported
 * in Node.js 8.10+ and all Bun versions.
 */
export function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
