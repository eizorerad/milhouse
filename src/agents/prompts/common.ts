/**
 * Shared prompt helpers — inject user config (rules, extraInstructions) into prompts.
 */

import type { PhaseName } from "../../config/define.ts";
import type { PhaseContext } from "../../runner/types.ts";

/**
 * Append user-configured rules and per-phase extra instructions to a prompt parts array.
 * Call this at the end of every prompt builder.
 */
export function appendUserConfig(parts: string[], phase: PhaseName, ctx: PhaseContext): void {
	const cfg = ctx.userConfig;
	if (!cfg) return;

	if (cfg.rules.length > 0) {
		parts.push(`## Project Rules\n\n${cfg.rules.map(r => `- ${r}`).join("\n")}`);
	}

	const extra = cfg.prompts?.[phase]?.extraInstructions;
	if (extra) {
		parts.push(`## Additional Instructions\n\n${extra}`);
	}
}
