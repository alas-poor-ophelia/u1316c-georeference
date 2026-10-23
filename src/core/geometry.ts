/**
 * The geometry of the control points themselves, as opposed to the residuals of a fit through them.
 *
 * WHY THIS MODULE EXISTS. Geb had two instruments for telling a user whether to trust a fit — the
 * affine residual and the round-trip validity gate — and a 2026-10-20 review found that BOTH
 * measure self-consistency, so a whole class of real error is invisible to them. The sharpest case
 * is near-collinear control points: six pins strung along a road, with ordinary placement noise,
 * produce an affine residual that reads like a clean fit while a legitimate probe off the line is
 * wrong by many pixels. The forward and reverse fits agree with each other, so the round trip
 * closes; the residuals sit at the placement noise, so the headline number looks fine. Nothing
 * was wrong with either instrument. They simply cannot see it.
 *
 * `SCOPE.md` claims "degenerate geometry throws, it does not answer", and the relative pivot
 * threshold in `linalg.ts` delivers that for EXACTLY collinear points. It does not for nearly
 * collinear ones, and it cannot: partial pivoting makes the surviving pivot a function of the
 * determinant and the row that was swapped in, not of the smallest eigenvalue, so a configuration
 * whose smallest eigenvalue is five orders of magnitude below the threshold is still accepted.
 * Measured, a perpendicular spread of 1e-9 relative is accepted for an affine fit.
 *
 * So the answer is not a tighter threshold — a threshold tight enough to catch this would refuse
 * legitimate maps — but a SECOND, INDEPENDENT quantity that depends on the point configuration and
 * not on how well the fit reproduces it. That is what this file computes. It describes the input;
 * it never refuses it. A historian who pinned six places along a Roman road gets her fit, and gets
 * told what it rests on.
 */
import { fitMapping } from "./mapping";
import { mercatorY } from "./projection";
import type { ControlPoint } from "./types";

/**
 * How round the control-point cloud is: the ratio of its smaller principal spread to its larger,
 * as a length ratio in [0, 1].
 *
 * 1 is an isotropic scatter, 0 is an exact line (or a single repeated point). It is the ratio of
 * the standard deviations along the two principal axes, NOT of the eigenvalues, so it reads as a
 * shape — 0.1 means "ten times longer than it is wide" — rather than as a variance.
 *
 * SCALE AND POSITION INVARIANT BY CONSTRUCTION, which is what makes it the right quantity to
 * report. Translating or uniformly scaling the points leaves it unchanged, so it means the same
 * thing on a town plan and on a continent, and it is unaffected by the Hartley normalisation the
 * fitters apply internally (that normalisation is isotropic, so it cannot change this ratio).
 * Contrast the absolute pivot magnitude, which means nothing without knowing the coordinates.
 *
 * Computed on the WORLD side, in the same `x = lng, y = lat` convention the hull uses, because
 * that is the side whose coordinates the user typed. It is a property of the configuration rather
 * than of either fit direction. For the `mercator` model `diagnose` asks it of `inMercatorPlane`
 * instead, because that is the plane the fit is determined in. The two differ, but not near the
 * threshold on a real map: on the twelve Britain control points, 0.71 raw against 0.50 projected.
 *
 * Returns 1 for fewer than two points: with nothing to compare there is no anisotropy to report,
 * and claiming degeneracy on a single point would be a warning about nothing.
 */
export function principalAxisRatio(points: readonly ControlPoint[]): number {
	const n = points.length;
	if (n < 2) return 1;

	let mx = 0;
	let my = 0;
	for (const p of points) {
		mx += p.lng;
		my += p.lat;
	}
	mx /= n;
	my /= n;

	// Covariance of the cloud. Population rather than sample (divide by n, not n-1): the quantity
	// wanted is the shape of the points in hand, not an estimate of a distribution they came from.
	let cxx = 0;
	let cyy = 0;
	let cxy = 0;
	for (const p of points) {
		const dx = p.lng - mx;
		const dy = p.lat - my;
		cxx += dx * dx;
		cyy += dy * dy;
		cxy += dx * dy;
	}
	cxx /= n;
	cyy /= n;
	cxy /= n;

	// Eigenvalues of a symmetric 2x2, closed form. The discriminant is non-negative in exact
	// arithmetic (a real symmetric matrix has real eigenvalues), so a negative value here is pure
	// float error on a near-circular cloud and clamps to zero rather than producing NaN.
	const trace = cxx + cyy;
	const det = cxx * cyy - cxy * cxy;
	const disc = Math.max(0, trace * trace - 4 * det);
	const root = Math.sqrt(disc);
	const larger = (trace + root) / 2;
	const smaller = (trace - root) / 2;

	// All points coincident. Zero spread in both directions is not a line, but it is at least as
	// degenerate as one, and the fitters will refuse it anyway.
	if (!(larger > 0)) return 0;
	// `smaller` can go very slightly negative for the same float reason as `disc`.
	return Math.sqrt(Math.max(0, smaller) / larger);
}

