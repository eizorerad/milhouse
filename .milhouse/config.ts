import type { Config } from "milhouse";

const config: Config = {
  // ── AI Engine ──────────────────────────────────────────────
  engine: "claude",
  model: "",

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
    name: "milhouse-cli",
    language: "TypeScript",
    framework: "",
  },

  // ── Commands ───────────────────────────────────────────────
  commands: {
    test: "npm test",
    lint: "npm run lint",
    build: "npm run build",
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
