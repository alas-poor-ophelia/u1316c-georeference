/**
 * How a user knows whether to trust a fit.
 *
 * THE PRIMARY DISPLAY IS THE AFFINE RESIDUAL, whatever model the user picked. An affine fit over
 * the same control points is always available at three points or more and is an honest least
 * squares fit, so a mistyped coordinate shows up as a gross outlier the fit cannot absorb. That
 * is the number to put in front of someone.
 *
 * WITH ONE EXCEPTION, AND IT IS EXACTLY AT THE MINIMUM. "The fit cannot absorb it" is a claim
 * about having more observations than parameters, and an affine fit has three free parameters per
 * axis. At exactly three control points there is nothing left over: the fit reproduces them
 * exactly, every residual is zero, and that is true of a mistyped coordinate as much as a correct
 * one. Measured — one longitude sign-flipped, about 150 km — the display read "RMS 0.0 px, worst
 * 0.0 px" with no caveat at all, while the same error at four points read 199 px. So the headline
 * number is honest from four points up, and from three it is a tautology; `diagnose` says so in a
 * note rather than leaving the reader to know it. This is the same trap as the interpolating
 * spline below, one layer down, and it was missed because the spline case was handled.
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
import { NEARLY_COLLINEAR_RATIO, principalAxisRatio, wrapsAntimeridian } from "./geometry";
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

/**
 * Smallest worst-residual worth naming an outlier about, in image pixels.
 *
 * Control points are placed by hand at pixel precision, so a spread below one pixel carries no
 * information about whether the user made a mistake — there is nothing to go and look at. This is
 * about actionability rather than about float noise, but it fixes the float-noise false positive
 * as a side effect, and by an enormous margin: a perfect fit's residuals are around 1e-12 px.
 *
 * DELIBERATELY ABSOLUTE, against the general rule that a threshold must scale with input size.
 * Review flagged this as the scaling mistake, and the exception is argued rather than assumed: the
 * quantity this bounds is HAND-PLACEMENT PRECISION, which does not scale with the image. A user
 * zooms in to drop a control point, so they place it to within about a pixel whether the scan is
 * 300 px or 8,000 px wide — the precision is a property of the pointer and the zoom, not of the
 * file. A fraction-of-image floor would therefore be too permissive on a large scan (silencing a
 * real 20 px outlier at 8,000 px) and too strict on a thumbnail. A relative term was considered
 * and dropped as unjustifiable: it would sit twelve orders of magnitude below this one at every
 * realistic image size, so nothing would ever read it.
 */
const MASKING_NOTE_FLOOR_PX = 1;

/**
 * How far the worst residual must exceed the median before one point counts as dominating.
 *
 * RE-CALIBRATED when `medianOf` replaced `errs[floor(n / 2)]`, and that re-calibration is the
 * interesting part: the old threshold of 2 was tuned against the UPPER-MIDDLE element, which
 * overstates the median, so correcting the statistic made the same threshold more sensitive and it
 * began firing on the clean fixture. A fix described as trivial was coupled to a constant
 * elsewhere. Measured on the shared fixtures, worst-over-median:
 *
 *                      upper-middle (old)    true median (now)
 *   CLEAN (no outlier)       1.97                  2.12
 *   TYPO  (one bad point)    3.14                  4.30
 *
 * 3 sits mid-gap between 2.12 and 4.30 on a log scale, about 1.4x clear of each — the same
 * placement rule the round-trip tolerance uses.
 *
 * WHAT IT COSTS, measured by review over 1,500 Monte Carlo trials per cell (affine fit on linear
 * truth, 0.3 px placement noise, one point displaced). Probability the note fires:
 *
 *     n    outlier    old rule (median biased, ratio 2, no floor)    this rule
 *     5      5 px                    0.54                              0.17
 *     5    150 px                    0.60                              0.25
 *     8      5 px                    0.80                              0.57
 *     8     15 px                    0.87                              0.72
 *    12     15 px                    0.96                              0.92
 *    20     15 px                    0.98                              0.94
 *
 * A REAL LOSS OF SENSITIVITY, and it is accepted rather than overlooked, because the same trials
 * put the old rule's FALSE positive rate on clean data at 0.26 to 0.61 — a caveat that fired on
 * roughly half of all good fits, which is a caveat a user learns to ignore. This rule is at 0.00
 * to 0.02. The trade is good above about eight points and poor below it.
 *
 * TWO HONEST LIMITS. First, worst-over-median is a weak statistic at small n: at five points a
 * gross 150 px outlier is named only a quarter of the time, and at four points neither rule works
 * at all because one spare observation cannot localise anything. Second, the calibration above is
 * two configurations from one eight-point fixture, so this is a separating value and not a
 * characterised distribution. Both are tolerable only because this decides a NOTE and never a
 * number: the signal a user acts on is the overall RISE in the residuals, which this does not
 * gate, and the note merely names a suspect.
 */
