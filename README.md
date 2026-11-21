# Milhouse

Correctness-first orchestrator for [Claude Code](https://claude.com/claude-code) and [Codex](https://github.com/openai/codex). It investigates issues, implements fixes in a worktree and merges them automatically only after review and passing project checks.

## Quick start

Needs [Bun](https://bun.sh) ≥ 1.1, `git`, and the `claude` or the `codex` CLI, logged in. Works on macOS and Linux; Windows is not supported.

```bash
git clone --depth 1 https://github.com/eizorerad/milhouse.git && cd milhouse
bun install && bun link        # puts `milhouse` on your PATH

cd your-project                # a git repo, on the branch you want changed
milhouse "fix authentication bugs"
```

That is all there is to set up. The first run writes `.milhouse/config.ts` with the setup, build, lint and test commands your project defines and goes on with them; the folder is kept out of git, so there is nothing to commit. Work that you have not committed is no obstacle, and neither is switching to another branch while a run is under way: the run works on your last commit in a checkout of its own, leaves your files alone and merges into the branch it started on. Every command ends with the report of its run: the issues, their tasks and commits, the cost.

**Choose a harness:** Set `harness: "codex"` or `harness: "claude"` at the top level of your project's `.milhouse/config.ts`. A new config names Claude Code, or Codex when only that is installed. For one run, use `milhouse --harness codex "your task"`.

## How it works

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

**One commit for the whole run.** Every step works in the run's own worktree, never in your checkout: on the commit your branch was at when the run began, and on top of it the work the run accepted since. So scan, validate and plan judge the same code that exec changes, and you can go on working while a run is under way, on that branch or on another one. At the end `merge` moves the branch the run started on: where it is checked out, forward around your uncommitted edits (only if one of them is to a file that the run changed too does it stop, and say so); where it is not, as a name, without touching a file. What you commit in the meantime meets the run's work in `merge`, in a merge commit that has to pass the checks too.

**exec, per issue:** the agent commits one commit per task (`[<task id>] <title>`) → Milhouse runs the gates → a reviewer agent checks the acceptance criteria against the diff → the issue is accepted. Any failure goes back to the agent as feedback for a repair round (`phases.exec.retries`). An issue that still fails is parked on `mh-failed/<issue-id>`, its worktree is thrown away (a failed attempt may have installed dependencies the next issue would silently build on) and the next issue carries on from a fresh one, so no issue builds on broken work and every issue is tested on top of all the accepted ones. An issue that depends on a failed one waits.

| Gate (`gates.*`) | Blocks |
|---|---|
| `evidence` (validate) | issues whose cited file does not exist, or whose snippet is not found at the cited lines (give or take five; a citation of more than 200 lines, or with line numbers that are not whole numbers, does not count) |
| `placeholder` | new `TODO` / `FIXME` notes (where a comment begins, or `TODO:` where a line begins) and Rust's `todo!()` / `unimplemented!()`. The word alone, in an enum or a string, is not one; whether a `throw new Error("not implemented")` is a stub is for the reviewer to say |
| `diffHygiene` | trailing whitespace and conflict markers in added lines |
| `baseline` | a run whose `commands.build` / `lint` / `test` already fail on the starting commit: it stops before scan spends anything, because it could not tell its own mistakes from what was broken before. If the failure is what the run should fix, start it with `--no-baseline` (or set `gates.baseline: false`). The checks run in the worktree that exec uses next, so what they leave there (ignored by git) stays |
| `dod` | failing `commands.build` / `lint` / `test`; a reviewer that finds unmet acceptance criteria or unnecessary complexity in the change |
| always on | tasks without a commit, uncommitted leftovers, history that drops accepted commits, any commit touching a `neverTouch` path or `.milhouse/` (renames and merges included), checks that move HEAD or rewrite tracked files |

`placeholder` and `diffHygiene` skip binary files and the files that `gates.ignore` names (patterns as in `.gitignore`; by default `*.md`, `*.tsv`, `*.csv`, `*.patch`, `*.diff` and `*.snap`, where trailing spaces or a TODO in the text are not mistakes). A list in the config replaces the default. Conflict markers in the skipped files are not looked for either, and a change of more than 32 MB is refused whatever the list says.

**Keep changes simple.** The planner and executor look for a direct change that fits the existing code. To send work back for complexity, the reviewer must point to the code and explain a simpler alternative that preserves behaviour, safeguards and tests. For example, it can point to an existing parser that the patch duplicates. Line count and style preferences are not grounds for rejection.

**Automatic merge** requires at least one build, lint or test command to have run on the accepted commit, with all checks passing. Setup alone does not count. If your branch advanced, the new merge commit must pass project checks too. A conflict or failing check leaves your branch untouched.

**No checks, no run.** Without a build, lint or test command only an agent reviews the work and nothing merges by itself, so exec refuses to start (also when it resumes a run of 0.5.1); `allowUnchecked: true` in the config, or `--allow-unchecked` for one run, lets it go on. `gates.dod: false` switches the checks and the review off together and is not refused. The first run (or `milhouse init`, which starts nothing) writes the commands your project defines into the config and prints them: `package.json` scripts with the install that matches the lock file (a `lint` script that rewrites files, `--fix`, is no check and is left out), Cargo, Go, Python tests with an environment of the run's own (uv, Poetry or `requirements.txt`), Makefile targets, and the fetching of submodules. They run on every issue: change them in `.milhouse/config.ts` if they are not the right ones. A config without a build, lint or test command is not the last word: at every run Milhouse looks in the project again and uses what it defines by then, and says so. `milhouse --report` says how many accepted tasks passed a project check.

If no project check ran, the work waits in `refs/milhouse/<run-id>`. Adding a test command before `--resume` does not count as running it. After inspecting the changes, use `milhouse --merge --run-id <run-id>` to accept them yourself. A manual fast-forward does not rerun checks; if a merge commit is needed, its configured checks still apply when `gates.dod` is on.

## Safety

- **Claude:** read-only steps and the reviewer get only `Read`, `Grep` and `Glob`. Your MCP servers (mail, payments, …) are never loaded, and the repository's own `.claude/settings.json` (hooks, env, API URL) is ignored; your user-level Claude settings apply.
- **Codex:** read-only steps run in Codex's read-only sandbox (nothing can be written), which is not a tool allowlist and does not cover MCP tools. Your Codex configuration applies as it is, MCP servers and plugins included (see Harnesses).
- **exec runs the agent with permissions bypassed** (`--dangerously-skip-permissions` for Claude, `--dangerously-bypass-approvals-and-sandbox` for Codex): the agent can run any command as you, inside the run's worktree (by default in `~/.cache/milhouse`, or in `$XDG_CACHE_HOME/milhouse` when that is an absolute path: outside your project, so that a command in it cannot find what is installed in your project's own directories. If you set `MILHOUSE_WORK_DIR`, choose a folder outside your project too, and keep it the same for the life of a run). Use Milhouse on repositories you trust, and in a container or VM for anything else. `neverTouch` is checked after every attempt: it detects violations, it cannot prevent them. `.milhouse/config.ts` is code and is executed too.
- Your branch changes only in `merge`, and only with accepted work, by fast-forward: git never replaces a file of yours (untracked or ignored, a `.env` for example) - the merge stops instead and says why. Uncommitted changes and untracked files never stop a run or its merge: the run works on the last commit and says that they are not part of it, and the fast-forward goes around them. Only a file of yours that the merged work would have to replace stops the merge; then commit or stash it and run `milhouse --merge`. The accepted tip lives in `refs/milhouse/<run-id>`, not in a branch, so an agent that runs `git switch` or `git branch -f` cannot move it.
- Your git hooks run for the agents' commits (agents are told to use `--no-verify` if a commit-message rule rejects `[<task id>] <title>`); Milhouse's own commits skip them. `GIT_DIR` and friends inherited from a caller never reach agents or checks, and without a git identity commits use `milhouse <milhouse@localhost>`.
- Claude's cost is its own `total_cost_usd`. Each call is capped at what is left of `budget` (split between parallel agents) and no new work starts once it is spent. `milhouse --resume --budget 100` goes on with a higher one (`--max-tokens` and `--max-minutes` do the same for the other limits). Codex reports tokens, not dollars: they are counted and shown, but `budget` cannot limit them. `maxTokens` does: once a run has used that many (input and output together), no new call starts; a call that is running is not cut short. A Claude call that runs out of time is counted with what it reports for the turns it finished; if it reports nothing, with an estimate of at most $1. `maxMinutes` is a clock for one command, Codex included. It starts when the run begins, once the configuration is read (the check of the starting commit counts): no agent call outlasts it and no new one starts, while a check that has begun runs on to `commandTimeoutMinutes`.
- Ctrl-C, SIGTERM and a closed terminal stop the agents too, and the run is recorded as stopped: `--resume` continues it. A git command of Milhouse's own that is running at that moment is asked to stop, not killed, so it removes its lock: your repository is not left with an `index.lock`. A lock that a killed agent left in the run's worktree is removed when the run goes on. After `kill -9` an agent may keep running: check `ps` before resuming.
- A command that runs out of time is asked to stop (SIGTERM; an agent is interrupted, as by Ctrl-C) and killed three seconds later, with everything it started: a test that started a container or a server has that long to remove it.
- One Milhouse per checkout at a time (`.milhouse/lock`). The lock holds its owner's pid and when that process started, so the lock of a Milhouse that crashed is not taken for a running one when another process gets its pid. A command that never stops printing cannot exhaust memory (only the last 32 MB are kept), and what an agent or a check leaves running in the background is stopped when it finishes (unless it detached itself from the process group).

## Harnesses

Each step inherits the project's `harness` unless it names its own. For example, with `harness: "claude"` and `phases: { verify: { harness: "codex" } }`, Claude does the work and Codex reviews it.

The `--harness` flag overrides even the per-step settings for that run.

| | Claude Code | Codex |
|---|---|---|
| model | a full id pins a version, an alias follows the newest; default `sonnet` | the model of your Codex config, unless you name one |
| read-only steps | `Read`/`Grep`/`Glob` only, no MCP servers, no repository settings | read-only sandbox; your Codex config, MCP servers and plugins apply |
| cost | USD per call, `budget` caps it | tokens only, `maxTokens` limits a run |
| answer format | enforced by `--json-schema` | asked for in the prompt, checked and retried |
| extra flags (`harnessArgs`) | `claude: [...]` | `codex: ["-p", "profile"]`, `["--ignore-user-config"]`, ... |

A step uses the model of its own harness: the global `model` does not apply to a step on the other one. `--harness` drops models that were named for the other harness; `--model` applies to every step on the global harness. `harnessArgs` may add profiles and config overrides, but not the options Milhouse sets itself (output format, sandbox, working directory): those are rejected. A login problem or an unknown model stops the phase at once instead of failing every item three times.

## Configuration

The first run in a project writes `.milhouse/config.ts` with every option and its default; only `commands` holds what it found in your project. `milhouse init` (or `milhouse --init`) writes the same file without starting any agents, and leaves an existing config alone. The options that matter:

```ts
export default {
  harness: "claude",                     // or "codex"; per step: phases.<step>.harness
  model: "",                             // "" = claude: sonnet, codex: your Codex config; per step: phases.<step>.model
  budget: 50,                            // USD per run, 0 = unlimited
  maxTokens: 0,                          // tokens per run for calls that report no dollars (Codex), 0 = unlimited
  maxMinutes: 0,                         // the clock of one command, for every agent: no call outlasts it, no new one starts; 0 = unlimited
  commandTimeoutMinutes: 10,             // the longest one setup, build, lint or test command may run
  commands: { setup: "bun install", build: "", lint: "bunx biome check .", test: "bun test" },
  neverTouch: ["migrations/**", ".env*"],
  rules: ["Use parameterized SQL queries"],
  pipeline: ["scan", "validate", "plan", "consolidate", "exec"], // no "merge": review the work yourself
  failFast: false,                       // true: stop after the first phase with a failed item
};
```

`phases.<step>.timeoutMinutes` sets how long one agent call of a step may take (scan 15, exec 30, verify 10, the rest 5). `neverTouch` and `gates.ignore` patterns are written like `.gitignore` lines, without exceptions (`!` is an error): a name such as `.env*` or `secrets` matches a file or directory at any depth with everything below it (`cache/`: directories only), a pattern with a slash inside or in front (`migrations/**`, `/LICENSE`) starts at the repository root. Unknown keys and wrong types are errors, and so is a pattern that would match no file (spaces around it, `./` in front, nothing but slashes), so a typo cannot silently disable a rule. `commands.setup` runs whenever the worktree is created (also after a failed issue); what it installs must be ignored by git (`node_modules`, `.venv`). The worktree holds the committed files only: submodules and ignored files such as `.env` are not in it, so `setup` has to bring what the checks need. For a project with submodules the first run writes `git submodule update --init --recursive` there; for what git does not track, `$MILHOUSE_PROJECT` is your project's folder while setup runs: `cp "$MILHOUSE_PROJECT/.env" . && npm ci`. The other commands run on every issue and must leave the files alone. Without `merge` the accepted work stays in `refs/milhouse/<run-id>`: inspect it with `git log HEAD..refs/milhouse/<run-id>`, merge it with `milhouse --merge`.

### One agent per step

Every step has its own `harness`, `model`, `rules`, `retries`, `timeoutMinutes` and, for the two steps that run items in parallel, `workers`. A full example for fixing bugs (paste it into `.milhouse/config.ts`, then `milhouse "fix the bugs in src/auth"`):

```ts
// Claude reads the code and does the work; Codex checks the findings (many at once) and reviews the result.
// Models are pinned to a version: an alias such as "opus" follows the newest release, and its price follows it.
export default {
  harness: "claude",                       // the default for every step that does not say otherwise
  budget: 20,                              // USD, for the Claude steps (Codex reports tokens, not dollars)
  harnessArgs: { codex: ["-c", 'model_reasoning_effort="high"'] },
  phases: {
    scan:        { model: "claude-opus-5-5", rules: ["Prefer bugs that lose data or break security over style"] },
    validate:    { harness: "codex", workers: 8 },     // 8 Codex agents in parallel; add model: "<id>" to pin one
    plan:        { model: "claude-sonnet-5-5", workers: 4 },  // 4 Claude agents plan the issues in parallel
    consolidate: { model: "claude-haiku-5-5" },        // one cheap agent merges duplicate tasks
    exec:        { model: "claude-opus-5-5", retries: 3, rules: ["Write the failing test first"] },
    verify:      { harness: "codex", rules: ["Reject a fix that comes without a test"] },
  },
  commands: { setup: "bun install", test: "bun test" },
  neverTouch: [".env*", "migrations/**"],
};
```

`model` is the model of the step's own harness. A full id (`claude-opus-5-5`) pins a version; an alias (`opus`, `sonnet`, `haiku`) follows the newest release, so its price and behaviour change when a new one ships (today they mean `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5`). A step without a model: Claude runs `sonnet` (Milhouse's own choice, not Claude Code's default), Codex runs the model of your Codex config. Every run starts with a line such as `Agents: scan claude/claude-opus-5-5, validate codex/default x8, ...` (`default` = your Codex config), so you see what will run before it costs anything.

`rules` adds instructions to that step's prompt only, after the global `rules`. The prompts themselves are fixed, because the parsers depend on them: the answer format of every step and the commit protocol of exec. `workers` exists only for `validate` and `plan`: scan, consolidate and the reviewer are one agent each, and exec is sequential on purpose (every issue is built and checked on top of the ones accepted before it). For a single run, flags override the file: `milhouse --harness codex --workers 3 "..."`.

## CLI

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

## Upgrading from 0.5.3

- Nothing has to be prepared: the first run writes the config (with the agent that is installed), `.milhouse/` is ignored by git through its own ignore file, and uncommitted changes stop neither a run nor its merge.
- A run no longer needs its branch checked out: it can be resumed and merged from any branch, and from a detached HEAD it does its work and leaves the merge for a branch. The merge moves the branch the run started on.
- A failed agent call waits longer before it is tried again (about 15 seconds, a minute, four) instead of a few seconds.
- A new run removes finished runs older than 30 days and the worktrees of earlier runs.
- Every command ends with the report of its run.
- New: `--budget`, `--max-tokens`, `--max-minutes`, `--no-baseline`; `$MILHOUSE_PROJECT` for `commands.setup`. Old configs load unchanged; one without a build, lint or test command gets what the project defines, at every run.

## Upgrading from 0.5.2

- Every step now works in the run's worktree, on the commit the run began with: scan, validate and plan no longer read your checkout. Uncommitted changes and untracked files are not part of a run; a new run that includes exec refuses to start with them, one that only reads warns.
- `--clean` keeps a run whose accepted work was never merged, and removes the `mh-failed/` branches of the runs it removes. `--clean --all` also takes old stopped and interrupted runs.
- A `neverTouch` or `gates.ignore` pattern that would match no file (`./x`, spaces around it) is an error now: such a pattern protected nothing before.
- The `placeholder` gate no longer stops on `not implemented` or `NotImplementedError`, nor on the word `TODO` outside a note; `*.snap` joined the default `gates.ignore`.
- The evidence gate rejects citations of more than 200 lines.
- Text given to a command that continues a run (`--resume "..."`) and an unknown `--format` are errors; `--run-id <id>` alone resumes that run.
- New: `maxTokens` (a token limit for Codex), `--report --format json`, `--clean --all`. Old configs load unchanged.

## Upgrading from 0.5.1

- exec refuses to start without a build, lint or test command: set one in your `.milhouse/config.ts` (`milhouse init` writes what a project defines, but leaves an existing config alone), or pass `--allow-unchecked`.
- A run whose checks already fail on the starting commit stops before it spends anything. Set `gates.baseline: false` to go on anyway.
- `placeholder` and `diffHygiene` skip binary files and, by default, `*.md`, `*.tsv`, `*.csv`, `*.patch` and `*.diff` (`gates.ignore`).
- `neverTouch` patterns without a slash (`.env*`, `LICENSE`) now match at any depth, as in `.gitignore`; write `/LICENSE` for the root only. A pattern that starts with `!` is an error now (before, it matched in an odd way).
- The worktree moved out of `.milhouse/work` into `~/.cache/milhouse` (`MILHOUSE_WORK_DIR` overrides it); a run that began with 0.5.1 keeps its old one for as long as that folder exists.
- New options: `maxMinutes`, `commandTimeoutMinutes`, `phases.<step>.timeoutMinutes`, `allowUnchecked`, `gates.baseline`, `gates.ignore`. Old configs load unchanged.

## Upgrading from 0.3

Config: `cost.budget` → `budget`, `boundaries.neverTouch` → `neverTouch`, `engine` and the token prices are gone (Claude Code only, real cost), `phases.<x>.workers` exists only for `validate` and `plan`, and `verify` is now the reviewer step inside `exec`, not a phase. exec is sequential on purpose; `--resolve`, `--exec-workers` and `--phase-workers` went with parallel branches.

## Development

```bash
bun install
bun run check        # typecheck + lint + tests
```

The tests drive the whole pipeline against real git repositories with a fake agent that speaks both CLIs (`tests/fixtures/fake-agent.ts`). `MILHOUSE_CLAUDE` and `MILHOUSE_CODEX` point Milhouse at other binaries.

## License

MIT
