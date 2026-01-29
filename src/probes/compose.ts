import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { BaseProbe, type CommandResult } from "./base.ts";
import {
	type ComposeProbeOutput,
	type ComposeService,
	type ComposeTopology,
	type ProbeConfig,
	type ProbeFinding,
	type ProbeInput,
	type ProbeResult,
	createProbeFinding,
} from "./types.ts";

/**
 * Raw service from docker-compose.yml parsing
 */
interface RawComposeService {
	image?: string;
	build?: string | { context?: string; dockerfile?: string };
	ports?: Array<string | { target?: number; published?: number }>;
	volumes?: Array<string | { source?: string; target?: string }>;
	environment?: Record<string, string> | string[];
	depends_on?: string[] | Record<string, unknown>;
	networks?: string[] | Record<string, unknown>;
	healthcheck?: {
		test?: string | string[];
		interval?: string;
		timeout?: string;
		retries?: number;
	};
	[key: string]: unknown;
}

/**
 * Raw compose file structure
 */
interface RawComposeFile {
	version?: string;
	services?: Record<string, RawComposeService>;
	networks?: Record<string, unknown> | string[];
	volumes?: Record<string, unknown> | string[];
	[key: string]: unknown;
}

/**
 * Docker Compose Topology Inspector (ETI)
 *
 * Analyzes Docker Compose files to extract and validate:
 * - Services and their configurations
 * - Networks and their connectivity
 * - Volumes and mount points
 * - Service dependencies
 * - Health checks
 * - Port mappings
 * - Environment variables
 *
 * Capabilities:
 * - Read compose files from the repository
 * - Cannot write files or modify Docker state
 *
 * Output:
 * - Complete topology with services, networks, volumes
 * - Issues/findings for misconfigurations or concerns
 */
export class ComposeProbe extends BaseProbe<ComposeProbeOutput> {
	constructor(configOverrides?: Partial<ProbeConfig>) {
		super("compose", configOverrides);
	}

	/**
	 * Get commands to execute for topology inspection
	 * These commands gather information about Docker Compose setup
	 */
	protected getCommands(input: ProbeInput): Array<{ command: string; args: string[] }> {
		const commands: Array<{ command: string; args: string[] }> = [];

		// Check for compose files - use find-like approach
		// We don't actually need to execute commands since we parse files directly
		// But we can optionally check if docker-compose is available
		if (input.options?.checkDocker) {
			commands.push({
				command: "docker",
				args: ["compose", "version"],
			});
		}

		return commands;
	}

