import * as fs from "node:fs";
import * as path from "node:path";
import { BaseProbe, type CommandResult } from "./base.ts";
import {
	type ProbeConfig,
	type ProbeFinding,
	type ProbeInput,
	type ProbeResult,
	type RedisKeyPattern,
	type RedisProbeOutput,
	createProbeFinding,
} from "./types.ts";

/**
 * Redis configuration file patterns
 */
const REDIS_CONFIG_PATTERNS: Record<string, string[]> = {
	docker: ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"],
	env: [".env", ".env.local", ".env.development", ".env.production"],
	config: ["redis.conf", "config/redis.conf"],
	kubernetes: ["k8s/redis.yaml", "kubernetes/redis.yaml", "deploy/redis.yaml"],
};

/**
 * Common Redis key prefix patterns by application type
 */
const COMMON_KEY_PATTERNS: Record<string, string[]> = {
	session: ["session:", "sess:", "sessions:"],
	cache: ["cache:", "cached:", "c:"],
	queue: ["queue:", "q:", "bull:", "bee:", "celery:"],
	ratelimit: ["ratelimit:", "rate:", "limit:", "throttle:"],
	lock: ["lock:", "locks:", "distributed_lock:"],
	pubsub: ["channel:", "pubsub:", "events:"],
	user: ["user:", "users:", "u:"],
	token: ["token:", "tokens:", "auth:", "jwt:"],
};

/**
 * Redis connection string patterns for environment variables
 * Only patterns that contain full connection URLs (not individual params like REDIS_HOST)
 */
const REDIS_URL_PATTERNS = [
	/REDIS_URL\s*=\s*["']?([^"'\n]+)["']?/,
	/REDIS_CONNECTION\s*=\s*["']?([^"'\n]+)["']?/,
	/CACHE_URL\s*=\s*["']?([^"'\n]+)["']?/,
];

/**
 * Raw Redis configuration data
 */
interface RawRedisConfig {
	host?: string;
	port?: number;
	database?: number;
	password?: string;
	maxMemory?: string;
	evictionPolicy?: string;
	persistence?: {
		rdb?: boolean;
		aof?: boolean;
	};
	cluster?: boolean;
	sentinel?: boolean;
}

/**
 * Redis TTL/Keyspace Inspector (CA - Cache Auditor)
 *
 * Analyzes Redis configurations and key patterns:
 * - Configuration files (docker-compose, env, redis.conf)
 * - Key prefix patterns from code analysis
 * - Connection settings from environment files
 * - Memory and eviction policy configuration
 *
 * Capabilities:
 * - Read configuration files from the repository
 * - Analyze code for Redis key patterns
 * - Parse environment variables for connection info
 * - Cannot connect to Redis or modify data
 *
 * Output:
 * - Key patterns found in codebase
 * - Connection configuration
 * - Memory/eviction settings
 * - Issues/findings for misconfigurations
 */
export class RedisProbe extends BaseProbe<RedisProbeOutput> {
	constructor(configOverrides?: Partial<ProbeConfig>) {
		super("redis", configOverrides);
	}

	/**
	 * Get commands to execute for Redis inspection
	 * These are informational commands only - no write operations
	 */
	protected getCommands(_input: ProbeInput): Array<{ command: string; args: string[] }> {
		// We primarily parse files directly, so no commands needed
		return [];
	}

