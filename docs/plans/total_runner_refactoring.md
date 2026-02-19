# Total Runner Refactoring Plan

## Problem

Each pipeline phase (scan, validate, plan, consolidate, verify) is a standalone 600-1000 line file that reimplements the same pattern:

```
Load items → Build prompt → Run AI agent(s) → Parse JSON → Save results → Show summary
```

This creates ~5100 lines of duplicated boilerplate across 5 files, with inconsistent parallelism strategies (pool vs batch), duplicated error handling, and duplicated tmux mode support.

## Goal

Replace 5 standalone command files with one `PhaseRunner` + 5 phase configs (~50-100 lines each). Keep `exec` as specialized module.

**Expected result:** ~5100 lines → ~1500 lines. Same functionality, one code path.

---

## Architecture

### Core: `PhaseRunner`

Single class that executes any phase given a config:

```
src/execution/
  phase-runner.ts          # ~300 lines — the unified runner
  phase-configs/
    scan.ts                # ~80 lines — config + prompt builder
    validate.ts            # ~100 lines — config + retry logic
    plan.ts                # ~100 lines — config + WBS generation
    consolidate.ts         # ~80 lines — config (single agent)
    verify.ts              # ~100 lines — config + gate pre-checks
    types.ts               # ~50 lines — interfaces
```

### Interface

```typescript
// types.ts
interface PhaseConfig<TItem, TResult> {
  name: PipelinePhase;
  role: AgentRole;
  jsonSchema: Record<string, unknown>;

  // Execution mode
  mode: "per-item" | "single-agent";
  defaultMaxParallel: number;

  // Lifecycle hooks
  loadItems(runId: string, workDir: string, options: RuntimeOptions): TItem[];
  buildPrompt(item: TItem, context: PhaseContext): string;
  parseResponse(response: string, item: TItem): TResult;
  saveResults(results: PhaseResultEntry<TResult>[], context: PhaseContext): void;
  resolveNextPhase(results: PhaseResultEntry<TResult>[]): PipelinePhase;

  // Optional hooks
  beforeRun?(context: PhaseContext): Promise<void>;
  afterRun?(results: PhaseResultEntry<TResult>[], context: PhaseContext): Promise<void>;
  beforeItem?(item: TItem, context: PhaseContext): Promise<TItem>;
  formatSummary?(results: PhaseResultEntry<TResult>[]): void;
  isRetryable?: boolean;
  maxRetryRounds?: number;
  retryFilter?(items: TItem[], results: PhaseResultEntry<TResult>[]): TItem[];
}

interface PhaseContext {
  runId: string;
  workDir: string;
  engine: AIEngine;
  options: RuntimeOptions;
}

interface PhaseResultEntry<T> {
  item: { id: string };
  result: T;
  success: boolean;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}
```

### PhaseRunner (~300 lines)

```typescript
// phase-runner.ts
class PhaseRunner {
  async run<TItem, TResult>(
    config: PhaseConfig<TItem, TResult>,
    options: RuntimeOptions,
  ): Promise<PipelinePhaseResult> {
    // 1. Select/validate run
    const { runId, workDir } = await this.resolveRun(config.name, options);

    // 2. Initialize engine
    const engine = await createEngine(options.aiEngine);

    // 3. Create context
    const context: PhaseContext = { runId, workDir, engine, options };

    // 4. beforeRun hook
    await config.beforeRun?.(context);

    // 5. Load items
    const items = config.loadItems(runId, workDir, options);

    // 6. Execute (with optional retry loop)
    let results: PhaseResultEntry<TResult>[];
    if (config.mode === "single-agent") {
      results = [await this.executeSingle(config, items, context)];
    } else {
      results = await this.executeParallel(config, items, context);
    }

    // 7. Retry loop (if configured, e.g. validate)
    if (config.isRetryable) {
      results = await this.retryLoop(config, items, results, context);
    }

    // 8. Save results
    config.saveResults(results, context);

    // 9. afterRun hook
    await config.afterRun?.(results, context);

    // 10. Summary
    config.formatSummary?.(results);

    // 11. Phase transition
    const nextPhase = config.resolveNextPhase(results);
    updateRunPhaseInMeta(runId, nextPhase, workDir);

    return this.buildResult(config.name, results);
  }

  private async executeParallel<TItem, TResult>(
    config: PhaseConfig<TItem, TResult>,
    items: TItem[],
    context: PhaseContext,
  ): Promise<PhaseResultEntry<TResult>[]> {
    const maxParallel = Math.min(
      context.options.maxParallel || config.defaultMaxParallel,
      items.length,
    );
    const limit = pLimit(maxParallel);

    // Unified pool strategy for all phases (not batch)
    return Promise.all(
      items.map(item => limit(async () => {
        const processed = await config.beforeItem?.(item, context) ?? item;
        const prompt = config.buildPrompt(processed, context);
        const result = await context.engine.execute(prompt, context.workDir, {
          jsonSchema: config.jsonSchema,
          modelOverride: context.options.modelOverride,
        });
        const parsed = config.parseResponse(result.response, processed);
        return {
          item: processed,
          result: parsed,
          success: result.success,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        };
      })),
    );
  }
}
```

