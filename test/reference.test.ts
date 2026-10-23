import { beforeEach, describe, expect, test } from "bun:test";
import { ApiController } from "../src/api/controller";
import type { GebAPI, LatLng, PixelResult, ReferenceLine, ReferenceSet } from "../src/api/types";
import { toFrontmatter } from "../src/persist/serialize";
import { exceedsReferenceCap, parseGeoJsonLines, REFERENCE_MAX_BYTES } from "../src/reference/geojson";
import { boxIntersects, cullToBox, decimate } from "../src/view/reference-lines";
import { MapShell, REFERENCE_MIN_PX } from "../src/view/shell";
import { insideImage } from "../src/view/viewport";
import { FakeVault } from "./fake-vault";
import { CLEAN, IMAGE } from "./fixtures";
import { BYTES, georef, ID, openShell, Recorder, seedVault, type ShellOptions } from "./shell-harness";

const SRC = "Geb/reference/x.geojson";

const feature = (geometry: unknown): string => JSON.stringify({ type: "Feature", properties: {}, geometry });
const collection = (...geometries: unknown[]): string =>
	JSON.stringify({ type: "FeatureCollection", features: geometries.map((geometry) => ({ type: "Feature", properties: {}, geometry })) });

describe("reference parser", () => {
	test("LineString, bare and in a Feature", () => {
		const g = { type: "LineString", coordinates: [[0, 50], [1, 51], [2, 52]] };
		for (const text of [JSON.stringify(g), feature(g), collection(g)]) {
			const out = parseGeoJsonLines(text, SRC);
			expect(out.problems).toEqual([]);
			expect(out.lines).toHaveLength(1);
			expect(out.lines[0]!.points).toEqual([{ lat: 50, lng: 0 }, { lat: 51, lng: 1 }, { lat: 52, lng: 2 }]);
		}
	});

	test("coordinates are [lng, lat]; extra elements are ignored", () => {
		const out = parseGeoJsonLines(JSON.stringify({ type: "LineString", coordinates: [[10, 20, 99], [11, 21, 99]] }), SRC);
		expect(out.lines[0]!.points[0]).toEqual({ lat: 20, lng: 10 });
	});

	test("MultiLineString gives one line per part", () => {
		const out = parseGeoJsonLines(
			JSON.stringify({ type: "MultiLineString", coordinates: [[[0, 0], [1, 1]], [[5, 5], [6, 6]]] }),
			SRC,
		);
		expect(out.lines).toHaveLength(2);
	});

	test("Polygon: each ring is a line, closed or not", () => {
		const closed = [[0, 0], [2, 0], [2, 2], [0, 0]];
		const open = [[0, 0], [2, 0], [2, 2]];
		const out = parseGeoJsonLines(JSON.stringify({ type: "Polygon", coordinates: [closed, open] }), SRC);
		expect(out.lines.map((l) => l.points.length)).toEqual([4, 3]);
		// The parser does not close an open ring or open a closed one.
		expect(out.lines[1]!.points[2]).toEqual({ lat: 2, lng: 2 });
	});

	test("MultiPolygon: every ring of every polygon", () => {
		const ring = [[0, 0], [1, 0], [1, 1], [0, 0]];
		const out = parseGeoJsonLines(JSON.stringify({ type: "MultiPolygon", coordinates: [[ring, ring], [ring]] }), SRC);
		expect(out.lines).toHaveLength(3);
	});

	test("GeometryCollection, nested, with a point that draws nothing", () => {
		const out = parseGeoJsonLines(
			feature({
				type: "GeometryCollection",
				geometries: [
					{ type: "LineString", coordinates: [[0, 0], [1, 1]] },
					{ type: "Point", coordinates: [3, 3] },
					{ type: "GeometryCollection", geometries: [{ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }] },
				],
			}),
			SRC,
		);
		expect(out.problems).toEqual([]);
		expect(out.lines).toHaveLength(2);
	});

	test("bbox is [south, west, north, east]", () => {
		const out = parseGeoJsonLines(JSON.stringify({ type: "LineString", coordinates: [[-3, 50], [2, 58], [-1, 52]] }), SRC);
		expect(out.lines[0]!.bbox).toEqual([50, -3, 58, 2]);
	});

	test("longitudes in 0..360 are wrapped into -180..180", () => {
		const out = parseGeoJsonLines(JSON.stringify({ type: "LineString", coordinates: [[190, 10], [200, 11]] }), SRC);
		expect(out.lines).toHaveLength(1);
		expect(out.lines[0]!.points.map((p) => p.lng)).toEqual([-170, -160]);
		expect(out.lines[0]!.bbox).toEqual([10, -170, 11, -160]);
	});

	test("a vertex exactly on 180 in a 0..360 file belongs to both runs, in either order", () => {
		const lngsOf = (coords: number[][]): number[][] =>
			parseGeoJsonLines(JSON.stringify({ type: "LineString", coordinates: coords }), SRC).lines.map((l) => l.points.map((p) => p.lng));
		expect(lngsOf([[170, 0], [180, 1], [190, 2]])).toEqual([[170, 180], [-180, -170]]);
		expect(lngsOf([[190, 0], [180, 1], [170, 2]])).toEqual([[-170, -180], [180, 170]]);
		// The mirrored vertex keeps its latitude.
		const out = parseGeoJsonLines(JSON.stringify({ type: "LineString", coordinates: [[170, 0], [180, 1], [190, 2]] }), SRC);
		expect(out.lines[1]!.points[0]).toEqual({ lat: 1, lng: -180 });
	});

	test("an antimeridian crossing breaks the line in two", () => {
		const out = parseGeoJsonLines(
			JSON.stringify({ type: "LineString", coordinates: [[170, 0], [179, 1], [-179, 2], [-170, 3]] }),
			SRC,
		);
		expect(out.problems).toEqual([]);
		expect(out.lines).toHaveLength(2);
		expect(out.lines[0]!.points.map((p) => p.lng)).toEqual([170, 179]);
		expect(out.lines[1]!.points.map((p) => p.lng)).toEqual([-179, -170]);
	});

	test("a 0..360 line across 180 is broken the same way", () => {
		const out = parseGeoJsonLines(JSON.stringify({ type: "LineString", coordinates: [[170, 0], [179, 1], [181, 2], [190, 3]] }), SRC);
		expect(out.lines).toHaveLength(2);
	});

	test("a bad coordinate drops that line only, naming the source and its index", () => {
		const out = parseGeoJsonLines(
			collection(
				{ type: "LineString", coordinates: [[0, 0], [1, 1]] },
				{ type: "LineString", coordinates: [[0, 95], [1, 1]] },
				{ type: "LineString", coordinates: [[0, 0], ["x", 1]] },
				{ type: "LineString", coordinates: [[400, 0], [1, 1]] },
				{ type: "LineString", coordinates: [[5, 5], [6, 6]] },
			),
			SRC,
		);
		expect(out.lines).toHaveLength(2);
		expect(out.problems).toHaveLength(3);
		expect(out.problems[0]).toContain(SRC);
		expect(out.problems[0]).toContain("line 1");
		expect(out.problems[1]).toContain("line 2");
		expect(out.problems[2]).toContain("line 3");
	});

	test("null coordinates (from NaN in JSON) drop the line", () => {
		const out = parseGeoJsonLines('{"type":"LineString","coordinates":[[0,0],[null,1]]}', SRC);
		expect(out.lines).toHaveLength(0);
		expect(out.problems).toHaveLength(1);
	});

	test("empty and one-point lines vanish silently", () => {
		const out = parseGeoJsonLines(
			collection(
				{ type: "LineString", coordinates: [] },
				{ type: "LineString", coordinates: [[1, 1]] },
				{ type: "LineString", coordinates: [[1, 1], [2, 2]] },
			),
			SRC,
		);
		expect(out.lines).toHaveLength(1);
		expect(out.problems).toEqual([]);
	});

	test("non-JSON and non-GeoJSON give no lines and one problem naming the source", () => {
		for (const text of ["", "not json {", "42", "null", '{"hello":"world"}', '{"type":"FeatureCollection"}', '{"type":"Banana","coordinates":[]}']) {
			const out = parseGeoJsonLines(text, SRC);
			expect(out.lines).toEqual([]);
			expect(out.problems).toHaveLength(1);
			expect(out.problems[0]).toContain(SRC);
		}
	});

	test("never throws on hostile shapes", () => {
		const shapes = [
			'{"type":"FeatureCollection","features":[null,1,{"geometry":5},{"geometry":{"type":"LineString","coordinates":"x"}}]}',
			'{"type":"Polygon","coordinates":[1,null,[[0,0],[1,1]]]}',
			'{"type":"MultiPolygon","coordinates":[null,[1],[[[0,0],[1,1]]]]}',
		];
		for (const text of shapes) expect(() => parseGeoJsonLines(text, SRC)).not.toThrow();
	});
});

