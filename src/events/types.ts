import type { AgentRole, PipelinePhase } from "../schemas/engine.schema";

/**
 * Milhouse execution context fields for events.
 * These optional fields provide pipeline-aware tracking information.
 */
export interface MilhouseEventContext {
	/** Unique run identifier for tracking across the pipeline */
	runId?: string;
	/** Role of the agent executing the operation */
	agentRole?: AgentRole;
	/** Current phase in the pipeline workflow */
	pipelinePhase?: PipelinePhase;
}

// Define strongly typed event map for all Milhouse events
export type MilhouseEvents = {
	// Pipeline lifecycle
	"pipeline:start": { runId: string; phases: string[] };
	"pipeline:phase:start": { runId: string; phase: string };
	"pipeline:phase:complete": { runId: string; phase: string; duration: number };
	"pipeline:phase:error": { runId: string; phase: string; error: Error };
	"pipeline:complete": { runId: string; duration: number };

	// Task lifecycle
	"task:start": { taskId: string; title: string; worktree?: string } & MilhouseEventContext;
	"task:progress": { taskId: string; step: string; detail?: string } & MilhouseEventContext;
	"task:complete": { taskId: string; duration: number; success: boolean } & MilhouseEventContext;
	"task:error": { taskId: string; error: Error } & MilhouseEventContext;

	// Engine lifecycle (enhanced with Milhouse context)
	"engine:start": { engine: string; taskId: string } & MilhouseEventContext;
	"engine:streaming": { engine: string; taskId: string; chunk: string } & MilhouseEventContext;
	"engine:complete": { engine: string; taskId: string; result: unknown } & MilhouseEventContext;
	"engine:error": { engine: string; taskId: string; error: Error } & MilhouseEventContext;

	// Git operations
	"git:worktree:create": { path: string; branch: string } & MilhouseEventContext;
	"git:worktree:cleanup": { path: string } & MilhouseEventContext;
	"git:branch:create": { name: string } & MilhouseEventContext;
	"git:merge:start": { source: string; target: string } & MilhouseEventContext;
	"git:merge:complete": { source: string; target: string } & MilhouseEventContext;
	"git:merge:conflict": { source: string; target: string; files: string[] } & MilhouseEventContext;
	"git:rebase:start": { source: string; target: string } & MilhouseEventContext;
	"git:rebase:complete": { source: string; target: string } & MilhouseEventContext;
	"git:rebase:conflict": { source: string; target: string; files: string[] } & MilhouseEventContext;

	// Gate checks
	"gate:start": { name: string; taskId: string } & MilhouseEventContext;
	"gate:pass": { name: string; taskId: string } & MilhouseEventContext;
	"gate:fail": { name: string; taskId: string; reason: string } & MilhouseEventContext;

	// Probe checks
	"probe:start": { name: string } & MilhouseEventContext;
	"probe:complete": { name: string; result: unknown } & MilhouseEventContext;
	"probe:error": { name: string; error: Error } & MilhouseEventContext;
};

export type EventName = keyof MilhouseEvents;
export type EventPayload<E extends EventName> = MilhouseEvents[E];