---

## Phase Configs

### 1. Scan Config

```typescript
// phase-configs/scan.ts
export const scanConfig: PhaseConfig<ScanItem, ParsedIssue[]> = {
  name: "scan",
  role: "LI",
  jsonSchema: SCAN_JSON_SCHEMA,
  mode: "single-agent",       // One agent scans entire repo
  defaultMaxParallel: 1,

  loadItems(runId, workDir, options) {
    // Scan creates items, not loads them
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
  },

  resolveNextPhase(results) {
    const issueCount = results[0]?.result?.length ?? 0;
    return issueCount > 0 ? "validate" : "completed";
  },

  beforeRun(context) {
    // Scan is unique: it creates the run
    const run = createRun({ scope: context.options.scanFocus, workDir: context.workDir });
    context.runId = run.id;
  },

  formatSummary(results) {
    // Display scan summary with issue counts
  },
};
```

### 2. Validate Config

```typescript
// phase-configs/validate.ts
export const validateConfig: PhaseConfig<Issue, ValidationResult> = {
  name: "validate",
  role: "IV",
  jsonSchema: VALIDATE_JSON_SCHEMA,
  mode: "per-item",
  defaultMaxParallel: 5,
  isRetryable: true,
  maxRetryRounds: 3,

  loadItems(runId, workDir, options) {
    const issues = loadIssuesForRun(runId, workDir);
    return filterIssues(issues, { status: ["UNVALIDATED"], ...buildFilterOptions(options) });
  },

  async beforeItem(issue, context) {
    // Run probes for this issue (deps, repro)
    const probeEvidence = await runProbesForIssue(issue, context.workDir);
    return { ...issue, _probeEvidence: probeEvidence };
  },

  buildPrompt(issue, context) {
    return buildDeepIssueValidatorPrompt(issue, context.workDir, 0, issue._probeEvidence);
  },

  parseResponse(response, issue) {
    return parseDeepValidationFromResponse(response);
  },

  saveResults(results, context) {
    for (const entry of results) {
      if (entry.result) {
        updateIssueForRun(context.runId, entry.item.id, {
          status: entry.result.status,
          evidence: entry.result.evidence,
          corrected_description: entry.result.corrected_description,
          validated_by: "IV",
        }, context.workDir);
      }
    }
    // Generate updated Work Brief
    const allIssues = loadIssuesForRun(context.runId, context.workDir);
    const brief = generateValidatedProblemBrief(allIssues, context.runId);
    writeProblemBriefForRun(context.workDir, context.runId, brief);
  },

  retryFilter(items, results) {
    // Return items that are still UNVALIDATED after this round
    return items.filter(item => {
      const result = results.find(r => r.item.id === item.id);
      return !result || result.result?.status === "UNVALIDATED";
    });
  },

  resolveNextPhase(results) {
    const confirmed = results.filter(r => ["CONFIRMED", "PARTIAL"].includes(r.result?.status));
    return confirmed.length > 0 ? "plan" : "completed";
  },
};
```

### 3. Plan Config

