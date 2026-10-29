/**
 * The doc-drift gate: API.md pinned to the real surface, in three independent ways.
 *
 * Documentation rots silently, and an API doc that lies is worse than none — a consumer writes
 * against it and the failure lands in their plugin. So the parts of API.md that make factual
 * claims about the surface are extracted from the file and compared with the code:
 *
 *   1. the method table against `API_KEYS` (and so, transitively, against the live object);
 *   2. the error-code table against the `GebErrorCode` union;
 *   3. a worked example against a real api call on a real fixture.
 *
 * The third is the one that catches a changed RESULT rather than a changed name, which the other
 * two cannot see.
 */
import { describe, expect, test } from "bun:test";
import { ApiController } from "../src/api/controller";
import { MIN_POINTS, RECOMMENDED_POINTS } from "../src/core/types";
import { KEY } from "../src/persist/types";
import { FEATURE_KEY } from "../src/query/types";
import { COPY } from "../src/view/copy";
import { MODELS } from "../src/view/shell";
import { hashBytes } from "../src/persist/identity";
import { toFrontmatter } from "../src/persist/serialize";
import type { Georeference } from "../src/persist/types";
import { CLEAN, IMAGE } from "./fixtures";
import { FakeVault } from "./fake-vault";
import { API_KEYS } from "./types/conformance";

/**
 * Read through `Bun.file`, NOT `node:fs`.
 *
 * The scanner replica rejected the first draft of this file for importing `node:fs` and
 * `node:path` — and it was right to. The community store's scanner lints `test` as well as `src`
 * and does not distinguish plugin code from harness code, which is the exact blind spot that got
 * a sibling plugin delisted. A node built-in anywhere in the scanned tree is a rejection risk,
 * even in a file that never ships.
 */
const ROOT = `${import.meta.dir}/..`;
const DOC = await Bun.file(`${ROOT}/API.md`).text();

/** Everything between a pair of `<!-- geb:name -->` / `<!-- /geb:name -->` markers. */
function section(name: string): string {
	const open = `<!-- geb:${name} -->`;
	const close = `<!-- /geb:${name} -->`;
	const from = DOC.indexOf(open);
	const to = DOC.indexOf(close);
	if (from < 0 || to < 0) throw new Error(`API.md is missing its ${name} section markers`);
	return DOC.slice(from + open.length, to);
}

