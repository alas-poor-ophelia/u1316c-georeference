/**
 * The tolerances that have to mean the same thing at every scale.
 *
 * Geb is used on a 500 px sketch of a village and on an 8,000 px scan of a continent, and the
 * review that produced this file found the same defect class twice: a tolerance written as an
 * absolute number, compared against a quantity that grows with the coordinates. `linalg.ts` had
 * already been fixed this way (its pivot threshold is relative to the matrix magnitude); `hull.ts`
 * had not, and nothing in the suite would have noticed — the mutation gate proved it by replacing
 * the hull epsilon with a value a billion times larger and watching every test still pass.
 *
 * Every test here is therefore a COMPARISON BETWEEN TWO SCALES rather than an absolute assertion.
 * That is the only shape that can catch this class, because an absolute assertion at one scale is
 * exactly what the bug looks like when it is right.
 */
import { describe, expect, test } from "bun:test";
import { buildFit, extent, toPixel } from "../src/core/fit";
import { convexHull, inHull } from "../src/core/hull";
import { medianOf } from "../src/core/residuals";
import { CLEAN, IMAGE, truth } from "./fixtures";
import type { ControlPoint } from "../src/core/types";
import { ticks } from "../src/view/graticule";

describe("the hull boundary tolerance is a distance, so it travels between scales", () => {
	/** A square hull of side `s` centred on the origin, counter-clockwise. */
	const square = (s: number): { x: number; y: number }[] =>
		convexHull([
			{ x: -s / 2, y: -s / 2 },
			{ x: s / 2, y: -s / 2 },
			{ x: s / 2, y: s / 2 },
			{ x: -s / 2, y: s / 2 },
		]);

	test("a point well outside is outside at every scale", () => {
		// The pathological case: a BUILDING PLAN, which crs.ts explicitly contemplates. 0.0001
		// degrees is about 11 m. Under the old absolute epsilon a point 1.1 m outside this hull —
		// ten per cent of its own edge — was reported as interpolated. One tenth of the edge is
		// the same relative position at every scale, so a correct test gives the same answer.
		for (const s of [60, 1, 0.001, 0.0001]) {
			const outside = { x: s / 2 + s / 10, y: 0 };
			expect(inHull(square(s), outside)).toBe(false);
		}
	});

	test("a point well inside is inside at every scale", () => {
		for (const s of [60, 1, 0.001, 0.0001]) {
			expect(inHull(square(s), { x: 0, y: 0 })).toBe(true);
			expect(inHull(square(s), { x: s / 2 - s / 10, y: 0 })).toBe(true);
		}
	});

	test("the boundary itself counts as inside at every scale", () => {
		// Fuzziness is labelled, not laundered — but a point ON the hull is interpolated, and
		// reporting a corner as extrapolated would mark a legitimate pin fuzzy for no reason.
		for (const s of [60, 1, 0.001, 0.0001]) {
			expect(inHull(square(s), { x: s / 2, y: 0 })).toBe(true);
			expect(inHull(square(s), { x: s / 2, y: s / 2 })).toBe(true);
		}
	});

	test("and a degenerate hull edge cannot swallow the whole plane", () => {
		// Two identical vertices define no half-plane. Dividing by that edge length would be a
		// division by zero, and declaring everything outside would be the wrong answer.
		const withDuplicate = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 2 }];
		expect(inHull(withDuplicate, { x: 1, y: 0.5 })).toBe(true);
	});
});

describe("a fit is as accurate on a thumbnail as on a wall map", () => {
	/** `n` points on a circle of radius `r` degrees about (`lat0`, `lng0`), mapped linearly. */
	function ring(n: number, r: number, lat0: number, lng0: number, pxPerDeg: number): ControlPoint[] {
		return Array.from({ length: n }, (_, i) => {
			const a = (2 * Math.PI * i) / n;
			const lat = lat0 + r * Math.sin(a);
			const lng = lng0 + r * Math.cos(a);
			return { px: (lng - lng0) * pxPerDeg + 500, py: (lat0 - lat) * pxPerDeg + 500, lat, lng };
		});
	}

	test("the same configuration fits to the same RELATIVE accuracy at both extremes", () => {
		// THE MUTATION-GATE TARGET. Removing the Hartley centring in mapping.ts left every test in
		// the suite green, because every fixture sat near Britain where the centroid is small
		// relative to nothing in particular. A large OFFSET is what exposes it: the town case below
		// is 0.002 degrees wide centred at longitude 120, so the coordinates are five orders of
		// magnitude larger than their own spread, and an uncentred fit loses the fit in the offset.
		// [radius in degrees, pixels per degree] — the product is the pixel half-span, so both
		// cases cover about the same number of pixels from wildly different coordinates.
		const cases: readonly (readonly [number, number])[] = [
			[30, 60], // a continent: 60 degrees across, 3,600 px
			[0.001, 250_000], // a town square: 0.002 degrees across, 500 px, at longitude 120
		];
		for (const [r, pxPerDeg] of cases) {
			const pts = ring(10, r, 51.5, r > 1 ? 20 : 120, pxPerDeg);
			const fit = buildFit(pts, { kind: "affine" });
			// Asserted as a FRACTION of the pixel span the points occupy, which is what makes the
			// two scales comparable at all. An absolute pixel bound here would be the very mistake
			// this file exists to catch.
			const pixelSpan = 2 * r * pxPerDeg;
			expect(fit.diagnostics.affineRms / pixelSpan).toBeLessThan(1e-9);
		}
	});

	test("and a probe lands in the right place at a large coordinate offset", () => {
		const pxPerDeg = 250_000;
		const lat0 = 51.5;
		const lng0 = 120;
		const pts = ring(10, 0.001, lat0, lng0, pxPerDeg);
		const fit = buildFit(pts, { kind: "affine" });
		const lat = lat0 + 0.0004;
		const lng = lng0 - 0.0003;
		const want = { x: (lng - lng0) * pxPerDeg + 500, y: (lat0 - lat) * pxPerDeg + 500 };
		const got = toPixel(fit, lat, lng, { width: 1000, height: 1000 });
		expect(got).not.toBeNull();
		// Sub-thousandth of a pixel on a 500 px half-span. An uncentred fit is out by far more.
		expect(Math.hypot(got!.x - want.x, got!.y - want.y)).toBeLessThan(0.001);
	});
});

