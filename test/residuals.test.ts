import { describe, expect, test } from "bun:test";
import { fitMapping, type TpsMapping } from "../src/core/mapping";
import { affineResiduals, diagnose, tpsLooIndependent, tpsLooRippa } from "../src/core/residuals";
import { MIN_POINTS, RECOMMENDED_POINTS } from "../src/core/types";
import { CLEAN, CLEAN_LINEAR, TYPO, TYPO_INDEX } from "./fixtures";

const worst = (rs: readonly { index: number; error: number }[]): number =>
	rs.reduce((a, b) => (b.error > a.error ? b : a)).index;

const world = new Float64Array(CLEAN.flatMap((p) => [p.lat, p.lng]));
const pixel = new Float64Array(CLEAN.flatMap((p) => [p.px, p.py]));
const fitTps = (lambda: number): TpsMapping =>
	fitMapping(world, pixel, { kind: "tps", lambda }) as TpsMapping;

describe("the trust display catches a mistyped coordinate", () => {
	test("affine residuals rank the corrupted point worst", () => {
		expect(worst(affineResiduals(TYPO))).toBe(TYPO_INDEX);
	});

	test("but only by a modest margin, because least-squares masking inflates the rest", () => {
		// Measured at about 1.7x the next worst. A first guess of 3x failed here, and the failure
		// was informative: masking is not only a leave-one-out problem. A least-squares fit drags
		// itself toward a bad point, so every other residual rises too. The ranking names the
		// suspect; the magnitudes of the others mean nothing on their own.
		const rs = affineResiduals(TYPO);
		const bad = rs[TYPO_INDEX]!.error;
		const nextWorst = Math.max(...rs.filter((_, i) => i !== TYPO_INDEX).map((r) => r.error));
		expect(bad / nextWorst).toBeGreaterThan(1.5);
		expect(bad / nextWorst).toBeLessThan(3);
	});

	test("the signal a user can act on is the global rise, not one number", () => {
		// Clean fixture: max about 27px. One sign-flipped longitude: max about 276px.
		const clean = Math.max(...affineResiduals(CLEAN).map((r) => r.error));
		const typo = Math.max(...affineResiduals(TYPO).map((r) => r.error));
		expect(typo / clean).toBeGreaterThan(5);
	});

	test("and that caveat is surfaced when there is an outlier to surface it about", () => {
		expect(diagnose(TYPO, { kind: "affine" }).notes.some((n) => n.includes("masking"))).toBe(true);
		expect(diagnose(CLEAN, { kind: "affine" }).notes.some((n) => n.includes("masking"))).toBe(false);
	});
});

describe("why affine is the primary display and not the spline's own residuals", () => {
	test("the spline's ordinary residuals are zero by construction; affine's are not", () => {
		// THIS is the reason, and it is the whole reason. An earlier version of this suite tried
		// to assert that the affine display avoids the hull-extrapolation artefact. Measured, that
		// claim is false: on the clean fixture the worst affine residual and the worst
		// leave-one-out error are the SAME point (Aberdeen, the northernmost, where the warp is
		// largest), so affine ranks a hull corner worst for an entirely legitimate reason.
		//
		// What actually distinguishes them is that an interpolating spline reports a flawless fit
		// on any input whatsoever, while a least-squares fit cannot absorb a bad point.
		const out = new Float64Array(pixel.length);
		fitTps(0).apply(world, out);
		const splineWorst = Math.max(...CLEAN.map((p, i) => Math.hypot(out[2 * i]! - p.px, out[2 * i + 1]! - p.py)));
		const affineWorst = Math.max(...affineResiduals(CLEAN).map((r) => r.error));

		expect(splineWorst).toBeLessThan(1e-3);
		expect(affineWorst).toBeGreaterThan(10);
	});
});

describe("Rippa's closed form against an independent re-solve", () => {
	// The oracle no longer goes through the public fitter. That was a defect in the ORACLE: a
	// re-fitted subset gets re-normalised, so it solves a different problem. At lambda = 0 the
	// spline interpolates either way and the discrepancy hid; at lambda > 0 the two disagreed by
	// 1 to 3 percent — and diagnose() runs with lambda > 0 in production.
	for (const lambda of [0, 0.01, 0.5, 2]) {
		test(`agrees at lambda = ${lambda}`, () => {
			const m = fitTps(lambda);
			const closed = tpsLooRippa(m);
			const oracle = tpsLooIndependent(m);
			expect(closed.length).toBe(oracle.length);
			closed.forEach((c, i) => {
				const o = oracle[i]!;
				expect(Math.abs(c - o) / Math.max(o, 1e-9)).toBeLessThan(1e-6);
			});
		});
	}
});

