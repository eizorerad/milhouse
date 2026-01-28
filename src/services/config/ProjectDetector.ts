/**
 * @fileoverview Project Detector Service
 *
 * Automatically detects project settings from the codebase to provide
 * intelligent defaults for Milhouse configuration. Supports multiple
 * languages and frameworks.
 *
 * @module services/config/ProjectDetector
 * @since 5.0.0
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DetectedProject } from "../../domain/config/types.ts";
import type { IProjectDetector } from "./types.ts";

/**
 * Detection configuration constants
 *
 * These constants define the detection behavior and supported
 * project types for Milhouse.
 */
export const DETECTION_CONFIG = {
	/** Supported languages */
	languages: ["TypeScript", "JavaScript", "Python", "Go", "Rust"] as const,
	/** Default test commands by runtime */
	defaultTestCommands: {
		node: "npm test",
		bun: "bun test",
		python: "pytest",
		go: "go test ./...",
		rust: "cargo test",
	},
	/** Default lint commands by runtime */
	defaultLintCommands: {
		node: "npm run lint",
		python: "ruff check .",
		go: "golangci-lint run",
		rust: "cargo clippy",
	},
} as const;

/**
 * Framework detection pattern
 */
interface FrameworkPattern {
	name: string;
	packages: string[];
}

/**
 * Node.js framework detection patterns
 */
const NODE_FRAMEWORKS: FrameworkPattern[] = [
	{ name: "Next.js", packages: ["next"] },
	{ name: "Nuxt", packages: ["nuxt"] },
	{ name: "Remix", packages: ["@remix-run/react"] },
	{ name: "Svelte", packages: ["svelte"] },
	{ name: "NestJS", packages: ["@nestjs/"] },
	{ name: "Hono", packages: ["hono"] },
	{ name: "Fastify", packages: ["fastify"] },
	{ name: "Express", packages: ["express"] },
	{ name: "React", packages: ["react"] },
	{ name: "Vue", packages: ["vue"] },
];

/**
 * Python framework detection patterns
 */
const PYTHON_FRAMEWORKS: FrameworkPattern[] = [
	{ name: "FastAPI", packages: ["fastapi"] },
	{ name: "Django", packages: ["django"] },
	{ name: "Flask", packages: ["flask"] },
];

/**
 * Project detector class
 *
 * Analyzes the project directory to determine the language, framework,
 * and appropriate commands for testing, linting, and building.
 */
export class ProjectDetector implements IProjectDetector {
	/**
	 * Detect project settings from the codebase
	 *
	 * @param workDir - Working directory to analyze (defaults to cwd)
	 * @returns Detected project information
	 */
	detectProject(workDir = process.cwd()): DetectedProject {
		const result: DetectedProject = {
			name: basename(workDir),
			language: "",
			framework: "",
			testCmd: "",
			lintCmd: "",
			buildCmd: "",
		};

		// Check for package.json (Node.js/JavaScript/TypeScript)
		const packageJsonPath = join(workDir, "package.json");
		if (existsSync(packageJsonPath)) {
			this.detectNodeProject(packageJsonPath, result);
			return result;
		}

		// Check for Python projects
		const pyprojectPath = join(workDir, "pyproject.toml");
		const requirementsPath = join(workDir, "requirements.txt");
		const setupPyPath = join(workDir, "setup.py");
		if (existsSync(pyprojectPath) || existsSync(requirementsPath) || existsSync(setupPyPath)) {
			this.detectPythonProject(workDir, result);
			return result;
		}

		// Check for Go projects
		const goModPath = join(workDir, "go.mod");
		if (existsSync(goModPath)) {
			this.detectGoProject(result);
			return result;
		}

		// Check for Rust projects
		const cargoPath = join(workDir, "Cargo.toml");
		if (existsSync(cargoPath)) {
			this.detectRustProject(result);
			return result;
		}

		return result;
	}

