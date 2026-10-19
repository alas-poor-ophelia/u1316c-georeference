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
