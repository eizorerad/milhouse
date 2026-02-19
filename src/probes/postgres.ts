import * as fs from "node:fs";
import * as path from "node:path";
import { BaseProbe, type CommandResult } from "./base.ts";
import {
	type PostgresColumn,
	type PostgresMigration,
	type PostgresProbeOutput,
	type PostgresTable,
	type ProbeConfig,
	type ProbeFinding,
	type ProbeInput,
	type ProbeResult,
	createProbeFinding,
} from "./types.ts";

/**
 * Migration file patterns by framework
 */
const MIGRATION_PATTERNS: Record<string, RegExp[]> = {
	prisma: [/migrations\/\d+_.*\/migration\.sql$/],
	drizzle: [/drizzle\/\d+_.*\.sql$/, /migrations\/.*\.sql$/],
	knex: [/migrations\/\d+_.*\.(js|ts|sql)$/],
	typeorm: [/migrations\/\d+.*\.(js|ts)$/, /migration\/.*\.(js|ts)$/],
	sequelize: [/migrations\/\d+-.*\.(js|ts)$/, /db\/migrate\/.*\.(js|ts)$/],
	django: [/migrations\/\d+_.*\.py$/],
	alembic: [/alembic\/versions\/.*\.py$/, /migrations\/versions\/.*\.py$/],
	flyway: [/sql\/V\d+__.*\.sql$/, /db\/migration\/V\d+__.*\.sql$/],
	liquibase: [/changelog.*\.xml$/, /changelog.*\.yaml$/, /changelog.*\.sql$/],
	goose: [/migrations\/\d+_.*\.sql$/],
	dbmate: [/db\/migrations\/\d+_.*\.sql$/],
	sqlalchemy: [/alembic\/versions\/.*\.py$/],
	rails: [/db\/migrate\/\d+_.*\.rb$/],
	generic: [/migrations?\/.*\.(sql|js|ts|py|rb)$/],
};

/**
 * Schema file patterns by framework
 */
const SCHEMA_PATTERNS: Record<string, string[]> = {
	prisma: ["prisma/schema.prisma"],
	drizzle: ["drizzle/schema.ts", "src/db/schema.ts", "src/schema.ts"],
	typeorm: ["src/entities/**/*.ts", "src/entity/**/*.ts"],
	sequelize: ["models/**/*.ts", "models/**/*.js", "src/models/**/*.ts"],
	django: ["models.py", "**/models.py"],
	sqlalchemy: ["models.py", "**/models.py", "src/models/**/*.py"],
	rails: ["db/schema.rb", "app/models/**/*.rb"],
	knex: ["knexfile.js", "knexfile.ts"],
	generic: ["schema.sql", "db/schema.sql", "database/schema.sql"],
};

/**
 * Raw migration file data
 */
interface RawMigrationFile {
	name: string;
	path: string;
	content?: string;
	timestamp?: number;
}

/**
 * Raw schema definition from Prisma
 */
interface PrismaSchema {
	models: Array<{
		name: string;
		fields: Array<{
			name: string;
			type: string;
			isRequired: boolean;
			isId: boolean;
			isList: boolean;
			default?: string;
			relation?: {
				name?: string;
				fields?: string[];
				references?: string[];
			};
		}>;
	}>;
	enums: Array<{
		name: string;
		values: string[];
	}>;
}

/**
 * PostgreSQL Schema/Migrations Auditor (DLA - Database Layer Auditor)
 *
 * Analyzes PostgreSQL database configurations and migrations:
 * - Schema files (Prisma, Drizzle, TypeORM, Sequelize, etc.)
 * - Migration files and their status
 * - Table structures from schema definitions
 * - Connection configuration from environment files
 *
 * Capabilities:
 * - Read schema and migration files from the repository
 * - Parse Prisma schema files
 * - Parse SQL migration files
 * - Cannot write files or modify database state
 *
 * Output:
 * - Tables with columns, indexes, constraints
 * - Migrations with applied status
 * - Database extensions
 * - Connection info
 * - Issues/findings for misconfigurations
 */
export class PostgresProbe extends BaseProbe<PostgresProbeOutput> {
	constructor(configOverrides?: Partial<ProbeConfig>) {
		super("postgres", configOverrides);
	}

	/**
	 * Get commands to execute for database inspection
	 * These are informational commands only - no write operations
	 */
	protected getCommands(_input: ProbeInput): Array<{ command: string; args: string[] }> {
		// We primarily parse files directly, so no commands needed
		// Could optionally check for psql availability
		return [];
	}

