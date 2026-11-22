/** `milhouse upgrade`: bring this installation to the latest version, the way it was installed. */

import { chmodSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import pkg from "../package.json";
import { run } from "./proc.ts";
import { log } from "./ui.ts";
import { MINUTE, tail } from "./util.ts";

/** Where the releases are. MILHOUSE_RELEASES points the installer and the tests at another place. */
const releases = (): string =>
	process.env.MILHOUSE_RELEASES || "https://github.com/eizorerad/milhouse/releases";

/** The file of a release for this computer, as the release workflow names it. */
export const assetName = (): string => `milhouse-${process.platform}-${process.arch}`;

/** Stdout of a command that has to succeed. */
async function output(command: string, args: string[], cwd: string): Promise<string> {
	const result = await run(command, args, { cwd, timeoutMs: 10 * MINUTE });
	if (result.code !== 0) {
		const why = tail(result.stderr || result.stdout, 1000);
		throw new Error(`${command} ${args.join(" ")} failed:\n${why}`);
	}
	return result.stdout.trim();
}

/** A git checkout that `bun link` put on the PATH: pull, and install what the new version needs. */
export async function upgradeCheckout(dir: string): Promise<void> {
	const version = (): string =>
		JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")).version;
	const head = (): Promise<string> => output("git", ["rev-parse", "--short", "HEAD"], dir);
	const before = { version: version(), commit: await head() };
	await output("git", ["pull", "--ff-only"], dir);
	const commit = await head();
	if (commit === before.commit) {
		log.success(`Milhouse ${before.version} (${commit}) is the latest.`);
		return;
	}
	// Bun itself runs this file: it is there also where it is not on the PATH.
	await output(process.execPath, ["install", "--frozen-lockfile"], dir);
	log.success(`Milhouse ${before.version} (${before.commit}) -> ${version()} (${commit})`);
}

/**
 * The binary of the latest release for this computer. A release carries it twice: gzipped (about half of the
 * download) and plain, which is all that releases up to 0.5.4 have and what their `milhouse upgrade` fetches.
 * The gzipped file is taken when it can be fetched and unpacked, otherwise the plain one.
 */
async function fetchBinary(): Promise<Uint8Array> {
	const url = `${releases()}/latest/download/${assetName()}`;
	const packed = await fetch(`${url}.gz`);
	if (packed.ok) {
		try {
			return Bun.gunzipSync(new Uint8Array(await packed.arrayBuffer()));
		} catch {
			// not a gzip file: the plain one is next to it
		}
	}
	const plain = await fetch(url);
	if (!plain.ok) throw new Error(`Could not fetch ${url} (HTTP ${plain.status}).`);
	return new Uint8Array(await plain.arrayBuffer());
}

/** A binary from a release: fetch the latest, see that it starts, then put it in the place of this one. */
export async function upgradeBinary(path: string): Promise<void> {
	const binary = await fetchBinary();
	const fresh = `${path}.new`; // beside it: a rename within one folder replaces the file in one step
	try {
		await Bun.write(fresh, binary);
		chmodSync(fresh, 0o755);
		const version = await output(fresh, ["--version"], dirname(path));
		if (version === pkg.version) {
			log.success(`Milhouse ${version} is the latest.`);
			return;
		}
		renameSync(fresh, path);
		log.success(`Milhouse ${pkg.version} -> ${version}`);
	} finally {
		rmSync(fresh, { force: true });
	}
}

export async function upgrade(): Promise<void> {
	// A compiled binary carries its sources inside itself.
	if (import.meta.dir.startsWith("/$bunfs/")) return upgradeBinary(process.execPath);
	const checkout = resolve(import.meta.dir, "..");
	if (existsSync(join(checkout, ".git"))) return upgradeCheckout(checkout);
	throw new Error(
		"This Milhouse comes neither from a release nor from a git checkout: update it the way it was installed.",
	);
}
