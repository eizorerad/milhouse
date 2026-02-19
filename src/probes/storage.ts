import * as fs from "node:fs";
import * as path from "node:path";
import { BaseProbe, type CommandResult } from "./base.ts";
import {
	type ProbeConfig,
	type ProbeFinding,
	type ProbeInput,
	type ProbeResult,
	type StorageBucket,
	type StorageProbeOutput,
	createProbeFinding,
} from "./types.ts";

/**
 * Storage configuration file patterns
 */
const STORAGE_CONFIG_PATTERNS: Record<string, string[]> = {
	docker: ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"],
	env: [".env", ".env.local", ".env.development", ".env.production"],
	aws: ["aws-config.json", ".aws/config", ".aws/credentials"],
	terraform: ["terraform.tfvars", "main.tf", "variables.tf"],
	kubernetes: [
		"k8s/storage.yaml",
		"kubernetes/storage.yaml",
		"deploy/storage.yaml",
		"k8s/pvc.yaml",
		"kubernetes/pvc.yaml",
	],
};

/**
 * Storage provider detection patterns
 */
const PROVIDER_PATTERNS: Record<StorageProbeOutput["provider"], RegExp[]> = {
	s3: [
		/AWS_ACCESS_KEY_ID/i,
		/AWS_SECRET_ACCESS_KEY/i,
		/AWS_BUCKET/i,
		/S3_BUCKET/i,
		/s3:\/\//i,
		/aws-sdk/i,
		/@aws-sdk\/client-s3/i,
	],
	minio: [/MINIO_/i, /minio/i, /MINIO_ENDPOINT/i, /MINIO_ACCESS_KEY/i],
	gcs: [
		/GOOGLE_APPLICATION_CREDENTIALS/i,
		/GCS_BUCKET/i,
		/GOOGLE_CLOUD_STORAGE/i,
		/@google-cloud\/storage/i,
		/gs:\/\//i,
	],
	azure: [
		/AZURE_STORAGE/i,
		/AZURE_BLOB/i,
		/wasb:\/\//i,
		/@azure\/storage-blob/i,
		/AZURE_STORAGE_CONNECTION_STRING/i,
	],
	local: [/STORAGE_PATH/i, /UPLOAD_DIR/i, /FILE_STORAGE_PATH/i, /LOCAL_STORAGE/i],
};

/**
 * Environment variable patterns for storage endpoints
 */
const STORAGE_ENV_PATTERNS = {
	s3: {
		endpoint: [
			/S3_ENDPOINT\s*=\s*["']?([^"'\n]+)["']?/,
			/AWS_S3_ENDPOINT\s*=\s*["']?([^"'\n]+)["']?/,
		],
		bucket: [
			/S3_BUCKET\s*=\s*["']?([^"'\n]+)["']?/,
			/AWS_S3_BUCKET\s*=\s*["']?([^"'\n]+)["']?/,
			/AWS_BUCKET\s*=\s*["']?([^"'\n]+)["']?/,
		],
		region: [
			/S3_REGION\s*=\s*["']?([^"'\n]+)["']?/,
			/AWS_REGION\s*=\s*["']?([^"'\n]+)["']?/,
			/AWS_DEFAULT_REGION\s*=\s*["']?([^"'\n]+)["']?/,
		],
	},
	minio: {
		endpoint: [/MINIO_ENDPOINT\s*=\s*["']?([^"'\n]+)["']?/, /MINIO_URL\s*=\s*["']?([^"'\n]+)["']?/],
		bucket: [/MINIO_BUCKET\s*=\s*["']?([^"'\n]+)["']?/],
	},
	gcs: {
		bucket: [
			/GCS_BUCKET\s*=\s*["']?([^"'\n]+)["']?/,
			/GOOGLE_CLOUD_STORAGE_BUCKET\s*=\s*["']?([^"'\n]+)["']?/,
		],
		project: [
			/GCS_PROJECT\s*=\s*["']?([^"'\n]+)["']?/,
			/GOOGLE_CLOUD_PROJECT\s*=\s*["']?([^"'\n]+)["']?/,
		],
	},
	azure: {
		account: [/AZURE_STORAGE_ACCOUNT\s*=\s*["']?([^"'\n]+)["']?/],
		container: [
			/AZURE_STORAGE_CONTAINER\s*=\s*["']?([^"'\n]+)["']?/,
			/AZURE_BLOB_CONTAINER\s*=\s*["']?([^"'\n]+)["']?/,
		],
	},
	local: {
		path: [
			/STORAGE_PATH\s*=\s*["']?([^"'\n]+)["']?/,
			/UPLOAD_DIR\s*=\s*["']?([^"'\n]+)["']?/,
			/FILE_STORAGE_PATH\s*=\s*["']?([^"'\n]+)["']?/,
			/LOCAL_STORAGE_PATH\s*=\s*["']?([^"'\n]+)["']?/,
		],
	},
};

