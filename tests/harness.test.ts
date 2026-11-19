/** What each harness sends to its CLI and how it reads the answer. */

import { describe, expect, it } from "bun:test";
import { HARNESSES } from "../src/engine.ts";
import { claude } from "../src/harness/claude.ts";
import { codex } from "../src/harness/codex.ts";
import { type AgentOptions, EngineError } from "../src/harness/types.ts";
import type { RunResult } from "../src/proc.ts";

const opts = (over: Partial<AgentOptions> = {}): AgentOptions => ({
	harness: "claude",
	cwd: "/work",
	timeoutMs: 1000,
	tools: "read",
	...over,
});

const out = (stdout: string, code: number | null = 0, stderr = ""): RunResult => ({
	code,
	stdout,
	stderr,
	timedOut: false,
	truncated: false,
});

const lines = (...events: object[]): string => events.map((e) => JSON.stringify(e)).join("\n");

describe("the harness registry", () => {
	it("knows both agents and which one reports dollars", () => {
		expect(Object.keys(HARNESSES)).toEqual(["claude", "codex"]);
		expect(HARNESSES.claude.reportsCost).toBe(true);
		expect(HARNESSES.codex.reportsCost).toBe(false);
	});

	it("looks for the binary by its name unless an environment variable says otherwise", () => {
		const saved = { claude: process.env.MILHOUSE_CLAUDE, codex: process.env.MILHOUSE_CODEX };
		process.env.MILHOUSE_CLAUDE = "";
		process.env.MILHOUSE_CODEX = "";
		expect([claude.binary(), codex.binary()]).toEqual(["claude", "codex"]);
		process.env.MILHOUSE_CODEX = "/opt/codex";
		expect(codex.binary()).toBe("/opt/codex");
		process.env.MILHOUSE_CLAUDE = saved.claude;
		process.env.MILHOUSE_CODEX = saved.codex;
	});
});

