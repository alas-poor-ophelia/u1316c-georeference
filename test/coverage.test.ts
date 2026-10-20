import { beforeEach, describe, expect, test } from "bun:test";
import type { TransformKind } from "../src/core/types";
import { hashBytes } from "../src/persist/identity";
import { toFrontmatter } from "../src/persist/serialize";
import type { Georeference } from "../src/persist/types";
import { featuresIn, georefsCovering } from "../src/query/coverage";
import { readFeature } from "../src/query/features";
import { buildIndex } from "../src/query/store";
import type { Problem, ProblemCode, WorldIndex } from "../src/query/types";
import { CLEAN, IMAGE, truth } from "./fixtures";
import { FakeVault } from "./fake-vault";

const BYTES = new Uint8Array([1, 2, 3, 4]).buffer;
const YORK = { lat: 53.9591, lng: -1.0815 };
/** North of every control point: outside the hull, still pictured on the map. */
const ORKNEY = { lat: 59.0, lng: -3.0 };

let v: FakeVault;

function georef(id: string, scale = 1, kind: TransformKind = "tps", crs = "earth"): Georeference {
	return {
		id,
		imageLink: `[[${id}.png]]`,
		image: {
			width: Math.round(IMAGE.width * scale),
			height: Math.round(IMAGE.height * scale),
			byteLength: BYTES.byteLength,
			hash: hashBytes(BYTES),
		},
		crs,
		fits: [
			{
				bounds: null,
				transform: { model: kind },
				points: CLEAN.map((p) => ({
					px: p.px * scale,
					py: p.py * scale,
					lat: p.lat,
					lng: p.lng,
					...(p.label === undefined ? {} : { label: p.label }),
				})),
			},
		],
	};
}

function addGeoref(g: Georeference): void {
	v.addFile(`${g.id}.png`, BYTES);
	v.addNote(`maps/${g.id}.md`, toFrontmatter(g));
}

const addPlace = (path: string, fm: Record<string, unknown>): void => v.addNote(path, fm);
/**
 * The problem codes, SORTED and asserted as an exact set rather than by membership.
 *
 * `toContain(code)` was the single biggest weakness in this suite: it passes for any message
 * text, any number of problems, and either half of a coordinate pair, which is why a third of the
 * mutations an audit ran outside the author's own list stayed green. An exact set catches a
 * spurious EXTRA problem too, which is how over-reporting becomes visible.
 */
const problemCodes = (index: WorldIndex): ProblemCode[] => index.problems.map((p) => p.code).sort();
const codes = (): ProblemCode[] => problemCodes(buildIndex(v));

beforeEach(() => {
	v = new FakeVault();
});

describe("the payoff: one note on every map that covers it", () => {
	test("two maps of one region both place the same note", () => {
		addGeoref(georef("britain-5c"));
		addGeoref(georef("britain-detail", 0.5));
		addPlace("places/Eboracum.md", { lat: YORK.lat, lng: YORK.lng });

		const index = buildIndex(v);
		expect(index.rejected).toEqual([]);
		expect(index.features).toHaveLength(1);

		const covering = georefsCovering(index, YORK.lat, YORK.lng);
		expect(covering.map((c) => c.georefId).sort()).toEqual(["britain-5c", "britain-detail"]);
		expect(covering[0]!.x).not.toBeCloseTo(covering[1]!.x, 0);
	});

	test("and the pixel position matches where the ground truth put it", () => {
		addGeoref(georef("britain-5c"));
		const [c] = georefsCovering(buildIndex(v), YORK.lat, YORK.lng);
		const [tx, ty] = truth(YORK.lat, YORK.lng);
		// A spline interpolates its control points — but through a 23x23 solve and two
		// normalisations, so "exactly" means about 4e-3 of a pixel at a coordinate of 1354.
		expect(Math.hypot(c!.x - tx, c!.y - ty)).toBeLessThan(0.1);
	});

	test("featuresIn gives the same answer from the map's side", () => {
		addGeoref(georef("britain-5c"));
		addPlace("places/Eboracum.md", { lat: YORK.lat, lng: YORK.lng });
		addPlace("places/Londinium.md", { lat: 51.51, lng: -0.13 });
		addPlace("Daily/2026-10-19.md", { tags: ["journal"] });

		const pins = featuresIn(buildIndex(v), "britain-5c");
		expect(pins).not.toBeNull();
		expect(pins!.map((p) => p.feature.notePath).sort()).toEqual(["places/Eboracum.md", "places/Londinium.md"]);
		// The note path on the Coverage half, not just on the feature: swapping it for the georef
		// id passed every test in this file.
		expect(pins!.every((p) => p.notePath === "maps/britain-5c.md")).toBe(true);
		// And the pin's FEATURE carries the real coordinates. Asserting only the note path let a
		// mutation replace the whole feature with a doctored copy.
		const eboracum = pins!.find((p) => p.feature.notePath === "places/Eboracum.md");
		expect(eboracum!.feature.lat).toBeCloseTo(YORK.lat, 4);
		expect(eboracum!.feature.lng).toBeCloseTo(YORK.lng, 4);
	});

	test("a georeference note is not also pinned as a place", () => {
		// A sidecar carrying lat/lng would otherwise be pinned on itself and on every other map.
		const g = georef("britain-5c");
		v.addFile("britain-5c.png", BYTES);
		v.addNote("maps/britain-5c.md", { ...toFrontmatter(g), lat: YORK.lat, lng: YORK.lng });
		expect(buildIndex(v).features).toEqual([]);
	});
});

