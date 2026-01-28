/**
 * Document Factory
 *
 * Provides a unified interface for generating and managing
 * Milhouse documentation files (Problem Brief, Execution Plan, etc.)
 */

// Re-export Problem Brief types and functions
export {
	type ProblemBriefOptions,
	type ProblemBriefResult,
	generateProblemBrief,
	generateProblemBriefMarkdown,
	regenerateProblemBrief,
	saveProblemBrief,
} from "./problem-brief.ts";

// Re-export Execution Plan types and functions
export {
	type ExecutionPlanOptions,
	type ExecutionPlanResult,
	generateExecutionPlan,
	generateExecutionPlanMarkdown,
	regenerateExecutionPlan,
	saveExecutionPlan,
} from "./execution-plan.ts";

import type { ExecutionPlanOptions, ExecutionPlanResult } from "./execution-plan.ts";
import { regenerateExecutionPlan, saveExecutionPlan } from "./execution-plan.ts";
import type { ProblemBriefOptions, ProblemBriefResult } from "./problem-brief.ts";
import { regenerateProblemBrief, saveProblemBrief } from "./problem-brief.ts";

/**
 * Document types available for generation
 */
export type DocumentType = "problem-brief" | "execution-plan";

/**
 * Union of all document options
 */
export type DocumentOptions = ProblemBriefOptions | ExecutionPlanOptions;

/**
 * Union of all document results
 */
export type DocumentResult = ProblemBriefResult | ExecutionPlanResult;

/**
 * Document generation request
 */
export interface GenerateDocumentRequest {
	/** Type of document to generate */
	type: DocumentType;
	/** Working directory (default: process.cwd()) */
	workDir?: string;
	/** Document-specific options */
	options?: DocumentOptions;
	/** Whether to regenerate (update existing) */
	regenerate?: boolean;
}

/**
 * Generate a document by type
 *
 * @param request - Document generation request
 * @returns Document result with success status, file path, and content
 *
 * @example
 * ```typescript
 * // Generate Problem Brief
 * const result = generateDocument({
 *   type: "problem-brief",
 *   workDir: "/path/to/project",
 *   options: { includeEvidence: true }
 * });
 *
 * // Regenerate Execution Plan after task completion
 * const result = generateDocument({
 *   type: "execution-plan",
 *   regenerate: true
 * });
 * ```
 */
export function generateDocument(request: GenerateDocumentRequest): DocumentResult {
	const workDir = request.workDir ?? process.cwd();

	switch (request.type) {
		case "problem-brief": {
			const options = request.options as ProblemBriefOptions | undefined;
			if (request.regenerate) {
				return regenerateProblemBrief(workDir, options);
			}
			return saveProblemBrief(workDir, options);
		}

		case "execution-plan": {
			const options = request.options as ExecutionPlanOptions | undefined;
			if (request.regenerate) {
				return regenerateExecutionPlan(workDir, options);
			}
			return saveExecutionPlan(workDir, options);
		}

		default: {
			const exhaustiveCheck: never = request.type;
			throw new Error(`Unknown document type: ${exhaustiveCheck}`);
		}
	}
}

/**
 * Generate all documents from current state
 *
 * @param workDir - Working directory
 * @param regenerate - Whether to regenerate existing documents
 * @returns Map of document type to generation result
 */
export function generateAllDocuments(
	workDir: string = process.cwd(),
	regenerate = false,
): Map<DocumentType, DocumentResult> {
	const results = new Map<DocumentType, DocumentResult>();

	const documentTypes: DocumentType[] = ["problem-brief", "execution-plan"];

	for (const type of documentTypes) {
		const result = generateDocument({
			type,
			workDir,
			regenerate,
		});
		results.set(type, result);
	}

	return results;
}

/**
 * Get the file name for a document type
 *
 * @param type - Document type
 * @returns File name without path
 */
export function getDocumentFileName(type: DocumentType): string {
	const fileNames: Record<DocumentType, string> = {
		"problem-brief": "problem_brief.md",
		"execution-plan": "execution_plan.md",
	};
	return fileNames[type];
}

/**
 * Get a human-readable display name for a document type
 *
 * @param type - Document type
 * @returns Human-readable name
 */
export function getDocumentDisplayName(type: DocumentType): string {
	const displayNames: Record<DocumentType, string> = {
		"problem-brief": "Problem Brief",
		"execution-plan": "Execution Plan",
	};
	return displayNames[type];
}

/**
 * List all available document types
 *
 * @returns Array of document type identifiers
 */
export function listDocumentTypes(): DocumentType[] {
	return ["problem-brief", "execution-plan"];
}
