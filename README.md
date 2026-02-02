# Milhouse

[![npm version](https://img.shields.io/npm/v/milhouse-cli.svg?style=flat-square)](https://www.npmjs.com/package/milhouse-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

**Evidence-Based AI Pipeline Orchestrator**

---

## ❌ Without Milhouse

AI coding assistants work blind. You get:

- ❌ **Cleaning code after vibe-coding** — AI changes code without understanding the problem 
- ❌ **Hallucinated fixes** — AI guesses the root cause without checking the environment
- ❌ **Silent refactors** — Changes you didn't ask for sneak into the codebase
- ❌ **TODO stubs** — "Implementation left as exercise" placeholders everywhere
- ❌ **Broken dependencies** — AI doesn't check if changes break other code
- ❌ **No verification** — You have to manually verify every change

---

## ✅ With Milhouse

Milhouse investigates before it acts — and verifies after:

```bash
milhouse --scan --scope "authentication bugs"
milhouse --validate    # ← Runs probes: database, cache, env, deps
milhouse --plan        # ← Creates WBS with DoD and dependencies  
milhouse --exec        # ← Executes with evidence verification
```

**SCAN → VALIDATE → PLAN → CONSOLIDATE → EXEC → VERIFY**

Milhouse:
- ✅ **Vibe-code auto cleaner** — Scans and fixes vibe-coded changes automatically, no need for manual cleanup
- ✅ **Diagnoses with probes** — PostgreSQL, Redis, Docker, dependencies audited
- ✅ **Plans with evidence** — Every claim backed by file:line or probe results
- ✅ **Blocks bad patterns** — Gates catch placeholders, silent refactors, env mismatches
- ✅ **Respects dependencies** — Tasks execute in correct order based on dep graph
- ✅ **Verifies results** — 5 gates must pass before any task is marked complete

---

## 🚀 Quick Start

### Option 1: Install from npm (Recommended)

```bash
# Install globally
npm install -g milhouse-cli

# Initialize in your project
cd your-project
milhouse --init

# Start with human in the loop (scan and plan, no execution)
milhouse --run --end-phase consolidate --severity CRITICAL,HIGH

# Execute the plan 
milhouse --run --start-phase exec --severity CRITICAL,HIGH
```

### Option 2: Install from source (For contributors)

```bash
git clone https://github.com/eizorerad/milhouse.git
cd milhouse
```

#### Using Bun (Recommended)

```bash
# Install Bun if not already installed
# Windows:
powershell -c "irm bun.sh/install.ps1 | iex"
# macOS/Linux:
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install

# Build the binary for your platform
bun run build:windows   # Windows
bun run build:mac-arm   # macOS Apple Silicon
bun run build:mac-x64   # macOS Intel
bun run build:linux     # Linux

# Link globally
bun link

# Now you can use milhouse anywhere
cd your-project
milhouse --init
```

#### Using pnpm

```bash
# Install dependencies
pnpm install

# Setup pnpm global bin directory (first time only)
pnpm setup
# Restart your terminal after this

# Link globally
pnpm link --global

# Now you can use milhouse anywhere
cd your-project
milhouse --init
```

> **Note:** When using pnpm, you need Bun or tsx installed to run in dev mode, or build the binary first with `bun run build:windows` (or your platform).

### Or start with fully automatic execution

```bash
# Run with severity filter (WARNING: automatic execution!)
milhouse --run --min-severity HIGH --scope "frontend performance"
```
```bash
# or like this
milhouse --run --opencode --tmux --model "amazon-bedrock/anthropic.claude-opus-4-5-20251101-v1:0" --scope "logic" --severity CRITICAL,HIGH
```

That's it. Milhouse scans → validates → plans → executes → verifies.

---

## 🔧 Installation

### Cursor
Add to your MCP settings:
```json
{
  "mcpServers": {
    "milhouse": {
      "command": "npx",
      "args": ["-y", "milhouse-cli", "mcp"]
    }
  }
}
```

### Claude Code
```bash
claude mcp add milhouse -- npx -y milhouse-cli mcp
```

### Standalone CLI
```bash
npm install -g milhouse-cli
milhouse --help
```

---

## 🎯 The Pipeline

![Milhouse Pipeline Flow](docs/flow.png)

### 7 AI Agents

| Agent | Role |
|-------|------|
| **LI** | Lead Investigator — scans codebase, identifies candidate issues |
| **IV** | Issue Validator — runs probes, collects evidence |
| **PL** | Planner — generates Work Breakdown Structure per issue |
| **PR** | Plan Reviewer — reviews and refines WBS |
| **CO** | Consolidator — merges plans, builds dependency graph |
| **EX** | Executor — runs tasks in isolated worktrees |
| **VE** | Verifier — blocks claims without evidence |

---

## 🔍 Probes (Evidence Collection)

Milhouse runs **read-only probes** automatically during validation and planning to collect evidence:

| Probe | What it checks |
|-------|----------------|
| **ETI** (compose) | Docker Compose topology, k8s manifests, .env files |
| **DLA** (postgres) | PostgreSQL schemas, migrations, constraints |
| **CA** (redis) | Redis TTL, keyspace, prefix patterns |
| **SI** (storage) | S3/MinIO buckets, filesystem structure |
| **DVA** (deps) | Package lockfile vs installed versions |
| **RR** (repro) | Logs, reproduction steps |

### Automatic Probe Execution

Probes run automatically when you validate or plan issues:

```bash
# Probes auto-run during validation
milhouse --validate

# Probes auto-run during planning (or reuse validation results)
milhouse --plan

# Skip probes for AI-only mode (not recommended)
milhouse --validate --skip-probes

# Results saved to .milhouse/probes/
```

Probes detect applicable infrastructure automatically:
- If `docker-compose.yml` exists, runs **compose** probe
- If Prisma/database config exists, runs **postgres** probe
- If Redis config exists, runs **redis** probe
- Dependencies probe always runs

Probe results are included in the validation/planning prompts to give AI agents concrete evidence about your infrastructure.

---

## 🚧 Gates (Verification)

Every task must pass **5 gates** before completion:

| Gate | What it blocks |
|------|----------------|
| **Evidence** | Claims without `file:line` or `probe_id` proof |
| **Diff Hygiene** | Silent refactors, whitespace bombs, extra files |
| **Placeholder** | `TODO`, `mock`, `return true` stubs |
| **Env Consistency** | DB/cache/storage issues without probe evidence |
| **DoD** | Unverifiable definitions of done |

---

## 🤖 AI Engines

Milhouse works with 8 AI coding assistants:

```bash
milhouse                    # Claude Code (default)
milhouse --opencode         # OpenCode
milhouse --gemini           # Gemini
milhouse --aider           # AIder
milhouse --cursor           # Cursor
milhouse --codex            # Codex
milhouse --qwen             # Qwen-Code
milhouse --droid            # Factory Droid
```

### Model Override

```bash
milhouse --model sonnet "fix auth bug"
milhouse --sonnet "add feature"     # shortcut
```

---

## 📋 Task Sources

| Source | Command |
|--------|---------|
| Markdown file | `milhouse --input tasks.md` |
| Folder of specs | `milhouse --tasks ./specs/` |
| YAML tasks | `milhouse --yaml tasks.yaml` |
| GitHub Issues | `milhouse --github owner/repo` |

---

## ⚡ Parallel Execution

### By Issue (Recommended)

```bash
milhouse --exec --exec-by-issue --workers 3
```

Each issue runs in its own worktree. One agent handles ALL tasks for that issue — better context, fewer switches.

### By Task

```bash
milhouse --workers 5
```

### Task Isolation

```bash
milhouse --exec --isolate          # Isolate each task in its own worktree
milhouse --exec --pr               # Create PR after each task
milhouse --exec --pr --draft       # Create draft PRs
```

---

## 🎚️ Issue Filtering

```bash
# Only specific issues
milhouse --validate --issues P-001,P-002

# Exclude issues
milhouse --plan --exclude-issues P-003

# By severity
milhouse --exec --min-severity HIGH
milhouse --validate --severity CRITICAL,HIGH
```

---

## 🔄 Retry for UNVALIDATED Issues

### The Problem

Sometimes issues may remain in `UNVALIDATED` status due to:
- API timeouts or rate limits
- Temporary network failures
- AI engine errors
- Probe execution failures

### The Solution

Milhouse automatically retries validation for `UNVALIDATED` issues. After the initial validation pass, any issues that failed to validate are retried up to a configurable number of times.

### CLI Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--max-validation-retries <n>` | Maximum number of retry attempts | `2` |
| `--no-retry-unvalidated` | Disable automatic retry | — |
| `--retry-delay-validation <ms>` | Delay between retry rounds (milliseconds) | `2000` |

### Examples

```bash
# Default: 2 retry attempts with 2s delay
milhouse --validate

# Increase to 5 retry attempts
milhouse --validate --max-validation-retries 5

# Disable retry completely
milhouse --validate --no-retry-unvalidated

# Custom delay between retries (5 seconds)
milhouse --validate --retry-delay-validation 5000

# Combine with other options
milhouse --validate --issues P-001,P-002 --max-validation-retries 3
```

---

## 📁 Project Structure

After `milhouse --init`:

```
.milhouse/
├── config.yaml          # Project rules and commands
├── state/
│   ├── issues.json      # Validated issues with evidence
│   ├── tasks.json       # Tasks with status and deps
│   └── graph.json       # Dependency graph
├── probes/              # Evidence from each probe type
├── plans/
│   ├── problem_brief.md # Investigation results
│   └── execution_plan.md# Consolidated plan
└── work/
    └── worktrees/       # Isolated execution environments
```

---

## 🛠️ Configuration

```yaml
# .milhouse/config.yaml
project:
  name: "my-app"
  language: "TypeScript"

commands:
  test: "pnpm test"
  lint: "pnpm lint"

rules:
  - "use server components by default"
  - "no any types"

boundaries:
  never_touch:
    - "src/legacy/**"
```

---

## 🔄 Flag Migration (v4.5.0)

The following flags have been renamed for clarity. Old flags still work but show deprecation warnings:

| Old Flag | New Flag | Notes |
|----------|----------|-------|
| `--parallel` | `--workers` | Enable parallel execution |
| `--max-parallel <n>` | `--workers <n>` | Set worker count |
| `--prd <file>` | `--input <file>` | Task source file |
| `--prd <folder>` | `--tasks <folder>` | Task source folder |
| `--create-pr` | `--pr` | Create pull request |
| `--draft-pr` | `--pr --draft` | Create draft PR |
| `--branch-per-task` | `--isolate` | Task isolation |

Use `--no-deprecation-warnings` to suppress deprecation messages.

---

## 📊 Metrics

| Metric | Value |
|--------|-------|
| Tests | 3,700+ passing |
| Pass Rate | 99.6% |
| AI Engines | 8 supported |
| Probe Types | 6 |
| Gates | 5 |
| Agents | 7 |

---

## 📖 Architecture

Key concepts:
- **7 AI Agents**: LI, IV, PL, PR, CO, EX, VE — each with specific roles in the pipeline
- **6 Probes**: Evidence collection from infrastructure (PostgreSQL, Redis, Docker, etc.)
- **5 Gates**: Verification checkpoints that block bad patterns
- **Run Isolation**: Each execution runs in isolated worktrees with full state management

---

## 📂 Run-Aware Plan Storage

When you run `milhouse --scan`, a new **run** is created with a unique ID (e.g., `run_2024-01-27_12-30-45`). All subsequent pipeline commands (`--validate`, `--plan`, `--consolidate`, `--exec`, `--verify`) operate within this run context.

### Directory Structure

```
.milhouse/
├── runs-index.json              # Tracks all runs and current run
├── runs/
│   └── run_2024-01-27_12-30-45/
│       ├── plans/               # Source of truth for this run's plans
│       │   ├── problem_brief.md
│       │   ├── plan_ISS-001.md
│       │   ├── wbs_ISS-001.json
│       │   └── execution_plan.md
│       └── ...
└── plans/                       # View/export (symlink to current run's plans)
```

### The `.milhouse/plans` View

The `.milhouse/plans` directory is a **view** of the current run's plans:
- On Unix/macOS: It's a symlink pointing to `.milhouse/runs/<currentRunId>/plans`
- On Windows: It's a copy of the current run's plans

This allows tools and scripts that expect plans in `.milhouse/plans` to continue working.

### Migrating Legacy Plans

If you have plans in `.milhouse/plans` from before the run-aware system was introduced, you can import them into the current run:

```bash
# See what would be imported
milhouse runs import-legacy-plans --dry-run

# Actually import the plans
milhouse runs import-legacy-plans
```

---

## 🔒 Run Isolation

Milhouse supports running multiple instances in parallel without data corruption. Each run is isolated in its own directory under `.milhouse/runs/`.

### Specifying a run

Commands that operate on existing runs accept `--run-id`:

```bash
# Use full run ID
milhouse --validate --run-id run-20260128-after-ujb8

# Use partial ID (suffix match)
milhouse --plan --run-id after-ujb8

# Use partial ID (name match)
milhouse --exec --run-id after
```

### Behavior when `--run-id` is not specified

- If only one eligible run exists, it is automatically selected
- If multiple eligible runs exist, an interactive prompt is shown
- If no eligible runs exist, an error is displayed

### Interactive selection

When multiple runs exist and no `--run-id` is specified, you'll be prompted to select one:

```
? Multiple runs available. Which one do you want to use:
❯ run-20260128-after-ujb8 [VALIDATE] - 3 issues - fix auth bug - 2 hours ago
  run-20260127-before-xyz1 [SCAN] - 5 issues - refactor api - 1 day ago
```

---

## 📄 License

MIT

---

<p align="center">
  <b>Stop guessing. Start verifying.</b><br>
  <code>npm install -g milhouse-cli</code>
</p>