describe("validity and bounds are separate layers", () => {
	// Review deleted the validity gate from toPixel and every test here still passed, because the
	// only out-of-domain point in the suite was also out of frame — so `inBounds` rejected it
	// first and the gate was never reached. These tests are built so that cannot happen again.

	/** Raw forward transform, bypassing both gates, to prove which one is doing the rejecting. */
	function rawPixel(kind: TransformKind, lat: number, lng: number): { x: number; y: number } {
		addGeoref(georef(`probe-${kind}`, 1, kind));
		const g = buildIndex(v).georefs[0]!;
		const out = new Float64Array(2);
		g.fit.forward.apply(new Float64Array([lat, lng]), out);
		return { x: out[0]!, y: out[1]! };
	}

	test("a folded polynomial is refused at a point that IS inside the frame", () => {
		// lat 58, lng -8 is the case that matters: the fold maps it to a pixel well within the
		// image, so bounds has no objection and only the round-trip gate can catch it. If the
		// gate is removed or its tolerance loosened, this test fails — which is the whole point.
		const raw = rawPixel("polynomial2", 58, -8);
		expect(raw.x).toBeGreaterThanOrEqual(0);
		expect(raw.x).toBeLessThanOrEqual(IMAGE.width);
		expect(raw.y).toBeGreaterThanOrEqual(0);
		expect(raw.y).toBeLessThanOrEqual(IMAGE.height);

		expect(georefsCovering(buildIndex(v), 58, -8)).toEqual([]);
	});

	test("while an affine fit, which cannot fold, covers that same point", () => {
		// The control: the coordinate itself is fine. It is the polynomial's behaviour there that
		// is not, so the two models must disagree about it.
		addGeoref(georef("britain-affine", 1, "affine"));
		expect(georefsCovering(buildIndex(v), 58, -8)).toHaveLength(1);
	});

	test("bounds, not validity, rejects a coordinate off the edge of the picture", () => {
		const raw = rawPixel("affine", 20, 20);
		const outside = raw.x < 0 || raw.y < 0 || raw.x > IMAGE.width || raw.y > IMAGE.height;
		expect(outside).toBe(true);
		expect(georefsCovering(buildIndex(v), 20, 20)).toEqual([]);
	});
});

describe("the hull marking", () => {
	test("a point outside the control-point hull resolves and is marked extrapolated", () => {
		addGeoref(georef("britain-5c"));
		const [c] = georefsCovering(buildIndex(v), ORKNEY.lat, ORKNEY.lng);
		expect(c).toBeDefined();
		expect(c!.extrapolated).toBe(true);
	});

	test("an interior point is not marked", () => {
		addGeoref(georef("britain-5c"));
		expect(georefsCovering(buildIndex(v), YORK.lat, YORK.lng)[0]!.extrapolated).toBe(false);
	});

	test("a point exactly on a hull vertex counts as inside", () => {
		// Membership is inclusive of the boundary. Nothing used to exercise that, so a strict
		// comparison would have passed the whole suite.
		addGeoref(georef("britain-5c"));
		const index = buildIndex(v);
		const vertex = index.georefs[0]!.fit.hull[0]!;
		expect(georefsCovering(index, vertex.lat, vertex.lng)[0]!.extrapolated).toBe(false);
	});

	test("a point exactly on a hull edge counts as inside", () => {
		addGeoref(georef("britain-5c"));
		const index = buildIndex(v);
		const hull = index.georefs[0]!.fit.hull;
		const a = hull[0]!;
		const b = hull[1]!;
		const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
		expect(georefsCovering(index, mid.lat, mid.lng)[0]!.extrapolated).toBe(false);
	});
});

describe("coordinate reference systems keep worlds apart", () => {
	test("an Earth coordinate does not land on a map of another world", () => {
		addGeoref(georef("faerun", 1, "tps", "faerun"));
		expect(georefsCovering(buildIndex(v), YORK.lat, YORK.lng, "earth")).toEqual([]);
		expect(georefsCovering(buildIndex(v), YORK.lat, YORK.lng, "faerun")).toHaveLength(1);
	});

	test("a map in an UNKNOWN system says so rather than covering nothing in silence", () => {
		// geb-crs: "erath" used to load with an empty problems list and then match no query at
		// all — the exact "my map didn't appear and nothing told me why" case.
		addGeoref(georef("typo-crs", 1, "tps", "erath"));
		expect(codes()).toEqual(["record-problem"]);
		expect(buildIndex(v).problems.some((p) => p.message.includes("not a known coordinate system"))).toBe(true);
	});

	test("a differently-cased crs is not silently accepted", () => {
		addPlace("places/Eboracum.md", { lat: YORK.lat, lng: YORK.lng, crs: "Earth" });
		const index = buildIndex(v);
		expect(index.features).toEqual([]);
		expect(problemCodes(index)).toEqual(["unknown-crs"]);
	});

	test("a note in one system is not pinned on a map in another", () => {
		// THIS TEST WAS VACUOUS, and in exactly the family this file already knows about. Its note
		// used `crs: "faerun"`; the registry holds only `earth`, so `readFeature` refused the note
		// as unknown-crs and the index held ZERO features. The filter the test is named for had
		// nothing to filter, and deleting that filter outright left all 154 tests green.
		//
		// A second world is not reachable through a place note yet. What IS reachable is a map
		// whose crs is misspelled: it loads, reported, and its crs really does differ from every
		// feature's.
		addGeoref(georef("britain-5c", 1, "tps", "erath"));
		addPlace("places/Eboracum.md", { lat: YORK.lat, lng: YORK.lng });

		const index = buildIndex(v);
		// Every cheaper guard would have passed this input: the map loaded, and so did the note.
		expect(index.georefs).toHaveLength(1);
		expect(index.features).toHaveLength(1);
		expect(featuresIn(index, "britain-5c")).toEqual([]);
	});

	test("...and that same note IS pinned once the map's crs is spelled correctly", () => {
		// The control for the test above. Without it, "not pinned" could be true for any reason —
		// a coordinate off the edge, a broken fixture — and the crs filter would still be untested.
		addGeoref(georef("britain-5c"));
		addPlace("places/Eboracum.md", { lat: YORK.lat, lng: YORK.lng });
		expect(featuresIn(buildIndex(v), "britain-5c")).toHaveLength(1);
	});
});

