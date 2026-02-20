# Milhouse

**Correctness-first AI coding orchestrator**

Milhouse investigates before it acts and verifies after. Instead of throwing a prompt at an AI and hoping, it runs a structured pipeline: scan the codebase, validate findings with evidence, plan tasks, execute in isolated worktrees, and verify through quality gates.

---

## Quick Start

```bash
npm install -g milhouse-cli
cd your-project
milhouse --init
milhouse "fix authentication bugs"
```

That runs the full pipeline: **scan** the repo for auth bugs, **validate** each finding, **plan** tasks with dependencies, **execute** in worktrees, **verify** results through 5 quality gates.

---

## How It Works

```
scan → validate → plan → consolidate → exec → verify
 LI       IV       PL       CDM         EX      TV
```

| Phase | Agent | What happens |
|-------|-------|-------------|
| **scan** | LI (Lead Investigator) | Analyzes codebase, identifies work items |
| **validate** | IV (Issue Validator) | Runs probes (Postgres, Redis, Docker, deps), collects evidence |
| **plan** | PL (Planner) | Generates WBS with tasks, dependencies, acceptance criteria |
| **consolidate** | CDM (Consolidator) | Deduplicates, builds dependency graph, assigns parallel groups |
| **exec** | EX (Executor) | Executes tasks in isolated git worktrees |
| **verify** | TV (Truth Verifier) | Runs 5 quality gates, blocks unverified changes |

Each phase can run independently (`milhouse --scan`, `milhouse --validate`, etc.) or as a full pipeline (`milhouse --run`).

---

## Configuration

`milhouse --init` creates `.milhouse/config.ts` — one file where everything is configured:

```typescript
import type { Config } from "milhouse";

const config: Config = {
  // Which phases to run and in what order. Remove a phase to skip it.
  pipeline: ["scan", "validate", "plan", "consolidate", "exec", "verify"],

  // Per-phase: workers (parallel agents), retries, model override
  phases: {
    scan:     { workers: 1, retries: 2 },
    validate: { workers: 5, retries: 2 },
    plan:     { workers: 5, retries: 3 },
    exec:     { workers: 3, retries: 3 },
    verify:   { workers: 1, retries: 1 },
  },

  // Project info (auto-detected)
  project: { name: "my-app", language: "typescript", framework: "express" },
  commands: { test: "bun test", lint: "biome check", build: "bun run build" },

  // Rules injected into every agent prompt
  rules: [
    "Never modify migration files",
    "Always use parameterized SQL queries",
  ],

  // Files agents must never touch
  boundaries: { neverTouch: ["migrations/**", ".env*"] },

  // Quality gates (all enabled by default)
  gates: { evidence: true, diffHygiene: true, placeholder: true, dod: true },

  // Cost tracking and budget limit
  cost: { budgetLimit: 10 },  // $10 max per run, 0 = unlimited
};

export default config;
```

CLI flags override config for that run: `milhouse --run --workers 2` uses 2 workers regardless of config.

---

## AI Engines

Milhouse doesn't call APIs directly. It spawns CLI tools as child processes:

```bash
milhouse "fix bugs"              # Claude Code (default)
milhouse --gemini "fix bugs"     # Gemini CLI
milhouse --aider "fix bugs"      # Aider
milhouse --opencode "fix bugs"   # OpenCode
milhouse --codex "fix bugs"      # Codex
milhouse --model sonnet "fix"    # Override model
```

The engine and model can also be set in `.milhouse/config.ts`.

---

## Pipeline Control

```bash
# Full pipeline
milhouse "fix auth bugs"
milhouse --run --scope "frontend performance"

# Partial pipeline
milhouse --run --end-phase consolidate    # Plan only, don't execute
milhouse --run --start-phase exec         # Execute existing plan

# Resume after failure
milhouse --resume

# Individual phases
milhouse --scan --scope "security"
milhouse --validate
milhouse --exec --workers 5
```

---

## Quality Gates

Every task passes 5 gates during verification:

| Gate | What it blocks |
|------|----------------|
| **Evidence** | Claims without `file:line` or probe proof |
| **Diff Hygiene** | Silent refactors, whitespace changes, extra files |
| **Placeholder** | `TODO`, `mock`, `return true` stubs |
| **Env Consistency** | DB/cache changes without probe evidence |
| **DoD** | Unverifiable acceptance criteria |

Gates are configurable in `.milhouse/config.ts`. Set any to `false` to skip.

---

## Probes

Read-only infrastructure probes run during validation:

| Probe | What it checks |
|-------|----------------|
| **compose** | Docker Compose topology, .env files |
| **postgres** | Schemas, migrations, constraints |
| **redis** | TTL, keyspace, prefix patterns |
| **storage** | S3/MinIO buckets, filesystem |
| **deps** | Lockfile vs installed versions |
| **repro** | Logs, reproduction steps |

Probes auto-detect applicable infrastructure. Skip with `--skip-probes`.

---

## Parallel Execution

```bash
milhouse --exec --workers 5        # 5 parallel agents
milhouse --exec --isolate          # Each issue in its own worktree
milhouse --exec --pr               # Create PR per issue
milhouse --exec --pr --draft       # Draft PRs
```

Each issue runs in a dedicated git worktree. Branches merge automatically after all agents complete.

---

## Filtering

```bash
milhouse --validate --issues P-001,P-002       # Specific issues only
milhouse --run --min-severity HIGH             # HIGH and CRITICAL only
milhouse --exec --exclude-issues P-003         # Skip specific issues
milhouse --run --severity CRITICAL,HIGH        # Exact severity match
```

---

## Run Management

Each `--scan` creates a new run. All subsequent phases operate within that run.

```bash
milhouse runs list                # List all runs
milhouse runs info [id]           # Show run details
milhouse runs switch <id>         # Switch active run
milhouse runs delete <id>         # Delete a run
milhouse --run-id <id> --exec     # Use specific run
```

---

## Project Structure

```
.milhouse/
├── config.ts               # Central configuration (edit this)
├── runs/
│   └── run-20260220-xxx/
│       ├── meta.json       # Run metadata and phase status
│       ├── state/
│       │   ├── issues.json # Work items with evidence
│       │   └── tasks.json  # Tasks with dependencies
│       ├── plans/
│       │   ├── problem_brief.md
│       │   └── wbs_P-xxx.md
│       └── probes/         # Probe results
└── work/
    └── worktrees/          # Isolated execution environments
```

---

## Install from Source

```bash
git clone https://github.com/eizorerad/milhouse.git
cd milhouse
pnpm install
pnpm link --global
```

Requires [Bun](https://bun.sh) for runtime and [pnpm](https://pnpm.io) for packages.

---

## License

MIT

---

**Stop guessing. Start verifying.**

```
npm install -g milhouse-cli
```
