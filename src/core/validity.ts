/**
 * Is this transform meaningful at this point?
 *
 * An affine map is invertible everywhere, but an order-2 polynomial is not injective outside the
 * control-point hull and can fold, and a thin-plate spline extrapolates wildly. A folded fit will
 * happily map a coordinate on the far side of the planet to a pixel inside the image, which is
 * how a coverage query ends up returning a map of Britain for a point in the Pacific.
 *
 * Rather than reason about injectivity per model, test the property directly. The forward and
 * reverse mappings are fitted INDEPENDENTLY from the same control points, so agreement between
 * them is real evidence and not an algebraic identity. Three evaluations, model-agnostic:
 *
 *   1. pixel  = forward(world)
 *   2. world2 = reverse(pixel)
 *   3. pixel2 = forward(world2)      -- so the discrepancy is measured in pixels, not degrees
 *
 * Degrees would be the wrong unit: a degree of longitude is not a fixed distance, so a tolerance
 * expressed in them would be tighter at the equator than at the pole for no principled reason.
 */
import type { Mapping } from "./types";

export interface RoundTrip {
	readonly ok: boolean;
	/** Discrepancy in pixels. */
	readonly error: number;
}

/**
 * Default round-trip tolerance, as a fraction of the image's SMALLER dimension.
 *
 * Calibrated in phase 1 against real fits rather than guessed, and the measurement changed the
 * design twice. Over a 2400x3200 image warped the way a hand-drawn map is, the round-trip error
 * in pixels came out as:
 *
 *            interior   just outside the hull   far side of the planet
 *   affine      0.10            0.31                     74.6
 *   poly2       0.31            4.31                3.6 x 10^6
 *   tps         0.21            2.65                      370
 *
 * First lesson: an absolute pixel count is the wrong shape. A 500-pixel thumbnail and an
 * 8000-pixel scan have no business sharing a threshold, so the tolerance scales with the image.
 *
 * Second, and the reason a guess would have shipped a bug: the first default of 2 pixels REFUSED
 * the just-outside-the-hull column under both the polynomial and the spline. That column is a
 * legitimate query — an Orkney pin on a map whose control points all sit further south — and the
 * design says it must resolve and be MARKED extrapolated, not rejected. 0.5% of 2400 is 12
 * pixels, which clears the legitimate column by about 3x and still rejects the nonsense column by
 * about 30x. The two populations are separated by roughly 85x, so this sits mid-gap on a log
 * scale rather than balanced on a cliff.
 */
export const DEFAULT_ROUND_TRIP_TOLERANCE_FRACTION = 0.005;

/** Absolute round-trip tolerance in pixels for a given image, from the default fraction. */
export function roundTripTolerance(
	size: { readonly width: number; readonly height: number },
	fraction: number = DEFAULT_ROUND_TRIP_TOLERANCE_FRACTION,
): number {
	return fraction * Math.min(size.width, size.height);
}

const scratchA = new Float64Array(2);
const scratchB = new Float64Array(2);
const scratchC = new Float64Array(2);

/**
 * `tolerancePx` is required on purpose. It depends on the image, so a default here could only be
 * a magic number — and the one that was here refused legitimate queries until it was measured.
 * Callers get it from `roundTripTolerance(size)`.
 */
export function roundTrip(
	forward: Mapping,
	reverse: Mapping,
	lat: number,
	lng: number,
	tolerancePx: number,
): RoundTrip {
	scratchA[0] = lat;
	scratchA[1] = lng;
	forward.apply(scratchA, scratchB);
	const px = scratchB[0]!;
	const py = scratchB[1]!;
	if (!Number.isFinite(px) || !Number.isFinite(py)) return { ok: false, error: Number.POSITIVE_INFINITY };

	reverse.apply(scratchB, scratchC);
	if (!Number.isFinite(scratchC[0]!) || !Number.isFinite(scratchC[1]!)) {
		return { ok: false, error: Number.POSITIVE_INFINITY };
	}

	forward.apply(scratchC, scratchB);
	const dx = scratchB[0]! - px;
	const dy = scratchB[1]! - py;
	const error = Math.hypot(dx, dy);
	return { ok: Number.isFinite(error) && error <= tolerancePx, error };
}

/**
 * The same test starting from a pixel, which is what a hover readout has.
 *
 * Only TWO evaluations are needed in this direction, and the discrepancy is already in pixels:
 * reverse to world, forward back to a pixel, compare against where we started.
 *
 * This gate was missing. `toLatLng` carried a comment claiming the inverse direction needed no
 * check because the query already holds a pixel — which is wrong twice over. A pixel outside the
 * image is extrapolating just as much as a far-field coordinate is, and a near-singular fit
 * returns confident finite garbage for a pixel that is perfectly in bounds.
 */
export function roundTripFromPixel(
	forward: Mapping,
	reverse: Mapping,
	x: number,
	y: number,
	tolerancePx: number,
): RoundTrip {
	scratchA[0] = x;
	scratchA[1] = y;
	reverse.apply(scratchA, scratchB);
	if (!Number.isFinite(scratchB[0]!) || !Number.isFinite(scratchB[1]!)) {
		return { ok: false, error: Number.POSITIVE_INFINITY };
	}

	forward.apply(scratchB, scratchC);
	const error = Math.hypot(scratchC[0]! - x, scratchC[1]! - y);
	return { ok: Number.isFinite(error) && error <= tolerancePx, error };
}