describe("reading coordinates broadly, but never wrongly", () => {
	const accepted: ReadonlyArray<[string, Record<string, unknown>]> = [
		["lat and lng", { lat: 53.9591, lng: -1.0815 }],
		["lat and long", { lat: 53.9591, long: -1.0815 }],
		["latitude and longitude", { latitude: 53.9591, longitude: -1.0815 }],
		["a location array", { location: [53.9591, -1.0815] }],
		["a location string with a decimal point", { location: "53.9591, -1.0815" }],
		["quoted plain decimals", { lat: "53.9591", lng: "-1.0815" }],
		["a signed integer pair", { lat: "54", lng: "-1" }],
	];

	for (const [label, fm] of accepted) {
		test(`${label} is accepted`, () => {
			addGeoref(georef("britain-5c"));
			addPlace("places/Eboracum.md", fm);
			expect(featuresIn(buildIndex(v), "britain-5c")).toHaveLength(1);
		});
	}

	test("the numeric coercion takes plain decimals and nothing else", () => {
		// Number() accepted "0x10" as 16, "0b11" as 3 and "1e1" as 10. None of those is a
		// coordinate, and nothing pinned the rule, so swapping in parseFloat also passed.
		for (const bad of ["0x10", "0b11", "1e1", "0o17", " ", "51.5.5", "--1"]) {
			addPlace(`places/${encodeURIComponent(bad)}.md`, { lat: bad, lng: "-1" });
		}
		expect(buildIndex(v).features).toEqual([]);
	});

	test("a decimal comma is refused, not read as two coordinates", () => {
		// `location: "51,5"` means 51.5 to much of Europe. Reading it as lat 51, lng 5 is a
		// plausible pin in the wrong country reported as a success, and it cannot be
		// disambiguated — so it is refused and the fix is explained.
		addPlace("places/Ambiguous.md", { location: "51,5" });
		const index = buildIndex(v);
		expect(index.features).toEqual([]);
		const p = index.problems.find((x) => x.code === "coords-ambiguous");
		expect(p).toBeDefined();
		expect(p!.message).toContain("location: [51, 5]");
	});

	test("a three-value location is refused by the length rule specifically", () => {
		// The old prose test passed with the length guard deleted, because "York, England" failed
		// the number test anyway. This one can only pass if the length rule exists.
		addPlace("places/Three.md", { location: "51.5, -0.1, 42" });
		const index = buildIndex(v);
		expect(index.features).toEqual([]);
		expect(problemCodes(index)).toEqual(["coords-incomplete"]);
	});

	test("prose is still not mistaken for coordinates", () => {
		addPlace("places/Eboracum.md", { location: "York, England" });
		expect(buildIndex(v).features).toEqual([]);
	});

	test("half a pair is reported, not quietly ignored", () => {
		// `lat` with no readable `lng` used to make the note simply "not a place", which is
		// indistinguishable from a journal entry and unanswerable when the user asks why.
		addPlace("places/Half.md", { lat: 53.9591 });
		const index = buildIndex(v);
		expect(index.features).toEqual([]);
		expect(problemCodes(index)).toEqual(["coords-incomplete"]);
	});

	test("Geb's own keys win over location, and the disagreement is reported", () => {
		// The old version of this passed only because location [0,0] happened to be off the map.
		// Both coordinates here are inside the picture, so precedence is what decides it.
		addGeoref(georef("britain-5c"));
		addPlace("places/Eboracum.md", { lat: YORK.lat, lng: YORK.lng, location: [51.51, -0.13] });
		const index = buildIndex(v);
		const [f] = index.features;
		expect(f!.lat).toBeCloseTo(YORK.lat, 4);
		expect(f!.source).toBe("lat-lng");
		expect(problemCodes(index)).toEqual(["coords-conflict"]);
	});

	test("certainty is matched case-insensitively", () => {
		// "Exact" is what a user types. Nothing exercised it, so a case-sensitive match passed.
		addPlace("places/Eboracum.md", { lat: YORK.lat, lng: YORK.lng, "geb-certainty": "Exact" });
		expect(buildIndex(v).features[0]!.certainty).toBe("exact");
	});

	test("an unrecognised certainty is reported", () => {
		addPlace("places/Eboracum.md", { lat: YORK.lat, lng: YORK.lng, "geb-certainty": "maybe" });
		expect(codes()).toEqual(["bad-certainty"]);
	});

	test("a note with no coordinates is simply not a place, and not a problem", () => {
		addPlace("Daily/2026-10-19.md", { tags: ["journal"] });
		const index = buildIndex(v);
		expect(index.features).toEqual([]);
		expect(index.problems).toEqual([]);
	});

	test("out-of-range coordinates are refused and reported", () => {
		addPlace("places/Nowhere.md", { lat: 91, lng: 0 });
		const index = buildIndex(v);
		expect(index.features).toEqual([]);
		expect(problemCodes(index)).toEqual(["coords-out-of-range"]);
	});

	test("Null Island is a real place, not a falsy one", () => {
		addPlace("places/Zero.md", { lat: 0, lng: 0 });
		expect(buildIndex(v).features).toHaveLength(1);
	});

	test("the optional fields come through, and dates stay raw", () => {
		addPlace("places/Eboracum.md", {
			lat: YORK.lat,
			lng: YORK.lng,
			"geb-uncertainty": 5000,
			"geb-certainty": "disputed",
			"geb-from": 71,
			"geb-to": 866,
		});
		const [f] = buildIndex(v).features;
		expect(f!.uncertainty).toBe(5000);
		expect(f!.certainty).toBe("disputed");
		expect(f!.from).toBe("71");
		expect(f!.to).toBe("866");
	});
});

