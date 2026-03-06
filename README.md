# Milhouse

**Correctness-first AI coding orchestrator**

Milhouse investigates before it acts and verifies after. Instead of throwing a prompt at an AI and hoping, it runs a structured pipeline: scan the codebase, validate findings with evidence, plan tasks, execute in isolated worktrees, and verify through quality gates.

## v0.3 — Rewrite from scratch

v0.3 is a complete rewrite. Same pipeline concept, 95% less code.

| | v0.2 | v0.3 |
|---|---|---|
| Lines of code | 68,000 | ~3,000 |
| Files | 242 | 17 |
| Dependencies | 17 | 2 |
| Config systems | 4 | 1 |
| Engine abstractions | 7 | 1 |

---

## Quick Start

```bash
# Install
npm install -g milhouse-cli

# Initialize project
cd your-project
milhouse --init

# Run full pipeline
milhouse "fix authentication bugs"
```

---

## How It Works

```
scan → validate → plan → consolidate → exec → verify
 LI       IV       PL       CDM         EX      TV
```

| Phase | Agent | What happens |
|-------|-------|-------------|
| **scan** | Lead Investigator | Analyzes codebase, identifies work items (bugs, features, refactors) |
| **validate** | Issue Validator | Validates each finding with file:line evidence |
| **plan** | Planner | Generates WBS — tasks with dependencies and acceptance criteria |
| **consolidate** | Dependency Manager | Deduplicates tasks, resolves cross-issue dependencies, assigns parallel groups |
| **exec** | Executor | Executes tasks in isolated git worktrees, one per issue |
| **verify** | Truth Verifier | Runs quality gates, blocks unverified changes |

---

## CLI

```bash
# Full pipeline
milhouse "fix auth bugs"                    # Scope from positional args
milhouse --run --scope "frontend perf"      # Explicit scope

# Single phase
milhouse --scan --scope "security"
milhouse --validate
milhouse --plan
milhouse --exec --workers 5

# Resume after failure
milhouse --resume
milhouse --resume --run-id run-20260304-xxx

# Report
milhouse --report                           # Terminal format
milhouse --report --format md               # Markdown format
milhouse --report --run-id run-20260304-xxx # Specific run

# Options
milhouse --engine gemini "fix bugs"         # Use Gemini CLI
milhouse --model opus "fix bugs"            # Override model
milhouse --workers 5 "fix bugs"             # Parallel exec workers
milhouse -v --run                           # Verbose output
```

---

## Configuration

`milhouse --init` creates `.milhouse/config.ts`:

```typescript
import type { Config } from "milhouse";

const config: Config = {
  // AI engine: "claude" | "gemini" | "aider"
  engine: "claude",
  model: "sonnet",

  // Pipeline phases (remove to skip)
  pipeline: ["scan", "validate", "plan", "consolidate", "exec", "verify"],

  // Per-phase settings
  phases: {
    scan:        { workers: 1, retries: 2 },
    validate:    { workers: 5, retries: 2 },
    plan:        { workers: 5, retries: 3 },
    consolidate: { workers: 1, retries: 2 },
    exec:        { workers: 3, retries: 3 },
    verify:      { workers: 5, retries: 1 },
  },

  // Project info
  project: { name: "my-app", language: "typescript", framework: "express", description: "" },
  commands: { test: "bun test", lint: "biome check", build: "bun run build" },

  // Rules injected into every prompt
  rules: [
    "Never modify migration files",
    "Always use parameterized SQL queries",
  ],

  // Files agents must never touch
  boundaries: { neverTouch: ["migrations/**", ".env*"] },

  // Quality gates
  gates: { evidence: true, diffHygiene: true, placeholder: true, dod: true },

  // Cost budget ($0 = unlimited)
  cost: { inputPerMillion: 5, outputPerMillion: 25, budget: 50 },
};

export default config;
```

CLI flags override config: `milhouse --workers 5 --model opus --run`.

---

## AI Engines

Milhouse spawns CLI tools as child processes — no API keys in your config:

