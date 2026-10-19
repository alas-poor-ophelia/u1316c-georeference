/**
 * How a user knows whether to trust a fit.
 *
 * THE PRIMARY DISPLAY IS THE AFFINE RESIDUAL, whatever model the user picked. An affine fit over
 * the same control points is always available at three points or more and is an honest least
 * squares fit, so a mistyped coordinate shows up as a gross outlier the fit cannot absorb. That
 * is the number to put in front of someone.
 *
 * A thin-plate spline at lambda = 0 interpolates EXACTLY, so its ordinary residuals are zero by
 * construction. Reporting them would tell a historian her fit was flawless on a map containing a
 * transposed digit. Leave-one-out is the refinement, with three caveats that must reach the UI:
 *
 *   - A control point ON THE CONVEX HULL is predicted by extrapolation when it is left out, so
 *     its error is inflated and is not evidence of anything. Unmarked, a correct corner point is
 *     presented as the worst offender and the user deletes a good point while keeping the bad one.
 *   - Masking: one bad point inflates its neighbours' errors too, so the ranking alone does not
 *     identify which point is wrong.
 *   - It needs four points. With exactly three a thin-plate spline IS an affine transform.
 */
import { convexHull } from "./hull";
import { solve } from "./linalg";
import { fitMapping, INTERNAL_FOR_ORACLE, TpsMapping } from "./mapping";
import type { ControlPoint, TransformOptions } from "./types";

export interface PointResidual {
	readonly index: number;
	readonly label?: string;
	/** Error in pixels. */
	readonly error: number;
	/** On the convex hull of the control points, so a leave-one-out error here is extrapolated. */
	readonly onHull: boolean;
}

export interface Diagnostics {
	/** Always present. The trust display. */
	readonly affine: readonly PointResidual[];
	readonly affineRms: number;
	/** Present only for a thin-plate spline over four or more points. */
	readonly loo?: readonly PointResidual[];
	/**
	 * RMS over INTERIOR points only. Hull points are predicted by extrapolation when left out, so
	 * their errors are flagged non-diagnostic — averaging them into the headline number would let
	 * the artefact dominate the one figure a user actually reads. Absent when every point is on
	 * the hull, which is always true at n = 4.
	 */
	readonly looRms?: number;
	/** Caveats that belong next to the numbers, not in a changelog. */
	readonly notes: readonly string[];
}

function worldArray(points: readonly ControlPoint[]): Float64Array {
	const a = new Float64Array(points.length * 2);
	points.forEach((p, i) => {
		a[2 * i] = p.lat;
		a[2 * i + 1] = p.lng;
	});
	return a;
}

function pixelArray(points: readonly ControlPoint[]): Float64Array {
	const a = new Float64Array(points.length * 2);
	points.forEach((p, i) => {
		a[2 * i] = p.px;
		a[2 * i + 1] = p.py;
	});
	return a;
}

function hullFlags(points: readonly ControlPoint[]): boolean[] {
	const verts = points.map((p) => ({ x: p.lng, y: p.lat }));
	const hull = convexHull(verts);
	const key = (v: { x: number; y: number }): string => `${v.x},${v.y}`;
	const onHull = new Set(hull.map(key));
	return verts.map((v) => onHull.has(key(v)));
}

function rms(values: readonly number[]): number {
	if (values.length === 0) return 0;
	let acc = 0;
	for (const v of values) acc += v * v;
	return Math.sqrt(acc / values.length);
}

function residual(points: readonly ControlPoint[], i: number, hull: readonly boolean[], error: number): PointResidual {
	const label = points[i]!.label;
	const base = { index: i, error, onHull: hull[i] ?? false };
	return label === undefined ? base : { ...base, label };
}

/** Least-squares residuals from an affine fit over all the points. Always meaningful. */
export function affineResiduals(points: readonly ControlPoint[]): PointResidual[] {
	const world = worldArray(points);
	const pixel = pixelArray(points);
	const m = fitMapping(world, pixel, { kind: "affine" });
	const out = new Float64Array(pixel.length);
	m.apply(world, out);
	const hull = hullFlags(points);
	return points.map((p, i) => residual(points, i, hull, Math.hypot(out[2 * i]! - p.px, out[2 * i + 1]! - p.py)));
}

/**
 * Leave-one-out errors by Rippa's formula: for an interpolation system A c = y, the error at
 * point i is c_i / (A inverse)_ii. One inversion, already computed at fit time — not N refits.
 *
 * Validated against `tpsLooBruteForce` in the test suite rather than trusted. If the closed form
 * and the independent refit ever disagree, the test says so and the formula is wrong, not the
 * refit.
 */
export function tpsLooRippa(m: TpsMapping): number[] {
	const n = m.pointCount;
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		const denom = m.systemInverse[i]?.[i] ?? 0;
		if (denom === 0) {
			out.push(Number.POSITIVE_INFINITY);
			continue;
		}
		const ex = m.coeffs[i]![0]! / denom;
		const ey = m.coeffs[i]![1]! / denom;
		// Errors live in normalised destination space; a DIFFERENCE converts back by scale alone.
		out.push(Math.hypot(ex, ey) / m.dstScale);
	}
	return out;
}