describe("a map that cannot be used is reported, never dropped in silence", () => {
	test("degenerate control points reject that map and leave the others working", () => {
		addGeoref(georef("good"));
		const bad = georef("collinear");
		v.addFile("collinear.png", BYTES);
		v.addNote("maps/collinear.md", toFrontmatter({
			...bad,
			fits: [{
				bounds: null,
				transform: { model: "affine" },
				points: [
					{ px: 10, py: 10, lat: 50, lng: 0 },
					{ px: 20, py: 20, lat: 51, lng: 1 },
					{ px: 30, py: 30, lat: 52, lng: 2 },
				],
			}],
		}));

		const index = buildIndex(v);
		expect(index.georefs.map((g) => g.record.id)).toEqual(["good"]);
		expect(index.rejected).toHaveLength(1);
		expect(index.rejected[0]!.code).toBe("degenerate-fit");
		expect(index.rejected[0]!.id).toBe("collinear");
	});

	// The old fixture set width AND height to 0, so a mutation that checked only one of them — or
	// swapped the `&&` for an `||` — agreed with it on that input. Half-known sizes discriminate.
	for (const [label, size] of [
		["neither dimension known", { width: 0, height: 0 }],
		["only the width missing", { width: 0, height: 1200 }],
		["only the height missing", { width: 1800, height: 0 }],
	] as const) {
		test(`an unknown image size rejects the map (${label}), because coverage is what it pictures`, () => {
			const g = georef("sizeless");
			v.addFile("sizeless.png", BYTES);
			v.addNote("maps/sizeless.md", toFrontmatter({ ...g, image: { ...g.image, ...size } }));
			expect(buildIndex(v).rejected[0]!.code).toBe("unknown-image-size");
		});
	}

	test("an empty fits list is rejected by the PARSER, before the store's backstop", () => {
		// Where the invariant actually lives. `store.ts`'s `no-fits` branch is a defensive
		// backstop that cannot currently be reached, because this rejection happens first — so
		// the code to pin is the parser's, and `unparsable` is the honest expected value.
		const fm = toFrontmatter(georef("empty"));
		fm["geb-fits"] = [];
		v.addFile("empty.png", BYTES);
		v.addNote("maps/empty.md", fm);
		expect(buildIndex(v).rejected[0]!.code).toBe("unparsable");
	});

	test("a duplicate id is rejected rather than loaded alongside the first", () => {
		// Obsidian's "Make a copy" produces this. Loading both left the second unreachable through
		// featuresIn while still appearing in georefsCovering under the same id.
		addGeoref(georef("britain-5c"));
		v.addNote("maps/Copy of britain-5c.md", toFrontmatter(georef("britain-5c")));
		const index = buildIndex(v);
		expect(index.georefs).toHaveLength(1);
		expect(index.rejected[0]!.code).toBe("duplicate-id");
		expect(problemCodes(index)).toEqual(["duplicate-id"]);
	});

	test("a lossy record still loads, but says it must not be saved", () => {
		const fm = toFrontmatter(georef("lossy-map"));
		(fm["geb-fits"] as { points: unknown[] }[])[0]!.points.push({ px: 1, py: 1, lat: 91, lng: 0 });
		v.addFile("lossy-map.png", BYTES);
		v.addNote("maps/lossy-map.md", fm);

		const index = buildIndex(v);
		expect(index.georefs).toHaveLength(1);
		expect(problemCodes(index)).toEqual(["lossy-record"]);
	});

	test("extra fits are ignored with a note, and the FIRST is the one used", () => {
		// The old test duplicated one fit twice, so swapping first for last passed. These two
		// differ, so only using the first can satisfy it.
		const g = georef("inset-map");
		const second = {
			...g.fits[0]!,
			points: g.fits[0]!.points.map((p) => ({ ...p, px: p.px + 500 })),
		};
		v.addFile("inset-map.png", BYTES);
		v.addNote("maps/inset-map.md", toFrontmatter({ ...g, fits: [g.fits[0]!, second] }));

		const index = buildIndex(v);
		expect(problemCodes(index)).toEqual(["extra-fits"]);
		const [c] = georefsCovering(index, YORK.lat, YORK.lng);
		const [tx] = truth(YORK.lat, YORK.lng);
		expect(c!.x).toBeCloseTo(tx, 1);
		expect(c!.x).not.toBeCloseTo(tx + 500, 1);
	});
});

describe("empty vaults", () => {
	test("no georeferences and no features is an empty index, not a throw", () => {
		const index = buildIndex(v);
		expect(index).toEqual({ georefs: [], features: [], rejected: [], problems: [] });
		expect(georefsCovering(index, YORK.lat, YORK.lng)).toEqual([]);
		// NULL, not an empty list: "no such loaded map" must not look like "a map with no pins".
		expect(featuresIn(index, "nothing")).toBeNull();
	});
});

describe("a note that CLAIMS to be a georeference is parsed, so its mistakes are reported", () => {
	test("geb-id: 1066 is rejected and reported, not excluded in silence", () => {
		// The selection predicate used to read `typeof geb-id === "string"`, in four places, so a
		// YAML number was never listed as a georeference, never parsed, and produced no rejection
		// and no problem. The report for a non-string id already existed — it was unreachable.
		const fm = toFrontmatter(georef("1066"));
		fm["geb-id"] = 1066;
		v.addFile("1066.png", BYTES);
		v.addNote("maps/1066.md", fm);

		const index = buildIndex(v);
		expect(index.georefs).toEqual([]);
		expect(index.rejected).toHaveLength(1);
		expect(index.rejected[0]!.code).toBe("unparsable");
		expect(index.rejected[0]!.reason).toContain("geb-id");
	});

	test("a note with fits but no id is a broken map, not a place to pin", () => {
		// It used to fall through to the place-note scan and be pinned on itself.
		const fm = toFrontmatter(georef("orphan"));
		delete fm["geb-id"];
		fm["lat"] = YORK.lat;
		fm["lng"] = YORK.lng;
		v.addFile("orphan.png", BYTES);
		v.addNote("maps/orphan.md", fm);

		const index = buildIndex(v);
		expect(index.features).toEqual([]);
		expect(index.rejected.map((r) => r.code)).toEqual(["unparsable"]);
	});

	for (const [label, blank] of [
		["geb-id", { "geb-id": null }],
		["geb-fits", { "geb-fits": null }],
	] as const) {
		test(`a place note with a bare ${label}: key is still a place`, () => {
			// A bare `geb-id:` is YAML null, and a template that left the key blank has claimed
			// nothing. Counting it made this note vanish from `features` — and because
			// `handleRename` gates on the same predicate and never parses the record, it also got
			// this note's frontmatter rewritten on an unrelated vault rename.
			addGeoref(georef("britain-5c"));
			addPlace("places/Eboracum.md", { lat: YORK.lat, lng: YORK.lng, ...blank });

			const index = buildIndex(v);
			expect(index.features.map((f) => f.notePath)).toEqual(["places/Eboracum.md"]);
			expect(index.rejected).toEqual([]);
		});
	}

	test("a HALF-FILLED template is reported, not excluded for having no id", () => {
		// The narrowing that stopped a blank key counting as a claim re-created the original defect
		// in miniature: a note with `geb-id:` and `geb-fits:` left blank but the image already
		// written was excluded again, with nothing reported anywhere. Every georeference key is a
		// claim, not just those two.
		v.addFile("map.png", BYTES);
		v.addNote("maps/Half.md", {
			"geb-id": null,
			"geb-fits": null,
			"geb-image": "[[map.png]]",
			"geb-image-size": [1800, 1200],
		});

		const index = buildIndex(v);
		expect(index.rejected.map((r) => r.code)).toEqual(["unparsable"]);
		expect(index.rejected[0]!.reason).toContain("geb-id");
	});

	test("a blank geb-crs is reported rather than defaulting to earth in silence", () => {
		const fm = toFrontmatter(georef("blank-crs"));
		fm["geb-crs"] = "";
		v.addFile("blank-crs.png", BYTES);
		v.addNote("maps/blank-crs.md", fm);
		expect(problemCodes(buildIndex(v))).toEqual(["record-problem"]);
	});

	test("a clean vault reports NOTHING, which is what makes over-reporting visible", () => {
		// Without this, every spurious problem is invisible to the suite: no other test asserts
		// that the problem list is empty.
		addGeoref(georef("britain-5c"));
		addPlace("places/Eboracum.md", { lat: YORK.lat, lng: YORK.lng });
		addPlace("Daily/2026-10-19.md", { tags: ["journal"] });

		const index = buildIndex(v);
		expect(index.problems).toEqual([]);
		expect(index.rejected).toEqual([]);
	});
});