describe("extent refuses a corner the transform cannot answer for", () => {
	const SIZE = { width: 2400, height: 3200 };

	/**
	 * Eight points in a narrow southern band, under the shared WARPED ground truth (`truth` from fixtures).
	 *
	 * The warp is load-bearing and my first attempt at this fixture got it wrong: built on a
	 * purely linear truth, affine, polynomial2 and tps all fit and invert it exactly, every corner
	 * round-tripped to 0.0 px, and the test could not fail for the right reason. A fold needs
	 * something to fold — a non-linear truth the order-2 model must approximate and then
	 * extrapolate far beyond its control points.
	 */
	const southern: ControlPoint[] = [
		[50.5, -3.9], [50.7, -3.2], [50.6, -2.4], [50.9, -1.7],
		[50.8, -1.0], [51.0, -0.3], [50.6, 0.3], [50.9, -2.8],
	].map(([lat, lng]) => {
		const [px, py] = truth(lat!, lng!);
		return { px, py, lat: lat!, lng: lng! };
	});

	test("an affine fit answers for all four corners", () => {
		// Affine is invertible everywhere, so extrapolation is wide but meaningful.
		expect(extent(buildFit(southern, { kind: "affine" }), SIZE)).toHaveLength(4);
	});

	test("a folded order-2 polynomial yields null rather than a confident wrong corner", () => {
		// Measured on THIS fixture: the two northern corners round-trip at 129.3 px and 138.2 px
		// against a 12 px tolerance, while the southern pair are fine at 3.2 and 1.7. The ungated
		// version returned all four as plain data with no way for a caller to tell which were
		// meaningless. A caller can handle null; it cannot detect a plausible lie.
		expect(extent(buildFit(southern, { kind: "polynomial2" }), SIZE)).toBeNull();
	});

	test("and the gate is the round-trip gate, not a finiteness check", () => {
		// Proof that the refusal above comes from the round trip: a tolerance wide enough to admit
		// anything brings the corners back, so the corners were finite all along. Without this, a
		// null could equally mean the polynomial produced NaN.
		expect(extent(buildFit(southern, { kind: "polynomial2" }), SIZE, 1e9)).toHaveLength(4);
	});
});

describe("ticks is inclusive at both ends, as its name claims", () => {
	test("a tick exactly on the boundary is not lost to floating-point division", () => {
		// `25 * (1/60) / (1/60)` evaluates to 24.999999999999996, so a plain floor dropped the
		// last tick. Measured across 4,800 windows before the fix: 640 lost one.
		const step = 1 / 60;
		let lost = 0;
		for (let k = 1; k <= 400; k++) {
			const hi = k * step;
			if (ticks(0, hi, step).length !== k + 1) lost++;
		}
		expect(lost).toBe(0);
	});

	test("and the origin tick is a positive zero, not a negative one", () => {
		// The nudge that fixed the above manufactures -0 out of Math.ceil, and -0 is not 0 under
		// Object.is: it would reach a map label as "-0°".
		const out = ticks(0, 1, 1 / 60);
		expect(Object.is(out[0], 0)).toBe(true);
		expect(Object.is(ticks(0, 0, 1)[0], 0)).toBe(true);
	});
});

describe("the median used by the outlier note is a median", () => {
	test("an even count averages the middle pair", () => {
		// The upper-middle element would give 3 here, overstating the centre and suppressing a
		// note about the 5. Pinned directly because, with the ratio calibrated for this statistic,
		// both choices agree on every shared fixture and `diagnose` cannot tell them apart.
		expect(medianOf([1, 1, 3, 5])).toBe(2);
		expect(medianOf([0, 10])).toBe(5);
	});

	test("an odd count takes the middle element, and an empty list is zero", () => {
		expect(medianOf([1, 2, 3])).toBe(2);
		expect(medianOf([7])).toBe(7);
		expect(medianOf([])).toBe(0);
	});
});

