# Development

```bash
git clone https://github.com/eizorerad/milhouse.git && cd milhouse
bun install                  # Bun >= 1.1
bun run check                # typecheck + lint + tests
bun link                     # optional: puts this checkout on your PATH as `milhouse`
```

The tests drive the whole pipeline against real git repositories with a fake agent that speaks both CLIs (`tests/fixtures/fake-agent.ts`), so they need no login and cost nothing. `MILHOUSE_CLAUDE` and `MILHOUSE_CODEX` point Milhouse at other binaries. `bun run build` makes the binary for this machine.

## Where things are

| Path | What is there |
|---|---|
| `src/index.ts` | the CLI: arguments, `init`, `upgrade`, `--report`, `--clean`, and the start of a run |
| `src/pipeline.ts` | preflight, opening or resuming a run, the phases in order, the final status and report |
| `src/runner.ts` | one phase: its items, parallel workers, retries with pauses, the share of the budget |
| `src/phases/` | `scan`, `validate`, `plan`, `consolidate`, `exec` (with `exec-order`, `exec-prompts`) and `merge` |
| `src/harness/` | how Claude Code and Codex are called and how their answers are read |
| `src/engine.ts` | one agent call: the process, its timeout, what it cost |
| `src/gates.ts` | the deterministic checks: evidence, placeholders, whitespace, the project's commands |
| `src/git.ts` | every git command Milhouse runs |
| `src/worktree.ts` | the run's worktree: creating it, `commands.setup`, housekeeping |
| `src/state.ts` | run state on disk (`.milhouse/runs/<run-id>/`) |
| `src/config.ts`, `src/detect.ts` | loading and validating the config, its template; the commands found in a project |
| `src/cost.ts`, `src/lock.ts`, `src/proc.ts`, `src/report.ts`, `src/baseline.ts`, `src/upgrade.ts` | limits, the one-run-per-checkout lock, child processes, the report, the check of the starting commit, self-update |
| `tests/` | one file per module, plus `e2e`, `scenarios`, `recovery` and `cli`, which run whole pipelines |

## Conventions

- A change comes with a test that fails without it.
- Simple, readable code over clever code; comments say why, not what.
- The documentation's config example is tested (`tests/readme.test.ts`): if you change it, the test has to agree.

## Releasing

A pull request titled `Release X.Y.Z` bumps `package.json` and adds a section to [Upgrading](upgrading.md); after the merge, an annotated tag `vX.Y.Z` and a published GitHub release. Publishing makes `.github/workflows/release.yml` build the binaries for Linux and macOS, x64 and arm64, and attach each of them gzipped and plain: `install.sh` and `milhouse upgrade` fetch the gzipped file (about half the size) and fall back to the plain one, which is all that releases up to 0.5.4 fetch.

---
[← README](../README.md)
