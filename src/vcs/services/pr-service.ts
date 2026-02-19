/**
 * VCS PR Service
 *
 * High-level pull request operations using the GitHub CLI (gh).
 * Uses the git-cli backend for deterministic command execution.
 *
 * @module vcs/services/pr-service
 */

import { spawn } from "node:child_process";
import { bus } from "../../events/bus.ts";
import { runGitCommand } from "../backends/git-cli.ts";
import type {
	CreatePullRequestOptions,
	CreatePullRequestResult,
	IPrService,
	PrInfo,
	PrStatus,
	PushBranchOptions,
	PushBranchResult,
	VcsResult,
} from "../types.ts";
import { createVcsError, err, ok } from "../types.ts";

/**
 * Execute a command and return stdout/stderr/exitCode
 */
async function execCommand(
	command: string,
	args: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});

		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		child.on("error", () => {
			resolve({ stdout, stderr, exitCode: 1 });
		});

		child.on("close", (exitCode: number | null) => {
			resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
		});
	});
}

/**
 * PR Service implementation
 *
 * Provides high-level PR operations with proper error handling
 * and event emission for observability.
 */
export class PrService implements IPrService {
	/**
	 * Push a branch to origin
	 */
	async pushBranch(options: PushBranchOptions): Promise<VcsResult<PushBranchResult>> {
		const { branch, workDir = process.cwd(), setUpstream = true, force = false } = options;

		const args = ["push"];
		if (setUpstream) {
			args.push("--set-upstream");
		}
		if (force) {
			args.push("--force");
		}
		args.push("origin", branch);

		const result = await runGitCommand(args, workDir);
		if (!result.ok) {
			return result;
		}

		if (result.value.exitCode !== 0) {
			return err(
				createVcsError("PUSH_FAILED", "Failed to push branch", {
					context: { stderr: result.value.stderr, branch },
				}),
			);
		}

		// Emit event for branch push
		bus.emit("git:branch:create", { name: `pushed:${branch}` });

		// Get remote URL
		const remoteResult = await this.getOriginUrl(workDir);
		const remote = remoteResult.ok ? remoteResult.value : undefined;

		return ok({
			success: true,
			remote: remote ?? undefined,
		});
	}

	/**
	 * Create a pull request using gh CLI
	 *
	 * This operation:
	 * 1. Pushes the branch to origin
	 * 2. Creates a PR using the GitHub CLI
	 * 3. Emits events for observability
	 */
	async createPullRequest(
		options: CreatePullRequestOptions,
	): Promise<VcsResult<CreatePullRequestResult>> {
		const {
			branch,
			baseBranch,
			title,
			body,
			workDir = process.cwd(),
			draft = false,
			labels = [],
			reviewers = [],
		} = options;

		// Push branch first
		const pushResult = await this.pushBranch({ branch, workDir });
		if (!pushResult.ok) {
			return pushResult;
		}

		if (!pushResult.value.success) {
			return err(createVcsError("PUSH_FAILED", "Failed to push branch before creating PR"));
		}

		// Build gh pr create command args
		const args = [
			"pr",
			"create",
			"--base",
			baseBranch,
			"--head",
			branch,
			"--title",
			title,
			"--body",
			body,
		];

		if (draft) {
			args.push("--draft");
		}

		for (const label of labels) {
			args.push("--label", label);
		}

		for (const reviewer of reviewers) {
			args.push("--reviewer", reviewer);
		}

		// Execute gh CLI
		const { stdout, stderr, exitCode } = await execCommand("gh", args, workDir);

		if (exitCode !== 0) {
			// Emit failure event
			bus.emit("git:branch:create", { name: `pr-failed:${branch}` });

			return err(
				createVcsError("PR_CREATION_FAILED", "Failed to create pull request", {
					context: { stderr, branch, baseBranch },
				}),
			);
		}

		// Emit success event
		bus.emit("git:branch:create", { name: `pr-created:${branch}` });

		// Parse PR URL from output
		const url = stdout.trim();

		// Extract PR number from URL
		const prNumberMatch = url.match(/\/pull\/(\d+)/);
		const number = prNumberMatch ? Number.parseInt(prNumberMatch[1], 10) : 0;

		return ok({ url, number });
	}

	/**
	 * Check if gh CLI is available and authenticated
	 */
	async isGhAvailable(): Promise<boolean> {
		try {
			const { exitCode } = await execCommand("gh", ["auth", "status"], process.cwd());
			return exitCode === 0;
		} catch {
			return false;
		}
	}

	/**
	 * Get PR status for a branch
	 */
	async getPrStatus(branch: string, workDir?: string): Promise<VcsResult<PrStatus>> {
		const cwd = workDir ?? process.cwd();

		const { stdout, stderr, exitCode } = await execCommand(
			"gh",
			["pr", "view", branch, "--json", "number,title,state,url"],
			cwd,
		);

		if (exitCode !== 0) {
			// No PR exists for this branch
			if (stderr.includes("no pull requests found") || stderr.includes("Could not resolve")) {
				return ok({ exists: false });
			}

			return err(
				createVcsError("COMMAND_FAILED", "Failed to get PR status", {
					context: { stderr, branch },
				}),
			);
		}

		try {
			const data = JSON.parse(stdout);
			return ok({
				exists: true,
				state: data.state?.toLowerCase() as "open" | "closed" | "merged",
				url: data.url,
				number: data.number,
				title: data.title,
			});
		} catch {
			return err(
				createVcsError("COMMAND_FAILED", "Failed to parse PR status", {
					context: { stdout },
				}),
			);
		}
	}

