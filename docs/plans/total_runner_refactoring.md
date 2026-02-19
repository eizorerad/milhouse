# Milhouse 0.2.0 — Total Runner Refactoring

## Overview

Complete rewrite of the pipeline execution layer into a single configurable runner.
Lives in `milhouse-020/` as a parallel project. TUI/CLI interface preserved from current version.

### What changes
- 5 phase command files (5100 lines) → 1 PhaseRunner + 5 configs (~1500 lines)
- `current_run` global pointer removed — fully stateless run management
- All state operations use explicit `runId` (no implicit current run)
- Unified pool parallelism (no more batch vs pool inconsistency)
- `--json-schema` automatic for all phases
- Atomic writes + run-level locks for concurrent safety
- One tmux implementation instead of 5 copies

### What stays
- TUI: spinners, progress bars, color theme, CLI args — copied as-is
- Exec phase: stays specialized (writes code, manages worktrees)
- State file format: `.milhouse/runs/<runId>/` structure unchanged
- All engine plugins: claude, gemini, opencode, etc.

---

## Project Structure

```
milhouse-020/
├── src/
│   ├── index.ts                      # Entry point (from current)
│   ├── runner/
│   │   ├── phase-runner.ts           # NEW: Single runner for all phases (~300 lines)
│   │   ├── types.ts                  # NEW: PhaseConfig interface (~50 lines)
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
│   │   │   ├── scan.ts               # buildLeadInvestigatorPrompt()
│   │   │   ├── validate.ts           # buildDeepIssueValidatorPrompt()
│   │   │   ├── plan.ts               # buildDeepPlannerPrompt()
│   │   │   ├── consolidate.ts        # buildConsolidatorPrompt()
│   │   │   ├── verify.ts             # buildVerifierPrompt()
│   │   │   └── executor.ts           # buildExecutorPrompt()
│   │   └── schemas/                  # JSON schemas for --json-schema
│   │       ├── scan.ts
│   │       ├── validate.ts
│   │       ├── plan.ts
│   │       ├── consolidate.ts
│   │       └── verify.ts
│   │
│   ├── execution/                    # Exec phase (specialized, not in runner)
│   │   ├── exec-command.ts           # CLI entry for exec
│   │   ├── issue-executor.ts         # FROM CURRENT (cleaned: extract merge + tmux)
│   │   ├── merge/
│   │   │   └── rebase-merge.ts       # Extracted merge strategy
│   │   └── tmux/
│   │       └── tmux-executor.ts      # Extracted tmux mode (shared with runner)
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
│       │   └── runs.ts              # FROM CURRENT (run listing/management)
│       └── types.ts                  # FROM CURRENT
│
├── tests/
├── package.json
├── tsconfig.json
└── biome.json
```

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

  /** Default parallel agents (overridden by --workers) */
  defaultParallel: number;

  /** Load work items for this phase */
  loadItems(runId: string, workDir: string, options: RuntimeOptions): TItem[];

  /** Build the prompt for one item (per-item) or all items (single-agent) */
  buildPrompt(item: TItem, context: PhaseContext): string;

  /** Parse AI response into structured result */
  parseResponse(response: string, item: TItem): TResult;

  /** Save all results to state */
  saveResults(results: PhaseResult<TResult>[], context: PhaseContext): void;

  /** Determine next pipeline phase based on results */
  nextPhase(results: PhaseResult<TResult>[]): PipelinePhase | "completed" | "failed";

  /** Optional: format summary for terminal output */
  formatSummary?(results: PhaseResult<TResult>[], context: PhaseContext): void;

  // --- Lifecycle hooks (optional) ---

  /** Before phase starts (e.g., scan creates run, verify runs gates) */
  beforeRun?(context: PhaseContext): Promise<void>;

  /** After phase completes */
  afterRun?(results: PhaseResult<TResult>[], context: PhaseContext): Promise<void>;

  /** Before each item is processed (e.g., validate runs probes) */
  beforeItem?(item: TItem, context: PhaseContext): Promise<TItem>;

  // --- Retry support (optional, used by validate) ---

  /** Whether failed items can be retried */
  isRetryable?: boolean;

  /** Max retry rounds */
  maxRetryRounds?: number;

  /** Filter items for next retry round */
  retryFilter?(items: TItem[], results: PhaseResult<TResult>[]): TItem[];
}

interface PhaseContext {
  runId: string;
  workDir: string;
  engine: AIEngine;
  options: RuntimeOptions;
  /** Phase-specific storage (e.g., gate results for verify) */
  store: Record<string, unknown>;
}

interface PhaseResult<T> {
  itemId: string;
  result: T;
  success: boolean;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: string;
}
```

### Runner Implementation

```typescript
// runner/phase-runner.ts (~300 lines)

