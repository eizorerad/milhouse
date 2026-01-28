import * as fs from "node:fs";
import * as path from "node:path";
import { BaseProbe, type CommandResult } from "./base.ts";
import {
	type Dependency,
	type DepsProbeOutput,
	type ProbeConfig,
	type ProbeFinding,
	type ProbeInput,
	type ProbeResult,
	createProbeFinding,
} from "./types.ts";

/**
 * Package manager detection patterns
 */
const PACKAGE_MANAGER_FILES: Record<DepsProbeOutput["package_manager"], string[]> = {
	npm: ["package-lock.json"],
	yarn: ["yarn.lock"],
	pnpm: ["pnpm-lock.yaml"],
	pip: ["requirements.txt", "requirements-dev.txt", "requirements-prod.txt"],
	poetry: ["poetry.lock", "pyproject.toml"],
	cargo: ["Cargo.lock"],
	go: ["go.sum", "go.mod"],
	other: [],
};

/**
 * Manifest files by package manager
 */
const MANIFEST_FILES: Record<DepsProbeOutput["package_manager"], string[]> = {
	npm: ["package.json"],
	yarn: ["package.json"],
	pnpm: ["package.json"],
	pip: ["requirements.txt", "setup.py", "pyproject.toml"],
	poetry: ["pyproject.toml"],
	cargo: ["Cargo.toml"],
	go: ["go.mod"],
	other: [],
};

/**
 * Known vulnerable package patterns (simplified - real implementation would use security advisory databases)
 */
const KNOWN_VULNERABLE_PATTERNS: Array<{
	name: RegExp;
	minVersion?: string;
	maxVersion?: string;
	severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
	cve?: string;
	description: string;
}> = [
	{
		name: /^lodash$/,
		maxVersion: "4.17.20",
		severity: "HIGH",
		cve: "CVE-2021-23337",
		description: "Prototype pollution vulnerability in lodash",
	},
	{
		name: /^axios$/,
		maxVersion: "0.21.0",
		severity: "HIGH",
		cve: "CVE-2021-3749",
		description: "SSRF vulnerability in axios",
	},
	{
		name: /^minimist$/,
		maxVersion: "1.2.5",
		severity: "CRITICAL",
		cve: "CVE-2021-44906",
		description: "Prototype pollution in minimist",
	},
	{
		name: /^node-fetch$/,
		maxVersion: "2.6.0",
		severity: "HIGH",
		cve: "CVE-2022-0235",
		description: "Exposure of sensitive information in node-fetch",
	},
	{
		name: /^glob-parent$/,
		maxVersion: "5.1.1",
		severity: "HIGH",
		cve: "CVE-2020-28469",
		description: "Regular expression denial of service in glob-parent",
	},
	{
		name: /^tar$/,
		maxVersion: "6.1.8",
		severity: "HIGH",
		cve: "CVE-2021-37712",
		description: "Arbitrary file creation/overwrite in tar",
	},
	{
		name: /^express$/,
		maxVersion: "4.17.2",
		severity: "MEDIUM",
		cve: "CVE-2022-24999",
		description: "Open redirect vulnerability in express",
	},
	{
		name: /^json5$/,
		maxVersion: "2.2.1",
		severity: "HIGH",
		cve: "CVE-2022-46175",
		description: "Prototype pollution in json5",
	},
];

/**
 * Interface for package.json structure
 */
interface PackageJson {
	name?: string;
	version?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}

/**
 * Interface for npm package-lock.json structure
 */
interface PackageLock {
	lockfileVersion?: number;
	packages?: Record<
		string,
		{
			version?: string;
			resolved?: string;
			dev?: boolean;
		}
	>;
	dependencies?: Record<
		string,
		{
			version: string;
			resolved?: string;
			dev?: boolean;
		}
	>;
}

/**
 * Interface for Cargo.toml structure
 */
interface CargoToml {
	dependencies?: Record<string, string | { version: string }>;
	devDependencies?: Record<string, string | { version: string }>;
	"dev-dependencies"?: Record<string, string | { version: string }>;
}

/**
 * Dependency Version Auditor (DVA)
 *
 * Analyzes dependency configurations and lockfiles:
 * - Detects package manager (npm, yarn, pnpm, pip, poetry, cargo, go)
 * - Compares lockfile versions vs manifest specifications
 * - Identifies outdated dependencies
 * - Detects known vulnerable packages
 *
 * Capabilities:
 * - Read manifest files (package.json, pyproject.toml, Cargo.toml, go.mod)
 * - Parse lockfiles for installed versions
 * - Check against known vulnerability patterns
 * - Cannot modify dependencies or run package managers
 *
 * Output:
 * - Package manager detected
 * - List of dependencies with versions
 * - Outdated and vulnerable dependency counts
 * - Security findings and recommendations
 */
