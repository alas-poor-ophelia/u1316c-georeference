import { describe, expect, test } from "bun:test";
import { fitMapping, type TpsMapping } from "../src/core/mapping";
import { affineResiduals, diagnose, tpsLooIndependent, tpsLooRippa } from "../src/core/residuals";
import { CLEAN, TYPO, TYPO_INDEX } from "./fixtures";

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
