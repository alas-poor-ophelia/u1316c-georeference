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
	/** What the source map's own projection is, where known. `unknown` lets the spline absorb it. */
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