/** The first column of every row of a markdown table, unwrapped from its backticks. */
function firstColumn(markdown: string): string[] {
	const out: string[] = [];
	for (const line of markdown.split("\n")) {
		const m = /^\|\s*`([^`]+)`\s*\|/.exec(line.trim());
		if (m !== null) out.push(m[1]!);
	}
	return out;
}

describe("API.md cannot drift from the surface", () => {
	test("every member is documented, and nothing undocumented is claimed", () => {
		const documented = firstColumn(section("methods"));
		expect(documented.sort()).toEqual([...API_KEYS].sort());
	});

	test("every error code is documented, and no invented ones are", async () => {
		// Read off the source rather than a second hand-written list: the union is the truth, and a
		// list here would be the very duplication this test exists to catch.
		const source = await Bun.file(`${ROOT}/src/api/errors.ts`).text();
		const union = source.slice(source.indexOf("export type GebErrorCode"), source.indexOf("export function codedError"));
		const codes = [...union.matchAll(/"(geb-[a-z-]+)"/g)].map((m) => m[1]!);
		expect(codes.length).toBeGreaterThan(5);
		expect(firstColumn(section("error-codes")).sort()).toEqual([...new Set(codes)].sort());
	});

	test("every event is documented, and no invented ones are", async () => {
		// Read off the GebEvent union in source, same discipline as the error codes: the union is
		// the truth and a second hand-written list here would be the drift this test exists to
		// catch. The doc claimed the change events were NOT in API 1 until the moment they were.
		const source = await Bun.file(`${ROOT}/src/api/types.ts`).text();
		const union = source.slice(source.indexOf("export type GebEvent"), source.indexOf("export interface GebEventPayload"));
		const events = [...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
		expect(events.length).toBe(5);
		expect(firstColumn(section("events")).sort()).toEqual([...events].sort());
	});

	test("every transform kind is named in the doc", () => {
		// MIN_POINTS is keyed by every TransformKind, so a kind added to the union without a doc
		// mention fails here rather than shipping undocumented.
		for (const kind of Object.keys(MIN_POINTS)) expect(DOC).toContain(kind);
	});

	test("the worked example still produces what the doc says it does", () => {
		// The pin that catches a changed RESULT rather than a changed name.
		const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
		const record: Georeference = {
			id: "britain-5c",
			imageLink: "[[britain-5c.png]]",
			image: { width: IMAGE.width, height: IMAGE.height, byteLength: bytes.byteLength, hash: hashBytes(bytes) },
			crs: "earth",
			fits: [{ bounds: null, transform: { model: "tps" }, points: CLEAN.map((p) => ({ ...p })) }],
		};
		const v = new FakeVault();
		v.addFile("britain-5c.png", bytes);
		v.addNote("maps/britain-5c.md", toFrontmatter(record));
		v.addNote("places/Eboracum.md", { lat: 53.9591, lng: -1.0815 });
		const c = new ApiController(v, "0.0.1");
		c.markReady();

		// `\r?\n`, because the working tree's line endings are not ours to assume. This repo has
		// `core.autocrlf=true`, so git stores LF and checks out CRLF on Windows — a test that
		// hard-codes `\n` passes on a Linux runner and fails on the machine it was written on.
		const json = /```json\r?\n([\s\S]*?)```/.exec(section("example"));
		expect(json).not.toBeNull();
		const promised: unknown = JSON.parse(json![1]!);

		expect(c.api.listGeorefs()).toEqual(promised as never);
		// The PROSE above the JSON is pinned too, not just the JSON below it. This caught the
		// example's first draft, which called the fixture a 3-point spline when it has eight.
		expect(CLEAN).toHaveLength(8);
		expect(section("example")).toContain("8-point thin-plate spline");
	});
});

/**
 * README.md gets the same chain. Its place-note and georeference-note examples name frontmatter
 * keys, its model table names point counts, and its settings and command names are the ones the
 * plugin shows; each is pinned to the source that owns it.
 */
const README = await Bun.file(`${ROOT}/README.md`).text();

function readmeSection(name: string): string {
	const open = `<!-- geb:${name} -->`;
	const close = `<!-- /geb:${name} -->`;
	const from = README.indexOf(open);
	const to = README.indexOf(close);
	if (from < 0 || to < 0) throw new Error(`README.md is missing its ${name} section markers`);
	return README.slice(from + open.length, to);
}

/** The keys of a YAML block's lines at the given indent, in order. */
function yamlKeys(block: string, indent: string): string[] {
	const out: string[] = [];
	for (const line of block.split(/\r?\n/)) {
		const m = new RegExp(`^${indent}([A-Za-z-]+):`).exec(line);
		if (m !== null) out.push(m[1]!);
	}
	return out;
}

describe("README.md cannot drift from the plugin", () => {
	test("the place-note example names every coordinate and time key Geb reads, and no other", () => {
		expect(yamlKeys(readmeSection("readme-place-keys"), "").sort()).toEqual([...Object.values(FEATURE_KEY)].sort());
	});

	test("the georeference-note example names every key Geb writes, and no other", () => {
		expect(yamlKeys(readmeSection("readme-georef-keys"), "").sort()).toEqual([...Object.values(KEY)].sort());
	});

	test("the model table's point counts are the kernel's", () => {
		for (const m of MODELS) {
			const row = README.split(/\r?\n/).find((l) => l.startsWith(`| ${m.name} |`));
			expect(row, `a table row for ${m.name}`).toBeDefined();
			const cells = row!.split("|").map((c) => c.trim());
			expect(cells[2]).toBe(`${MIN_POINTS[m.kind]} points`);
			expect(cells[3]).toBe(String(RECOMMENDED_POINTS[m.kind]));
		}
	});

	test("the settings, commands and doors it names are the ones the plugin shows", () => {
		const s = COPY.settings;
		for (const name of [s.referenceFolder.name, s.coastline.name, s.showReference.name, s.defaultModel.name, s.newNoteFolder.name]) expect(README).toContain(`**${name}.**`);
		for (const name of [COPY.reference.download.command, COPY.doors.ribbon, COPY.doors.note, COPY.reference.button, COPY.report.button]) expect(README).toContain(`**${name}**`);
	});
});
