# Pipeline Remaining Issues — Root Cause Analysis & Fix Plan

## Issue 1: `continueRebase` returns false after AI resolves files

### Root Cause

`continueRebase()` in `merge-service.ts:477-500` does:
```
git add -A
git rebase --continue
```

When `rebase --continue` exits non-zero, it returns `ok(false)` — but it doesn't distinguish between:
1. **More conflicts in later commits** — rebase has multiple commits, first resolved but next has conflicts
2. **Editor prompt** — `rebase --continue` may open an editor (needs `GIT_EDITOR=true` or `--no-edit`)
3. **Nothing to commit** — AI already ran `git add` + `git rebase --continue` itself

The code at line 490-496 has a catch-all `return ok(false)` for any non-zero exit, losing the actual reason:

```typescript
if (continueResult.value.exitCode !== 0) {
    // Check if there are still conflicts
    const conflictedFilesResult = await this.getConflictedFiles(workDir);
    if (conflictedFilesResult.ok && conflictedFilesResult.value.length > 0) {
        return ok(false);  // conflicts remain
    }
    return ok(false);  // <-- CATCH-ALL: unknown failure, no error info
}
```

### Fix Plan

1. **Set `GIT_EDITOR=true`** in the rebase --continue command to prevent editor prompts
2. **Log stderr** when rebase --continue fails for debugging
3. **Loop for multi-commit rebases**: after resolving one conflict, rebase --continue may hit the next commit's conflict — need to detect and loop
4. **Check if rebase is still in progress** after continue fails — if not, it actually succeeded
5. **In `conflict-resolution.ts`**: when `continueRebase` returns false, check `isRebaseInProgress` — if false, rebase completed

### Files to Modify
- `src/vcs/services/merge-service.ts` — `continueRebase()`: add GIT_EDITOR, loop, better error reporting
- `src/execution/runtime/conflict-resolution.ts` — handle `continueRebase` false + isRebaseInProgress check

---

## Issue 2: Phantom Completions — agents mark tasks done without code

### Root Cause

The issue is NOT in milhouse — it's in **Claude Code agent behavior**. Here's what happens:

1. Claude agent receives prompt with task list
2. Agent reads files, understands what needs to be done
3. Agent **reports success** to the engine but doesn't actually edit/commit the files
4. Engine returns `success: true` with response text
5. `analyzeIssueTaskCompletion()` checks git commits and finds NO matching commits
6. **BUT** — in the current flow on line 933-935, `completedTaskIds` from analysis is used correctly

Wait — looking more carefully at the verify output:
```
13 tasks (22%) across 4 task groups have NO implementation evidence
despite being reported as completed
```

This means `analyzeIssueTaskCompletion` DID mark them as completed (found matching commits). But verify found no actual code changes in those commits. The issue is:

**The commit matcher is too loose** — `matchTasksToCommits` at line 60-68 matches by:
1. Exact pattern: `[ISSUE_ID] Task N:`
2. Title substring match (case-insensitive)

Claude Code agents create commits with matching messages even when the commits are **empty** or contain trivial changes. The matcher sees the commit message and says "completed" without verifying the commit actually has meaningful diffs.

### Fix Plan

1. **Add diff-size validation** to `matchTasksToCommits`: after finding a matching commit, check that it has non-trivial diffs using `git diff --stat`
2. **Minimum diff threshold**: a task commit should have at least 1 file changed with 1+ lines
3. **Log warning** when commit matches by message but has zero diffs
4. **Optional: Add commit diff check to exec phase prompt** — instruct agents to verify their own work compiled/passes tests before committing

### Files to Modify
- `src/execution/utils/task-commit-matcher.ts` — add diff validation
- `src/vcs/backends/git-cli.ts` — add `getCommitDiffStats(hash)` function

---

## Issue 3: EBUSY worktree cleanup on Windows

### Root Cause

Windows file locking — when a process (Claude CLI) has a file open in the worktree directory, Windows prevents deletion with `EBUSY: resource busy or locked`.

The current code in `issue-executor.ts:1080-1142` already has 3 levels of escalation:
1. Normal cleanup via `cleanupWorktree()`
2. Force cleanup with `force: true`
3. Manual `rmSync` + `git worktree prune`

All 3 fail because **the Claude CLI child process may still be running** or has files memory-mapped.

### Fix Plan

1. **Kill child processes before cleanup**: ensure the Claude CLI process for this worktree is fully terminated before attempting cleanup. Track PIDs per worktree.
2. **Add retry with delay**: Windows file locks are often transient — wait 1-2 seconds between cleanup attempts
3. **Use `rimraf` pattern**: on Windows, rename directory first, then delete — avoids EBUSY on in-use files
4. **Deferred cleanup**: if all 3 attempts fail, schedule cleanup for after merge phase (the merge happens in an isolated worktree anyway)
5. **Short-term**: The current exclusion from merge is the correct safety behavior. These branches can be merged manually.

### Files to Modify
- `src/execution/issue-executor.ts` — add delay between cleanup retries, track child PIDs
- `src/vcs/services/worktree-service.ts` — add Windows-specific rename-then-delete pattern

---

## Issue 4: "Pipeline failed: unknown error"

### Root Cause

In `run.ts:55-58`:
```typescript
if (!result.success) {
    logError(`Pipeline failed${result.stoppedAt ? ` at phase "${result.stoppedAt}"` : ""}: ${result.error ?? "unknown error"}`);
}
```

The pipeline returns `{ success: false }` when `allSuccess = outcomes.every(o => o.success)` is false on line 313. But `result.error` is only set when `failResult()` is called — which only happens for `failFast` or `BudgetExceededError`.

When failFast is **disabled** (the default), the pipeline runs all phases and then checks if all succeeded. If exec failed but pipeline continued to verify:
- `allSuccess = false` — correct
- `result.error = undefined` — no error was set because no failResult was called
- `result.stoppedAt = undefined` — pipeline didn't stop, it completed all phases

So the message becomes: `Pipeline failed: unknown error`

### Fix Plan

1. **Set error message from outcomes**: when `allSuccess` is false, build an error message from failed phase outcomes
2. **Set stoppedAt** to the first failed phase even when failFast is disabled

### Files to Modify
- `src/pipeline/orchestrator.ts` — line 313-315: build error/stoppedAt from outcomes

---

## Priority Order

| Priority | Issue | Impact | Complexity |
|----------|-------|--------|------------|
| 1 | Issue 4: unknown error message | UX — confusing | Very Low |
| 2 | Issue 2: phantom completions | Quality — 22% false positives | Low |
| 3 | Issue 1: continueRebase | Merge success rate | Medium |
| 4 | Issue 3: EBUSY Windows | 2 branches excluded | Medium |

## Summary of Changes

| File | Issues Addressed |
|------|-----------------|
| `src/pipeline/orchestrator.ts` | #4 — error message |
| `src/execution/utils/task-commit-matcher.ts` | #2 — diff validation |
| `src/vcs/backends/git-cli.ts` | #2 — getCommitDiffStats |
| `src/vcs/services/merge-service.ts` | #1 — continueRebase improvements |
| `src/execution/runtime/conflict-resolution.ts` | #1 — isRebaseInProgress check |
| `src/execution/issue-executor.ts` | #3 — retry delay, PID tracking |
| `src/vcs/services/worktree-service.ts` | #3 — Windows rename-delete |
