# Milhouse

Correctness-first orchestrator for [Claude Code](https://claude.com/claude-code) and [Codex](https://github.com/openai/codex). It investigates before it acts and verifies before it merges: nothing reaches your branch until it is committed, passes your build/lint/test commands and is approved by a reviewer agent.

## Quick start

Needs [Bun](https://bun.sh) ≥ 1.1, `git`, and the `claude` or the `codex` CLI, logged in.

```bash
git clone https://github.com/eizorerad/milhouse.git && cd milhouse
bun install && bun link        # puts `milhouse` on your PATH

cd your-project                # a git repo, clean working tree, on the branch you want changed
milhouse --init                # writes .milhouse/config.ts: set commands.test / lint / build
milhouse "fix authentication bugs"
```

## How it works

```
scan → validate → plan → consolidate → exec → merge
```

| Phase | What happens |
|---|---|
| scan | A read-only agent lists work items (bugs, features, refactors) for your scope. |
| validate | Each item is checked against the code. Milhouse opens every cited file and checks the lines and the snippet itself, so invented evidence is rejected. |
| plan | Each real issue becomes a few small tasks with acceptance criteria. |
| consolidate | Duplicate tasks are merged. Dependencies between issues decide the order. |
| exec | Issues run **one at a time** in a git worktree, each on top of the ones accepted before it (see below). |
| merge | Accepted work is fast-forwarded into the branch the run started on. |

**exec, per issue:** the agent commits one commit per task (`[<task id>] <title>`) → Milhouse runs the gates → a reviewer agent checks the acceptance criteria against the diff → the issue is accepted. Any failure goes back to the agent as feedback for a repair round (`phases.exec.retries`). An issue that still fails is parked on `mh-failed/<issue-id>`, its worktree is thrown away (a failed attempt may have installed dependencies the next issue would silently build on) and the next issue carries on from a fresh one, so no issue builds on broken work and every issue is tested on top of all the accepted ones. An issue that depends on a failed one waits.

| Gate (`gates.*`) | Blocks |
|---|---|
| `evidence` (validate) | issues whose cited file, lines or snippet do not exist |
| `placeholder` | new `TODO` / `FIXME` / "not implemented" stubs |
| `diffHygiene` | trailing whitespace and conflict markers in added lines |
| `dod` | failing `commands.build` / `lint` / `test`; a reviewer that rejects the acceptance criteria |
| always on | tasks without a commit, uncommitted leftovers, history that drops accepted commits, any commit touching a `neverTouch` path or `.milhouse/` (renames and merges included), checks that move HEAD or rewrite tracked files |

**merge** tests before it publishes: if your branch moved during the run, the merge commit is built and checked in the run's worktree, and only that tested commit is fast-forwarded into your branch. If the merge conflicts or the checks fail, your branch has not been touched and the work stays accepted, waiting. The run then continues from the merged state, so a later `--resume` builds on it.

## Safety

- **Claude:** read-only steps and the reviewer get only `Read`, `Grep` and `Glob`. Your MCP servers (mail, payments, …) are never loaded, and the repository's own `.claude/settings.json` (hooks, env, API URL) is ignored; your user-level Claude settings apply.
- **Codex:** read-only steps run in Codex's read-only sandbox (nothing can be written), which is not a tool allowlist and does not cover MCP tools. Your Codex configuration applies as it is, MCP servers and plugins included (see Harnesses).
- **exec runs the agent with permissions bypassed** (`--dangerously-skip-permissions` for Claude, `--dangerously-bypass-approvals-and-sandbox` for Codex): the agent can run any command as you, inside the run's worktree. Use Milhouse on repositories you trust, and in a container or VM for anything else. `neverTouch` is checked after every attempt: it detects violations, it cannot prevent them. `.milhouse/config.ts` is code and is executed too.
- Your branch changes only in `merge`, and only with accepted work, by fast-forward: git never replaces a file of yours (untracked or ignored, a `.env` for example) - the merge stops instead and says why. Untracked files in your checkout never block a run. The accepted tip lives in `refs/milhouse/<run-id>`, not in a branch, so an agent that runs `git switch` or `git branch -f` cannot move it.
- Your git hooks run for the agents' commits (agents are told to use `--no-verify` if a commit-message rule rejects `[<task id>] <title>`); Milhouse's own commits skip them. `GIT_DIR` and friends inherited from a caller never reach agents or checks, and without a git identity commits use `milhouse <milhouse@localhost>`.
- Claude's cost is its own `total_cost_usd`. Each call is capped at what is left of `budget` (split between parallel agents) and no new work starts once it is spent. Raise the budget and `--resume`. Codex reports tokens, not dollars: they are counted and shown, but `budget` cannot limit them.
- Ctrl-C, SIGTERM and a closed terminal stop the agents too. After `kill -9` an agent may keep running: check `ps` before resuming.
- One Milhouse per checkout at a time (`.milhouse/lock`). A command that never stops printing cannot exhaust memory (only the last 32 MB are kept), and what an agent or a check leaves running in the background is stopped when it finishes.

## Harnesses

Milhouse drives Claude Code (`claude`) or Codex (`codex`). `harness` picks the agent for every step, and any step can name its own: `phases.verify.harness: "codex"` lets Codex review what Claude wrote. `--harness codex` switches a whole run.

| | Claude Code | Codex |
|---|---|---|
| model | alias or id, default `sonnet` | what your Codex config says, unless you name one |
| read-only steps | `Read`/`Grep`/`Glob` only, no MCP servers, no repository settings | read-only sandbox; your Codex config, MCP servers and plugins apply |
| cost | USD per call, `budget` caps it | tokens only |
| answer format | enforced by `--json-schema` | asked for in the prompt, checked and retried |
| extra flags (`harnessArgs`) | `claude: [...]` | `codex: ["-p", "profile"]`, `["--ignore-user-config"]`, ... |

A step uses the model of its own harness: the global `model` does not apply to a step on the other one. `--model` applies to every step on the global harness. A login problem or an unknown model stops the phase at once instead of failing every item three times.

## Configuration

`milhouse --init` writes `.milhouse/config.ts` with every option and its default. The ones that matter:

```ts
export default {
  harness: "claude",                     // or "codex"; per step: phases.<step>.harness
  model: "",                             // "" = the harness default; per step: phases.<step>.model
  budget: 50,                            // USD per run, 0 = unlimited
  commands: { setup: "bun install", build: "", lint: "bunx biome check .", test: "bun test" },
  neverTouch: ["migrations/**", ".env*"],
  rules: ["Use parameterized SQL queries"],
  pipeline: ["scan", "validate", "plan", "consolidate", "exec"], // no "merge": review the work yourself
  failFast: false,                       // true: stop after the first phase with a failed item
};
```

Unknown keys and wrong types are errors, so a typo cannot silently disable a rule. `commands.setup` runs whenever the worktree is created (also after a failed issue); what it installs must be ignored by git (`node_modules`, `.venv`). The other commands run on every issue and must leave the files alone. Without `merge` the accepted work stays in `refs/milhouse/<run-id>`: inspect it with `git log HEAD..refs/milhouse/<run-id>`, merge it with `milhouse --merge`.

## CLI

```
milhouse "fix auth bugs"        run the whole pipeline; the text is the scope
milhouse --run                  same, without a scope
milhouse --resume               continue the latest run (--run-id <id> for another)
milhouse --scan | --validate | --plan | --consolidate | --exec | --merge
                                run one phase (all but --scan continue the latest run)
milhouse --report [--format md] run summary: issues, tasks, failures, cost
milhouse --list-runs            list runs
milhouse --clean [--days 30]    delete finished runs
milhouse --init                 create .milhouse/config.ts
  --scope <text>  --workers <n>  --harness <claude|codex>  --model <name>  --run-id <id>  -v  -V  -h
```

Unknown flags are an error; with no arguments you get the help. It works from any subdirectory. The exit code is 0 only if everything that was asked for succeeded.

`--resume` skips finished phases and retries failed items, feeding the old failure back to the agent. A phase counts as finished only when everything before it did. A run continues only on the branch it started on. An issue that was interrupted mid-way starts again from the accepted state. If only the review failed (an outage, the budget), the finished work is kept on its parked branch and only the review is repeated, as long as no other issue was accepted in between.

## Run state

```
.milhouse/config.ts          your config (commit it)
.milhouse/runs/<run-id>/     meta.json  issues.json  tasks.json  cost.json
.milhouse/work/<run-id>/     the exec worktree
refs/milhouse/<run-id>       accepted work; mh-failed/<issue-id> holds failed attempts
```

Everything under `.milhouse/` except `config.ts` is ignored by git (`.milhouse/.gitignore`). `--clean` keeps accepted work that was never merged.

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
