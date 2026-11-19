import { afterEach, describe, expect, it } from "bun:test";
import { run } from "../src/proc.ts";
import { cleanupTempDirs, tempDir } from "./helpers.ts";

afterEach(cleanupTempDirs);

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function goneWithin(pid: number, ms: number): Promise<boolean> {
	for (let waited = 0; waited < ms; waited += 25) {
		if (!alive(pid)) return true;
		await Bun.sleep(25);
	}
	return !alive(pid);
}

describe("run", () => {
	it("captures output and the exit code", async () => {
		const out = await run("echo hi; echo oops >&2; exit 3", [], { cwd: tempDir(), shell: true });
		expect(out).toMatchObject({
			code: 3,
			stdout: "hi\n",
			stderr: "oops\n",
			timedOut: false,
			truncated: false,
		});
	});

	it("returns when the command has exited, even if a background child keeps its pipes open", async () => {
		const started = Date.now();
		const out = await run("sleep 30 & echo $!", [], {
			cwd: tempDir(),
			shell: true,
			timeoutMs: 20_000,
		});
		const straggler = Number(out.stdout.trim());
		try {
			expect(out.code).toBe(0);
			expect(out.timedOut).toBe(false);
			expect(Date.now() - started).toBeLessThan(5_000);
			expect(alive(straggler)).toBe(true); // a command's own background work is left alone
		} finally {
			process.kill(straggler, "SIGKILL");
		}
	});

	it("does not call a command that already finished a timeout while its pipes drain", async () => {
		const out = await run("sleep 30 & echo $!", [], {
			cwd: tempDir(),
			shell: true,
			timeoutMs: 400,
		});
		try {
			expect(out.code).toBe(0);
			expect(out.timedOut).toBe(false);
		} finally {
			process.kill(Number(out.stdout.trim()), "SIGKILL");
		}
	});

	it("can stop what an agent left running after it finished", async () => {
		const out = await run("sleep 30 & echo $!", [], { cwd: tempDir(), shell: true, reap: true });
		const straggler = Number(out.stdout.trim());
		expect(await goneWithin(straggler, 2_000)).toBe(true);
	});

	it("keeps only the end of an output that never stops", async () => {
		const out = await run("i=0; while [ $i -lt 4000 ]; do echo line-$i; i=$((i+1)); done", [], {
			cwd: tempDir(),
			shell: true,
			maxOutput: 4_000,
		});
		expect(out.code).toBe(0);
		expect(out.truncated).toBe(true);
		expect(out.stdout.length).toBeLessThanOrEqual(4_000);
		expect(out.stdout.trimEnd().endsWith("line-3999")).toBe(true);
		expect(out.stdout.startsWith("line-0\n")).toBe(false);
	});

	it("kills the whole process tree on a timeout", async () => {
		const out = await run("sleep 30 & echo $!; sleep 30", [], {
			cwd: tempDir(),
			shell: true,
			timeoutMs: 300,
		});
		expect(out.timedOut).toBe(true);
		expect(await goneWithin(Number(out.stdout.trim()), 2_000)).toBe(true);
	});
});