describe("claude arguments", () => {
	it("always isolates the agent from the user's MCP servers and from session files", () => {
		const args = claude.args(opts());
		expect(args).toContain("--strict-mcp-config");
		expect(args).toContain("--no-session-persistence");
		expect(args.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
	});

	it("never loads the repository's own Claude settings", () => {
		for (const tools of ["read", "all"] as const) {
			expect(claude.args(opts({ tools })).join(" ")).toContain("--setting-sources user");
		}
	});

	it("gives read-only steps read-only tools and no permission bypass", () => {
		const args = claude.args(opts());
		expect(args.join(" ")).toContain("--tools Read,Grep,Glob");
		expect(args).not.toContain("--dangerously-skip-permissions");
	});

	it("bypasses permissions only when the agent must edit and run things", () => {
		const args = claude.args(opts({ tools: "all" }));
		expect(args).toContain("--dangerously-skip-permissions");
		expect(args).not.toContain("--tools");
	});

	it("passes model, schema, turn limit and the per-call budget, and omits them otherwise", () => {
		const args = claude.args(
			opts({ model: "opus", schema: { type: "object" }, maxTurns: 7, maxBudgetUsd: 1.23456 }),
		);
		expect(args.join(" ")).toContain("--model opus");
		expect(args).toContain('{"type":"object"}');
		expect(args.join(" ")).toContain("--max-turns 7");
		expect(args.join(" ")).toContain("--max-budget-usd 1.2346");
		const bare = claude.args(opts()).join(" ");
		for (const flag of ["--model", "--json-schema", "--max-turns", "--max-budget-usd"]) {
			expect(bare).not.toContain(flag);
		}
	});

	it("puts the configured extra arguments before its own, so its own win", () => {
		const args = claude.args(opts({ model: "opus", extraArgs: ["--model", "haiku", "--verbose"] }));
		expect(args.indexOf("--verbose")).toBeLessThan(args.lastIndexOf("--model"));
		expect(args[args.lastIndexOf("--model") + 1]).toBe("opus");
	});
});

describe("codex arguments", () => {
	it("runs `codex exec` with an event stream, no session files and the prompt on stdin", () => {
		const args = codex.args(opts({ harness: "codex" }));
		expect(args[0]).toBe("exec");
		expect(args).toContain("--json");
		expect(args).toContain("--ephemeral");
		expect(args.slice(args.indexOf("-C"), args.indexOf("-C") + 2)).toEqual(["-C", "/work"]);
		expect(args.at(-1)).toBe("-");
	});

	it("keeps read-only steps in Codex's read-only sandbox, with no way out of it", () => {
		const args = codex.args(opts({ harness: "codex" }));
		expect(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2)).toEqual(["-s", "read-only"]);
		expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
	});

	it("lets exec edit and commit, as it must inside a linked worktree", () => {
		const args = codex.args(opts({ harness: "codex", tools: "all" }));
		expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
		expect(args).not.toContain("-s");
	});

	it("names a model only when the config does, so Codex's own default applies otherwise", () => {
		expect(codex.args(opts({ harness: "codex" }))).not.toContain("-m");
		const args = codex.args(opts({ harness: "codex", model: "gpt-x" }));
		expect(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2)).toEqual(["-m", "gpt-x"]);
	});

	it("puts the configured extra arguments right after `exec`, before its own", () => {
		const args = codex.args(opts({ harness: "codex", extraArgs: ["-p", "milhouse"] }));
		expect(args.slice(0, 3)).toEqual(["exec", "-p", "milhouse"]);
		expect(args.indexOf("--json")).toBeGreaterThan(2);
	});

	it("asks for the answer's shape in the prompt, since a schema cannot be enforced for every provider", () => {
		const schema = { type: "object", properties: { items: { type: "array" } } };
		const text = codex.input("do it", opts({ harness: "codex", schema }));
		expect(text.startsWith("do it")).toBe(true);
		expect(text).toContain("one JSON object that matches this JSON Schema");
		expect(text).toContain(JSON.stringify(schema));
		expect(codex.input("do it", opts({ harness: "codex" }))).toBe("do it");
		expect(claude.input("do it", opts({ schema }))).toBe("do it"); // Claude enforces it itself
	});
});

