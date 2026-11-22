/** `milhouse upgrade` and the installer, against releases served from this machine and an origin on disk. */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pkg from "../package.json";
import { run } from "../src/proc.ts";
import { assetName, upgradeBinary, upgradeCheckout } from "../src/upgrade.ts";
import {
	captureConsole,
	cleanupTempDirs,
	commitFile,
	git,
	makeRepo,
	resetFakeAgentEnv,
	tempDir,
	unsetEnv,
} from "./helpers.ts";

const output = captureConsole();
let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
	server?.stop(true);
	server = undefined;
	unsetEnv("MILHOUSE_RELEASES");
	resetFakeAgentEnv();
	cleanupTempDirs();
});

/**
 * Serve the latest release for this computer: `binary` as the plain file (releases up to 0.5.4 have only this)
 * and `packed` as the gzipped file beside it. Without either, there is no release.
 */
function release(binary?: string, packed?: Uint8Array): void {
	const path = `/latest/download/${assetName()}`;
	server = Bun.serve({
		port: 0,
		fetch: (request) => {
			const asked = new URL(request.url).pathname;
			if (binary !== undefined && asked === path) return new Response(binary);
			if (packed !== undefined && asked === `${path}.gz`) return new Response(packed);
			return new Response("not found", { status: 404 });
		},
	});
	process.env.MILHOUSE_RELEASES = `http://localhost:${server.port}`;
}

/** A stand-in for a milhouse binary: all that an upgrade asks of one is its version. */
const binary = (version: string): string => `#!/bin/sh\necho ${version}\n`;

const gzipped = (text: string): Uint8Array => Bun.gzipSync(text);

/** Gzipped files that do not unpack: not gzip at all, and a download that broke off. */
const DAMAGED = [
	["is not gzip", new TextEncoder().encode("this is not gzip")],
	["is cut off", gzipped(binary("9.9.9")).subarray(0, 20)],
] as const;
const NOT_GZIP = DAMAGED[0][1];

/** An installed binary of this version, in a folder of its own. */
function installed(): string {
	const path = join(tempDir(), "milhouse");
	writeFileSync(path, "the one in use\n", { mode: 0o755 });
	return path;
}

describe("upgrading a binary", () => {
	it("puts the latest release in the place of the one in use", async () => {
		const path = installed();
		release(binary("9.9.9"));
		await upgradeBinary(path);
		expect(readFileSync(path, "utf-8")).toBe(binary("9.9.9"));
		expect((await run(path, ["--version"], { cwd: tempDir() })).stdout.trim()).toBe("9.9.9");
		expect(output.join("\n")).toContain(`Milhouse ${pkg.version} -> 9.9.9`);
		expect(existsSync(`${path}.new`)).toBe(false);
	});

	it("takes the gzipped file of a release when there is one, and unpacks it", async () => {
		const path = installed();
		release(undefined, gzipped(binary("9.9.9"))); // a release without a plain file
		await upgradeBinary(path);
		expect(readFileSync(path, "utf-8")).toBe(binary("9.9.9"));
		expect(output.join("\n")).toContain(`Milhouse ${pkg.version} -> 9.9.9`);
		expect(existsSync(`${path}.new`)).toBe(false);
	});

	it("prefers the gzipped file to the plain one attached beside it", async () => {
		const path = installed();
		release(binary("1.1.1"), gzipped(binary("9.9.9")));
		await upgradeBinary(path);
		expect(readFileSync(path, "utf-8")).toBe(binary("9.9.9"));
	});

	for (const [what, damaged] of DAMAGED) {
		it(`falls back to the plain file when the gzipped one ${what}`, async () => {
			const path = installed();
			release(binary("9.9.9"), damaged);
			await upgradeBinary(path);
			expect(readFileSync(path, "utf-8")).toBe(binary("9.9.9"));
		});
	}

	it("falls back to the plain file when the gzipped one cannot be fetched at all", async () => {
		const path = installed();
		release(binary("9.9.9"));
		const realFetch = globalThis.fetch;
		const gzippedCutsOff = (input: string, init?: RequestInit) =>
			input.endsWith(".gz")
				? Promise.reject(new TypeError("The socket connection was closed unexpectedly"))
				: realFetch(input, init);
		const broken = spyOn(globalThis, "fetch").mockImplementation(gzippedCutsOff as typeof fetch);
		try {
			await upgradeBinary(path);
		} finally {
			broken.mockRestore();
		}
		expect(readFileSync(path, "utf-8")).toBe(binary("9.9.9"));
	});

	it("keeps the one in use when the gzipped file is damaged and there is no plain one", async () => {
		const path = installed();
		release(undefined, NOT_GZIP);
		await expect(upgradeBinary(path)).rejects.toThrow(/Could not fetch/);
		expect(readFileSync(path, "utf-8")).toBe("the one in use\n");
		expect(existsSync(`${path}.new`)).toBe(false);
	});

	it("leaves the one in use when it is the latest already", async () => {
		const path = installed();
		release(binary(pkg.version));
		await upgradeBinary(path);
		expect(readFileSync(path, "utf-8")).toBe("the one in use\n");
		expect(output.join("\n")).toContain(`Milhouse ${pkg.version} is the latest`);
		expect(existsSync(`${path}.new`)).toBe(false);
	});

	it("keeps the one in use when there is no release for this computer, or the download does not start", async () => {
		const path = installed();
		release();
		await expect(upgradeBinary(path)).rejects.toThrow(/Could not fetch .*HTTP 404/);
		server?.stop(true);
		release("#!/bin/sh\necho broken >&2\nexit 1\n");
		await expect(upgradeBinary(path)).rejects.toThrow(/--version failed/);
		expect(readFileSync(path, "utf-8")).toBe("the one in use\n");
		expect(existsSync(`${path}.new`)).toBe(false);
	});
});

