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

	describe("complex depends_on and healthcheck", () => {
		test("should parse depends_on with conditions", () => {
			const yaml = `
version: '3.8'
services:
  web:
    image: web:latest
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services?.web?.depends_on).toBeDefined();
			expect(result?.services?.web?.depends_on).toEqual({
				db: { condition: "service_healthy" },
				redis: { condition: "service_started" },
			});
		});

		test("should parse nested healthcheck with all properties", () => {
			const yaml = `
version: '3.8'
services:
  db:
    image: postgres:15
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services?.db?.healthcheck).toBeDefined();
			// Use type assertion for healthcheck with start_period which is valid YAML but not in the interface
			const healthcheck = result?.services?.db?.healthcheck as {
				test: string[];
				interval: string;
				timeout: string;
				retries: number;
				start_period: string;
			};
			expect(healthcheck.test).toEqual(["CMD-SHELL", "pg_isready -U postgres"]);
			expect(healthcheck.interval).toBe("10s");
			expect(healthcheck.timeout).toBe("5s");
			expect(healthcheck.retries).toBe(5);
			expect(healthcheck.start_period).toBe("30s");
		});

		test("should parse complex build configurations", () => {
			const yaml = `
version: '3.8'
services:
  app:
    build:
      context: ./app
      dockerfile: Dockerfile.prod
      args:
        NODE_ENV: production
        BUILD_DATE: "2024-01-01"
      target: production
      cache_from:
        - app:cache
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			// Use type assertion for build config with extended properties
			const build = result?.services?.app?.build as {
				context: string;
				dockerfile: string;
				args: Record<string, string>;
				target: string;
				cache_from: string[];
			};
			expect(build.context).toBe("./app");
			expect(build.dockerfile).toBe("Dockerfile.prod");
			expect(build.args).toEqual({
				NODE_ENV: "production",
				BUILD_DATE: "2024-01-01",
			});
			expect(build.target).toBe("production");
			expect(build.cache_from).toEqual(["app:cache"]);
		});

		test("should parse depends_on corruption example from validation report", () => {
			const yaml = `
version: '3.8'
services:
  api:
    image: api:latest
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
      rabbitmq:
        condition: service_started
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services?.api?.depends_on).toBeDefined();

			const dependsOn = result?.services?.api?.depends_on as Record<
				string,
				{ condition: string }
			>;
			expect(Object.keys(dependsOn)).toHaveLength(3);
			expect(dependsOn.db?.condition).toBe("service_healthy");
			expect(dependsOn.redis?.condition).toBe("service_healthy");
			expect(dependsOn.rabbitmq?.condition).toBe("service_started");
		});

		test("should parse healthcheck with string test command", () => {
			const yaml = `
version: '3.8'
services:
  redis:
    image: redis:7
    healthcheck:
      test: redis-cli ping
      interval: 5s
      timeout: 3s
      retries: 3
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services?.redis?.healthcheck?.test).toBe("redis-cli ping");
			expect(result?.services?.redis?.healthcheck?.interval).toBe("5s");
		});

		test("should parse service with all complex nested structures", () => {
			const yaml = `
version: '3.8'
services:
  app:
    image: app:latest
    build:
      context: .
      dockerfile: Dockerfile
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    deploy:
      replicas: 3
      resources:
        limits:
          cpus: '0.5'
          memory: 512M
        reservations:
          cpus: '0.25'
          memory: 256M
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services?.app?.build).toEqual({
				context: ".",
				dockerfile: "Dockerfile",
			});
			expect(result?.services?.app?.depends_on).toEqual({
				db: { condition: "service_healthy" },
			});
			expect(result?.services?.app?.healthcheck?.test).toEqual([
				"CMD",
				"curl",
				"-f",
				"http://localhost:3000/health",
			]);
			// Use type assertion for deploy config which is valid YAML but not in the interface
			const deploy = result?.services?.app?.deploy as {
				replicas: number;
				resources: {
					limits: { cpus: string; memory: string };
					reservations: { cpus: string; memory: string };
				};
			};
			expect(deploy.replicas).toBe(3);
			expect(deploy.resources.limits.memory).toBe("512M");
		});
	});

	describe("integration tests with real-world compose files", () => {
		test("should correctly parse a real-world compose file with 4+ services", () => {
			const yaml = `
version: '3.8'

x-common-env: &common-env
  LOG_LEVEL: info
  NODE_ENV: production

x-healthcheck-defaults: &healthcheck-defaults
  interval: 30s
  timeout: 10s
  retries: 3

services:
  nginx:
    image: nginx:alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./certs:/etc/nginx/certs:ro
    depends_on:
      api:
        condition: service_healthy
      web:
        condition: service_started
    healthcheck:
      <<: *healthcheck-defaults
      test: ["CMD", "nginx", "-t"]
    networks:
      - frontend
      - backend

  api:
    image: api:latest
    build:
      context: ./api
      dockerfile: Dockerfile.prod
      args:
        NODE_ENV: production
    environment:
      <<: *common-env
      DATABASE_URL: postgres://db:5432/app
      REDIS_URL: redis://redis:6379
    ports:
      - "3000:3000"
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      <<: *healthcheck-defaults
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
    networks:
      - backend
    volumes:
      - ./api/uploads:/app/uploads

  web:
    image: web:latest
    build:
      context: ./web
      dockerfile: Dockerfile
    environment:
      <<: *common-env
      API_URL: http://api:3000
    ports:
      - "8080:8080"
    depends_on:
      - api
    networks:
      - frontend

  db:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: app
    volumes:
      - db-data:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      <<: *healthcheck-defaults
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 10s
    networks:
      - backend

  redis:
    image: redis:7-alpine
    command: |
      redis-server
      --appendonly yes
      --maxmemory 256mb
      --maxmemory-policy allkeys-lru
    volumes:
      - redis-data:/data
    healthcheck:
      <<: *healthcheck-defaults
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
    networks:
      - backend

networks:
  frontend:
    driver: bridge
  backend:
    driver: bridge
    internal: true

volumes:
  db-data:
  redis-data:
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.version).toBe("3.8");

			// Verify all 5 services are detected (not just 3 of 4 like before)
			expect(result?.services).toBeDefined();
			const serviceNames = Object.keys(result?.services || {});
			expect(serviceNames).toHaveLength(5);
			expect(serviceNames).toContain("nginx");
			expect(serviceNames).toContain("api");
			expect(serviceNames).toContain("web");
			expect(serviceNames).toContain("db");
			expect(serviceNames).toContain("redis");

			// Verify nginx service
			expect(result?.services?.nginx?.image).toBe("nginx:alpine");
			expect(result?.services?.nginx?.ports).toEqual(["80:80", "443:443"]);
			expect(result?.services?.nginx?.depends_on).toEqual({
				api: { condition: "service_healthy" },
				web: { condition: "service_started" },
			});

			// Verify api service with merged environment
			expect(result?.services?.api?.environment).toEqual({
				LOG_LEVEL: "info",
				NODE_ENV: "production",
				DATABASE_URL: "postgres://db:5432/app",
				REDIS_URL: "redis://redis:6379",
			});
			// Use type assertion for build config with extended properties
			const apiBuild = result?.services?.api?.build as {
				context: string;
				dockerfile: string;
				args: Record<string, string>;
			};
			expect(apiBuild.context).toBe("./api");
			expect(apiBuild.dockerfile).toBe("Dockerfile.prod");
			expect(apiBuild.args).toEqual({ NODE_ENV: "production" });

			// Verify depends_on relationships are correct
			const apiDependsOn = result?.services?.api?.depends_on as Record<
				string,
				{ condition: string }
			>;
			expect(apiDependsOn.db?.condition).toBe("service_healthy");
			expect(apiDependsOn.redis?.condition).toBe("service_healthy");

			// Verify healthchecks are properly parsed (merged from anchor)
			expect(result?.services?.db?.healthcheck?.interval).toBe("10s");
			expect(result?.services?.db?.healthcheck?.test).toEqual([
				"CMD-SHELL",
				"pg_isready -U app",
			]);

			// Verify redis command with block scalar
			const redisCommand = result?.services?.redis?.command as string;
			expect(redisCommand).toContain("redis-server");
			expect(redisCommand).toContain("--appendonly yes");
			expect(redisCommand).toContain("--maxmemory-policy allkeys-lru");

			// Verify volumes use correct array structure
			expect(result?.services?.db?.volumes).toEqual([
				"db-data:/var/lib/postgresql/data",
				"./init.sql:/docker-entrypoint-initdb.d/init.sql:ro",
			]);

			// Verify networks
			expect(result?.networks).toBeDefined();
			expect(Object.keys(result?.networks as object)).toContain("frontend");
			expect(Object.keys(result?.networks as object)).toContain("backend");

			// Verify volumes
			expect(result?.volumes).toBeDefined();
			expect(Object.keys(result?.volumes as object)).toContain("db-data");
			expect(Object.keys(result?.volumes as object)).toContain("redis-data");
		});

		test("should detect correct service count from complex file", () => {
			const yaml = `
version: '3.8'
services:
  service1:
    image: service1:latest
  service2:
    image: service2:latest
  service3:
    image: service3:latest
  service4:
    image: service4:latest
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(Object.keys(result?.services || {})).toHaveLength(4);
		});

		test("should handle empty compose file gracefully", () => {
			const yaml = `version: '3.8'`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.version).toBe("3.8");
			expect(result?.services).toBeUndefined();
		});

		test("should handle compose file with only services", () => {
			const yaml = `
services:
  app:
    image: node:18
`;
			const result = probe.parseYaml(yaml);

			expect(result).not.toBeNull();
			expect(result?.services?.app?.image).toBe("node:18");
		});
	});
});