```typescript
// phase-configs/plan.ts
export const planConfig: PhaseConfig<Issue, ParsedWBS> = {
  name: "plan",
  role: "PL",
  jsonSchema: PLAN_JSON_SCHEMA,
  mode: "per-item",
  defaultMaxParallel: 5,

  loadItems(runId, workDir, options) {
    const issues = loadIssuesForRun(runId, workDir);
    return filterIssues(issues, { status: ["CONFIRMED", "PARTIAL"], ...buildFilterOptions(options) });
  },

  buildPrompt(issue, context) {
    const validationReport = loadValidationReport(issue.id, context.workDir);
    return buildDeepPlannerPrompt(issue, validationReport, context.workDir, 0);
  },

  parseResponse(response) {
    return parseWBSFromResponse(response);
  },

  saveResults(results, context) {
    for (const entry of results) {
      if (entry.result?.tasks?.length > 0) {
        // Write WBS markdown + JSON
        const markdown = generateWBSMarkdown(entry.item, entry.result);
        writeIssueWbsPlanForRun(context.workDir, context.runId, entry.item.id, markdown);
        writeIssueWbsJsonForRun(context.workDir, context.runId, entry.item.id, entry.result);
        // Create tasks in state
        for (const task of entry.result.tasks) {
          createTaskForRun(context.runId, { ...task, issue_id: entry.item.id }, context.workDir);
        }
      }
    }
  },

  resolveNextPhase(results) {
    const hasPlanned = results.some(r => r.result?.tasks?.length > 0);
    return hasPlanned ? "consolidate" : "completed";
  },
};
```

### 4. Consolidate Config

```typescript
// phase-configs/consolidate.ts
export const consolidateConfig: PhaseConfig<ConsolidateInput, ConsolidateResult> = {
  name: "consolidate",
  role: "CDM",
  jsonSchema: CONSOLIDATE_JSON_SCHEMA,
  mode: "single-agent",       // One agent consolidates everything
  defaultMaxParallel: 1,

  loadItems(runId, workDir) {
    const tasks = loadTasksForRun(runId, workDir);
    const issues = loadIssuesForRun(runId, workDir);
    return [{ tasks, issues }];
  },

  buildPrompt(input, context) {
    return buildConsolidatorPrompt(input.tasks, input.issues, context.workDir);
  },

  parseResponse(response) {
    return parseConsolidationResponse(response);
  },

  saveResults(results, context) {
    const result = results[0]?.result;
    if (result) {
      const tasks = loadTasksForRun(context.runId, context.workDir);
      const consolidated = applyConsolidation(tasks, result);
      const sorted = topologicalSort(consolidated);
      assignParallelGroups(sorted);
      saveTasksForRun(context.runId, sorted, context.workDir);
      // Generate execution plan markdown
      const plan = generateExecutionPlanMarkdown(sorted, ...);
      writeExecutionPlanForRun(context.workDir, context.runId, plan);
    }
  },

  resolveNextPhase() {
    return "exec";
  },
};
```

### 5. Verify Config

```typescript
// phase-configs/verify.ts
export const verifyConfig: PhaseConfig<VerifyInput, VerifyResult> = {
  name: "verify",
  role: "TV",
  jsonSchema: VERIFY_JSON_SCHEMA,
  mode: "single-agent",
  defaultMaxParallel: 1,

  loadItems(runId, workDir) {
    const tasks = loadTasksForRun(runId, workDir);
    return [{
      completedTasks: tasks.filter(t => t.status === "done"),
      failedTasks: tasks.filter(t => t.status === "failed"),
    }];
  },

  async beforeRun(context) {
    // Run quality gates BEFORE AI verification
    const gateResults = runAllGates(context.runId, context.workDir);
    context._gateResults = gateResults;
  },

  buildPrompt(input, context) {
    return buildVerifierPrompt(input.completedTasks, input.failedTasks, context._gateResults);
  },

  parseResponse(response) {
    return parseVerificationFromResponse(response);
  },

  saveResults(results, context) {
    saveVerificationReport(context.runId, results[0]?.result, context.workDir);
  },

  resolveNextPhase(results) {
    const passed = results[0]?.result?.overall_pass;
    return passed ? "completed" : "failed";
  },
};
```

---

## What Stays Separate: Exec

Exec phase is fundamentally different:
- Writes code and creates files
- Manages git branches and worktrees
- Has 3 execution strategies (issue-based, task-parallel, sequential)
- Two-phase model: execution + merge
- Cannot be reduced to "prompt → parse → save"

