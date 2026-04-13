import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const promptDir = join(process.cwd(), "src", "prompts");
const files = [];

try {
	for (const entry of readdirSync(promptDir, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".ts")) {
			const fullPath = join(promptDir, entry.name);
			files.push({
				path: relative(process.cwd(), fullPath),
				content: normalize(readFileSync(fullPath, "utf8")),
			});
		}
	}
} catch {
	console.log("similarity-check skipped: src/prompts not found");
	process.exit(0);
}

const threshold = 0.985;
const tooSimilar = [];
for (let i = 0; i < files.length; i++) {
	for (let j = i + 1; j < files.length; j++) {
		const score = dice(files[i].content, files[j].content);
		if (score >= threshold) {
			tooSimilar.push({ left: files[i].path, right: files[j].path, score });
		}
	}
}

if (tooSimilar.length > 0) {
	console.error("similarity-check failed:");
	for (const pair of tooSimilar) {
		console.error(`  ${pair.left} <-> ${pair.right} (${pair.score.toFixed(3)})`);
	}
	process.exit(1);
}

console.log("similarity-check passed");

function normalize(text) {
	return text.replace(/\s+/g, " ").trim();
}

function dice(a, b) {
	if (!a || !b) return 0;
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return 0;

	const counts = new Map();
	for (let i = 0; i < a.length - 1; i++) {
		const bigram = a.slice(i, i + 2);
		counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
	}

	let overlap = 0;
	for (let i = 0; i < b.length - 1; i++) {
		const bigram = b.slice(i, i + 2);
		const count = counts.get(bigram) ?? 0;
		if (count > 0) {
			counts.set(bigram, count - 1);
			overlap++;
		}
	}

	return (2 * overlap) / (a.length + b.length - 2);
}
