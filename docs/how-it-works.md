# How it works

What each phase does, what the gates block, and when work merges by itself.

## The pipeline

```
scan → validate → plan → consolidate → exec → merge
```

| Phase | What happens |
|---|---|
| scan | A read-only agent lists work items (bugs, features, refactors) for your scope. |
| validate | Each item is checked against the code and the run's scope. Milhouse checks the cited snippets and prints the verdict with a short reason. |
| plan | Each real issue becomes a few small tasks with acceptance criteria. |
| consolidate | Duplicate tasks are merged. Dependencies between issues decide the order. |
| exec | Issues run **one at a time** in a git worktree, each on top of the ones accepted before it. The reviewer sees which build, lint and test commands passed, or that none ran. |
| merge | Work that passed project checks is fast-forwarded into the original branch. Unchecked work waits for an explicit `--merge`. |

## One commit for the whole run

Every step works in the run's own worktree, never in your checkout: on the commit your branch was at when the run began, and on top of it the work the run accepted since. So scan, validate and plan judge the same code that exec changes, and you can go on working while a run is under way, on that branch or on another one. At the end `merge` moves the branch the run started on: where it is checked out, forward around your uncommitted edits (only if one of them is to a file that the run changed too does it stop, and say so); where it is not, as a name, without touching a file. What you commit in the meantime meets the run's work in `merge`, in a merge commit that has to pass the checks too.

## What exec does with an issue

The agent commits one commit per task (`[<task id>] <title>`) → Milhouse runs the gates → a reviewer agent checks the acceptance criteria against the diff → the issue is accepted. Any failure goes back to the agent as feedback for a repair round (`phases.exec.retries`). An issue that still fails is parked on `mh-failed/<issue-id>`, its worktree is thrown away (a failed attempt may have installed dependencies the next issue would silently build on) and the next issue carries on from a fresh one, so no issue builds on broken work and every issue is tested on top of all the accepted ones. An issue that depends on a failed one waits.

## Gates

| Gate (`gates.*`) | Blocks |
|---|---|
| `evidence` (validate) | issues whose cited file does not exist, or whose snippet is not found at the cited lines (give or take five; a citation of more than 200 lines, or with line numbers that are not whole numbers, does not count) |
| `placeholder` | new `TODO` / `FIXME` notes (where a comment begins, or `TODO:` where a line begins) and Rust's `todo!()` / `unimplemented!()`. The word alone, in an enum or a string, is not one; whether a `throw new Error("not implemented")` is a stub is for the reviewer to say |
| `diffHygiene` | trailing whitespace and conflict markers in added lines |
| `baseline` | a run whose `commands.build` / `lint` / `test` already fail on the starting commit: it stops before scan spends anything, because it could not tell its own mistakes from what was broken before. If the failure is what the run should fix, start it with `--no-baseline` (or set `gates.baseline: false`). The checks run in the worktree that exec uses next, so what they leave there (ignored by git) stays |
| `dod` | failing `commands.build` / `lint` / `test`; a reviewer that finds unmet acceptance criteria or unnecessary complexity in the change |
| always on | tasks without a commit, uncommitted leftovers, history that drops accepted commits, any commit touching a `neverTouch` path or `.milhouse/` (renames and merges included), checks that move HEAD or rewrite tracked files |

`placeholder` and `diffHygiene` skip binary files and the files that `gates.ignore` names (patterns as in `.gitignore`; by default `*.md`, `*.tsv`, `*.csv`, `*.patch`, `*.diff` and `*.snap`, where trailing spaces or a TODO in the text are not mistakes). A list in the config replaces the default. Conflict markers in the skipped files are not looked for either, and a change of more than 32 MB is refused whatever the list says.

## Simple changes

The planner and executor look for a direct change that fits the existing code. To send work back for complexity, the reviewer must point to the code and explain a simpler alternative that preserves behaviour, safeguards and tests. For example, it can point to an existing parser that the patch duplicates. Line count and style preferences are not grounds for rejection.

## When work merges by itself

Automatic merge requires at least one build, lint or test command to have run on the accepted commit, with all checks passing. Setup alone does not count. If your branch advanced, the new merge commit must pass project checks too. A conflict or failing check leaves your branch untouched.

## No checks, no run

Without a build, lint or test command only an agent reviews the work and nothing merges by itself, so exec refuses to start (also when it resumes a run of 0.5.1); `allowUnchecked: true` in the config, or `--allow-unchecked` for one run, lets it go on. `gates.dod: false` switches the checks and the review off together and is not refused. The first run (or `milhouse init`, which starts nothing) writes the commands your project defines into the config and prints them: `package.json` scripts with the install that matches the lock file (a `lint` script that rewrites files, `--fix`, is no check and is left out), Cargo, Go, Python tests with an environment of the run's own (uv, Poetry or `requirements.txt`), Makefile targets, and the fetching of submodules. They run on every issue: change them in `.milhouse/config.ts` if they are not the right ones. A config without a build, lint or test command is not the last word: at every run Milhouse looks in the project again and uses what it defines by then, and says so. `milhouse --report` says how many accepted tasks passed a project check.

If no project check ran, the work waits in `refs/milhouse/<run-id>`. Adding a test command before `--resume` does not count as running it. After inspecting the changes, use `milhouse --merge --run-id <run-id>` to accept them yourself. A manual fast-forward does not rerun checks; if a merge commit is needed, its configured checks still apply when `gates.dod` is on.

---
[← README](../README.md)