describe("upgrading a git checkout", () => {
	const manifest = (version: string) => JSON.stringify({ name: "milhouse-cli", version });

	it("pulls the new commits and says which version it came to", async () => {
		const origin = await makeRepo();
		await commitFile(origin, "package.json", manifest("1.0.0"), "1.0.0");
		const checkout = join(tempDir(), "milhouse");
		await git(origin, "clone", "-q", origin, checkout);

		await upgradeCheckout(checkout);
		expect(output.join("\n")).toContain("Milhouse 1.0.0");
		expect(output.join("\n")).toContain("is the latest");

		await commitFile(origin, "package.json", manifest("1.0.1"), "1.0.1");
		await upgradeCheckout(checkout);
		expect(readFileSync(join(checkout, "package.json"), "utf-8")).toBe(manifest("1.0.1"));
		expect(output.join("\n")).toMatch(/Milhouse 1\.0\.0 \(\w+\) -> 1\.0\.1 \(\w+\)/);
	});

	it("says why when the checkout cannot be fast-forwarded, and leaves it as it is", async () => {
		const origin = await makeRepo();
		const checkout = join(tempDir(), "milhouse");
		await git(origin, "clone", "-q", origin, checkout);
		await git(checkout, "config", "user.email", "test@example.com");
		await git(checkout, "config", "user.name", "Test");
		await commitFile(origin, "package.json", manifest("1.0.1"), "theirs");
		const mine = await commitFile(checkout, "package.json", manifest("1.0.0-mine"), "mine");

		await expect(upgradeCheckout(checkout)).rejects.toThrow(/git pull --ff-only failed/);
		expect(await git(checkout, "rev-parse", "HEAD")).toBe(mine);
	});
});

describe("the installer", () => {
	const INSTALLER = resolve(import.meta.dir, "../install.sh");
	const install = (dir: string) =>
		run("sh", [INSTALLER], { cwd: tempDir(), env: { ...process.env, MILHOUSE_INSTALL_DIR: dir } });

	it("puts the binary of the latest release for this computer into the folder, ready to run", async () => {
		release(binary("9.9.9")); // under the name the installer works out by itself: it has to be the upgrade's
		const dir = join(tempDir(), "bin");
		const result = await install(dir);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`Installed milhouse 9.9.9 in ${dir}`);
		expect(result.stdout).toContain("is not on your PATH");
		expect((await run(join(dir, "milhouse"), ["--version"], { cwd: dir })).stdout.trim()).toBe(
			"9.9.9",
		);
	});

	it("takes the gzipped file of the release when there is one", async () => {
		release(undefined, gzipped(binary("9.9.9")));
		const dir = join(tempDir(), "bin");
		const result = await install(dir);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`Installed milhouse 9.9.9 in ${dir}`);
		expect(existsSync(join(dir, "milhouse.new"))).toBe(false);
	});

	it("prefers the gzipped file to the plain one attached beside it", async () => {
		release(binary("1.1.1"), gzipped(binary("9.9.9")));
		const dir = join(tempDir(), "bin");
		expect((await install(dir)).stdout).toContain("Installed milhouse 9.9.9");
	});

	for (const [what, damaged] of DAMAGED) {
		it(`falls back to the plain file when the gzipped one ${what}`, async () => {
			release(binary("9.9.9"), damaged);
			const dir = join(tempDir(), "bin");
			const result = await install(dir);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("Installed milhouse 9.9.9");
		});
	}

	it("installs nothing, and leaves nothing behind, when there is no release to fetch", async () => {
		release();
		const dir = join(tempDir(), "bin");
		const result = await install(dir);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("the latest release has no binary");
		expect(existsSync(join(dir, "milhouse"))).toBe(false);
		expect(existsSync(join(dir, "milhouse.new"))).toBe(false);
	});

	it("installs nothing when the only file of the release is damaged", async () => {
		release(undefined, NOT_GZIP);
		const dir = join(tempDir(), "bin");
		const result = await install(dir);
		expect(result.code).toBe(1);
		expect(existsSync(join(dir, "milhouse"))).toBe(false);
		expect(existsSync(join(dir, "milhouse.new"))).toBe(false);
	});
});
