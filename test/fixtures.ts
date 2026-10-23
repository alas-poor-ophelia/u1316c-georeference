/**
 * Shared fixture: eight places across Britain, with pixel positions generated from a known
 * ground-truth transform.
 *
 * The pixel coordinates are DERIVED, not pinned from memory. That matters: a hand-typed expected
 * value is a guess dressed as an oracle, and the thing under test here is the fitting mathematics,
 * not anybody's recall of where York sits on a particular scan. The latitudes and longitudes only
 * need to be plausibly British, because `truth` is what defines the correct answer.
 *
 * `truth` is deliberately NON-LINEAR — a gentle warp of the sort a hand-drawn map has. That is
 * what makes the affine and spline tests say different things: an affine fit cannot absorb the
 * warp and so has honest non-zero residuals, while a thin-plate spline interpolates it exactly.
 */
import type { ControlPoint } from "../src/core/types";

export interface Place {
	readonly label: string;
	readonly lat: number;
	readonly lng: number;
}

export const PLACES: readonly Place[] = [
	{ label: "London", lat: 51.51, lng: -0.13 },
	{ label: "Eboracum", lat: 53.96, lng: -1.08 },
	{ label: "Edinburgh", lat: 55.95, lng: -3.19 },
	{ label: "Cardiff", lat: 51.48, lng: -3.18 },
	{ label: "Norwich", lat: 52.63, lng: 1.3 },
	{ label: "Exeter", lat: 50.72, lng: -3.53 },
	{ label: "Carlisle", lat: 54.89, lng: -2.93 },
	{ label: "Aberdeen", lat: 57.15, lng: -2.09 },
];

export const IMAGE = { width: 2400, height: 3200 } as const;

/** The ground truth this fixture is built from: an equirectangular base plus a gentle warp. */
export function truth(lat: number, lng: number): [number, number] {
	const x = (lng + 8) * 200;
	const y = (60 - lat) * 300;
	return [x + 30 * Math.sin(y / 400), y + 20 * Math.cos(x / 500)];
}

/** A purely linear ground truth, for the tests that need an affine fit to be exact. */
export function linearTruth(lat: number, lng: number): [number, number] {
	return [(lng + 8) * 200, (60 - lat) * 300];
}

/**
 * The Mercator ordinate in degrees by the TEXTBOOK route, `ln(tan(pi/4 + lat/2))`, and not by
 * importing `mercatorY`. The kernel uses `atanh(sin(lat))`; the two agree in exact arithmetic, so a
 * fixture built from a different formulation still checks the kernel's formula rather than
 * agreeing with it by construction (a fixture that imports the code under test cannot catch a
 * mistake in it).
 */
function textbookMercatorY(lat: number): number {
	const r = Math.PI / 180;
	return Math.log(Math.tan(Math.PI / 4 + (lat * r) / 2)) / r;
}

/** A Web Mercator ground truth: affine in the Mercator plane, so the `mercator` model is exact. */
export function mercatorTruth(lat: number, lng: number): [number, number] {
	return [(lng + 8) * 200, (textbookMercatorY(60) - textbookMercatorY(lat)) * 300];
}

function build(places: readonly Place[], f: (lat: number, lng: number) => [number, number]): ControlPoint[] {
	return places.map((p) => {
		const [px, py] = f(p.lat, p.lng);
		return { px, py, lat: p.lat, lng: p.lng, label: p.label };
	});
}

/** Eight clean control points under the warped truth. */
export const CLEAN: readonly ControlPoint[] = build(PLACES, truth);

/** The same eight under a purely linear truth. */
export const CLEAN_LINEAR: readonly ControlPoint[] = build(PLACES, linearTruth);

/** The same eight under a Web Mercator truth. */
export const CLEAN_MERCATOR: readonly ControlPoint[] = build(PLACES, mercatorTruth);