/**
 * Common bucket naming patterns
 */
const BUCKET_NAMING_ISSUES: Array<{ pattern: RegExp; issue: string; severity: "HIGH" | "MEDIUM" }> =
	[
		{
			pattern: /^[0-9]/,
			issue: "Bucket name starts with a number (not recommended)",
			severity: "MEDIUM",
		},
		{
			pattern: /prod|production/i,
			issue: "Bucket name contains production reference (verify environment separation)",
			severity: "MEDIUM",
		},
		{
			pattern: /test|dev|staging/i,
			issue: "Bucket name suggests non-production environment",
			severity: "MEDIUM",
		},
	];

/**
 * Storage Inspector (SI - Storage Inspector)
 *
 * Analyzes storage configurations for S3, MinIO, GCS, Azure, and local storage:
 * - Configuration files (docker-compose, env, terraform)
 * - Storage SDK usage patterns in code
 * - Bucket/container configurations
 * - Permission and access patterns
 *
 * Capabilities:
 * - Read configuration files from the repository
 * - Analyze code for storage SDK usage patterns
 * - Parse environment variables for storage config
 * - Detect security misconfigurations
 * - Cannot connect to storage services or modify data
 *
 * Output:
 * - Storage provider detection
 * - Bucket configurations found
 * - Security findings and recommendations
 */
export class StorageProbe extends BaseProbe<StorageProbeOutput> {
	constructor(configOverrides?: Partial<ProbeConfig>) {
		super("storage", configOverrides);
	}

	/**
	 * Get commands to execute for storage inspection
	 * These are informational commands only - no write operations
	 */
	protected getCommands(_input: ProbeInput): Array<{ command: string; args: string[] }> {
		// We primarily parse files directly, so no commands needed
		return [];
	}

