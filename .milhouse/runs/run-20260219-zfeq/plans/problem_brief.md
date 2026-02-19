# Work Brief v0

> **Status**: UNVALIDATED
> **Run ID**: run-20260219-zfeq
> **Generated**: 2026-02-19T19:23:20.121Z
> **Work Items Found**: 11

---

## Work Items

### P-mltumks8-ct5x00: Pipeline exec phase is a no-op stub

| Field | Value |
|-------|-------|
| **Type** | bug |
| **Status** | UNVALIDATED |
| **Severity** | HIGH |
| **Rationale** | In `src/pipeline/orchestrator.ts:134-139`, the `exec` phase simply logs 'delegating to exec module' and continues with no actual execution. The comment says 'wired in T9' but the delegation was never implemented. A full `milhouse --run` pipeline will skip task execution entirely, making the orchestrator unable to complete its primary purpose. |

---

### P-mltumks8-ortg2o: createRun mutates runs index without file locking

| Field | Value |
|-------|-------|
| **Type** | bug |
| **Status** | UNVALIDATED |
| **Severity** | MEDIUM |
| **Rationale** | In `src/state/runs.ts:310-319`, `createRun()` calls `loadRunsIndex()`, mutates the array, then calls `saveRunsIndex()` without any file locking. Other concurrent-safe functions like `updateRunPhaseInMetaWithLock` and `saveRunsIndexWithLock` use proper locking. If two processes create runs simultaneously, one run entry could be lost due to the read-modify-write race condition. |

---

### P-mltumks8-toflnc: Run lock (acquireRunLock) has TOCTOU race condition

| Field | Value |
|-------|-------|
| **Type** | bug |
| **Status** | UNVALIDATED |
| **Severity** | MEDIUM |
| **Rationale** | In `src/state/run-lock.ts:44-68`, `acquireRunLock` checks if the lock file exists with `existsSync`, reads it, checks the PID, then writes a new lock. Between the check and the write, another process could acquire the same lock. Unlike the file-lock mechanism used in `runs.ts` (which uses atomic operations), this lock uses a non-atomic check-then-write pattern. |

---

### P-mltumks8-j6s5j6: Stash pop failure silently ignored in BranchService

| Field | Value |
|-------|-------|
| **Type** | bug |
| **Status** | UNVALIDATED |
| **Severity** | MEDIUM |
| **Rationale** | In `src/vcs/services/branch-service.ts:141-143` (success path) and `152-154` (error path), `git stash pop` results are not checked. If stash pop fails (e.g., merge conflicts with the new branch state), the user's stashed changes could be silently left in the stash. The user would not be informed that their changes were not restored. |

---

### P-mltumks8-53u12t: clearEngineRateLimiters uses Promise.all instead of Promise.allSettled

| Field | Value |
|-------|-------|
| **Type** | bug |
| **Status** | UNVALIDATED |
| **Severity** | MEDIUM |
| **Rationale** | In `src/engines/middleware/rate-limit.ts:155-162`, `clearEngineRateLimiters()` uses `Promise.all()` to stop all limiters. If any `limiter.stop()` throws, the remaining limiters won't be stopped and `engineLimiters.clear()` may leave zombie entries. The same pattern exists in `RateLimiterGroup.stopAll()` at lines 244-249. |

---

### P-mltumks8-l9ecvz: ProgressiveTimeoutState.reset() does not restore initial timeout

| Field | Value |
|-------|-------|
| **Type** | bug |
| **Status** | UNVALIDATED |
| **Severity** | MEDIUM |
| **Rationale** | In `src/engines/middleware/timeout.ts:173`, the `reset()` method computes `this.currentTimeout = this.maxTimeout / this.multiplier ** 3` instead of restoring to the original `initialTimeout`. This formula only equals `initialTimeout` when `multiplier^3` happens to be the correct ratio, which is coincidental. After a success, the progressive timeout resets to an unpredictable value rather than the configured starting point. |

---

### P-mltumks8-icfl3e: PrService emits misleading event names for non-branch-create operations

| Field | Value |
|-------|-------|
| **Type** | improvement |
| **Status** | UNVALIDATED |
| **Severity** | LOW |
| **Rationale** | In `src/vcs/services/pr-service.ts`, the `git:branch:create` event is emitted for branch pushes (line 96: `pushed:${branch}`), PR creation failures (line 171: `pr-failed:${branch}`), and PR creation success (line 181: `pr-created:${branch}`). Using the same event name with a prefixed payload makes it impossible to distinguish operations via event handlers and makes debugging harder. |

---

### P-mltumks8-kmmq3c: Default engine timeout of 66 minutes may mask hung processes

| Field | Value |
|-------|-------|
| **Type** | improvement |
| **Status** | UNVALIDATED |
| **Severity** | LOW |
| **Rationale** | In `src/engines/middleware/timeout.ts:45`, the default timeout is `4000000`ms (~66 minutes). While LLM operations can be slow, this extremely high default means a stuck engine process won't be detected for over an hour. Most LLM calls complete within a few minutes, and a 66-minute timeout provides almost no protection against hangs. |

---

### P-mltumks8-nh1dv3: loadRunMeta uses unsafe `null as unknown as RunMeta` default

| Field | Value |
|-------|-------|
| **Type** | improvement |
| **Status** | UNVALIDATED |
| **Severity** | LOW |
| **Rationale** | In `src/state/runs.ts:174`, `loadRunMeta` passes `null as unknown as RunMeta` as the default value to `loadJsonFile`. If the file exists but parsing fails, `loadJsonFile` returns this type-punned null as if it were a valid `RunMeta`. The function signature says it returns `RunMeta | null`, but callers may not be aware that a parsed-but-invalid file also produces null. The same pattern appears in `src/state/probes.ts`. |

---

### P-mltumks8-quqwnx: Diff analyzer uses hardcoded 500-line threshold for large file detection

| Field | Value |
|-------|-------|
| **Type** | improvement |
| **Status** | UNVALIDATED |
| **Severity** | LOW |
| **Rationale** | In `src/gates/diff/analyzer.ts:26`, the large file threshold is hardcoded as `changes > 500`. This is not configurable, which means it can't be adjusted for projects where larger diffs are expected (e.g., generated code, migrations). The hygiene score deduction for large files (line 148) is also hardcoded. |

---

### P-mltumks8-ctahic: Duplicate in-memory lock pattern across run state functions

| Field | Value |
|-------|-------|
| **Type** | refactor |
| **Status** | UNVALIDATED |
| **Severity** | LOW |
| **Rationale** | In `src/state/runs.ts`, the in-memory lock pattern (wait-for-promise, create new promise, try/finally release) is repeated identically in `updateRunMetaWithLock` (lines 460-491), `updateRunPhaseInMetaWithLock` (lines 497-543), and `saveRunsIndexWithLock` (lines 566-594). Each uses the same structure with different lock variables (`runMetaLockPromise`, `runsIndexLockPromise`). |

---

## Next Steps

1. Run `milhouse validate` to validate each work item with evidence
2. Run `milhouse plan` to generate WBS for confirmed work items