const MASKING_NOTE_RATIO = 3;

/**
 * True median, averaging the middle pair for an even count.
 *
 * `values[floor(length / 2)]` is the UPPER middle element, which biases the median upward: for
 * errors [1, 1, 3, 5] the real median is 2 while the upper-middle is 3.
 *
 * EXPORTED FOR ITS TEST, following `INTERNAL_FOR_ORACLE` in `mapping.ts`, and not re-exported from
 * `core/index.ts` — so it is reachable by a test without joining the kernel's public surface. The
 * export is not decoration: with the threshold calibrated for this statistic, both medians agree
 * on every shared fixture, so the correction is invisible through `diagnose` and a direct test is
 * the only thing that can pin it. An untestable correctness fix is one a later edit silently undoes.
 */
export function medianOf(sorted: readonly number[]): number {
	const n = sorted.length;
	if (n === 0) return 0;
	const mid = Math.floor(n / 2);
	return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
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

/**
 * Free parameters per axis in an affine fit — the `[1, x, y]` basis in `mapping.ts`. The affine
 * residual display carries information only when there are MORE control points than this; at
 * exactly this many the fit is determined and every residual is zero by construction.
 */
const AFFINE_PARAMETERS = 3;

/**
 * Least-squares residuals from an affine fit over all the points.
 *
 * Meaningful from `AFFINE_PARAMETERS + 1` points up. At exactly three these are zero for any
 * input whatsoever, which is not a tolerance to widen but a consequence of counting; `diagnose`
 * attaches the caveat.
 */
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
 * Validated against `tpsLooIndependent` in the test suite rather than trusted. If the closed form
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

	// ORDER IS NOT COSMETIC HERE. `trust` in the view shows `notes[0]` verbatim when there is
	// exactly one note, so these run most-invalidating first: the longitude wrap means the fit
	// itself is wrong, the three-point case means the displayed number is uninformative, and the
	// near-collinear case means it is an understatement.
	if (wrapsAntimeridian(points)) {
		notes.push(
			"These control points appear to cross the antimeridian, which Geb does not handle in v1: longitude is treated as a plain coordinate, so the jump from +180 to -180 is read as a real distance and this fit is wrong rather than merely imprecise. Split the map either side of the line, or shift the longitudes into one continuous range.",
		);
	}

	if (points.length <= AFFINE_PARAMETERS) {
		notes.push(
			"Three control points determine an affine fit exactly, so these residuals are zero whatever the coordinates say, a mistyped one included. Add a fourth point before trusting this number.",
		);
	}

	// The second caveat the residuals cannot express. Measured: across a 2,600-fold change in real
	// error at a probe off the line, the affine RMS does not move off the placement-noise floor.
	// So this is reported from the geometry of the points, never inferred from how well the fit
	// reproduces them.
	const ratio = principalAxisRatio(points);
	if (ratio < NEARLY_COLLINEAR_RATIO) {
		notes.push(
			`The control points are nearly collinear (axis ratio ${ratio.toPrecision(2)}), so the fit is poorly determined across the line. Errors there are amplified by far more than the residuals below suggest, and those residuals cannot show it. Add points away from the line.`,
		);
	}

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
	const median = medianOf(errs);
	const worstError = errs[errs.length - 1] ?? 0;
	// TWO CONDITIONS, AND THE SECOND ONE IS NOT PEDANTRY. The ratio alone fires on a MATHEMATICALLY
	// PERFECT fit: an exactly affine map over exact data leaves residuals of pure float noise, and
	// measured on one such fixture the worst was 1.27e-13 px against a median of 5.68e-14 — a ratio
	// of 2.24, comfortably over the threshold. A user with a flawless fit was being told one of
	// their points dominates it. So the outlier must also be big enough to act on: these are
	// hand-placed pixels, and nobody can go and inspect a point whose residual is a fraction of one.
	if (median > 0 && worstError > MASKING_NOTE_FLOOR_PX && worstError > MASKING_NOTE_RATIO * median) {
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