	/**
	 * Check if a PR exists for a branch
	 */
	async prExistsForBranch(branch: string, workDir?: string): Promise<VcsResult<boolean>> {
		const statusResult = await this.getPrStatus(branch, workDir);
		if (!statusResult.ok) {
			return statusResult;
		}

		return ok(statusResult.value.exists);
	}

	/**
	 * Get PR URL for a branch
	 */
	async getPrUrlForBranch(branch: string, workDir?: string): Promise<VcsResult<string | null>> {
		const statusResult = await this.getPrStatus(branch, workDir);
		if (!statusResult.ok) {
			return statusResult;
		}

		return ok(statusResult.value.url ?? null);
	}

	/**
	 * List open PRs
	 */
	async listOpenPrs(workDir?: string, limit = 30): Promise<VcsResult<PrInfo[]>> {
		const cwd = workDir ?? process.cwd();

		const { stdout, stderr, exitCode } = await execCommand(
			"gh",
			[
				"pr",
				"list",
				"--state",
				"open",
				"--limit",
				String(limit),
				"--json",
				"number,title,url,headRefName,baseRefName,state,isDraft",
			],
			cwd,
		);

		if (exitCode !== 0) {
			return err(
				createVcsError("COMMAND_FAILED", "Failed to list PRs", {
					context: { stderr },
				}),
			);
		}

		try {
			const data = JSON.parse(stdout);
			return ok(
				data.map((pr: Record<string, unknown>) => ({
					number: pr.number as number,
					title: pr.title as string,
					url: pr.url as string,
					headBranch: pr.headRefName as string,
					baseBranch: pr.baseRefName as string,
					state: (pr.state as string)?.toLowerCase() as "open" | "closed" | "merged",
					isDraft: pr.isDraft as boolean,
				})),
			);
		} catch {
			return err(
				createVcsError("COMMAND_FAILED", "Failed to parse PR list", {
					context: { stdout },
				}),
			);
		}
	}

	/**
	 * Get the remote URL for origin
	 */
	async getOriginUrl(workDir?: string): Promise<VcsResult<string | null>> {
		const cwd = workDir ?? process.cwd();

		const result = await runGitCommand(["remote", "get-url", "origin"], cwd);
		if (!result.ok) {
			return result;
		}

		if (result.value.exitCode !== 0) {
			return ok(null);
		}

		return ok(result.value.stdout.trim() || null);
	}
}

// ============================================================================
// Standalone Function Exports (for convenience)
// ============================================================================

const defaultService = new PrService();

/**
 * Push a branch to origin
 * @see PrService.pushBranch
 */
export async function pushBranch(
	branch: string,
	workDir?: string,
	options?: Partial<PushBranchOptions>,
): Promise<VcsResult<PushBranchResult>> {
	return defaultService.pushBranch({ branch, workDir, ...options });
}

/**
 * Create a pull request using gh CLI
 * @see PrService.createPullRequest
 */
export async function createPullRequest(
	branch: string,
	baseBranch: string,
	title: string,
	body: string,
	options?: Partial<CreatePullRequestOptions>,
): Promise<VcsResult<CreatePullRequestResult>> {
	return defaultService.createPullRequest({
		branch,
		baseBranch,
		title,
		body,
		...options,
	});
}

/**
 * Check if gh CLI is available and authenticated
 * @see PrService.isGhAvailable
 */
export async function isGhAvailable(): Promise<boolean> {
	return defaultService.isGhAvailable();
}

/**
 * Get PR status for a branch
 * @see PrService.getPrStatus
 */
export async function getPrStatus(branch: string, workDir?: string): Promise<VcsResult<PrStatus>> {
	return defaultService.getPrStatus(branch, workDir);
}

/**
 * Check if a PR exists for a branch
 * @see PrService.prExistsForBranch
 */
export async function prExistsForBranch(
	branch: string,
	workDir?: string,
): Promise<VcsResult<boolean>> {
	return defaultService.prExistsForBranch(branch, workDir);
}

/**
 * Get PR URL for a branch
 * @see PrService.getPrUrlForBranch
 */
export async function getPrUrlForBranch(
	branch: string,
	workDir?: string,
): Promise<VcsResult<string | null>> {
	return defaultService.getPrUrlForBranch(branch, workDir);
}

/**
 * List open PRs
 * @see PrService.listOpenPrs
 */
export async function listOpenPrs(workDir?: string, limit?: number): Promise<VcsResult<PrInfo[]>> {
	return defaultService.listOpenPrs(workDir, limit);
}

/**
 * Get the remote URL for origin
 * @see PrService.getOriginUrl
 */
export async function getOriginUrl(workDir?: string): Promise<VcsResult<string | null>> {
	return defaultService.getOriginUrl(workDir);
}