describe("reading Codex's event stream", () => {
	const started = [{ type: "thread.started", thread_id: "t" }, { type: "turn.started" }];
	const message = (text: string) => ({
		type: "item.completed",
		item: { type: "agent_message", text },
	});
	const finished = (input = 100, output = 10) => ({
		type: "turn.completed",
		usage: { input_tokens: input, cached_input_tokens: 5, output_tokens: output },
	});

	it("takes the last message as the answer and the usage of the turn as the tokens", () => {
		const result = codex.parse(
			out(lines(...started, message("working on it"), message('{"ok":true}'), finished(500, 20))),
			opts(),
		);
		expect(result).toEqual({ text: '{"ok":true}', costUsd: 0, tokens: { input: 500, output: 20 } });
	});

	it("ignores tool output and reconnect notices; a turn with tools only has an empty answer", () => {
		const result = codex.parse(
			out(
				lines(
					...started,
					{ type: "error", message: "Reconnecting... 1/5 (stream closed)" },
					{ type: "item.completed", item: { type: "command_execution", aggregated_output: "{}" } },
					{ type: "item.completed", item: { type: "reasoning", text: "thinking" } },
					finished(),
				),
			),
			opts(),
		);
		expect(result.text).toBe("");
	});

	it("skips lines that are not events, such as a cut-off first line", () => {
		const stream = `{"type":"item.comp\n${lines(...started, message("answer"), finished())}\nnot json`;
		expect(codex.parse(out(stream), opts()).text).toBe("answer");
	});

	it("fails with the reason when the turn failed, whatever the stream said before", () => {
		const failure = () =>
			codex.parse(
				out(
					lines(...started, message("half an answer"), {
						type: "turn.failed",
						error: { message: "stream disconnected before completion" },
					}),
					1,
				),
				opts(),
			);
		expect(failure).toThrow(EngineError);
		expect(failure).toThrow(/stream disconnected/);
		try {
			failure();
		} catch (err) {
			expect((err as EngineError).systemic).toBe(false); // a retry may well work
		}
	});

	it("fails when the stream has no ending or the process failed, even after a message", () => {
		expect(() => codex.parse(out(lines(...started, message("x"))), opts())).toThrow(/no result/);
		expect(() => codex.parse(out(lines(...started, message("x"), finished()), 1), opts())).toThrow(
			EngineError,
		);
		expect(() => codex.parse(out("", null, "spawn ENOENT"), opts())).toThrow(/ENOENT/);
	});

	it("knows a failure that every other call would share: login, unknown model, quota", () => {
		const reasons: Array<[string, boolean]> = [
			["unexpected status 401 Unauthorized: Missing bearer or basic authentication", true],
			["unexpected status 403 Forbidden", true],
			[
				"unexpected status 404 Not Found: The API deployment for this resource does not exist.",
				true,
			],
			["You've hit your usage limit. Try again later.", true],
			["unexpected status 429 Too Many Requests", false],
			["unexpected status 500 Internal Server Error", false],
			["stream disconnected before completion", false],
		];
		for (const [reason, systemic] of reasons) {
			let error: EngineError | undefined;
			try {
				codex.parse(
					out(lines(...started, { type: "turn.failed", error: { message: reason } }), 1),
					opts(),
				);
			} catch (err) {
				error = err as EngineError;
			}
			expect([reason, error?.systemic]).toEqual([reason, systemic]);
			expect([reason, error?.fatal]).toEqual([reason, systemic]);
		}
	});
});

describe("reading Claude's result", () => {
	const result = (over: object) =>
		JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "ok",
			total_cost_usd: 0.5,
			...over,
		});

	it("returns the text and the cost, preferring structured output", () => {
		expect(claude.parse(out(result({})), opts())).toEqual({ text: "ok", costUsd: 0.5 });
		const structured = claude.parse(out(result({ structured_output: { a: 1 } })), opts());
		expect(structured.text).toBe('{"a":1}');
	});

	it("knows a failure that every other call would share: logged out, no credit, over the limit", () => {
		const shapes: Array<[object, boolean]> = [
			[{ is_error: true, result: "Not logged in · Please run /login", total_cost_usd: 0 }, true],
			[{ is_error: true, result: "Invalid API key", api_error_status: 401 }, true],
			[{ is_error: true, result: "Credit balance is too low" }, true],
			[{ is_error: true, result: "You've hit your limit · resets 5pm" }, true],
			[{ is_error: true, subtype: "error_during_execution", errors: ["tool crashed"] }, false],
			[
				{ is_error: true, subtype: "error_max_turns", errors: ["Reached maximum number of turns"] },
				false,
			],
		];
		for (const [shape, systemic] of shapes) {
			let error: EngineError | undefined;
			try {
				claude.parse(out(result(shape), 1), opts());
			} catch (err) {
				error = err as EngineError;
			}
			expect([JSON.stringify(shape), error?.systemic]).toEqual([JSON.stringify(shape), systemic]);
		}
	});

	it("keeps the cost of a failed call and calls a used-up call budget fatal", () => {
		try {
			claude.parse(
				out(
					result({
						is_error: true,
						subtype: "error_max_budget_usd",
						errors: ["over"],
						total_cost_usd: 0.7,
					}),
					1,
				),
				opts(),
			);
			throw new Error("should have failed");
		} catch (err) {
			expect(err).toBeInstanceOf(EngineError);
			expect((err as EngineError).costUsd).toBe(0.7);
			expect((err as EngineError).fatal).toBe(true);
			expect((err as EngineError).systemic).toBe(false);
		}
	});
});
