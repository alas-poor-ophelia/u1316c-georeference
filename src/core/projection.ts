/**
 * Map projections the fitters can work through, as composable `{ forward, inverse }` pairs.
 *
 * WHY THIS EXISTS. Every model in mapping.ts is linear (or polynomial, or spline) in the raw
 * lat/lng pair, so a map drawn on Web Mercator carries a systematic error no affine fit can
 * absorb: on the Britain test map an affine fit in lat/lng read 4.3 px RMS over the towns, while
 * an affine fit between Mercator-projected coordinates and pixels is exact from four points. The
 * `mercator` model is that second fit. The projection is a pair rather than a branch inside the
 * fitter so that a later kind can reuse the same wrapper with a different pair.
 *
 * ONLY THE TWO FITTED MAPPINGS SEE THIS. The hull, `extent`, the round-trip gate, coverage and
 * leave-one-out all stay in raw lat/lng, so the projection is an implementation detail of one
 * model and never a second coordinate convention for a caller to learn.
 *
 * Pure: no imports. Longitude passes through unchanged, and the y value is kept in DEGREES (the
 * Mercator ordinate scaled the same way as longitude) so the projected plane is roughly isotropic
 * near the equator and the Hartley normalisation in mapping.ts sees comparable spreads.
 */

/** A projection of interleaved [lat, lng] pairs, and its inverse. */
export interface Projection {
	/** Interleaved [lat, lng] in, a NEW interleaved [y, lng] out; pair order kept. */
	readonly forward: (world: Float64Array) => Float64Array;
	/** In place, [y, lng] back to [lat, lng]. */
	readonly inverse: (proj: Float64Array) => void;
	/** Control points beyond this absolute latitude are refused. */
	readonly controlLat: number;
	/** Queries evaluate up to this absolute latitude; beyond it the forward value is NaN. */
	readonly evalLat: number;
}

/**
 * Web Mercator's tile limit, the latitude at which the square world tile ends. A control point
 * beyond it cannot be on a Web Mercator map at all, so it is refused rather than fitted.
 */
export const MERCATOR_CONTROL_LAT = 85.05112878;

/**
 * Where QUERIES stop evaluating, and deliberately not the same number. A full-world tile's top
 * pixel row unprojects to the tile limit only when the fit is exact; pinned the way a person pins
 * it, at ±85° with pixels rounded to the pixel, a 512 px tile's top row measured 85.061°, above
 * the limit. Refusing evaluation at 85.05 would lose the top edge of every such tile and with it
 * the map's extent. Above 89.9 the ordinate grows without useful meaning (89.9 is already about 400°).
 * The formula cannot be trusted to refuse the pole on its own: the plan's probe read a finite
 * 2139° at 90 where `sin` of the rounded radian value fell just under 1, while Bun measured
 * `atanh(sin)` at exactly 90 as +Infinity. Which one a runtime gives is an accident of rounding,
 * so the guard is explicit and returns NaN whatever the formula would have said.
 */
export const MERCATOR_EVAL_LAT = 89.9;

const RAD = Math.PI / 180;

/**
 * The Mercator ordinate of a latitude, in degrees. NaN when |lat| > `MERCATOR_EVAL_LAT`.
 *
 * `atanh(sin(lat))` rather than the textbook `ln(tan(pi/4 + lat/2))`, which is the same function
 * in exact arithmetic but returns -6.36e-15 at the equator; this form returns exactly 0 there, so
 * an equatorial control point projects to where it is.
 */
export function mercatorY(latDeg: number): number {
	if (!(Math.abs(latDeg) <= MERCATOR_EVAL_LAT)) return Number.NaN;
	return Math.atanh(Math.sin(latDeg * RAD)) / RAD;
}

/** The latitude of a Mercator ordinate given in degrees. The exact inverse of `mercatorY`. */
export function mercatorLat(yDeg: number): number {
	return Math.atan(Math.sinh(yDeg * RAD)) / RAD;
}

/** Interleaved [lat, lng] to a new interleaved [y, lng]. One allocation per batch. */
export function projectWorld(world: Float64Array): Float64Array {
	const out = new Float64Array(world.length);
	for (let i = 0; i + 1 < world.length; i += 2) {
		out[i] = mercatorY(world[i]!);
		out[i + 1] = world[i + 1]!;
	}
	return out;
}

/** In place, interleaved [y, lng] back to [lat, lng]. */
export function unprojectWorld(proj: Float64Array): void {
	for (let i = 0; i + 1 < proj.length; i += 2) proj[i] = mercatorLat(proj[i]!);
}

export const MERCATOR: Projection = {
	forward: projectWorld,
	inverse: unprojectWorld,
	controlLat: MERCATOR_CONTROL_LAT,
	evalLat: MERCATOR_EVAL_LAT,
};
