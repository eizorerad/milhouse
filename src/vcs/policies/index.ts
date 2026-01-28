/**
 * VCS Policies
 *
 * Centralized naming conventions and configuration for VCS operations.
 *
 * @module vcs/policies
 */

export {
	// Naming functions
	slugify,
	generateNonce,
	makeAgentBranchName,
	makeTaskBranchName,
	makeIntegrationBranchName,
	isMillhouseBranch,
	extractRunIdFromBranch,
	// Naming config
	DEFAULT_NAMING_CONFIG,
	// Types
	type NamingConfig,
	type AgentBranchNameOptions,
	type TaskBranchNameOptions,
	type IntegrationBranchNameOptions,
} from "./naming.ts";

export {
	// Worktree location functions
	getWorktreeRoot,
	getWorktreePath,
	isMillhouseWorktree,
	isLegacyRunsWorktreePath,
	getLegacyWorktreeBase,
	extractRunIdFromWorktreePath,
	extractTaskIdFromWorktreePath,
	isLegacyWorktreePath,
	generateWorktreeId,
	// Worktree config
	DEFAULT_WORKTREE_CONFIG,
	// Types
	type WorktreeConfig,
} from "./worktree-locations.ts";