describe("the decimal comma, including the signs that used to slip past it", () => {
	for (const text of ["51,5", "-0,1", "+51,5", "-33,8"]) {
		test(`location "${text}" is refused as ambiguous`, () => {
			// `/^\d+$/` on both halves let every SIGNED form through. "-0,1" is London's longitude
			// written the European way, read as lat -0 lng 1 — a pin in the Gulf of Guinea,
			// reported as a success.
			addPlace("places/Ambiguous.md", { location: text });
			const index = buildIndex(v);
			expect(index.features).toEqual([]);
			expect(problemCodes(index)).toEqual(["coords-ambiguous"]);
		});
	}

	for (const [text, lat, lng] of [["51,5.5", 51, 5.5] as const]) {
		test(`location "${text}" is NOT ambiguous, because it cannot be one number`, () => {
			addPlace("places/Fine.md", { location: text });
			const [f] = buildIndex(v).features;
			expect(f!.lat).toBe(lat);
			expect(f!.lng).toBe(lng);
		});
	}

	test("a trailing comma is incomplete, not ambiguous", () => {
		addPlace("places/Trailing.md", { location: "51," });
		const index = buildIndex(v);
		expect(index.features).toEqual([]);
		expect(index.problems.map((p) => p.code)).toEqual(["coords-incomplete"]);
	});

	test("an explicit list is never ambiguous — it is the documented escape hatch", () => {
		addPlace("places/List.md", { location: [51, 5] });
		const [f] = buildIndex(v).features;
		expect(f!.lat).toBe(51);
		expect(f!.lng).toBe(5);
	});

	for (const [text, lat, lng] of [
		["45, 90", 45, 90],
		["0, 0", 0, 0],
	] as const) {
		test(`location "${text}" has a space, so it is two coordinates beyond doubt`, () => {
			// A European decimal comma never has a space after it — the digits close up against
			// it. Trimming the halves before the shape test threw that evidence away, so integer
			// coordinates written longhand, Null Island among them, were refused as ambiguous.
			addPlace("places/Spaced.md", { location: text });
			const index = buildIndex(v);
			expect(index.problems).toEqual([]);
			const [f] = index.features;
			expect(f!.lat).toBe(lat);
			expect(f!.lng).toBe(lng);
		});
	}
});

describe("a losing coordinate form is never discarded unseen", () => {
	const won = { lat: 53.9591, lng: -1.0815 };

	for (const [label, extra] of [
		["a location that tried and failed", { location: "51.5, abc" }],
		["an ambiguous location", { location: "51,5" }],
		["a broken long-form pair", { latitude: "abc", longitude: 5 }],
		["half a long-form pair", { latitude: 7 }],
	] as const) {
		test(`${label} is reported even though lat/lng won`, () => {
			// `peek` read the losing forms for comparison and threw their problems away, so the
			// user's typed value went in the bin unmentioned — the same silent discard the
			// rescued-longitude rule exists to prevent.
			addPlace("places/Losing.md", { ...won, ...extra });
			const index = buildIndex(v);
			expect(index.features[0]!.lat).toBeCloseTo(won.lat, 4);
			expect(index.problems.length).toBeGreaterThan(0);
		});
	}

	test("but prose in a losing location stays silent, exactly as it would if it won", () => {
		addPlace("places/LosingProse.md", { ...won, location: "York, England" });
		const index = buildIndex(v);
		expect(index.features).toHaveLength(1);
		expect(index.problems).toEqual([]);
	});
});