describe("the leave-one-out caveat is real, measured, and marked", () => {
	test("hull points carry systematically larger errors than interior points", () => {
		// The artefact itself, quantified rather than asserted: leaving a hull point out means
		// extrapolating to it. Measured on the clean fixture, hull mean is roughly twice interior.
		const d = diagnose(CLEAN, { kind: "tps" });
		const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
		const hull = mean(d.loo!.filter((r) => r.onHull).map((r) => r.error));
		const interior = mean(d.loo!.filter((r) => !r.onHull).map((r) => r.error));
		expect(hull).toBeGreaterThan(1.5 * interior);
	});

	test("so the headline number excludes them", () => {
		const d = diagnose(CLEAN, { kind: "tps" });
		const interior = d.loo!.filter((r) => !r.onHull).map((r) => r.error);
		const all = d.loo!.map((r) => r.error);
		const rms = (xs: readonly number[]): number => Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / xs.length);
		expect(d.looRms).toBeCloseTo(rms(interior), 6);
		expect(d.looRms).not.toBeCloseTo(rms(all), 2);
	});

	test("and the caveats reach the caller rather than sitting in a changelog", () => {
		const d = diagnose(CLEAN, { kind: "tps" });
		expect(d.notes.some((n) => n.includes("hull"))).toBe(true);
		expect(d.notes.some((n) => n.includes("neighbours"))).toBe(true);
	});
});

describe("leave-one-out availability", () => {
	test("three points is affine in disguise, so no leave-one-out is offered", () => {
		const d = diagnose(CLEAN.slice(0, 3), { kind: "tps" });
		expect(d.loo).toBeUndefined();
		expect(d.notes.some((n) => n.includes("exactly affine"))).toBe(true);
	});

	test("four points has every point on the hull, so there is no headline number", () => {
		const d = diagnose(CLEAN.slice(0, 4), { kind: "tps" });
		expect(d.loo).toBeDefined();
		expect(d.looRms).toBeUndefined();
		expect(d.notes.some((n) => n.includes("Every control point is on the hull"))).toBe(true);
	});

	test("an affine fit reports no leave-one-out at all", () => {
		expect(diagnose(CLEAN, { kind: "affine" }).loo).toBeUndefined();
	});
});

/**
 * The exactly-determined case, which is the one point count at which the headline number lies.
 *
 * This whole block is the test that was missing: the suite checked affine exactness only at eight
 * points on linear data, so nothing pinned what happens at the MINIMUM — and the minimum is where
 * a user starts. `CLEAN_LINEAR` is used throughout because a purely linear truth makes a correct
 * affine fit exact, so the only error present is the one deliberately injected.
 */
describe("the affine display is a tautology at exactly three points", () => {
	const three = CLEAN_LINEAR.slice(0, 3);
	/** The same mistake `TYPO` makes, one sign-flipped longitude, about 150 km. */
	const flip = (ps: readonly (typeof CLEAN_LINEAR)[number][]): typeof three =>
		ps.map((p, i) => (i === 1 ? { ...p, lng: -p.lng } : p));

	test("a correct affine fit over three points reproduces them exactly", () => {
		// Three free parameters per axis against three constraints. Measured max 5.1e-13 px.
		for (const r of affineResiduals(three)) expect(r.error).toBeLessThan(1e-9);
	});

	test("and so does a WRONG one, which is the hazard", () => {
		// Measured at 0.0 px on this fixture and at 1.1e-13 px on another — float noise either
		// way, NOT a tolerance that could be tightened, because the fit has nothing spare to show
		// the error in. (An earlier version of this comment claimed "exactly 0.0", which is true
		// of some point sets and not others; the claim worth making is that it is noise-level
		// whatever the input, which is what the assertion says.) This is why
		// RECOMMENDED_POINTS.affine moved from 3 to 4.
		for (const r of affineResiduals(flip(three))) expect(r.error).toBeLessThan(1e-9);
	});

	test("the identical error at four points is loud", () => {
		// Measured 145.8 px. The cliff is at exactly three; one spare observation is enough.
		const worstFour = Math.max(...affineResiduals(flip(CLEAN_LINEAR.slice(0, 4))).map((r) => r.error));
		expect(worstFour).toBeGreaterThan(100);
	});

	test("so the caveat is attached at three, and is absent once it is untrue", () => {
		const atThree = diagnose(flip(three), { kind: "affine" });
		// FIRST in the list: it voids every other number in the object, and `trust` shows notes[0]
		// verbatim when there is only one.
		expect(atThree.notes[0]).toContain("Add a fourth point");
		const atFour = diagnose(flip(CLEAN_LINEAR.slice(0, 4)), { kind: "affine" });
		expect(atFour.notes.some((n) => n.includes("Add a fourth point"))).toBe(false);
	});

	test("and three points is no longer advertised as recommended for affine", () => {
		// Fittable is not the same as meaningful, and this constant is the only place that
		// distinction is expressed. Pinned so a revert to 3 fails here rather than in the field.
		expect(MIN_POINTS.affine).toBe(3);
		expect(RECOMMENDED_POINTS.affine).toBe(4);
	});
});
