/**
 * Runs management command
 * milhouse runs list|info|switch|delete|cleanup|import-legacy-plans
 */

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import pc from "picocolors";
import {
	cleanupOldRuns,
	deleteRun,
	getCurrentRun,
	getCurrentRunId,
	getDateFromDuration,
	getLegacyPlansDir,
	getRunDir,
	hasLegacyPlansToImport,
	hasRuns,
	importLegacyPlans,
	listRuns,
	loadRunMeta,
	migrateLegacyToRun,
	setCurrentRun,
	syncLegacyPlansView,
} from "../../state/index.ts";
import { logError, logInfo, logSuccess, logWarn } from "../../ui/index.ts";

export interface RunsOptions {
	workDir: string;
}

export interface CleanupCommandOptions extends RunsOptions {
	olderThan?: string;
	keepLast?: number;
	dryRun?: boolean;
}

export interface ImportLegacyPlansOptions extends RunsOptions {
	dryRun?: boolean;
}

/**
 * List all runs
 */
export async function listRunsCommand(options: RunsOptions): Promise<void> {
	const runs = listRuns(options.workDir);

	if (runs.length === 0) {
		logWarn("No runs found.");
		logInfo('Start by scanning: milhouse --scan --scope "your scope"');
		return;
	}

	console.log(`\n📋 Pipeline Runs (${runs.length} total)\n`);

	for (const run of runs) {
		const current = run.is_current ? pc.green(" ← current") : "";
		const scope = run.scope ? pc.dim(` (${run.scope})`) : "";
		const phase = getPhaseEmoji(run.phase);

		console.log(`  ${phase} ${run.id}${scope}${current}`);
		console.log(pc.dim(`     Created: ${formatDate(run.created_at)}`));
	}

	console.log("");
}

/**
 * Show info about current or specific run
 */
export async function infoRunCommand(
	runId: string | undefined,
	options: RunsOptions,
): Promise<void> {
	let meta;

	if (runId) {
		meta = loadRunMeta(runId, options.workDir);
		if (!meta) {
			logError(`Run not found: ${runId}`);
			return;
		}
	} else {
		meta = getCurrentRun(options.workDir);
		if (!meta) {
			logError("No active run.");
			logInfo("Use: milhouse runs list");
			return;
		}
	}

	console.log(`\n📊 Run: ${meta.id}\n`);
	console.log(`  Phase:    ${getPhaseEmoji(meta.phase)} ${meta.phase}`);
	if (meta.scope) {
		console.log(`  Scope:    ${meta.scope}`);
	}
	if (meta.name) {
		console.log(`  Name:     ${meta.name}`);
	}
	console.log(`  Created:  ${formatDate(meta.created_at)}`);
	console.log(`  Updated:  ${formatDate(meta.updated_at)}`);
	console.log("");
	console.log("  Statistics:");
	console.log(`    Issues found:     ${meta.issues_found}`);
	console.log(`    Issues validated: ${meta.issues_validated}`);
	console.log(`    Tasks total:      ${meta.tasks_total}`);
	console.log(`    Tasks completed:  ${meta.tasks_completed}`);
	console.log(`    Tasks failed:     ${meta.tasks_failed}`);
	console.log("");
}

/**
 * Switch to a different run
 */
export async function switchRunCommand(runId: string, options: RunsOptions): Promise<void> {
	const success = setCurrentRun(runId, options.workDir);

	if (success) {
		const meta = loadRunMeta(runId, options.workDir);
		logSuccess(`Switched to run: ${runId}`);
		if (meta?.scope) {
			console.log(`  Scope: ${meta.scope}`);
		}
		console.log(`  Phase: ${meta?.phase}`);
	} else {
		logError(`Run not found: ${runId}`);
		logInfo("Use: milhouse runs list");
	}
}

/**
 * Delete a run
 */
export async function deleteRunCommand(runId: string, options: RunsOptions): Promise<void> {
	const meta = loadRunMeta(runId, options.workDir);
	if (!meta) {
		logError(`Run not found: ${runId}`);
		return;
	}

	const success = deleteRun(runId, options.workDir);

	if (success) {
		logSuccess(`Deleted run: ${runId}`);
	} else {
		logError(`Failed to delete run: ${runId}`);
	}
}

/**
 * Migrate legacy state to a new run
 */
