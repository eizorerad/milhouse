/**
 * @fileoverview Milhouse CLI Commands Module
 *
 * Barrel export for all CLI commands organized by group:
 * - pipeline: Pipeline phases (scan, validate, plan, consolidate, exec, verify)
 * - utils: Utility commands (export)
 *
 * @module cli/commands
 *
 * @since 4.3.0
 */

// ============================================================================
// Pipeline Commands (scan, validate, plan, consolidate, exec, verify)
// ============================================================================
export * from "./pipeline/index.ts";

// ============================================================================
// Utility Commands (export)
// ============================================================================
export * from "./utils/index.ts";

// ============================================================================
// Direct Command Exports
// ============================================================================

// Init command
export { runInit } from "./init.ts";

// Config command
export { showConfig, addRule } from "./config.ts";

// Task command
export { runTask } from "./task.ts";

// Run commands
export { runPipelineMode, runLoop } from "./run.ts";

// Runs management
export { runsCommand } from "./runs.ts";
