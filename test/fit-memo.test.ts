/**
 * The memo key's gate, WRITTEN BEFORE THE MEMO.
 *
 * A content-keyed memo has no invalidation problem by construction — the key IS the content, so a
 * hit cannot be stale. All the risk moves into one question: does the key cover everything the
 * cached computation reads? Get that wrong and the memo serves a confidently wrong answer, which
 * is worse than the 214 ms it saves.
 *
 * Two independent reviewers already got that question wrong on this exact object. Both produced
 * the key `{px, py, lat, lng, model, lambda, bounds}` — the fields `buildFit` reads — and both
 * missed `label`, because a label does not affect the fit. It affects `diagnostics`, which is a
 * memoised GETTER living inside the `Fit`, so a lazy member makes the cached object's input set
 * larger than the eager computation's, and the gap is invisible when you write the key by hand.
 *
 * So this test does not check a list of fields. It WALKS the fixture, finds every leaf, and
 * perturbs each one in turn — which means a field added to `StoredFit` next year is covered
 * without anyone remembering to extend anything.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { FitMemo, fitKey } from "../src/query/fit-memo";
import { hashBytes } from "../src/persist/identity";
import { toFrontmatter } from "../src/persist/serialize";
import { KEY, type Georeference, type StoredFit } from "../src/persist/types";
import { buildIndex } from "../src/query/store";
import { CLEAN, IMAGE } from "./fixtures";
import { FakeVault } from "./fake-vault";

const FIT: StoredFit = {
	bounds: null,
	transform: { model: "tps", lambda: 0.5 },
	points: CLEAN.map((p, i) => ({ px: p.px, py: p.py, lat: p.lat, lng: p.lng, ...(i === 0 ? { label: "Eboracum" } : {}) })),
};

/** Every path to a primitive (or null) leaf in the object, as arrays of keys. */
function leafPaths(v: unknown, at: (string | number)[] = []): (string | number)[][] {
	if (Array.isArray(v)) return v.flatMap((item, i) => leafPaths(item, [...at, i]));
	if (typeof v === "object" && v !== null) {
		return Object.entries(v).flatMap(([k, item]) => leafPaths(item, [...at, k]));
	}
	return [at];
}

function read(root: unknown, path: (string | number)[]): unknown {
	let cur: unknown = root;
	for (const step of path) cur = (cur as Record<string | number, unknown>)[step];
	return cur;
}

function withChange(root: unknown, path: (string | number)[], value: unknown): StoredFit {
	const copy = structuredClone(root) as Record<string | number, unknown>;
	let cur: Record<string | number, unknown> = copy;
	for (const step of path.slice(0, -1)) cur = cur[step] as Record<string | number, unknown>;
	const last = path[path.length - 1]!;
	if (value === undefined) delete cur[last];
	else cur[last] = value;
	return copy as unknown as StoredFit;
}

/** A different value of the same shape, so the key cannot pass by a type change alone. */
function perturb(v: unknown): unknown {
	if (typeof v === "number") return v + 1;
	if (typeof v === "string") return `${v}-moved`;
	if (typeof v === "boolean") return !v;
	// `bounds: null` is the interesting one: null to a real rectangle is a real change.
	return { x: 1, y: 2, width: 3, height: 4 };
}

