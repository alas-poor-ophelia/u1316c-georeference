/**
 * Core kernel types. Nothing here imports Obsidian — the whole kernel is testable without an app,
 * which is why src/core carries an eslint fence against reaching into the plugin layer.
 *
 * COORDINATE ORDER. Every public array in the kernel is [lat, lng, lat, lng, ...] on the world
 * side and [x, y, x, y, ...] on the pixel side, matching the scalar API so a consumer never meets
 * two different conventions. There is no axis swap anywhere: the fitters in mapping.ts are pure
 * 2D-to-2D and never learn which of the two coordinates is a latitude, so the only requirement is
 * that a given side uses the same order at fit time and at apply time.
 */

export interface LatLng {
	readonly lat: number;
	readonly lng: number;
}

export interface Pixel {
	readonly x: number;
	readonly y: number;
}

/** A user-placed correspondence: this pixel of the image is that place in the world. */
export interface ControlPoint {
	readonly px: number;
	readonly py: number;
	readonly lat: number;
	readonly lng: number;
	readonly label?: string;
}

export type TransformKind = "affine" | "polynomial2" | "tps";

/** The minimum number of control points each model needs before it can be fitted at all. */
export const MIN_POINTS: Readonly<Record<TransformKind, number>> = {
	affine: 3,
	polynomial2: 6,
	tps: 3,
};

/**
 * The number of points below which a model is fittable but not yet meaningful. The UI offers the
 * model and says so, rather than pretending a 3-point spline is doing spline work: with exactly
 * three points a thin-plate spline has only its affine part and IS an affine transform.
 *
 * AFFINE IS 4, NOT 3, and the difference is the whole point of this constant. Three points is the
 * MINIMUM — `MIN_POINTS` says so — but an affine fit has three free parameters per axis, so at
 * exactly three points it reproduces them exactly and its residuals are zero WHATEVER the
 * coordinates say. Measured: one control point's longitude sign-flipped, about 150 km of error,
 * gives an RMS at the float-noise floor at three points (0.0 to about 1e-13 px, depending on the
 * points) against 146 to 199 px at four. Saying "recommended" of a point
 * count at which the trust display cannot see a mistake was the defect; four is the first count
 * where the residual carries information. See the matching note in `residuals.ts`.
 */
export const RECOMMENDED_POINTS: Readonly<Record<TransformKind, number>> = {
	affine: 4,
	polynomial2: 8,
	tps: 8,
};

/**
 * A fitted 2D-to-2D mapping. The batch form is the kernel seam: Float64Array in, Float64Array
 * out, no per-point calls across the boundary, so swapping this layer for WASM later touches
 * one file. `src` and `dst` are interleaved pairs and must be the same length; `dst` is written
 * in place and may not alias `src`.
 */
export interface Mapping {
	readonly kind: TransformKind;
	/** Number of control points the mapping was fitted from. */
	readonly pointCount: number;
	apply(src: Float64Array, dst: Float64Array): void;
}

export interface TransformOptions {
	readonly kind: TransformKind;
	/** Thin-plate spline smoothing. 0 interpolates exactly; larger values approximate. */
	readonly lambda?: number;
}
