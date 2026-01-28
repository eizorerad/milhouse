# Run ID Isolation Refactoring Plan

## Problem Statement

The current milhouse architecture has a critical flaw: long-running commands (scan, validate, plan, exec) rely on `getCurrentRunId()` which reads from `.milhouse/runs-index.json`. This creates race conditions when:

1. **Multiple milhouse processes run in parallel** - each process can change `current_run`, causing other processes to read/write to the wrong run's directory
2. **Long-running operations** - during 6-8 minute operations, another process can create a new run and change the `current_run` pointer
3. **Mixed data** - issues, tasks, and plans from different scopes can end up in the wrong run

### Current Architecture (Problematic)

```
┌─────────────────────────────────────────────────────────────────┐
│                    runs-index.json                               │
│                    current_run: "run-A"                          │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ reads via getCurrentRunId()
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   Process 1             Process 2             Process 3
   (scan A)              (scan B)              (validate)
        │                     │                     │
        │                     ▼                     │
        │              current_run = "run-B"       │
        │                                          │
        ▼                                          ▼
   writes to run-B! ← BUG                    reads from run-B! ← BUG
```

### Target Architecture (Run-Isolated)

```
┌─────────────────────────────────────────────────────────────────┐
│                    runs-index.json                               │
│                    (only for listing/discovery)                  │
└─────────────────────────────────────────────────────────────────┘

   Process 1             Process 2             Process 3
   runId = "run-A"       runId = "run-B"       runId = ? (prompt)
        │                     │                     │
        ▼                     ▼                     ▼
   .milhouse/runs/       .milhouse/runs/       Interactive
   run-A/                run-B/                selection
```

---

## Current Code Analysis

### Key Files and Functions

| File | Function | Problem |
|------|----------|---------|
| `src/state/paths.ts:46` | `getCurrentRunId()` | Reads from runs-index.json - can return wrong run |
| `src/state/paths.ts:81` | `getStatePathForCurrentRun()` | Uses `getCurrentRunId()` internally |
| `src/state/issues.ts:12` | `getIssuesPath()` | Uses `getStatePathForCurrentRun()` |
| `src/state/issues.ts:29` | `loadIssues()` | Uses `getIssuesPath()` - reads from wrong run |
| `src/state/issues.ts:68` | `saveIssues()` | Uses `getIssuesPath()` - writes to wrong run |
| `src/state/plan-store.ts:109` | `getCurrentPlansDir()` | Uses `getCurrentRunId()` |
| `src/state/plan-store.ts:159` | `writePlanFile()` | Uses `getCurrentPlansDir()` |

### Already Fixed (Partial)

| File | Function | Status |
|------|----------|--------|
| `src/cli/commands/scan.ts` | Problem brief writing | ✅ Fixed - uses `runMeta.id` directly |
| `src/cli/commands/validate.ts` | Problem brief writing | ✅ Fixed - uses `currentRun.id` directly |
| `src/cli/commands/plan.ts` | WBS plan/JSON writing | ✅ Fixed - uses `writeIssueWbsPlanForRun()` |
| `src/state/plan-store.ts` | `writeIssueWbsPlanForRun()` | ✅ Added - accepts explicit runId |
| `src/state/plan-store.ts` | `writeIssueWbsJsonForRun()` | ✅ Added - accepts explicit runId |

### Still Broken

| File | Function | Impact |
|------|----------|--------|
| `src/state/issues.ts` | `loadIssues()` | Reads issues from wrong run |
| `src/state/issues.ts` | `saveIssues()` | Writes issues to wrong run |
| `src/state/issues.ts` | `updateIssue()` | Updates wrong run's issues |
| `src/state/tasks.ts` | `loadTasks()` | Reads tasks from wrong run |
| `src/state/tasks.ts` | `createTask()` | Creates task in wrong run |

### CLI Arguments Status