/**
 * The twelve control points of the Britain test map, a 622 x 718 px Web Mercator render: the four
 * ends of Hadrian's and the Antonine walls, then coastal capes. Public coordinates, copied as
 * literals from the hand-verified georeference; no image is needed to use them.
 *
 * The pixels are where the map's RECOVERED transform puts each coordinate, rounded to the pixel.
 * That transform was found by snapping a coastline to the painted coast, so a test against these
 * checks CONSISTENCY WITH THAT RECOVERY, not ground truth. `CLEAN_MERCATOR` is the exact case.
 */
export const BRITAIN_12: readonly ControlPoint[] = [
	{ px: 352, py: 364, lat: 54.953, lng: -3.213, label: "Bowness-on-Solway" },
	{ px: 422, py: 361, lat: 54.988, lng: -1.532, label: "Wallsend" },
	{ px: 299, py: 293, lat: 55.924, lng: -4.463, label: "Old Kilpatrick" },
	{ px: 337, py: 286, lat: 56.015, lng: -3.572, label: "Carriden" },
	{ px: 247, py: 698, lat: 50.066, lng: -5.716, label: "Land's End" },
	{ px: 528, py: 642, lat: 50.914, lng: 0.976, label: "Dungeness" },
	{ px: 548, py: 612, lat: 51.375, lng: 1.447, label: "North Foreland" },
	{ px: 561, py: 537, lat: 52.481, lng: 1.762, label: "Ness Point" },
	{ px: 483, py: 423, lat: 54.117, lng: -0.082, label: "Flamborough Head" },
	{ px: 359, py: 83, lat: 58.644, lng: -3.023, label: "Duncansby Head" },
	{ px: 276, py: 84, lat: 58.627, lng: -4.998, label: "Cape Wrath" },
	{ px: 264, py: 577, lat: 51.907, lng: -5.316, label: "St David's Head" },
];

/** The first four of `BRITAIN_12`: the two ends of each wall. */
export const BRITAIN_WALL_ENDS: readonly ControlPoint[] = BRITAIN_12.slice(0, 4);

/**
 * Twenty-nine Roman towns on the same map, none of them a control point, with the pixel the
 * recovered transform puts each at (to 0.1 px). Held out, so they measure a fit between its
 * control points. The same caveat as `BRITAIN_12`: consistency with the recovery, not truth.
 */
export const BRITAIN_TOWNS: readonly (Place & { readonly px: number; readonly py: number })[] = [
	{ label: "Londinium", lat: 51.5126, lng: -0.0913, px: 483.2, py: 602.7 },
	{ label: "Eboracum", lat: 53.9591, lng: -1.0815, px: 441.4, py: 434.6 },
	{ label: "Lindum", lat: 53.235, lng: -0.538, px: 464.3, py: 485.3 },
	{ label: "Deva", lat: 53.191, lng: -2.891, px: 365.5, py: 488.6 },
	{ label: "Isca Dumnoniorum", lat: 50.723, lng: -3.531, px: 338.9, py: 655.2 },
	{ label: "Camulodunum", lat: 51.89, lng: 0.903, px: 524.9, py: 577.3 },
	{ label: "Glevum", lat: 51.865, lng: -2.244, px: 392.8, py: 579.2 },
	{ label: "Luguvalium", lat: 54.895, lng: -2.938, px: 363.4, py: 367.8 },
	{ label: "Corinium", lat: 51.719, lng: -1.968, px: 404.4, py: 589.0 },
	{ label: "Verulamium", lat: 51.75, lng: -0.355, px: 472.1, py: 586.8 },
	{ label: "Durovernum", lat: 51.28, lng: 1.08, px: 532.4, py: 618.1 },
	{ label: "Dubris", lat: 51.128, lng: 1.313, px: 542.2, py: 628.2 },
	{ label: "Aquae Sulis", lat: 51.381, lng: -2.359, px: 388.0, py: 611.6 },
	{ label: "Venta Belgarum", lat: 51.063, lng: -1.308, px: 432.2, py: 632.7 },
	{ label: "Noviomagus", lat: 50.836, lng: -0.78, px: 454.4, py: 647.6 },
	{ label: "Ratae", lat: 52.635, lng: -1.137, px: 439.2, py: 526.8 },
	{ label: "Viroconium", lat: 52.673, lng: -2.649, px: 375.7, py: 524.3 },
	{ label: "Isca Augusta", lat: 51.609, lng: -2.955, px: 363.0, py: 596.4 },
	{ label: "Moridunum", lat: 51.857, lng: -4.308, px: 306.2, py: 579.9 },
	{ label: "Segontium", lat: 53.139, lng: -4.265, px: 307.8, py: 492.3 },
	{ label: "Mamucium", lat: 53.477, lng: -2.252, px: 392.3, py: 468.6 },
	{ label: "Cataractonium", lat: 54.386, lng: -1.642, px: 417.8, py: 404.3 },
	{ label: "Trimontium", lat: 55.6, lng: -2.69, px: 373.7, py: 316.4 },
	{ label: "Coria", lat: 54.973, lng: -2.021, px: 401.8, py: 362.1 },
	{ label: "Vindolanda", lat: 54.991, lng: -2.36, px: 387.6, py: 360.8 },
	{ label: "Petuaria", lat: 53.728, lng: -0.573, px: 462.8, py: 450.9 },
	{ label: "Durnovaria", lat: 50.715, lng: -2.437, px: 384.8, py: 655.7 },
	{ label: "Venta Icenorum", lat: 52.584, lng: 1.293, px: 541.2, py: 530.1 },
	{ label: "Durobrivae", lat: 52.561, lng: -0.37, px: 471.4, py: 531.8 },
];

