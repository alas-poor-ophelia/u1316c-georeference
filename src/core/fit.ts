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
import { InvalidInputError } from "./errors";
import { convexHull, inHull, type Vec2 } from "./hull";
import { fitMapping } from "./mapping";
import { MERCATOR_CONTROL_LAT } from "./projection";
import { diagnose, type Diagnostics } from "./residuals";
import { MIN_POINTS, type ControlPoint, type LatLng, type Mapping, type TransformKind, type TransformOptions } from "./types";
import { roundTrip, roundTripFromPixel, roundTripTolerance } from "./validity";

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
	/**
	 * The same hull as {x: lng, y: lat}, precomputed. `toPixel` and `toLatLng` run once per pin
	 * per render and once per mouse-move for a hover readout, and they previously rebuilt this
	 * array on every call.
	 */
	readonly hullXY: readonly Vec2[];
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

/**
 * Validate at the boundary, naming the offending control point.
 *
 * The fitters reject non-finite coordinates too, but they only know array indices. A user who
 * mistyped a latitude wants to be told which place it was, not "source coordinate 11".
 */
function validate(points: readonly ControlPoint[], opts: TransformOptions): void {
	if (!(opts.kind in MIN_POINTS)) {
		throw new InvalidInputError(`unknown transform model: ${JSON.stringify(opts.kind)}`);
	}
	points.forEach((p, i) => {
		const where = p.label === undefined ? `control point ${i}` : `control point ${i} (${p.label})`;
		for (const [name, v] of [["px", p.px], ["py", p.py], ["lat", p.lat], ["lng", p.lng]] as const) {
			if (!Number.isFinite(v)) throw new InvalidInputError(`${where} has a non-finite ${name}: ${v}`);
		}
		// A point past the tile limit cannot be ON a Web Mercator map, so it is a typo or the wrong
		// model, and fitting it would anchor the affine to an ordinate that grows without bound.
		if (opts.kind === "mercator" && Math.abs(p.lat) > MERCATOR_CONTROL_LAT) {
			throw new InvalidInputError(
				`${where} has latitude ${p.lat}, beyond the Mercator model's limit of ±${MERCATOR_CONTROL_LAT}°`,
			);
		}
	});
}

export function buildFit(
	points: readonly ControlPoint[],
	opts: TransformOptions,
	bounds: PixelBounds | null = null,
): Fit {
	validate(points, opts);
	const world = new Float64Array(points.length * 2);
	const pixel = new Float64Array(points.length * 2);
	points.forEach((p, i) => {
		world[2 * i] = p.lat;
		world[2 * i + 1] = p.lng;
		pixel[2 * i] = p.px;
		pixel[2 * i + 1] = p.py;
	});

	const hullXY = convexHull(points.map((p) => ({ x: p.lng, y: p.lat })));

	// Diagnostics are computed on first access, not at fit time, and then memoised.
	//
	// Measured 2026-10-20 on one dev box, 300-point spline: 189 ms to fit, a further 110 ms on
	// the first read of `diagnostics` — an affine fit plus a leave-one-out matrix inversion. The
	// absolute numbers are machine-dependent and have been quoted three different ways in this
	// repo; the STABLE claim is the ratio. Diagnosing costs roughly as much again as fitting, and
	// the coverage layer builds a fit for every georeference in the vault while never reading
	// diagnostics at all — so eagerly diagnosing spent about a third of the index build on numbers
	// nobody looked at. A getter keeps the interface identical.
	let cached: Diagnostics | null = null;

	return {
		kind: opts.kind,
		points: [...points],
		forward: fitMapping(world, pixel, opts, "forward"),
		reverse: fitMapping(pixel, world, opts, "reverse"),
		hull: hullXY.map((v) => ({ lat: v.y, lng: v.x })),
		hullXY,
		bounds,
		get diagnostics(): Diagnostics {
			cached ??= diagnose(points, opts);
			return cached;
		},
	};
}

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
		extrapolated: !inHull(fit.hullXY, { x: lng, y: lat }),
	};
}

/**
 * Pixel to world, gated the same way.
 *
 * An earlier version of this skipped the gate on the reasoning that the query already holds a
 * pixel. That was wrong twice: a pixel outside the image extrapolates exactly as a far-field
 * coordinate does, and a near-singular fit returns confident finite garbage for a pixel that is
 * perfectly in bounds. From this direction the test needs only two evaluations.
 */