/**
 * Shift the longitudes into one continuous range, if they are a candidate for being wrapped.
 *
 * Returns `null` when the set is not a candidate at all — narrower than a hemisphere, or already
 * continuous when read around the back. Otherwise it returns the same points with the longitudes
 * before the largest gap moved up by 360°, which is the reading a wrapped region was MEANT to have.
 */
function unwrapLongitudes(points: readonly ControlPoint[]): ControlPoint[] | null {
	const lngs = points.map((p) => p.lng).sort((a, b) => a - b);
	const lo = lngs[0]!;
	const hi = lngs[lngs.length - 1]!;
	// Narrower than a hemisphere cannot be a wrap however it is read.
	if (hi - lo <= 180) return null;

	// The largest gap between neighbours, including the one that straddles the antimeridian. If
	// THAT is the largest, the points already run continuously and there is nothing to unwrap.
	let largestGap = lo + 360 - hi;
	let cutIndex = -1;
	for (let i = 1; i < lngs.length; i++) {
		const gap = lngs[i]! - lngs[i - 1]!;
		if (gap > largestGap) {
			largestGap = gap;
			cutIndex = i - 1;
		}
	}
	if (cutIndex < 0) return null;
	// Removing the largest gap leaves the tightest arc holding every point. Still wider than a
	// hemisphere means this is a genuinely wide map, not a wrap.
	if (360 - largestGap >= 180) return null;

	const cut = lngs[cutIndex]!;
	return points.map((p) => (p.lng <= cut ? { ...p, lng: p.lng + 360 } : p));
}

/** RMS of an affine fit's own control-point residuals, in pixels, or `null` if it cannot fit. */
function affineRms(points: readonly ControlPoint[]): number | null {
	const n = points.length;
	const world = new Float64Array(n * 2);
	const pixel = new Float64Array(n * 2);
	points.forEach((p, i) => {
		world[2 * i] = p.lat;
		world[2 * i + 1] = p.lng;
		pixel[2 * i] = p.px;
		pixel[2 * i + 1] = p.py;
	});
	try {
		const m = fitMapping(world, pixel, { kind: "affine" });
		const out = new Float64Array(n * 2);
		m.apply(world, out);
		let acc = 0;
		for (let i = 0; i < n; i++) {
			const dx = out[2 * i]! - pixel[2 * i]!;
			const dy = out[2 * i + 1]! - pixel[2 * i + 1]!;
			acc += dx * dx + dy * dy;
		}
		return Math.sqrt(acc / n);
	} catch {
		// A degenerate configuration is not evidence of a wrap. It has its own error path.
		return null;
	}
}

/**
 * The same control points with each latitude replaced by its Mercator ordinate, in degrees: the
 * plane the `mercator` model fits in. Longitude, pixels and labels are untouched, so anything
 * written against `ControlPoint` (the axis ratio, an affine RMS) can be asked about that plane.
 */
export function inMercatorPlane(points: readonly ControlPoint[]): ControlPoint[] {
	return points.map((p) => ({ ...p, lat: mercatorY(p.lat) }));
}

/**
 * RMS of an affine fit in the Mercator plane, or `null` if it cannot fit there — including a
 * point past the evaluation limit, whose NaN ordinate the fitter refuses as non-finite. The
 * quantity the Mercator hint in `diagnose` compares against the raw affine RMS.
 */
export function mercatorAffineRms(points: readonly ControlPoint[]): number | null {
	return affineRms(inMercatorPlane(points));
}

/** How much better the unwrapped fit must be before a wrap is the better explanation. */
const WRAP_IMPROVEMENT_FACTOR = 10;
/** And the as-typed fit must be materially broken, not merely imperfect. */
const WRAP_MIN_AS_TYPED_RMS_PX = 1;

