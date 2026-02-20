/**
 * Template for generating .milhouse/config.ts during `milhouse init`.
 */

export interface DetectedProject {
	name: string;
	language: string;
	framework: string;
	testCmd: string;
	lintCmd: string;
	buildCmd: string;
}

export function generateConfigTs(detected: DetectedProject): string {
	const q = (s: string) => JSON.stringify(s); // quote string

	return `import type { Config } from "milhouse";

/**
 * Milhouse configuration.
 *
 * All fields are optional — omit anything to use the default.
 * CLI flags (e.g. --workers 2) override values here for that run only.
 */
const config: Config = {

  // ═══════════════════════════════════════════════════════════
  // AI ENGINE
  // ═══════════════════════════════════════════════════════════
  //
  // Which CLI tool milhouse spawns to execute prompts.
  // Milhouse doesn't call APIs directly — it runs the CLI as a child process.
  //
  // Supported:  "claude" | "gemini" | "aider" | "opencode" | "codex" | "qwen" | "droid"
  // Default:    "claude"  (Claude Code CLI)
  //
  // engine: "claude",

  // Model name passed to the CLI via --model flag.
  // If omitted, the CLI picks its own default model.
  //
  // Claude examples:   "opus", "sonnet", "haiku", "claude-opus-4-6"
  // Gemini examples:   "gemini-2.0-flash", "gemini-2.5-pro"
  // Aider examples:    "gpt-4o", "claude-3-5-sonnet-20241022"
  //
  // model: "opus",

  // ═══════════════════════════════════════════════════════════
  // PIPELINE
  // ═══════════════════════════════════════════════════════════
  //
  // Phases run in order. Remove a phase to skip it entirely.
  //
  //   scan        — LI agent scans repo, identifies work items
  //   validate    — IV agent validates each item with evidence
  //   plan        — PL agent creates WBS (tasks) per item
  //   consolidate — CDM agent deduplicates and orders tasks
  //   exec        — EX agent executes tasks in worktrees
  //   verify      — TV agent runs quality gates
  //
  // Example: skip validation and consolidation:
  //   pipeline: ["scan", "plan", "exec", "verify"],
  //
  pipeline: ["scan", "validate", "plan", "consolidate", "exec", "verify"],

  // Stop the entire pipeline on first phase failure.
  failFast: false,

  // ═══════════════════════════════════════════════════════════
  // PER-PHASE CONFIG
  // ═══════════════════════════════════════════════════════════
  //
  // Each phase can override: model, workers, retries, retryDelay (ms), timeout (ms).
  //
  // workers  — how many parallel agents run in that phase.
  //            scan/consolidate/verify are single-agent (1).
  //            validate/plan process items in parallel.
  //            exec runs issues in parallel worktrees.
  //
  // model    — override the global model for this phase only.
  //            Example: use a cheaper model for validation:
  //            validate: { model: "sonnet", workers: 5, retries: 2 },
  //
  phases: {
    scan:        { workers: 1, retries: 2 },
    validate:    { workers: 5, retries: 2 },
    plan:        { workers: 5, retries: 3 },
    consolidate: { workers: 1, retries: 2 },
    exec:        { workers: 3, retries: 3 },
    verify:      { workers: 1, retries: 1 },
  },

  // ═══════════════════════════════════════════════════════════
  // COST & BUDGET
  // ═══════════════════════════════════════════════════════════
  //
  // Token pricing for cost tracking (displayed in summaries).
  // budgetLimit: max $ per pipeline run. 0 = unlimited.
  //
  // Example: cap at $5 per run:
  //   cost: { inputPerMillion: 5, outputPerMillion: 25, budgetLimit: 5 },
  //
  cost: {
    inputPerMillion: 5,
    outputPerMillion: 25,
    budgetLimit: 0,
  },

  // ═══════════════════════════════════════════════════════════
  // PROJECT INFO  (auto-detected by \`milhouse init\`)
  // ═══════════════════════════════════════════════════════════
  //
  // Used in agent prompts to give context about the project.
  //
  project: {
    name: ${q(detected.name)},
    language: ${q(detected.language)},
    framework: ${q(detected.framework)},
    // description: "Brief description of the project",
  },

  // ═══════════════════════════════════════════════════════════
  // COMMANDS  (auto-detected by \`milhouse init\`)
  // ═══════════════════════════════════════════════════════════
  //
  // Shell commands agents use to test/lint/build.
  // Empty string = not available.
  //
  commands: {
    test: ${q(detected.testCmd)},
    lint: ${q(detected.lintCmd)},
    build: ${q(detected.buildCmd)},
    // compile: "tsc --noEmit",
  },

  // ═══════════════════════════════════════════════════════════
  // RULES
  // ═══════════════════════════════════════════════════════════
  //
  // Injected into every agent prompt as "## Project Rules".
  // Use for project-specific constraints agents must follow.
  //
  // Examples:
  //   "Never modify migration files",
  //   "Always use parameterized SQL queries",
  //   "Use Bun APIs instead of Node.js where possible",
  //   "All new functions must have JSDoc comments",
  //   "Import order: node builtins, external deps, local modules",
  //
  rules: [],

  // ═══════════════════════════════════════════════════════════
  // BOUNDARIES
  // ═══════════════════════════════════════════════════════════
  //
  // Glob patterns for files agents must never touch.
  //
  // Examples:
  //   "migrations/**",
  //   ".env*",
  //   "package-lock.json",
  //   "vendor/**",
  //
  boundaries: {
    neverTouch: [],
  },

  // ═══════════════════════════════════════════════════════════
  // EXECUTION
  // ═══════════════════════════════════════════════════════════
  //
  // How the exec phase runs tasks.
  //
  // mode:
  //   "in-place"  — modify files directly (no branches)
  //   "branch"    — one branch per issue (default)
  //   "worktree"  — git worktree per issue (full isolation)
  //   "pr"        — branch + auto-create pull request
  //
  execution: {
    mode: "branch",
    autoCommit: true,   // commit after each task
    createPr: false,    // create PR after exec completes
    draftPr: true,      // PRs created as draft
    skipMerge: false,   // skip auto-merge of branches after exec
  },

  // ═══════════════════════════════════════════════════════════
  // QUALITY GATES
  // ═══════════════════════════════════════════════════════════
  //
  // Gates run during the verify phase. Set to false to skip a gate.
  //
  //   evidence       — require evidence for all claims
  //   diffHygiene    — check for debug code, TODO markers, etc.
  //   placeholder    — detect placeholder/stub implementations
  //   envConsistency — verify environment didn't change unexpectedly
  //   dod            — Definition of Done (acceptance criteria) check
  //
  gates: {
    evidence: true,
    diffHygiene: true,
    placeholder: true,
    envConsistency: true,
    dod: true,
  },

  // ═══════════════════════════════════════════════════════════
  // CUSTOM PROMPT INSTRUCTIONS
  // ═══════════════════════════════════════════════════════════
  //
  // Extra instructions appended to agent prompts per phase.
  // Unlike "rules" (which apply to ALL phases), these target a specific phase.
  //
  // Example:
  //   prompts: {
  //     scan:  { extraInstructions: "Focus on security vulnerabilities and SQL injection" },
  //     exec:  { extraInstructions: "Run the full test suite after every file change" },
  //     plan:  { extraInstructions: "Keep tasks small — max 3 files per task" },
  //   },
  //

  // ═══════════════════════════════════════════════════════════
  // REPORT
  // ═══════════════════════════════════════════════════════════
  //
  // Auto-generated after pipeline completes.
  //
  report: {
    enabled: true,
    format: "json",      // "json" | "markdown" | "both"
    autoGenerate: true,  // generate report automatically after pipeline run
  },
};

export default config;
`;
}