describe("reported or ignored, decided by whether it TRIED to be a coordinate", () => {
	for (const value of [
		"51.5, abc",
		"51.5° N, 0.1° W",
		// These were SILENT under the first-character test, which is the mirror of the regression
		// above: a labelled coordinate that leads with its hemisphere letter had no numeric first
		// character, so a real attempt vanished while an address was reported.
		"N 51.5, W 0.1",
		"51.5, -0.1, 42",
		// A unicode minus, which is how a coordinate copied out of Wikipedia arrives. Recognised
		// as an attempt and reported; deliberately NOT parsed, because stripping the character
		// would turn a southern latitude into a northern one.
		"−33.9, −70.6",
		// A street number leading a comma'd address. A KNOWN LIMIT, pinned rather than papered
		// over: this is structurally identical to "51.5, abc" — first half a bare number, second
		// half unreadable — and no rule separates them without knowing what a street is.
		"5, Rue de Rivoli",
	] as const) {
		test(`location "${value}" tried and failed, so it is reported`, () => {
			addPlace("places/Tried.md", { location: value });
			const index = buildIndex(v);
			expect(index.features).toEqual([]);
			expect(problemCodes(index)).toEqual(["coords-incomplete"]);
		});
	}

	for (const [label, value] of [
		["two-part prose", "York, England"],
		["three-part prose", "York, North Yorkshire, England"],
		// Every one of these begins with a digit, sign or dot. A first-character test for "did it
		// try to be a coordinate" reported all of them — addresses and dates are the commonest
		// non-coordinate `location` text there is, so that test manufactured the exact noise it
		// was meant to remove, and no fixture caught it because they all start with a letter.
		["a house number", "221B Baker Street"],
		["a street address", "10 Downing Street, London"],
		["an ISO date", "2026-10-19"],
		["a bare dash", "-"],
		["relative directions", "3 miles north, 2 east"],
		// A CITY AND A POSTAL CODE, and its family. These were silent before this review and
		// reported after the first repair, because asking whether ANY part tried to be a number
		// is satisfied by a postcode, a year or a quarter sitting in the SECOND half. A coordinate
		// pair leads with its latitude, so only the first half may decide.
		["a city and a postal code", "Paris, 75001"],
		["a US city and ZIP", "Boston, 02108"],
		["a written date", "Jan 5, 2026"],
		["a quarter and a year", "Q3, 2026"],
		["a place and a house number", "Dover, 5"],
		["a chapter reference", "Chapter 3, 4"],
		// A lone token is a postcode, a year or a phone number far more often than it is half a
		// coordinate, and a pair needs a separator. All of these were reported as "needs exactly
		// two values, got 1", which is a misleading thing to say about a ZIP code.
		["a bare ZIP code", "90210"],
		["a bare year", "1066"],
		["a single coordinate with no pair", "51.5"],
		["a phone number", "555 1234"],
		["a spaced date", "19 10 2026"],
		["a thousands-separated number", "10 000"],
		["a name list", ["York", "England"]],
		["an unquoted wikilink", [["York"]]],
		["a bare number", 5],
		["an empty string", ""],
	] as const) {
		test(`${label} was never a coordinate, so it is silent`, () => {
			// Three-part prose used to raise coords-incomplete while two-part prose did not: the
			// same kind of input, two different answers, and a problem list the user learns to
			// ignore. `location: 5` also used to depend on an unpinned typeof guard to not throw.
			addPlace("places/Prose.md", { location: value });
			const index = buildIndex(v);
			expect(index.features).toEqual([]);
			expect(index.problems).toEqual([]);
		});
	}

	for (const [label, value] of [
		["too few", [1]],
		["too many", [1, 2, 3]],
	] as const) {
		test(`a list with ${label} values is refused by the length rule`, () => {
			addPlace("places/Len.md", { location: value });
			const index = buildIndex(v);
			expect(index.features).toEqual([]);
			expect(problemCodes(index)).toEqual(["coords-incomplete"]);
		});
	}

	test("a template's blank lat and lng is not a broken place", () => {
		// `lat: ""` counted as present and reported, while a bare `lat:` (null) did not. Same
		// input to a user, two different answers.
		addPlace("places/Template.md", { lat: "", lng: "" });
		const index = buildIndex(v);
		expect(index.features).toEqual([]);
		expect(index.problems).toEqual([]);
	});

	test("a lone lng, with no lat at all, is still half a pair", () => {
		addPlace("places/HalfB.md", { lng: -1.0815 });
		expect(codes()).toEqual(["coords-incomplete"]);
	});

	test("a note with no frontmatter, or frontmatter that is not a mapping, is simply not a place", () => {
		const problems: Problem[] = [];
		expect(readFeature("Daily/x.md", null, problems)).toBeNull();
		expect(readFeature("Daily/x.md", ["not", "a", "mapping"], problems)).toBeNull();
		expect(readFeature("Daily/x.md", "a string", problems)).toBeNull();
		expect(problems).toEqual([]);
	});

	test("a leading-dot decimal and a padded decimal both read", () => {
		// The regex's leading-dot branch and the trim in `num` were only ever exercised as
		// REJECTIONS, so deleting either of them kept the suite green.
		addPlace("places/Dot.md", { lat: ".5", lng: " -1.25 " });
		const [f] = buildIndex(v).features;
		expect(f!.lat).toBe(0.5);
		expect(f!.lng).toBe(-1.25);
	});
});

describe("when two spellings disagree, the loser is named", () => {
	test("lat/lng wins over latitude/longitude, and the disagreement is reported", () => {
		// The canonical pair used to win in SILENCE against every form except `location`,
		// discarding a value the user had typed with no way to learn it had been discarded.
		addPlace("places/Both.md", { lat: 53.9591, lng: -1.0815, latitude: 51.51, longitude: -0.13 });
		const index = buildIndex(v);
		expect(index.features[0]!.lat).toBeCloseTo(53.9591, 4);
		expect(problemCodes(index)).toEqual(["coords-conflict"]);
	});

	test("lng wins over long, and the disagreement is reported", () => {
		addPlace("places/Long.md", { lat: 53.9591, lng: -1.0815, long: 99 });
		const index = buildIndex(v);
		expect(index.features[0]!.lng).toBeCloseTo(-1.0815, 4);
		expect(problemCodes(index)).toEqual(["coords-conflict"]);
	});

	test("a broken lng rescued by long still reports the broken one", () => {
		// `{lng: "abc", long: 5}` resolved to 5 with no sign that `lng` was unreadable.
		addPlace("places/Rescued.md", { lat: 53.9591, lng: "abc", long: -1.0815 });
		const index = buildIndex(v);
		expect(index.features[0]!.lng).toBeCloseTo(-1.0815, 4);
		expect(problemCodes(index)).toEqual(["coords-incomplete"]);
	});

	test("an incomplete canonical pair does NOT fall through to a valid location", () => {
		// The rule this file's own docstring claims, which nothing pinned: a note with `lat` and a
		// stray `location` used to pin at the location, ignoring the user's own latitude.
		addPlace("places/Fallthrough.md", { lat: 53.9591, location: [51.51, -0.13] });
		const index = buildIndex(v);
		expect(index.features).toEqual([]);
		expect(problemCodes(index)).toEqual(["coords-incomplete"]);
	});

	for (const [source, fm] of [
		["lat-lng", { lat: 53.9591, lng: -1.0815 }],
		["latitude-longitude", { latitude: 53.9591, longitude: -1.0815 }],
		["location", { location: [53.9591, -1.0815] }],
	] as const) {
		test(`the source label says ${source}`, () => {
			// Only the lat-lng label was ever asserted, so mislabelling the other two passed.
			addPlace("places/Source.md", fm);
			expect(buildIndex(v).features[0]!.source).toBe(source);
		});
	}
});