/** The Britain test map's size, for the round-trip tolerance. */
export const BRITAIN_IMAGE = { width: 622, height: 718 } as const;

/**
 * Index of the point corrupted in `TYPO`. Eboracum is interior to the hull on purpose: an
 * interior point is the case leave-one-out is supposed to handle well, so if the affine display
 * fails to catch it there is nowhere left to hide.
 */
export const TYPO_INDEX = 1;

/**
 * The same eight points with one realistic mistake: Eboracum's longitude sign flipped, -1.08 to
 * +1.08. The pixel position stays where the correct coordinate put it, which is exactly what
 * happens when a user types the coordinate wrongly after clicking the right spot.
 */
export const TYPO: readonly ControlPoint[] = CLEAN.map((p, i) =>
	i === TYPO_INDEX ? { ...p, lng: -p.lng } : p,
);

/** Deterministic pseudo-random, so a generated fixture is reproducible across runs. */
function rng(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 1664525 + 1013904223) % 4294967296;
		return s / 4294967296;
	};
}

/**
 * `n` control points scattered over Britain with jittered pixel positions, so the data is not
 * exactly representable and a smoothing term has work to do. Used to check that the spline's
 * lambda means roughly the same thing at different control-point counts.
 */
export function jittered(n: number, seed = 12345): ControlPoint[] {
	const r = rng(seed);
	return Array.from({ length: n }, () => {
		const lat = 50 + r() * 8;
		const lng = -7 + r() * 8;
		const [x, y] = truth(lat, lng);
		return { px: x + (r() - 0.5) * 20, py: y + (r() - 0.5) * 20, lat, lng };
	});
}

/**
 * Four exactly collinear control points. Taken from the adversarial review that found the
 * singularity check: before the pivot threshold became relative, these built "successfully" and
 * a probe mapped to x=54.98 under affine and x=51.01 under the spline — two wrong answers that
 * disagreed with each other, and which nothing downstream could catch, because the garbage
 * forward and reverse fits were consistent with each other.
 */
export const COLLINEAR: readonly ControlPoint[] = Array.from({ length: 4 }, (_, i) => ({
	px: 37.3 * i + 11.1,
	py: 91.7 * i + 5.3,
	lat: 0.17 * i + 3.3,
	lng: 0.09 * i + 7.7,
}));
