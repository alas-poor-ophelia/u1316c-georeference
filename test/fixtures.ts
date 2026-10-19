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
