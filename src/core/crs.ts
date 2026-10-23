/**
 * A coordinate reference system, as a record Geb owns rather than an EPSG code.
 *
 * The EPSG registry is Earth-only, so letting an EPSG code be the only way to NAME a system
 * would make a fictional world a special case forever. proj4js can still sit underneath as the
 * projection engine — it accepts PROJ strings with custom `+a`/`+b` axes, so an arbitrary sphere
 * is expressible — but the naming and the body parameters live here.
 *
 * v1 carries a sphere radius only. Flattening belongs with a geodesic distance implementation,
 * and the two ship together or not at all: a record that advertises flattening while the only
 * distance function is great-circle is a field nothing reads.
 */

export interface Crs {
	readonly id: string;
	readonly name: string;
	/** Sphere radius, in `distanceUnit`. */
	readonly radius: number;
	readonly distanceUnit: string;
	/** Inclusive bounds of the latitude-like axis. */
	readonly latRange: readonly [number, number];
	/** Inclusive bounds of the longitude-like axis. */
	readonly lngRange: readonly [number, number];
	/**
	 * What the source map's own projection is, where known. `unknown` lets the spline absorb it.
	 *
	 * DECLARATIVE ONLY — THE FITTERS DO NOT READ THIS FIELD. The way to fit a Mercator source
	 * exactly is the `"mercator"` transform kind, which the user picks per map; it does not
	 * consult `projection`, and anything that registers a non-equirectangular CRS still has to
	 * deal with that. The other models are linear (or polynomial, or spline) in the raw lat/lng
	 * pair, so a genuinely Mercator source fitted by them carries a systematic error that grows
	 * with the latitude span, and that error is why the kind exists. Measured over 200 interior
	 * points on a 4,000 px image, worst error:
	 *
	 *       latitude span     affine     polynomial2     tps
	 *       49-52°             44 px        1.3 px       48 px
	 *       40-60°            166 px         34 px       77 px
	 *       20-70°            415 px        154 px       67 px
	 *
	 * The spline absorbs the curvature given enough points, which is what `unknown` is for; the
	 * affine and order-2 models do not. The sharp edge is diagnostic rather than numerical: the
	 * affine residual display would report that systematic error as if the user had mistyped a
	 * coordinate, because it cannot tell a projection mismatch from a bad point.
	 *
	 * This is UNREACHABLE TODAY and deliberately not guarded: `BUILT_IN` ships only `EARTH`, whose
	 * projection is `equirectangular`, so a warning would be code that nothing can trigger. The
	 * note is here rather than in a changelog because whoever adds the second CRS needs it, and
	 * `diagnose` has no access to a CRS to raise it from.
	 */
	readonly projection: "equirectangular" | "mercator" | "unknown";
}

/** Mean Earth radius (IUGG), in metres. */
export const EARTH_MEAN_RADIUS_M = 6_371_008.8;

export const EARTH: Crs = {
	id: "earth",
	name: "Earth",
	radius: EARTH_MEAN_RADIUS_M,
	distanceUnit: "m",
	latRange: [-90, 90],
	lngRange: [-180, 180],
	projection: "equirectangular",
};

const BUILT_IN: readonly Crs[] = [EARTH];

export function listCrs(): readonly Crs[] {
	return BUILT_IN;
}

export function getCrs(id: string): Crs | null {
	return BUILT_IN.find((c) => c.id === id) ?? null;
}

/** Whether a coordinate lies inside the CRS's declared angular domain. */
export function inDomain(crs: Crs, lat: number, lng: number): boolean {
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
	const [latLo, latHi] = crs.latRange;
	const [lngLo, lngHi] = crs.lngRange;
	return lat >= latLo && lat <= latHi && lng >= lngLo && lng <= lngHi;
}
