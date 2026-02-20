# Milhouse 0.2.0 — Total Runner Refactoring

## Overview

Complete rewrite of the pipeline execution layer into a single configurable runner.
Lives in a **separate repository** at `C:\Users\eizo\Documents\Projects\milhouse-020` (sibling to `milhouse/`, separate git). TUI/CLI interface preserved from current version.

> **Source**: Original milhouse at `C:\Users\eizo\Documents\Projects\milhouse`
> **Target**: New project at `C:\Users\eizo\Documents\Projects\milhouse-020`

### Design principles

1. **One runner, many configs** — no duplicated execution logic
2. **Config-first** — `.milhouse/config.yml` drives everything, CLI flags override
3. **Machine-readable** — other AI agents will call milhouse; outputs must be parseable
4. **Stateless runs** — no global `current_run` pointer, explicit `runId` everywhere
5. **Cost-aware** — every run tracks token usage and dollar cost
6. **Transparent** — structured reports for both humans and machines

### What changes
- 5 phase command files (5100 lines) → 1 PhaseRunner + 5 configs (~1500 lines)
- `current_run` global pointer removed — fully stateless run management
- All state operations use explicit `runId` (no implicit current run)
- Unified pool parallelism (no more batch vs pool inconsistency)
- `--json-schema` automatic for all phases
- Atomic writes + run-level locks for concurrent safety
- One tmux implementation instead of 5 copies
- Per-project config with per-phase model selection
- Cost tracking with configurable pricing
- Structured run reports (JSON + optional markdown)

### Architecture decision: Pool over Batch

**Decision: All phases use pool (p-limit) parallelism. Batch is removed.**

Current milhouse has two strategies:
- validate uses pool (agents grab next item as soon as they finish)
- plan uses batch (wait for all N agents to finish, then next N)

Batch wastes time — if one agent takes 5 min and others take 1 min, two agents sit idle for 4 min. Pool has zero idle time. With 12 items and 3 agents, pool saves ~40% wall time.

PhaseRunner implements only pool via `pLimit(maxParallel)`. No batch mode, no strategy selection, no configuration for this. One strategy, everywhere.

### What stays
- TUI: spinners, progress bars, color theme — copied as-is
- CLI args: same interface, same flags
- Exec phase: stays specialized (writes code, manages worktrees)
- State file format: `.milhouse/runs/<runId>/` structure unchanged
- All engine plugins: claude, gemini, opencode, etc.
- Tmux mode for OpenCode

