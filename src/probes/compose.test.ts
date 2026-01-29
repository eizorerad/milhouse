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

	describe("multi-line strings (block scalars)", () => {
		test("should parse literal block scalar (|) preserving newlines", () => {
			const yaml = `
version: '3.8'
services:
  redis:
    image: redis:7
    command: |
      redis-server
      --appendonly yes
      --maxmemory 256mb
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services?.redis).toBeDefined();
			const command = result?.services?.redis.command as string;
			expect(command).toContain("redis-server");
			expect(command).toContain("--appendonly yes");
			expect(command).toContain("--maxmemory 256mb");
			expect(command).toContain("\n");
		});

		test("should parse folded block scalar (>) folding newlines to spaces", () => {
			const yaml = `
version: '3.8'
services:
  app:
    image: node:18
    entrypoint: >
      node
      --experimental-specifier-resolution=node
      dist/index.js
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services?.app).toBeDefined();
			const entrypoint = result?.services?.app.entrypoint as string;
			expect(entrypoint).toContain("node");
			expect(entrypoint).toContain("--experimental-specifier-resolution=node");
			expect(entrypoint).toContain("dist/index.js");
		});

		test("should parse multi-line commands in service configs", () => {
			const yaml = `
version: '3.8'
services:
  db:
    image: postgres:15
    command: |
      postgres
      -c shared_preload_libraries=pg_stat_statements
      -c pg_stat_statements.track=all
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services?.db).toBeDefined();
			const command = result?.services?.db.command as string;
			expect(command).toContain("postgres");
			expect(command).toContain("shared_preload_libraries");
		});

		test("should parse redis command example from validation report", () => {
			const yaml = `
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    command: |
      redis-server
      --appendonly yes
      --maxmemory 256mb
      --maxmemory-policy allkeys-lru
    ports:
      - "6379:6379"
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services?.redis).toBeDefined();
			expect(result?.services?.redis.image).toBe("redis:7-alpine");
			const command = result?.services?.redis.command as string;
			expect(command).toContain("redis-server");
			expect(command).toContain("--maxmemory-policy allkeys-lru");
			expect(result?.services?.redis.ports).toEqual(["6379:6379"]);
		});
	});

	describe("flow style arrays and objects", () => {
		test("should parse flow style inline arrays for ports", () => {
			const yaml = `
version: '3.8'
services:
  web:
    image: nginx:latest
    ports: ['80:80', '443:443']
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services?.web).toBeDefined();
			expect(result?.services?.web.ports).toEqual(["80:80", "443:443"]);
		});

		test("should parse flow style inline objects for build", () => {
			const yaml = `
version: '3.8'
services:
  app:
    build: { context: '.', dockerfile: 'Dockerfile.prod' }
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services?.app).toBeDefined();
			expect(result?.services?.app.build).toEqual({
				context: ".",
				dockerfile: "Dockerfile.prod",
			});
		});

		test("should parse mixed flow and block styles", () => {
			const yaml = `
version: '3.8'
services:
  app:
    image: node:18
    ports: ['3000:3000', '9229:9229']
    environment:
      NODE_ENV: production
      DEBUG: 'false'
    volumes:
      - ./app:/app
      - node_modules:/app/node_modules
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services?.app).toBeDefined();
			expect(result?.services?.app.ports).toEqual(["3000:3000", "9229:9229"]);
			expect(result?.services?.app.environment).toEqual({
				NODE_ENV: "production",
				DEBUG: "false",
			});
			expect(result?.services?.app.volumes).toEqual([
				"./app:/app",
				"node_modules:/app/node_modules",
			]);
		});

		test("should parse flow style environment variables", () => {
			const yaml = `
version: '3.8'
services:
  app:
    image: node:18
    environment: { NODE_ENV: 'production', PORT: '3000' }
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services?.app?.environment).toEqual({
				NODE_ENV: "production",
				PORT: "3000",
			});
		});

		test("should parse ports with flow style from validation report", () => {
			const yaml = `
version: '3.8'
services:
  nginx:
    image: nginx:alpine
    ports: ["80:80", "443:443", "8080:8080"]
    volumes: ["./nginx.conf:/etc/nginx/nginx.conf:ro"]
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services?.nginx).toBeDefined();
			expect(result?.services?.nginx.ports).toEqual([
				"80:80",
				"443:443",
				"8080:8080",
			]);
			expect(result?.services?.nginx.volumes).toEqual([
				"./nginx.conf:/etc/nginx/nginx.conf:ro",
			]);
		});
	});

	describe("YAML anchors and aliases", () => {
		test("should parse anchor definition and alias reference", () => {
			const yaml = `
version: '3.8'
x-common-env: &common-env
  LOG_LEVEL: info
  DEBUG: 'false'

services:
  app:
    image: node:18
    environment:
      <<: *common-env
      NODE_ENV: production
  worker:
    image: node:18
    environment:
      <<: *common-env
      WORKER_TYPE: background
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services?.app?.environment).toEqual({
				LOG_LEVEL: "info",
				DEBUG: "false",
				NODE_ENV: "production",
			});
			expect(result?.services?.worker?.environment).toEqual({
				LOG_LEVEL: "info",
				DEBUG: "false",
				WORKER_TYPE: "background",
			});
		});

		test("should parse merge key (<<:) for object merging", () => {
			const yaml = `
version: '3.8'
x-base-service: &base-service
  restart: always
  logging:
    driver: json-file
    options:
      max-size: "10m"
      max-file: "3"

services:
  api:
    <<: *base-service
    image: api:latest
    ports:
      - "3000:3000"
  web:
    <<: *base-service
    image: web:latest
    ports:
      - "80:80"
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services?.api?.restart).toBe("always");
			expect(result?.services?.api?.image).toBe("api:latest");
			expect(result?.services?.api?.logging).toEqual({
				driver: "json-file",
				options: {
					"max-size": "10m",
					"max-file": "3",
				},
			});
			expect(result?.services?.web?.restart).toBe("always");
			expect(result?.services?.web?.image).toBe("web:latest");
		});

		test("should parse common DRY patterns with &common_env and <<: *base", () => {
			const yaml = `
version: '3.8'
x-logging: &default-logging
  driver: json-file
  options:
    max-size: "10m"

x-deploy: &default-deploy
  resources:
    limits:
      cpus: '0.5'
      memory: 512M

services:
  service1:
    image: service1:latest
    logging: *default-logging
    deploy: *default-deploy
  service2:
    image: service2:latest
    logging: *default-logging
    deploy: *default-deploy
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services?.service1?.logging).toEqual({
				driver: "json-file",
				options: {
					"max-size": "10m",
				},
			});
			expect(result?.services?.service1?.deploy).toEqual({
				resources: {
					limits: {
						cpus: "0.5",
						memory: "512M",
					},
				},
			});
			expect(result?.services?.service2?.logging).toEqual(
				result?.services?.service1?.logging
			);
		});

		test("should parse extension fields with x- prefix", () => {
			const yaml = `
version: '3.8'
x-custom-labels: &custom-labels
  app.kubernetes.io/name: myapp
  app.kubernetes.io/version: "1.0"

services:
  app:
    image: myapp:1.0
    labels:
      <<: *custom-labels
      environment: production
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services?.app?.labels).toEqual({
				"app.kubernetes.io/name": "myapp",
				"app.kubernetes.io/version": "1.0",
				environment: "production",
			});
		});
	});
});