describe("the outlier note needs an outlier worth acting on", () => {
	/** Deliberately LINEAR here, unlike the extent block: a perfect affine fit is the point. */
	const linear = (lat: number, lng: number): [number, number] => [(lng + 8) * 200, (60 - lat) * 300];
	/** Nine points under an exactly linear truth, so the affine fit is mathematically perfect. */
	const perfect: ControlPoint[] = [
		[50.7, -3.5], [53.9, -1.1], [55.9, -3.2], [51.5, -0.1], [52.6, 1.3],
		[54.9, -2.9], [57.2, -2.1], [51.3, -2.6], [56.1, -3.9],
	].map(([lat, lng]) => {
		const [px, py] = linear(lat!, lng!);
		return { px, py, lat: lat!, lng: lng! };
	});

	test("a flawless fit is not told that one of its points dominates", () => {
		const d = buildFit(perfect, { kind: "affine" }).diagnostics;
		expect(d.affineRms).toBeLessThan(1e-9);
		expect(d.notes.some((n) => n.includes("dominates"))).toBe(false);
	});

	test("and that holds across many exact fits, not just a lucky one", () => {
		// A PROPERTY, BECAUSE ONE FIXTURE WAS NOT ENOUGH. The residuals of a perfect fit are
		// quantised multiples of an ulp, so their worst-over-median is essentially arbitrary:
		// measured over 4,000 exact fits, 1,316 of them exceed a ratio of 3 on pure float noise,
		// the worst at 71.55. The single fixture above happens to sit near 2, so it would pass
		// whether or not the absolute floor existed — this sweep is what actually pins it.
		let noted = 0;
		for (let seed = 1; seed <= 150; seed++) {
			let s = seed * 7919;
			const r = (): number => {
				s = (s * 1664525 + 1013904223) % 4294967296;
				return s / 4294967296;
			};
			const pts: ControlPoint[] = Array.from({ length: 4 + (seed % 12) }, () => {
				const lat = 40 + r() * 20;
				const lng = -10 + r() * 30;
				// Non-round multipliers so the residuals are float noise rather than exact zeros.
				return { px: (lng + 8) * 200.37, py: (60 - lat) * 300.11, lat, lng };
			});
			const d = buildFit(pts, { kind: "affine" }).diagnostics;
			// Every one of these is an exact affine fit by construction.
			expect(d.affineRms).toBeLessThan(1e-6);
			if (d.notes.some((n) => n.includes("dominates"))) noted++;
		}
		expect(noted).toBe(0);
	});

	test("but a real outlier still raises it", () => {
		// The floor must not have bought silence at the price of the signal. One sign-flipped
		// longitude, which is the mistake the whole display exists to catch.
		const typo = perfect.map((p, i) => (i === 1 ? { ...p, lng: -p.lng } : p));
		const d = buildFit(typo, { kind: "affine" }).diagnostics;
		expect(d.affineRms).toBeGreaterThan(1);
		expect(d.notes.some((n) => n.includes("dominates"))).toBe(true);
	});
});

describe("what extent's gate does and does not establish", () => {
	// Pinned because it surprised me, and a surprise that is not pinned becomes a surprise twice.
	// The round trip measures whether the forward and reverse fits agree, not whether either is
	// right, and image corners are extrapolation by construction.
	test("a spline over the shared fixture is refused, and that is a known cost not a bug", () => {
		// Measured: corners round-trip at 12.4 to 17.8 px against the 12 px tolerance, while their
		// TRUE error is 14.9 to 70.4 px — comparable to the affine corners that pass. Pinning this
		// so that a future change to the tolerance shows up here as a deliberate decision.
		expect(extent(buildFit(CLEAN, { kind: "tps" }), IMAGE)).toBeNull();
		expect(extent(buildFit(CLEAN, { kind: "polynomial2" }), IMAGE)).toBeNull();
	});

	test("an affine fit is accepted, though its corners are no more accurate", () => {
		// THE POINT OF THIS TEST IS THE SECOND HALF. Affine is self-consistent everywhere, so the
		// round trip closes at about 3 px while the corner is in fact up to 67 px from the truth.
		// Passing the gate is not an accuracy claim, and this asserts that it is not, so nobody
		// reads the acceptance above as one.
		const fit = buildFit(CLEAN, { kind: "affine" });
		const got = extent(fit, IMAGE);
		expect(got).toHaveLength(4);
		// The NE corner carried back through the real ground truth lands far from the real NE
		// corner: large error, cheerfully accepted.
		const ne = got![1]!;
		const [bx, by] = truth(ne.lat, ne.lng);
		expect(Math.hypot(bx - IMAGE.width, by - 0)).toBeGreaterThan(20);
	});
});
