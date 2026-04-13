/**
 * Tests for parseResponse of each phase.
 * Ensures AI output → structured data parsing is correct.
 */

import { describe, expect, it } from "bun:test";
import { consolidatePhase } from "../../src/phases/consolidate.ts";
import { execPhase } from "../../src/phases/exec.ts";
import { planPhase } from "../../src/phases/plan.ts";
import { scanPhase } from "../../src/phases/scan.ts";
import { validatePhase } from "../../src/phases/validate.ts";
import { verifyPhase } from "../../src/phases/verify.ts";
import type { Issue, IssueGroup, Task } from "../../src/types.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const mockIssue: Issue = {
	id: "P-test-001",
	type: "bug",
	title: "Test issue",
	rationale: "For testing",
	severity: "HIGH",
	status: "UNVALIDATED",
	evidence: [],
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
};

const mockTask: Task = {
	id: "T-test-001",
	issue_id: "P-test-001",
	title: "Test task",
	description: "A test task",
	files: ["src/foo.ts"],
	depends_on: [],
	checks: ["bun test"],
	acceptance: [{ description: "Test passes" }],
	parallel_group: 0,
	status: "done",
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
};

const mockIssueGroup: IssueGroup = {
	issueId: "P-test-001",
	issue: mockIssue,
	tasks: [mockTask],
};

// ─── Scan ────────────────────────────────────────────────────────────────────

describe("scanPhase.parseResponse", () => {
	it("parses JSON array in code block", () => {
		const response = `Here are the issues:

\`\`\`json
[
  {
    "type": "bug",
    "title": "Missing null check in auth handler",
    "rationale": "Causes crash on invalid token",
    "severity": "HIGH",
    "scope_impact": "auth module",
    "strategy": "Add null check"
  },
  {
    "type": "refactor",
    "title": "Duplicate DB queries",
    "rationale": "Performance issue",
    "severity": "MEDIUM",
    "scope_impact": "database layer",
    "strategy": "Consolidate queries"
  }
]
\`\`\``;

		const result = scanPhase.parseResponse(response, { scope: "all" });
		expect(result.issues).toHaveLength(2);
		expect(result.issues[0].title).toBe("Missing null check in auth handler");
		expect(result.issues[0].type).toBe("bug");
		expect(result.issues[1].severity).toBe("MEDIUM");
	});

	it("parses raw JSON array", () => {
		const response = `[{"type":"bug","title":"Test bug","rationale":"reason","severity":"LOW"}]`;
		const result = scanPhase.parseResponse(response, { scope: "test" });
		expect(result.issues).toHaveLength(1);
		expect(result.issues[0].title).toBe("Test bug");
	});

	it("handles items wrapper object", () => {
		const response = `\`\`\`json
{"items": [{"type":"feature","title":"Add caching","rationale":"Speed up","severity":"MEDIUM"}]}
\`\`\``;
		const result = scanPhase.parseResponse(response, { scope: "" });
		expect(result.issues).toHaveLength(1);
		expect(result.issues[0].title).toBe("Add caching");
	});

	it("filters out invalid items", () => {
		const response = `[{"type":"bug","title":"Valid","rationale":"r","severity":"HIGH"}, {"invalid": true}, null]`;
		const result = scanPhase.parseResponse(response, { scope: "" });
		expect(result.issues).toHaveLength(1);
	});

	it("throws on no JSON", () => {
		expect(() => scanPhase.parseResponse("No issues found.", { scope: "" })).toThrow();
	});

	it("returns empty for empty array", () => {
		const result = scanPhase.parseResponse("```json\n[]\n```", { scope: "" });
		expect(result.issues).toHaveLength(0);
	});
});

// ─── Validate ────────────────────────────────────────────────────────────────