export async function migrateRunCommand(options: RunsOptions): Promise<void> {
	if (hasRuns(options.workDir)) {
		logWarn("Runs already exist. Migration not needed.");
		return;
	}

	const run = migrateLegacyToRun({ workDir: options.workDir });

	if (run) {
		logSuccess(`Migrated legacy state to run: ${run.id}`);
		console.log("  This run is now active.");
	} else {
		logWarn("No legacy state found to migrate.");
	}
}

/**
 * Cleanup old runs
 */
export async function cleanupRunsCommand(options: CleanupCommandOptions): Promise<void> {
	// Validate options
	if (!options.olderThan && options.keepLast === undefined) {
		logError("Please specify at least one cleanup criteria");
		logInfo("Usage: milhouse runs cleanup --older-than 30d --keep-last 5");
		return;
	}

	// Parse olderThan if provided
	let olderThan: Date | undefined;
	if (options.olderThan) {
		try {
			olderThan = getDateFromDuration(options.olderThan);
		} catch (error) {
			logError(`Invalid duration format: ${options.olderThan}`);
			logInfo("Use format like: 30d (days), 2w (weeks), 6h (hours), 30m (minutes)");
			return;
		}
	}

	// Run cleanup
	const result = cleanupOldRuns({
		olderThan,
		keepLast: options.keepLast,
		workDir: options.workDir,
		dryRun: options.dryRun,
	});

	// Display results
	if (options.dryRun) {
		console.log(`\n🔍 Dry Run - No runs will be deleted\n`);
	}

	if (result.deleted.length === 0) {
		logInfo("No runs to clean up.");
		return;
	}

	console.log(
		`\n${options.dryRun ? "Would delete" : "Deleted"} ${result.deleted.length} run(s):\n`,
	);
	for (const run of result.deleted) {
		console.log(`  ${pc.red("✗")} ${run.id}`);
		console.log(pc.dim(`     Created: ${formatDate(run.created_at)}`));
		console.log(pc.dim(`     Reason: ${run.reason}`));
	}

	if (result.kept.length > 0) {
		console.log(`\nKept ${result.kept.length} run(s):\n`);
		for (const run of result.kept) {
			console.log(`  ${pc.green("✓")} ${run.id}`);
			console.log(pc.dim(`     Reason: ${run.reason}`));
		}
	}

	console.log("");

	if (options.dryRun) {
		logInfo("Run without --dry-run to actually delete these runs.");
	} else {
		logSuccess(`Cleaned up ${result.deleted.length} run(s).`);
	}
}

/**
 * Helper function to list files in legacy plans directory
 */
function listLegacyPlanFiles(workDir: string): string[] {
	const legacyPlansDir = getLegacyPlansDir(workDir);
	if (!existsSync(legacyPlansDir)) {
		return [];
	}

	try {
		const stats = lstatSync(legacyPlansDir);
		if (stats.isSymbolicLink()) {
			// Already a symlink, no legacy files to import
			return [];
		}
	} catch {
		return [];
	}

	try {
		return readdirSync(legacyPlansDir).filter((file) => {
			const filePath = join(legacyPlansDir, file);
			return existsSync(filePath) && !lstatSync(filePath).isDirectory();
		});
	} catch {
		return [];
	}
}

/**
 * Check if plans have already been imported for the current run
 */
function hasImportMarker(workDir: string): boolean {
	const currentRunId = getCurrentRunId(workDir);
	if (!currentRunId) {
		return false;
	}

	const runPlansDir = join(getRunDir(currentRunId, workDir), "plans");
	const markerPath = join(runPlansDir, ".imported-from-legacy.json");
	return existsSync(markerPath);
}

/**
 * Import legacy plans into the current run
 */
