/**
 * Control-point geometry: the quantity the residual display cannot express.
 *
 * The values here are derived from the definition rather than pinned from a run, because the
 * definition is simple enough to compute by hand: for a cloud with no covariance, the ratio is
 * the ratio of the standard deviations, so a cloud ten times longer than it is wide measures 0.1.
 * That makes these tests an independent check on the implementation rather than a snapshot of it.
 */
import { describe, expect, test } from "bun:test";
import { buildFit, toPixel } from "../src/core/fit";
import { NEARLY_COLLINEAR_RATIO, principalAxisRatio, wrapsAntimeridian } from "../src/core/geometry";
import { diagnose } from "../src/core/residuals";
import type { ControlPoint } from "../src/core/types";

/** Control points at given world positions. The pixel side is irrelevant to this quantity. */
const at = (pairs: readonly (readonly [number, number])[]): ControlPoint[] =>
	pairs.map(([lng, lat], i) => ({ px: i, py: i, lat, lng }));

describe("principalAxisRatio describes the shape of the control-point cloud", () => {
	test("an isotropic cloud measures 1", () => {
		// A unit square: equal spread on both axes and no covariance.
		expect(principalAxisRatio(at([[0, 0], [1, 0], [1, 1], [0, 1]]))).toBeCloseTo(1, 12);
	});

	test("a cloud ten times longer than it is wide measures 0.1", () => {
		// Hand-derived: cxx = 100, cyy = 1, cxy = 0, so the ratio is sqrt(1/100).
		expect(principalAxisRatio(at([[-10, -1], [10, -1], [10, 1], [-10, 1]]))).toBeCloseTo(0.1, 12);
	});

	test("an axis-aligned line measures 0", () => {
		expect(principalAxisRatio(at([[0, 5], [1, 5], [2, 5], [3, 5]]))).toBe(0);
	});

	test("AND SO DOES A DIAGONAL ONE", () => {
		// The test that actually discriminates. An implementation that compared the per-axis
		// variances and skipped the covariance cross-term would report this 45-degree line as a
		// well-shaped cloud: its x-spread and y-spread are identical, so the naive ratio is 1.
		// Collinearity is a property of the cloud, not of the axes it happens to be measured on.
		expect(principalAxisRatio(at([[0, 0], [1, 1], [2, 2], [3, 3]]))).toBeCloseTo(0, 12);
		expect(principalAxisRatio(at([[0, 3], [1, 2], [2, 1], [3, 0]]))).toBeCloseTo(0, 12);
	});

	test("coincident points measure 0, and a single point measures 1", () => {
		expect(principalAxisRatio(at([[2, 2], [2, 2], [2, 2]]))).toBe(0);
		// Nothing to compare: reporting degeneracy here would be a warning about nothing.
		expect(principalAxisRatio(at([[2, 2]]))).toBe(1);
		expect(principalAxisRatio([])).toBe(1);
	});

	test("it is invariant under translation and uniform scale, which is why it travels", () => {
		// The documented property that makes one threshold work on a town plan and a continent —
		// and the reason the Hartley normalisation inside the fitters cannot perturb it.
		const base = at([[-4, -1], [4, -1], [4, 1], [-4, 1], [0, 0.5]]);
		const moved = base.map((p) => ({ ...p, lng: p.lng * 1000 + 77, lat: p.lat * 1000 - 12 }));
		const shrunk = base.map((p) => ({ ...p, lng: p.lng * 1e-5 + 120, lat: p.lat * 1e-5 - 33 }));
		expect(principalAxisRatio(moved)).toBeCloseTo(principalAxisRatio(base), 9);
		expect(principalAxisRatio(shrunk)).toBeCloseTo(principalAxisRatio(base), 9);
	});
});