Exec stays as `src/cli/commands/exec.ts` + `src/execution/issue-executor.ts`. The pipeline calls it directly instead of going through PhaseRunner.

---

## Tmux Mode

Currently duplicated across all phases (~100 lines each). Extract into:

```typescript
// phase-runner.ts (inside PhaseRunner)
private async executeWithTmux<T>(
  prompt: string,
  context: PhaseContext,
  sessionName: string,
): Promise<AIResult> {
  const executor = new OpencodeServerExecutor({ ... });
  const port = await executor.startServer(context.workDir);
  const session = await executor.createSession({ title: sessionName });
  const tmuxSession = await tmuxManager.createSession({ ... });
  const response = await executor.sendMessage(session.id, prompt, messageOptions);
  await executor.stopServer();
  return translateToAIResult(response);
}
```

One implementation, all phases get tmux support automatically.

---

## Pipeline Orchestrator Update

```typescript
// src/execution/pipeline.ts (simplified)
const PHASE_CONFIGS = {
  scan: scanConfig,
  validate: validateConfig,
  plan: planConfig,
  consolidate: consolidateConfig,
  verify: verifyConfig,
};

async function executePhase(phase: PipelinePhase, options: RuntimeOptions) {
  if (phase === "exec") {
    return runExec(options);  // Specialized
  }
  const config = PHASE_CONFIGS[phase];
  const runner = new PhaseRunner();
  return runner.run(config, options);
}
```

Replaces the current 100-line switch-case.

---

## Migration Steps

### Step 1: Create infrastructure (~300 lines)
- `src/execution/phase-runner.ts` — PhaseRunner class
- `src/execution/phase-configs/types.ts` — interfaces
- No behavior change yet

### Step 2: Migrate Scan
- Create `src/execution/phase-configs/scan.ts`
- Wire into pipeline.ts
- Delete `src/cli/commands/scan.ts` prompt building + parsing (keep CLI glue)
- Test: `milhouse --scan` works identically

### Step 3: Migrate Validate
- Create `src/execution/phase-configs/validate.ts`
- Port retry logic into PhaseRunner.retryLoop()
- Port probe integration into beforeItem hook
- Test: `milhouse --validate` works identically

### Step 4: Migrate Plan
- Create `src/execution/phase-configs/plan.ts`
- Switch from batch to pool strategy (performance improvement)
- Test: `milhouse --plan` works identically

### Step 5: Migrate Consolidate
- Create `src/execution/phase-configs/consolidate.ts`
- Single-agent mode in PhaseRunner
- Test: `milhouse --consolidate` works identically

### Step 6: Migrate Verify
- Create `src/execution/phase-configs/verify.ts`
- Port gate pre-checks into beforeRun hook
- Test: `milhouse --verify` works identically

### Step 7: Extract Tmux
- Move tmux logic from all phase configs into PhaseRunner
- Single implementation

### Step 8: Cleanup
- Delete old command files (keep thin CLI wrappers that call PhaseRunner)
- Remove duplicate prompt builders, parsers, savers
- Update imports across codebase

### Step 9: Full pipeline test
- `milhouse --run --scope "test" --force` end-to-end
- Verify all phases work individually and as pipeline

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Breaking existing CLI interface | Keep thin wrappers in cli/commands/ that delegate to PhaseRunner |
| Exec phase doesn't fit | Exec stays separate, called directly from pipeline |
| Validate retry logic is complex | Dedicated retryLoop() in PhaseRunner with retryFilter hook |
| Tmux mode differences per phase | beforeRun/afterRun hooks handle phase-specific tmux setup |
| Phase-specific state saving | Each config has its own saveResults — no forced abstraction |
| Probe integration in validate | beforeItem hook runs probes, augments item with evidence |

---

## Expected Outcome

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Total lines (5 phases) | ~5100 | ~1500 | **-70%** |
| Parallelism strategies | 2 (pool + batch) | 1 (pool) | Unified |
| Tmux implementations | 5 copies | 1 | **-80%** |
| Error handling paths | 5 | 1 | Unified |
| JSON schema passing | 5 manual | Automatic | Built-in |
| Adding new phase | ~800 lines | ~80 lines | **-90%** |
| Progress spinner logic | 5 copies | 1 | Unified |