class PhaseRunner {
  async run<TItem, TResult>(
    config: PhaseConfig<TItem, TResult>,
    options: RuntimeOptions,
  ): Promise<PipelinePhaseResult> {

    // 1. Resolve run (select existing or let beforeRun create one)
    const context = await this.createContext(config, options);

    // 2. Acquire run lock (prevents concurrent execution of same phase)
    const lock = await acquireRunLock(context.runId, config.name, context.workDir);

    try {
      // 3. Update phase in meta
      await updateRunPhaseInMetaWithLock(context.runId, config.name, context.workDir);

      // 4. beforeRun hook
      await config.beforeRun?.(context);

      // 5. Load items
      const items = config.loadItems(context.runId, context.workDir, context.options);
      if (items.length === 0) {
        return this.emptyResult(config.name);
      }

      // 6. Execute with unified pool strategy
      let results: PhaseResult<TResult>[];
      if (config.mode === "single-agent") {
        results = [await this.executeSingle(config, items[0], context)];
      } else {
        results = await this.executePool(config, items, context);
      }

      // 7. Retry loop (validate only)
      if (config.isRetryable && config.retryFilter) {
        for (let round = 1; round < (config.maxRetryRounds ?? 1); round++) {
          const retryItems = config.retryFilter(items, results);
          if (retryItems.length === 0) break;
          const retryResults = await this.executePool(config, retryItems, context);
          results = this.mergeResults(results, retryResults);
        }
      }

      // 8. Save results
      config.saveResults(results, context);

      // 9. afterRun hook
      await config.afterRun?.(results, context);

      // 10. Summary
      config.formatSummary?.(results, context);

      // 11. Phase transition
      const next = config.nextPhase(results);
      await updateRunPhaseInMetaWithLock(context.runId, next, context.workDir);

      return this.buildResult(config.name, results);
    } finally {
      lock.release();
    }
  }

  private async executePool<TItem, TResult>(
    config: PhaseConfig<TItem, TResult>,
    items: TItem[],
    context: PhaseContext,
  ): Promise<PhaseResult<TResult>[]> {
    const max = Math.min(
      context.options.maxParallel || config.defaultParallel,
      items.length,
    );
    const limit = pLimit(max);

    return Promise.all(
      items.map(item => limit(async () => {
        const start = Date.now();
        // beforeItem hook (e.g., run probes)
        const processed = await config.beforeItem?.(item, context) ?? item;
        // Build prompt
        const prompt = config.buildPrompt(processed, context);
        // Execute with json-schema
        const aiResult = await context.engine.execute(prompt, context.workDir, {
          jsonSchema: config.jsonSchema,
          modelOverride: context.options.modelOverride,
        });
        // Parse
        const parsed = config.parseResponse(aiResult.response, processed);
        return {
          itemId: (processed as any).id ?? "unknown",
          result: parsed,
          success: aiResult.success,
          inputTokens: aiResult.inputTokens,
          outputTokens: aiResult.outputTokens,
          durationMs: Date.now() - start,
        };
      })),
    );
  }
}
```

---

## Stateless Run Management (from remove-current-run.md)

### What changes

1. **Remove `current_run`** from `RunsIndexSchema` — no global mutable pointer
2. **Remove** all functions: `getCurrentRunId()`, `getCurrentRun()`, `setCurrentRun()`, `requireActiveRun()`, `updateCurrentRunPhase()`, `updateCurrentRunStats()`
3. **Remove** implicit-path functions from `issues.ts`, `tasks.ts`, `graph.ts`, `executions.ts`
4. **Keep only** `ForRun` API everywhere: `loadIssuesForRun(runId, ...)`, `saveTasksForRun(runId, ...)`, etc.

### Run selection

```typescript
// pipeline/run-manager.ts

/** Smart run selection — replaces getCurrentRun() */
async function selectRun(options: {
  runId?: string;          // --run-id explicit
  workDir: string;
  requirePhase?: PipelinePhase[];  // Filter by phase
}): Promise<string> {
  // 1. Explicit --run-id → use it
  if (options.runId) return resolveRunId(options.runId, options.workDir);

  // 2. Find runs matching phase filter
  const runs = loadRunsIndex(options.workDir).runs;
  const matching = options.requirePhase
    ? runs.filter(r => options.requirePhase.includes(r.phase))
    : runs;

  // 3. One match → use it
  if (matching.length === 1) return matching[0].id;

  // 4. Multiple → prompt user
  if (matching.length > 1) return promptUserToSelectRun(matching);

  // 5. None → error
  throw new Error("No matching runs found. Start with: milhouse --scan");
}
```

### Run-level lock

```typescript
// state/run-lock.ts (~40 lines)

