# Configuration

The first run in a project writes `.milhouse/config.ts` with every option and its default; only `commands` and `harness` hold what it found on your machine. `milhouse init` (or `milhouse --init`) writes the same file without starting any agents, and leaves an existing config alone. The options that matter:

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

## Timeouts, patterns and setup

`phases.<step>.timeoutMinutes` sets how long one agent call of a step may take (scan 15, exec 30, verify 10, the rest 5). `neverTouch` and `gates.ignore` patterns are written like `.gitignore` lines, without exceptions (`!` is an error): a name such as `.env*` or `secrets` matches a file or directory at any depth with everything below it (`cache/`: directories only), a pattern with a slash inside or in front (`migrations/**`, `/LICENSE`) starts at the repository root. Unknown keys and wrong types are errors, and so is a pattern that would match no file (spaces around it, `./` in front, nothing but slashes), so a typo cannot silently disable a rule. `commands.setup` runs whenever the worktree is created (also after a failed issue); what it installs must be ignored by git (`node_modules`, `.venv`). The worktree holds the committed files only: submodules and ignored files such as `.env` are not in it, so `setup` has to bring what the checks need. For a project with submodules the first run writes `git submodule update --init --recursive` there; for what git does not track, `$MILHOUSE_PROJECT` is your project's folder while setup runs: `cp "$MILHOUSE_PROJECT/.env" . && npm ci`. The other commands run on every issue and must leave the files alone. Without `merge` the accepted work stays in `refs/milhouse/<run-id>`: inspect it with `git log HEAD..refs/milhouse/<run-id>`, merge it with `milhouse --merge`.

## One agent per step

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

---
[← README](../README.md)