describe("the optional fields, which nothing used to check", () => {
	const place = (extra: Record<string, unknown>): Record<string, unknown> => ({ lat: YORK.lat, lng: YORK.lng, ...extra });

	test("an uncertainty in exponent notation is a distance, not a coordinate", () => {
		// `geb-uncertainty: 1e3` is a thousand metres. It was parsed with the COORDINATE parser,
		// whose ban on exponents exists because a latitude is never written `1e1`.
		addPlace("places/Exp.md", place({ "geb-uncertainty": "1e3" }));
		expect(buildIndex(v).features[0]!.uncertainty).toBe(1000);
	});

	test("zero uncertainty is a real value, not a falsy one", () => {
		addPlace("places/Zero.md", place({ "geb-uncertainty": 0 }));
		const index = buildIndex(v);
		expect(index.features[0]!.uncertainty).toBe(0);
		expect(index.problems).toEqual([]);
	});

	for (const [label, value] of [
		["negative", -5],
		["non-numeric", "wide"],
		["infinite", Number.POSITIVE_INFINITY],
	] as const) {
		test(`a ${label} uncertainty is reported and ignored`, () => {
			// Six separate mutations to this rule survived, because no test had ever supplied
			// anything but 5000 — `bad-uncertainty` was asserted nowhere in the suite.
			addPlace("places/Bad.md", place({ "geb-uncertainty": value }));
			const index = buildIndex(v);
			expect(index.features[0]!.uncertainty).toBeUndefined();
			expect(problemCodes(index)).toEqual(["bad-uncertainty"]);
		});
	}

	test("an absent uncertainty is not a problem", () => {
		addPlace("places/None.md", place({}));
		expect(codes()).toEqual([]);
	});

	test("a padded certainty is trimmed before matching", () => {
		addPlace("places/Pad.md", place({ "geb-certainty": "  Exact  " }));
		const index = buildIndex(v);
		expect(index.features[0]!.certainty).toBe("exact");
		expect(index.problems).toEqual([]);
	});

	test("a certainty that is not text is reported", () => {
		addPlace("places/NumCert.md", place({ "geb-certainty": 5 }));
		expect(codes()).toEqual(["bad-certainty"]);
	});

	test("a crs that is not text is reported, then treated as earth", () => {
		// It defaulted to earth in silence, while the georeference side reported the same mistake.
		addPlace("places/NumCrs.md", place({ crs: 5 }));
		const index = buildIndex(v);
		expect(index.features[0]!.crs).toBe("earth");
		expect(index.problems.map((p) => p.code)).toEqual(["unknown-crs"]);
	});

	test("a crs padded with spaces still names its system", () => {
		// `crs: "earth "` was DROPPED: `present` counted it, and the id was compared to "" without
		// trimming, so a trailing space failed the registry lookup and cost the user their pin.
		addPlace("places/Padded.md", place({ crs: "earth " }));
		const index = buildIndex(v);
		expect(index.features[0]!.crs).toBe("earth");
		expect(index.problems).toEqual([]);
	});

	for (const [label, blanks] of [
		["an empty crs", { crs: "" }],
		["a whitespace-only crs", { crs: "   " }],
		["a bare crs key", { crs: null }],
		["an empty certainty", { "geb-certainty": "" }],
		["a bare certainty key", { "geb-certainty": null }],
		["an empty uncertainty", { "geb-uncertainty": "" }],
	] as const) {
		test(`${label} is a blank key, not a mistake`, () => {
			// `geb-certainty: ""` was reported while `geb-certainty:` and a blank
			// `geb-uncertainty` were silent, because the string branch ran ahead of the `present`
			// gate — one blank value, three different answers across three fields.
			addPlace("places/Blank.md", place(blanks));
			const index = buildIndex(v);
			expect(index.features).toHaveLength(1);
			expect(index.problems).toEqual([]);
		});
	}

	test("blank and padded date text is normalised, not carried", () => {
		addPlace("places/Dates.md", place({ "geb-from": "  450  ", "geb-to": "   ", "geb-calendar": "  julian " }));
		const [f] = buildIndex(v).features;
		expect(f!.from).toBe("450");
		expect(f!.to).toBeUndefined();
		expect(f!.calendar).toBe("julian");
	});

	test("a date field that is neither text nor a number is reported, not dropped", () => {
		// It vanished in silence while a non-text certainty and a bad uncertainty both said so.
		addPlace("places/BadDate.md", place({ "geb-from": [1066] }));
		const index = buildIndex(v);
		expect(index.features[0]!.from).toBeUndefined();
		expect(problemCodes(index)).toEqual(["bad-text"]);
	});

	for (const [label, value, expected] of [
		["a signed distance", "+500", 500],
		["an uppercase exponent", "1E3", 1000],
		["a padded distance", "  500  ", 500],
		["a leading-dot distance", ".5", 0.5],
		// A SIGNED exponent. Without this the sign group inside the exponent can be deleted and
		// every other distance test still agrees.
		["a negative exponent", "1e-3", 0.001],
	] as const) {
		test(`${label} reads as ${expected}`, () => {
			addPlace("places/Dist.md", place({ "geb-uncertainty": value }));
			const index = buildIndex(v);
			expect(index.features[0]!.uncertainty).toBe(expected);
			expect(index.problems).toEqual([]);
		});
	}

	for (const [label, value] of [
		["an overflowing exponent", "1e999"],
		["hexadecimal", "0x10"],
		["a trailing dot", "5."],
	] as const) {
		test(`${label} is refused as a distance`, () => {
			// `1e999` is the one that matters: the regex passes it and `Number()` returns Infinity,
			// so only the finiteness check stops it becoming an infinite radius of uncertainty.
			addPlace("places/BadDist.md", place({ "geb-uncertainty": value }));
			const index = buildIndex(v);
			expect(index.features[0]!.uncertainty).toBeUndefined();
			expect(problemCodes(index)).toEqual(["bad-uncertainty"]);
		});
	}

	test("a signed coordinate reads, since the sign branch was only ever tested as a rejection", () => {
		addPlace("places/Signed.md", { lat: "+53.9591", lng: "-1.0815" });
		const [f] = buildIndex(v).features;
		expect(f!.lat).toBe(53.9591);
		expect(f!.lng).toBe(-1.0815);
	});
});

describe("the recogniser's internals, letter by letter", () => {
	// Eight separate deletions from the hemisphere character class all survived an audit, because
	// every fixture supplied TWO decorated halves and the partner masked the removed letter. Now
	// only the FIRST half decides, so each letter needs its own case.
	for (const letter of ["N", "S", "E", "W", "n", "s", "e", "w"] as const) {
		test(`a trailing ${letter} on the first half still marks an attempt`, () => {
			addPlace("places/Hemi.md", { location: `51.5 ${letter}, abc` });
			expect(codes()).toEqual(["coords-incomplete"]);
		});
	}

	test("but a compass letter INSIDE a value is not stripped, so 1e1 is not a coordinate", () => {
		// Dropping the `^` or `$` anchor from the hemisphere pattern strips letters anywhere, and
		// "1e1" would then read as "11" and count as an attempt.
		addPlace("places/Exp.md", { location: "1e1, abc" });
		const index = buildIndex(v);
		expect(index.features).toEqual([]);
		expect(index.problems).toEqual([]);
	});

	test("the ambiguity shape is tested on TRIMMED text", () => {
		// Run on the raw string, " 51,5 " would miss the pattern and read as lat 51, lng 5 — the
		// exact trap the rule exists to stop.
		addPlace("places/Padded.md", { location: " 51,5 " });
		const index = buildIndex(v);
		expect(index.features).toEqual([]);
		expect(problemCodes(index)).toEqual(["coords-ambiguous"]);
	});
});

