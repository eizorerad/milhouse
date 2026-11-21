# Upgrading

What changes for you between versions, newest first. `milhouse upgrade` brings an installation to the latest one.

## From 0.5.3

- To get it: in a git checkout, `git pull && bun install` this once; from 0.5.4 on, `milhouse upgrade` does it.
- Nothing has to be prepared: the first run writes the config (with the agent that is installed), `.milhouse/` is ignored by git through its own ignore file, and uncommitted changes stop neither a run nor its merge.
- A run no longer needs its branch checked out: it can be resumed and merged from any branch, and from a detached HEAD it does its work and leaves the merge for a branch. The merge moves the branch the run started on, unless that branch is in the middle of a rebase or a bisect: then it waits for `milhouse --merge`.
- A failed agent call waits longer before it is tried again (about 15 seconds, a minute, four) instead of a few seconds.
- A new run removes finished runs older than 30 days and the worktrees of earlier runs.
- Every command ends with the report of its run.
- New: `milhouse upgrade`; releases carry binaries that `install.sh` installs without Bun; `--budget`, `--max-tokens`, `--max-minutes`, `--no-baseline`; `$MILHOUSE_PROJECT` for `commands.setup`. Old configs load unchanged; one without a build, lint or test command gets what the project defines, at every run.

## From 0.5.2

- Every step now works in the run's worktree, on the commit the run began with: scan, validate and plan no longer read your checkout. Uncommitted changes and untracked files are not part of a run; a new run that includes exec refuses to start with them, one that only reads warns.
- `--clean` keeps a run whose accepted work was never merged, and removes the `mh-failed/` branches of the runs it removes. `--clean --all` also takes old stopped and interrupted runs.
- A `neverTouch` or `gates.ignore` pattern that would match no file (`./x`, spaces around it) is an error now: such a pattern protected nothing before.
- The `placeholder` gate no longer stops on `not implemented` or `NotImplementedError`, nor on the word `TODO` outside a note; `*.snap` joined the default `gates.ignore`.
- The evidence gate rejects citations of more than 200 lines.
- Text given to a command that continues a run (`--resume "..."`) and an unknown `--format` are errors; `--run-id <id>` alone resumes that run.
- New: `maxTokens` (a token limit for Codex), `--report --format json`, `--clean --all`. Old configs load unchanged.

## From 0.5.1

- exec refuses to start without a build, lint or test command: set one in your `.milhouse/config.ts` (`milhouse init` writes what a project defines, but leaves an existing config alone), or pass `--allow-unchecked`.
- A run whose checks already fail on the starting commit stops before it spends anything. Set `gates.baseline: false` to go on anyway.
- `placeholder` and `diffHygiene` skip binary files and, by default, `*.md`, `*.tsv`, `*.csv`, `*.patch` and `*.diff` (`gates.ignore`).
- `neverTouch` patterns without a slash (`.env*`, `LICENSE`) now match at any depth, as in `.gitignore`; write `/LICENSE` for the root only. A pattern that starts with `!` is an error now (before, it matched in an odd way).
- The worktree moved out of `.milhouse/work` into `~/.cache/milhouse` (`MILHOUSE_WORK_DIR` overrides it); a run that began with 0.5.1 keeps its old one for as long as that folder exists.
- New options: `maxMinutes`, `commandTimeoutMinutes`, `phases.<step>.timeoutMinutes`, `allowUnchecked`, `gates.baseline`, `gates.ignore`. Old configs load unchanged.

## From 0.3

Config: `cost.budget` → `budget`, `boundaries.neverTouch` → `neverTouch`, `engine` and the token prices are gone (Claude Code only, real cost), `phases.<x>.workers` exists only for `validate` and `plan`, and `verify` is now the reviewer step inside `exec`, not a phase. exec is sequential on purpose; `--resolve`, `--exec-workers` and `--phase-workers` went with parallel branches.

---
[← README](../README.md)
