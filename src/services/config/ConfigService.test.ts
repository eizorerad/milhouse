/**
 * @fileoverview Unit Tests for ConfigService
 *
 * Tests the ConfigService class including the addRule immutability fix.
 *
 * @module services/config/ConfigService.test
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MilhouseConfig } from "../../domain/config/types.ts";
import { ConfigService, clearGlobalConfigCache, resetDefaultServices } from "./ConfigService.ts";
import type { ConfigLoadResult, ConfigSaveResult, ConfigStore } from "./types.ts";

/**
 * Mock ConfigStore for testing
 */
class MockConfigStore implements ConfigStore {
	private config: MilhouseConfig | null = null;
	private _exists = false;
	private readonly path: string;
	private readonly configDir: string;

	constructor(initialConfig?: MilhouseConfig) {
		this.config = initialConfig ?? null;
		this._exists = initialConfig !== undefined;
		this.path = "/mock/path/config.yaml";
		this.configDir = "/mock/path";
	}

	load(): ConfigLoadResult {
		if (!this.config) {
			return {
				success: false,
				error: { type: "not_found", path: this.path },
			};
		}
		// Return a copy to detect mutations
		return {
			success: true,
			value: JSON.parse(JSON.stringify(this.config)),
		};
	}

	save(config: MilhouseConfig): ConfigSaveResult {
		// Store a copy
		this.config = JSON.parse(JSON.stringify(config));
		this._exists = true;
		return { success: true, value: undefined };
	}

	exists(): boolean {
		return this._exists;
	}

	getPath(): string {
		return this.path;
	}

	getConfigDir(): string {
		return this.configDir;
	}

	/**
	 * Get the raw stored config for assertions
	 */
	getRawConfig(): MilhouseConfig | null {
		return this.config;
	}
}

/**
 * Create a minimal valid MilhouseConfig for testing
 */
function createTestConfig(overrides: Partial<MilhouseConfig> = {}): MilhouseConfig {
	return {
		version: "1.0",
		project: {
			name: "test-project",
			language: "TypeScript",
			framework: "",
			description: "",
		},
		commands: {
			test: "npm test",
			lint: "npm run lint",
			build: "npm run build",
			compile: "",
		},
		rules: [],
		boundaries: {
			never_touch: [],
		},
		allowed_commands: {
			probes: [],
			execution: [],
		},
		probes: {},
		execution: {
			mode: "branch",
			parallel: 4,
			auto_commit: true,
			create_pr: false,
			draft_pr: true,
		},
		gates: {
			evidence_required: true,
			diff_hygiene: true,
			placeholder_check: true,
			env_consistency: true,
			dod_verification: true,
		},
		...overrides,
	};
}

