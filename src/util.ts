/** Small helpers shared across modules. */

export const now = (): string => new Date().toISOString();

export const MINUTE = 60_000;

export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** Text from the agent or the repository, safe to print: no terminal escape sequences or control characters. */
export function stripControl(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
	return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** The strings of a value that should be a list of strings: anything else in it, or around it, is dropped. */
export const stringList = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function errorMessage(err: unknown): string {
	return stripControl(err instanceof Error ? err.message : String(err));
}

export function generateId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Last `max` characters of a text, trimmed (command output, stderr). */
export function tail(text: string, max = 2000): string {
	const trimmed = text.trim();
	return trimmed.length <= max ? trimmed : `...${trimmed.slice(-max)}`;
}

/** Run `fn` over `items` with at most `size` calls in flight. Results keep the input order. */
export async function mapPool<T, R>(
	items: readonly T[],
	size: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(Math.max(size, 1), items.length) }, worker));
	return results;
}

/** Index of the bracket that closes the one at `start`, or -1. String contents are skipped. */
function closingIndex(text: string, start: number): number {
	const open = text[start];
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (c === "\\") i++;
			else if (c === '"') inString = false;
		} else if (c === '"') inString = true;
		else if (c === open) depth++;
		else if (c === close && --depth === 0) return i;
	}
	return -1;
}

function isJson(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

/**
 * The largest JSON object or array in free-form model output (fenced or not). The answer is the largest:
 * the prose around it may hold brackets of its own, such as `[0]` or `{}`.
 */
export function extractJson(text: string): string | null {
	// A bracket after the last closing one of its kind cannot be closed: not worth a look.
	const lastClose: Record<string, number> = {
		"{": text.lastIndexOf("}"),
		"[": text.lastIndexOf("]"),
	};
	let best: string | null = null;
	for (let start = 0; start < text.length; start++) {
		const open = text[start];
		if ((open !== "{" && open !== "[") || start > lastClose[open]) continue;
		const end = closingIndex(text, start);
		if (end === -1) continue;
		const candidate = text.slice(start, end + 1);
		if (!isJson(candidate)) continue; // a bracket in prose: try the next one
		if (best === null || candidate.length > best.length) best = candidate;
		start = end; // brackets inside belong to this value
	}
	return best;
}

/** Parse model output as JSON (structured output or fenced block). Throws a short error. */
export function parseJson<T>(text: string, what: string): T {
	const json = extractJson(text);
	if (!json) throw new Error(`${what}: no JSON in the response (got: ${tail(text, 120)})`);
	return JSON.parse(json) as T;
}
