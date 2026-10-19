/**
 * A fit: one transform model over one set of control points, in both directions.
 *
 * The reverse mapping is fitted independently from the same points, by calling the same fitter
 * with the arguments swapped. That is cheap, it is what GDAL does, and it is what makes the
 * round-trip validity test real evidence rather than an algebraic identity.
 *
 * A georeference holds a LIST of these — one image file can contain more than one picture, and a
 * sheet with an inset needs two unrelated transforms over two pixel areas. v1 fills the list with
 * exactly one entry whose bounds are the whole image.
 */
import { convexHull, inHull } from "./hull";
import { fitMapping } from "./mapping";
import { diagnose, type Diagnostics } from "./residuals";
import type { ControlPoint, LatLng, Mapping, TransformKind, TransformOptions } from "./types";
import { roundTrip, roundTripTolerance } from "./validity";

export interface ImageSize {
	readonly width: number;
	readonly height: number;
}

/** Pixel bounds of a fit within its image. `null` means the whole image. */
export interface PixelBounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface Fit {
	readonly kind: TransformKind;
	readonly points: readonly ControlPoint[];
	/** [lat, lng, ...] -> [x, y, ...] */
	readonly forward: Mapping;
	/** [x, y, ...] -> [lat, lng, ...] */
	readonly reverse: Mapping;
	/** Convex hull of the control points, in world space. Inside it the fit interpolates. */
	readonly hull: readonly LatLng[];
	readonly bounds: PixelBounds | null;
	readonly diagnostics: Diagnostics;
}

export interface PixelResult {
	readonly x: number;
	readonly y: number;
	/** Inside the image rectangle (or the fit's bounds, where set). */
	readonly inBounds: boolean;
	/** Outside the control-point hull: resolved, but extrapolated and so fuzzy. */
	readonly extrapolated: boolean;
}

export interface WorldResult {
	readonly lat: number;
	readonly lng: number;
	readonly extrapolated: boolean;
}

export function buildFit(
	points: readonly ControlPoint[],
	opts: TransformOptions,
	bounds: PixelBounds | null = null,
): Fit {
	const world = new Float64Array(points.length * 2);
	const pixel = new Float64Array(points.length * 2);
	points.forEach((p, i) => {
		world[2 * i] = p.lat;
		world[2 * i + 1] = p.lng;
		pixel[2 * i] = p.px;
		pixel[2 * i + 1] = p.py;
	});

	return {
		kind: opts.kind,
		points: [...points],
		forward: fitMapping(world, pixel, opts),
		reverse: fitMapping(pixel, world, opts),
		hull: convexHull(points.map((p) => ({ x: p.lng, y: p.lat }))).map((v) => ({ lat: v.y, lng: v.x })),
		bounds,
		diagnostics: diagnose(points, opts),
	};
}

const hullVerts = (fit: Fit): { x: number; y: number }[] => fit.hull.map((h) => ({ x: h.lng, y: h.lat }));

function withinBounds(fit: Fit, size: ImageSize, x: number, y: number): boolean {
	const b = fit.bounds;
	if (b === null) return x >= 0 && y >= 0 && x <= size.width && y <= size.height;
	return x >= b.x && y >= b.y && x <= b.x + b.width && y <= b.y + b.height;
}

/**
 * World to pixel. Returns null when the transform is not meaningful at this coordinate — a folded
 * order-2 polynomial or wild spline extrapolation fails the round trip and is refused rather than
 * silently returning a plausible-looking pixel.
 */
export function toPixel(
	fit: Fit,
	lat: number,
	lng: number,
	size: ImageSize,
	tolerancePx: number = roundTripTolerance(size),
): PixelResult | null {
	const trip = roundTrip(fit.forward, fit.reverse, lat, lng, tolerancePx);
	if (!trip.ok) return null;

	const src = new Float64Array([lat, lng]);
	const dst = new Float64Array(2);
	fit.forward.apply(src, dst);
	const x = dst[0]!;
	const y = dst[1]!;
	return {
		x,
		y,
		inBounds: withinBounds(fit, size, x, y),
		extrapolated: !inHull(hullVerts(fit), { x: lng, y: lat }),
	};
}

/** Pixel to world. The inverse direction needs no round-trip gate: the query already has a pixel. */
export function toLatLng(fit: Fit, x: number, y: number): WorldResult | null {
	const src = new Float64Array([x, y]);
	const dst = new Float64Array(2);
	fit.reverse.apply(src, dst);
	const lat = dst[0]!;
	const lng = dst[1]!;
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	return { lat, lng, extrapolated: !inHull(hullVerts(fit), { x: lng, y: lat }) };
}

/**
 * The extent of a fit: its image corners carried into world space. Coverage is what the map
 * PICTURES, not what its control points happen to span — a user who pinned four places in the
 * south still has a map of the whole island. Returns null if any corner fails to invert.
 */
export function extent(fit: Fit, size: ImageSize): LatLng[] | null {
	const b = fit.bounds;
	const x0 = b?.x ?? 0;
	const y0 = b?.y ?? 0;
	const x1 = b === null ? size.width : b.x + b.width;
	const y1 = b === null ? size.height : b.y + b.height;

	const src = new Float64Array([x0, y0, x1, y0, x1, y1, x0, y1]);
	const dst = new Float64Array(8);
	fit.reverse.apply(src, dst);
	const out: LatLng[] = [];
	for (let i = 0; i < 4; i++) {
		const lat = dst[2 * i]!;
		const lng = dst[2 * i + 1]!;
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
		out.push({ lat, lng });
	}
	return out;
}