	/**
	 * Override execute to handle file-based parsing
	 * Since postgres probe primarily reads schema/migration files
	 */
	async execute(input: ProbeInput): Promise<ProbeResult> {
		const startTime = Date.now();

		// Validate input
		if (!this.validateInput(input)) {
			const duration = Date.now() - startTime;
			return {
				probe_id: `postgres-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				probe_type: "postgres",
				success: false,
				error: "Invalid probe input: workDir is required",
				timestamp: new Date().toISOString(),
				read_only: true,
				duration_ms: duration,
				findings: [],
			};
		}

		try {
			// Detect the ORM/framework in use
			const framework = this.detectFramework(input.workDir);

			// Find and parse schema files
			const tables = await this.parseSchemaFiles(input.workDir, framework);

			// Find and parse migration files
			const migrations = this.findMigrations(input.workDir, framework);

			// Extract connection info from environment files
			const connectionInfo = this.extractConnectionInfo(input.workDir);

			// Detect extensions from schema/migrations
			const extensions = this.extractExtensions(input.workDir, migrations);

			// Build the output
			const output: PostgresProbeOutput = {
				tables,
				migrations,
				extensions,
				connection_info: connectionInfo,
				issues: [],
			};

			// Extract findings
			const findings = this.extractFindings(output);

			const duration = Date.now() - startTime;
			return {
				probe_id: `postgres-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				probe_type: "postgres",
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
				probe_id: `postgres-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				probe_type: "postgres",
				success: false,
				error: `Failed to analyze PostgreSQL configuration: ${errorMessage}`,
				timestamp: new Date().toISOString(),
				read_only: true,
				duration_ms: duration,
				findings: [],
			};
		}
	}

	/**
	 * Detect the ORM/framework being used
	 */
	detectFramework(workDir: string): string {
		// Check for Prisma
		if (fs.existsSync(path.join(workDir, "prisma/schema.prisma"))) {
			return "prisma";
		}

		// Check for Drizzle
		if (
			fs.existsSync(path.join(workDir, "drizzle.config.ts")) ||
			fs.existsSync(path.join(workDir, "drizzle.config.js")) ||
			fs.existsSync(path.join(workDir, "drizzle"))
		) {
			return "drizzle";
		}

		// Check for TypeORM
		if (
			fs.existsSync(path.join(workDir, "ormconfig.json")) ||
			fs.existsSync(path.join(workDir, "ormconfig.ts")) ||
			fs.existsSync(path.join(workDir, "typeorm.config.ts"))
		) {
			return "typeorm";
		}

		// Check for Sequelize
		if (
			fs.existsSync(path.join(workDir, ".sequelizerc")) ||
			fs.existsSync(path.join(workDir, "sequelize.config.js"))
		) {
			return "sequelize";
		}

		// Check for Knex
		if (
			fs.existsSync(path.join(workDir, "knexfile.js")) ||
			fs.existsSync(path.join(workDir, "knexfile.ts"))
		) {
			return "knex";
		}

		// Check for Django
		if (fs.existsSync(path.join(workDir, "manage.py"))) {
			return "django";
		}

		// Check for Rails
		if (fs.existsSync(path.join(workDir, "Gemfile")) && fs.existsSync(path.join(workDir, "db"))) {
			return "rails";
		}

		// Check for Flyway
		if (
			fs.existsSync(path.join(workDir, "flyway.conf")) ||
			fs.existsSync(path.join(workDir, "sql"))
		) {
			return "flyway";
		}

		// Check for Alembic
		if (fs.existsSync(path.join(workDir, "alembic.ini"))) {
			return "alembic";
		}

		// Check for Liquibase
		if (
			fs.existsSync(path.join(workDir, "liquibase.properties")) ||
			fs.existsSync(path.join(workDir, "changelog.xml"))
		) {
			return "liquibase";
		}

		// Check for goose
		if (fs.existsSync(path.join(workDir, "dbconfig.yml"))) {
			return "goose";
		}

		// Check for dbmate
		if (
			fs.existsSync(path.join(workDir, "db/migrations")) &&
			!fs.existsSync(path.join(workDir, "prisma"))
		) {
			return "dbmate";
		}

		return "generic";
	}

	/**
	 * Parse schema files and extract table definitions
	 */
	async parseSchemaFiles(workDir: string, framework: string): Promise<PostgresTable[]> {
		const tables: PostgresTable[] = [];

		if (framework === "prisma") {
			const prismaPath = path.join(workDir, "prisma/schema.prisma");
			if (fs.existsSync(prismaPath)) {
				const content = fs.readFileSync(prismaPath, "utf-8");
				const prismaSchema = this.parsePrismaSchema(content);
				for (const model of prismaSchema.models) {
					tables.push(this.convertPrismaModelToTable(model));
				}
			}
		} else if (framework === "drizzle") {
			// Look for Drizzle schema files
			const drizzlePaths = [
				path.join(workDir, "drizzle/schema.ts"),
				path.join(workDir, "src/db/schema.ts"),
				path.join(workDir, "src/schema.ts"),
			];

			for (const drizzlePath of drizzlePaths) {
				if (fs.existsSync(drizzlePath)) {
					const content = fs.readFileSync(drizzlePath, "utf-8");
					const drizzleTables = this.parseDrizzleSchema(content);
					tables.push(...drizzleTables);
				}
			}
		} else if (framework === "generic") {
			// Look for SQL schema files
			const sqlSchemaPaths = [
				path.join(workDir, "schema.sql"),
				path.join(workDir, "db/schema.sql"),
				path.join(workDir, "database/schema.sql"),
			];

			for (const sqlPath of sqlSchemaPaths) {
				if (fs.existsSync(sqlPath)) {
					const content = fs.readFileSync(sqlPath, "utf-8");
					const sqlTables = this.parseSqlSchema(content);
					tables.push(...sqlTables);
				}
			}
		}

		return tables;
	}

	/**
	 * Parse Prisma schema file
	 */
	parsePrismaSchema(content: string): PrismaSchema {
		const models: PrismaSchema["models"] = [];
		const enums: PrismaSchema["enums"] = [];

		const lines = content.split("\n");
		let currentModel: (typeof models)[0] | null = null;
		let currentEnum: (typeof enums)[0] | null = null;
		let inModel = false;
		let inEnum = false;

		for (const line of lines) {
			const trimmed = line.trim();

			// Skip empty lines and comments
			if (trimmed === "" || trimmed.startsWith("//")) {
				continue;
			}

			// Check for model start
			const modelMatch = trimmed.match(/^model\s+(\w+)\s*\{$/);
			if (modelMatch) {
				currentModel = { name: modelMatch[1], fields: [] };
				inModel = true;
				continue;
			}

			// Check for enum start
			const enumMatch = trimmed.match(/^enum\s+(\w+)\s*\{$/);
			if (enumMatch) {
				currentEnum = { name: enumMatch[1], values: [] };
				inEnum = true;
				continue;
			}

			// Check for block end
			if (trimmed === "}") {
				if (inModel && currentModel) {
					models.push(currentModel);
					currentModel = null;
					inModel = false;
				} else if (inEnum && currentEnum) {
					enums.push(currentEnum);
					currentEnum = null;
					inEnum = false;
				}
				continue;
			}

			// Parse model fields
			if (inModel && currentModel) {
				const fieldMatch = trimmed.match(/^(\w+)\s+(\w+)(\[\])?(\?)?(\s+@.*)?$/);
				if (fieldMatch) {
					const [, fieldName, fieldType, isList, isOptional, attributes] = fieldMatch;

					const field: (typeof currentModel.fields)[0] = {
						name: fieldName,
						type: fieldType,
						isRequired: !isOptional,
						isId: attributes?.includes("@id") ?? false,
						isList: !!isList,
					};

					// Extract default value - handle nested parentheses like autoincrement()
					const defaultMatch = attributes?.match(/@default\((.+?)\)(?:\s|$|@)/);
					if (defaultMatch) {
						// Handle nested parens by finding matching closing paren
						const startIdx = attributes?.indexOf("@default(");
						if (startIdx !== undefined && startIdx >= 0 && attributes) {
							let depth = 0;
							const endIdx = startIdx + 9; // Length of "@default("
							for (let i = endIdx; i < attributes.length; i++) {
								if (attributes[i] === "(") depth++;
								else if (attributes[i] === ")") {
									if (depth === 0) {
										field.default = attributes.slice(endIdx, i);
										break;
									}
									depth--;
								}
							}
						}
					}

					// Extract relation
					const relationMatch = attributes?.match(/@relation\(([^)]+)\)/);
					if (relationMatch) {
						const relationStr = relationMatch[1];
						const fieldsMatch = relationStr.match(/fields:\s*\[([^\]]+)\]/);
						const referencesMatch = relationStr.match(/references:\s*\[([^\]]+)\]/);

						field.relation = {
							fields: fieldsMatch ? fieldsMatch[1].split(",").map((f) => f.trim()) : undefined,
							references: referencesMatch
								? referencesMatch[1].split(",").map((r) => r.trim())
								: undefined,
						};
					}

					currentModel.fields.push(field);
				}
			}

			// Parse enum values
			if (inEnum && currentEnum) {
				const valueMatch = trimmed.match(/^(\w+)$/);
				if (valueMatch) {
					currentEnum.values.push(valueMatch[1]);
				}
			}
		}

		return { models, enums };
	}

	/**
	 * Convert Prisma model to PostgresTable
	 */
	convertPrismaModelToTable(model: PrismaSchema["models"][0]): PostgresTable {
		const columns: PostgresColumn[] = [];
		const constraints: string[] = [];
		const indexes: string[] = [];

		for (const field of model.fields) {
			// Skip relation fields
			if (field.relation && !field.relation.fields) {
				continue;
			}

			const column: PostgresColumn = {
				name: field.name,
				type: this.mapPrismaTypeToPostgres(field.type, field.isList),
				nullable: !field.isRequired,
				is_primary: field.isId,
				is_foreign: !!field.relation,
			};

			if (field.default) {
				column.default_value = field.default;
			}

			if (field.relation?.references?.[0]) {
				// Infer foreign table from type
				column.foreign_table = this.toSnakeCase(field.type);
				column.foreign_column = field.relation.references[0];
			}

			columns.push(column);

			if (field.isId) {
				constraints.push(`PRIMARY KEY (${field.name})`);
			}
		}

		return {
			name: this.toSnakeCase(model.name),
			schema: "public",
			columns,
			indexes,
			constraints,
		};
	}

	/**
	 * Map Prisma type to PostgreSQL type
	 */
	mapPrismaTypeToPostgres(prismaType: string, isList: boolean): string {
		const typeMap: Record<string, string> = {
			String: "text",
			Int: "integer",
			BigInt: "bigint",
			Float: "double precision",
			Decimal: "decimal",
			Boolean: "boolean",
			DateTime: "timestamp with time zone",
			Json: "jsonb",
			Bytes: "bytea",
		};

		const pgType = typeMap[prismaType] ?? "text";
		return isList ? `${pgType}[]` : pgType;
	}

	/**
	 * Parse Drizzle schema file (simplified)
	 */
	parseDrizzleSchema(content: string): PostgresTable[] {
		const tables: PostgresTable[] = [];

		// Match pgTable definitions
		const tableRegex =
			/(?:export\s+const\s+)?(\w+)\s*=\s*pgTable\s*\(\s*["'](\w+)["']\s*,\s*\{([^}]+)\}/g;
		const matches = content.matchAll(tableRegex);

		for (const match of matches) {
			const [, , tableName, columnsStr] = match;
			const columns = this.parseDrizzleColumns(columnsStr);

			tables.push({
				name: tableName,
				schema: "public",
				columns,
				indexes: [],
				constraints: [],
			});
		}

		return tables;
	}

	/**
	 * Parse Drizzle column definitions
	 */
	parseDrizzleColumns(columnsStr: string): PostgresColumn[] {
		const columns: PostgresColumn[] = [];

		// Match column definitions like: id: serial("id").primaryKey()
		// We need to capture the full line including method chains
		const columnRegex = /(\w+)\s*:\s*(\w+)\s*\(\s*["']?(\w+)["']?[^)]*\)([^,]*)/g;
		const matches = columnsStr.matchAll(columnRegex);

		for (const match of matches) {
			const [, , columnType, columnName, methodChain] = match;

			const column: PostgresColumn = {
				name: columnName,
				type: this.mapDrizzleTypeToPostgres(columnType),
				nullable: !methodChain.includes(".notNull()"),
				is_primary: methodChain.includes(".primaryKey()"),
				is_foreign: methodChain.includes(".references("),
			};

			columns.push(column);
		}

		return columns;
	}

	/**
	 * Map Drizzle type to PostgreSQL type
	 */
	mapDrizzleTypeToPostgres(drizzleType: string): string {
		const typeMap: Record<string, string> = {
			serial: "serial",
			bigserial: "bigserial",
			smallserial: "smallserial",
			integer: "integer",
			bigint: "bigint",
			smallint: "smallint",
			real: "real",
			doublePrecision: "double precision",
			numeric: "numeric",
			decimal: "decimal",
			text: "text",
			varchar: "varchar",
			char: "char",
			boolean: "boolean",
			timestamp: "timestamp",
			timestamptz: "timestamp with time zone",
			date: "date",
			time: "time",
			interval: "interval",
			json: "json",
			jsonb: "jsonb",
			uuid: "uuid",
			bytea: "bytea",
		};

		return typeMap[drizzleType] ?? "text";
	}

	/**
	 * Parse SQL schema file
	 */
	parseSqlSchema(content: string): PostgresTable[] {
		const tables: PostgresTable[] = [];

		// Match CREATE TABLE statements
		const tableRegex =
			/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?\s*\(([^;]+)\)/gi;
		const matches = content.matchAll(tableRegex);

		for (const match of matches) {
			const [, schema, tableName, columnsStr] = match;
			const columns = this.parseSqlColumns(columnsStr);
			const constraints = this.parseSqlConstraints(columnsStr);

			tables.push({
				name: tableName,
				schema: schema ?? "public",
				columns,
				indexes: [],
				constraints,
			});
		}

		return tables;
	}

	/**
	 * Parse SQL column definitions
	 */
	parseSqlColumns(columnsStr: string): PostgresColumn[] {
		const columns: PostgresColumn[] = [];

		// Split by commas, handling nested parentheses
		const parts = this.splitSqlParts(columnsStr);

		for (const part of parts) {
			const trimmed = part.trim();

			// Skip constraints
			if (
				trimmed.toUpperCase().startsWith("PRIMARY KEY") ||
				trimmed.toUpperCase().startsWith("FOREIGN KEY") ||
				trimmed.toUpperCase().startsWith("UNIQUE") ||
				trimmed.toUpperCase().startsWith("CHECK") ||
				trimmed.toUpperCase().startsWith("CONSTRAINT")
			) {
				continue;
			}

			// Match column definition
			const columnMatch = trimmed.match(
				/^"?(\w+)"?\s+([\w\s()]+?)(?:\s+(NOT\s+NULL|NULL))?(?:\s+DEFAULT\s+(.+?))?(?:\s+(PRIMARY\s+KEY|REFERENCES.*))?$/i,
			);

			if (columnMatch) {
				const [, name, type, nullability, defaultValue, constraint] = columnMatch;

				const column: PostgresColumn = {
					name,
					type: type.trim(),
					nullable: nullability?.toUpperCase() !== "NOT NULL",
					is_primary: constraint?.toUpperCase().includes("PRIMARY KEY") ?? false,
					is_foreign: constraint?.toUpperCase().includes("REFERENCES") ?? false,
				};

				if (defaultValue) {
					column.default_value = defaultValue.trim();
				}

				// Extract foreign key reference
				const refMatch = constraint?.match(/REFERENCES\s+"?(\w+)"?(?:\s*\(\s*"?(\w+)"?\s*\))?/i);
				if (refMatch) {
					column.foreign_table = refMatch[1];
					column.foreign_column = refMatch[2];
				}

				columns.push(column);
			}
		}

		return columns;
	}

	/**
	 * Parse SQL constraints
	 */
	parseSqlConstraints(columnsStr: string): string[] {
		const constraints: string[] = [];
		const parts = this.splitSqlParts(columnsStr);

		for (const part of parts) {
			const trimmed = part.trim();
			const upper = trimmed.toUpperCase();

			if (
				upper.startsWith("PRIMARY KEY") ||
				upper.startsWith("FOREIGN KEY") ||
				upper.startsWith("UNIQUE") ||
				upper.startsWith("CHECK") ||
				upper.startsWith("CONSTRAINT")
			) {
				constraints.push(trimmed);
			}
		}

		return constraints;
	}

	/**
	 * Split SQL parts by commas, respecting parentheses
	 */
	splitSqlParts(str: string): string[] {
		const parts: string[] = [];
		let current = "";
		let depth = 0;

		for (const char of str) {
			if (char === "(") {
				depth++;
				current += char;
			} else if (char === ")") {
				depth--;
				current += char;
			} else if (char === "," && depth === 0) {
				if (current.trim()) {
					parts.push(current.trim());
				}
				current = "";
			} else {
				current += char;
			}
		}

		if (current.trim()) {
			parts.push(current.trim());
		}

		return parts;
	}

	/**
	 * Find migration files
	 */
	findMigrations(workDir: string, framework: string): PostgresMigration[] {
		const migrations: PostgresMigration[] = [];
		const patterns = MIGRATION_PATTERNS[framework] ?? MIGRATION_PATTERNS.generic;

		// Get migration directories to search
		const migrationDirs = this.getMigrationDirs(workDir, framework);

		for (const dir of migrationDirs) {
			if (!fs.existsSync(dir)) {
				continue;
			}

			const files = this.findFilesRecursive(dir, patterns);

			for (const file of files) {
				const relativePath = path.relative(workDir, file);
				const migration = this.parseMigrationFile(file, relativePath, framework);
				if (migration) {
					migrations.push(migration);
				}
			}
		}

		// Sort by name (which typically contains timestamp)
		migrations.sort((a, b) => a.name.localeCompare(b.name));

		return migrations;
	}

	/**
	 * Get migration directories based on framework
	 */
	getMigrationDirs(workDir: string, framework: string): string[] {
		const dirs: string[] = [];

		switch (framework) {
			case "prisma":
				dirs.push(path.join(workDir, "prisma/migrations"));
				break;
			case "drizzle":
				dirs.push(path.join(workDir, "drizzle"));
				dirs.push(path.join(workDir, "migrations"));
				break;
			case "knex":
			case "typeorm":
			case "sequelize":
			case "dbmate":
			case "goose":
				dirs.push(path.join(workDir, "migrations"));
				dirs.push(path.join(workDir, "db/migrations"));
				break;
			case "flyway":
				dirs.push(path.join(workDir, "sql"));
				dirs.push(path.join(workDir, "db/migration"));
				break;
			case "alembic":
			case "sqlalchemy":
				dirs.push(path.join(workDir, "alembic/versions"));
				dirs.push(path.join(workDir, "migrations/versions"));
				break;
			case "django":
				// Django has migrations in each app
				dirs.push(workDir);
				break;
			case "rails":
				dirs.push(path.join(workDir, "db/migrate"));
				break;
			default:
				dirs.push(path.join(workDir, "migrations"));
				dirs.push(path.join(workDir, "db/migrations"));
		}

		return dirs;
	}

	/**
	 * Find files matching patterns recursively
	 */
	findFilesRecursive(dir: string, patterns: RegExp[]): string[] {
		const files: string[] = [];

		if (!fs.existsSync(dir)) {
			return files;
		}

		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);

			if (entry.isDirectory()) {
				// Recurse into subdirectories
				files.push(...this.findFilesRecursive(fullPath, patterns));
			} else if (entry.isFile()) {
				// Check if file matches any pattern
				for (const pattern of patterns) {
					if (pattern.test(fullPath)) {
						files.push(fullPath);
						break;
					}
				}
			}
		}

		return files;
	}

	/**
	 * Parse a migration file
	 */
	parseMigrationFile(
		filePath: string,
		relativePath: string,
		framework: string,
	): PostgresMigration | null {
		const fileName = path.basename(filePath);
		let name = fileName;

		// Extract migration name based on framework conventions
		if (framework === "prisma") {
			// Prisma: migrations/20230101120000_migration_name/migration.sql
			const dirName = path.basename(path.dirname(filePath));
			name = dirName;
		} else if (framework === "flyway") {
			// Flyway: V1__migration_name.sql
			const match = fileName.match(/^V(\d+)__(.+)\.sql$/);
			if (match) {
				name = `V${match[1]}__${match[2]}`;
			}
		} else {
			// Generic: timestamp_name.ext or sequence_name.ext
			name = fileName.replace(/\.(sql|js|ts|py|rb)$/, "");
		}

		// Try to determine if applied by checking for migration tracking files
		const applied = this.checkMigrationApplied(filePath, framework);

		// Try to extract timestamp from name
		const timestampMatch = name.match(/^(\d{14}|\d{13}|\d+)/);
		let appliedAt: string | undefined;

		if (applied && timestampMatch) {
			const timestamp = timestampMatch[1];
			if (timestamp.length === 14) {
				// Format: YYYYMMDDHHmmss
				appliedAt = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}Z`;
			} else if (timestamp.length === 13) {
				// Unix timestamp in milliseconds
				appliedAt = new Date(Number.parseInt(timestamp, 10)).toISOString();
			}
		}

		return {
			name,
			applied,
			applied_at: appliedAt,
		};
	}