describe("the residual display cannot see near-collinearity, which is why this exists", () => {
	const SIZE = { width: 2400, height: 3200 };
	const truth = (lat: number, lng: number): [number, number] => [(lng + 8) * 200, (60 - lat) * 300];

	/** Six pins along a 5-degree line with `perp` degrees of perpendicular spread, plus noise. */
	function line(perp: number): ControlPoint[] {
		let s = 20260;
		const r = (): number => {
			s = (s * 1664525 + 1013904223) % 4294967296;
			return s / 4294967296;
		};
		return Array.from({ length: 6 }, (_, i) => {
			const t = i / 5;
			const sign = i % 2 === 0 ? 1 : -1;
			const lat = 51 + 5 * t + sign * perp;
			const lng = -6 + 5 * t - sign * perp;
			const [x, y] = truth(lat, lng);
			return { px: x + (r() - 0.5) * 0.6, py: y + (r() - 0.5) * 0.6, lat, lng };
		});
	}

	test("the displayed RMS is identical for a sane cloud and a pathological one", () => {
		// THE MEASUREMENT THIS MODULE WAS BUILT FROM. Both configurations carry the same 0.3 px of
		// placement noise, and the affine RMS reports that noise floor in both cases — while the
		// real error at a probe off the line differs by orders of magnitude. The residual is not
		// merely imprecise here; it is constant with respect to the thing that changed.
		const sane = buildFit(line(1), { kind: "affine" }).diagnostics.affineRms;
		const bad = buildFit(line(0.003), { kind: "affine" }).diagnostics.affineRms;
		expect(bad).toBeCloseTo(sane, 2);
	});

	test("but the real error at a probe off the line is far worse", () => {
		const probe = (perp: number): number => {
			const fit = buildFit(line(perp), { kind: "affine" });
			const [tx, ty] = truth(53.9, -3.9);
			const got = toPixel(fit, 53.9, -3.9, SIZE);
			// `null` means the round-trip gate refused it, which is also not an accurate answer.
			return got === null ? Number.POSITIVE_INFINITY : Math.hypot(got.x - tx, got.y - ty);
		};
		// Measured at 21 seeds: about 0.08 px at 1 degree of spread against about 14.6 px at
		// 0.003. The assertion is on the RATIO, so it does not depend on this fixture's seed
		// giving any particular absolute value.
		expect(probe(0.003) / Math.max(probe(1), 1e-9)).toBeGreaterThan(10);
	});

	test("so the geometry is reported, and the threshold brackets the two cases", () => {
		expect(principalAxisRatio(line(1))).toBeGreaterThan(NEARLY_COLLINEAR_RATIO);
		expect(principalAxisRatio(line(0.003))).toBeLessThan(NEARLY_COLLINEAR_RATIO);
	});

	test("and the caveat reaches the caller, naming the ratio", () => {
		const bad = diagnose(line(0.003), { kind: "affine" });
		expect(bad.notes.some((n) => n.includes("nearly collinear"))).toBe(true);
		expect(bad.notes.some((n) => n.includes("axis ratio"))).toBe(true);
		const fine = diagnose(line(1), { kind: "affine" });
		expect(fine.notes.some((n) => n.includes("nearly collinear"))).toBe(false);
	});
});

/**
 * Antimeridian detection, and the false positives that are the real bug here.
 *
 * THIS BLOCK EXISTS BECAUSE ITS ABSENCE COST SOMETHING. The first version of
 * `wrapsAntimeridian` reasoned only about the longitude VALUES — drop the largest gap, and if the
 * remaining arc is under a hemisphere call it a wrap — and it was verified with a throwaway script
 * that was then deleted. A cross-model review found it flags an ordinary world map pinned at its
 * four corners, and one pinned at five real cities, both of which are exactly affine fits. The
 * reassuring case I had run used seven points lying on a line in lat/lng, so it could not be
 * fitted at all: my evidence was weaker than the conclusion I drew from it.
 *
 * So the positive case is one test and the NEGATIVE cases are six, which is the right ratio for a
 * recognition heuristic. A detector's false positives are its real defect, because a warning that
 * fires on good input gets switched off and then the true positive goes unseen too.
 */