**Current `--run` option in `src/cli/args.ts:98`:**
```typescript
.option(
  '--run',
  `Run ${theme.highlight("full Milhouse pipeline")} (scan → validate → plan → consolidate → exec → verify)`,
)
```

**Problem:** `--run` is a boolean flag for full pipeline, NOT for specifying run ID!

**Need to add:** `--run-id <id>` or repurpose `--run` to accept optional value

---

## Phase 1: Add `--run-id` CLI Parameter (Foundation)

### 1.1 Update CLI Arguments

**File:** `src/cli/args.ts`

**IMPORTANT:** `--run` is already used as a boolean flag for full pipeline!
We need to add a NEW option `--run-id` instead.

```typescript
// Add after line 100 in createProgram()
.option('--run-id <id>', 'Specify run ID to use (full or partial match)')
```

**Also update `RuntimeOptions` in `src/cli/runtime-options.ts`:**
```typescript
export interface RuntimeOptions {
  // ... existing options
  
  /** Explicit run ID to use instead of current_run */
  runId?: string;
}
```

**Update `parseArgs()` in `src/cli/args.ts`:**
```typescript
const options: RuntimeOptions = {
  // ... existing options
  runId: opts.runId,  // Add this line
};
```

### 1.2 Create Run Selector Utility

**New File:** `src/cli/commands/utils/run-selector.ts`

```typescript
export interface RunSelectionResult {
  runId: string;
  runMeta: RunMeta;
}

/**
 * Select a run based on explicit ID, interactive prompt, or single active run
 */
export async function selectOrRequireRun(
  explicitRunId: string | undefined,
  workDir: string,
  options?: {
    allowCreate?: boolean;
    scope?: string;
    requirePhase?: RunPhase[];
  }
): Promise<RunSelectionResult>;

/**
 * Resolve partial run ID to full ID
 * Examples: "after-ujb8" → "run-20260128-after-ujb8"
 */
export function resolveRunId(partialId: string, workDir: string): string;

/**
 * Interactive run selection with scope and status display
 */
export async function promptRunSelection(
  runs: RunMeta[],
  message?: string
): Promise<string>;
```

### 1.3 Update RuntimeOptions

**File:** `src/cli/runtime-options.ts`

```typescript
export interface RuntimeOptions {
  // ... existing options
  run?: string;  // Explicit run ID
  runId?: string;  // Resolved run ID (set by selectOrRequireRun)
}
```

---

## Phase 2: Run-Aware State Functions

### 2.1 Add Run-Scoped Issue Functions

**File:** `src/state/issues.ts`

**Current code uses `getStatePathForCurrentRun()` from `src/state/paths.ts`:**
```typescript
// Line 12-14 in issues.ts
function getIssuesPath(workDir = process.cwd()): string {
  return getStatePathForCurrentRun("issues", workDir);
}
```

**Need to add:**
```typescript
import { getRunStateDir } from "./paths.ts";
import { join } from "node:path";
import { STATE_FILES } from "./types.ts";

// NEW: Get issues path for specific run
function getIssuesPathForRun(runId: string, workDir = process.cwd()): string {
  return join(getRunStateDir(runId, workDir), STATE_FILES.issues);
}

// NEW: Load issues for specific run
export function loadIssuesForRun(runId: string, workDir = process.cwd()): Issue[] {
  const path = getIssuesPathForRun(runId, workDir);
  
  if (!existsSync(path)) {
    return [];
  }
  
  try {
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content);
    
    if (!Array.isArray(parsed)) {
      return [];
    }
    
    const validIssues: Issue[] = [];
    for (const item of parsed) {
      const result = IssueSchema.safeParse(item);
      if (result.success) {
        validIssues.push(result.data);
      }
    }
    return validIssues;
  } catch (error) {
    logError(`Failed to load issues from ${path}:`, error);
    return [];
  }
}

// NEW: Save issues for specific run
export function saveIssuesForRun(runId: string, issues: Issue[], workDir = process.cwd()): void {
  const path = getIssuesPathForRun(runId, workDir);
  const dir = join(path, "..");
  
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  writeFileSync(path, JSON.stringify(issues, null, 2));
}

// NEW: Update issue in specific run
export function updateIssueForRun(
  runId: string,
  issueId: string,
  update: Partial<Omit<Issue, "id" | "created_at">>,
  workDir = process.cwd(),
): Issue | null {
  const issues = loadIssuesForRun(runId, workDir);
  const index = issues.findIndex((i) => i.id === issueId);
  
  if (index === -1) {
    return null;
  }
  
  const updated: Issue = {
    ...issues[index],
    ...update,
    updated_at: new Date().toISOString(),
  };
  
  const newIssues = [...issues.slice(0, index), updated, ...issues.slice(index + 1)];
  saveIssuesForRun(runId, newIssues, workDir);
  return updated;
}
```

