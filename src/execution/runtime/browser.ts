/**
 * Milhouse Browser Automation Runtime
 *
 * Provides browser automation capabilities for Milhouse execution.
 * Uses the agent-browser CLI for web interaction during task execution.
 *
 * Features:
 * - Browser availability detection
 * - Prompt instruction generation
 * - Event emission for browser operations
 * - Pipeline-aware configuration
 *
 * @module execution/runtime/browser
 * @since 1.0.0
 */

import { execSync } from "node:child_process";
import { logDebug, logWarn } from "../../ui/logger.ts";
import type { BrowserConfig, BrowserMode, MilhouseRuntimeContext } from "./types.ts";

// ============================================================================
// Browser Detection
// ============================================================================

/**
 * Check if the agent-browser CLI is installed and available
 *
 * @returns true if agent-browser is available in PATH
 */
export function detectAgentBrowser(): boolean {
	try {
		const isWindows = process.platform === "win32";
		const checkCommand = isWindows ? "where agent-browser" : "which agent-browser";
		execSync(checkCommand, { stdio: "ignore" });
		logDebug("agent-browser CLI detected");
		return true;
	} catch {
		logDebug("agent-browser CLI not found in PATH");
		return false;
	}
}

/**
 * Check if browser automation should be enabled based on mode
 *
 * @param mode - Browser mode setting
 * @returns true if browser should be enabled
 */
export function shouldEnableBrowser(mode: BrowserMode): boolean {
	switch (mode) {
		case "disabled":
			return false;
		case "enabled":
			if (!detectAgentBrowser()) {
				logWarn("Browser mode set to 'enabled' but agent-browser CLI not found");
				logWarn("Install from: https://agent-browser.dev");
				return false;
			}
			return true;
		case "auto":
		default:
			return detectAgentBrowser();
	}
}

/**
 * Convert legacy browser flag to BrowserMode
 *
 * @param flag - Legacy flag value ('auto' | 'true' | 'false')
 * @returns Corresponding BrowserMode
 */
export function legacyFlagToBrowserMode(flag: "auto" | "true" | "false"): BrowserMode {
	switch (flag) {
		case "true":
			return "enabled";
		case "false":
			return "disabled";
		case "auto":
		default:
			return "auto";
	}
}

// ============================================================================
// Browser Configuration
// ============================================================================

/**
 * Create browser configuration based on mode
 *
 * @param mode - Browser mode setting
 * @returns Complete browser configuration
 */
export function createBrowserConfig(mode: BrowserMode = "auto"): BrowserConfig {
	const isAvailable = shouldEnableBrowser(mode);

	return {
		mode,
		isAvailable,
		cliCommand: "agent-browser",
		instructions: isAvailable ? generateBrowserInstructions() : undefined,
	};
}

/**
 * Create browser configuration from runtime context
 *
 * @param context - Milhouse runtime context
 * @param mode - Browser mode override
 * @returns Browser configuration
 */
export function createBrowserConfigFromContext(
	context: MilhouseRuntimeContext,
	mode: BrowserMode = "auto",
): BrowserConfig {
	const config = createBrowserConfig(mode);

	// Emit event if browser is available
	if (config.isAvailable) {
		context.emitEvent("probe:start", { name: "browser-automation" });
		context.emitEvent("probe:complete", {
			name: "browser-automation",
			result: { available: true, mode },
		});
	}

	return config;
}

// ============================================================================
// Browser Instructions
// ============================================================================

/**
 * Generate browser automation instructions for prompt injection
 *
 * These instructions are included in the AI prompt when browser
 * automation is available, enabling the AI to interact with web pages.
 *
 * @returns Formatted browser instructions
 */
export function generateBrowserInstructions(): string {
	return `## Browser Automation (Milhouse agent-browser)

You have access to browser automation via the \`agent-browser\` CLI.
This enables web interaction for testing, verification, and data gathering.

### Available Commands

| Command | Description |
|---------|-------------|
| \`agent-browser open <url>\` | Navigate to a URL |
| \`agent-browser snapshot\` | Get accessibility tree with element refs (@e1, @e2, etc.) |
| \`agent-browser click @e1\` | Click an element by reference |
| \`agent-browser type @e1 "text"\` | Type text into an input field |
| \`agent-browser screenshot <file.png>\` | Capture screenshot |
| \`agent-browser content\` | Get page text content |
| \`agent-browser close\` | Close browser session |

### Recommended Workflow

1. **Navigate**: Use \`open\` to go to the target URL
2. **Inspect**: Use \`snapshot\` to see available elements (returns refs like @e1, @e2)
3. **Interact**: Use \`click\`/\`type\` with element refs
4. **Verify**: Use \`screenshot\` for visual confirmation

### Use Cases

- **Testing**: Verify web UI after implementing features
- **Verification**: Check deployments and live environments
- **Forms**: Fill forms or test workflows
- **Visual**: Capture screenshots for regression testing

### Best Practices

- Always close the browser session when done
- Use snapshots to understand page structure before interacting
- Capture screenshots at key verification points
- Handle navigation timeouts gracefully`;
}

/**
 * Generate compact browser instructions for parallel execution
 *
 * @returns Compact browser instructions
 */
export function generateCompactBrowserInstructions(): string {
	return `## Browser Automation

\`agent-browser\` CLI available for web interaction:
- \`open <url>\` - Navigate
- \`snapshot\` - Get element refs (@e1, @e2)
- \`click @e1\` / \`type @e1 "text"\` - Interact
- \`screenshot <file>\` - Capture
- \`close\` - End session`;
}

// ============================================================================
// Browser Utilities
// ============================================================================

/**
 * Check browser availability and emit appropriate events
 *
 * @param context - Runtime context for event emission
 * @param mode - Browser mode to check
 * @returns Whether browser is available
 */
export function checkBrowserAvailability(
	context: MilhouseRuntimeContext,
	mode: BrowserMode = "auto",
): boolean {
	const isAvailable = shouldEnableBrowser(mode);

	if (mode === "enabled" && !isAvailable) {
		context.emitEvent("probe:error", {
			name: "browser-automation",
			error: new Error("Browser automation requested but agent-browser not available"),
		});
	}

	return isAvailable;
}

/**
 * Get browser instructions if available
 *
 * @param config - Browser configuration
 * @param compact - Use compact instructions
 * @returns Browser instructions or empty string
 */
export function getBrowserInstructionsIfAvailable(config: BrowserConfig, compact = false): string {
	if (!config.isAvailable) {
		return "";
	}

	return compact ? generateCompactBrowserInstructions() : generateBrowserInstructions();
}

// ============================================================================
// Backward Compatibility Exports
// ============================================================================

/**
 * Check if agent-browser CLI is available
 * @deprecated Use detectAgentBrowser() instead
 */
export const isAgentBrowserInstalled = detectAgentBrowser;

/**
 * Check if browser automation should be enabled
 * @deprecated Use shouldEnableBrowser() with BrowserMode instead
 */
export function isBrowserAvailable(browserEnabled: "auto" | "true" | "false"): boolean {
	const mode = legacyFlagToBrowserMode(browserEnabled);
	return shouldEnableBrowser(mode);
}

/**
 * Get browser instructions for prompt injection
 * @deprecated Use generateBrowserInstructions() instead
 */
export const getBrowserInstructions = generateBrowserInstructions;
