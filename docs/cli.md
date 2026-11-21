# CLI and run state

Every command, how a run is continued, and what a run leaves on disk.

## Commands

```
milhouse "fix auth bugs"        run the whole pipeline; the text is the scope
milhouse --run                  same, without a scope
milhouse --resume               continue the latest run (--run-id <id> for another)
milhouse --scan | --validate | --plan | --consolidate | --exec | --merge
                                run one phase (all but --scan continue the latest run)
milhouse --report [--format md|json]
                                the run: every issue with its verdict, its tasks and their commits, failures, cost
milhouse --list-runs            list runs
milhouse --clean [--days 30] [--all]
                                delete finished runs (--all: stopped and interrupted ones too)
milhouse init                   create .milhouse/config.ts (also: --init)
milhouse upgrade                update Milhouse itself: the binary of a release, or the git checkout it runs from
  --scope <text>  --workers <n>  --harness <claude|codex>  --model <name>  --run-id <id>
  --budget <usd>  --max-tokens <n>  --max-minutes <n>     limits for this command (0 = none)
  --allow-unchecked  --no-baseline  -v  -V  -h
```

Unknown flags are an error; with no arguments you get the help. It works from any subdirectory. The exit code is 0 only if everything that was asked for succeeded.

To look at the plan before anything is changed, stop before exec and read the report: `milhouse --scan "fix auth bugs"`, then `--validate`, `--plan`, `--consolidate` and `milhouse --report`; `milhouse --resume` goes on from there. A run keeps the scope it started with, so a command that continues one takes no text.

An agent call that fails (an outage, a rate limit, a timeout) is tried again by itself after a pause that grows: about 15 seconds, then a minute, then four, as often as `phases.<step>.retries` says. `--resume` skips finished phases and retries failed items, feeding the old failure back to the agent (not an outage or a timeout of the agent's call: there is nothing in it to fix). `--run-id <id>` alone resumes that run. When the budget is already spent, a resume starts no agent but still merges what was accepted. A phase counts as finished only when everything before it did. A run can be continued whatever is checked out: its work goes to the branch it started on. One that began on a detached HEAD (a CI checkout) does all its work and leaves the merge: it takes the branch it is continued on, if that branch holds its starting commit. An issue that was interrupted mid-way starts again from the accepted state. If only the review failed (an outage, the budget), the finished work is kept on its parked branch and only the review is repeated, as long as no other issue was accepted in between.

## Run state

```
.milhouse/config.ts          your config (to share it: git add -f .milhouse/config.ts)
.milhouse/runs/<run-id>/     meta.json  issues.json  tasks.json  cost.json  events.jsonl
~/.cache/milhouse/<project>/<run-id>/  the run's worktree (MILHOUSE_WORK_DIR moves it; a run of 0.5.1 keeps .milhouse/work/<run-id>/ while that exists)
refs/milhouse/<run-id>       accepted work; mh-failed/<issue-id> holds failed attempts
```

`events.jsonl` has one JSON object per line: every failed attempt with its reason, every verdict of the reviewer with its reason (approvals too), whether each issue was accepted or failed, why a run stopped at its starting commit, and every agent call with its step, its cost and the start of its answer (the executor's own account of what it did, for example). The whole `.milhouse/` folder is ignored by git through its own `.milhouse/.gitignore`; your `.gitignore` is not touched. A config that you add with `git add -f` is tracked from then on like any other file. A project set up by an earlier version keeps the ignore file it has, where `config.ts` was left visible to be committed.

A new run tidies up before it starts: finished runs older than 30 days go as with `--clean`, and so do the worktrees of all earlier runs (a run that is resumed later gets a new one, and its setup runs again). `--clean` removes a finished run (completed or failed) that is older than `--days`, with its worktree, its ref and the `mh-failed/` branches of its issues. A run whose accepted work was never merged is kept, records included, so that `--merge --run-id <run-id>` still works; the message says how to give the work up instead. Stopped runs can be resumed and stay, as do runs that were killed before they could say how they ended: `--clean --all` takes those too. `--days 0` means whatever their age.

---
[← README](../README.md)