	/**
	 * Check if a migration has been applied
	 * Note: Without database access, we make assumptions based on file structure
	 */
	checkMigrationApplied(_filePath: string, _framework: string): boolean {
		// Without database access, we assume migrations are applied
		// A real implementation would query the migration tracking table
		return true;
	}

	/**
	 * Extract connection info from environment files
	 */
	extractConnectionInfo(workDir: string): PostgresProbeOutput["connection_info"] {
		const envFiles = [".env", ".env.local", ".env.development", ".env.production"];
		const connectionInfo: PostgresProbeOutput["connection_info"] = {};

		for (const envFile of envFiles) {
			const envPath = path.join(workDir, envFile);
			if (fs.existsSync(envPath)) {
				const content = fs.readFileSync(envPath, "utf-8");
				const parsed = this.parseEnvConnectionString(content);
				if (parsed) {
					return parsed;
				}
			}
		}

		// Also check docker-compose for database service
		const composeFiles = ["docker-compose.yml", "docker-compose.yaml", "compose.yml"];
		for (const composeFile of composeFiles) {
			const composePath = path.join(workDir, composeFile);
			if (fs.existsSync(composePath)) {
				const content = fs.readFileSync(composePath, "utf-8");
				const parsed = this.parseComposeDbConfig(content);
				if (parsed) {
					return parsed;
				}
			}
		}

		return connectionInfo;
	}

