/**
 * Compose Probe Tests
 *
 * Tests for Docker Compose YAML parsing functionality.
 */

import { describe, expect, test } from "bun:test";
import { ComposeProbe } from "./compose.ts";

describe("Compose Probe YAML Parsing", () => {
	const probe = new ComposeProbe();

	describe("basic YAML parsing", () => {
		test("should parse basic key-value pairs", () => {
			const yaml = `version: '3.8'`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.version).toBe("3.8");
		});

		test("should parse simple services structure", () => {
			const yaml = `
version: '3.8'
services:
  app:
    image: node:18
    ports:
      - "3000:3000"
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services).toBeDefined();
			expect(result?.services?.app).toBeDefined();
			expect(result?.services?.app.image).toBe("node:18");
			expect(result?.services?.app.ports).toEqual(["3000:3000"]);
		});

		test("should parse version field correctly", () => {
			const yaml = `version: "3"`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.version).toBe("3");
		});

		test("should handle JSON fallback for JSON compose files", () => {
			const json = `{"version": "3.8", "services": {"app": {"image": "node:18"}}}`;
			const result = probe.parseYaml(json);

			expect(result).not.toBeNull();
			expect(result?.version).toBe("3.8");
			expect(result?.services?.app?.image).toBe("node:18");
		});

		test("should return null for invalid YAML", () => {
			const invalidYaml = `
services:
  - invalid: true
    - nested: wrong
      [[[[malformed
`;
			const result = probe.parseYaml(invalidYaml);

			expect(result).toBeNull();
		});

		test("should parse networks section", () => {
			const yaml = `
version: '3.8'
services:
  app:
    image: node:18
networks:
  frontend:
  backend:
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.networks).toBeDefined();
			expect(Object.keys(result?.networks as object)).toContain("frontend");
			expect(Object.keys(result?.networks as object)).toContain("backend");
		});

		test("should parse volumes section", () => {
			const yaml = `
version: '3.8'
services:
  app:
    image: node:18
volumes:
  db-data:
  cache-data:
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.volumes).toBeDefined();
			expect(Object.keys(result?.volumes as object)).toContain("db-data");
			expect(Object.keys(result?.volumes as object)).toContain("cache-data");
		});
	});
});