### What's NOT in 0.2.0
- No web dashboard (CLI only — by design)
- No human-in-the-loop interactive mode
- No incremental scans (doesn't work for AI analysis)
- No learning from errors (validation step covers this)

---

## Project Structure

```
C:\Users\eizo\Documents\Projects\milhouse-020\
├── src/
│   ├── index.ts                      # Entry point (from current)
│   │
│   ├── config/
│   │   ├── loader.ts                 # NEW: Load + merge config.yml + CLI flags
│   │   ├── schema.ts                 # NEW: Zod schema for config.yml
│   │   └── defaults.ts              # NEW: Default values
│   │
│   ├── runner/
│   │   ├── phase-runner.ts           # NEW: Single runner for all phases (~300 lines)
│   │   ├── types.ts                  # NEW: PhaseConfig interface (~50 lines)
│   │   ├── cost.ts                   # NEW: Cost calculator (~50 lines)
│   │   └── phases/
│   │       ├── scan.ts               # NEW: Scan config (~80 lines)
│   │       ├── validate.ts           # NEW: Validate config (~100 lines)
│   │       ├── plan.ts               # NEW: Plan config (~100 lines)
│   │       ├── consolidate.ts        # NEW: Consolidate config (~80 lines)
│   │       └── verify.ts             # NEW: Verify config (~100 lines)
│   │
│   ├── pipeline/
│   │   ├── orchestrator.ts           # Simplified pipeline (replaces pipeline.ts)
│   │   └── run-manager.ts            # Stateless run management (no current_run)
│   │
│   ├── report/
│   │   ├── generator.ts              # NEW: Run report generator
│   │   ├── json-report.ts            # NEW: Machine-readable JSON report
│   │   └── markdown-report.ts        # NEW: Optional human-readable markdown
│   │
│   ├── state/                        # FROM CURRENT (cleaned up)
│   │   ├── types.ts                  # Schemas (minus AuditEntry, minus current_run)
│   │   ├── runs.ts                   # Run CRUD (minus getCurrentRun/setCurrentRun)
│   │   ├── issues.ts                 # Only ForRun API
│   │   ├── tasks.ts                  # Only ForRun API
│   │   ├── graph.ts                  # ForRun API
│   │   ├── executions.ts             # ForRun API
│   │   ├── probes.ts                 # ForRun API
│   │   ├── plan-store.ts             # ForRun API
│   │   ├── run-lock.ts               # NEW: Per-run execution locks
│   │   └── file-lock.ts              # FROM CURRENT (cross-process locks)
│   │
│   ├── agents/                       # SIMPLIFIED
│   │   ├── prompts/                  # Only prompt builders (no BaseAgent classes)
│   │   │   ├── scan.ts
│   │   │   ├── validate.ts
│   │   │   ├── plan.ts
│   │   │   ├── consolidate.ts
│   │   │   ├── verify.ts
│   │   │   └── executor.ts
│   │   └── schemas/                  # JSON schemas for --json-schema
│   │       ├── scan.ts
│   │       ├── validate.ts
│   │       ├── plan.ts
│   │       ├── consolidate.ts
│   │       └── verify.ts
│   │
│   ├── execution/                    # Exec phase (specialized, not in runner)
│   │   ├── exec-command.ts
│   │   ├── issue-executor.ts         # Cleaned: extract merge + tmux
│   │   ├── merge/
│   │   │   └── rebase-merge.ts
│   │   └── tmux/
│   │       └── tmux-executor.ts      # Shared with runner
│   │
│   ├── engines/                      # FROM CURRENT (as-is)
│   ├── gates/                        # FROM CURRENT (as-is)
│   ├── probes/                       # FROM CURRENT (as-is)
│   ├── vcs/                          # FROM CURRENT (as-is)
│   ├── documents/                    # FROM CURRENT (simplified)
│   ├── ui/                           # FROM CURRENT (as-is: spinners, logger, theme)
│   └── cli/
│       ├── args.ts                   # FROM CURRENT (as-is)
│       ├── commands/                 # Thin wrappers that call runner
│       │   ├── scan.ts               # ~30 lines: parse args → runner.run(scanConfig)
│       │   ├── validate.ts           # ~30 lines
│       │   ├── plan.ts               # ~30 lines
│       │   ├── consolidate.ts        # ~30 lines
│       │   ├── exec.ts               # Specialized (delegates to execution/)
│       │   ├── verify.ts             # ~30 lines
│       │   ├── runs.ts               # Run listing/management
│       │   └── report.ts             # NEW: `milhouse report` command
│       └── types.ts
│
├── tests/
├── package.json
├── tsconfig.json
└── biome.json
```

---

## Feature 1: Project Config (`.milhouse/config.yml`)

### Schema

```yaml
# .milhouse/config.yml
version: "0.2"

# Default engine and model
engine: claude
model: opus

# Per-phase model overrides (cost optimization)
phases:
  scan:
    model: sonnet        # Cheaper for code reading
  validate:
    model: sonnet
  plan:
    model: opus          # Needs deep thinking
  exec:
    model: sonnet        # Code writing
  verify:
    model: haiku         # Fast checks

# Parallelism
workers: 5

# Execution
exec:
  auto_commit: true
  create_pr: true
  isolate: true          # Worktree per task
  skip_merge: false

# Cost tracking
cost:
  input_per_million: 5       # $/1M input tokens
  output_per_million: 25     # $/1M output tokens
  budget_limit: 50           # $ max per run (0 = unlimited)

# Report
report:
  enabled: true
  format: json               # json | markdown | both
  auto_generate: true        # Generate after pipeline completes

# Skip options
skip_tests: false
skip_lint: false
skip_probes: false
```

### Precedence: CLI flags > config.yml > defaults

```typescript
// config/loader.ts

interface ResolvedConfig {
  engine: string;
  model: string;
  phases: Record<PipelinePhase, { model?: string }>;
  workers: number;
  cost: { inputPerMillion: number; outputPerMillion: number; budgetLimit: number };
  report: { enabled: boolean; format: "json" | "markdown" | "both"; autoGenerate: boolean };
  // ...
}

function loadConfig(workDir: string, cliOptions: RuntimeOptions): ResolvedConfig {
  // 1. Start with defaults
  const config = { ...DEFAULTS };

  // 2. Merge config.yml (if exists)
  const configPath = join(workDir, ".milhouse", "config.yml");
  if (existsSync(configPath)) {
    const yaml = parseYaml(readFileSync(configPath, "utf-8"));
    deepMerge(config, yaml);
  }

  // 3. CLI flags override everything
  if (cliOptions.aiEngine) config.engine = cliOptions.aiEngine;
  if (cliOptions.modelOverride) config.model = cliOptions.modelOverride;
  if (cliOptions.maxParallel) config.workers = cliOptions.maxParallel;
  // etc.

  return config;
}
```

**Conflict resolution rule: CLI always wins.** Config.yml is baseline, flags are overrides. Simple, no ambiguity.

---

## Feature 2: Cost Tracking

### Calculator

```typescript
// runner/cost.ts

interface CostConfig {
  inputPerMillion: number;    // $/1M input tokens
  outputPerMillion: number;   // $/1M output tokens
  budgetLimit: number;        // $ max per run (0 = unlimited)
}

interface RunCost {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputCost: number;          // $
  outputCost: number;         // $
  totalCost: number;          // $
  byPhase: Record<string, { inputTokens: number; outputTokens: number; cost: number }>;
}

function calculateCost(tokens: { input: number; output: number }, config: CostConfig): number {
  return (tokens.input / 1_000_000) * config.inputPerMillion
       + (tokens.output / 1_000_000) * config.outputPerMillion;
}
```

### Budget enforcement

PhaseRunner checks budget before each agent call:

```typescript
// Inside PhaseRunner.executePool()
const spent = this.runCost.totalCost;
const limit = context.config.cost.budgetLimit;
if (limit > 0 && spent >= limit) {
  throw new BudgetExceededError(`Run budget $${limit} exceeded (spent: $${spent.toFixed(2)})`);
}
```

### Display in summary

```
══════════════════════════════════════════
Scan Summary:
  Items found:   12
  Duration:      9m 29s
  Tokens:        6,254 in / 19,217 out
  Cost:          $0.51                     ← NEW
══════════════════════════════════════════
```

### Display in pipeline summary

```
Pipeline Summary:
  Status:           SUCCESS
  Phases completed: 6/6
  Total duration:   32m 15s
  Total tokens:     45,000 in / 120,000 out
  Total cost:       $3.23                   ← NEW
  Budget remaining: $46.77 / $50.00         ← NEW

  Phase breakdown:
    scan       $0.51  (6K in / 19K out)
    validate   $2.10  (27K in / 82K out)
    plan       $0.35  (8K in / 12K out)
    consolidate $0.05 (2K in / 1K out)
    exec       $0.18  (1K in / 5K out)
    verify     $0.04  (1K in / 1K out)
```

---

## Feature 3: Per-Phase Model Selection

PhaseRunner reads model from resolved config:

```typescript
// Inside PhaseRunner
const phaseModel = context.config.phases[config.name]?.model
  ?? context.config.model;  // Fallback to global

const aiResult = await context.engine.execute(prompt, context.workDir, {
  jsonSchema: config.jsonSchema,
  modelOverride: phaseModel,
});
```

This allows cost optimization:
- **scan/validate** (reads code): Sonnet ($3/$15 per 1M) — saves ~60% vs Opus
- **plan** (strategic thinking): Opus ($5/$25 per 1M) — needs quality
- **exec** (writes code): Sonnet — code gen is good on Sonnet
- **verify** (quick check): Haiku ($0.25/$1.25 per 1M) — saves ~95% vs Opus

---

## Feature 4: Structured Run Report

### Command

```bash
milhouse report                    # Report for latest run
milhouse report --run-id <id>      # Report for specific run
milhouse report --format json      # Machine-readable (default)
milhouse report --format markdown  # Human-readable
milhouse report --format both      # Both files
milhouse --run --no-report         # Disable auto-report
```

### JSON Report (machine-readable)

For other AI agents consuming milhouse output:

```json
{
  "version": "0.2.0",
  "run_id": "run-20260219-find-dlnx",
  "scope": "find and fix bugs",
  "status": "completed",
  "duration_ms": 1935000,
  "cost": {
    "total": 3.23,
    "currency": "USD",
    "by_phase": {
      "scan": { "input_tokens": 6254, "output_tokens": 19217, "cost": 0.51 },
      "validate": { "input_tokens": 27111, "output_tokens": 81605, "cost": 2.10 }
    }
  },
  "results": {
    "items_found": 12,
    "items_confirmed": 11,
    "items_false": 0,
    "items_partial": 1,
    "tasks_created": 34,
    "tasks_completed": 30,
    "tasks_failed": 4,
    "verification_passed": true
  },
  "items": [
    {
      "id": "P-xxx",
      "type": "bug",
      "title": "Evidence merge race condition",
      "severity": "HIGH",
      "status": "CONFIRMED",
      "tasks": ["T-1", "T-2"],
      "pr_url": "https://github.com/org/repo/pull/45"
    }
  ],
  "errors": []
}
```

This format is designed for:
- Other AI agents parsing milhouse output
- CI/CD pipelines checking results
- Dashboards aggregating across repos
- Cost tracking systems

### Markdown Report (optional, human-readable)

Generated only when `--format markdown` or `--format both`. Can be disabled with `--no-report`.

---

## Core: PhaseRunner

### Interface

```typescript
// runner/types.ts

interface PhaseConfig<TItem = unknown, TResult = unknown> {
  /** Phase identity */
  name: PipelinePhase;
  role: AgentRole;

  /** JSON schema for --json-schema (forces structured output) */
  jsonSchema: Record<string, unknown>;

  /** How to run: one agent for all items, or one agent per item */
  mode: "per-item" | "single-agent";

  /** Default parallel agents (overridden by config.workers or --workers) */
  defaultParallel: number;

  /** Load work items for this phase */
  loadItems(runId: string, workDir: string, config: ResolvedConfig): TItem[];

  /** Build the prompt for one item (per-item) or all items (single-agent) */
  buildPrompt(item: TItem, context: PhaseContext): string;

  /** Parse AI response into structured result */
  parseResponse(response: string, item: TItem): TResult;

  /** Save all results to state */
  saveResults(results: PhaseResult<TResult>[], context: PhaseContext): void;

  /** Determine next pipeline phase based on results */
  nextPhase(results: PhaseResult<TResult>[]): PipelinePhase | "completed" | "failed";

  /** Format summary for terminal output */
  formatSummary?(results: PhaseResult<TResult>[], context: PhaseContext): void;

  // --- Lifecycle hooks ---
  beforeRun?(context: PhaseContext): Promise<void>;
  afterRun?(results: PhaseResult<TResult>[], context: PhaseContext): Promise<void>;
  beforeItem?(item: TItem, context: PhaseContext): Promise<TItem>;

  // --- Retry (validate only) ---
  isRetryable?: boolean;
  maxRetryRounds?: number;
  retryFilter?(items: TItem[], results: PhaseResult<TResult>[]): TItem[];
}

interface PhaseContext {
  runId: string;
  workDir: string;
  engine: AIEngine;
  config: ResolvedConfig;
  cost: RunCost;               // Accumulated cost tracker
  store: Record<string, unknown>;
}
```

### Runner (~300 lines)

Single class. All phases go through the same code path:

1. Resolve run (select or create)
2. Acquire run lock
3. Load config (config.yml + CLI flags merged)
4. Resolve model for this phase
5. `beforeRun` hook
6. Load items
7. Execute with pool strategy (pLimit)
8. Retry loop (if configured)
9. Save results
10. `afterRun` hook
11. Calculate cost
12. Display summary
13. Phase transition
14. Release lock

---

## Stateless Run Management

### Remove `current_run`

From `remove-current-run.md`:
- Remove `current_run` from `RunsIndexSchema`
- Delete `getCurrentRunId()`, `getCurrentRun()`, `setCurrentRun()`, `requireActiveRun()`
- Delete all deprecated implicit-path functions
- Keep only `ForRun` API

### Smart run selection

```typescript
// pipeline/run-manager.ts

async function selectRun(options: {
  runId?: string;
  workDir: string;
  requirePhase?: PipelinePhase[];
}): Promise<string> {
  if (options.runId) return resolveRunId(options.runId, options.workDir);

  const runs = loadRunsIndex(options.workDir).runs;
  const matching = options.requirePhase
    ? runs.filter(r => options.requirePhase.includes(r.phase))
    : runs;

  if (matching.length === 1) return matching[0].id;
  if (matching.length > 1) return promptUserToSelectRun(matching);
  throw new Error("No matching runs. Start with: milhouse --scan");
}
```

### Run-level locks + atomic writes

```typescript
// state/run-lock.ts
acquireRunLock(runId, phase, workDir) → { release() }

// state/utils.ts
saveJsonAtomic(path, data)  // write to .tmp, then rename
```

---

## Pipeline Orchestrator

```typescript
// pipeline/orchestrator.ts

const PHASE_CONFIGS = {
  scan: scanConfig,
  validate: validateConfig,
  plan: planConfig,
  consolidate: consolidateConfig,
  verify: verifyConfig,
};

async function runPipeline(options: RuntimeOptions): Promise<PipelineResult> {
  const config = loadConfig(process.cwd(), options);
  const runner = new PhaseRunner();
  const cost = createRunCost();
  let runId: string | undefined;

  const phases = resolvePhaseRange(options.startPhase, options.endPhase);

  for (const phase of phases) {
    // Budget check
    if (config.cost.budgetLimit > 0 && cost.totalCost >= config.cost.budgetLimit) {
      logWarn(`Budget limit $${config.cost.budgetLimit} reached. Stopping.`);
      break;
    }

    let result: PipelinePhaseResult;
    if (phase === "exec") {
      result = await runExec({ ...options, runId, config });
    } else {
      result = await runner.run(PHASE_CONFIGS[phase], { ...options, runId, config });
    }

    cost.addPhase(phase, result.inputTokens, result.outputTokens);

    if (phase === "scan") runId = result.data?.runId;
    if (!result.success && config.failFast) break;
  }

  // Auto-generate report
  if (config.report.autoGenerate && runId) {
    generateReport(runId, cost, config);
  }

  // Print cost summary
  displayCostSummary(cost, config);

  return { runId, cost, phases };
}
```

---

## Migration Steps

### Step 0: Setup milhouse-020 project (separate repo)
- Create `C:\Users\eizo\Documents\Projects\milhouse-020` with its own `git init`
- Copy package.json, tsconfig.json, biome.json from `../milhouse/`
- Copy src/engines/, src/gates/, src/probes/, src/vcs/, src/ui/ from `../milhouse/`
- Copy src/state/ (will be cleaned in step 1)
- `pnpm install` + verify `npx tsc --noEmit`

### Step 1: Clean state layer (remove-current-run)
- Remove `current_run` from schema
- Delete deprecated functions
- Add ForRun variants for graph, executions, probes
- Add run-lock.ts, atomic writes
- Add run-manager.ts with selectRun()

### Step 2: Config system
- Create config/schema.ts with Zod schema
- Create config/loader.ts with merge logic (config.yml + CLI)
- Create config/defaults.ts

### Step 3: Cost tracking
- Create runner/cost.ts
- Wire into PhaseRunner
- Add cost display to summary

### Step 4: PhaseRunner
- Create runner/types.ts
- Create runner/phase-runner.ts
- Pool parallelism, retry loop, lifecycle hooks, json-schema, cost tracking

### Step 5: Migrate Scan
- Create runner/phases/scan.ts
- Create agents/prompts/scan.ts + agents/schemas/scan.ts
- Test: `milhouse --scan` works

### Step 6: Migrate Validate
- Create runner/phases/validate.ts
- Port retry + probes
- Test: `milhouse --validate` works

### Step 7: Migrate Plan
- Create runner/phases/plan.ts
- Pool instead of batch
- Test: `milhouse --plan` works

### Step 8: Migrate Consolidate + Verify
- Create runner/phases/consolidate.ts
- Create runner/phases/verify.ts
- Test: both work

### Step 9: Exec cleanup
- Extract merge strategy → execution/merge/
- Extract tmux → execution/tmux/ (shared)
- Clean issue-executor.ts

### Step 10: Pipeline orchestrator + Report
- Create pipeline/orchestrator.ts (replaces old pipeline.ts)
- Create report/ module
- Wire `milhouse report` command
- Test: `milhouse --run` end-to-end

### Step 11: Delete dead code
- Remove old cli/commands/ (replaced by thin wrappers)
- Remove BaseAgent classes
- Remove agent capabilities system
- Remove document factory
- Final line count audit

---

## Line Count Estimate

| Module | Current | After | Change |
|--------|---------|-------|--------|
| cli/commands/ (5 phases) | 5100 | 150 (thin wrappers) | **-4950** |
| runner/ (new) | 0 | 860 | +860 |
| config/ (new) | 0 | 200 | +200 |
| report/ (new) | 0 | 250 | +250 |
| agents/ (prompts only) | 4777 | 1200 | **-3577** |
| state/ (ForRun only) | 3500 | 2800 | -700 |
| pipeline/ | 700 | 200 | -500 |
| execution/ (exec only) | 1740 | 1200 | -540 |
| **Total** | **~15800** | **~6860** | **-8940 (-57%)** |

---

## Machine-to-Machine Design

Milhouse is designed to be called by other AI agents. Key properties:

### Structured exit codes
```
0 — pipeline completed successfully
1 — pipeline failed (phase error)
2 — budget exceeded
3 — no items found (scan found nothing)
4 — config error
```

### JSON output mode
```bash
milhouse --run --scope "fix bugs" --output json
```
Outputs only the JSON report to stdout. No spinners, no colors, no progress. Other machines parse this directly.

### Config as contract
An orchestrating AI agent writes `.milhouse/config.yml`, runs `milhouse --run`, reads the JSON report. The config is the contract between the caller and milhouse.

### Idempotent resume
```bash
milhouse --resume --run-id <id>
```
Safe to retry. Run locks prevent double execution. State is always consistent.

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Breaking CLI interface | Same args.ts, same command names, same flags |
| State file incompatibility | Same `.milhouse/runs/` structure, just remove `current_run` |
| Exec phase regression | Exec stays specialized, only extract merge/tmux |
| Config conflicts | Simple rule: CLI flags always override config.yml |
| Budget false stops | Budget is per-run, not per-phase; warn at 80% |
| JSON report schema changes | Version field in report allows backward compat |

## Verification

After each step:
1. `npx tsc --noEmit` — zero errors
2. `bun test` — no new failures
3. `milhouse --scan --scope "test" --verbose` — works
4. `milhouse --run --scope "test" --force` — full pipeline
5. Two terminals scanning simultaneously — no conflicts
6. `milhouse report --format json` — valid JSON output