async function acquireRunLock(runId: string, phase: string, workDir: string) {
  const lockPath = join(getRunDir(runId, workDir), `${phase}.lock`);
  // Check if locked by another process (PID alive check)
  // Write lock file with { pid, startedAt }
  // Return { release() } that deletes lock file
}
```

### Atomic writes

All state write functions use write-to-tmp + rename pattern:
```typescript
function saveJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}
```

---

## Phase Configs (detailed)

### Scan (~80 lines)

```typescript
export const scanConfig: PhaseConfig<ScanItem, ParsedIssue[]> = {
  name: "scan",
  role: "LI",
  jsonSchema: SCAN_JSON_SCHEMA,
  mode: "single-agent",
  defaultParallel: 1,

  async beforeRun(context) {
    // Scan is unique: creates the run
    const run = createRun({ scope: context.options.scanFocus, workDir: context.workDir });
    context.runId = run.id;
    context.store.runMeta = run;
  },

  loadItems(runId, workDir, options) {
    return [{ id: "scan", scope: options.scanFocus }];
  },

  buildPrompt(item, context) {
    return buildLeadInvestigatorPrompt(context.workDir, {
      scope: item.scope ? [item.scope] : undefined,
    });
  },

  parseResponse(response) {
    return parseIssuesFromResponse(response);
  },

  saveResults(results, context) {
    const issues = buildIssueObjects(results[0].result);
    saveIssuesForRun(context.runId, issues, context.workDir);
    const brief = generateWorkBrief(issues, context.runId);
    writeProblemBriefForRun(context.workDir, context.runId, brief);
    updateRunStatsWithLock(context.runId, { issues_found: issues.length }, context.workDir);
  },

  nextPhase(results) {
    return (results[0]?.result?.length ?? 0) > 0 ? "validate" : "completed";
  },
};
```

### Validate (~100 lines)

Key difference: retry loop + probes in beforeItem.

```typescript
export const validateConfig: PhaseConfig<Issue, ValidationReport> = {
  name: "validate",
  role: "IV",
  jsonSchema: VALIDATE_JSON_SCHEMA,
  mode: "per-item",
  defaultParallel: 5,
  isRetryable: true,
  maxRetryRounds: 3,

  loadItems(runId, workDir, options) {
    const issues = loadIssuesForRun(runId, workDir);
    return filterIssues(issues, { status: ["UNVALIDATED"], ...buildFilterOptions(options) });
  },

  async beforeItem(issue, context) {
    // Run probes before validation
    const probeEvidence = await runProbesForIssue(issue, context.workDir);
    return { ...issue, _probeEvidence: probeEvidence };
  },

  buildPrompt(issue, context) {
    return buildDeepIssueValidatorPrompt(issue, context.workDir, 0, issue._probeEvidence);
  },

  parseResponse(response) {
    return parseDeepValidationFromResponse(response);
  },

  saveResults(results, context) {
    for (const entry of results) {
      updateIssueForRun(context.runId, entry.itemId, {
        status: entry.result.status,
        evidence: entry.result.evidence,
        validated_by: "IV",
      }, context.workDir);
    }
  },

  retryFilter(items, results) {
    const validated = new Set(results.filter(r => r.result?.status !== "UNVALIDATED").map(r => r.itemId));
    return items.filter(i => !validated.has(i.id));
  },

  nextPhase(results) {
    const confirmed = results.filter(r => ["CONFIRMED", "PARTIAL"].includes(r.result?.status));
    return confirmed.length > 0 ? "plan" : "completed";
  },
};
```

### Plan (~100 lines)

Key difference: creates tasks + writes WBS files.

### Consolidate (~80 lines)

Key difference: `mode: "single-agent"` — one call with all tasks.

### Verify (~100 lines)

Key difference: runs quality gates in `beforeRun` before AI verification.

---

## Pipeline Orchestrator (simplified)

```typescript
// pipeline/orchestrator.ts

const PHASE_CONFIGS: Record<PipelinePhase, PhaseConfig | "exec"> = {
  scan: scanConfig,
  validate: validateConfig,
  plan: planConfig,
  consolidate: consolidateConfig,
  exec: "exec",           // Specialized, not via runner
  verify: verifyConfig,
};

const PHASE_ORDER: PipelinePhase[] = [
  "scan", "validate", "plan", "consolidate", "exec", "verify"
];