export function toLatLng(
	fit: Fit,
	x: number,
	y: number,
	size: ImageSize,
	tolerancePx: number = roundTripTolerance(size),
): WorldResult | null {
	if (!roundTripFromPixel(fit.forward, fit.reverse, x, y, tolerancePx).ok) return null;

	const src = new Float64Array([x, y]);
	const dst = new Float64Array(2);
	fit.reverse.apply(src, dst);
	const lat = dst[0]!;
	const lng = dst[1]!;
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	return { lat, lng, extrapolated: !inHull(fit.hullXY, { x: lng, y: lat }) };
}

/**
 * The extent of a fit: its image corners carried into world space. Coverage is what the map
 * PICTURES, not what its control points happen to span — a user who pinned four places in the
 * south still has a map of the whole island.
 *
 * GATED, like `toPixel` and `toLatLng`, and it was not: it checked only that each corner came back
 * finite. A folded order-2 polynomial returns finite garbage, so a corner could confidently name
 * the wrong place as plain data with no way for a caller to tell.
 *
 * READ THIS BEFORE TRUSTING A RESULT. PASSING THE GATE IS NOT AN ACCURACY CLAIM. The round trip
 * measures whether the forward and reverse fits AGREE WITH EACH OTHER, and image corners are far
 * outside the control-point hull by construction, so they are extrapolation whatever the gate
 * says. Measured on the shared eight-point fixture, against a 12 px tolerance, with the true
 * corner position recovered by inverting the ground truth:
 *
 *     model          verdict      round-trip error (px)        TRUE error (px)
 *     affine         accepted      2.9  3.4  2.9  3.5      31.1  49.7  66.7  10.8
 *     tps            REFUSED      12.4 17.8 14.3 13.0      70.4  42.7  30.7  14.9
 *     polynomial2    REFUSED      41.3 18.4 15.9  5.1     258.8  80.4  86.0  58.7
 *
 * The affine corners this ACCEPTS are up to 67 px wrong — no better than the spline corners it
 * refuses. An affine map is self-consistent everywhere, so the gate cannot see its extrapolation
 * error at all. What the gate genuinely buys is the bottom row: it rejects the folded polynomial
 * whose corner is 259 px and 1.8° of latitude out. That is worth having, and it is the whole of
 * what is being claimed.
 *
 * IN PRACTICE, THEREFORE, THIS IS LARGELY AFFINE-ONLY. Measured over nine random control points
 * under a non-linear truth, the proportion returning `null`: a spline 52% when the points cover
 * 90% of the image, 21% at 60% and 1% at 40%; an order-2 polynomial 96% to 100% throughout. A
 * caller wanting an extent for a spline over clustered points should expect to handle `null`
 * routinely rather than exceptionally.
 *
 * Nothing consumed this function when the gate was added — the coverage layer deliberately goes
 * through `toPixel`, which was already gated — so the risk being managed was what the NEXT
 * consumer would have trusted. Retaining the refusal also keeps one gate across every answer the
 * kernel gives, which is worth more than a corner-specific tolerance nobody has calibrated: the
 * 12 px figure comes from "just outside the hull" queries, and corners are a different population.
 */
export function extent(
	fit: Fit,
	size: ImageSize,
	tolerancePx: number = roundTripTolerance(size),
): LatLng[] | null {
	const b = fit.bounds;
	const x0 = b?.x ?? 0;
	const y0 = b?.y ?? 0;
	const x1 = b === null ? size.width : b.x + b.width;
	const y1 = b === null ? size.height : b.y + b.height;

	const corners: readonly (readonly [number, number])[] = [
		[x0, y0],
		[x1, y0],
		[x1, y1],
		[x0, y1],
	];

	const out: LatLng[] = [];
	for (const [x, y] of corners) {
		// Starting from a pixel, so this is the two-evaluation form and the discrepancy is already
		// measured in pixels.
		if (!roundTripFromPixel(fit.forward, fit.reverse, x, y, tolerancePx).ok) return null;
		const src = new Float64Array([x, y]);
		const dst = new Float64Array(2);
		fit.reverse.apply(src, dst);
		const lat = dst[0]!;
		const lng = dst[1]!;
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
		out.push({ lat, lng });
	}
	return out;
}