describe("validatePhase.parseResponse", () => {
	it("parses CONFIRMED response", () => {
		const response = `\`\`\`json
{
  "issue_id": "P-test-001",
  "status": "CONFIRMED",
  "confidence": "HIGH",
  "summary": "Bug confirmed in auth.ts:42",
  "corrected_description": null,
  "evidence": [
    {"type": "file", "file": "src/auth.ts", "line_start": 42, "line_end": 45, "output": "missing check"}
  ]
}
\`\`\``;

		const result = validatePhase.parseResponse(response, mockIssue);
		expect(result.status).toBe("CONFIRMED");
		expect(result.confidence).toBe("HIGH");
		expect(result.evidence).toHaveLength(1);
		expect(result.evidence?.[0]?.file).toBe("src/auth.ts");
	});

	it("parses FALSE response", () => {
		const response = `\`\`\`json
{"issue_id": "P-test-001", "status": "FALSE", "confidence": "HIGH", "summary": "Not a real bug"}
\`\`\``;
		const result = validatePhase.parseResponse(response, mockIssue);
		expect(result.status).toBe("FALSE");
	});

	it("parses PARTIAL with corrected_description", () => {
		const response = `\`\`\`json
{
  "issue_id": "P-test-001",
  "status": "PARTIAL",
  "confidence": "MEDIUM",
  "summary": "Issue exists but scope is smaller",
  "corrected_description": "Only affects login endpoint",
  "evidence": []
}
\`\`\``;
		const result = validatePhase.parseResponse(response, mockIssue);
		expect(result.status).toBe("PARTIAL");
		expect(result.corrected_description).toBe("Only affects login endpoint");
	});

	it("defaults to UNVALIDATED for invalid status", () => {
		const response = `\`\`\`json
{"issue_id": "P-test-001", "status": "MAYBE", "confidence": "LOW", "summary": "Unsure"}
\`\`\``;
		const result = validatePhase.parseResponse(response, mockIssue);
		expect(result.status).toBe("UNVALIDATED");
	});

	it("handles missing JSON gracefully", () => {
		const result = validatePhase.parseResponse("I couldn't find anything.", mockIssue);
		expect(result.status).toBe("UNVALIDATED");
		expect(result.issue_id).toBe("P-test-001");
	});
});

// ─── Plan ────────────────────────────────────────────────────────────────────

describe("planPhase.parseResponse", () => {
	it("parses plan with tasks", () => {
		const response = `\`\`\`json
{
  "issue_id": "P-test-001",
  "summary": "Fix auth handler with null check",
  "tasks": [
    {
      "title": "Add null check to token validator",
      "description": "Guard against null token in validateToken()",
      "files": ["src/auth.ts"],
      "depends_on": [],
      "checks": ["bun test"],
      "acceptance": [{"description": "No crash on null token", "check_command": "bun test"}],
      "risk": "Low",
      "rollback": "Revert commit",
      "parallel_group": 0
    },
    {
      "title": "Add test for null token",
      "description": "Cover edge case",
      "files": ["tests/auth.test.ts"],
      "depends_on": [],
      "checks": ["bun test"],
      "acceptance": [{"description": "New test passes"}],
      "risk": "Low",
      "rollback": "Revert commit",
      "parallel_group": 0
    }
  ]
}
\`\`\``;

		const result = planPhase.parseResponse(response, mockIssue);
		expect(result.issue_id).toBe("P-test-001");
		expect(result.summary).toBe("Fix auth handler with null check");
		expect(result.tasks).toHaveLength(2);
		expect(result.tasks[0].title).toBe("Add null check to token validator");
		expect(result.tasks[0].files).toEqual(["src/auth.ts"]);
	});

	it("handles empty tasks array", () => {
		const response = `\`\`\`json
{"issue_id": "P-test-001", "summary": "Nothing to do", "tasks": []}
\`\`\``;
		const result = planPhase.parseResponse(response, mockIssue);
		expect(result.tasks).toHaveLength(0);
	});

	it("throws on missing JSON", () => {
		expect(() => planPhase.parseResponse("No plan possible.", mockIssue)).toThrow();
	});
});

// ─── Consolidate ─────────────────────────────────────────────────────────────

describe("consolidatePhase.parseResponse", () => {
	it("parses consolidation result", () => {
		const response = `\`\`\`json
{
  "duplicates": [
    {"keep": "T-001", "remove": ["T-003"], "reason": "Same file, same change"}
  ],
  "cross_dependencies": [
    {"task_id": "T-002", "depends_on": ["T-001"], "reason": "Shared file"}
  ],
  "parallel_groups": [
    {"group": 0, "task_ids": ["T-001"]},
    {"group": 1, "task_ids": ["T-002"]}
  ],
  "execution_order": ["T-001", "T-002"]
}
\`\`\``;

		const input = { tasks: [mockTask], issues: [mockIssue] };
		const result = consolidatePhase.parseResponse(response, input);
		expect(result.duplicates).toHaveLength(1);
		expect(result.duplicates[0].keep).toBe("T-001");
		expect(result.cross_dependencies).toHaveLength(1);
		expect(result.parallel_groups).toHaveLength(2);
		expect(result.execution_order).toEqual(["T-001", "T-002"]);
	});

	it("handles empty consolidation (no changes needed)", () => {
		const response = `\`\`\`json
{
  "duplicates": [],
  "cross_dependencies": [],
  "parallel_groups": [{"group": 0, "task_ids": ["T-001"]}],
  "execution_order": ["T-001"]
}
\`\`\``;
		const input = { tasks: [mockTask], issues: [mockIssue] };
		const result = consolidatePhase.parseResponse(response, input);
		expect(result.duplicates).toHaveLength(0);
		expect(result.cross_dependencies).toHaveLength(0);
	});

	it("handles missing fields with defaults", () => {
		const response = `\`\`\`json
{}
\`\`\``;
		const input = { tasks: [mockTask], issues: [mockIssue] };
		const result = consolidatePhase.parseResponse(response, input);
		expect(result.duplicates).toEqual([]);
		expect(result.cross_dependencies).toEqual([]);
		expect(result.parallel_groups).toEqual([]);
		expect(result.execution_order).toEqual([]);
	});

	it("throws on no JSON", () => {
		const input = { tasks: [mockTask], issues: [mockIssue] };
		expect(() => consolidatePhase.parseResponse("No consolidation needed.", input)).toThrow();
	});
});

