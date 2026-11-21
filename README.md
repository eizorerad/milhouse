# Milhouse

[![CI](https://github.com/eizorerad/milhouse/actions/workflows/ci.yml/badge.svg)](https://github.com/eizorerad/milhouse/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/eizorerad/milhouse)](https://github.com/eizorerad/milhouse/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)
![Agents](https://img.shields.io/badge/agents-Claude%20Code%20%7C%20Codex-8A2BE2)

**Say what you want fixed; get reviewed, tested commits on your branch.**

Milhouse drives [Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex) through a fixed pipeline. It finds the issues, checks that they are real, plans small tasks, implements them in a checkout of its own, and merges only what passed your project's build, lint and tests and a review by a second agent.

```
scan → validate → plan → consolidate → exec → merge
```

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/eizorerad/milhouse/main/install.sh | sh
```

Needs `git` and the `claude` or the `codex` CLI, logged in. Works on macOS and Linux, x64 and arm64. The binary goes to `~/.local/bin` (`MILHOUSE_INSTALL_DIR` names another folder), and `milhouse upgrade` updates it later. To run from source with Bun, see [Development](docs/development.md).

## Use

```bash
cd your-project
milhouse "fix authentication bugs"
```

That is the whole setup.

- **Nothing to configure.** The first run finds your project's setup, build, lint and test commands, writes them to `.milhouse/config.ts` (which git does not see) and uses them.
- **Your checkout stays yours.** A run works on your last commit in a worktree of its own. Go on editing or switch branches: what you have not committed is neither read nor touched.
- **Only checked work lands.** Every issue is implemented, run through your commands and reviewed. What passes is fast-forwarded into the branch you started on; a failed attempt is kept on `mh-failed/<issue-id>` and nothing is built on it.
- **You see what happened.** Every command ends with a report: the issues, the verdicts, the tasks, the commits, the cost.

A project without a build, lint or test command gives Milhouse nothing to check the work with, so it stops before changing anything and says so (`--allow-unchecked` goes on; such work waits for your `--merge`).

In `exec` the agent runs with its permissions bypassed, inside the run's worktree: use Milhouse on repositories you trust. [Safety](docs/safety.md) has the details.

## The pipeline

| Phase | What happens |
|---|---|
| scan | A read-only agent lists work items for your scope: bugs, features, refactors. |
| validate | Each item is checked against the code. The snippets it cites must really be there. |
| plan | Each real issue becomes a few small tasks with acceptance criteria. |
| consolidate | Duplicate tasks are merged, and dependencies decide the order. |
| exec | One issue at a time: the agent commits, the gates and your commands run, a reviewer checks the criteria. |
| merge | Accepted work is fast-forwarded into your branch, or merged and checked again if the branch moved. |

More in [How it works](docs/how-it-works.md).

## Commands

```bash
milhouse "fix auth bugs"         # the whole pipeline; the text is the scope
milhouse --scan "fix auth bugs"  # only look; go on with --validate, --plan, --consolidate
milhouse --resume                # continue the latest run after a stop, a failure or a spent limit
milhouse --merge                 # merge accepted work yourself
milhouse --report                # the report again (--format md|json)
milhouse --harness codex "..."   # another agent for this run
milhouse --budget 20 "..."       # spending limit in USD for this command (default: 50 per run)
milhouse upgrade                 # update Milhouse itself
```

All commands and flags: [CLI and run state](docs/cli.md).

## Configuration

`.milhouse/config.ts` is written for you with every option and its default. The ones that matter most:

```ts
export default {
  harness: "claude",                       // or "codex"; any step can use the other one
  budget: 50,                              // USD per run, 0 = unlimited
  commands: { setup: "npm ci", build: "", lint: "npm run lint", test: "npm test" },
  neverTouch: ["migrations/**", ".env*"],  // files no agent may change
  rules: ["Use parameterized SQL queries"],
};
```

Every option, and an example with a different agent and model per step: [Configuration](docs/configuration.md).

## Documentation

| | |
|---|---|
| [How it works](docs/how-it-works.md) | the phases, the gates, when work merges by itself |
| [Configuration](docs/configuration.md) | every option, patterns, one agent per step |
| [CLI and run state](docs/cli.md) | every command, resuming, what a run leaves on disk |
| [Harnesses](docs/harnesses.md) | Claude Code and Codex side by side |
| [Safety](docs/safety.md) | what agents may do, limits, interruption |
| [Upgrading](docs/upgrading.md) | what changes between versions |
| [Development](docs/development.md) | running from source, where things are, releasing |

## License

[MIT](LICENSE)
