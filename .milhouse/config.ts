// Milhouse working on itself.
export default {
  harness: "codex",
  project: { name: "milhouse", language: "TypeScript", framework: "Bun", description: "CLI that orchestrates Claude Code and Codex" },
  commands: {
    setup: "bun install --frozen-lockfile",
    build: "bunx tsc --noEmit",
    lint: "bunx biome check .",
    test: "bun test",
  },
  neverTouch: [".milhouse/**", "LICENSE"],
};