describe("antimeridian detection reports a wrap without crying wolf", () => {
	/** An equirectangular world map: pixel x is linear in longitude over the whole range. */
	const worldMap = (rows: readonly (readonly [number, number])[]): ControlPoint[] =>
		rows.map(([lat, lng]) => ({ px: (lng + 180) * 10, py: (90 - lat) * 10, lat, lng }));

	/**
	 * A genuine wrap: a 16° region straddling 180°, whose PIXELS were laid out by the continuous
	 * longitude (170 to 186) while the stored longitudes use the usual [-180, 180] form.
	 */
	const wrapped: ControlPoint[] = (
		[[-12, 170], [-12, 178], [-12, -174], [-18, 172], [-18, -176], [-15, 180], [-14, 174], [-17, -178]] as const
	).map(([lat, lng]) => {
		const continuous = lng < 0 ? lng + 360 : lng;
		return { px: (continuous - 168) * 100, py: (-10 - lat) * 100, lat, lng };
	});

	test("a region straddling 180 degrees is reported", () => {
		// Measured: this fits at an affine RMS of 311 px as typed and 0.0 px unwrapped, with no
		// coordinate out of range and no error raised. Silent wrongness is the thing being fixed.
		expect(wrapsAntimeridian(wrapped)).toBe(true);
		expect(buildFit(wrapped, { kind: "affine" }).diagnostics.affineRms).toBeGreaterThan(100);
	});

	test("and unwrapping those same points really is the better reading", () => {
		// Proof the detector is answering the right question rather than coincidentally agreeing.
		const unwrapped = wrapped.map((p) => (p.lng < 0 ? { ...p, lng: p.lng + 360 } : p));
		expect(buildFit(unwrapped, { kind: "affine" }).diagnostics.affineRms).toBeLessThan(1e-6);
		expect(wrapsAntimeridian(unwrapped)).toBe(false);
	});

	test("a world map pinned at its FOUR CORNERS is not a wrap", () => {
		// The first input a world-map user tries, and the old heuristic flagged it. Both the -180
		// and +180 pins sort to the ends, leaving a 360-degree interior gap and an arc of zero.
		const corners = worldMap([[90, -180], [90, 180], [-90, 180], [-90, -180]]);
		expect(buildFit(corners, { kind: "affine" }).diagnostics.affineRms).toBeLessThan(1e-6);
		expect(wrapsAntimeridian(corners)).toBe(false);
	});

	test("a world map pinned at five real cities is not a wrap", () => {
		// New York, San Francisco, Tokyo, Beijing, Sydney. The largest gap is 190 degrees across
		// the Atlantic and Europe, which the old heuristic read as a wrap. The fit is exact.
		const cities = worldMap([[40.7, -74], [37.8, -122], [35.7, 139.7], [39.9, 116.4], [-33.9, 151.2]]);
		expect(buildFit(cities, { kind: "affine" }).diagnostics.affineRms).toBeLessThan(1e-6);
		expect(wrapsAntimeridian(cities)).toBe(false);
	});

	test("nor is a well-scattered world map, nor a sparse one with a hole in the middle", () => {
		const scattered = worldMap([
			[0, -170], [40, -100], [-30, -40], [60, 10], [-10, 70], [20, 130], [-50, 175], [35, -120],
		]);
		expect(wrapsAntimeridian(scattered)).toBe(false);
		// Two clusters either side of the prime meridian with nothing between them.
		expect(wrapsAntimeridian(worldMap([[0, -100], [10, 100], [20, -60], [30, 60]]))).toBe(false);
	});

	test("nor a genuinely wide map, nor an ordinary small one", () => {
		expect(wrapsAntimeridian(worldMap([[0, -100], [10, -50], [20, 0], [30, 40], [40, 90]]))).toBe(false);
		expect(wrapsAntimeridian(worldMap([[51.5, -0.1], [53.9, -1.1], [55.9, -3.2], [50.7, -3.5]]))).toBe(false);
	});

	test("and three points say nothing either way, because affine interpolates both readings", () => {
		// At three points the fit is exactly determined, so as-typed and unwrapped both give zero
		// residual and the comparison carries no information. Claiming a wrap from that would be
		// the three-point tautology again, one module along.
		expect(wrapsAntimeridian(worldMap([[0, -179], [10, 179], [20, 178]]))).toBe(false);
	});

	test("the caveat reaches the caller, and leads, because the fit is wrong not just imprecise", () => {
		const d = diagnose(wrapped, { kind: "affine" });
		expect(d.notes[0]).toContain("antimeridian");
		expect(diagnose(worldMap([[40.7, -74], [37.8, -122], [35.7, 139.7], [39.9, 116.4], [-33.9, 151.2]]), { kind: "affine" })
			.notes.some((n) => n.includes("antimeridian"))).toBe(false);
	});
});