describe("the memo key covers the whole record, not a hand-written field list", () => {
	const paths = leafPaths(FIT);

	test("the fixture really does have leaves worth walking", () => {
		// Guard against the walk silently finding nothing and every assertion below vacuously
		// passing. Eight points of four or five fields each, plus the transform and bounds.
		expect(paths.length).toBeGreaterThan(30);
		// And it reaches a label, which is the field both reviewers missed.
		expect(paths.some((p) => p.includes("label"))).toBe(true);
	});

	test("perturbing ANY leaf changes the key", () => {
		const base = fitKey(FIT, "earth");
		const unchanged: string[] = [];
		for (const path of paths) {
			const moved = withChange(FIT, path, perturb(read(FIT, path)));
			if (fitKey(moved, "earth") === base) unchanged.push(path.join("."));
		}
		expect(unchanged).toEqual([]);
	});

	test("ADDING an absent optional changes the key", () => {
		// A point with no label gaining one. The key must notice a field appearing, not only a
		// field changing — this is the renamed-control-point case that corrupts diagnostics.
		const base = fitKey(FIT, "earth");
		const labelled = withChange(FIT, ["points", 1, "label"], "Londinium");
		expect(fitKey(labelled, "earth")).not.toBe(base);
	});

	test("REMOVING a present optional changes the key", () => {
		const base = fitKey(FIT, "earth");
		const stripped = withChange(FIT, ["points", 0, "label"], undefined);
		expect(fitKey(stripped, "earth")).not.toBe(base);
	});

	test("the crs is part of the key, because inDomain reads it", () => {
		// Not a field of the fit at all — a SELECTOR over its points, applied when the record is
		// parsed. Leave it out and two records that differ only by coordinate system collide.
		expect(fitKey(FIT, "earth")).not.toBe(fitKey(FIT, "faerun"));
	});

	test("an explicit undefined keys the same as an absent key", () => {
		// `Object.entries` skips a key that was never set, so the undefined FILTER only matters for
		// a record that carries `label: undefined` explicitly — which the parser never builds, but
		// a hand-written record or a patch applied field by field can. The cast is the point: this
		// shape is unreachable through `fromFrontmatter` and reachable through `fitKey`, which is
		// exported. Without the filter these two key differently and the memo misses forever.
		const explicit = structuredClone(FIT) as unknown as { points: Record<string, unknown>[] };
		explicit.points[1] = { ...explicit.points[1]!, label: undefined };
		expect(fitKey(explicit as unknown as StoredFit, "earth")).toBe(fitKey(FIT, "earth"));
	});

	test("a non-finite number cannot collide with an absent value", () => {
		// `JSON.stringify(NaN)` is the string "null", so without the finite guard a NaN keys
		// identically to a real null — and `bounds: null` is the commonest value in the record.
		// Same reasoning as above: the parser's `finiteNumber` makes this unreachable from
		// frontmatter, and `fitKey` is public.
		const nan = structuredClone(FIT) as unknown as Record<string, unknown>;
		nan.bounds = Number.NaN;
		expect(fitKey(nan as unknown as StoredFit, "earth")).not.toBe(fitKey(FIT, "earth"));

		const infinite = structuredClone(FIT) as unknown as Record<string, unknown>;
		infinite.bounds = Number.POSITIVE_INFINITY;
		expect(fitKey(infinite as unknown as StoredFit, "earth")).not.toBe(fitKey(nan as unknown as StoredFit, "earth"));
	});

	test("the same record always keys the same", () => {
		expect(fitKey(FIT, "earth")).toBe(fitKey(structuredClone(FIT), "earth"));
	});

	test("the key is CANONICAL, not dependent on property insertion order", () => {
		// JSON.stringify follows insertion order, so a key built straight from it would differ for
		// two records that are identical in content. The parser happens to construct points in one
		// fixed order today, which would make such a key work BY ACCIDENT and break the day
		// anything constructs a record differently.
		const reordered: StoredFit = {
			points: FIT.points.map((p) => {
				const back: Record<string, unknown> = {};
				const src = p as unknown as Record<string, unknown>;
				for (const k of Object.keys(src).reverse()) back[k] = src[k];
				return back as unknown as StoredFit["points"][number];
			}),
			transform: { lambda: FIT.transform.lambda, model: FIT.transform.model } as StoredFit["transform"],
			bounds: FIT.bounds,
		};
		expect(fitKey(reordered, "earth")).toBe(fitKey(FIT, "earth"));
	});

	test("two records that differ never share a key, across a sweep of single changes", () => {
		const keys = new Map<string, string>();
		keys.set(fitKey(FIT, "earth"), "base");
		for (const path of paths) {
			const moved = withChange(FIT, path, perturb(read(FIT, path)));
			const key = fitKey(moved, "earth");
			const clash = keys.get(key);
			expect(clash, `${path.join(".")} collided with ${clash ?? ""}`).toBeUndefined();
			keys.set(key, path.join("."));
		}
	});
});