/**
 * Whether the control points describe a region that crosses the antimeridian.
 *
 * `SCOPE.md` names longitude wrap as a known v1 limitation and defers handling it, which is a
 * decision rather than an oversight. What was NOT a decision is that it fails silently: an exactly
 * affine map over 170°E to 170°W, with longitudes typed in the usual [-180, 180] form, fits with an
 * affine residual RMS of 347 px and no error, no note, and nothing out of range — the CRS domain
 * check passes both endpoints happily. A limitation a user cannot see is indistinguishable from
 * their own mistake, and Fiji, Chukotka and the Aleutians are real places.
 *
 * ASKED OF THE DATA, NOT GUESSED FROM THE LONGITUDES, and the first version of this function got
 * that wrong in a way worth recording. It reasoned purely about the longitude values: sort them,
 * drop the largest gap, and call it a wrap if the remaining arc is under a hemisphere. That is
 * sound for a DENSE world map and false for a sparse one, because a gap proves nothing about
 * whether the points either side of it are adjacent on the image. Caught by a cross-model review:
 *
 *   world map pinned at its four corners   flagged, affine RMS 0.0 px      FALSE POSITIVE
 *   world map pinned at five real cities   flagged, affine RMS 5.0e-13 px  FALSE POSITIVE
 *
 * Both are perfect fits being told their fit is wrong — the cry-wolf failure this module's own
 * threshold note warns about, on the first input a world-map user would try. Worse, the test that
 * had reassured me used seven points lying on a line in lat/lng, so it could not be fitted at all.
 *
 * The question a gap cannot answer, the fit can: if the longitudes really are wrapped, then reading
 * them as one continuous range makes the map make sense, and a wrapped reading of an ordinary world
 * map makes it nonsense. So fit both ways and compare. A wrap is reported only when the as-typed
 * fit is materially broken AND unwrapping improves it by an order of magnitude. For the 170°E to
 * 170°W case that is 347 px against 0.0 px; for the five-city world map the as-typed fit is already
 * perfect, so there is nothing to improve and nothing is said.
 *
 * Needs four points: at three an affine fit interpolates either reading exactly, so the comparison
 * has no information in it. Reports; never refuses.
 */
export function wrapsAntimeridian(points: readonly ControlPoint[]): boolean {
	if (points.length < 4) return false;
	const unwrapped = unwrapLongitudes(points);
	if (unwrapped === null) return false;

	const asTyped = affineRms(points);
	const rewrapped = affineRms(unwrapped);
	if (asTyped === null || rewrapped === null) return false;

	return asTyped > WRAP_MIN_AS_TYPED_RMS_PX && rewrapped * WRAP_IMPROVEMENT_FACTOR < asTyped;
}

/**
 * The ratio below which a configuration is reported as nearly collinear.
 *
 * MEASURED, NOT GUESSED, the same way the round-trip tolerance was, and the measurement is worth
 * reading because the headline it produced is the reason this module exists. Six pins strung along
 * a 5° line on a 2400x3200 image, 0.3 px of placement noise, 21 seeds, median; probe 0.4° off the
 * line; linear ground truth so the injected noise is the only error present:
 *
 *      perpendicular    axis    affine RMS    probe error    error as a
 *        spread         ratio    DISPLAYED      ACTUAL     multiple of noise
 *          1°          0.54        0.182         0.08            0.3x
 *          0.1°        0.056       0.182         0.46            1.5x
 *          0.03°       0.017       0.182         1.42            4.7x
 *          0.01°       0.0056      0.182         4.34           14.5x
 *          0.003°      0.0017      0.182        14.56           48.5x
 *          0.0003°     0.00017     0.182       209.50          698.3x
 *
 * THE DISPLAYED NUMBER NEVER MOVES. It sits at 0.182 px — the placement-noise floor — while the
 * real error at the probe grows by a factor of 2,600. That is the whole case for measuring the
 * input geometry separately: no tightening of a residual threshold can recover information the
 * residual does not contain.
 *
 * The threshold is placed where the actual error first exceeds the placement noise by more than an
 * order of magnitude: between 0.017 (4.7x) and 0.0056 (14.5x), so mid-gap on a log scale is about
 * 0.01. NOT A CLIFF, and the note's wording must not imply one — at 0.017 the amplification is
 * already 4.7x, so a configuration just above this threshold is not thereby promised anything.
 * It is the point past which saying nothing would be misleading.
 *
 * For reference, 0.01 is a cloud a hundred times longer than it is wide. A map whose pins follow
 * a coastline measures about 0.1 to 0.2; an ordinary scatter measures about 0.5.
 *
 * ONE CAVEAT ON THE NUMBERS ABOVE, raised by review and worth keeping: amplification depends on
 * how far off the line you ask, roughly as offset divided by ratio, and that table probes 0.4° off
 * a 5° line — a relative offset of about 0.08. Ask further off the line and the amplification at a
 * given ratio is larger. So the "order of magnitude" figure is specific to that probe geometry,
 * and this threshold is conservative rather than exact.
 */
export const NEARLY_COLLINEAR_RATIO = 0.01;