async function runPipeline(options: RuntimeOptions): Promise<PipelineResult> {
  const runner = new PhaseRunner();
  let runId: string | undefined;

  const startPhase = options.startPhase ?? "scan";
  const endPhase = options.endPhase ?? "verify";
  const phases = PHASE_ORDER.slice(
    PHASE_ORDER.indexOf(startPhase),
    PHASE_ORDER.indexOf(endPhase) + 1,
  );

  for (const phase of phases) {
    const config = PHASE_CONFIGS[phase];

    let result: PipelinePhaseResult;
    if (config === "exec") {
      result = await runExec({ ...options, runId });
    } else {
      result = await runner.run(config, { ...options, runId });
    }

    // Capture runId from scan phase
    if (phase === "scan" && result.data?.runId) {
      runId = result.data.runId;
    }

    if (!result.success && options.failFast) break;
  }
}
```

---

## Migration Steps

### Step 0: Setup milhouse-020/ project
- Copy package.json, tsconfig.json, biome.json
- Copy src/engines/, src/gates/, src/probes/, src/vcs/, src/ui/, src/cli/args.ts
- Copy src/state/ (will be cleaned in step 1)
- `pnpm install`
- Verify `npx tsc --noEmit` passes

### Step 1: Clean state layer (remove-current-run.md)
- Remove `current_run` from RunsIndexSchema
- Delete all `getCurrentRun`/`setCurrentRun` functions
- Delete deprecated implicit-path functions
- Add missing `ForRun` variants (graph, executions, probes)
- Add `run-lock.ts` for per-run execution locks
- Add atomic write helper (`saveJsonAtomic`)
- Add `run-manager.ts` with `selectRun()`
- Test: state module compiles and passes tests

### Step 2: Create PhaseRunner
- Create `runner/types.ts` with PhaseConfig interface
- Create `runner/phase-runner.ts` with PhaseRunner class
- Pool parallelism, retry loop, lifecycle hooks
- json-schema automatic for all phases
- Test: runner compiles (no phases yet)

### Step 3: Migrate Scan
- Create `runner/phases/scan.ts`
- Move prompt builder to `agents/prompts/scan.ts`
- Move JSON schema to `agents/schemas/scan.ts`
- Create thin CLI wrapper `cli/commands/scan.ts` (~30 lines)
- Test: `milhouse --scan` works

### Step 4: Migrate Validate
- Create `runner/phases/validate.ts`
- Port retry logic, probe integration
- Test: `milhouse --validate` works

### Step 5: Migrate Plan
- Create `runner/phases/plan.ts`
- Switch from batch to pool (performance improvement)
- Test: `milhouse --plan` works

### Step 6: Migrate Consolidate
- Create `runner/phases/consolidate.ts`
- Single-agent mode
- Test: `milhouse --consolidate` works

### Step 7: Migrate Verify
- Create `runner/phases/verify.ts`
- Gate pre-checks in beforeRun hook
- Test: `milhouse --verify` works

### Step 8: Exec cleanup (not in runner)
- Extract merge strategy from issue-executor.ts → `execution/merge/`
- Extract tmux mode → `execution/tmux/` (shared with runner)
- Clean up issue-executor.ts (~1740 → ~1000 lines)

### Step 9: Pipeline orchestrator
- Create `pipeline/orchestrator.ts`
- Replace old pipeline.ts switch-case with config registry
- Wire resume mode to `selectRun()`
- Test: `milhouse --run` end-to-end

### Step 10: Delete dead code
- Remove old cli/commands/ files (replaced by thin wrappers)
- Remove BaseAgent classes (replaced by prompt builders)
- Remove agent capabilities system
- Remove document factory
- Final line count audit

---

## Line Count Estimate

| Module | Current | After | Change |
|--------|---------|-------|--------|
| cli/commands/ (5 phases) | 5100 | 150 (thin wrappers) | **-4950** |
| runner/ (new) | 0 | 760 | +760 |
| agents/ (prompts only) | 4777 | 1200 | **-3577** |
| state/ (ForRun only) | 3500 | 2800 | -700 |
| pipeline/ | 700 | 200 | -500 |
| execution/ (exec only) | 1740 | 1200 | -540 |
| **Total estimate** | **~15800** | **~6300** | **-9500 (-60%)** |

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Breaking CLI interface | Keep same args.ts, same command names, same output format |
| State file incompatibility | Same `.milhouse/runs/` structure, just remove `current_run` field |
| Exec phase regression | Exec stays specialized, only extracted merge/tmux |
| Parallel execution regression | Unified pool strategy with pLimit — battle-tested in validate |
| Engine compatibility | Engine layer copied as-is, no changes |
| Tmux mode regression | Extracted into shared module, used by both runner and exec |

## Verification at each step

1. `npx tsc --noEmit` — zero errors
2. `bun test` — no new failures
3. `milhouse --scan --scope "test" --verbose` — works
4. `milhouse --run --scope "test" --force` — full pipeline completes
5. Two terminals running scan simultaneously — no conflicts