**DEPRECATE existing functions:**
```typescript
/**
 * @deprecated Use loadIssuesForRun() with explicit runId to avoid race conditions
 * when multiple milhouse processes run in parallel.
 */
export function loadIssues(workDir = process.cwd()): Issue[] {
  // Keep existing implementation for backward compatibility
}
```

### 2.2 Add Run-Scoped Task Functions

**File:** `src/state/tasks.ts`

```typescript
// NEW: Load tasks for specific run
export function loadTasksForRun(runId: string, workDir?: string): Task[];

// NEW: Create task in specific run
export function createTaskForRun(
  runId: string,
  taskData: Omit<Task, 'id' | 'created_at' | 'updated_at'>,
  workDir?: string
): Task;

// NEW: Update task in specific run
export function updateTaskForRun(
  runId: string,
  taskId: string,
  update: Partial<Task>,
  workDir?: string
): Task | null;
```

### 2.3 Update Plan Store (Already Partially Done)

**File:** `src/state/plan-store.ts`

Already added:
- `writeIssueWbsPlanForRun()`
- `writeIssueWbsJsonForRun()`

Need to add:
- `readIssueWbsPlanForRun()`
- `readIssueWbsJsonForRun()`
- `writeProblemBriefForRun()`
- `readProblemBriefForRun()`
- `writeExecutionPlanForRun()`
- `readExecutionPlanForRun()`

---

## Phase 3: Update Commands to Use Explicit Run ID

### 3.1 Update Scan Command

**File:** `src/cli/commands/scan.ts`

```typescript
export async function runScan(options: RuntimeOptions): Promise<ScanResult> {
  const workDir = process.cwd();
  
  // Create new run (scan always creates)
  const runMeta = createRun({ scope: options.scope, workDir });
  const runId = runMeta.id;  // Lock in the run ID
  
  // All operations use runId explicitly
  // ... scan logic ...
  
  // Write results to specific run
  saveIssuesForRun(runId, issues, workDir);
  writeProblemBriefForRun(runId, problemBrief, workDir);
  
  return { runId, ... };
}
```

### 3.2 Update Validate Command

**File:** `src/cli/commands/validate.ts`

```typescript
export async function runValidate(options: RuntimeOptions): Promise<ValidateResult> {
  const workDir = process.cwd();
  
  // Select or prompt for run
  const { runId, runMeta } = await selectOrRequireRun(options.run, workDir, {
    requirePhase: ['scan', 'validate'],  // Must be in scan or validate phase
  });
  
  // Load issues from specific run
  const issues = loadIssuesForRun(runId, workDir);
  
  // ... validation logic ...
  
  // Update issues in specific run
  for (const issue of validatedIssues) {
    updateIssueForRun(runId, issue.id, issue, workDir);
  }
  
  // Write problem brief to specific run
  writeProblemBriefForRun(runId, problemBrief, workDir);
  
  return { runId, ... };
}
```

### 3.3 Update Plan Command

**File:** `src/cli/commands/plan.ts`

