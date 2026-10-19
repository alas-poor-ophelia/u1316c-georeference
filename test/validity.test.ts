import { describe, expect, test } from "bun:test";
import { buildFit, toPixel } from "../src/core/fit";
import { convexHull, inHull } from "../src/core/hull";
import { roundTrip, roundTripTolerance } from "../src/core/validity";
import { CLEAN, CLEAN_LINEAR, IMAGE } from "./fixtures";

/** Somewhere with no business appearing on a map of Britain. */
const PACIFIC = { lat: -20, lng: 150 };
/** Interior to the control-point hull. */
const INTERIOR = { lat: 53.0, lng: -2.0 };
/** North of every control point: outside the hull, but still plainly on a map of the Isles. */
const ORKNEY = { lat: 59.0, lng: -3.0 };

const TOL = roundTripTolerance(IMAGE);
const MODELS = ["affine", "polynomial2", "tps"] as const;

describe("round-trip validity", () => {
	test("an interior coordinate closes far inside the tolerance, for every model", () => {
		for (const kind of MODELS) {
			const fit = buildFit(CLEAN, { kind });
			const r = roundTrip(fit.forward, fit.reverse, INTERIOR.lat, INTERIOR.lng, TOL);
			expect(r.ok).toBe(true);
			expect(r.error).toBeLessThan(TOL / 10);
		}
	});

	test("a legitimate point just outside the hull still resolves", () => {
		// The calibration bug this test exists for: the first tolerance was an absolute 2 pixels,
		// which REFUSED this column under both the polynomial and the spline. Orkney is outside
		// the control-point hull but on the map, and must resolve and be marked, not rejected.
		for (const kind of MODELS) {
			const fit = buildFit(CLEAN, { kind });
			expect(roundTrip(fit.forward, fit.reverse, ORKNEY.lat, ORKNEY.lng, TOL).ok).toBe(true);
			const px = toPixel(fit, ORKNEY.lat, ORKNEY.lng, IMAGE);
			expect(px).not.toBeNull();
			expect(px!.extrapolated).toBe(true);
		}
	});

	test("a wild extrapolation does not close, and is refused", () => {
		// Without this, a fit that folds can map a coordinate on the far side of the planet to a
		// pixel INSIDE the image, and a coverage query returns a map of Britain for the Pacific.
		for (const kind of ["polynomial2", "tps"] as const) {
			const fit = buildFit(CLEAN, { kind });
			const r = roundTrip(fit.forward, fit.reverse, PACIFIC.lat, PACIFIC.lng, TOL);
			expect(r.error).toBeGreaterThan(TOL);
			expect(r.ok).toBe(false);
			expect(toPixel(fit, PACIFIC.lat, PACIFIC.lng, IMAGE)).toBeNull();
		}
	});

	test("the tolerance sits mid-gap, not on a knife edge", () => {
		// Calibration, not decoration. The legitimate population and the nonsense population must
		// be separated by orders of magnitude with the threshold between them.
		const legit: number[] = [];
		const nonsense: number[] = [];
		for (const kind of MODELS) {
			const fit = buildFit(CLEAN, { kind });
			legit.push(roundTrip(fit.forward, fit.reverse, INTERIOR.lat, INTERIOR.lng, TOL).error);
			legit.push(roundTrip(fit.forward, fit.reverse, ORKNEY.lat, ORKNEY.lng, TOL).error);
			nonsense.push(roundTrip(fit.forward, fit.reverse, PACIFIC.lat, PACIFIC.lng, TOL).error);
		}
		const worstLegit = Math.max(...legit);
		const bestNonsense = Math.min(...nonsense);
		expect(worstLegit).toBeLessThan(TOL);
		expect(bestNonsense).toBeGreaterThan(TOL);
		// Measured at roughly 85x. Anything above one order of magnitude means the default is not
		// a magic number balanced on a cliff.
		expect(bestNonsense / worstLegit).toBeGreaterThan(10);
	});
});

describe("why the round trip is evidence and not an identity", () => {
	test("over exactly affine data, forward and reverse ARE exact inverses everywhere", () => {
		// Including the Pacific: a linear map inverts exactly, so there is nothing to catch here.
		const fit = buildFit(CLEAN_LINEAR, { kind: "affine" });
		expect(roundTrip(fit.forward, fit.reverse, PACIFIC.lat, PACIFIC.lng, TOL).error).toBeLessThan(1e-6);
	});

	test("over warped data they are two different approximations, and diverge with distance", () => {
		// This is the part worth understanding: the reverse mapping is fitted INDEPENDENTLY from
		// the same control points, so when the model cannot represent the data exactly the two
		// fits disagree, and the disagreement grows away from the evidence. That is what makes
		// agreement between them meaningful rather than tautological — and it means even an
		// affine fit gets caught extrapolating, which an invertibility argument would have missed.
		const fit = buildFit(CLEAN, { kind: "affine" });
		const near = roundTrip(fit.forward, fit.reverse, INTERIOR.lat, INTERIOR.lng, TOL).error;
		const far = roundTrip(fit.forward, fit.reverse, PACIFIC.lat, PACIFIC.lng, TOL).error;
		expect(near).toBeLessThan(TOL);
		expect(far).toBeGreaterThan(TOL);
		expect(far / near).toBeGreaterThan(100);
	});
});

describe("convex hull", () => {
	test("wraps a square and drops its interior", () => {
		const hull = convexHull([
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
			{ x: 0, y: 10 },
			{ x: 5, y: 5 },
		]);
		expect(hull.length).toBe(4);
		expect(hull.some((h) => h.x === 5 && h.y === 5)).toBe(false);
	});

	test("contains its interior and excludes the outside", () => {
		const hull = convexHull([
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
			{ x: 0, y: 10 },
		]);
		expect(inHull(hull, { x: 5, y: 5 })).toBe(true);
		expect(inHull(hull, { x: 11, y: 5 })).toBe(false);
	});

	test("collinear points evidence no area, so the hull contains nothing", () => {
		const hull = convexHull([
			{ x: 0, y: 0 },
			{ x: 5, y: 5 },
			{ x: 10, y: 10 },
		]);
		expect(inHull(hull, { x: 5, y: 5 })).toBe(false);
	});
});