describe("what the store passes through to the kernel", () => {
	test("a fit's bounds reaches buildFit, so restricting it changes the answer", () => {
		// Every georef fixture used `bounds: null`, so the store could stop forwarding bounds
		// altogether and the whole suite stayed green. Same for lambda below.
		addGeoref(georef("whole"));
		const unrestricted = georefsCovering(buildIndex(v), YORK.lat, YORK.lng);
		expect(unrestricted).toHaveLength(1);

		v = new FakeVault();
		const g = georef("whole");
		const bounded = {
			...g,
			fits: [{ ...g.fits[0]!, bounds: { x: 0, y: 0, width: Math.round(IMAGE.width / 3), height: Math.round(IMAGE.height / 3) } }],
		};
		v.addFile("whole.png", BYTES);
		v.addNote("maps/whole.md", toFrontmatter(bounded));
		const restricted = georefsCovering(buildIndex(v), YORK.lat, YORK.lng);

		expect(restricted).not.toEqual(unrestricted);
	});

	test("a fit's lambda reaches buildFit, so smoothing changes the pixel", () => {
		addGeoref(georef("sharp"));
		const [sharp] = georefsCovering(buildIndex(v), ORKNEY.lat, ORKNEY.lng);

		v = new FakeVault();
		const g = georef("smooth");
		const smoothed = { ...g, fits: [{ ...g.fits[0]!, transform: { model: "tps" as const, lambda: 1000 } }] };
		v.addFile("smooth.png", BYTES);
		v.addNote("maps/smooth.md", toFrontmatter(smoothed));
		const [smooth] = georefsCovering(buildIndex(v), ORKNEY.lat, ORKNEY.lng);

		expect(smooth).toBeDefined();
		expect(smooth!.x).not.toBeCloseTo(sharp!.x, 1);
	});

	for (const [label, bad] of [
		["a negative px", { px: -1, py: 10 }],
		["a negative py", { px: 10, py: -1 }],
	] as const) {
		test(`${label} alone makes the record lossy`, () => {
			// The guard is `px < 0 || py < 0`, and every fixture made BOTH negative, so dropping
			// either half of the test agreed with all of them.
			const g = georef("halfneg");
			const fm = toFrontmatter({
				...g,
				fits: [{ ...g.fits[0]!, points: g.fits[0]!.points.map((p, i) => (i === 0 ? { ...p, ...bad } : p)) }],
			});
			v.addFile("halfneg.png", BYTES);
			v.addNote("maps/halfneg.md", fm);
			expect(problemCodes(buildIndex(v))).toEqual(["lossy-record"]);
		});
	}

	test("a control point ON the image corner is not lossy — zero is a position", () => {
		// The lossy guard is `px < 0`, and every fixture used a clearly negative or clearly
		// positive value, so narrowing it to `<= 0` and rejecting the corner went unnoticed.
		const g = georef("corner");
		const atCorner = {
			...g,
			fits: [{ ...g.fits[0]!, points: g.fits[0]!.points.map((p, i) => (i === 0 ? { ...p, px: 0, py: 0 } : p)) }],
		};
		v.addFile("corner.png", BYTES);
		v.addNote("maps/corner.md", toFrontmatter(atCorner));

		const index = buildIndex(v);
		expect(index.rejected).toEqual([]);
		expect(index.problems).toEqual([]);
	});

	test("a record with no image link is unparsable, not a usable map", () => {
		const fm = toFrontmatter(georef("linkless"));
		delete fm["geb-image"];
		v.addFile("linkless.png", BYTES);
		v.addNote("maps/linkless.md", fm);
		expect(buildIndex(v).rejected.map((r) => r.code)).toEqual(["unparsable"]);
	});

	test("a blank geb-crs parses to earth, not to the empty string", () => {
		// The existing test asserted only that SOME problem appeared, so a mutation making the
		// record's crs `""` — a map that matches no query — passed. Assert the parsed VALUE.
		const fm = toFrontmatter(georef("blank"));
		fm["geb-crs"] = "";
		v.addFile("blank.png", BYTES);
		v.addNote("maps/blank.md", fm);
		addPlace("places/Eboracum.md", { lat: YORK.lat, lng: YORK.lng });

		const index = buildIndex(v);
		expect(index.georefs[0]!.record.crs).toBe("earth");
		expect(featuresIn(index, "blank")).toHaveLength(1);
	});

	test("a third copy of an id is blamed on the FIRST claimant, not the second", () => {
		// With two copies, storing the wrong note path or letting the duplicate overwrite the
		// first claimant is invisible. Three copies discriminate.
		addGeoref(georef("britain-5c"));
		v.addNote("maps/Copy of britain-5c.md", toFrontmatter(georef("britain-5c")));
		v.addNote("maps/Copy 2 of britain-5c.md", toFrontmatter(georef("britain-5c")));

		const index = buildIndex(v);
		expect(index.georefs).toHaveLength(1);
		expect(index.rejected).toHaveLength(2);
		for (const r of index.rejected) expect(r.reason).toContain("maps/britain-5c.md");
	});
});

describe("a losing form differing in only ONE half", () => {
	// Every conflict fixture differed in both lat and lng, so narrowing the test from "lat OR lng
	// differs" to "both differ", or comparing only one half, agreed with all of them.
	for (const [label, extra] of [
		["only the latitude", { latitude: 51.51, longitude: -1.0815 }],
		["only the longitude", { latitude: 53.9591, longitude: -0.13 }],
	] as const) {
		test(`a long-form pair differing in ${label} is still a conflict`, () => {
			addPlace("places/Half.md", { lat: 53.9591, lng: -1.0815, ...extra });
			expect(codes()).toEqual(["coords-conflict"]);
		});
	}

	test("a long-form pair that AGREES is not a conflict", () => {
		// The control. Without it, a `peek` that swapped lat for lng would raise a false conflict
		// on an agreeing pair and nothing would notice.
		addPlace("places/Agree.md", { lat: 53.9591, lng: -1.0815, latitude: 53.9591, longitude: -1.0815 });
		expect(codes()).toEqual([]);
	});

	test("a lone longitude in a losing form is reported", () => {
		// The mirror of the lat-only case, which was the only half ever tested.
		addPlace("places/LoneLng.md", { lat: 53.9591, lng: -1.0815, longitude: 7 });
		expect(codes()).toEqual(["coords-incomplete"]);
	});
});