/**
 * Leave-one-out by actually re-solving the system with one row and column removed. The
 * independent oracle for `tpsLooRippa` — O(n) solves, and not what the UI calls.
 *
 * It deliberately does NOT call `fitMapping`. The previous version did, and that was a real
 * defect in the oracle rather than in the formula: re-fitting a subset through the public fitter
 * re-normalises it, so the subset is centred and scaled differently and a DIFFERENT problem gets
 * solved. At lambda = 0 the spline interpolates either way and the discrepancy hid; at lambda > 0
 * the two disagreed by 1 to 3 percent, and `diagnose` runs with lambda > 0 in production. An
 * oracle that solves a different problem cannot confirm anything.
 *
 * Rippa's identity concerns the same matrix A with row and column i struck out, so the smoothing
 * diagonal is held at the FULL fit's value rather than recomputed for n-1 points.
 */
export function tpsLooIndependent(m: TpsMapping): number[] {
	const { tpsKernel, smoothingDiagonal } = INTERNAL_FOR_ORACLE;
	const n = m.pointCount;
	const diag = smoothingDiagonal(m.lambda, n);
	const out: number[] = [];

	for (let skip = 0; skip < n; skip++) {
		const idx = Array.from({ length: n }, (_, i) => i).filter((i) => i !== skip);
		const k = idx.length;
		const size = k + 3;
		const nx = idx.map((i) => [m.nodes[2 * i]!, m.nodes[2 * i + 1]!] as const);

		const A: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
		const B: number[][] = Array.from({ length: size }, () => [0, 0]);
		for (let a = 0; a < k; a++) {
			for (let b = 0; b < k; b++) {
				if (a === b) {
					A[a]![b] = diag;
					continue;
				}
				const dx = nx[a]![0] - nx[b]![0];
				const dy = nx[a]![1] - nx[b]![1];
				A[a]![b] = tpsKernel(dx * dx + dy * dy);
			}
			A[a]![k] = 1;
			A[a]![k + 1] = nx[a]![0];
			A[a]![k + 2] = nx[a]![1];
			A[k]![a] = 1;
			A[k + 1]![a] = nx[a]![0];
			A[k + 2]![a] = nx[a]![1];
			B[a] = [m.targets[idx[a]!]![0]!, m.targets[idx[a]!]![1]!];
		}

		const c = solve(A, B);
		const qx = m.nodes[2 * skip]!;
		const qy = m.nodes[2 * skip + 1]!;
		let ex = c[k]![0]! + c[k + 1]![0]! * qx + c[k + 2]![0]! * qy;
		let ey = c[k]![1]! + c[k + 1]![1]! * qx + c[k + 2]![1]! * qy;
		for (let a = 0; a < k; a++) {
			const dx = qx - nx[a]![0];
			const dy = qy - nx[a]![1];
			const u = tpsKernel(dx * dx + dy * dy);
			ex += c[a]![0]! * u;
			ey += c[a]![1]! * u;
		}

		const tx = m.targets[skip]![0]!;
		const ty = m.targets[skip]![1]!;
		out.push(Math.hypot(ex - tx, ey - ty) / m.dstScale);
	}
	return out;
}

export function diagnose(points: readonly ControlPoint[], opts: TransformOptions): Diagnostics {
	const hull = hullFlags(points);
	const affine = affineResiduals(points);
	const notes: string[] = [];

	let loo: PointResidual[] | undefined;
	if (opts.kind === "tps") {
		if (points.length < 4) {
			notes.push("A thin-plate spline over three points is exactly affine; leave-one-out needs four.");
		} else {
			const m = fitMapping(worldArray(points), pixelArray(points), opts);
			if (m instanceof TpsMapping) {
				const errs = tpsLooRippa(m);
				loo = points.map((_, i) => residual(points, i, hull, errs[i] ?? Number.POSITIVE_INFINITY));
				if (hull.some(Boolean)) {
					notes.push(
						"Points on the hull are extrapolated when left out, so their errors are inflated and not diagnostic.",
					);
				}
				notes.push("One bad point inflates its neighbours' errors, so this ranking does not identify which point is wrong on its own.");
			}
		}
		if ((opts.lambda ?? 0) === 0) {
			notes.push("This spline interpolates exactly, so its ordinary residuals are zero by construction.");
		}
	}

	// Masking is not only a leave-one-out problem: a least-squares fit drags itself toward a bad
	// point, which inflates every other residual too. Measured on the eight-point fixture, one
	// sign-flipped longitude ranked worst at only about 1.7x the next value, while the whole set's
	// errors rose several-fold against its clean baseline. So the ranking identifies the suspect,
	// but the magnitudes of the others mean nothing in isolation, and the signal a user should act
	// on is the global rise. Say so, but only when there is actually an outlier to say it about.
	const errs = affine.map((r) => r.error).sort((a, b) => a - b);
	const median = errs[Math.floor(errs.length / 2)] ?? 0;
	if (median > 0 && (errs[errs.length - 1] ?? 0) > 2 * median) {
		notes.push(
			"One point dominates the affine residuals. Least-squares masking inflates the others too, so treat the ranking as naming the suspect and the overall rise as the evidence, not the individual magnitudes.",
		);
	}

	const base = { affine, affineRms: rms(affine.map((r) => r.error)), notes };
	if (loo === undefined) return base;

	// Interior points only — see the note on `looRms`.
	const interior = loo.filter((r) => !r.onHull).map((r) => r.error);
	if (interior.length === 0) {
		notes.push(
			"Every control point is on the hull, so leave-one-out has nothing to say: each point is extrapolated to when left out. Four points are always in this position.",
		);
		return { ...base, loo };
	}
	return { ...base, loo, looRms: rms(interior) };
}