describe("reference size cap", () => {
	test("refuses only files over the cap", () => {
		expect(REFERENCE_MAX_BYTES).toBe(64 * 1024 * 1024);
		expect(exceedsReferenceCap(REFERENCE_MAX_BYTES)).toBe(false);
		expect(exceedsReferenceCap(REFERENCE_MAX_BYTES + 1)).toBe(true);
		expect(exceedsReferenceCap(10 * 1024 * 1024)).toBe(false);
	});
});

// --- the shell's half: culling, decimation, and the overlay the shell plans ------------------

/** A reference line with its bbox computed here, as the parser would, independently of the code under test. */
function refLine(points: readonly LatLng[]): ReferenceLine {
	const lats = points.map((p) => p.lat);
	const lngs = points.map((p) => p.lng);
	return { bbox: [Math.min(...lats), Math.min(...lngs), Math.max(...lats), Math.max(...lngs)], points };
}

const setOf = (...lines: ReferenceLine[]): ReferenceSet => ({ lines, sources: ["test"], problems: [] });

/** `n + 1` evenly spaced vertices along a parallel. */
const parallel = (lat: number, from: number, to: number, n: number): LatLng[] =>
	Array.from({ length: n + 1 }, (_, i) => ({ lat, lng: from + ((to - from) * i) / n }));