```typescript
export async function runPlan(options: RuntimeOptions): Promise<PlanResult> {
  const workDir = process.cwd();
  
  // Select or prompt for run
  const { runId, runMeta } = await selectOrRequireRun(options.run, workDir, {
    requirePhase: ['validate', 'plan'],
  });
  
  // Load issues from specific run
  const issues = loadIssuesForRun(runId, workDir);
  
  // ... planning logic ...
  
  // Create tasks in specific run
  for (const task of tasks) {
    createTaskForRun(runId, task, workDir);
  }
  
  // Write plans to specific run
  writeIssueWbsPlanForRun(workDir, runId, issueId, markdown);
  
  return { runId, ... };
}
```

### 3.4 Update Exec Command

**File:** `src/cli/commands/exec.ts`

Similar pattern - select run, load tasks from run, update tasks in run.

### 3.5 Update Run Command (Full Pipeline)

**File:** `src/cli/commands/run.ts`

```typescript
export async function runFullPipeline(options: RuntimeOptions): Promise<void> {
  const workDir = process.cwd();
  
  // Create run once at the start
  const runMeta = createRun({ scope: options.scope, workDir });
  const runId = runMeta.id;
  
  // Pass runId through entire pipeline
  const scanResult = await runScanForRun(runId, options);
  const validateResult = await runValidateForRun(runId, options);
  const planResult = await runPlanForRun(runId, options);
  const execResult = await runExecForRun(runId, options);
}
```

---

## Phase 4: Interactive Run Selection

### 4.1 Implement Interactive Prompt

**File:** `src/cli/commands/utils/run-selector.ts`

```typescript
import { select } from '@inquirer/prompts';

export async function promptRunSelection(
  runs: RunMeta[],
  message = 'Select a run:'
): Promise<string> {
  const choices = runs.map(run => ({
    name: formatRunChoice(run),
    value: run.id,
    description: run.scope,
  }));
  
  return select({
    message,
    choices,
  });
}

function formatRunChoice(run: RunMeta): string {
  const age = formatRelativeTime(run.created_at);
  const phase = run.phase.toUpperCase();
  const issues = run.issues_found > 0 ? `${run.issues_found} issues` : 'no issues';
  
  return `${run.id} [${phase}] - ${issues} - ${age}`;
}
```

### 4.2 Selection Logic

```typescript
export async function selectOrRequireRun(
  explicitRunId: string | undefined,
  workDir: string,
  options?: SelectRunOptions
): Promise<RunSelectionResult> {
  // 1. If explicit run ID provided, use it
  if (explicitRunId) {
    const runId = resolveRunId(explicitRunId, workDir);
    const runMeta = loadRunMeta(runId, workDir);
    if (!runMeta) {
      throw new Error(`Run not found: ${explicitRunId}`);
    }
    return { runId, runMeta };
  }
  
  // 2. Get all runs
  const allRuns = listRuns(workDir);
  
  // 3. Filter by phase if required
  let eligibleRuns = allRuns;
  if (options?.requirePhase) {
    eligibleRuns = allRuns.filter(r => options.requirePhase!.includes(r.phase));
  }
  
  // 4. If no eligible runs, error
  if (eligibleRuns.length === 0) {
    throw new Error('No eligible runs found. Start with: milhouse scan --scope "..."');
  }
  
  // 5. If exactly one eligible run, use it automatically
  if (eligibleRuns.length === 1) {
    const runMeta = loadRunMeta(eligibleRuns[0].id, workDir)!;
    console.log(`Using run: ${runMeta.id} (${runMeta.scope || 'no scope'})`);
    return { runId: runMeta.id, runMeta };
  }
  
  // 6. Multiple runs - prompt for selection
  const selectedId = await promptRunSelection(
    eligibleRuns.map(r => loadRunMeta(r.id, workDir)!),
    'Multiple runs available. Which one do you want to use?'
  );
  
  return {
    runId: selectedId,
    runMeta: loadRunMeta(selectedId, workDir)!,
  };
}
```

---

## Phase 5: File Locking for Concurrent Safety

### 5.1 Add File Locking Utility