	/**
	 * Override execute to handle file-based parsing
	 * Since compose probe primarily reads YAML files rather than executing commands
	 */
	async execute(input: ProbeInput): Promise<ProbeResult> {
		const startTime = Date.now();

		// Validate input
		if (!this.validateInput(input)) {
			const duration = Date.now() - startTime;
			return {
				probe_id: `compose-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				probe_type: "compose",
				success: false,
				error: "Invalid probe input: workDir is required",
				timestamp: new Date().toISOString(),
				read_only: true,
				duration_ms: duration,
				findings: [],
			};
		}

		try {
			// Find compose files in the work directory
			const composeFiles = this.findComposeFiles(input.workDir, input.targets);

			if (composeFiles.length === 0) {
				const duration = Date.now() - startTime;
				return {
					probe_id: `compose-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					probe_type: "compose",
					success: true,
					output: "No Docker Compose files found",
					timestamp: new Date().toISOString(),
					read_only: true,
					duration_ms: duration,
					findings: [],
				};
			}

			// Parse all compose files
			const topology = this.parseComposeFiles(input.workDir, composeFiles);

			// Extract findings from the topology
			const findings = this.extractFindings(topology);

			const duration = Date.now() - startTime;
			return {
				probe_id: `compose-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				probe_type: "compose",
				success: true,
				output: this.formatOutput(topology),
				timestamp: new Date().toISOString(),
				read_only: true,
				duration_ms: duration,
				findings,
				raw_output: JSON.stringify(topology, null, 2),
			};
		} catch (error) {
			const duration = Date.now() - startTime;
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				probe_id: `compose-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				probe_type: "compose",
				success: false,
				error: `Failed to analyze compose files: ${errorMessage}`,
				timestamp: new Date().toISOString(),
				read_only: true,
				duration_ms: duration,
				findings: [],
			};
		}
	}

	/**
	 * Find Docker Compose files in the directory
	 */
	findComposeFiles(workDir: string, targets?: string[]): string[] {
		const composeFilePatterns = [
			"docker-compose.yml",
			"docker-compose.yaml",
			"compose.yml",
			"compose.yaml",
			"docker-compose.override.yml",
			"docker-compose.override.yaml",
			"docker-compose.dev.yml",
			"docker-compose.dev.yaml",
			"docker-compose.prod.yml",
			"docker-compose.prod.yaml",
			"docker-compose.test.yml",
			"docker-compose.test.yaml",
		];

		// If specific targets are provided, use those
		if (targets && targets.length > 0) {
			return targets.filter((target) => {
				const fullPath = path.isAbsolute(target) ? target : path.join(workDir, target);
				return fs.existsSync(fullPath);
			});
		}

		// Otherwise, search for common compose file patterns
		const foundFiles: string[] = [];
		for (const pattern of composeFilePatterns) {
			const fullPath = path.join(workDir, pattern);
			if (fs.existsSync(fullPath)) {
				foundFiles.push(pattern);
			}
		}

		return foundFiles;
	}

	/**
	 * Parse Docker Compose files and build topology
	 */
	parseComposeFiles(workDir: string, files: string[]): ComposeProbeOutput {
		const topology: ComposeTopology = {
			version: undefined,
			services: [],
			networks: [],
			volumes: [],
			config_files: [...files],
		};

		const allIssues: ProbeFinding[] = [];
		const serviceMap = new Map<string, ComposeService>();
		const networkSet = new Set<string>();
		const volumeSet = new Set<string>();

		for (const file of files) {
			const fullPath = path.isAbsolute(file) ? file : path.join(workDir, file);

			try {
				const content = fs.readFileSync(fullPath, "utf-8");
				const parsed = this.parseYaml(content);

				if (!parsed) {
					allIssues.push(
						createProbeFinding(
							`parse-error-${file}`,
							`Failed to parse ${file}`,
							`The compose file ${file} could not be parsed as valid YAML`,
							"HIGH",
							{ file },
						),
					);
					continue;
				}

				// Extract version
				if (parsed.version && !topology.version) {
					topology.version = String(parsed.version);
				}

				// Extract services
				if (parsed.services && typeof parsed.services === "object") {
					for (const [name, rawService] of Object.entries(parsed.services)) {
						const service = this.parseService(name, rawService as RawComposeService, file);
						serviceMap.set(name, service);
					}
				}

				// Extract networks
				if (parsed.networks) {
					const networks = this.extractNetworkNames(parsed.networks);
					for (const network of networks) {
						networkSet.add(network);
					}
				}

				// Extract volumes
				if (parsed.volumes) {
					const volumes = this.extractVolumeNames(parsed.volumes);
					for (const volume of volumes) {
						volumeSet.add(volume);
					}
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				allIssues.push(
					createProbeFinding(
						`read-error-${file}`,
						`Failed to read ${file}`,
						`Could not read compose file: ${errorMessage}`,
						"HIGH",
						{ file },
					),
				);
			}
		}

		topology.services = Array.from(serviceMap.values());
		topology.networks = Array.from(networkSet);
		topology.volumes = Array.from(volumeSet);

		return {
			topology,
			issues: allIssues,
		};
	}

	/**
	 * Parse a single service definition
	 */
	parseService(name: string, raw: RawComposeService, sourceFile: string): ComposeService {
		const service: ComposeService = {
			name,
			image: raw.image,
			ports: this.extractPorts(raw.ports),
			volumes: this.extractVolumes(raw.volumes),
			environment: this.extractEnvironment(raw.environment),
			depends_on: this.extractDependsOn(raw.depends_on),
			networks: this.extractServiceNetworks(raw.networks),
			healthcheck: raw.healthcheck
				? {
						test: Array.isArray(raw.healthcheck.test)
							? raw.healthcheck.test.join(" ")
							: raw.healthcheck.test,
						interval: raw.healthcheck.interval,
						timeout: raw.healthcheck.timeout,
						retries: raw.healthcheck.retries,
					}
				: undefined,
		};

		return service;
	}

	/**
	 * Extract port mappings from various formats
	 */
	extractPorts(ports?: RawComposeService["ports"]): string[] {
		if (!ports || !Array.isArray(ports)) {
			return [];
		}

		return ports.map((port) => {
			if (typeof port === "string") {
				return port;
			}
			if (typeof port === "object" && port !== null) {
				const target = port.target ?? "";
				const published = port.published ?? "";
				return `${published}:${target}`;
			}
			return String(port);
		});
	}

	/**
	 * Extract volume mounts from various formats
	 */
	extractVolumes(volumes?: RawComposeService["volumes"]): string[] {
		if (!volumes || !Array.isArray(volumes)) {
			return [];
		}

		return volumes.map((volume) => {
			if (typeof volume === "string") {
				return volume;
			}
			if (typeof volume === "object" && volume !== null) {
				const source = volume.source ?? "";
				const target = volume.target ?? "";
				return `${source}:${target}`;
			}
			return String(volume);
		});
	}

	/**
	 * Extract environment variables from various formats
	 */
	extractEnvironment(env?: RawComposeService["environment"]): Record<string, string> {
		if (!env) {
			return {};
		}

		if (Array.isArray(env)) {
			const result: Record<string, string> = {};
			for (const item of env) {
				const [key, ...valueParts] = item.split("=");
				result[key] = valueParts.join("=");
			}
			return result;
		}

		if (typeof env === "object") {
			const result: Record<string, string> = {};
			for (const [key, value] of Object.entries(env)) {
				result[key] = String(value ?? "");
			}
			return result;
		}

		return {};
	}

	/**
	 * Extract depends_on from various formats
	 */
	extractDependsOn(dependsOn?: RawComposeService["depends_on"]): string[] {
		if (!dependsOn) {
			return [];
		}

		if (Array.isArray(dependsOn)) {
			return dependsOn.filter((item) => typeof item === "string");
		}

		if (typeof dependsOn === "object") {
			return Object.keys(dependsOn);
		}

		return [];
	}

	/**
	 * Extract service networks from various formats
	 */
	extractServiceNetworks(networks?: RawComposeService["networks"]): string[] {
		if (!networks) {
			return [];
		}

		if (Array.isArray(networks)) {
			return networks.filter((item) => typeof item === "string");
		}

		if (typeof networks === "object") {
			return Object.keys(networks);
		}

		return [];
	}

	/**
	 * Extract network names from compose networks section
	 */
	extractNetworkNames(networks: unknown): string[] {
		if (Array.isArray(networks)) {
			return networks.filter((item) => typeof item === "string");
		}

		if (typeof networks === "object" && networks !== null) {
			return Object.keys(networks);
		}

		return [];
	}

	/**
	 * Extract volume names from compose volumes section
	 */
	extractVolumeNames(volumes: unknown): string[] {
		if (Array.isArray(volumes)) {
			return volumes.filter((item) => typeof item === "string");
		}

		if (typeof volumes === "object" && volumes !== null) {
			return Object.keys(volumes);
		}

		return [];
	}

	/**
	 * Simple YAML parser for compose files
	 * Handles basic compose file structure without external dependencies
	 */
	parseYaml(content: string): RawComposeFile | null {
		try {
			// Try to parse as JSON first (some compose files are JSON)
			return JSON.parse(content) as RawComposeFile;
		} catch {
			// Fall back to simple YAML parsing
		}

		try {
			return this.simpleYamlParse(content);
		} catch {
			return null;
		}
	}

	/**
	 * Simple YAML parser for basic compose structures
	 * This is a minimal implementation - for production use, a proper YAML library would be better
	 */
	simpleYamlParse(content: string): RawComposeFile {
		const lines = content.split("\n");
		const result: RawComposeFile = {};

		let currentSection: string | null = null;
		let currentService: string | null = null;
		let currentServiceData: RawComposeService = {};
		let currentKey: string | null = null;
		let currentArrayKey: string | null = null;
		const services: Record<string, RawComposeService> = {};
		const networks: string[] = [];
		const volumes: string[] = [];

		for (const rawLine of lines) {
			const line = rawLine;

			// Skip empty lines and comments
			if (line.trim() === "" || line.trim().startsWith("#")) {
				continue;
			}

			// Calculate indentation
			const indent = line.search(/\S/);
			const trimmed = line.trim();

			// Top-level keys (version, services, networks, volumes)
			if (indent === 0 && trimmed.endsWith(":")) {
				const key = trimmed.slice(0, -1);
				if (key === "services") {
					currentSection = "services";
				} else if (key === "networks") {
					currentSection = "networks";
				} else if (key === "volumes") {
					currentSection = "volumes";
				} else if (key === "version") {
					currentSection = "version";
				}
				currentService = null;
				currentKey = null;
				currentArrayKey = null;
				continue;
			}

			// Top-level value (for version)
			if (indent === 0 && trimmed.includes(":")) {
				const colonIdx = trimmed.indexOf(":");
				const key = trimmed.slice(0, colonIdx).trim();
				const value = trimmed
					.slice(colonIdx + 1)
					.trim()
					.replace(/^["']|["']$/g, "");
				if (key === "version") {
					result.version = value;
				}
				continue;
			}

			// Service name (indent 2)
			if (currentSection === "services" && indent === 2 && trimmed.endsWith(":")) {
				// Save previous service
				if (currentService && Object.keys(currentServiceData).length > 0) {
					services[currentService] = currentServiceData;
				}
				currentService = trimmed.slice(0, -1);
				currentServiceData = {};
				currentKey = null;
				currentArrayKey = null;
				continue;
			}

			// Service properties (indent 4)
			if (currentSection === "services" && currentService && indent === 4) {
				// Handle array items
				if (trimmed.startsWith("-")) {
					const value = trimmed
						.slice(1)
						.trim()
						.replace(/^["']|["']$/g, "");
					if (currentArrayKey && Array.isArray(currentServiceData[currentArrayKey])) {
						(currentServiceData[currentArrayKey] as string[]).push(value);
					}
					continue;
				}

				// Handle key: value pairs
				if (trimmed.includes(":")) {
					const colonIdx = trimmed.indexOf(":");
					const key = trimmed.slice(0, colonIdx).trim();
					const value = trimmed
						.slice(colonIdx + 1)
						.trim()
						.replace(/^["']|["']$/g, "");

					if (value === "") {
						// This key has nested content or is an array
						currentKey = key;
						currentArrayKey = key;
						if (
							key === "ports" ||
							key === "volumes" ||
							key === "depends_on" ||
							key === "networks"
						) {
							currentServiceData[key] = [];
						} else if (key === "environment") {
							currentServiceData[key] = {};
						}
					} else {
						currentServiceData[key] = value;
						currentKey = null;
						currentArrayKey = null;
					}
				}
				continue;
			}

			// Nested service properties (indent 6+)
			if (currentSection === "services" && currentService && indent >= 6) {
				if (trimmed.startsWith("-")) {
					const value = trimmed
						.slice(1)
						.trim()
						.replace(/^["']|["']$/g, "");
					if (currentArrayKey && Array.isArray(currentServiceData[currentArrayKey])) {
						(currentServiceData[currentArrayKey] as string[]).push(value);
					}
				} else if (trimmed.includes(":") && currentKey === "environment") {
					const colonIdx = trimmed.indexOf(":");
					const key = trimmed.slice(0, colonIdx).trim();
					const value = trimmed
						.slice(colonIdx + 1)
						.trim()
						.replace(/^["']|["']$/g, "");
					if (!currentServiceData.environment) {
						currentServiceData.environment = {};
					}
					(currentServiceData.environment as Record<string, string>)[key] = value;
				}
				continue;
			}

			// Network names (indent 2)
			if (currentSection === "networks" && indent === 2) {
				if (trimmed.endsWith(":")) {
					networks.push(trimmed.slice(0, -1));
				}
				continue;
			}

			// Volume names (indent 2)
			if (currentSection === "volumes" && indent === 2) {
				if (trimmed.endsWith(":")) {
					volumes.push(trimmed.slice(0, -1));
				}
			}
		}

		// Save last service
		if (currentService && Object.keys(currentServiceData).length > 0) {
			services[currentService] = currentServiceData;
		}

		if (Object.keys(services).length > 0) {
			result.services = services;
		}
		if (networks.length > 0) {
			result.networks = networks;
		}
		if (volumes.length > 0) {
			result.volumes = volumes;
		}

		return result;
	}

	/**
	 * Parse raw output (for BaseProbe compatibility)
	 */
	parseOutput(rawOutput: string): ComposeProbeOutput {
		try {
			const parsed = JSON.parse(rawOutput);
			return parsed as ComposeProbeOutput;
		} catch {
			return {
				topology: {
					services: [],
					networks: [],
					volumes: [],
					config_files: [],
				},
				issues: [],
			};
		}
	}

	/**
	 * Extract findings from the topology
	 */
	extractFindings(output: ComposeProbeOutput): ProbeResult["findings"] {
		const findings: ProbeFinding[] = [...output.issues];
		const topology = output.topology;

		// Check for services without health checks
		for (const service of topology.services) {
			if (!service.healthcheck) {
				findings.push(
					createProbeFinding(
						`no-healthcheck-${service.name}`,
						`Service '${service.name}' has no health check`,
						`The service '${service.name}' does not define a health check. Health checks help Docker determine when a container is ready to accept traffic.`,
						"LOW",
						{ suggestion: "Add a healthcheck configuration to the service" },
					),
				);
			}

			// Check for privileged ports
			for (const port of service.ports) {
				const portNum = Number.parseInt(port.split(":")[0], 10);
				if (!Number.isNaN(portNum) && portNum < 1024) {
					findings.push(
						createProbeFinding(
							`privileged-port-${service.name}-${portNum}`,
							`Service '${service.name}' uses privileged port ${portNum}`,
							`The service '${service.name}' binds to port ${portNum}, which is a privileged port requiring root access.`,
							"INFO",
						),
					);
				}
			}

			// Check for hardcoded secrets in environment
			for (const [key, value] of Object.entries(service.environment)) {
				const secretPatterns = ["PASSWORD", "SECRET", "KEY", "TOKEN", "CREDENTIAL"];
				const hasSecretKey = secretPatterns.some((p) => key.toUpperCase().includes(p));
				const hasLiteralValue = value && !value.startsWith("$") && value.length > 0;

				if (hasSecretKey && hasLiteralValue) {
					findings.push(
						createProbeFinding(
							`hardcoded-secret-${service.name}-${key}`,
							`Possible hardcoded secret in '${service.name}'`,
							`The environment variable '${key}' in service '${service.name}' appears to contain a hardcoded secret. Consider using Docker secrets or environment variable references.`,
							"HIGH",
							{ suggestion: "Use Docker secrets or ${VAR} syntax for sensitive values" },
						),
					);
				}
			}

			// Check for missing image/build
			if (!service.image && !("build" in service)) {
				findings.push(
					createProbeFinding(
						`no-image-${service.name}`,
						`Service '${service.name}' has no image or build`,
						`The service '${service.name}' does not specify an image or build configuration.`,
						"HIGH",
					),
				);
			}
		}

		// Check for circular dependencies
		const circularDeps = this.detectCircularDependencies(topology.services);
		for (const cycle of circularDeps) {
			findings.push(
				createProbeFinding(
					`circular-dep-${cycle.join("-")}`,
					"Circular dependency detected",
					`Services form a circular dependency: ${cycle.join(" -> ")}`,
					"CRITICAL",
					{ suggestion: "Refactor service dependencies to remove the cycle" },
				),
			);
		}

		// Check for undefined dependencies
		const serviceNames = new Set(topology.services.map((s) => s.name));
		for (const service of topology.services) {
			for (const dep of service.depends_on) {
				if (!serviceNames.has(dep)) {
					findings.push(
						createProbeFinding(
							`undefined-dep-${service.name}-${dep}`,
							`Undefined dependency in '${service.name}'`,
							`Service '${service.name}' depends on '${dep}', but no such service is defined.`,
							"CRITICAL",
						),
					);
				}
			}
		}

		// Check for undefined networks in services
		const networkNames = new Set(topology.networks);
		for (const service of topology.services) {
			for (const network of service.networks) {
				// Allow default network
				if (network !== "default" && !networkNames.has(network)) {
					findings.push(
						createProbeFinding(
							`undefined-network-${service.name}-${network}`,
							`Undefined network in '${service.name}'`,
							`Service '${service.name}' references network '${network}', but it is not defined in the networks section.`,
							"MEDIUM",
						),
					);
				}
			}
		}

		return findings;
	}

	/**
	 * Detect circular dependencies among services
	 */
	detectCircularDependencies(services: ComposeService[]): string[][] {
		const cycles: string[][] = [];
		const serviceMap = new Map<string, ComposeService>();

		for (const service of services) {
			serviceMap.set(service.name, service);
		}

		const visited = new Set<string>();
		const recursionStack = new Set<string>();

		const dfs = (serviceName: string, path: string[]): void => {
			if (recursionStack.has(serviceName)) {
				// Found a cycle
				const cycleStart = path.indexOf(serviceName);
				if (cycleStart !== -1) {
					cycles.push([...path.slice(cycleStart), serviceName]);
				}
				return;
			}

			if (visited.has(serviceName)) {
				return;
			}

			visited.add(serviceName);
			recursionStack.add(serviceName);

			const service = serviceMap.get(serviceName);
			if (service) {
				for (const dep of service.depends_on) {
					dfs(dep, [...path, serviceName]);
				}
			}

			recursionStack.delete(serviceName);
		};

		for (const service of services) {
			visited.clear();
			recursionStack.clear();
			dfs(service.name, []);
		}

		// Deduplicate cycles (same cycle can be found from different starting points)
		const uniqueCycles: string[][] = [];
		const cycleKeys = new Set<string>();

		for (const cycle of cycles) {
			// Normalize cycle by rotating to start with smallest element
			const minIdx = cycle.indexOf(cycle.reduce((min, current) => (current < min ? current : min)));
			const normalized = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
			const key = normalized.join(",");

			if (!cycleKeys.has(key)) {
				cycleKeys.add(key);
				uniqueCycles.push(cycle);
			}
		}

		return uniqueCycles;
	}

	/**
	 * Format output for human-readable display
	 */
	formatOutput(output: ComposeProbeOutput): string {
		const lines: string[] = [];
		const topology = output.topology;

		lines.push("# Docker Compose Topology");
		lines.push("");

		if (topology.version) {
			lines.push(`Version: ${topology.version}`);
		}

		lines.push(`Config files: ${topology.config_files.join(", ")}`);
		lines.push("");

		lines.push(`## Services (${topology.services.length})`);
		for (const service of topology.services) {
			lines.push(`- ${service.name}`);
			if (service.image) {
				lines.push(`  Image: ${service.image}`);
			}
			if (service.ports.length > 0) {
				lines.push(`  Ports: ${service.ports.join(", ")}`);
			}
			if (service.depends_on.length > 0) {
				lines.push(`  Depends on: ${service.depends_on.join(", ")}`);
			}
			if (service.networks.length > 0) {
				lines.push(`  Networks: ${service.networks.join(", ")}`);
			}
		}

		if (topology.networks.length > 0) {
			lines.push("");
			lines.push(`## Networks (${topology.networks.length})`);
			for (const network of topology.networks) {
				lines.push(`- ${network}`);
			}
		}

		if (topology.volumes.length > 0) {
			lines.push("");
			lines.push(`## Volumes (${topology.volumes.length})`);
			for (const volume of topology.volumes) {
				lines.push(`- ${volume}`);
			}
		}

		if (output.issues.length > 0) {
			lines.push("");
			lines.push(`## Issues (${output.issues.length})`);
			for (const issue of output.issues) {
				lines.push(`- [${issue.severity}] ${issue.title}`);
				lines.push(`  ${issue.description}`);
			}
		}

		return lines.join("\n");
	}

	/**
	 * Allow continuation when docker version check fails
	 * We can still parse compose files without docker installed
	 */
	protected shouldContinueOnFailure(result: CommandResult): boolean {
		// Continue even if docker version check fails
		return true;
	}
}

/**
 * Create a Compose probe with optional configuration overrides
 */
export function createComposeProbe(configOverrides?: Partial<ProbeConfig>): ComposeProbe {
	return new ComposeProbe(configOverrides);
}

/**
 * Parse a Docker Compose file and return the topology
 */
export function parseComposeFile(filePath: string): ComposeProbeOutput {
	const probe = new ComposeProbe();
	const workDir = path.dirname(filePath);
	const fileName = path.basename(filePath);
	return probe.parseComposeFiles(workDir, [fileName]);
}

/**
 * Find all Docker Compose files in a directory
 */
export function findComposeFiles(workDir: string): string[] {
	const probe = new ComposeProbe();
	return probe.findComposeFiles(workDir);
}

/**
 * Analyze a compose topology for issues
 */
export function analyzeComposeTopology(topology: ComposeTopology): ProbeFinding[] {
	const probe = new ComposeProbe();
	const output: ComposeProbeOutput = { topology, issues: [] };
	return probe.extractFindings(output);
}

/**
 * Check if a directory has Docker Compose files
 */
export function hasComposeFiles(workDir: string): boolean {
	const files = findComposeFiles(workDir);
	return files.length > 0;
}

/**
 * Get service names from a compose file
 */
export function getServiceNames(filePath: string): string[] {
	const output = parseComposeFile(filePath);
	return output.topology.services.map((s) => s.name);
}

/**
 * Get service dependencies as a map
 */
export function getServiceDependencies(topology: ComposeTopology): Map<string, string[]> {
	const deps = new Map<string, string[]>();
	for (const service of topology.services) {
		deps.set(service.name, [...service.depends_on]);
	}
	return deps;
}

/**
 * Check for circular dependencies in a topology
 */
export function hasCircularDependencies(topology: ComposeTopology): boolean {
	const probe = new ComposeProbe();
	const cycles = probe.detectCircularDependencies(topology.services);
	return cycles.length > 0;
}

/**
 * Get all network names used by services
 */
export function getUsedNetworks(topology: ComposeTopology): string[] {
	const networks = new Set<string>();
	for (const service of topology.services) {
		for (const network of service.networks) {
			networks.add(network);
		}
	}
	return Array.from(networks);
}

/**
 * Get all volume names used by services
 */
export function getUsedVolumes(topology: ComposeTopology): string[] {
	const volumes = new Set<string>();
	for (const service of topology.services) {
		for (const volume of service.volumes) {
			// Extract named volume (before the first colon, if not a path)
			const parts = volume.split(":");
			if (parts.length > 0 && !parts[0].startsWith("/") && !parts[0].startsWith(".")) {
				volumes.add(parts[0]);
			}
		}
	}
	return Array.from(volumes);
}

/**
 * Format topology as markdown
 */
export function formatTopologyAsMarkdown(topology: ComposeTopology): string {
	const probe = new ComposeProbe();
	return probe.formatOutput({ topology, issues: [] });
}
