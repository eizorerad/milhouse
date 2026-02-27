/**
 * @fileoverview Validation Prompt Builder Module
 *
 * Functions for building AI prompts for issue validation:
 * - buildDeepIssueValidatorPrompt: Comprehensive validation prompt
 * - buildIssueValidatorPrompt: Legacy wrapper for backwards compatibility
 *
 * @module cli/commands/utils/validation-prompt
 */

import { getConfigService } from "../../../services/config/ConfigService.ts";
import {
	AGENT_ROLES,
	type Issue,
	getWorkItemRationale,
	getWorkItemTitle,
} from "../../../state/types.ts";

/**
 * Build the Deep Issue Validator prompt for thorough investigation
 */
export function buildDeepIssueValidatorPrompt(
	issue: Issue,
	workDir: string,
	agentNum: number,
	probeEvidence?: string,
): string {
	const parts: string[] = [];

	// Role definition with agent identity
	const itemType = issue.type ?? "bug";
	const itemTitle = getWorkItemTitle(issue);

	parts.push(`## Role: Work Item Validator Agent #${agentNum} (IV-${agentNum})
${AGENT_ROLES.IV}

You are **dedicated validator agent #${agentNum}** investigating a SINGLE work item (type: ${itemType}).
Your task is to perform a DEEP, THOROUGH investigation and produce a comprehensive validation report.

⚠️ **IMPORTANT**: This is a deep investigation, not a quick check. Take your time to:
- Read ALL related files completely
- Trace the code flow from start to end
- Run actual tests and commands
- Consider edge cases and alternative explanations
- Validate the work item with concrete evidence

⚠️ **AUTONOMOUS MODE**: You are running in a fully automated pipeline. Do NOT ask questions or request clarification. Make the best decision for this specific project based on the codebase context. If uncertain, choose the most conservative/safe option and proceed.`);

	// Add project context if available
	const configService = getConfigService(workDir);
	const config = configService.getConfig();

	if (config) {
		const contextParts: string[] = [];
		if (config.project.name) contextParts.push(`Project: ${config.project.name}`);
		if (config.project.language) contextParts.push(`Language: ${config.project.language}`);
		if (config.project.framework) contextParts.push(`Framework: ${config.project.framework}`);
		if (config.project.description) contextParts.push(`Description: ${config.project.description}`);

		if (contextParts.length > 0) {
			parts.push(`## Project Context
${contextParts.join("\n")}`);
		}
	}

	// Add config info if available
	if (config) {
		const configParts: string[] = [];
		if (config.commands.test) configParts.push(`Test command: ${config.commands.test}`);
		if (config.commands.lint) configParts.push(`Lint command: ${config.commands.lint}`);
		if (config.commands.build) configParts.push(`Build command: ${config.commands.build}`);
		if (configParts.length > 0) {
			parts.push(`## Available Commands\n${configParts.join("\n")}`);
		}
	}

	// Work item to validate with full context
	const rationale = getWorkItemRationale(issue);
	parts.push(`## Work Item Under Investigation

| Field | Value |
|-------|-------|
| **ID** | ${issue.id} |
| **Type** | ${itemType} |
| **Title** | ${itemTitle} |
| **Rationale** | ${rationale} |
| **Claimed Severity** | ${issue.severity} |
${issue.scope_impact ? `| **Scope Impact** | ${issue.scope_impact} |` : ""}
${issue.frequency ? `| **Claimed Frequency** | ${issue.frequency} |` : ""}
${issue.blast_radius ? `| **Blast Radius** | ${issue.blast_radius} |` : ""}
${issue.strategy ? `| **Suggested Strategy** | ${issue.strategy} |` : ""}

### Previous Evidence (from scan)
${issue.evidence.length > 0 ? issue.evidence.map((e) => `- ${e.type}: ${e.file || e.command || "N/A"}`).join("\n") : "No previous evidence collected"}`);

	// Deep investigation instructions - type-aware
	const investigationInstructions =
		itemType === "bug"
			? `## Deep Investigation Protocol

### Phase 1: Code Exploration
1. Read the files mentioned in the title/rationale completely
2. Search for related patterns using grep/ripgrep
3. Trace the code flow to understand the full context
4. Identify all affected code paths

### Phase 2: Hypothesis Testing
1. Create specific tests or checks to validate/invalidate the hypothesis
2. Run existing tests to see if they cover this scenario
3. Check for similar patterns elsewhere in the codebase
4. Consider if this is a common false positive pattern

### Phase 3: Impact Analysis
1. Determine the actual severity based on evidence
2. List all components that would be affected
3. Assess user-facing impact
4. Check for security implications

### Phase 4: Reproduction
1. Try to reproduce the issue or demonstrate it exists
2. Document exact steps/conditions needed
3. Note if it's environment-specific

### Phase 5: Recommendations
1. Propose a fix approach if confirmed
2. Estimate complexity of the fix
3. Suggest test strategy to prevent regression`
			: `## Deep Investigation Protocol

### Phase 1: Code Exploration
1. Read the files and modules relevant to this ${itemType}
2. Search for related patterns, existing implementations, and integration points
3. Trace the code flow to understand the full context
4. Identify all areas that would need to change

### Phase 2: Feasibility Assessment
1. Verify the work item is feasible with the current architecture
2. Identify prerequisites and dependencies
3. Check for existing implementations that could be reused
4. Assess compatibility with the current codebase

### Phase 3: Impact Analysis
1. Determine the scope and complexity of changes
2. List all components that would be affected
3. Assess risks and potential side effects
4. Check for potential conflicts with existing functionality

### Phase 4: Evidence Gathering
1. Document specific code locations relevant to the work
2. Identify existing tests and patterns to follow
3. Note technical constraints or limitations

### Phase 5: Recommendations
1. Propose an implementation approach
2. Estimate complexity
3. Suggest test strategy for verification`;

	parts.push(investigationInstructions);

	// Output format
	parts.push(`## Output Format

You MUST respond with a JSON object in this EXACT format:

\`\`\`json
{
  "issue_id": "${issue.id}",
  "status": "CONFIRMED|FALSE|PARTIAL|MISDIAGNOSED",
  "confidence": "HIGH|MEDIUM|LOW",
  "summary": "2-3 sentence summary of your findings",
  "investigation": {
    "files_examined": ["file1.ts", "file2.ts"],
    "commands_run": ["grep -r 'pattern' src/", "npm test -- --grep 'test name'"],
    "patterns_found": ["Pattern A found in X files", "No instances of Y"],
    "related_code": [
      {
        "file": "path/to/file.ts",
        "line_start": 42,
        "line_end": 60,
        "relevance": "Related code location",
        "code_snippet": "optional relevant code"
      }
    ]
  },
  "analysis": {
    "confirmed_finding": "The validated finding or root cause",
    "alternative_considerations": ["Other possible approaches or explanations considered"],
    "validity_assessment": "Evidence supporting the validity of this work item"
  },
  "impact_assessment": {
    "severity_confirmed": true,
    "actual_severity": "CRITICAL|HIGH|MEDIUM|LOW",
    "affected_components": ["ComponentA", "StoreB"],
    "user_impact": "Description of how users are affected",
    "security_implications": "Any security concerns if applicable"
  },
  "reproduction": {
    "reproducible": true,
    "steps": ["Step 1", "Step 2"],
    "conditions": "Under what conditions this occurs"
  },
  "recommendations": {
    "implementation_approach": "Detailed description of how to implement",
    "estimated_complexity": "LOW|MEDIUM|HIGH",
    "prerequisites": ["Dependency updates needed", "etc"],
    "test_strategy": "How to test and verify"
  },
  "evidence": [
    {
      "type": "file",
      "file": "path/to/file.ts",
      "line_start": 42,
      "line_end": 50,
      "output": "Relevant code or output"
    }
  ],
  "corrected_description": "Only if PARTIAL or MISDIAGNOSED"
}
\`\`\`

## Status Definitions

- **CONFIRMED**: Work item is valid and actionable. You have concrete evidence.
- **FALSE**: Work item is not valid or not needed. Explain why.
- **PARTIAL**: Work item is valid but scope/severity/priority differs from described.
- **MISDIAGNOSED**: Valid need exists but a different approach is recommended.

## Quality Requirements

1. **Evidence Required**: CONFIRMED/PARTIAL/MISDIAGNOSED must have at least 2 evidence items
2. **File References**: All evidence must have specific file:line references
3. **Commands**: Document all commands you ran
4. **No Assumptions**: Don't claim evidence without actually finding it
5. **Thoroughness**: Spend time on deep investigation, not quick checks`);

	// Add probe evidence if available
	if (probeEvidence) {
		parts.push(probeEvidence);
	}

	return parts.join("\n\n");
}

/**
 * Build the Issue Validator prompt for a specific issue (legacy - for backwards compatibility)
 */
export function buildIssueValidatorPrompt(issue: Issue, workDir: string): string {
	return buildDeepIssueValidatorPrompt(issue, workDir, 0);
}
