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
import { AGENT_ROLES, type Issue } from "../../../state/types.ts";

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
	parts.push(`## Role: Issue Validator Agent #${agentNum} (IV-${agentNum})
${AGENT_ROLES.IV}

You are **dedicated validator agent #${agentNum}** investigating a SINGLE issue.
Your task is to perform a DEEP, THOROUGH investigation and produce a comprehensive validation report.

⚠️ **IMPORTANT**: This is a deep investigation, not a quick check. Take your time to:
- Read ALL related files completely
- Trace the code flow from start to end
- Run actual tests and commands
- Consider edge cases and alternative explanations
- Prove or disprove the hypothesis with concrete evidence`);

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

	// Issue to validate with full context
	parts.push(`## Issue Under Investigation

| Field | Value |
|-------|-------|
| **ID** | ${issue.id} |
| **Symptom** | ${issue.symptom} |
| **Hypothesis** | ${issue.hypothesis} |
| **Claimed Severity** | ${issue.severity} |
${issue.frequency ? `| **Claimed Frequency** | ${issue.frequency} |` : ""}
${issue.blast_radius ? `| **Claimed Blast Radius** | ${issue.blast_radius} |` : ""}
${issue.strategy ? `| **Suggested Strategy** | ${issue.strategy} |` : ""}

### Previous Evidence (from scan)
${issue.evidence.length > 0 ? issue.evidence.map((e) => `- ${e.type}: ${e.file || e.command || e.probe_id || "N/A"}`).join("\n") : "No previous evidence collected"}`);

	// Deep investigation instructions
	parts.push(`## Deep Investigation Protocol

### Phase 1: Code Exploration
1. Read the files mentioned in the symptom/hypothesis completely
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
3. Suggest test strategy to prevent regression`);

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
        "relevance": "This is where the bug manifests",
        "code_snippet": "optional relevant code"
      }
    ]
  },
  "root_cause_analysis": {
    "confirmed_cause": "The actual root cause if CONFIRMED",
    "alternative_causes": ["Other possible explanations considered"],
    "why_not_false_positive": "Evidence that this is NOT a false positive"
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
    "fix_approach": "Detailed description of how to fix",
    "estimated_complexity": "LOW|MEDIUM|HIGH",
    "prerequisites": ["Dependency updates needed", "etc"],
    "test_strategy": "How to test the fix"
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

- **CONFIRMED**: Issue exists EXACTLY as described. You have concrete evidence.
- **FALSE**: Issue does NOT exist. Explain why it's a false positive.
- **PARTIAL**: Issue exists but severity/scope/frequency is different than claimed.
- **MISDIAGNOSED**: A real problem exists but the root cause is different.

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
