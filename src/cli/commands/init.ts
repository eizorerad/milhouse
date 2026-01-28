import pc from "picocolors";
import { PROBE_SUBDIRS, WORK_SUBDIRS } from "../../domain/config/directories.ts";
import { getConfigService } from "../../services/config/index.ts";
import { getDirectoryService } from "../../services/config/DirectoryService.ts";
import { logSuccess, logWarn } from "../../ui/logger.ts";

/**
 * Handle --init command
 * Creates the full .milhouse/ directory structure:
 * - .milhouse/config.yaml
 * - .milhouse/progress.txt
 * - .milhouse/state/
 * - .milhouse/probes/ (with subdirs: compose, postgres, redis, storage, deps, repro)
 * - .milhouse/plans/
 * - .milhouse/work/ (with subdirs: branches, worktrees)
 * - .milhouse/rules/
 */
export async function runInit(workDir = process.cwd()): Promise<void> {
	const configService = getConfigService(workDir);
	const directoryService = getDirectoryService();

	// Check if already initialized
	if (configService.isInitialized()) {
		logWarn(".milhouse/ already exists");

		// In a real CLI, we'd prompt the user
		// For now, just warn and return
		console.log("To overwrite, delete .milhouse/ and run again");
		return;
	}

	// Create directory structure first
	const { created: createdDirs } = directoryService.createDirectoryStructure(workDir);

	// Initialize config (creates config.yaml and progress.txt)
	const initResult = configService.ensureInitialized();
	if (!initResult.success) {
		const errorType = initResult.error.type;
		const errorPath = 'path' in initResult.error ? initResult.error.path : 'unknown';
		logWarn(`Failed to initialize config: ${errorType} at ${errorPath}`);
		return;
	}
	const { detected } = initResult.value;

	// Show what we detected
	console.log("");
	console.log(pc.bold("Detected:"));
	console.log(`  Project:   ${pc.cyan(detected.name)}`);
	if (detected.language) console.log(`  Language:  ${pc.cyan(detected.language)}`);
	if (detected.framework) console.log(`  Framework: ${pc.cyan(detected.framework)}`);
	if (detected.testCmd) console.log(`  Test:      ${pc.cyan(detected.testCmd)}`);
	if (detected.lintCmd) console.log(`  Lint:      ${pc.cyan(detected.lintCmd)}`);
	if (detected.buildCmd) console.log(`  Build:     ${pc.cyan(detected.buildCmd)}`);
	console.log("");

	logSuccess("Created .milhouse/");
	console.log("");

	// Show created directory structure
	console.log(pc.bold("Directory structure:"));
	console.log(`  ${pc.cyan(".milhouse/config.yaml")}     - Your rules and preferences`);
	console.log(`  ${pc.cyan(".milhouse/progress.txt")}    - Progress log (auto-updated)`);
	console.log(`  ${pc.cyan(".milhouse/state/")}          - Runtime state (issues, tasks, graph)`);
	console.log(`  ${pc.cyan(".milhouse/probes/")}         - Probe results`);
	for (const probe of PROBE_SUBDIRS) {
		console.log(`    ${pc.dim(`└─ ${probe}/`)}`);
	}
	console.log(`  ${pc.cyan(".milhouse/plans/")}          - Problem briefs and execution plans`);
	console.log(`  ${pc.cyan(".milhouse/work/")}           - Branch and worktree metadata`);
	for (const subdir of WORK_SUBDIRS) {
		console.log(`    ${pc.dim(`└─ ${subdir}/`)}`);
	}
	console.log(`  ${pc.cyan(".milhouse/rules/")}          - Custom rules catalog`);
	console.log("");

	// Show directories created count
	if (createdDirs.length > 0) {
		console.log(pc.dim(`Created ${createdDirs.length} directories`));
		console.log("");
	}

	console.log(pc.bold("Next steps:"));
	console.log(`  1. Add rules:  ${pc.cyan('milhouse --add-rule "your rule here"')}`);
	console.log(`  2. Or edit:    ${pc.cyan(".milhouse/config.yaml")}`);
	console.log(
		`  3. Run:        ${pc.cyan('milhouse "your task"')} or ${pc.cyan("milhouse")} (with PRD.md)`,
	);
}
