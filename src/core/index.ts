/**
 * The transform kernel's public surface.
 *
 * Pure TypeScript, no Obsidian imports — an eslint fence in eslint.config.mjs keeps it that way,
 * which is what lets the whole kernel be driven by tests without an app. This is also the
 * swappable boundary: the batch entry points take and return Float64Array with no per-point calls
 * across the seam, so if a raster-warp kernel ever justifies WASM it replaces mapping.ts alone.
 */
export { EARTH, EARTH_MEAN_RADIUS_M, getCrs, inDomain, listCrs, type Crs } from "./crs";
export {
	buildFit,
	extent,
	toLatLng,
	toPixel,
	type Fit,
	type ImageSize,
	type PixelBounds,
	type PixelResult,
	type WorldResult,
} from "./fit";
export { convexHull, inHull, type Vec2 } from "./hull";
export { FitError, fitMapping, TpsMapping } from "./mapping";
export {
	affineResiduals,
	diagnose,
	tpsLooBruteForce,
	tpsLooRippa,
	type Diagnostics,
	type PointResidual,
} from "./residuals";
export {
	MIN_POINTS,
	RECOMMENDED_POINTS,
	type ControlPoint,
	type LatLng,
	type Mapping,
	type Pixel,
	type TransformKind,
	type TransformOptions,
} from "./types";
export { DEFAULT_ROUND_TRIP_TOLERANCE_FRACTION, roundTrip, roundTripTolerance, type RoundTrip } from "./validity";
export { SingularMatrixError } from "./linalg";