**New File:** `src/state/file-lock.ts`

```typescript
import { lockSync, unlockSync, check } from 'proper-lockfile';

export interface LockOptions {
  retries?: number;
  stale?: number;  // Lock considered stale after this many ms
}

export async function withFileLock<T>(
  filePath: string,
  operation: () => T | Promise<T>,
  options?: LockOptions
): Promise<T> {
  const release = await lockSync(filePath, {
    retries: options?.retries ?? 5,
    stale: options?.stale ?? 10000,
  });
  
  try {
    return await operation();
  } finally {
    release();
  }
}

export function isFileLocked(filePath: string): boolean {
  return check(filePath);
}
```

### 5.2 Update State Functions to Use Locking

```typescript
// src/state/issues.ts
export async function updateIssueForRunSafe(
  runId: string,
  issueId: string,
  update: Partial<Issue>,
  workDir?: string
): Promise<Issue | null> {
  const issuesPath = getIssuesPathForRun(runId, workDir);
  
  return withFileLock(issuesPath, () => {
    const issues = loadIssuesForRun(runId, workDir);
    const index = issues.findIndex(i => i.id === issueId);
    if (index === -1) return null;
    
    issues[index] = { ...issues[index], ...update, updated_at: new Date().toISOString() };
    saveIssuesForRun(runId, issues, workDir);
    return issues[index];
  });
}
```

---

## Phase 6: Deprecation and Migration

### 6.1 Mark Old Functions as Deprecated

```typescript
/**
 * @deprecated Use loadIssuesForRun() with explicit runId instead.
 * This function relies on getCurrentRunId() which can return wrong run
 * in concurrent scenarios.
 */
export function loadIssues(workDir?: string): Issue[] {
  console.warn('DEPRECATION: loadIssues() is deprecated. Use loadIssuesForRun()');
  const runId = getCurrentRunId(workDir);
  if (!runId) return [];
  return loadIssuesForRun(runId, workDir);
}
```

### 6.2 Update All Callers

Search and replace all usages:
- `loadIssues(workDir)` → `loadIssuesForRun(runId, workDir)`
- `loadTasks(workDir)` → `loadTasksForRun(runId, workDir)`
- `updateIssue(id, update, workDir)` → `updateIssueForRun(runId, id, update, workDir)`
- etc.

---

## Phase 7: Testing

### 7.1 Unit Tests for Run Selector

```typescript
// tests/unit/cli/run-selector.test.ts
describe('selectOrRequireRun', () => {
  it('should use explicit run ID when provided', async () => {
    // ...
  });
  
  it('should auto-select when only one eligible run', async () => {
    // ...
  });
  
  it('should prompt when multiple eligible runs', async () => {
    // ...
  });
  
  it('should resolve partial run IDs', async () => {
    // ...
  });
});
```

### 7.2 Integration Tests for Concurrent Operations

```typescript
// tests/integration/concurrent-runs.test.ts
describe('Concurrent run operations', () => {
  it('should isolate data between parallel scans', async () => {
    // Start two scans in parallel
    const scan1 = runScan({ scope: 'scope A' });
    const scan2 = runScan({ scope: 'scope B' });
    
    const [result1, result2] = await Promise.all([scan1, scan2]);
    
    // Verify each scan wrote to its own run
    expect(result1.runId).not.toBe(result2.runId);
    
    const issues1 = loadIssuesForRun(result1.runId);
    const issues2 = loadIssuesForRun(result2.runId);
    
    // Issues should not be mixed
    expect(issues1.every(i => i.scope === 'scope A')).toBe(true);
    expect(issues2.every(i => i.scope === 'scope B')).toBe(true);
  });
});
```

---


## Risk Mitigation

### Breaking Changes
- Old scripts using `loadIssues()` will still work (with deprecation warning)
- Gradual migration path via deprecation

### Performance
- File locking adds ~10-50ms overhead per operation
- Acceptable for CLI tool, not for high-throughput scenarios

