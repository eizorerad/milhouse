# Harnesses

Milhouse drives Claude Code and Codex; any step can use either.

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

---
[← README](../README.md)