// ─── Exec ────────────────────────────────────────────────────────────────────

describe("execPhase.parseResponse", () => {
	it("returns issue and task IDs (exec doesn't parse AI output)", () => {
		const result = execPhase.parseResponse("Done! All tasks completed.", mockIssueGroup);
		expect(result.issueId).toBe("P-test-001");
		expect(result.taskIds).toEqual(["T-test-001"]);
	});

	it("works with multiple tasks", () => {
		const group: IssueGroup = {
			issueId: "P-multi",
			issue: { ...mockIssue, id: "P-multi" },
			tasks: [
				{ ...mockTask, id: "T-001" },
				{ ...mockTask, id: "T-002" },
				{ ...mockTask, id: "T-003" },
			],
		};
		const result = execPhase.parseResponse("", group);
		expect(result.taskIds).toEqual(["T-001", "T-002", "T-003"]);
	});

	it("works with empty response", () => {
		const result = execPhase.parseResponse("", mockIssueGroup);
		expect(result.issueId).toBe("P-test-001");
	});
});

// ─── Verify ──────────────────────────────────────────────────────────────────

describe("verifyPhase.parseResponse", () => {
	it("parses passing verification", () => {
		const response = `\`\`\`json
{
  "overall_pass": true,
  "gates": [
    {"gate": "evidence", "passed": true, "message": "Commit found"},
    {"gate": "diffHygiene", "passed": true, "message": "Clean diff"},
    {"gate": "placeholder", "passed": true, "message": "No TODOs"},
    {"gate": "dod", "passed": true, "message": "All criteria met"}
  ],
  "recommendations": [],
  "regressions_found": false,
  "summary": "All checks passed"
}
\`\`\``;

		const result = verifyPhase.parseResponse(response, mockTask);
		expect(result.overall_pass).toBe(true);
		expect(result.gates).toHaveLength(4);
		expect(result.gates.every((g) => g.passed)).toBe(true);
		expect(result.regressions_found).toBe(false);
		expect(result.recommendations).toHaveLength(0);
	});

	it("parses failing verification", () => {
		const response = `\`\`\`json
{
  "overall_pass": false,
  "gates": [
    {"gate": "evidence", "passed": true, "message": "Commit found"},
    {"gate": "placeholder", "passed": false, "message": "Found TODO in line 55"}
  ],
  "recommendations": ["Remove TODO comment", "Add proper implementation"],
  "regressions_found": true,
  "summary": "Placeholder code detected"
}
\`\`\``;

		const result = verifyPhase.parseResponse(response, mockTask);
		expect(result.overall_pass).toBe(false);
		expect(result.regressions_found).toBe(true);
		expect(result.recommendations).toHaveLength(2);
		expect(result.gates[1].passed).toBe(false);
	});

	it("handles missing JSON gracefully", () => {
		const result = verifyPhase.parseResponse("Could not verify.", mockTask);
		expect(result.overall_pass).toBe(false);
		expect(result.task_id).toBe("T-test-001");
		expect(result.summary).toBe("Failed to parse verification response");
	});

	it("defaults boolean fields properly", () => {
		const response = `\`\`\`json
{"gates": [], "summary": "Partial check"}
\`\`\``;
		const result = verifyPhase.parseResponse(response, mockTask);
		expect(result.overall_pass).toBe(false);
		expect(result.regressions_found).toBe(false);
		expect(result.recommendations).toEqual([]);
	});
});