describe("the memo reuses a fit, and stops reusing it the moment anything changes", () => {
	const BYTES = new Uint8Array([1, 2, 3, 4]).buffer;
	let v: FakeVault;
	let memo: FitMemo;

	const record = (points: readonly StoredFit["points"][number][]): Georeference => ({
		id: "britain-5c",
		imageLink: "[[britain-5c.png]]",
		image: { width: IMAGE.width, height: IMAGE.height, byteLength: BYTES.byteLength, hash: hashBytes(BYTES) },
		crs: "earth",
		fits: [{ bounds: null, transform: { model: "tps" }, points: points.map((p) => ({ ...p })) }],
	});

	const stored = CLEAN.map((p) => ({ px: p.px, py: p.py, lat: p.lat, lng: p.lng, ...(p.label === undefined ? {} : { label: p.label }) }));

	beforeEach(() => {
		v = new FakeVault();
		memo = new FitMemo();
		v.addFile("britain-5c.png", BYTES);
		v.addNote("maps/britain-5c.md", toFrontmatter(record(stored)));
	});

	test("a second build of an unchanged vault returns the SAME fit object", () => {
		// Identity, not equality: equality would pass against a memo that re-solved every time.
		const first = buildIndex(v, memo).georefs[0]!.fit;
		const second = buildIndex(v, memo).georefs[0]!.fit;
		expect(second).toBe(first);
		expect(memo.misses).toBe(1);
		expect(memo.hits).toBe(1);
	});

	test("without a memo nothing is reused, and the index is identical either way", () => {
		// Dormant by construction: passing nothing must behave exactly as it did before the memo
		// existed, which is what makes this a safe addition rather than a new code path.
		const a = buildIndex(v).georefs[0]!.fit;
		const b = buildIndex(v).georefs[0]!.fit;
		expect(b).not.toBe(a);
		expect(buildIndex(v, new FitMemo()).georefs[0]!.record).toEqual(buildIndex(v).georefs[0]!.record);
	});

	test("moving one control point gives a new fit", () => {
		const first = buildIndex(v, memo).georefs[0]!.fit;
		const moved = [...stored];
		moved[0] = { ...moved[0]!, px: moved[0]!.px + 25 };
		v.notes.set("maps/britain-5c.md", toFrontmatter(record(moved)));

		const second = buildIndex(v, memo).georefs[0]!.fit;
		expect(second).not.toBe(first);
		expect(memo.misses).toBe(2);
	});

	test("RENAMING a control point gives a new fit, whose diagnostics say the new name", () => {
		// THE TEST THIS WHOLE KEY EXISTS FOR. A label does not affect the fit, so a key written
		// from "what buildFit reads" omits it — and two independent reviewers wrote exactly that
		// key. But `diagnostics` is a memoised getter INSIDE the Fit, and it attaches each point's
		// label to that point's residual, so a stale hit reports the OLD name after a rename.
		const before = buildIndex(v, memo).georefs[0]!.fit;
		expect(before.diagnostics.affine[0]!.label).toBe(stored[0]!.label);

		const renamed = [...stored];
		renamed[0] = { ...renamed[0]!, label: "Eboracum (Roman York)" };
		v.notes.set("maps/britain-5c.md", toFrontmatter(record(renamed)));

		const after = buildIndex(v, memo).georefs[0]!.fit;
		expect(after).not.toBe(before);
		expect(after.diagnostics.affine[0]!.label).toBe("Eboracum (Roman York)");
	});

	test("changing only the crs gives a new fit", () => {
		const first = buildIndex(v, memo).georefs[0]!.fit;
		const fm = v.notes.get("maps/britain-5c.md")!;
		fm[KEY.crs] = "erath";
		expect(buildIndex(v, memo).georefs[0]!.fit).not.toBe(first);
	});

	test("the memo stays bounded: a superseded fit is swept, not hoarded", () => {
		// A user dragging a point mints a key per drag. Unbounded, that leaks one dense solve
		// apiece — which for a 300-point spline is the most expensive object in the layer.
		buildIndex(v, memo);
		expect(memo.size).toBe(1);

		for (let i = 1; i <= 5; i++) {
			const moved = [...stored];
			moved[0] = { ...moved[0]!, px: moved[0]!.px + i };
			v.notes.set("maps/britain-5c.md", toFrontmatter(record(moved)));
			buildIndex(v, memo);
			expect(memo.size).toBe(1);
		}
		expect(memo.misses).toBe(6);
		expect(memo.hits).toBe(0);
	});

	test("two maps with the SAME control points share one solve", () => {
		// Keyed on content, not on identity or note path. Two maps fitted from the same points in
		// the same system are the same transform, and solving it twice would be waste. (The first
		// draft of this test asserted two entries while its own comment said one — the memo was
		// right and the assertion was wrong.)
		v.addFile("britain-detail.png", BYTES);
		v.addNote("maps/britain-detail.md", toFrontmatter({ ...record(stored), id: "britain-detail" }));

		const index = buildIndex(v, memo);
		expect(index.georefs).toHaveLength(2);
		expect(memo.size).toBe(1);
		expect(index.georefs[0]!.fit).toBe(index.georefs[1]!.fit);
	});

	test("two maps that DIFFER keep two entries, and editing one leaves the other reused", () => {
		const shifted = stored.map((p) => ({ ...p, px: p.px * 0.5, py: p.py * 0.5 }));
		v.addFile("britain-detail.png", BYTES);
		v.addNote("maps/britain-detail.md", toFrontmatter({ ...record(shifted), id: "britain-detail" }));

		const first = buildIndex(v, memo);
		expect(memo.size).toBe(2);
		const untouched = first.georefs.find((g) => g.record.id === "britain-detail")!.fit;

		// Edit only the other map.
		const moved = [...stored];
		moved[0] = { ...moved[0]!, px: moved[0]!.px + 25 };
		v.notes.set("maps/britain-5c.md", toFrontmatter(record(moved)));

		const second = buildIndex(v, memo);
		expect(second.georefs.find((g) => g.record.id === "britain-detail")!.fit).toBe(untouched);
		expect(memo.size).toBe(2);
		// One new solve for the edited map; the untouched one was a hit.
		expect(memo.misses).toBe(3);
		expect(memo.hits).toBe(1);
	});

	test("a degenerate fit is not cached, so repairing it is not blocked by a stale failure", () => {
		const collinear = [
			{ px: 0, py: 0, lat: 0, lng: 0 },
			{ px: 10, py: 10, lat: 1, lng: 1 },
			{ px: 20, py: 20, lat: 2, lng: 2 },
		];
		v.notes.set("maps/britain-5c.md", toFrontmatter({ ...record(collinear), fits: [{ bounds: null, transform: { model: "affine" }, points: collinear }] }));

		expect(buildIndex(v, memo).rejected[0]!.code).toBe("degenerate-fit");
		expect(memo.size).toBe(0);
		// And the repair takes effect immediately rather than meeting a cached throw.
		v.notes.set("maps/britain-5c.md", toFrontmatter(record(stored)));
		expect(buildIndex(v, memo).georefs).toHaveLength(1);
	});
});
