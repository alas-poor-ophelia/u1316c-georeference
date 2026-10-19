/**
 * Phase 0 gate: prove the community-store scanner replica DETECTS, not merely that it loads.
 *
 * A lint run that is green on a tree with nothing in it proves nothing. This plants three
 * violations from three different rule families, asserts the scanner reports each one BY RULE ID,
 * removes them, and asserts the tree is green again.
 *
 * Asserting on the rule ids rather than on a non-zero exit code is the point: a broken config, a
 * syntax error, or a missing dependency also exits non-zero, and a gate that cannot tell those
 * apart from a real detection is not a gate.
 *
 * No `node:` imports here on purpose. The store scan reads the whole tracked tree, not just src/,
 * and flags Node built-ins because they are unavailable on mobile. A tracked dev script that
 * trips that rule puts warnings on the scorecard exactly the way a sibling plugin's harness
 * directory did. Bun's own APIs carry no such rule.
 *
 * Run: bun run gate:scanner
 */
import { $ } from "bun";

const PROBE_DIR = "src/__gate";

/** Each probe is a file plus the rule id the scanner must name when it sees it. */
const PROBES: ReadonlyArray<{ file: string; rule: string; source: string }> = [
	{
		file: "styles.ts",
		rule: "obsidianmd/no-static-styles-assignment",
		source: "export function paint(el: HTMLElement): void {\n  el.style.color = \"red\";\n}\n",
	},
	{
		file: "names.ts",
		rule: "obsidianmd/sample-names",
		source: "export class MyPlugin {\n  readonly id = \"my-plugin\";\n}\n",
	},
	{
		file: "logging.ts",
		rule: "obsidianmd/rule-custom-message",
		source: "export function shout(msg: string): void {\n  console.log(msg);\n}\n",
	},
];

/** The scan covers every tracked TypeScript directory, not only src/. See the header. */
const SCAN_PATHS = ["src", "scripts", "test"];

async function runScanner(): Promise<{ code: number; output: string }> {
	const res = await $`bunx eslint --config eslint.scanner-replica.mjs ${SCAN_PATHS} --max-warnings 0`
		.quiet()
		.nothrow();
	return { code: res.exitCode, output: res.stdout.toString() + res.stderr.toString() };
}

async function plant(): Promise<void> {
	for (const p of PROBES) await Bun.write(`${PROBE_DIR}/${p.file}`, p.source);
}

async function clear(): Promise<void> {
	await $`rm -rf ${PROBE_DIR}`.quiet().nothrow();
}

const failures: string[] = [];

// 1. Clean tree must be green. If it is not, nothing below means anything.
await clear();
const before = await runScanner();
if (before.code !== 0) {
	failures.push(`clean tree is not green (exit ${before.code}); fix real violations first`);
	console.error(before.output);
}

// 2. Planted tree must be red, and must name every expected rule.
await plant();
const planted = await runScanner();
if (planted.code === 0) {
	failures.push("scanner passed a tree containing three deliberate violations");
}
for (const p of PROBES) {
	if (!planted.output.includes(p.rule)) {
		failures.push(`scanner did not report ${p.rule} for ${PROBE_DIR}/${p.file}`);
	}
}

// 3. Removing them must restore green, so the detection was the probes and not residue.
await clear();
const after = await runScanner();
if (after.code !== 0) {
	failures.push(`tree not green after removing probes (exit ${after.code})`);
	console.error(after.output);
}

if (failures.length > 0) {
	for (const f of failures) console.error(`  - ${f}`);
	console.error("GATE FAILED");
	process.exit(1);
}

console.error(
	`scanned ${SCAN_PATHS.join(" ")}; clean=${before.code} planted=${planted.code} restored=${after.code}; ${PROBES.length}/${PROBES.length} rules detected`,
);
console.error("GATE GREEN");
