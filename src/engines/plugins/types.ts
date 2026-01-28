import type { IEnginePlugin } from "../core/types";
import { AiderPlugin } from "./aider";
import { ClaudePlugin } from "./claude";
import { CodexPlugin } from "./codex";
import { CursorPlugin } from "./cursor";
import { DroidPlugin } from "./droid";
import { GeminiPlugin } from "./gemini";
import { OpencodePlugin } from "./opencode";
import { QwenPlugin } from "./qwen";

/**
 * Plugin factory function type.
 */
export type PluginFactory = () => IEnginePlugin;

/**
 * Plugin registry for managing engine plugins.
 * Provides a centralized way to register, retrieve, and list plugins.
 */
class PluginRegistry {
	private readonly plugins = new Map<string, PluginFactory>();

	constructor() {
		// Register built-in plugins
		this.register("aider", () => new AiderPlugin());
		this.register("claude", () => new ClaudePlugin());
		this.register("gemini", () => new GeminiPlugin());
		this.register("opencode", () => new OpencodePlugin());
		this.register("cursor", () => new CursorPlugin());
		this.register("codex", () => new CodexPlugin());
		this.register("qwen", () => new QwenPlugin());
		this.register("droid", () => new DroidPlugin());
	}

	/**
	 * Register a plugin factory.
	 * @param name - Unique name for the plugin
	 * @param factory - Factory function that creates plugin instances
	 */
	register(name: string, factory: PluginFactory): void {
		if (this.plugins.has(name)) {
			throw new Error(`Plugin '${name}' is already registered`);
		}
		this.plugins.set(name, factory);
	}

	/**
	 * Unregister a plugin.
	 * @param name - Name of the plugin to unregister
	 * @returns true if plugin was unregistered, false if not found
	 */
	unregister(name: string): boolean {
		return this.plugins.delete(name);
	}

	/**
	 * Get a plugin by name.
	 * @param name - Name of the plugin
	 * @returns New plugin instance
	 * @throws Error if plugin not found
	 */
	get(name: string): IEnginePlugin {
		const factory = this.plugins.get(name);
		if (!factory) {
			throw new Error(`Unknown engine: '${name}'. Available engines: ${this.list().join(", ")}`);
		}
		return factory();
	}

	/**
	 * Check if a plugin is registered.
	 * @param name - Name of the plugin
	 * @returns true if plugin is registered
	 */
	has(name: string): boolean {
		return this.plugins.has(name);
	}

	/**
	 * List all registered plugin names.
	 * @returns Array of plugin names
	 */
	list(): string[] {
		return Array.from(this.plugins.keys());
	}

	/**
	 * Get all plugins as instances.
	 * @returns Array of plugin instances
	 */
	getAll(): IEnginePlugin[] {
		return this.list().map((name) => this.get(name));
	}

	/**
	 * Get all available plugins (those that pass isAvailable check).
	 * @returns Promise resolving to array of available plugin instances
	 */
	async getAvailable(): Promise<IEnginePlugin[]> {
		const plugins = this.getAll();
		const available: IEnginePlugin[] = [];

		for (const plugin of plugins) {
			try {
				if (await plugin.isAvailable()) {
					available.push(plugin);
				}
			} catch {
				// Plugin check failed, skip it
			}
		}

		return available;
	}

	/**
	 * Get the first available plugin.
	 * @returns Promise resolving to first available plugin or null
	 */
	async getFirstAvailable(): Promise<IEnginePlugin | null> {
		const available = await this.getAvailable();
		return available[0] || null;
	}
}

// Singleton registry instance
const registry = new PluginRegistry();

/**
 * Get a plugin by name from the global registry.
 * @param name - Name of the plugin
 * @returns New plugin instance
 */
export function getPlugin(name: string): IEnginePlugin {
	return registry.get(name);
}

/**
 * List all registered plugin names.
 * @returns Array of plugin names
 */
export function listPlugins(): string[] {
	return registry.list();
}

/**
 * Register a custom plugin.
 * @param name - Unique name for the plugin
 * @param factory - Factory function that creates plugin instances
 */
export function registerPlugin(name: string, factory: PluginFactory): void {
	registry.register(name, factory);
}

/**
 * Unregister a plugin.
 * @param name - Name of the plugin to unregister
 * @returns true if plugin was unregistered
 */
export function unregisterPlugin(name: string): boolean {
	return registry.unregister(name);
}

/**
 * Check if a plugin is registered.
 * @param name - Name of the plugin
 * @returns true if plugin is registered
 */
export function hasPlugin(name: string): boolean {
	return registry.has(name);
}

/**
 * Get all available plugins.
 * @returns Promise resolving to array of available plugins
 */
export async function getAvailablePlugins(): Promise<IEnginePlugin[]> {
	return registry.getAvailable();
}

/**
 * Get the first available plugin.
 * @returns Promise resolving to first available plugin or null
 */
export async function getFirstAvailablePlugin(): Promise<IEnginePlugin | null> {
	return registry.getFirstAvailable();
}

/**
 * Get the plugin registry instance for advanced usage.
 * @returns The singleton registry instance
 */
export function getRegistry(): PluginRegistry {
	return registry;
}

// Re-export plugin classes for direct instantiation
export { AiderPlugin } from "./aider";
export { ClaudePlugin } from "./claude";
export { GeminiPlugin } from "./gemini";
export { OpencodePlugin } from "./opencode";
export { CursorPlugin } from "./cursor";
export { CodexPlugin } from "./codex";
export { QwenPlugin } from "./qwen";
export { DroidPlugin } from "./droid";