describe("ConfigService", () => {
	beforeEach(() => {
		clearGlobalConfigCache();
		resetDefaultServices();
	});

	afterEach(() => {
		clearGlobalConfigCache();
		resetDefaultServices();
	});

	describe("addRule", () => {
		test("adds a rule to the configuration", () => {
			const initialConfig = createTestConfig({ rules: ["existing rule"] });
			const store = new MockConfigStore(initialConfig);
			const service = new ConfigService({
				workDir: "/test",
				store,
				noCache: true,
			});

			const result = service.addRule("new rule");

			expect(result.success).toBe(true);
			const savedConfig = store.getRawConfig();
			expect(savedConfig?.rules).toEqual(["existing rule", "new rule"]);
		});

		test("does not mutate the original config object", () => {
			const initialConfig = createTestConfig({ rules: ["existing rule"] });
			const originalRules = [...initialConfig.rules];
			const store = new MockConfigStore(initialConfig);
			const service = new ConfigService({
				workDir: "/test",
				store,
				noCache: true,
			});

			service.addRule("new rule");

			// The original config's rules array should not be mutated
			// This verifies the immutability fix
			expect(originalRules).toEqual(["existing rule"]);
		});

		test("creates rules array if it does not exist", () => {
			const initialConfig = createTestConfig();
			// Explicitly set rules to undefined to simulate missing field
			(initialConfig as { rules?: string[] }).rules = undefined;
			const store = new MockConfigStore(initialConfig);
			const service = new ConfigService({
				workDir: "/test",
				store,
				noCache: true,
			});

			const result = service.addRule("first rule");

			expect(result.success).toBe(true);
			const savedConfig = store.getRawConfig();
			expect(savedConfig?.rules).toEqual(["first rule"]);
		});

		test("trims whitespace from rule", () => {
			const initialConfig = createTestConfig({ rules: [] });
			const store = new MockConfigStore(initialConfig);
			const service = new ConfigService({
				workDir: "/test",
				store,
				noCache: true,
			});

			service.addRule("  rule with spaces  ");

			const savedConfig = store.getRawConfig();
			expect(savedConfig?.rules).toEqual(["rule with spaces"]);
		});

		test("returns error for empty rule", () => {
			const initialConfig = createTestConfig({ rules: [] });
			const store = new MockConfigStore(initialConfig);
			const service = new ConfigService({
				workDir: "/test",
				store,
				noCache: true,
			});

			const result = service.addRule("");

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.type).toBe("invalid_rule");
			}
		});

		test("returns error for whitespace-only rule", () => {
			const initialConfig = createTestConfig({ rules: [] });
			const store = new MockConfigStore(initialConfig);
			const service = new ConfigService({
				workDir: "/test",
				store,
				noCache: true,
			});

			const result = service.addRule("   ");

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.type).toBe("invalid_rule");
			}
		});

		test("returns error when config does not exist", () => {
			const store = new MockConfigStore(); // No initial config
			const service = new ConfigService({
				workDir: "/test",
				store,
				noCache: true,
			});

			const result = service.addRule("new rule");

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.type).toBe("not_found");
			}
		});

		test("multiple addRule calls work correctly", () => {
			const initialConfig = createTestConfig({ rules: [] });
			const store = new MockConfigStore(initialConfig);
			const service = new ConfigService({
				workDir: "/test",
				store,
				noCache: true,
			});

			service.addRule("rule 1");
			service.addRule("rule 2");
			service.addRule("rule 3");

			const savedConfig = store.getRawConfig();
			expect(savedConfig?.rules).toEqual(["rule 1", "rule 2", "rule 3"]);
		});
	});

	describe("getConfig", () => {
		test("returns null when config does not exist", () => {
			const store = new MockConfigStore();
			const service = new ConfigService({
				workDir: "/test",
				store,
				noCache: true,
			});

			const result = service.getConfig();

			expect(result).toBeNull();
		});

		test("returns config when it exists", () => {
			const initialConfig = createTestConfig();
			const store = new MockConfigStore(initialConfig);
			const service = new ConfigService({
				workDir: "/test",
				store,
				noCache: true,
			});

			const result = service.getConfig();

			expect(result).not.toBeNull();
			expect(result?.project.name).toBe("test-project");
		});

		test("uses cache on subsequent calls", () => {
			const initialConfig = createTestConfig();
			const store = new MockConfigStore(initialConfig);
			let loadCount = 0;
			const originalLoad = store.load.bind(store);
			store.load = () => {
				loadCount++;
				return originalLoad();
			};

			const service = new ConfigService({
				workDir: "/test",
				store,
				noCache: false,
			});

			service.getConfig();
			service.getConfig();
			service.getConfig();

			expect(loadCount).toBe(1);
		});
	});

	describe("isInitialized", () => {
		test("returns false when config does not exist", () => {
			const store = new MockConfigStore();
			const service = new ConfigService({
				workDir: "/test",
				store,
			});

			expect(service.isInitialized()).toBe(false);
		});

		test("returns true when config exists", () => {
			const initialConfig = createTestConfig();
			const store = new MockConfigStore(initialConfig);
			const service = new ConfigService({
				workDir: "/test",
				store,
			});

			expect(service.isInitialized()).toBe(true);
		});
	});

	describe("updateConfig", () => {
		test("merges partial config with existing config", () => {
			const initialConfig = createTestConfig({
				project: {
					name: "original",
					language: "TypeScript",
					framework: "",
					description: "",
				},
			});
			const store = new MockConfigStore(initialConfig);
			const service = new ConfigService({
				workDir: "/test",
				store,
				noCache: true,
			});

			const result = service.updateConfig({
				project: {
					name: "updated",
					language: "TypeScript",
					framework: "React",
					description: "Updated description",
				},
			});

			expect(result.success).toBe(true);
			const savedConfig = store.getRawConfig();
			expect(savedConfig?.project.name).toBe("updated");
			expect(savedConfig?.project.framework).toBe("React");
		});
	});

	describe("clearCache", () => {
		test("forces reload on next getConfig call", () => {
			const initialConfig = createTestConfig();
			const store = new MockConfigStore(initialConfig);
			let loadCount = 0;
			const originalLoad = store.load.bind(store);
			store.load = () => {
				loadCount++;
				return originalLoad();
			};

			const service = new ConfigService({
				workDir: "/test",
				store,
				noCache: false,
			});

			service.getConfig();
			expect(loadCount).toBe(1);

			service.clearCache();
			service.getConfig();
			expect(loadCount).toBe(2);
		});
	});
});