	/**
	 * Override execute to handle file-based parsing
	 * Since redis probe primarily reads config/code files
	 */
	async execute(input: ProbeInput): Promise<ProbeResult> {
		const startTime = Date.now();

		// Validate input
		if (!this.validateInput(input)) {
			const duration = Date.now() - startTime;
			return {
				probe_id: `redis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				probe_type: "redis",
				success: false,
				error: "Invalid probe input: workDir is required",
				timestamp: new Date().toISOString(),
				read_only: true,
				duration_ms: duration,
				findings: [],
			};
		}

		try {
			// Extract connection info from environment/config files
			const connectionInfo = this.extractConnectionInfo(input.workDir);

			// Find key patterns from code analysis
			const keyPatterns = await this.analyzeKeyPatterns(input.workDir);

			// Extract memory/eviction configuration
			const { maxMemory, evictionPolicy } = this.extractMemoryConfig(input.workDir);

			// Count total keys found (estimated from patterns)
			const totalKeys = keyPatterns.reduce((sum, p) => sum + p.count, 0);

			// Build the output
			const output: RedisProbeOutput = {
				key_patterns: keyPatterns,
				total_keys: totalKeys,
				memory_used_bytes: undefined, // Cannot determine without Redis connection
				max_memory_bytes: this.parseMemoryString(maxMemory),
				eviction_policy: evictionPolicy,
				connection_info: connectionInfo,
				issues: [],
			};

			// Extract findings
			const findings = this.extractFindings(output);

			const duration = Date.now() - startTime;
			return {
				probe_id: `redis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				probe_type: "redis",
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
				probe_id: `redis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				probe_type: "redis",
				success: false,
				error: `Failed to analyze Redis configuration: ${errorMessage}`,
				timestamp: new Date().toISOString(),
				read_only: true,
				duration_ms: duration,
				findings: [],
			};
		}
	}

	/**
	 * Extract Redis connection info from environment files
	 */
	extractConnectionInfo(workDir: string): RedisProbeOutput["connection_info"] {
		const connectionInfo: RedisProbeOutput["connection_info"] = {};

		// Check environment files
		for (const envFile of REDIS_CONFIG_PATTERNS.env) {
			const envPath = path.join(workDir, envFile);
			if (fs.existsSync(envPath)) {
				const content = fs.readFileSync(envPath, "utf-8");
				const parsed = this.parseEnvConnectionString(content);
				if (parsed && parsed.host) {
					return parsed;
				}
			}
		}

		// Check docker-compose files
		for (const composeFile of REDIS_CONFIG_PATTERNS.docker) {
			const composePath = path.join(workDir, composeFile);
			if (fs.existsSync(composePath)) {
				const content = fs.readFileSync(composePath, "utf-8");
				const parsed = this.parseComposeRedisConfig(content);
				if (parsed && parsed.host) {
					return parsed;
				}
			}
		}

		return connectionInfo;
	}

	/**
	 * Parse Redis connection string from env file
	 */
	parseEnvConnectionString(content: string): RedisProbeOutput["connection_info"] {
		// Look for REDIS_URL or similar
		for (const pattern of REDIS_URL_PATTERNS) {
			const match = content.match(pattern);
			if (match) {
				const value = match[1];

				// Check for environment variable references first
				if (value.includes("${") || value.startsWith("$")) {
					return { host: "(from environment variable)" };
				}

				// Check if it's a full URL
				if (value.startsWith("redis://") || value.startsWith("rediss://")) {
					return this.parseRedisUrl(value);
				}

				// It might be just a host
				return { host: value };
			}
		}

		// Look for individual connection params
		const hostMatch = content.match(/REDIS_HOST\s*=\s*["']?([^"'\n]+)["']?/);
		const portMatch = content.match(/REDIS_PORT\s*=\s*["']?(\d+)["']?/);
		const dbMatch = content.match(/REDIS_DB\s*=\s*["']?(\d+)["']?/);

		if (hostMatch || portMatch || dbMatch) {
			// Check for environment variable references in individual params
			const host = hostMatch?.[1];
			if (host && (host.includes("${") || host.startsWith("$"))) {
				return { host: "(from environment variable)" };
			}

			return {
				host: host,
				port: portMatch ? Number.parseInt(portMatch[1], 10) : undefined,
				database: dbMatch ? Number.parseInt(dbMatch[1], 10) : undefined,
			};
		}

		return {};
	}

	/**
	 * Parse Redis URL
	 */
	parseRedisUrl(url: string): RedisProbeOutput["connection_info"] {
		try {
			// Handle template variables
			if (url.includes("${") || url.includes("$")) {
				return { host: "(from environment variable)" };
			}

			const parsed = new URL(url);
			return {
				host: parsed.hostname || undefined,
				port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
				database: parsed.pathname ? Number.parseInt(parsed.pathname.slice(1), 10) || 0 : undefined,
			};
		} catch {
			return {};
		}
	}

	/**
	 * Parse Redis config from docker-compose
	 */
	parseComposeRedisConfig(content: string): RedisProbeOutput["connection_info"] {
		// Look for redis service
		if (!content.includes("redis")) {
			return {};
		}

		// Extract port mapping
		const portMatch = content.match(/(\d+):6379/);
		const port = portMatch ? Number.parseInt(portMatch[1], 10) : 6379;

		return {
			host: "localhost",
			port,
			database: 0,
		};
	}

	/**
	 * Analyze key patterns from code files
	 */
	async analyzeKeyPatterns(workDir: string): Promise<RedisKeyPattern[]> {
		const patterns: Map<string, RedisKeyPattern> = new Map();

		// File extensions to search
		const extensions = [".ts", ".tsx", ".js", ".jsx", ".py", ".rb", ".go", ".java"];

		// Find all source files
		const sourceFiles = this.findSourceFiles(workDir, extensions);

		for (const filePath of sourceFiles) {
			const content = fs.readFileSync(filePath, "utf-8");
			const foundPatterns = this.extractKeyPatternsFromCode(content, filePath);

			for (const pattern of foundPatterns) {
				const existing = patterns.get(pattern.pattern);
				if (existing) {
					// Merge patterns
					const updatedPattern: RedisKeyPattern = {
						...existing,
						count: existing.count + pattern.count,
						sample_keys: [...existing.sample_keys, ...pattern.sample_keys].slice(0, 5),
					};
					patterns.set(pattern.pattern, updatedPattern);
				} else {
					patterns.set(pattern.pattern, pattern);
				}
			}
		}

		return Array.from(patterns.values());
	}

	/**
	 * Find source files recursively
	 */
	findSourceFiles(dir: string, extensions: string[]): string[] {
		const files: string[] = [];

		if (!fs.existsSync(dir)) {
			return files;
		}

		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);

			// Skip common directories
			if (
				entry.isDirectory() &&
				!["node_modules", ".git", "dist", "build", ".next", "coverage", "vendor"].includes(
					entry.name,
				)
			) {
				files.push(...this.findSourceFiles(fullPath, extensions));
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name);
				if (extensions.includes(ext)) {
					files.push(fullPath);
				}
			}
		}

		return files;
	}

	/**
	 * Extract Redis key patterns from code content
	 */
	extractKeyPatternsFromCode(content: string, filePath: string): RedisKeyPattern[] {
		const patterns: Map<string, RedisKeyPattern> = new Map();

		// Common Redis key patterns in code
		const keyPatternRegexes = [
			// JavaScript/TypeScript: redis.get('key:prefix'), redis.set('key:prefix:${id}')
			/(?:redis|client|cache)\s*\.\s*(?:get|set|del|exists|expire|hget|hset|lpush|rpush|sadd|zadd|incr|decr)\s*\(\s*['"`]([^'"`$]+)/gi,
			// Template literals: `user:${id}`
			/['"`]([a-z_]+:)[^'"`]*['"`]/gi,
			// Python: redis.get('key:prefix')
			/(?:redis|r|client|cache)\s*\.\s*(?:get|set|delete|exists|expire|hget|hset|lpush|rpush|sadd|zadd|incr|decr)\s*\(\s*['"]([^'"$]+)/gi,
			// Explicit key prefix definitions: const KEY_PREFIX = 'session:'
			/(?:KEY|PREFIX|CACHE_KEY|REDIS_KEY)\s*[=:]\s*['"`]([a-z_]+:)[^'"`]*['"`]/gi,
		];

		for (const regex of keyPatternRegexes) {
			const matches = content.matchAll(regex);
			for (const match of matches) {
				const key = match[1];
				if (!key || key.length < 2) continue;

				// Extract the prefix (everything before the first colon or the whole key)
				const colonIndex = key.indexOf(":");
				const prefix = colonIndex > 0 ? key.slice(0, colonIndex + 1) : key;

				// Normalize prefix
				const normalizedPrefix = prefix.toLowerCase();
				if (normalizedPrefix.length < 2) continue;

				const existing = patterns.get(normalizedPrefix);
				if (existing) {
					const updatedPattern: RedisKeyPattern = {
						...existing,
						count: existing.count + 1,
						sample_keys: existing.sample_keys.includes(key)
							? existing.sample_keys
							: [...existing.sample_keys, key].slice(0, 5),
					};
					patterns.set(normalizedPrefix, updatedPattern);
				} else {
					patterns.set(normalizedPrefix, {
						pattern: normalizedPrefix,
						count: 1,
						sample_keys: [key],
					});
				}
			}
		}

		return Array.from(patterns.values());
	}

	/**
	 * Extract memory configuration from redis.conf or docker-compose
	 */
	extractMemoryConfig(workDir: string): { maxMemory?: string; evictionPolicy?: string } {
		// Check redis.conf
		for (const configFile of REDIS_CONFIG_PATTERNS.config) {
			const configPath = path.join(workDir, configFile);
			if (fs.existsSync(configPath)) {
				const content = fs.readFileSync(configPath, "utf-8");
				return this.parseRedisConf(content);
			}
		}

		// Check docker-compose for command args
		for (const composeFile of REDIS_CONFIG_PATTERNS.docker) {
			const composePath = path.join(workDir, composeFile);
			if (fs.existsSync(composePath)) {
				const content = fs.readFileSync(composePath, "utf-8");
				const config = this.parseComposeRedisMemoryConfig(content);
				if (config.maxMemory || config.evictionPolicy) {
					return config;
				}
			}
		}

		return {};
	}

	/**
	 * Parse redis.conf for memory settings
	 */
	parseRedisConf(content: string): { maxMemory?: string; evictionPolicy?: string } {
		const maxMemoryMatch = content.match(/^maxmemory\s+(\S+)/m);
		const evictionMatch = content.match(/^maxmemory-policy\s+(\S+)/m);

		return {
			maxMemory: maxMemoryMatch?.[1],
			evictionPolicy: evictionMatch?.[1],
		};
	}

	/**
	 * Parse docker-compose for Redis memory config
	 */
	parseComposeRedisMemoryConfig(content: string): {
		maxMemory?: string;
		evictionPolicy?: string;
	} {
		// Look for redis command args
		const maxMemoryMatch = content.match(/--maxmemory\s+(\S+)/);
		const evictionMatch = content.match(/--maxmemory-policy\s+(\S+)/);

		return {
			maxMemory: maxMemoryMatch?.[1],
			evictionPolicy: evictionMatch?.[1],
		};
	}

	/**
	 * Parse memory string to bytes
	 */
	parseMemoryString(memoryStr?: string): number | undefined {
		if (!memoryStr) return undefined;

		const match = memoryStr.match(/^(\d+)([kmgKMG]?[bB]?)?$/);
		if (!match) return undefined;

		const value = Number.parseInt(match[1], 10);
		const unit = (match[2] || "").toLowerCase();

		switch (unit) {
			case "k":
			case "kb":
				return value * 1024;
			case "m":
			case "mb":
				return value * 1024 * 1024;
			case "g":
			case "gb":
				return value * 1024 * 1024 * 1024;
			default:
				return value;
		}
	}

	/**
	 * Extract findings from the probe output
	 */
	extractFindings(output: RedisProbeOutput): ProbeFinding[] {
		const findings: ProbeFinding[] = [...output.issues];

		// Check for missing eviction policy
		if (!output.eviction_policy) {
			findings.push(
				createProbeFinding(
					"no-eviction-policy",
					"No Redis eviction policy configured",
					"Without an eviction policy, Redis will reject writes when memory is full. Consider configuring a policy like 'allkeys-lru' or 'volatile-lru'.",
					"MEDIUM",
					{
						suggestion: "Set maxmemory-policy in redis.conf or via --maxmemory-policy flag",
					},
				),
			);
		}

		// Check for noeviction policy
		if (output.eviction_policy === "noeviction") {
			findings.push(
				createProbeFinding(
					"noeviction-policy",
					"Redis eviction policy set to noeviction",
					"The noeviction policy will cause Redis to return errors when memory limit is reached. This can cause application failures.",
					"HIGH",
					{
						suggestion: "Consider using 'allkeys-lru' or 'volatile-lru' for cache use cases",
					},
				),
			);
		}

		// Check for missing maxmemory
		if (!output.max_memory_bytes) {
			findings.push(
				createProbeFinding(
					"no-max-memory",
					"No Redis maxmemory limit configured",
					"Without a memory limit, Redis may consume all available memory and cause system instability.",
					"HIGH",
					{
						suggestion: "Set maxmemory in redis.conf or via --maxmemory flag (e.g., 256mb)",
					},
				),
			);
		}

		// Check for session keys without TTL indicators
		const sessionPatterns = output.key_patterns.filter(
			(p) =>
				p.pattern.includes("session") ||
				p.pattern.includes("sess") ||
				p.pattern.includes("auth") ||
				p.pattern.includes("token"),
		);

		if (sessionPatterns.length > 0) {
			findings.push(
				createProbeFinding(
					"session-keys-found",
					`Found ${sessionPatterns.length} session-related key pattern(s)`,
					`Session keys (${sessionPatterns.map((p) => p.pattern).join(", ")}) should have TTL set to prevent memory leaks and ensure session expiration.`,
					"INFO",
					{
						suggestion: "Ensure all session keys have appropriate TTL values set",
					},
				),
			);
		}

		// Check for cache keys
		const cachePatterns = output.key_patterns.filter(
			(p) => p.pattern.includes("cache") || p.pattern.includes("cached") || p.pattern === "c:",
		);

		if (cachePatterns.length > 0 && !output.eviction_policy) {
			findings.push(
				createProbeFinding(
					"cache-without-eviction",
					"Cache keys found without eviction policy",
					`Cache keys (${cachePatterns.map((p) => p.pattern).join(", ")}) were found but no eviction policy is configured. This can lead to memory issues.`,
					"MEDIUM",
					{
						suggestion: "Configure an LRU eviction policy for cache workloads",
					},
				),
			);
		}

		// Check for potential queue patterns
		const queuePatterns = output.key_patterns.filter(
			(p) =>
				p.pattern.includes("queue") ||
				p.pattern.includes("bull") ||
				p.pattern.includes("bee") ||
				p.pattern.includes("celery"),
		);

		if (queuePatterns.length > 0) {
			findings.push(
				createProbeFinding(
					"queue-keys-found",
					`Found ${queuePatterns.length} queue-related key pattern(s)`,
					`Queue keys (${queuePatterns.map((p) => p.pattern).join(", ")}) found. Ensure queue workers are properly configured to consume messages.`,
					"INFO",
					{
						suggestion: "Monitor queue lengths and configure dead letter queues",
					},
				),
			);
		}

		// Check for localhost connection in production risk
		if (output.connection_info?.host === "localhost") {
			findings.push(
				createProbeFinding(
					"localhost-connection",
					"Redis configured to connect to localhost",
					"The Redis connection is configured for localhost. Ensure this is appropriate for your deployment environment.",
					"INFO",
					{
						suggestion: "Use environment variables for Redis host configuration",
					},
				),
			);
		}

		// Check for default database 0
		if (output.connection_info?.database === 0 || output.connection_info?.database === undefined) {
			if (output.key_patterns.length > 5) {
				findings.push(
					createProbeFinding(
						"using-default-database",
						"Using Redis default database 0",
						"Multiple key patterns detected but using default database 0. Consider using different databases for different purposes (cache, sessions, queues).",
						"LOW",
						{
							suggestion:
								"Use separate Redis databases for different concerns (e.g., db=0 for cache, db=1 for sessions)",
						},
					),
				);
			}
		}

		// Check for rate limiting patterns
		const rateLimitPatterns = output.key_patterns.filter(
			(p) =>
				p.pattern.includes("rate") || p.pattern.includes("limit") || p.pattern.includes("throttle"),
		);

		if (rateLimitPatterns.length > 0) {
			findings.push(
				createProbeFinding(
					"ratelimit-keys-found",
					`Found ${rateLimitPatterns.length} rate limiting key pattern(s)`,
					`Rate limiting keys (${rateLimitPatterns.map((p) => p.pattern).join(", ")}) found. Ensure TTL is set appropriately for rate limit windows.`,
					"INFO",
					{
						suggestion:
							"Verify rate limit TTLs match your rate limiting window (e.g., 60s for per-minute limits)",
					},
				),
			);
		}

		return findings;
	}

	/**
	 * Format output for human-readable display
	 */
	formatOutput(output: RedisProbeOutput): string {
		const lines: string[] = [];

		lines.push("# Redis Cache Analysis");
		lines.push("");

		// Connection info
		if (output.connection_info?.host) {
			lines.push("## Connection");
			lines.push(`Host: ${output.connection_info.host}`);
			if (output.connection_info.port) {
				lines.push(`Port: ${output.connection_info.port}`);
			}
			if (output.connection_info.database !== undefined) {
				lines.push(`Database: ${output.connection_info.database}`);
			}
			lines.push("");
		}

		// Memory configuration
		lines.push("## Memory Configuration");
		if (output.max_memory_bytes) {
			lines.push(`Max Memory: ${this.formatBytes(output.max_memory_bytes)}`);
		} else {
			lines.push("Max Memory: Not configured");
		}
		if (output.eviction_policy) {
			lines.push(`Eviction Policy: ${output.eviction_policy}`);
		} else {
			lines.push("Eviction Policy: Not configured");
		}
		lines.push("");

		// Key patterns
		if (output.key_patterns.length > 0) {
			lines.push(`## Key Patterns (${output.key_patterns.length})`);
			lines.push("| Pattern | Count | Sample Keys |");
			lines.push("|---------|-------|-------------|");
			for (const pattern of output.key_patterns) {
				const samples = pattern.sample_keys.slice(0, 3).join(", ");
				lines.push(`| ${pattern.pattern} | ${pattern.count} | ${samples} |`);
			}
			lines.push("");

			// Categorize patterns
			const categories = this.categorizePatterns(output.key_patterns);
			if (Object.keys(categories).length > 0) {
				lines.push("### Pattern Categories");
				for (const [category, patterns] of Object.entries(categories)) {
					lines.push(`- **${category}**: ${patterns.join(", ")}`);
				}
				lines.push("");
			}
		} else {
			lines.push("## Key Patterns");
			lines.push("No key patterns found in codebase");
			lines.push("");
		}

		// Summary
		lines.push("## Summary");
		lines.push(`- Total key patterns: ${output.key_patterns.length}`);
		lines.push(`- Estimated key usages: ${output.total_keys}`);
		lines.push("");

		return lines.join("\n");
	}

	/**
	 * Categorize key patterns
	 */
	categorizePatterns(patterns: RedisKeyPattern[]): Record<string, string[]> {
		const categories: Record<string, string[]> = {};

		for (const pattern of patterns) {
			const patternLower = pattern.pattern.toLowerCase();

			for (const [category, prefixes] of Object.entries(COMMON_KEY_PATTERNS)) {
				// Check if pattern starts with or equals any of the category prefixes
				if (prefixes.some((prefix) => patternLower.startsWith(prefix.replace(":", "")))) {
					if (!categories[category]) {
						categories[category] = [];
					}
					categories[category].push(pattern.pattern);
					break;
				}
			}
		}

		return categories;
	}

	/**
	 * Format bytes to human-readable string
	 */
	formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes}B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
	}

	/**
	 * Parse raw output (for BaseProbe compatibility)
	 */
	parseOutput(rawOutput: string): RedisProbeOutput {
		try {
			const parsed = JSON.parse(rawOutput);
			return parsed as RedisProbeOutput;
		} catch {
			return {
				key_patterns: [],
				total_keys: 0,
				issues: [],
			};
		}
	}

	/**
	 * Allow continuation when commands fail
	 * We can still parse files without Redis connection
	 */
	protected shouldContinueOnFailure(_result: CommandResult): boolean {
		return true;
	}
}

/**
 * Create a Redis probe with optional configuration overrides
 */
export function createRedisProbe(configOverrides?: Partial<ProbeConfig>): RedisProbe {
	return new RedisProbe(configOverrides);
}

/**
 * Check if a directory has Redis configuration
 */
export function hasRedisConfig(workDir: string): boolean {
	// Check for Redis references in docker-compose
	for (const composeFile of REDIS_CONFIG_PATTERNS.docker) {
		const composePath = path.join(workDir, composeFile);
		if (fs.existsSync(composePath)) {
			const content = fs.readFileSync(composePath, "utf-8");
			if (content.includes("redis")) {
				return true;
			}
		}
	}

	// Check for Redis environment variables
	for (const envFile of REDIS_CONFIG_PATTERNS.env) {
		const envPath = path.join(workDir, envFile);
		if (fs.existsSync(envPath)) {
			const content = fs.readFileSync(envPath, "utf-8");
			if (content.includes("REDIS")) {
				return true;
			}
		}
	}

	// Check for redis.conf
	for (const configFile of REDIS_CONFIG_PATTERNS.config) {
		if (fs.existsSync(path.join(workDir, configFile))) {
			return true;
		}
	}

	return false;
}

/**
 * Extract Redis connection info from a directory
 */
export function extractRedisConnectionInfo(workDir: string): RedisProbeOutput["connection_info"] {
	const probe = new RedisProbe();
	return probe.extractConnectionInfo(workDir);
}

/**
 * Analyze Redis key patterns in a codebase
 */
export async function analyzeRedisKeyPatterns(workDir: string): Promise<RedisKeyPattern[]> {
	const probe = new RedisProbe();
	return probe.analyzeKeyPatterns(workDir);
}

/**
 * Format Redis probe output as markdown
 */
export function formatRedisOutputAsMarkdown(output: RedisProbeOutput): string {
	const probe = new RedisProbe();
	return probe.formatOutput(output);
}

/**
 * Get Redis memory configuration from a directory
 */
export function getRedisMemoryConfig(workDir: string): {
	maxMemory?: string;
	evictionPolicy?: string;
} {
	const probe = new RedisProbe();
	return probe.extractMemoryConfig(workDir);
}

/**
 * Categorize Redis key patterns by purpose
 */
export function categorizeKeyPatterns(patterns: RedisKeyPattern[]): Record<string, string[]> {
	const probe = new RedisProbe();
	return probe.categorizePatterns(patterns);
}

/**
 * Parse a Redis memory string to bytes
 */
export function parseRedisMemoryString(memoryStr: string): number | undefined {
	const probe = new RedisProbe();
	return probe.parseMemoryString(memoryStr);
}

/**
 * Check for common Redis misconfigurations
 */
export function checkRedisConfiguration(output: RedisProbeOutput): ProbeFinding[] {
	const probe = new RedisProbe();
	return probe.extractFindings(output);
}