### Backwards Compatibility
- Existing runs will continue to work
- `current_run` in runs-index.json remains for single-terminal workflows
- New `--run` parameter is optional

---

## Success Criteria

1. **Isolation**: Two parallel `milhouse run` commands don't mix data
2. **Explicit**: User always knows which run is being used
3. **Safe**: File locking prevents data corruption
4. **UX**: Interactive selection when ambiguous
5. **Compatible**: Existing workflows continue to work

---

## Task Checklist

### Phase 1: CLI Parameter `--run-id`

- [ ] **1.1** Add `--run-id <id>` option to `src/cli/args.ts` (after line 100)
- [ ] **1.2** Add `runId?: string` to `RuntimeOptions` in `src/cli/runtime-options.ts`
- [ ] **1.3** Parse `opts.runId` in `parseArgs()` function in `src/cli/args.ts`
- [ ] **1.4** Create `src/cli/commands/utils/run-selector.ts` file
  - [ ] Implement `resolveRunId(partialId, workDir)` function
  - [ ] Implement `selectOrRequireRun(explicitRunId, workDir, options)` function
  - [ ] Implement `promptRunSelection(runs, message)` function

### Phase 2: Run-Aware State Functions

- [ ] **2.1** Update `src/state/issues.ts`
  - [ ] Add `getIssuesPathForRun(runId, workDir)` internal function
  - [ ] Add `loadIssuesForRun(runId, workDir)` export
  - [ ] Add `saveIssuesForRun(runId, issues, workDir)` export
  - [ ] Add `updateIssueForRun(runId, issueId, update, workDir)` export
  - [ ] Add `createIssueForRun(runId, issue, workDir)` export
  - [ ] Add deprecation warning to `loadIssues()`
  - [ ] Add deprecation warning to `saveIssues()`
  - [ ] Add deprecation warning to `updateIssue()`

- [ ] **2.2** Update `src/state/tasks.ts`
  - [ ] Add `getTasksPathForRun(runId, workDir)` internal function
  - [ ] Add `loadTasksForRun(runId, workDir)` export
  - [ ] Add `saveTasksForRun(runId, tasks, workDir)` export
  - [ ] Add `createTaskForRun(runId, task, workDir)` export
  - [ ] Add `updateTaskForRun(runId, taskId, update, workDir)` export
  - [ ] Add deprecation warnings to old functions

- [ ] **2.3** Update `src/state/plan-store.ts`
  - [ ] Add `readIssueWbsPlanForRun(workDir, runId, issueId)` export
  - [ ] Add `readIssueWbsJsonForRun(workDir, runId, issueId)` export
  - [ ] Add `writeProblemBriefForRun(workDir, runId, content)` export
  - [ ] Add `readProblemBriefForRun(workDir, runId)` export
  - [ ] Add `writeExecutionPlanForRun(workDir, runId, content)` export
  - [ ] Add `readExecutionPlanForRun(workDir, runId)` export

### Phase 3: Update Commands

- [ ] **3.1** Update `src/cli/commands/scan.ts`
  - [ ] Use `saveIssuesForRun(runMeta.id, issues, workDir)` instead of `saveIssues()`
  - [ ] Verify problem brief already uses `runMeta.id` directly (already fixed)

- [ ] **3.2** Update `src/cli/commands/validate.ts`
  - [ ] Add `selectOrRequireRun()` call at start
  - [ ] Replace `loadIssues(workDir)` with `loadIssuesForRun(runId, workDir)`
  - [ ] Replace `updateIssue()` calls with `updateIssueForRun(runId, ...)`
  - [ ] Verify problem brief already uses `currentRun.id` directly (already fixed)

- [ ] **3.3** Update `src/cli/commands/plan.ts`
  - [ ] Add `selectOrRequireRun()` call at start
  - [ ] Replace `loadIssues(workDir)` with `loadIssuesForRun(runId, workDir)`
  - [ ] Replace `createTask()` calls with `createTaskForRun(runId, ...)`
  - [ ] Verify WBS writing already uses `writeIssueWbsPlanForRun()` (already fixed)