	/**
	 * Parse PostgreSQL connection string from env file
	 */
	parseEnvConnectionString(content: string): PostgresProbeOutput["connection_info"] | null {
		// Look for DATABASE_URL or similar
		const urlPatterns = [
			/DATABASE_URL\s*=\s*["']?([^"'\n]+)["']?/,
			/POSTGRES_URL\s*=\s*["']?([^"'\n]+)["']?/,
			/PG_URL\s*=\s*["']?([^"'\n]+)["']?/,
		];

		for (const pattern of urlPatterns) {
			const match = content.match(pattern);
			if (match) {
				return this.parseConnectionUrl(match[1]);
			}
		}

		// Look for individual connection params
		const hostMatch = content.match(/(?:POSTGRES_HOST|DB_HOST|PGHOST)\s*=\s*["']?([^"'\n]+)["']?/);
		const portMatch = content.match(/(?:POSTGRES_PORT|DB_PORT|PGPORT)\s*=\s*["']?(\d+)["']?/);
		const dbMatch = content.match(/(?:POSTGRES_DB|DB_NAME|PGDATABASE)\s*=\s*["']?([^"'\n]+)["']?/);

		if (hostMatch || portMatch || dbMatch) {
			return {
				host: hostMatch?.[1],
				port: portMatch ? Number.parseInt(portMatch[1], 10) : undefined,
				database: dbMatch?.[1],
			};
		}

		return null;
	}

	/**
	 * Parse PostgreSQL connection URL
	 */
	parseConnectionUrl(url: string): PostgresProbeOutput["connection_info"] {
		try {
			// Handle template variables
			if (url.includes("${") || url.includes("$")) {
				return { host: "(from environment variable)" };
			}

			const parsed = new URL(url);
			return {
				host: parsed.hostname || undefined,
				port: parsed.port ? Number.parseInt(parsed.port, 10) : 5432,
				database: parsed.pathname?.slice(1) || undefined,
				ssl: parsed.searchParams.get("sslmode") !== "disable",
			};
		} catch {
			return {};
		}
	}

	/**
	 * Parse database config from docker-compose
	 */
	parseComposeDbConfig(content: string): PostgresProbeOutput["connection_info"] | null {
		// Look for postgres service
		if (!content.includes("postgres") && !content.includes("pg")) {
			return null;
		}

		// Extract port mapping
		const portMatch = content.match(/(\d+):5432/);
		const port = portMatch ? Number.parseInt(portMatch[1], 10) : 5432;

		// Extract database name from environment
		const dbMatch = content.match(/POSTGRES_DB:\s*["']?(\w+)["']?/);
		const database = dbMatch?.[1];

		return {
			host: "localhost",
			port,
			database,
		};
	}

	/**
	 * Extract PostgreSQL extensions from migrations
	 */
	extractExtensions(workDir: string, migrations: PostgresMigration[]): string[] {
		const extensions = new Set<string>();

		// Common extension patterns - handle quoted names like "uuid-ossp"
		const extensionPattern = /CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([\w-]+)["']?/gi;

		// Check migration files
		for (const migration of migrations) {
			const migrationPath = this.findMigrationPath(workDir, migration.name);
			if (migrationPath && fs.existsSync(migrationPath)) {
				const content = fs.readFileSync(migrationPath, "utf-8");
				const migrationMatches = content.matchAll(extensionPattern);
				for (const match of migrationMatches) {
					extensions.add(match[1].toLowerCase());
				}
			}
		}

		// Check schema files
		const schemaPaths = [
			path.join(workDir, "schema.sql"),
			path.join(workDir, "db/schema.sql"),
			path.join(workDir, "prisma/schema.prisma"),
		];

		for (const schemaPath of schemaPaths) {
			if (fs.existsSync(schemaPath)) {
				const content = fs.readFileSync(schemaPath, "utf-8");

				// For Prisma, check for extensions in the datasource
				if (schemaPath.endsWith(".prisma")) {
					const previewMatch = content.match(/previewFeatures\s*=\s*\[([^\]]+)\]/);
					if (previewMatch?.includes("postgresqlExtensions")) {
						const extMatch = content.match(/extensions\s*=\s*\[([^\]]+)\]/);
						if (extMatch) {
							const exts = extMatch[1].match(/\w+/g);
							if (exts) {
								for (const ext of exts) {
									extensions.add(ext.toLowerCase());
								}
							}
						}
					}
				} else {
					const schemaMatches = content.matchAll(extensionPattern);
					for (const match of schemaMatches) {
						extensions.add(match[1].toLowerCase());
					}
				}
			}
		}

		return Array.from(extensions);
	}

	/**
	 * Find the full path for a migration
	 */
	findMigrationPath(workDir: string, migrationName: string): string | null {
		const possiblePaths = [
			path.join(workDir, "migrations", migrationName),
			path.join(workDir, "migrations", `${migrationName}.sql`),
			path.join(workDir, "prisma/migrations", migrationName, "migration.sql"),
			path.join(workDir, "drizzle", `${migrationName}.sql`),
			path.join(workDir, "db/migrations", `${migrationName}.sql`),
		];

		for (const p of possiblePaths) {
			if (fs.existsSync(p)) {
				return p;
			}
		}

		return null;
	}

	/**
	 * Extract findings from the probe output
	 */
	extractFindings(output: PostgresProbeOutput): ProbeFinding[] {
		const findings: ProbeFinding[] = [...output.issues];

		// Check for tables without primary keys
		for (const table of output.tables) {
			const hasPrimaryKey = table.columns.some((col) => col.is_primary);
			if (!hasPrimaryKey && table.columns.length > 0) {
				findings.push(
					createProbeFinding(
						`no-primary-key-${table.name}`,
						`Table '${table.name}' has no primary key`,
						`The table '${table.name}' does not have a primary key defined. Primary keys are essential for data integrity and query performance.`,
						"HIGH",
						{
							suggestion: "Add a primary key column to the table",
						},
					),
				);
			}
		}

		// Check for foreign keys without indexes
		for (const table of output.tables) {
			for (const column of table.columns) {
				if (column.is_foreign) {
					const hasIndex = table.indexes.some((idx) =>
						idx.toLowerCase().includes(column.name.toLowerCase()),
					);
					if (!hasIndex) {
						findings.push(
							createProbeFinding(
								`foreign-key-no-index-${table.name}-${column.name}`,
								`Foreign key '${column.name}' in '${table.name}' may lack an index`,
								`The foreign key column '${column.name}' in table '${table.name}' may not have an index. This can cause slow JOIN operations.`,
								"MEDIUM",
								{
									suggestion: `Consider adding an index on ${table.name}(${column.name})`,
								},
							),
						);
					}
				}
			}
		}

		// Check for missing timestamps
		for (const table of output.tables) {
			const hasCreatedAt = table.columns.some((col) =>
				["created_at", "createdat", "created", "createdon"].includes(col.name.toLowerCase()),
			);
			const hasUpdatedAt = table.columns.some((col) =>
				["updated_at", "updatedat", "updated", "modifiedat", "modified_at"].includes(
					col.name.toLowerCase(),
				),
			);

			if (!hasCreatedAt && table.columns.length > 0) {
				findings.push(
					createProbeFinding(
						`no-created-at-${table.name}`,
						`Table '${table.name}' lacks created_at timestamp`,
						`The table '${table.name}' does not have a created_at timestamp column. Timestamps are useful for auditing and debugging.`,
						"LOW",
						{
							suggestion: "Consider adding a created_at column with default NOW()",
						},
					),
				);
			}

			if (!hasUpdatedAt && table.columns.length > 0) {
				findings.push(
					createProbeFinding(
						`no-updated-at-${table.name}`,
						`Table '${table.name}' lacks updated_at timestamp`,
						`The table '${table.name}' does not have an updated_at timestamp column.`,
						"INFO",
						{
							suggestion: "Consider adding an updated_at column with automatic updates",
						},
					),
				);
			}
		}

		// Check for pending migrations
		const pendingMigrations = output.migrations.filter((m) => !m.applied);
		if (pendingMigrations.length > 0) {
			findings.push(
				createProbeFinding(
					"pending-migrations",
					`${pendingMigrations.length} pending migration(s)`,
					`There are ${pendingMigrations.length} migration(s) that have not been applied: ${pendingMigrations.map((m) => m.name).join(", ")}`,
					"MEDIUM",
					{
						suggestion: "Run pending migrations before deployment",
					},
				),
			);
		}

		// Check for connection without SSL
		if (output.connection_info?.ssl === false) {
			findings.push(
				createProbeFinding(
					"no-ssl-connection",
					"Database connection does not use SSL",
					"The database connection is configured without SSL encryption. This can expose data in transit.",
					"HIGH",
					{
						suggestion: "Enable SSL for database connections in production",
					},
				),
			);
		}

		// Check for hardcoded credentials in connection info
		if (output.connection_info?.host && !output.connection_info.host.includes("environment")) {
			// This is a heuristic - could check for password in raw files
			findings.push(
				createProbeFinding(
					"potential-hardcoded-connection",
					"Database connection may have hardcoded values",
					"The database connection appears to have hardcoded host/port values. Consider using environment variables.",
					"INFO",
					{
						suggestion: "Use environment variables for database connection parameters",
					},
				),
			);
		}

		return findings;
	}

	/**
	 * Format output for human-readable display
	 */
	formatOutput(output: PostgresProbeOutput): string {
		const lines: string[] = [];

		lines.push("# PostgreSQL Database Analysis");
		lines.push("");

		// Connection info
		if (output.connection_info?.host) {
			lines.push("## Connection");
			lines.push(`Host: ${output.connection_info.host}`);
			if (output.connection_info.port) {
				lines.push(`Port: ${output.connection_info.port}`);
			}
			if (output.connection_info.database) {
				lines.push(`Database: ${output.connection_info.database}`);
			}
			if (output.connection_info.ssl !== undefined) {
				lines.push(`SSL: ${output.connection_info.ssl ? "enabled" : "disabled"}`);
			}
			lines.push("");
		}

		// Tables
		lines.push(`## Tables (${output.tables.length})`);
		for (const table of output.tables) {
			lines.push(`### ${table.schema}.${table.name}`);
			lines.push("| Column | Type | Nullable | Key |");
			lines.push("|--------|------|----------|-----|");
			for (const column of table.columns) {
				const key = column.is_primary ? "PK" : column.is_foreign ? "FK" : "";
				lines.push(
					`| ${column.name} | ${column.type} | ${column.nullable ? "YES" : "NO"} | ${key} |`,
				);
			}
			lines.push("");
		}

		// Migrations
		if (output.migrations.length > 0) {
			lines.push(`## Migrations (${output.migrations.length})`);
			for (const migration of output.migrations) {
				const status = migration.applied ? "✓" : "○";
				lines.push(`- ${status} ${migration.name}`);
			}
			lines.push("");
		}

		// Extensions
		if (output.extensions.length > 0) {
			lines.push(`## Extensions (${output.extensions.length})`);
			for (const ext of output.extensions) {
				lines.push(`- ${ext}`);
			}
			lines.push("");
		}

		// Issues
		if (output.issues.length > 0) {
			lines.push(`## Issues (${output.issues.length})`);
			for (const issue of output.issues) {
				lines.push(`- [${issue.severity}] ${issue.title}`);
				lines.push(`  ${issue.description}`);
			}
		}

		return lines.join("\n");
	}

	/**
	 * Parse raw output (for BaseProbe compatibility)
	 */
	parseOutput(rawOutput: string): PostgresProbeOutput {
		try {
			const parsed = JSON.parse(rawOutput);
			return parsed as PostgresProbeOutput;
		} catch {
			return {
				tables: [],
				migrations: [],
				extensions: [],
				issues: [],
			};
		}
	}

	/**
	 * Convert string to snake_case
	 */
	private toSnakeCase(str: string): string {
		return str
			.replace(/([A-Z])/g, "_$1")
			.toLowerCase()
			.replace(/^_/, "");
	}

	/**
	 * Allow continuation when commands fail
	 * We can still parse files without database access
	 */
	protected shouldContinueOnFailure(_result: CommandResult): boolean {
		return true;
	}
}

/**
 * Create a PostgreSQL probe with optional configuration overrides
 */
export function createPostgresProbe(configOverrides?: Partial<ProbeConfig>): PostgresProbe {
	return new PostgresProbe(configOverrides);
}

/**
 * Detect the ORM/framework in use in a directory
 */
export function detectOrmFramework(workDir: string): string {
	const probe = new PostgresProbe();
	return probe.detectFramework(workDir);
}

/**
 * Parse a Prisma schema file
 */
export function parsePrismaSchemaFile(filePath: string): PrismaSchema {
	const probe = new PostgresProbe();
	const content = fs.readFileSync(filePath, "utf-8");
	return probe.parsePrismaSchema(content);
}

/**
 * Find all migration files in a directory
 */
export function findMigrationFiles(workDir: string, framework?: string): PostgresMigration[] {
	const probe = new PostgresProbe();
	const detectedFramework = framework ?? probe.detectFramework(workDir);
	return probe.findMigrations(workDir, detectedFramework);
}

/**
 * Check if a directory has PostgreSQL database configuration
 */
export function hasPostgresConfig(workDir: string): boolean {
	const probe = new PostgresProbe();
	const framework = probe.detectFramework(workDir);
	return framework !== "generic" || fs.existsSync(path.join(workDir, ".env"));
}

/**
 * Extract PostgreSQL connection info from a directory
 */
export function extractPostgresConnectionInfo(
	workDir: string,
): PostgresProbeOutput["connection_info"] {
	const probe = new PostgresProbe();
	return probe.extractConnectionInfo(workDir);
}

/**
 * Get table names from schema files
 */
export async function getTableNames(workDir: string): Promise<string[]> {
	const probe = new PostgresProbe();
	const framework = probe.detectFramework(workDir);
	const tables = await probe.parseSchemaFiles(workDir, framework);
	return tables.map((t) => t.name);
}

/**
 * Analyze a database schema for issues
 */
export function analyzeDatabaseSchema(tables: PostgresTable[]): ProbeFinding[] {
	const probe = new PostgresProbe();
	const output: PostgresProbeOutput = {
		tables,
		migrations: [],
		extensions: [],
		issues: [],
	};
	return probe.extractFindings(output);
}

/**
 * Format PostgreSQL probe output as markdown
 */
export function formatPostgresOutputAsMarkdown(output: PostgresProbeOutput): string {
	const probe = new PostgresProbe();
	return probe.formatOutput(output);
}

/**
 * Get migration statistics
 */
export function getMigrationStats(migrations: PostgresMigration[]): {
	total: number;
	applied: number;
	pending: number;
} {
	const applied = migrations.filter((m) => m.applied).length;
	return {
		total: migrations.length,
		applied,
		pending: migrations.length - applied,
	};
}

/**
 * Check for common database anti-patterns
 */
export function checkDatabaseAntiPatterns(tables: PostgresTable[]): ProbeFinding[] {
	const findings: ProbeFinding[] = [];

	for (const table of tables) {
		// Check for too many columns
		if (table.columns.length > 30) {
			findings.push(
				createProbeFinding(
					`too-many-columns-${table.name}`,
					`Table '${table.name}' has ${table.columns.length} columns`,
					`Tables with many columns can indicate poor normalization or a "god table" anti-pattern.`,
					"MEDIUM",
					{
						suggestion: "Consider splitting into multiple related tables",
					},
				),
			);
		}

		// Check for generic column names
		const genericNames = ["data", "value", "info", "misc", "other", "extra"];
		for (const column of table.columns) {
			if (genericNames.includes(column.name.toLowerCase())) {
				findings.push(
					createProbeFinding(
						`generic-column-name-${table.name}-${column.name}`,
						`Column '${column.name}' in '${table.name}' has a generic name`,
						`Generic column names like '${column.name}' can indicate poor schema design and reduce code readability.`,
						"LOW",
						{
							suggestion: "Use descriptive column names that indicate the data's purpose",
						},
					),
				);
			}
		}

		// Check for EAV (Entity-Attribute-Value) pattern indicators
		const hasKeyColumn = table.columns.some((c) =>
			["key", "attribute", "attribute_name", "property"].includes(c.name.toLowerCase()),
		);
		const hasValueColumn = table.columns.some((c) =>
			["value", "attribute_value", "property_value"].includes(c.name.toLowerCase()),
		);

		if (hasKeyColumn && hasValueColumn) {
			findings.push(
				createProbeFinding(
					`eav-pattern-${table.name}`,
					`Table '${table.name}' may use EAV anti-pattern`,
					"The table appears to use Entity-Attribute-Value pattern which can cause query complexity and performance issues.",
					"MEDIUM",
					{
						suggestion: "Consider using JSONB columns or proper normalization",
					},
				),
			);
		}
	}

	return findings;
}