| Engine | Command | Notes |
|--------|---------|-------|
| **Claude Code** (default) | `claude` | Stream JSON output, token tracking |
| **Gemini CLI** | `gemini` | Text output |
| **Aider** | `aider` | Text output, `--yes-always --no-git` |

```bash
milhouse --engine claude "fix bugs"     # Default
milhouse --engine gemini "fix bugs"
milhouse --engine aider "fix bugs"
```

---

## Quality Gates

Every completed task passes through verification gates:

| Gate | What it blocks |
|------|----------------|
| **Evidence** | Claims without commit or file:line proof |
| **Diff Hygiene** | Silent refactors, whitespace changes, unrelated files |
| **Placeholder** | `TODO`, `FIXME`, `mock`, stub code |
| **DoD** | Unmet acceptance criteria |

Disable any gate in config: `gates: { placeholder: false }`.

---

## Parallel Execution

Exec phase runs issues in parallel using git worktrees:

```bash
milhouse --exec --workers 5    # 5 issues in parallel
```

Each issue gets its own branch (`mh/<issue-id>`) and worktree. Branches merge automatically after completion. Failed merges are skipped with `--abort`.

---

## Run State

Each run creates a directory under `.milhouse/runs/`:

```
.milhouse/
├── config.ts                   # Your config
├── runs-index.json             # All runs
└── runs/
    └── run-20260304-xxx/
        ├── meta.json           # Phase, timing, stats
        ├── state/
        │   ├── issues.json     # Scanned + validated issues
        │   ├── tasks.json      # Planned tasks with status
        │   └── verification.json
        └── plans/
            └── P-xxx.md        # Per-issue execution plans
```

Resume picks up from the last completed phase:

```bash
milhouse --resume              # Latest run
milhouse --resume --run-id run-20260304-xxx
```

---

## Architecture

```
src/
├── index.ts          CLI entry point (parseArgs)
├── config.ts         loadConfig + deepMerge + defaults
├── pipeline.ts       Phase loop with budget gate
├── runner.ts         Execute one phase: parallel AI calls + retry
├── engine.ts         Spawn claude/gemini/aider + parse output
├── state.ts          RunStore: all JSON read/write
├── git.ts            Worktree create/cleanup/merge
├── cost.ts           Token counting + budget
├── report.ts         Run report generation
├── types.ts          All types in one file
├── ui.ts             Spinner + colored logger
├── util.ts           JSON extraction + helpers
├── prompts/
│   ├── base.ts       PromptBuilder (shared patterns)
│   ├── scan.ts       Lead Investigator prompt
│   ├── validate.ts   Issue Validator prompt
│   ├── plan.ts       Planner prompt
│   ├── consolidate.ts Dependency Manager prompt
│   ├── exec.ts       Executor prompt
│   └── verify.ts     Truth Verifier prompt
└── phases/
    ├── scan.ts       loadItems → prompt → parse → save
    ├── validate.ts
    ├── plan.ts
    ├── consolidate.ts
    ├── exec.ts
    └── verify.ts
```

Every phase implements the same interface:

```typescript
interface PhaseConfig<TItem, TResult> {
  name: Phase;
  schema?: Record<string, unknown>;
  maxTurns?: number;
  timeout?: number;
  loadItems(store, config): TItem[];
  buildPrompt(item, store, config): string;
  parseResponse(response, item): TResult;
  saveResults(results, store): void;
}
```

---

## Dependencies

```json
{
  "dependencies": {
    "p-limit": "^7.2.0",
    "picocolors": "^1.1.1"
  }
}
```

Everything else is built-in: `util.parseArgs` for CLI, `Bun.spawn` for processes, `fs` for state.

---

## Development

```bash
git clone https://github.com/eizorerad/milhouse.git
cd milhouse
pnpm install

# Dev mode
bun run src/index.ts "fix bugs"

# Tests
bun test

# Build
bun run build

# Type check
pnpm typecheck
```

Requires [Bun](https://bun.sh) ≥ 1.0.

---

## License

MIT

---

**Stop guessing. Start verifying.**