- [ ] **3.4** Update `src/cli/commands/exec.ts`
  - [ ] Add `selectOrRequireRun()` call at start
  - [ ] Replace `loadTasks(workDir)` with `loadTasksForRun(runId, workDir)`
  - [ ] Replace `updateTask()` calls with `updateTaskForRun(runId, ...)`
  - [ ] Replace `loadIssues(workDir)` with `loadIssuesForRun(runId, workDir)`

- [ ] **3.5** Update `src/cli/commands/consolidate.ts`
  - [ ] Add `selectOrRequireRun()` call at start
  - [ ] Use run-aware plan-store functions

- [ ] **3.6** Update `src/cli/commands/verify.ts`
  - [ ] Add `selectOrRequireRun()` call at start
  - [ ] Use run-aware state functions

- [ ] **3.7** Update `src/cli/commands/run.ts` (full pipeline)
  - [ ] Create run once at start, capture `runId`
  - [ ] Pass `runId` to all pipeline steps
  - [ ] Create `runScanForRun()`, `runValidateForRun()`, etc. variants

### Phase 4: Interactive Selection

- [ ] **4.1** Add `@inquirer/prompts` dependency to `package.json`
- [ ] **4.2** Implement `promptRunSelection()` with formatted choices
- [ ] **4.3** Add `formatRunChoice(run)` helper function
- [ ] **4.4** Add `formatRelativeTime(isoDate)` helper function
- [ ] **4.5** Test interactive selection with multiple runs

### Phase 5: File Locking

- [ ] **5.1** Add `proper-lockfile` dependency to `package.json`
- [ ] **5.2** Create `src/state/file-lock.ts`
  - [ ] Implement `withFileLock(filePath, operation, options)` function
  - [ ] Implement `isFileLocked(filePath)` function
- [ ] **5.3** Add `*Safe()` versions of critical state functions
  - [ ] `updateIssueForRunSafe()`
  - [ ] `updateTaskForRunSafe()`
  - [ ] `batchUpdateIssuesForRunSafe()`
- [ ] **5.4** Update commands to use `*Safe()` functions where needed

### Phase 6: Testing

- [ ] **6.1** Create `tests/unit/cli/run-selector.test.ts`
  - [ ] Test `resolveRunId()` with full and partial IDs
  - [ ] Test `selectOrRequireRun()` with explicit ID
  - [ ] Test `selectOrRequireRun()` with single eligible run
  - [ ] Test `selectOrRequireRun()` with multiple runs (mock prompt)
  - [ ] Test phase filtering

- [ ] **6.2** Create `tests/integration/concurrent-runs.test.ts`
  - [ ] Test parallel scans don't mix data
  - [ ] Test parallel validates don't corrupt issues
  - [ ] Test file locking prevents race conditions

- [ ] **6.3** Update existing tests
  - [ ] Update tests that use `loadIssues()` to use `loadIssuesForRun()`
  - [ ] Update tests that use `loadTasks()` to use `loadTasksForRun()`

### Phase 7: Documentation & Cleanup

- [ ] **7.1** Update `docs/cli-contract.md` with `--run-id` parameter
- [ ] **7.2** Update `README.md` with run isolation examples
- [ ] **7.3** Add JSDoc deprecation notices to all old functions
- [ ] **7.4** Remove any remaining `getCurrentRunId()` calls in commands
- [ ] **7.5** Run full test suite and fix any regressions

### Verification

- [ ] **V1** Test: Two parallel `milhouse scan` commands create separate runs
- [ ] **V2** Test: `milhouse validate --run-id <id>` uses correct run
- [ ] **V3** Test: Interactive prompt appears when multiple runs exist
- [ ] **V4** Test: Partial run ID matching works (e.g., `--run-id after-ujb8`)
- [ ] **V5** Test: Existing single-terminal workflow still works without `--run-id`
