import { describe, expect, test } from "bun:test";
import { FitError, InvalidInputError, SingularMatrixError } from "../src/core/errors";
import { buildFit, toLatLng, toPixel } from "../src/core/fit";
import { convexHull } from "../src/core/hull";
import { fitMapping } from "../src/core/mapping";
import { diagnose } from "../src/core/residuals";
import { CLEAN, COLLINEAR, IMAGE, jittered } from "./fixtures";

const MODELS = ["affine", "mercator", "polynomial2", "tps"] as const;

describe("degenerate geometry is refused, not answered wrongly", () => {
	test("collinear control points throw rather than returning garbage", () => {
		// The defect this replaces: these built fine and produced two mutually inconsistent wrong
		// answers. The round-trip gate could not see it, because both bad fits agreed.
		for (const kind of ["affine", "tps"] as const) {
			expect(() => buildFit(COLLINEAR, { kind })).toThrow(SingularMatrixError);
		}
	});

	test("the throw is not erratic across tiny perturbations", () => {
		// Previously nudging a point by 1e-9 threw while 1e-12 did not, because the check was for
		// an exactly-zero pivot. A relative threshold makes the whole neighbourhood behave alike.
		for (const nudge of [0, 1e-14, 1e-12, 1e-10]) {
			const pts = COLLINEAR.map((p, i) => (i === 1 ? { ...p, lat: p.lat + nudge } : p));
			expect(() => buildFit(pts, { kind: "affine" })).toThrow(SingularMatrixError);
		}
	});

	test("exactly duplicated control points throw", () => {
		const dup = [...CLEAN.slice(0, 4), { ...CLEAN[0]! }];
		expect(() => buildFit(dup, { kind: "tps" })).toThrow(SingularMatrixError);
	});

	test("a singular fit is catchable as a FitError, so one catch covers the boundary", () => {
		// It used to escape the kernel untyped, so a user who clicked along a coastline got
		// "singular at column 8" and nothing else.
		expect(() => buildFit(COLLINEAR, { kind: "affine" })).toThrow(FitError);
		try {
			buildFit(COLLINEAR, { kind: "affine" });
		} catch (e) {
			expect((e as Error).message).toContain("collinear or coincident");
		}
	});
});

describe("input validation at the boundary", () => {
	test("a non-finite coordinate throws and names the control point", () => {
		for (const field of ["px", "py", "lat", "lng"] as const) {
			const pts = CLEAN.map((p, i) => (i === 2 ? { ...p, [field]: Number.NaN } : p));
			expect(() => buildFit(pts, { kind: "affine" })).toThrow(InvalidInputError);
			try {
				buildFit(pts, { kind: "affine" });
			} catch (e) {
				// The label matters: "source coordinate 11" is useless to someone who mistyped.
				expect((e as Error).message).toContain("Edinburgh");
				expect((e as Error).message).toContain(field);
			}
		}
	});

	test("Infinity is rejected the same way as NaN", () => {
		const pts = CLEAN.map((p, i) => (i === 0 ? { ...p, lat: Number.POSITIVE_INFINITY } : p));
		expect(() => buildFit(pts, { kind: "affine" })).toThrow(InvalidInputError);
	});

	test("an unknown model throws rather than yielding undefined mappings", () => {
		// The kind arrives from note frontmatter, where TypeScript guarantees nothing. Without a
		// default branch this returned a Fit whose forward and reverse were both undefined.
		const bad = { kind: "mercator-ish" } as unknown as { kind: "affine" };
		expect(() => buildFit(CLEAN, bad)).toThrow(InvalidInputError);
		expect(() => fitMapping(new Float64Array(8), new Float64Array(8), bad)).toThrow(InvalidInputError);
	});

	test("a negative or non-finite lambda throws", () => {
		for (const lambda of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => buildFit(CLEAN, { kind: "tps", lambda })).toThrow(InvalidInputError);
		}
	});

	test("the hull routine defends itself against non-finite input", () => {
		// A broken sort comparator does not merely mis-order: an eight-point set with one NaN
		// previously produced an ELEVEN-vertex hull.
		const verts = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: Number.NaN, y: 5 },
			{ x: 10, y: 10 },
			{ x: 0, y: 10 },
		];
		const hull = convexHull(verts);
		expect(hull.length).toBeLessThanOrEqual(4);
		expect(hull.every((v) => Number.isFinite(v.x) && Number.isFinite(v.y))).toBe(true);
	});
});

describe("the inverse direction is gated too", () => {
	test("a far-field pixel is refused rather than answered with finite garbage", () => {
		// toLatLng previously had no gate, on the reasoning that the query already holds a pixel.
		// A pixel far outside the image extrapolates exactly as a far-field coordinate does.
		for (const kind of ["polynomial2", "tps"] as const) {
			const fit = buildFit(CLEAN, { kind });
			expect(toLatLng(fit, -900000, 1000000, IMAGE)).toBeNull();
		}
	});

	test("an in-image pixel still resolves", () => {
		for (const kind of MODELS) {
			const fit = buildFit(CLEAN, { kind });
			const got = toLatLng(fit, IMAGE.width / 2, IMAGE.height / 2, IMAGE);
			expect(got).not.toBeNull();
			expect(Number.isFinite(got!.lat)).toBe(true);
		}
	});

	test("non-finite queries return null rather than throwing", () => {
		const fit = buildFit(CLEAN, { kind: "tps" });
		expect(toPixel(fit, Number.NaN, 0, IMAGE)).toBeNull();
		expect(toLatLng(fit, Number.NaN, 0, IMAGE)).toBeNull();
	});
});

describe("the spline smoothing term is comparable across fits", () => {
	test("a given lambda means roughly the same thing at different point counts", () => {
		// Measured: with the diagonal set to lambda alone, mean control-point residual spread 13.9x
		// across n = 8 to 128, because the kernel rows it competes with sum over n terms. Dividing
		// by n brings that to 3.3x, and what is left is non-monotonic, so most of it is fixture
		// sampling rather than a trend. This asserts the fixed version, and would fail the old one.
		const meanResidual = (n: number): number => {
			const pts = jittered(n);
			const fit = buildFit(pts, { kind: "tps", lambda: 0.01 });
			const src = new Float64Array(pts.flatMap((p) => [p.lat, p.lng]));
			const out = new Float64Array(src.length);
			fit.forward.apply(src, out);
			return pts.reduce((a, p, i) => a + Math.hypot(out[2 * i]! - p.px, out[2 * i + 1]! - p.py), 0) / n;
		};
		const sizes = [8, 16, 32, 64, 128];
		const vals = sizes.map(meanResidual);
		const spread = Math.max(...vals) / Math.max(Math.min(...vals), 1e-12);
		expect(spread).toBeLessThan(6);
	});

	test("lambda = 0 still interpolates exactly, whatever the point count", () => {
		for (const n of [8, 32]) {
			const pts = jittered(n);
			const fit = buildFit(pts, { kind: "tps", lambda: 0 });
			const src = new Float64Array(pts.flatMap((p) => [p.lat, p.lng]));
			const out = new Float64Array(src.length);
			fit.forward.apply(src, out);
			const worst = Math.max(...pts.map((p, i) => Math.hypot(out[2 * i]! - p.px, out[2 * i + 1]! - p.py)));
			expect(worst).toBeLessThan(1e-3);
		}
	});

	test("diagnose survives a non-zero lambda, which is where the old oracle disagreed", () => {
		const d = diagnose(CLEAN, { kind: "tps", lambda: 0.5 });
		expect(d.loo).toBeDefined();
		expect(d.loo!.every((r) => Number.isFinite(r.error))).toBe(true);
	});
});