	/**
	 * Override execute to handle file-based parsing
	 * Since storage probe primarily reads config/code files
	 */
	async execute(input: ProbeInput): Promise<ProbeResult> {
		const startTime = Date.now();

		// Validate input
		if (!this.validateInput(input)) {
			const duration = Date.now() - startTime;
			return {
				probe_id: `storage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				probe_type: "storage",
				success: false,
				error: "Invalid probe input: workDir is required",
				timestamp: new Date().toISOString(),
				read_only: true,
				duration_ms: duration,
				findings: [],
			};
		}

		try {
			// Detect storage provider
			const provider = this.detectStorageProvider(input.workDir);

			// Extract bucket/container configurations
			const buckets = this.extractBuckets(input.workDir, provider);

			// Extract endpoint and region
			const { endpoint, region } = this.extractEndpointAndRegion(input.workDir, provider);

			// Build the output
			const output: StorageProbeOutput = {
				provider,
				buckets,
				endpoint,
				region,
				issues: [],
			};

			// Extract findings
			const findings = this.extractFindings(output);

			// Analyze code for additional security issues
			const codeFindings = await this.analyzeCodeForSecurityIssues(input.workDir);
			findings.push(...codeFindings);

			const duration = Date.now() - startTime;
			return {
				probe_id: `storage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				probe_type: "storage",
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
				probe_id: `storage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				probe_type: "storage",
				success: false,
				error: `Failed to analyze storage configuration: ${errorMessage}`,
				timestamp: new Date().toISOString(),
				read_only: true,
				duration_ms: duration,
				findings: [],
			};
		}
	}

	/**
	 * Detect the storage provider from configuration files
	 */
	detectStorageProvider(workDir: string): StorageProbeOutput["provider"] {
		// Check environment files first
		for (const envFile of STORAGE_CONFIG_PATTERNS.env) {
			const envPath = path.join(workDir, envFile);
			if (fs.existsSync(envPath)) {
				const content = fs.readFileSync(envPath, "utf-8");

				// Check for MinIO first (it's often used with S3-compatible API)
				if (PROVIDER_PATTERNS.minio.some((p) => p.test(content))) {
					return "minio";
				}
				if (PROVIDER_PATTERNS.s3.some((p) => p.test(content))) {
					return "s3";
				}
				if (PROVIDER_PATTERNS.gcs.some((p) => p.test(content))) {
					return "gcs";
				}
				if (PROVIDER_PATTERNS.azure.some((p) => p.test(content))) {
					return "azure";
				}
				if (PROVIDER_PATTERNS.local.some((p) => p.test(content))) {
					return "local";
				}
			}
		}

		// Check docker-compose for MinIO service
		for (const composeFile of STORAGE_CONFIG_PATTERNS.docker) {
			const composePath = path.join(workDir, composeFile);
			if (fs.existsSync(composePath)) {
				const content = fs.readFileSync(composePath, "utf-8");
				if (content.includes("minio/minio") || content.includes("minio:")) {
					return "minio";
				}
			}
		}

		// Check package.json for SDK dependencies
		const packageJsonPath = path.join(workDir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			const content = fs.readFileSync(packageJsonPath, "utf-8");
			if (content.includes("@aws-sdk/client-s3") || content.includes("aws-sdk")) {
				return "s3";
			}
			if (content.includes("@google-cloud/storage")) {
				return "gcs";
			}
			if (content.includes("@azure/storage-blob")) {
				return "azure";
			}
			if (content.includes("minio")) {
				return "minio";
			}
		}

		// Default to local if storage-related code exists but no cloud provider detected
		return "local";
	}

	/**
	 * Extract bucket configurations from environment files
	 */
	extractBuckets(workDir: string, provider: StorageProbeOutput["provider"]): StorageBucket[] {
		const buckets: StorageBucket[] = [];

		// Check environment files
		for (const envFile of STORAGE_CONFIG_PATTERNS.env) {
			const envPath = path.join(workDir, envFile);
			if (fs.existsSync(envPath)) {
				const content = fs.readFileSync(envPath, "utf-8");
				const extractedBuckets = this.extractBucketsFromEnv(content, provider);
				buckets.push(...extractedBuckets);
			}
		}

		// Check docker-compose for MinIO buckets
		if (provider === "minio") {
			for (const composeFile of STORAGE_CONFIG_PATTERNS.docker) {
				const composePath = path.join(workDir, composeFile);
				if (fs.existsSync(composePath)) {
					const content = fs.readFileSync(composePath, "utf-8");
					const composeBuckets = this.extractBucketsFromCompose(content);
					buckets.push(...composeBuckets);
				}
			}
		}

		// Remove duplicates by name
		const uniqueBuckets = buckets.reduce<StorageBucket[]>((acc, bucket) => {
			if (!acc.some((b) => b.name === bucket.name)) {
				acc.push(bucket);
			}
			return acc;
		}, []);

		return uniqueBuckets;
	}

	/**
	 * Extract buckets from environment file content
	 */
	extractBucketsFromEnv(
		content: string,
		provider: StorageProbeOutput["provider"],
	): StorageBucket[] {
		const buckets: StorageBucket[] = [];

		// Get bucket patterns for the provider
		const providerPatterns = STORAGE_ENV_PATTERNS[provider as keyof typeof STORAGE_ENV_PATTERNS];
		const patterns =
			providerPatterns && "bucket" in providerPatterns ? providerPatterns.bucket : [];

		for (const pattern of patterns) {
			const match = content.match(pattern);
			if (match?.[1]) {
				const bucketName = match[1];

				// Check for environment variable references
				if (bucketName.includes("${") || bucketName.startsWith("$")) {
					buckets.push({
						name: "(from environment variable)",
						public_access: false,
						versioning_enabled: false,
					});
				} else {
					// Extract region if available
					let region: string | undefined;
					const regionPatterns =
						providerPatterns && "region" in providerPatterns ? providerPatterns.region : [];
					for (const regionPattern of regionPatterns) {
						if ("test" in regionPattern) {
							const regionMatch = content.match(regionPattern);
							if (regionMatch?.[1]) {
								region = regionMatch[1];
								break;
							}
						}
					}

					buckets.push({
						name: bucketName,
						region,
						public_access: false,
						versioning_enabled: false,
					});
				}
			}
		}

		// Also check for multiple buckets in comma-separated values
		const multipleBucketMatch = content.match(
			/(?:S3_BUCKETS|STORAGE_BUCKETS)\s*=\s*["']?([^"'\n]+)["']?/,
		);
		if (multipleBucketMatch?.[1]) {
			const bucketNames = multipleBucketMatch[1].split(",").map((b) => b.trim());
			for (const name of bucketNames) {
				if (name && !buckets.some((b) => b.name === name)) {
					buckets.push({
						name,
						public_access: false,
						versioning_enabled: false,
					});
				}
			}
		}

		return buckets;
	}

	/**
	 * Extract MinIO buckets from docker-compose
	 */
	extractBucketsFromCompose(content: string): StorageBucket[] {
		const buckets: StorageBucket[] = [];

		// Look for MINIO_DEFAULT_BUCKETS environment variable
		const bucketMatch = content.match(/MINIO_DEFAULT_BUCKETS\s*[:=]\s*["']?([^"'\n]+)["']?/);
		if (bucketMatch?.[1]) {
			const bucketNames = bucketMatch[1].split(",").map((b) => b.trim());
			for (const name of bucketNames) {
				if (name) {
					buckets.push({
						name,
						public_access: false,
						versioning_enabled: false,
					});
				}
			}
		}

		return buckets;
	}

	/**
	 * Extract endpoint and region configuration
	 */
	extractEndpointAndRegion(
		workDir: string,
		provider: StorageProbeOutput["provider"],
	): { endpoint?: string; region?: string } {
		let endpoint: string | undefined;
		let region: string | undefined;

		// Check environment files
		for (const envFile of STORAGE_CONFIG_PATTERNS.env) {
			const envPath = path.join(workDir, envFile);
			if (fs.existsSync(envPath)) {
				const content = fs.readFileSync(envPath, "utf-8");

				// Get endpoint patterns for the provider
				const providerPatterns =
					STORAGE_ENV_PATTERNS[provider as keyof typeof STORAGE_ENV_PATTERNS];
				const endpointPatterns =
					providerPatterns && "endpoint" in providerPatterns ? providerPatterns.endpoint : [];
				for (const pattern of endpointPatterns) {
					const match = content.match(pattern);
					if (match?.[1] && !match[1].includes("${")) {
						endpoint = match[1];
						break;
					}
				}

				// Get region patterns
				const regionPatterns =
					providerPatterns && "region" in providerPatterns ? providerPatterns.region : [];
				for (const pattern of regionPatterns) {
					if ("test" in pattern) {
						const match = content.match(pattern);
						if (match?.[1] && !match[1].includes("${")) {
							region = match[1];
							break;
						}
					}
				}
			}
		}

		// Check docker-compose for MinIO endpoint
		if (provider === "minio" && !endpoint) {
			for (const composeFile of STORAGE_CONFIG_PATTERNS.docker) {
				const composePath = path.join(workDir, composeFile);
				if (fs.existsSync(composePath)) {
					const content = fs.readFileSync(composePath, "utf-8");
					const portMatch = content.match(/(\d+):9000/);
					if (portMatch) {
						endpoint = `http://localhost:${portMatch[1]}`;
					}
				}
			}
		}

		return { endpoint, region };
	}

	/**
	 * Analyze code for storage-related security issues
	 */
	async analyzeCodeForSecurityIssues(workDir: string): Promise<ProbeFinding[]> {
		const findings: ProbeFinding[] = [];
		const extensions = [".ts", ".tsx", ".js", ".jsx", ".py"];

		const sourceFiles = this.findSourceFiles(workDir, extensions);

		for (const filePath of sourceFiles) {
			const content = fs.readFileSync(filePath, "utf-8");
			const relativePath = path.relative(workDir, filePath);

			// Check for hardcoded credentials
			if (/AWS_ACCESS_KEY_ID\s*[:=]\s*["'][A-Z0-9]{20}["']/i.test(content)) {
				findings.push(
					createProbeFinding(
						"hardcoded-aws-key",
						"Hardcoded AWS access key detected",
						`Found hardcoded AWS access key in ${relativePath}. Use environment variables instead.`,
						"CRITICAL",
						{
							file: relativePath,
							suggestion: "Move AWS credentials to environment variables or AWS credentials file",
						},
					),
				);
			}

			if (/AWS_SECRET_ACCESS_KEY\s*[:=]\s*["'][A-Za-z0-9/+=]{40}["']/i.test(content)) {
				findings.push(
					createProbeFinding(
						"hardcoded-aws-secret",
						"Hardcoded AWS secret key detected",
						`Found hardcoded AWS secret key in ${relativePath}. This is a critical security risk.`,
						"CRITICAL",
						{
							file: relativePath,
							suggestion: "Remove hardcoded secret and use IAM roles or environment variables",
						},
					),
				);
			}

			// Check for public bucket ACL settings
			if (/ACL\s*[:=]\s*["']public-read["']/i.test(content)) {
				findings.push(
					createProbeFinding(
						"public-bucket-acl",
						"Public bucket ACL detected",
						`Found public-read ACL in ${relativePath}. This makes bucket contents publicly accessible.`,
						"HIGH",
						{
							file: relativePath,
							suggestion: "Use private ACL unless public access is explicitly required",
						},
					),
				);
			}

			if (/ACL\s*[:=]\s*["']public-read-write["']/i.test(content)) {
				findings.push(
					createProbeFinding(
						"public-write-acl",
						"Public write bucket ACL detected",
						`Found public-read-write ACL in ${relativePath}. This allows anyone to write to the bucket.`,
						"CRITICAL",
						{
							file: relativePath,
							suggestion: "Never use public-read-write ACL in production",
						},
					),
				);
			}

			// Check for disabled SSL
			if (
				/sslEnabled\s*[:=]\s*false/i.test(content) ||
				(/forcePathStyle\s*[:=]\s*true/i.test(content) && /http:\/\/(?!localhost)/i.test(content))
			) {
				findings.push(
					createProbeFinding(
						"storage-no-ssl",
						"Storage connection without SSL",
						`Found non-SSL storage connection in ${relativePath}.`,
						"HIGH",
						{
							file: relativePath,
							suggestion: "Enable SSL for storage connections in production",
						},
					),
				);
			}

			// Check for presigned URL with long expiration
			const presignedMatch = content.match(
				/(?:getSignedUrl|presignedUrl|generatePresignedUrl).*?(?:expires|expiresIn)\s*[:=]\s*(\d+)/i,
			);
			if (presignedMatch?.[1]) {
				const expirationSeconds = Number.parseInt(presignedMatch[1], 10);
				// If expiration is more than 24 hours (86400 seconds) or 7 days (604800)
				if (expirationSeconds > 604800) {
					findings.push(
						createProbeFinding(
							"long-presigned-url",
							"Presigned URL with long expiration",
							`Found presigned URL with ${Math.round(expirationSeconds / 86400)} day expiration in ${relativePath}.`,
							"MEDIUM",
							{
								file: relativePath,
								suggestion:
									"Use shorter expiration times for presigned URLs (typically under 1 hour)",
							},
						),
					);
				}
			}
		}

		return findings;
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
				![
					"node_modules",
					".git",
					"dist",
					"build",
					".next",
					"coverage",
					"vendor",
					"__pycache__",
				].includes(entry.name)
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
	 * Extract findings from the probe output
	 */
	extractFindings(output: StorageProbeOutput): ProbeFinding[] {
		const findings: ProbeFinding[] = [...output.issues];

		// Check for no storage configuration found
		if (output.provider === "local" && output.buckets.length === 0) {
			findings.push(
				createProbeFinding(
					"no-storage-config",
					"No cloud storage configuration found",
					"No S3, MinIO, GCS, or Azure storage configuration detected. Using local file storage.",
					"INFO",
					{
						suggestion: "Consider using cloud storage for better scalability and reliability",
					},
				),
			);
		}

		// Check bucket naming
		for (const bucket of output.buckets) {
			if (bucket.name === "(from environment variable)") {
				continue;
			}

			for (const issue of BUCKET_NAMING_ISSUES) {
				if (issue.pattern.test(bucket.name)) {
					findings.push(
						createProbeFinding(
							`bucket-naming-${bucket.name}`,
							`Bucket naming issue: ${bucket.name}`,
							issue.issue,
							issue.severity,
							{
								suggestion: "Review bucket naming conventions",
							},
						),
					);
				}
			}
		}

		// Check for public access enabled
		const publicBuckets = output.buckets.filter((b) => b.public_access);
		if (publicBuckets.length > 0) {
			findings.push(
				createProbeFinding(
					"public-buckets-detected",
					`${publicBuckets.length} public bucket(s) detected`,
					`Public buckets: ${publicBuckets.map((b) => b.name).join(", ")}. Verify this is intentional.`,
					"HIGH",
					{
						suggestion: "Review public access settings for each bucket",
					},
				),
			);
		}

		// Check for versioning
		const unversionedBuckets = output.buckets.filter(
			(b) => !b.versioning_enabled && b.name !== "(from environment variable)",
		);
		if (unversionedBuckets.length > 0 && output.provider !== "local") {
			findings.push(
				createProbeFinding(
					"versioning-not-enabled",
					"Bucket versioning not detected",
					`Versioning status unknown for: ${unversionedBuckets.map((b) => b.name).join(", ")}. Enable versioning for data protection.`,
					"MEDIUM",
					{
						suggestion:
							"Enable versioning on production buckets to protect against accidental deletion",
					},
				),
			);
		}

		// Check for local endpoint (likely development)
		if (output.endpoint && /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(output.endpoint)) {
			findings.push(
				createProbeFinding(
					"local-storage-endpoint",
					"Local storage endpoint configured",
					`Storage endpoint points to local address: ${output.endpoint}`,
					"INFO",
					{
						suggestion: "Ensure production deployments use proper cloud endpoints",
					},
				),
			);
		}

		// Check for MinIO without encryption config
		if (output.provider === "minio") {
			findings.push(
				createProbeFinding(
					"minio-detected",
					"MinIO storage detected",
					"MinIO is being used for object storage. Ensure encryption at rest is configured.",
					"INFO",
					{
						suggestion: "Configure MINIO_KMS_SECRET_KEY for server-side encryption",
					},
				),
			);
		}

		// Check for missing region with S3
		if (output.provider === "s3" && !output.region && output.buckets.length > 0) {
			findings.push(
				createProbeFinding(
					"missing-s3-region",
					"AWS region not configured",
					"S3 buckets found but AWS region is not explicitly configured.",
					"MEDIUM",
					{
						suggestion: "Set AWS_REGION or AWS_DEFAULT_REGION environment variable",
					},
				),
			);
		}

		return findings;
	}

	/**
	 * Format output for human-readable display
	 */
	formatOutput(output: StorageProbeOutput): string {
		const lines: string[] = [];

		lines.push("# Storage Analysis");
		lines.push("");

		// Provider info
		lines.push("## Storage Provider");
		lines.push(`Provider: ${output.provider.toUpperCase()}`);
		if (output.endpoint) {
			lines.push(`Endpoint: ${output.endpoint}`);
		}
		if (output.region) {
			lines.push(`Region: ${output.region}`);
		}
		lines.push("");

		// Buckets/Containers
		if (output.buckets.length > 0) {
			lines.push(`## Buckets/Containers (${output.buckets.length})`);
			lines.push("| Name | Region | Public | Versioning | Encryption |");
			lines.push("|------|--------|--------|------------|------------|");
			for (const bucket of output.buckets) {
				const publicStatus = bucket.public_access ? "Yes" : "No";
				const versioningStatus = bucket.versioning_enabled ? "Enabled" : "Unknown";
				const encryptionStatus = bucket.encryption || "Unknown";
				lines.push(
					`| ${bucket.name} | ${bucket.region || "-"} | ${publicStatus} | ${versioningStatus} | ${encryptionStatus} |`,
				);
			}
			lines.push("");
		} else {
			lines.push("## Buckets/Containers");
			lines.push("No buckets or containers found in configuration");
			lines.push("");
		}

		// Summary
		lines.push("## Summary");
		lines.push(`- Provider: ${output.provider}`);
		lines.push(`- Total buckets: ${output.buckets.length}`);
		if (output.endpoint) {
			lines.push("- Endpoint configured: Yes");
		}
		lines.push("");

		return lines.join("\n");
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
	parseOutput(rawOutput: string): StorageProbeOutput {
		try {
			const parsed = JSON.parse(rawOutput);
			return parsed as StorageProbeOutput;
		} catch {
			return {
				provider: "local",
				buckets: [],
				issues: [],
			};
		}
	}

	/**
	 * Allow continuation when commands fail
	 * We can still parse files without storage service connection
	 */
	protected shouldContinueOnFailure(_result: CommandResult): boolean {
		return true;
	}
}

/**
 * Create a Storage probe with optional configuration overrides
 */
export function createStorageProbe(configOverrides?: Partial<ProbeConfig>): StorageProbe {
	return new StorageProbe(configOverrides);
}

/**
 * Check if a directory has storage configuration
 */
export function hasStorageConfig(workDir: string): boolean {
	// Check for storage-related environment variables
	for (const envFile of STORAGE_CONFIG_PATTERNS.env) {
		const envPath = path.join(workDir, envFile);
		if (fs.existsSync(envPath)) {
			const content = fs.readFileSync(envPath, "utf-8");
			for (const patterns of Object.values(PROVIDER_PATTERNS)) {
				if (patterns.some((p) => p.test(content))) {
					return true;
				}
			}
		}
	}

	// Check for MinIO in docker-compose
	for (const composeFile of STORAGE_CONFIG_PATTERNS.docker) {
		const composePath = path.join(workDir, composeFile);
		if (fs.existsSync(composePath)) {
			const content = fs.readFileSync(composePath, "utf-8");
			if (content.includes("minio")) {
				return true;
			}
		}
	}

	// Check package.json for storage SDKs
	const packageJsonPath = path.join(workDir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const content = fs.readFileSync(packageJsonPath, "utf-8");
		if (
			content.includes("@aws-sdk/client-s3") ||
			content.includes("aws-sdk") ||
			content.includes("@google-cloud/storage") ||
			content.includes("@azure/storage-blob") ||
			content.includes("minio")
		) {
			return true;
		}
	}

	return false;
}

/**
 * Detect storage provider from a directory
 */
export function detectStorageProvider(workDir: string): StorageProbeOutput["provider"] {
	const probe = new StorageProbe();
	return probe.detectStorageProvider(workDir);
}

/**
 * Extract storage buckets from a directory
 */
export function extractStorageBuckets(workDir: string): StorageBucket[] {
	const probe = new StorageProbe();
	const provider = probe.detectStorageProvider(workDir);
	return probe.extractBuckets(workDir, provider);
}

/**
 * Format storage probe output as markdown
 */
export function formatStorageOutputAsMarkdown(output: StorageProbeOutput): string {
	const probe = new StorageProbe();
	return probe.formatOutput(output);
}

/**
 * Check for storage security issues
 */
export function checkStorageConfiguration(output: StorageProbeOutput): ProbeFinding[] {
	const probe = new StorageProbe();
	return probe.extractFindings(output);
}
