import { describe, expect, test } from "bun:test";
import { fitMapping, type TpsMapping } from "../src/core/mapping";
import { affineResiduals, diagnose, tpsLooBruteForce, tpsLooRippa } from "../src/core/residuals";
import { CLEAN, TYPO, TYPO_INDEX } from "./fixtures";

const worst = (rs: readonly { index: number; error: number }[]): number =>
	rs.reduce((a, b) => (b.error > a.error ? b : a)).index;

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
		// Clean fixture: max about 27px. One sign-flipped longitude: max about 276px. The whole
		// fit degrades, which is the thing worth putting in front of someone.
		const clean = Math.max(...affineResiduals(CLEAN).map((r) => r.error));
		const typo = Math.max(...affineResiduals(TYPO).map((r) => r.error));
		expect(typo / clean).toBeGreaterThan(5);
	});

	test("and that caveat is surfaced when there is an outlier to surface it about", () => {
		expect(diagnose(TYPO, { kind: "affine" }).notes.some((n) => n.includes("masking"))).toBe(true);
		expect(diagnose(CLEAN, { kind: "affine" }).notes.some((n) => n.includes("masking"))).toBe(false);
	});

	test("a clean set produces no comparable outlier", () => {
		const errs = affineResiduals(CLEAN).map((r) => r.error);
		expect(Math.max(...errs)).toBeLessThan(3 * (errs.reduce((a, b) => a + b, 0) / errs.length));
	});
});

describe("Rippa's closed form against an independent refit", () => {
	test("agrees with brute-force leave-one-out on clean points", () => {
		const m = fitMapping(
			new Float64Array(CLEAN.flatMap((p) => [p.lat, p.lng])),
			new Float64Array(CLEAN.flatMap((p) => [p.px, p.py])),
			{ kind: "tps" },
		) as TpsMapping;
		const closed = tpsLooRippa(m);
		const brute = tpsLooBruteForce(CLEAN);
		expect(closed.length).toBe(brute.length);
		closed.forEach((c, i) => {
			const b = brute[i]!;
			// Relative agreement: these errors span orders of magnitude across hull and interior.
			expect(Math.abs(c - b) / Math.max(b, 1e-6)).toBeLessThan(1e-6);
		});
	});
});

describe("the leave-one-out caveat is real and is marked", () => {
	test("on clean points the worst leave-one-out error sits on the hull", () => {
		const d = diagnose(CLEAN, { kind: "tps" });
		expect(d.loo).toBeDefined();
		const w = d.loo!.reduce((a, b) => (b.error > a.error ? b : a));
		// This is the trap: a perfectly correct corner is the worst offender by this metric,
		// because leaving it out means extrapolating to it.
		expect(w.onHull).toBe(true);
	});

	test("so the caveat reaches the caller rather than sitting in a changelog", () => {
		const d = diagnose(CLEAN, { kind: "tps" });
		expect(d.notes.some((n) => n.includes("hull"))).toBe(true);
		expect(d.notes.some((n) => n.includes("neighbours"))).toBe(true);
	});

	test("and the affine display does NOT single that corner out", () => {
		const d = diagnose(CLEAN, { kind: "tps" });
		const looWorst = d.loo!.reduce((a, b) => (b.error > a.error ? b : a)).index;
		const affineWorst = worst(d.affine);
		// The whole reason affine is the primary display: it does not inherit this artefact.
		const affineAtLooWorst = d.affine[looWorst]!.error;
		const affineMax = d.affine[affineWorst]!.error;
		expect(affineAtLooWorst).toBeLessThanOrEqual(affineMax);
	});
});

describe("leave-one-out availability", () => {
	test("three points is affine in disguise, so no leave-one-out is offered", () => {
		const d = diagnose(CLEAN.slice(0, 3), { kind: "tps" });
		expect(d.loo).toBeUndefined();
		expect(d.notes.some((n) => n.includes("exactly affine"))).toBe(true);
	});

	test("four points is enough", () => {
		expect(diagnose(CLEAN.slice(0, 4), { kind: "tps" }).loo).toBeDefined();
	});

	test("an affine fit reports no leave-one-out at all", () => {
		expect(diagnose(CLEAN, { kind: "affine" }).loo).toBeUndefined();
	});
});