	/**
	 * Detect Node.js/TypeScript/JavaScript project settings
	 */
	private detectNodeProject(packageJsonPath: string, result: DetectedProject): void {
		try {
			const content = readFileSync(packageJsonPath, "utf-8");
			const pkg = JSON.parse(content);

			// Get name from package.json
			if (pkg.name) {
				result.name = pkg.name;
			}

			// Detect TypeScript
			const projectDir = dirname(packageJsonPath);
			const tsconfigPath = join(projectDir, "tsconfig.json");
			result.language = existsSync(tsconfigPath) ? "TypeScript" : "JavaScript";

			// Get all dependencies
			const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
			const depNames = Object.keys(deps);

			// Detect frameworks using pattern matching
			const frameworks = this.detectNodeFrameworks(depNames);
			result.framework = frameworks.join(", ");

			// Detect commands from scripts
			const scripts = pkg.scripts || {};
			const hasBunLock = existsSync(join(projectDir, "bun.lockb"));

			if (scripts.test) {
				result.testCmd = hasBunLock
					? DETECTION_CONFIG.defaultTestCommands.bun
					: DETECTION_CONFIG.defaultTestCommands.node;
			}
			if (scripts.lint) {
				result.lintCmd = DETECTION_CONFIG.defaultLintCommands.node;
			}
			if (scripts.build) {
				result.buildCmd = "npm run build";
			}
		} catch {
			// Ignore parsing errors - return partial result
		}
	}

	/**
	 * Detect Node.js frameworks from dependencies
	 */
	private detectNodeFrameworks(depNames: string[]): string[] {
		const frameworks: string[] = [];
		const metaFrameworks = ["Next.js", "Nuxt", "Remix", "Svelte"];

		for (const pattern of NODE_FRAMEWORKS) {
			const isMatch = pattern.packages.some((pkg) =>
				depNames.some((dep) => (pkg.endsWith("/") ? dep.startsWith(pkg) : dep === pkg)),
			);

			if (isMatch) {
				// Only add React/Vue if no meta-framework detected
				if (["React", "Vue"].includes(pattern.name)) {
					if (frameworks.some((f) => metaFrameworks.includes(f))) {
						continue;
					}
				}
				frameworks.push(pattern.name);
			}
		}

		return frameworks;
	}

	/**
	 * Detect Python project settings
	 */
	private detectPythonProject(workDir: string, result: DetectedProject): void {
		result.language = "Python";

		// Read dependencies to detect frameworks
		let deps = "";
		const pyprojectPath = join(workDir, "pyproject.toml");
		const requirementsPath = join(workDir, "requirements.txt");

		if (existsSync(pyprojectPath)) {
			deps += readFileSync(pyprojectPath, "utf-8");
		}
		if (existsSync(requirementsPath)) {
			deps += readFileSync(requirementsPath, "utf-8");
		}

		const depsLower = deps.toLowerCase();
		const frameworks: string[] = [];

		for (const pattern of PYTHON_FRAMEWORKS) {
			if (pattern.packages.some((pkg) => depsLower.includes(pkg))) {
				frameworks.push(pattern.name);
			}
		}

		result.framework = frameworks.join(", ");
		result.testCmd = DETECTION_CONFIG.defaultTestCommands.python;
		result.lintCmd = DETECTION_CONFIG.defaultLintCommands.python;
	}

	/**
	 * Detect Go project settings
	 */
	private detectGoProject(result: DetectedProject): void {
		result.language = "Go";
		result.testCmd = DETECTION_CONFIG.defaultTestCommands.go;
		result.lintCmd = DETECTION_CONFIG.defaultLintCommands.go;
	}

	/**
	 * Detect Rust project settings
	 */
	private detectRustProject(result: DetectedProject): void {
		result.language = "Rust";
		result.testCmd = DETECTION_CONFIG.defaultTestCommands.rust;
		result.lintCmd = DETECTION_CONFIG.defaultLintCommands.rust;
		result.buildCmd = "cargo build";
	}
}

/**
 * Create a new project detector
 *
 * @returns New project detector instance
 */
export function createProjectDetector(): ProjectDetector {
	return new ProjectDetector();
}

/**
 * Detect project settings (convenience function)
 *
 * @param workDir - Working directory to analyze
 * @returns Detected project information
 */
export function detectProject(workDir?: string): DetectedProject {
	const detector = new ProjectDetector();
	return detector.detectProject(workDir);
}