export async function importLegacyPlansCommand(options: ImportLegacyPlansOptions): Promise<void> {
	// Check if there's an active run
	const currentRunId = getCurrentRunId(options.workDir);
	if (!currentRunId) {
		logError("No active run.");
		logInfo("Create a run first with 'milhouse scan' or 'milhouse runs create'");
		return;
	}

	// Check if already imported
	if (hasImportMarker(options.workDir)) {
		logWarn("Plans already imported for this run (marker file exists).");
		const runPlansDir = join(getRunDir(currentRunId, options.workDir), "plans");
		const markerPath = join(runPlansDir, ".imported-from-legacy.json");
		logInfo(`Marker: ${relative(options.workDir, markerPath)}`);
		return;
	}

	// Check if there are legacy plans to import
	if (!hasLegacyPlansToImport(options.workDir)) {
		logWarn("No legacy plans found in .milhouse/plans");
		logInfo("Legacy plans directory is either empty, doesn't exist, or is already a symlink.");
		return;
	}

	// Get list of files to import
	const legacyFiles = listLegacyPlanFiles(options.workDir);
	const legacyPlansDir = getLegacyPlansDir(options.workDir);
	const runPlansDir = join(getRunDir(currentRunId, options.workDir), "plans");

	if (options.dryRun) {
		// Dry run - just show what would be imported
		console.log(
			`\n${pc.cyan("Legacy plans found in")} ${pc.yellow(relative(options.workDir, legacyPlansDir))}:\n`,
		);
		for (const file of legacyFiles) {
			console.log(`  ${pc.dim("-")} ${file}`);
		}
		console.log("");
		console.log(
			`${pc.cyan("Would import to:")} ${pc.yellow(relative(options.workDir, runPlansDir))}`,
		);
		console.log("");
		logInfo("Use without --dry-run to perform the import.");
		return;
	}

	// Perform the actual import
	console.log(`\n${pc.cyan("Importing legacy plans to current run...")}\n`);

	const importedCount = importLegacyPlans(options.workDir);

	if (importedCount === 0) {
		logWarn("No files were imported.");
		return;
	}

	// Show summary
	console.log(`${pc.green("Imported")} ${importedCount} file(s):\n`);
	for (const file of legacyFiles) {
		console.log(`  ${pc.dim("-")} ${file}`);
	}
	console.log("");
	console.log(`${pc.cyan("Target:")} ${pc.yellow(relative(options.workDir, runPlansDir))}`);

	const markerPath = join(runPlansDir, ".imported-from-legacy.json");
	console.log(`${pc.cyan("Marker:")} ${pc.yellow(relative(options.workDir, markerPath))}`);
	console.log("");

	// Sync the legacy plans view
	syncLegacyPlansView(options.workDir);
	logSuccess("Legacy plans view (.milhouse/plans) has been updated.");
}

/**
 * Main runs command dispatcher
 */
export async function runsCommand(
	subcommand: string,
	args: string[],
	options: RunsOptions & Partial<CleanupCommandOptions> & Partial<ImportLegacyPlansOptions>,
): Promise<void> {
	switch (subcommand) {
		case "list":
		case "ls":
			await listRunsCommand(options);
			break;

		case "info":
		case "show":
			await infoRunCommand(args[0], options);
			break;

		case "switch":
		case "use":
			if (!args[0]) {
				logError("Please specify a run ID");
				logInfo("Usage: milhouse runs switch <run-id>");
				return;
			}
			await switchRunCommand(args[0], options);
			break;

		case "delete":
		case "rm":
			if (!args[0]) {
				logError("Please specify a run ID");
				logInfo("Usage: milhouse runs delete <run-id>");
				return;
			}
			await deleteRunCommand(args[0], options);
			break;

		case "migrate":
			await migrateRunCommand(options);
			break;

		case "cleanup":
		case "clean":
			await cleanupRunsCommand({
				workDir: options.workDir,
				olderThan: options.olderThan,
				keepLast: options.keepLast,
				dryRun: options.dryRun,
			});
			break;

		case "import-legacy-plans":
			await importLegacyPlansCommand({
				workDir: options.workDir,
				dryRun: options.dryRun,
			});
			break;

		default:
			logError(`Unknown subcommand: ${subcommand}`);
			console.log("");
			console.log("Available commands:");
			console.log("  milhouse runs list                              - List all runs");
			console.log("  milhouse runs info [id]                         - Show run details");
			console.log("  milhouse runs switch <id>                       - Switch to a run");
			console.log("  milhouse runs delete <id>                       - Delete a run");
			console.log("  milhouse runs migrate                           - Migrate legacy state");
			console.log(
				"  milhouse runs cleanup --older-than 30d          - Delete runs older than 30 days",
			);
			console.log("  milhouse runs cleanup --keep-last 5             - Keep only last 5 runs");
			console.log("  milhouse runs cleanup --older-than 30d --keep-last 5 --dry-run");
			console.log(
				"  milhouse runs import-legacy-plans [--dry-run]   - Import legacy plans to current run",
			);
	}
}

// Helper functions

function getPhaseEmoji(phase: string): string {
	const emojis: Record<string, string> = {
		scan: "🔍",
		validate: "✅",
		plan: "📝",
		consolidate: "🔄",
		exec: "⚡",
		verify: "🧪",
		completed: "✨",
		failed: "❌",
	};
	return emojis[phase] || "•";
}

function formatDate(isoDate: string): string {
	const date = new Date(isoDate);
	return date.toLocaleString();
}