describe("cullToBox", () => {
	const box = { south: -1, west: -1, north: 1, east: 1 };

	test("keeps a chord that crosses the box while both its ends lie outside it", () => {
		// A vertex test keeps nothing here: neither end is in the box. The segment crosses it.
		const line = refLine([{ lat: 0, lng: -10 }, { lat: 0, lng: 10 }]);
		expect(cullToBox(line, box)).toEqual([[{ lat: 0, lng: -10 }, { lat: 0, lng: 10 }]]);
	});

	test("pads each kept run with ONE vertex either side, and drops what lies beyond", () => {
		const lngs = [-40, -30, -20, -5, 5, 20, 30, 40];
		const line = refLine(lngs.map((lng) => ({ lat: 0, lng })));
		// Only the segment -5 -> 5 meets the box; its ends plus one neighbour each side survive.
		expect(cullToBox(line, box)).toEqual([[-20, -5, 5, 20].map((lng) => ({ lat: 0, lng }))]);
	});

	test("two separate passes through the box are two runs; a line that misses it is none", () => {
		const pass = [{ lat: 0, lng: -5 }, { lat: 0, lng: 5 }];
		const far = [10, 20, 30, 40, 50].map((lat) => ({ lat, lng: 5 }));
		const line = refLine([...pass, ...far, { lat: 0, lng: 5 }, { lat: 0, lng: -5 }]);
		expect(cullToBox(line, box)).toHaveLength(2);
		expect(cullToBox(refLine([{ lat: 10, lng: 10 }, { lat: 20, lng: 20 }]), box)).toEqual([]);
	});

	test("boxIntersects counts a shared edge as meeting", () => {
		expect(boxIntersects(box, { south: 1, west: 1, north: 2, east: 2 })).toBe(true);
		expect(boxIntersects(box, { south: 1.01, west: 0, north: 2, east: 0.5 })).toBe(false);
	});
});