export class DepsProbe extends BaseProbe<DepsProbeOutput> {
	constructor(configOverrides?: Partial<ProbeConfig>) {
		super("deps", configOverrides);
	}

	/**
	 * Get commands to execute for dependency inspection
	 * These are informational commands only - no write operations
	 */
	protected getCommands(_input: ProbeInput): Array<{ command: string; args: string[] }> {
		// We primarily parse files directly, so no commands needed
		return [];
	}

	/**
	 * Override execute to handle file-based parsing
	 * Since deps probe primarily reads manifest/lockfiles
	 */
	async execute(input: ProbeInput): Promise<ProbeResult> {
		const startTime = Date.now();

		// Validate input
		if (!this.validateInput(input)) {
			const duration = Date.now() - startTime;
			return {
				probe_id: `deps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				probe_type: "deps",
				success: false,
				error: "Invalid probe input: workDir is required",
				timestamp: new Date().toISOString(),
				read_only: true,
				duration_ms: duration,
				findings: [],
			};
		}

		try {
			// Detect package manager
			const packageManager = this.detectPackageManager(input.workDir);

			// Find lockfile
			const lockfile = this.findLockfile(input.workDir, packageManager);

			// Extract dependencies
			const dependencies = this.extractDependencies(input.workDir, packageManager);

			// Check for vulnerabilities
			const { vulnerableCount, vulnerableDeps } = this.checkVulnerabilities(dependencies);

			// Count outdated (based on version constraints)
			const outdatedCount = dependencies.filter((d) => d.is_outdated).length;

			// Build the output
			const output: DepsProbeOutput = {
				package_manager: packageManager,
				lockfile,
				dependencies,
				total_count: dependencies.length,
				outdated_count: outdatedCount,
				vulnerable_count: vulnerableCount,
				issues: [],
			};

			// Extract findings
			const findings = this.extractFindings(output);

			// Add vulnerability findings
			for (const dep of vulnerableDeps) {
				if (dep.vulnerability_ids.length > 0) {
					findings.push(
						createProbeFinding(
							`vulnerable-${dep.name}`,
							`Vulnerable dependency: ${dep.name}`,
							`${dep.name}@${dep.installed_version || dep.specified_version} has known vulnerabilities: ${dep.vulnerability_ids.join(", ")}`,
							dep.vulnerability_severity ?? "HIGH",
							{
								file: lockfile ?? "package.json",
								suggestion: `Update ${dep.name} to latest version`,
								metadata: {
									package: dep.name,
									version: dep.installed_version || dep.specified_version,
									cves: dep.vulnerability_ids,
								},
							},
						),
					);
				}
			}

			const duration = Date.now() - startTime;
			return {
				probe_id: `deps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				probe_type: "deps",
				success: true,
				output: this.formatOutput(output),
				timestamp: new Date().toISOString(),
				read_only: true,
				duration_ms: duration,
				findings,
				raw_output: JSON.stringify(output, null, 2),
			};
		} catch (error) {
			const duration = Date.now() - startTime;
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				probe_id: `deps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				probe_type: "deps",
				success: false,
				error: `Failed to analyze dependencies: ${errorMessage}`,
				timestamp: new Date().toISOString(),
				read_only: true,
				duration_ms: duration,
				findings: [],
			};
		}
	}

	/**
	 * Detect the package manager used in the project
	 */
	detectPackageManager(workDir: string): DepsProbeOutput["package_manager"] {
		// Check for lockfiles in priority order
		const managerPriority: DepsProbeOutput["package_manager"][] = [
			"pnpm",
			"yarn",
			"npm",
			"poetry",
			"pip",
			"cargo",
			"go",
		];

		for (const manager of managerPriority) {
			const files = PACKAGE_MANAGER_FILES[manager];
			for (const file of files) {
				if (fs.existsSync(path.join(workDir, file))) {
					return manager;
				}
			}
		}

		// Check for manifest files without lockfiles
		if (fs.existsSync(path.join(workDir, "package.json"))) {
			return "npm";
		}
		if (fs.existsSync(path.join(workDir, "pyproject.toml"))) {
			return "poetry";
		}
		if (fs.existsSync(path.join(workDir, "requirements.txt"))) {
			return "pip";
		}
		if (fs.existsSync(path.join(workDir, "Cargo.toml"))) {
			return "cargo";
		}
		if (fs.existsSync(path.join(workDir, "go.mod"))) {
			return "go";
		}

		return "other";
	}

	/**
	 * Find the lockfile path for the detected package manager
	 */
	findLockfile(
		workDir: string,
		packageManager: DepsProbeOutput["package_manager"],
	): string | undefined {
		const files = PACKAGE_MANAGER_FILES[packageManager];
		for (const file of files) {
			const filePath = path.join(workDir, file);
			if (fs.existsSync(filePath)) {
				return file;
			}
		}
		return undefined;
	}

	/**
	 * Extract dependencies based on package manager
	 */
	extractDependencies(
		workDir: string,
		packageManager: DepsProbeOutput["package_manager"],
	): Dependency[] {
		switch (packageManager) {
			case "npm":
			case "yarn":
			case "pnpm":
				return this.extractNodeDependencies(workDir, packageManager);
			case "pip":
				return this.extractPipDependencies(workDir);
			case "poetry":
				return this.extractPoetryDependencies(workDir);
			case "cargo":
				return this.extractCargoDependencies(workDir);
			case "go":
				return this.extractGoDependencies(workDir);
			default:
				return [];
		}
	}

	/**
	 * Extract Node.js dependencies from package.json and lockfile
	 */
	extractNodeDependencies(workDir: string, packageManager: "npm" | "yarn" | "pnpm"): Dependency[] {
		const dependencies: Dependency[] = [];

		// Read package.json
		const packageJsonPath = path.join(workDir, "package.json");
		if (!fs.existsSync(packageJsonPath)) {
			return dependencies;
		}

		const packageJson: PackageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

		// Get installed versions from lockfile
		const installedVersions = this.getInstalledVersionsFromLockfile(workDir, packageManager);

		// Process production dependencies
		if (packageJson.dependencies) {
			for (const [name, specifiedVersion] of Object.entries(packageJson.dependencies)) {
				const installedVersion = installedVersions.get(name);
				dependencies.push({
					name,
					specified_version: specifiedVersion,
					installed_version: installedVersion,
					is_dev: false,
					is_outdated: this.isVersionOutdated(specifiedVersion, installedVersion),
					is_vulnerable: false,
					vulnerability_ids: [],
				});
			}
		}

		// Process dev dependencies
		if (packageJson.devDependencies) {
			for (const [name, specifiedVersion] of Object.entries(packageJson.devDependencies)) {
				const installedVersion = installedVersions.get(name);
				dependencies.push({
					name,
					specified_version: specifiedVersion,
					installed_version: installedVersion,
					is_dev: true,
					is_outdated: this.isVersionOutdated(specifiedVersion, installedVersion),
					is_vulnerable: false,
					vulnerability_ids: [],
				});
			}
		}

		// Process peer dependencies
		if (packageJson.peerDependencies) {
			for (const [name, specifiedVersion] of Object.entries(packageJson.peerDependencies)) {
				// Skip if already in dependencies
				if (dependencies.some((d) => d.name === name)) {
					continue;
				}
				const installedVersion = installedVersions.get(name);
				dependencies.push({
					name,
					specified_version: specifiedVersion,
					installed_version: installedVersion,
					is_dev: false,
					is_outdated: false,
					is_vulnerable: false,
					vulnerability_ids: [],
				});
			}
		}

		return dependencies;
	}

	/**
	 * Get installed versions from lockfile
	 */
	getInstalledVersionsFromLockfile(
		workDir: string,
		packageManager: "npm" | "yarn" | "pnpm",
	): Map<string, string> {
		const versions = new Map<string, string>();

		if (packageManager === "npm") {
			const lockPath = path.join(workDir, "package-lock.json");
			if (fs.existsSync(lockPath)) {
				const lockfile: PackageLock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));

				// lockfileVersion 2 and 3 use packages
				if (lockfile.packages) {
					for (const [pkgPath, pkg] of Object.entries(lockfile.packages)) {
						if (pkgPath === "") continue; // Skip root package
						// Extract package name from path (e.g., "node_modules/lodash" -> "lodash")
						const name = pkgPath.replace(/^node_modules\//, "").replace(/\/node_modules\/.*$/, "");
						if (pkg.version && !name.includes("node_modules")) {
							versions.set(name, pkg.version);
						}
					}
				}

				// lockfileVersion 1 uses dependencies
				if (lockfile.dependencies) {
					for (const [name, dep] of Object.entries(lockfile.dependencies)) {
						if (dep.version) {
							versions.set(name, dep.version);
						}
					}
				}
			}
		} else if (packageManager === "yarn") {
			const lockPath = path.join(workDir, "yarn.lock");
			if (fs.existsSync(lockPath)) {
				const content = fs.readFileSync(lockPath, "utf-8");
				// Parse yarn.lock format
				const versionMatches = content.matchAll(
					/^"?([^@\s]+)@[^":\n]+[",]?:\n\s+version[:\s]+"?([^"\n]+)"?/gm,
				);
				for (const match of versionMatches) {
					const name = match[1].replace(/^@/, "@");
					const version = match[2];
					versions.set(name, version);
				}
			}
		} else if (packageManager === "pnpm") {
			const lockPath = path.join(workDir, "pnpm-lock.yaml");
			if (fs.existsSync(lockPath)) {
				const content = fs.readFileSync(lockPath, "utf-8");
				// Parse pnpm-lock.yaml - simplified parsing
				const versionMatches = content.matchAll(
					/^\s+'?([^@:\s]+)@?'?:\s*(?:\n\s+version:\s*'?([^'\n]+)'?|\s*'?([^'\n]+)'?)/gm,
				);
				for (const match of versionMatches) {
					const name = match[1];
					const version = match[2] || match[3];
					if (version && !version.includes(":")) {
						versions.set(name, version);
					}
				}
			}
		}

		return versions;
	}

	/**
	 * Extract pip dependencies from requirements.txt
	 */
	extractPipDependencies(workDir: string): Dependency[] {
		const dependencies: Dependency[] = [];
		const reqFiles = ["requirements.txt", "requirements-dev.txt", "requirements-prod.txt"];

		for (const reqFile of reqFiles) {
			const reqPath = path.join(workDir, reqFile);
			if (!fs.existsSync(reqPath)) {
				continue;
			}

			const content = fs.readFileSync(reqPath, "utf-8");
			const isDev = reqFile.includes("dev");

			// Parse requirements.txt format: package==version, package>=version, etc.
			const lines = content.split("\n");
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) {
					continue;
				}

				// Match package name and version specifier
				const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*([=<>!~]+)?\s*([0-9][^\s;#]*)?/);
				if (match) {
					const name = match[1];
					const operator = match[2] || "";
					const version = match[3] || "";
					dependencies.push({
						name,
						specified_version: `${operator}${version}`.trim() || "*",
						is_dev: isDev,
						is_outdated: false,
						is_vulnerable: false,
						vulnerability_ids: [],
					});
				}
			}
		}

		return dependencies;
	}

	/**
	 * Extract poetry dependencies from pyproject.toml and poetry.lock
	 */
	extractPoetryDependencies(workDir: string): Dependency[] {
		const dependencies: Dependency[] = [];

		// Read pyproject.toml
		const pyprojectPath = path.join(workDir, "pyproject.toml");
		if (!fs.existsSync(pyprojectPath)) {
			return dependencies;
		}

		const content = fs.readFileSync(pyprojectPath, "utf-8");

		// Get installed versions from poetry.lock
		const installedVersions = this.getPoetryLockVersions(workDir);

		// Parse [tool.poetry.dependencies] section
		const depsMatch = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\[|$)/);
		if (depsMatch) {
			const depsSection = depsMatch[1];
			const depMatches = depsSection.matchAll(/^([a-zA-Z0-9_-]+)\s*=\s*["']?([^"'\n]+)["']?/gm);
			for (const match of depMatches) {
				const name = match[1];
				if (name === "python") continue;
				const specifiedVersion = match[2];
				dependencies.push({
					name,
					specified_version: specifiedVersion,
					installed_version: installedVersions.get(name.toLowerCase()),
					is_dev: false,
					is_outdated: false,
					is_vulnerable: false,
					vulnerability_ids: [],
				});
			}
		}

		// Parse [tool.poetry.dev-dependencies] section
		const devDepsMatch = content.match(
			/\[tool\.poetry\.(?:dev-)?dependencies\.dev\]([\s\S]*?)(?=\[|$)/,
		);
		if (devDepsMatch) {
			const devDepsSection = devDepsMatch[1];
			const depMatches = devDepsSection.matchAll(/^([a-zA-Z0-9_-]+)\s*=\s*["']?([^"'\n]+)["']?/gm);
			for (const match of depMatches) {
				const name = match[1];
				const specifiedVersion = match[2];
				dependencies.push({
					name,
					specified_version: specifiedVersion,
					installed_version: installedVersions.get(name.toLowerCase()),
					is_dev: true,
					is_outdated: false,
					is_vulnerable: false,
					vulnerability_ids: [],
				});
			}
		}

		return dependencies;
	}

	/**
	 * Get installed versions from poetry.lock
	 */
	getPoetryLockVersions(workDir: string): Map<string, string> {
		const versions = new Map<string, string>();
		const lockPath = path.join(workDir, "poetry.lock");

		if (!fs.existsSync(lockPath)) {
			return versions;
		}

		const content = fs.readFileSync(lockPath, "utf-8");

		// Parse [[package]] sections
		const packageMatches = content.matchAll(
			/\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"/g,
		);
		for (const match of packageMatches) {
			versions.set(match[1].toLowerCase(), match[2]);
		}

		return versions;
	}

	/**
	 * Extract Cargo dependencies from Cargo.toml and Cargo.lock
	 */
	extractCargoDependencies(workDir: string): Dependency[] {
		const dependencies: Dependency[] = [];

		// Read Cargo.toml
		const cargoPath = path.join(workDir, "Cargo.toml");
		if (!fs.existsSync(cargoPath)) {
			return dependencies;
		}

		const content = fs.readFileSync(cargoPath, "utf-8");

		// Get installed versions from Cargo.lock
		const installedVersions = this.getCargoLockVersions(workDir);

		// Parse [dependencies] section
		const depsMatch = content.match(/\[dependencies\]([\s\S]*?)(?=\n\[|$)/);
		if (depsMatch) {
			const depsSection = depsMatch[1];
			const extractedDeps = this.parseCargoSection(depsSection);
			for (const dep of extractedDeps) {
				dependencies.push({
					...dep,
					installed_version: installedVersions.get(dep.name),
					is_dev: false,
				});
			}
		}

		// Parse [dev-dependencies] section
		const devDepsMatch = content.match(/\[dev-dependencies\]([\s\S]*?)(?=\n\[|$)/);
		if (devDepsMatch) {
			const devDepsSection = devDepsMatch[1];
			const extractedDeps = this.parseCargoSection(devDepsSection);
			for (const dep of extractedDeps) {
				dependencies.push({
					...dep,
					installed_version: installedVersions.get(dep.name),
					is_dev: true,
				});
			}
		}

		return dependencies;
	}

	/**
	 * Parse a section of Cargo.toml dependencies
	 */
	parseCargoSection(section: string): Array<{
		name: string;
		specified_version: string;
		is_outdated: boolean;
		is_vulnerable: boolean;
		vulnerability_ids: string[];
	}> {
		const deps: Array<{
			name: string;
			specified_version: string;
			is_outdated: boolean;
			is_vulnerable: boolean;
			vulnerability_ids: string[];
		}> = [];

		const lines = section.split("\n");
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			// Match: name = "version"
			const simpleMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"$/);
			if (simpleMatch) {
				deps.push({
					name: simpleMatch[1],
					specified_version: simpleMatch[2],
					is_outdated: false,
					is_vulnerable: false,
					vulnerability_ids: [],
				});
				continue;
			}

			// Match: name = { version = "x.y.z", ... }
			const inlineTableMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*\{([^}]+)\}/);
			if (inlineTableMatch) {
				const name = inlineTableMatch[1];
				const tableContent = inlineTableMatch[2];
				const versionMatch = tableContent.match(/version\s*=\s*"([^"]+)"/);
				if (versionMatch) {
					deps.push({
						name,
						specified_version: versionMatch[1],
						is_outdated: false,
						is_vulnerable: false,
						vulnerability_ids: [],
					});
				}
			}
		}

		return deps;
	}

	/**
	 * Get installed versions from Cargo.lock
	 */
	getCargoLockVersions(workDir: string): Map<string, string> {
		const versions = new Map<string, string>();
		const lockPath = path.join(workDir, "Cargo.lock");

		if (!fs.existsSync(lockPath)) {
			return versions;
		}

		const content = fs.readFileSync(lockPath, "utf-8");

		// Parse [[package]] sections
		const packageMatches = content.matchAll(
			/\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"/g,
		);
		for (const match of packageMatches) {
			versions.set(match[1], match[2]);
		}

		return versions;
	}

	/**
	 * Extract Go dependencies from go.mod and go.sum
	 */
	extractGoDependencies(workDir: string): Dependency[] {
		const dependencies: Dependency[] = [];

		// Read go.mod
		const goModPath = path.join(workDir, "go.mod");
		if (!fs.existsSync(goModPath)) {
			return dependencies;
		}

		const content = fs.readFileSync(goModPath, "utf-8");

		// Get installed versions from go.sum
		const installedVersions = this.getGoSumVersions(workDir);

		// Parse require blocks
		const requireMatch = content.match(/require\s*\(([\s\S]*?)\)/);
		if (requireMatch) {
			const requireSection = requireMatch[1];
			const depMatches = requireSection.matchAll(/^\s*([^\s]+)\s+([^\s]+)/gm);
			for (const match of depMatches) {
				const name = match[1];
				const specifiedVersion = match[2];
				dependencies.push({
					name,
					specified_version: specifiedVersion,
					installed_version: installedVersions.get(name),
					is_dev: false,
					is_outdated: false,
					is_vulnerable: false,
					vulnerability_ids: [],
				});
			}
		}

		// Parse single-line require statements
		const singleRequires = content.matchAll(/^require\s+([^\s]+)\s+([^\s]+)/gm);
		for (const match of singleRequires) {
			const name = match[1];
			if (dependencies.some((d) => d.name === name)) {
				continue;
			}
			const specifiedVersion = match[2];
			dependencies.push({
				name,
				specified_version: specifiedVersion,
				installed_version: installedVersions.get(name),
				is_dev: false,
				is_outdated: false,
				is_vulnerable: false,
				vulnerability_ids: [],
			});
		}

		return dependencies;
	}

	/**
	 * Get installed versions from go.sum
	 */
	getGoSumVersions(workDir: string): Map<string, string> {
		const versions = new Map<string, string>();
		const sumPath = path.join(workDir, "go.sum");

		if (!fs.existsSync(sumPath)) {
			return versions;
		}

		const content = fs.readFileSync(sumPath, "utf-8");

		// Parse go.sum format: module version hash
		const lines = content.split("\n");
		for (const line of lines) {
			const match = line.match(/^([^\s]+)\s+([^\s]+)\s+/);
			if (match) {
				const name = match[1];
				let version = match[2];
				// Remove /go.mod suffix
				version = version.replace(/\/go\.mod$/, "");
				// Store first occurrence (without +incompatible suffix)
				if (!versions.has(name)) {
					versions.set(name, version);
				}
			}
		}

		return versions;
	}

	/**
	 * Check if a version is outdated based on version constraints
	 */
	isVersionOutdated(specifiedVersion: string, installedVersion?: string): boolean {
		if (!installedVersion) {
			return false;
		}

		// Clean version strings
		const cleanSpecified = specifiedVersion.replace(/^[\^~>=<]/, "");
		const cleanInstalled = installedVersion.replace(/^v/, "");

		// If specified uses ^ or ~, check major/minor versions
		if (specifiedVersion.startsWith("^")) {
			const specParts = cleanSpecified.split(".").map((p) => Number.parseInt(p, 10) || 0);
			const instParts = cleanInstalled.split(".").map((p) => Number.parseInt(p, 10) || 0);
			// With ^, major version should match
			return specParts[0] !== instParts[0];
		}

		if (specifiedVersion.startsWith("~")) {
			const specParts = cleanSpecified.split(".").map((p) => Number.parseInt(p, 10) || 0);
			const instParts = cleanInstalled.split(".").map((p) => Number.parseInt(p, 10) || 0);
			// With ~, major and minor should match
			return specParts[0] !== instParts[0] || specParts[1] !== instParts[1];
		}

		// For exact versions or ranges, just check if they differ significantly
		return false;
	}

	/**
	 * Check dependencies for known vulnerabilities
	 */
	checkVulnerabilities(dependencies: Dependency[]): {
		vulnerableCount: number;
		vulnerableDeps: Dependency[];
	} {
		const vulnerableDeps: Dependency[] = [];

		for (const dep of dependencies) {
			const version = dep.installed_version || dep.specified_version;
			const cleanVersion = version.replace(/^[\^~>=<v]/, "");

			for (const vuln of KNOWN_VULNERABLE_PATTERNS) {
				if (!vuln.name.test(dep.name)) {
					continue;
				}

				if (vuln.maxVersion && this.compareVersions(cleanVersion, vuln.maxVersion) <= 0) {
					dep.is_vulnerable = true;
					dep.vulnerability_severity = vuln.severity;
					if (vuln.cve) {
						dep.vulnerability_ids.push(vuln.cve);
					}
					vulnerableDeps.push(dep);
					break;
				}
			}
		}

		return {
			vulnerableCount: vulnerableDeps.length,
			vulnerableDeps,
		};
	}

	/**
	 * Compare two version strings
	 * Returns: -1 if v1 < v2, 0 if equal, 1 if v1 > v2
	 */
	compareVersions(v1: string, v2: string): number {
		const parts1 = v1.split(".").map((p) => Number.parseInt(p, 10) || 0);
		const parts2 = v2.split(".").map((p) => Number.parseInt(p, 10) || 0);

		const maxLen = Math.max(parts1.length, parts2.length);
		for (let i = 0; i < maxLen; i++) {
			const p1 = parts1[i] || 0;
			const p2 = parts2[i] || 0;
			if (p1 < p2) return -1;
			if (p1 > p2) return 1;
		}

		return 0;
	}

	/**
	 * Extract findings from the probe output
	 */
	extractFindings(output: DepsProbeOutput): ProbeFinding[] {
		const findings: ProbeFinding[] = [...output.issues];

		// Check for missing lockfile
		if (!output.lockfile && output.package_manager !== "other") {
			findings.push(
				createProbeFinding(
					"missing-lockfile",
					"Missing lockfile",
					`No lockfile found for ${output.package_manager}. Lockfiles ensure reproducible builds.`,
					"HIGH",
					{
						suggestion: "Run package manager install to generate a lockfile",
					},
				),
			);
		}

		// Check for no dependencies found
		if (output.total_count === 0) {
			findings.push(
				createProbeFinding(
					"no-dependencies",
					"No dependencies found",
					"No dependencies were found in the project manifest files.",
					"INFO",
					{
						suggestion: "Verify manifest file exists and is properly formatted",
					},
				),
			);
		}

		// Check for high vulnerable count
		if (output.vulnerable_count > 0) {
			findings.push(
				createProbeFinding(
					"vulnerable-dependencies",
					`${output.vulnerable_count} vulnerable dependencies`,
					`Found ${output.vulnerable_count} dependencies with known vulnerabilities. Run security audit.`,
					output.vulnerable_count >= 5 ? "CRITICAL" : "HIGH",
					{
						suggestion:
							"Run npm audit, yarn audit, or pip-audit to get detailed vulnerability info",
					},
				),
			);
		}

		// Check for many dev dependencies in production
		const prodDeps = output.dependencies.filter((d) => !d.is_dev);
		const devDeps = output.dependencies.filter((d) => d.is_dev);

		if (devDeps.length > prodDeps.length * 3 && devDeps.length > 20) {
			findings.push(
				createProbeFinding(
					"many-dev-dependencies",
					"Large number of dev dependencies",
					`Found ${devDeps.length} dev dependencies vs ${prodDeps.length} production dependencies. Review if all are needed.`,
					"LOW",
					{
						suggestion: "Review dev dependencies and remove unused ones",
					},
				),
			);
		}

		// Check for outdated dependencies
		if (output.outdated_count > 5) {
			findings.push(
				createProbeFinding(
					"outdated-dependencies",
					`${output.outdated_count} potentially outdated dependencies`,
					`Found ${output.outdated_count} dependencies that may be outdated based on version constraints.`,
					"MEDIUM",
					{
						suggestion:
							"Run npm outdated, yarn outdated, or pip list --outdated to check for updates",
					},
				),
			);
		}

		// Check for wildcard versions
		const wildcardDeps = output.dependencies.filter(
			(d) => d.specified_version === "*" || d.specified_version === "latest",
		);
		if (wildcardDeps.length > 0) {
			findings.push(
				createProbeFinding(
					"wildcard-versions",
					`${wildcardDeps.length} dependencies with wildcard versions`,
					`Dependencies with * or latest: ${wildcardDeps
						.slice(0, 5)
						.map((d) => d.name)
						.join(", ")}${wildcardDeps.length > 5 ? "..." : ""}`,
					"MEDIUM",
					{
						suggestion: "Pin dependencies to specific versions for reproducible builds",
					},
				),
			);
		}

		// Check for git dependencies (can be unstable)
		const gitDeps = output.dependencies.filter(
			(d) =>
				d.specified_version.includes("git") ||
				d.specified_version.includes("github") ||
				d.specified_version.startsWith("git+"),
		);
		if (gitDeps.length > 0) {
			findings.push(
				createProbeFinding(
					"git-dependencies",
					`${gitDeps.length} dependencies from git`,
					`Git dependencies: ${gitDeps.map((d) => d.name).join(", ")}. These can be unstable or unavailable.`,
					"MEDIUM",
					{
						suggestion: "Consider using published package versions instead of git references",
					},
				),
			);
		}

		return findings;
	}

	/**
	 * Format output for human-readable display
	 */
	formatOutput(output: DepsProbeOutput): string {
		const lines: string[] = [];

		lines.push("# Dependency Analysis");
		lines.push("");

		// Package manager info
		lines.push("## Package Manager");
		lines.push(`Type: ${output.package_manager}`);
		if (output.lockfile) {
			lines.push(`Lockfile: ${output.lockfile}`);
		} else {
			lines.push("Lockfile: Not found");
		}
		lines.push("");

		// Summary
		lines.push("## Summary");
		lines.push(`- Total dependencies: ${output.total_count}`);
		lines.push(`- Production: ${output.dependencies.filter((d) => !d.is_dev).length}`);
		lines.push(`- Development: ${output.dependencies.filter((d) => d.is_dev).length}`);
		lines.push(`- Outdated: ${output.outdated_count}`);
		lines.push(`- Vulnerable: ${output.vulnerable_count}`);
		lines.push("");

		// Vulnerable dependencies
		const vulnerableDeps = output.dependencies.filter((d) => d.is_vulnerable);
		if (vulnerableDeps.length > 0) {
			lines.push("## Vulnerable Dependencies");
			lines.push("| Package | Version | Severity | CVEs |");
			lines.push("|---------|---------|----------|------|");
			for (const dep of vulnerableDeps) {
				const version = dep.installed_version || dep.specified_version;
				const cves = dep.vulnerability_ids.join(", ");
				lines.push(`| ${dep.name} | ${version} | ${dep.vulnerability_severity} | ${cves} |`);
			}
			lines.push("");
		}

		// Top dependencies (production)
		const prodDeps = output.dependencies.filter((d) => !d.is_dev).slice(0, 20);
		if (prodDeps.length > 0) {
			lines.push("## Production Dependencies");
			lines.push("| Package | Specified | Installed |");
			lines.push("|---------|-----------|-----------|");
			for (const dep of prodDeps) {
				lines.push(`| ${dep.name} | ${dep.specified_version} | ${dep.installed_version || "-"} |`);
			}
			if (output.dependencies.filter((d) => !d.is_dev).length > 20) {
				lines.push(`| ... | ${output.dependencies.filter((d) => !d.is_dev).length - 20} more | |`);
			}
			lines.push("");
		}

		return lines.join("\n");
	}

	/**
	 * Parse raw output (for BaseProbe compatibility)
	 */
	parseOutput(rawOutput: string): DepsProbeOutput {
		try {
			const parsed = JSON.parse(rawOutput);
			return parsed as DepsProbeOutput;
		} catch {
			return {
				package_manager: "other",
				dependencies: [],
				total_count: 0,
				outdated_count: 0,
				vulnerable_count: 0,
				issues: [],
			};
		}
	}

	/**
	 * Allow continuation when commands fail
	 * We can still parse files without package manager
	 */
	protected shouldContinueOnFailure(_result: CommandResult): boolean {
		return true;
	}
}

/**
 * Create a Deps probe with optional configuration overrides
 */
export function createDepsProbe(configOverrides?: Partial<ProbeConfig>): DepsProbe {
	return new DepsProbe(configOverrides);
}

/**
 * Check if a directory has dependency configuration
 */
export function hasDependencyConfig(workDir: string): boolean {
	// Check for any manifest or lockfile
	const allFiles = [
		...PACKAGE_MANAGER_FILES.npm,
		...PACKAGE_MANAGER_FILES.yarn,
		...PACKAGE_MANAGER_FILES.pnpm,
		...PACKAGE_MANAGER_FILES.pip,
		...PACKAGE_MANAGER_FILES.poetry,
		...PACKAGE_MANAGER_FILES.cargo,
		...PACKAGE_MANAGER_FILES.go,
		...MANIFEST_FILES.npm,
		...MANIFEST_FILES.poetry,
		...MANIFEST_FILES.cargo,
		...MANIFEST_FILES.go,
	];

	for (const file of allFiles) {
		if (fs.existsSync(path.join(workDir, file))) {
			return true;
		}
	}

	return false;
}

/**
 * Detect package manager from a directory
 */
export function detectPackageManager(workDir: string): DepsProbeOutput["package_manager"] {
	const probe = new DepsProbe();
	return probe.detectPackageManager(workDir);
}

/**
 * Extract dependencies from a directory
 */
export function extractDependencies(workDir: string): Dependency[] {
	const probe = new DepsProbe();
	const packageManager = probe.detectPackageManager(workDir);
	return probe.extractDependencies(workDir, packageManager);
}

/**
 * Format deps probe output as markdown
 */
export function formatDepsOutputAsMarkdown(output: DepsProbeOutput): string {
	const probe = new DepsProbe();
	return probe.formatOutput(output);
}

/**
 * Check for dependency vulnerabilities
 */
export function checkDependencyVulnerabilities(dependencies: Dependency[]): {
	vulnerableCount: number;
	vulnerableDeps: Dependency[];
} {
	const probe = new DepsProbe();
	return probe.checkVulnerabilities(dependencies);
}

/**
 * Compare two semantic versions
 */
export function compareSemanticVersions(v1: string, v2: string): number {
	const probe = new DepsProbe();
	return probe.compareVersions(v1, v2);
}
