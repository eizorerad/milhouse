/**
 * @fileoverview Milhouse Validate Command
 *
 * Handles the --validate command to validate issues using Issue Validator (IV) agents.
 * Updates issue status to CONFIRMED, FALSE, PARTIAL, or MISDIAGNOSED.
 *
 * @module cli/commands/pipeline/validate
 *
 * @since 4.3.0
 *
 * @example
 * ```bash
 * # Validate all unvalidated issues
 * milhouse --validate
 *
 * # Validate specific issues
 * milhouse --validate --issues P-xxx,P-yyy
 * ```
 */

// Re-export from the original validate command
// The original command already uses Milhouse branding
export { runValidate } from "../validate.ts";