describe("decimate", () => {
	test("drops vertices within minPx of the last KEPT one, and always keeps the last", () => {
		const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2.5, y: 0 }];
		expect(decimate(pts, 1.5)).toEqual([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2.5, y: 0 }]);
	});

	test("measures from the last kept vertex, so many short steps do not all vanish", () => {
		const pts = Array.from({ length: 11 }, (_, i) => ({ x: i, y: 0 }));
		expect(decimate(pts, 1.5).map((p) => p.x)).toEqual([0, 2, 4, 6, 8, 10]);
	});
});

describe("the reference overlay in the shell", () => {
	let v: FakeVault;
	let c: ApiController;
	let s: Recorder;

	beforeEach(() => {
		v = new FakeVault();
		seedVault(v);
		c = new ApiController(v, "0.0.1");
		s = new Recorder();
	});

	/** `c.api`, counting the query length of every batch mapping and refusing whatever `refuse` names. */
	function wrapped(refuse: (q: LatLng) => boolean = () => false): { api: GebAPI; calls: number[] } {
		const calls: number[] = [];
		const cut = (q: readonly LatLng[], out: readonly (PixelResult | null)[]): (PixelResult | null)[] =>
			out.map((p, i) => (refuse(q[i]!) ? null : p));
		const api = new Proxy(c.api, {
			get(t, k, r): unknown {
				if (k === "toPixels") {
					return (id: string, q: readonly LatLng[]) => (calls.push(q.length), cut(q, t.toPixels(id, q)));
				}
				if (k === "previewToPixels") {
					return (pts: Parameters<GebAPI["previewToPixels"]>[0], opts: Parameters<GebAPI["previewToPixels"]>[1], q: readonly LatLng[]) =>
						(calls.push(q.length), cut(q, t.previewToPixels(pts, opts, q)));
				}
				return Reflect.get(t, k, r) as unknown;
			},
		});
		return { api, calls };
	}

	// Two lines over the harness map, which pictures roughly lng -8..4, lat 49..60: one across
	// the middle at 100 px spacing, inside the region the spline answers for; one running far off
	// both sides, which the spline REFUSES west of 6°W (probed: the round-trip gate returns null
	// there at lat 52, though the pixel would be inside the image) and which leaves the image east
	// of 4°E.
	const ACROSS = refLine(parallel(54, -4, 3, 14));
	const WIDE = refLine(parallel(52, -40, 40, 80));

	function open(options: ShellOptions, refuse?: (q: LatLng) => boolean): { shell: MapShell; calls: number[] } {
		const w = wrapped(refuse);
		const shell = openShell(c, s, ID, options, w.api);
		return { shell, calls: w.calls };
	}

	test("runs lie inside the image only, at the pixels toPixel gives, and refusals cut them", () => {
		// One vertex of ACROSS is refused by the wrapper as well, to cut a run in its middle.
		const refused = { lat: 54, lng: -0.5 };
		const { calls } = open({ references: () => setOf(ACROSS, WIDE) }, (q) => q.lat === refused.lat && q.lng === refused.lng);
		const ref = s.last.reference;
		expect(calls).toHaveLength(1); // ONE batch for the whole set
		expect(s.last.referenceVisible).toBe(true);
		for (const run of ref) {
			expect(run.points.length).toBeGreaterThanOrEqual(2);
			for (const p of run.points) expect(insideImage(IMAGE, p)).toBe(true);
		}
		const px = (lat: number, lng: number): { x: number; y: number } => {
			const p = c.api.toPixel(ID, lat, lng)!;
			return { x: p.x, y: p.y };
		};
		// ACROSS: 15 vertices, the eighth refused, so two runs of seven, each vertex where toPixel puts it.
		expect(ref).toHaveLength(3);
		expect(ref.slice(0, 2).map((r) => r.points.length)).toEqual([7, 7]);
		const want = parallel(54, -4, 3, 14).filter((q) => q.lng !== refused.lng);
		expect(ref.slice(0, 2).flatMap((r) => r.points)).toEqual(want.map((q) => px(q.lat, q.lng)));
		// WIDE: refused by the transform west of 6°W, off the image east of 4°E. What is left is
		// one run from 6°W to 4°E, vertex for vertex.
		expect(c.api.toPixel(ID, 52, -7)).toBeNull();
		expect(ref[2]!.points).toEqual(parallel(52, -6, 4, 10).map((q) => px(q.lat, q.lng)));
	});

	test("the same array across hovers; a new one after reloadReference", () => {
		const { shell } = open({ references: () => setOf(ACROSS) });
		shell.hoverAt({ x: 400, y: 300 });
		shell.hoverAt({ x: 410, y: 310 });
		const [a, b] = s.frames.slice(-2);
		expect(a!.reference).toBe(b!.reference);
		expect(a!.reference.length).toBeGreaterThan(0);
		shell.reloadReference();
		expect(s.last.reference).not.toBe(b!.reference);
		expect(s.last.reference).toEqual(b!.reference);
	});

	test("a reload of the SET draws the new set", () => {
		let set = setOf(ACROSS);
		const { shell } = open({ references: () => set });
		expect(s.last.reference).toHaveLength(1);
		set = setOf();
		shell.reloadReference();
		expect(s.last.reference).toEqual([]);
	});

	test("off then on keeps the same array and maps nothing again; the flag rides in each frame", () => {
		const { shell, calls } = open({ references: () => setOf(ACROSS) });
		const before = s.last;
		shell.setReferenceVisible(false);
		const hidden = s.last;
		expect(hidden).not.toBe(before);
		expect(hidden.referenceVisible).toBe(false);
		expect(hidden.reference).toBe(before.reference);
		shell.setReferenceVisible(true);
		expect(s.last.referenceVisible).toBe(true);
		expect(s.last.reference).toBe(before.reference);
		expect(calls).toHaveLength(1);
	});

	test("a hidden overlay is not planned at all, and is planned on first show", () => {
		const { shell, calls } = open({ references: () => setOf(ACROSS), referenceVisible: false });
		expect(calls).toHaveLength(0);
		expect(s.last.reference).toEqual([]);
		expect(s.last.referenceVisible).toBe(false);
		shell.setReferenceVisible(true);
		expect(calls).toHaveLength(1);
		expect(s.last.reference.length).toBeGreaterThan(0);
	});

	test("the overlay follows the draft: begun unchanged it is kept, a point that changes the fit re-plans it", () => {
		const { shell, calls } = open({ references: () => setOf(ACROSS) });
		const saved = s.last.reference;
		shell.beginEdit();
		expect(s.last.reference).toBe(saved); // the same fit, by content
		shell.select(0);
		expect(s.last.reference).toBe(saved);
		expect(calls).toHaveLength(1);
		// A point a few pixels off where the fit puts it bends the spline: a different fit.
		const p = c.api.toPixel(ID, 53, -4)!;
		shell.placePoint({ px: p.x + 40, py: p.y - 30, lat: 53, lng: -4 });
		expect(calls).toHaveLength(2);
		const drafted = s.last.reference;
		expect(drafted).not.toBe(saved);
		expect(drafted).not.toEqual(saved);
		shell.hoverAt({ x: 300, y: 300 });
		expect(s.last.reference).toBe(drafted);
		shell.discardEdit();
		expect(s.last.reference).not.toBe(drafted);
		expect(s.last.reference).toEqual(saved);
	});

	test("a draft that moves the map's world region is culled where the map now is, not where it was", () => {
		// One line over Britain, one 20 degrees east of it. The saved fit's box holds only the
		// first; the draft below is the same map with every point's longitude moved 20 degrees
		// east, so through it the second line lands where the first did and the first leaves the image.
		const EAST = refLine(parallel(54, 16, 23, 14));
		const { shell } = open({ references: () => setOf(ACROSS, EAST) });
		const saved = s.last.reference;
		expect(saved).toHaveLength(1);
		shell.beginEdit();
		CLEAN.forEach((p, i) => shell.replacePoint(i, { ...p, lng: p.lng + 20 }));
		const moved = s.last.reference;
		expect(moved).toHaveLength(1);
		const want = parallel(54, -4, 3, 14).map((q) => c.api.toPixel(ID, q.lat, q.lng)!);
		expect(moved[0]!.points).toHaveLength(want.length);
		moved[0]!.points.forEach((p, i) => {
			expect(p.x).toBeCloseTo(want[i]!.x, 3);
			expect(p.y).toBeCloseTo(want[i]!.y, 3);
		});
	});

	test("a draft edit while hidden plans nothing until shown", () => {
		const { shell, calls } = open({ references: () => setOf(ACROSS) });
		shell.setReferenceVisible(false);
		shell.beginEdit();
		const p = c.api.toPixel(ID, 53, -4)!;
		shell.placePoint({ px: p.x + 40, py: p.y - 30, lat: 53, lng: -4 });
		expect(calls).toHaveLength(1);
		shell.setReferenceVisible(true);
		expect(calls).toHaveLength(2);
	});

	test("a 10,000-vertex worldwide line is culled to the map's box before anything is mapped", () => {
		// Measured when written: 196 vertices mapped of 10,000, 98 drawn in 3 runs. The line
		// wanders 44-64N, so a fair share of the crossing is inside the box and the floor of 50
		// proves the cull did not simply throw everything away.
		const n = 10_000;
		const world = Array.from({ length: n }, (_, i) => ({ lat: 54 + 10 * Math.sin(i / 37), lng: -180 + (360 * i) / (n - 1) }));
		const { calls } = open({ references: () => setOf(refLine(world)) });
		expect(calls).toHaveLength(1);
		expect(calls[0]!).toBeLessThan(2000);
		expect(calls[0]!).toBeGreaterThan(50);
		const drawn = s.last.reference.reduce((sum, r) => sum + r.points.length, 0);
		expect(drawn).toBeGreaterThan(0);
		expect(drawn).toBeLessThanOrEqual(calls[0]!);
	});

	test("vertices closer than REFERENCE_MIN_PX are decimated, and every run keeps its last vertex", () => {
		// 0.001 degrees of longitude is about 0.2 px on this map: most of these share a pixel.
		const dense = refLine(parallel(54, -2, -1, 1000));
		open({ references: () => setOf(dense) });
		const run = s.last.reference[0]!;
		expect(run.points.length).toBeLessThan(200);
		const last = c.api.toPixel(ID, 54, -1)!;
		expect(run.points[run.points.length - 1]).toEqual({ x: last.x, y: last.y });
		for (let i = 1; i < run.points.length - 1; i++) {
			const a = run.points[i - 1]!;
			const b = run.points[i]!;
			expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(REFERENCE_MIN_PX);
		}
	});

	test("a map on a CRS other than earth draws no reference and maps nothing", () => {
		v.addFile("mars.png", BYTES);
		v.addNote("maps/mars.md", toFrontmatter({ ...georef("mars"), crs: "mars" }));
		const w = wrapped();
		openShell(c, s, "mars", { references: () => setOf(ACROSS) }, w.api);
		expect(s.messages).toEqual([]);
		expect(s.last.reference).toEqual([]);
		expect(w.calls).toHaveLength(0);
	});

	test("a new map with no saved fit plans through the draft once it can be fitted", async () => {
		v.addFile("scans/new.png", BYTES);
		const w = wrapped();
		c.markReady();
		const shell = new MapShell(w.api, "new", s, {
			create: { imagePath: "scans/new.png", notePath: "maps/new.md" },
			references: () => setOf(ACROSS),
		});
		shell.open();
		await Bun.sleep(0);
		expect(s.last.reference).toEqual([]);
		for (const p of CLEAN.slice(0, 4)) shell.placePoint(p);
		expect(w.calls.length).toBeGreaterThan(0);
		expect(s.last.reference.length).toBeGreaterThan(0);
	});
});
