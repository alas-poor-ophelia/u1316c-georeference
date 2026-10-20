import { beforeEach, describe, expect, test } from "bun:test";
import type { TransformKind } from "../src/core/types";
import { hashBytes } from "../src/persist/identity";
import { toFrontmatter } from "../src/persist/serialize";
import type { Georeference } from "../src/persist/types";
import { featuresIn, georefsCovering } from "../src/query/coverage";
import { buildIndex } from "../src/query/store";
import type { ProblemCode } from "../src/query/types";
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
const codes = (): ProblemCode[] => buildIndex(v).problems.map((p) => p.code);

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
		expect(pins.map((p) => p.feature.notePath).sort()).toEqual(["places/Eboracum.md", "places/Londinium.md"]);
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
		expect(codes()).toContain("record-problem");
		expect(buildIndex(v).problems.some((p) => p.message.includes("not a known coordinate system"))).toBe(true);
	});

	test("a differently-cased crs is not silently accepted", () => {
		addPlace("places/Eboracum.md", { lat: YORK.lat, lng: YORK.lng, crs: "Earth" });
		const index = buildIndex(v);
		expect(index.features).toEqual([]);
		expect(index.problems.map((p) => p.code)).toContain("unknown-crs");
	});

	test("a note in one system is not pinned on a map in another", () => {
		addGeoref(georef("britain-5c"));
		addPlace("places/Waterdeep.md", { lat: YORK.lat, lng: YORK.lng, crs: "faerun" });
		expect(featuresIn(buildIndex(v), "britain-5c")).toEqual([]);
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
		expect(index.problems.map((p) => p.code)).toContain("coords-incomplete");
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
		expect(index.problems.map((p) => p.code)).toContain("coords-incomplete");
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
		expect(index.problems.map((p) => p.code)).toContain("coords-conflict");
	});

	test("certainty is matched case-insensitively", () => {
		// "Exact" is what a user types. Nothing exercised it, so a case-sensitive match passed.
		addPlace("places/Eboracum.md", { lat: YORK.lat, lng: YORK.lng, "geb-certainty": "Exact" });
		expect(buildIndex(v).features[0]!.certainty).toBe("exact");
	});

	test("an unrecognised certainty is reported", () => {
		addPlace("places/Eboracum.md", { lat: YORK.lat, lng: YORK.lng, "geb-certainty": "maybe" });
		expect(codes()).toContain("bad-certainty");
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
		expect(index.problems.map((p) => p.code)).toContain("coords-out-of-range");
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

	test("an unknown image size rejects the map, because coverage is what it pictures", () => {
		const g = georef("sizeless");
		v.addFile("sizeless.png", BYTES);
		v.addNote("maps/sizeless.md", toFrontmatter({ ...g, image: { ...g.image, width: 0, height: 0 } }));
		expect(buildIndex(v).rejected[0]!.code).toBe("unknown-image-size");
	});

	test("a duplicate id is rejected rather than loaded alongside the first", () => {
		// Obsidian's "Make a copy" produces this. Loading both left the second unreachable through
		// featuresIn while still appearing in georefsCovering under the same id.
		addGeoref(georef("britain-5c"));
		v.addNote("maps/Copy of britain-5c.md", toFrontmatter(georef("britain-5c")));
		const index = buildIndex(v);
		expect(index.georefs).toHaveLength(1);
		expect(index.rejected[0]!.code).toBe("duplicate-id");
		expect(index.problems.map((p) => p.code)).toContain("duplicate-id");
	});

	test("a lossy record still loads, but says it must not be saved", () => {
		const fm = toFrontmatter(georef("lossy-map"));
		(fm["geb-fits"] as { points: unknown[] }[])[0]!.points.push({ px: 1, py: 1, lat: 91, lng: 0 });
		v.addFile("lossy-map.png", BYTES);
		v.addNote("maps/lossy-map.md", fm);

		const index = buildIndex(v);
		expect(index.georefs).toHaveLength(1);
		expect(index.problems.map((p) => p.code)).toContain("lossy-record");
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
		expect(index.problems.map((p) => p.code)).toContain("extra-fits");
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
		expect(featuresIn(index, "nothing")).toEqual([]);
	});
});
