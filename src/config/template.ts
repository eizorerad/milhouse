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

const config: Config = {
  // ── AI Engine ──────────────────────────────────────────────
  // CLI tool to use: "claude" | "gemini" | "aider" | "opencode" | "codex" | "qwen" | "droid"
  // If omitted, defaults to "claude".
  // engine: "claude",

  // Model passed to the CLI via --model flag.
  // If omitted, the CLI uses its own default.
  // Examples: "opus", "sonnet", "claude-opus-4-6", "gemini-2.0-flash"
  // model: "opus",

  // ── Pipeline ───────────────────────────────────────────────
  // Which phases to run and in what order. Remove a phase to skip it.
  pipeline: ["scan", "validate", "plan", "consolidate", "exec", "verify"],
  failFast: false,

  // ── Per-Phase Config ───────────────────────────────────────
  phases: {
    scan:        { workers: 1, retries: 2 },
    validate:    { workers: 5, retries: 2 },
    plan:        { workers: 5, retries: 3 },
    consolidate: { workers: 1, retries: 2 },
    exec:        { workers: 3, retries: 3 },
    verify:      { workers: 1, retries: 1 },
  },

  // ── Cost & Budget ──────────────────────────────────────────
  cost: {
    inputPerMillion: 5,
    outputPerMillion: 25,
    budgetLimit: 0, // 0 = unlimited
  },

  // ── Project Info ───────────────────────────────────────────
  project: {
    name: ${q(detected.name)},
    language: ${q(detected.language)},
    framework: ${q(detected.framework)},
  },

  // ── Commands ───────────────────────────────────────────────
  commands: {
    test: ${q(detected.testCmd)},
    lint: ${q(detected.lintCmd)},
    build: ${q(detected.buildCmd)},
  },

  // ── Rules (injected into all agent prompts) ────────────────
  rules: [],

  // ── Boundaries ─────────────────────────────────────────────
  boundaries: {
    neverTouch: [],
  },

  // ── Execution ──────────────────────────────────────────────
  execution: {
    mode: "branch",   // "in-place" | "branch" | "worktree" | "pr"
    autoCommit: true,
    createPr: false,
    draftPr: true,
    skipMerge: false,
  },

  // ── Quality Gates ──────────────────────────────────────────
  gates: {
    evidence: true,
    diffHygiene: true,
    placeholder: true,
    envConsistency: true,
    dod: true,
  },

  // ── Custom Prompt Instructions (appended per phase) ────────
  // prompts: {
  //   scan: { extraInstructions: "Focus on security vulnerabilities" },
  //   exec: { extraInstructions: "Run tests after every change" },
  // },

  // ── Report ─────────────────────────────────────────────────
  report: {
    enabled: true,
    format: "json", // "json" | "markdown" | "both"
    autoGenerate: true,
  },
};

export default config;
`;
}
