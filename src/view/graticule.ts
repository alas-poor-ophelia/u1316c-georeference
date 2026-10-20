/**
 * Choosing graticule lines — the lat/lng grid drawn over the map.
 *
 * WHY THIS IS IN v1 AT ALL. It is the cheapest way for a user to SEE whether a fit is sane. A
 * residual table says 3.4 pixels; a graticule that bows, crosses itself or runs diagonally says
 * "this spline is folded" at a glance, and nobody has to trust a number they cannot check.
 *
 * The only real decision is SPACING, and it is a decision rather than a constant: one line per
 * degree is unreadable on a world map and useless on a town plan. So the spacing is picked from a
 * fixed ladder of intervals a map reader recognises — degrees, then the sexagesimal steps, since
 * 0.25° is a quarter degree but 15' is a quarter a cartographer reads without converting.
 */
import type { LatLng } from "../api/types";

/**
 * The ladder, in degrees, coarse to fine.
 *
 * Sexagesimal below one degree on purpose: 0.5, 0.25 and 0.0833 are 30', 15' and 5', which read
 * as round numbers on a map where 0.3 and 0.1 do not.
 */
const STEPS: readonly number[] = [
	45, 30, 20, 15, 10, 5, 2, 1,
	30 / 60, 20 / 60, 15 / 60, 10 / 60, 5 / 60, 2 / 60, 1 / 60,
	30 / 3600, 15 / 3600, 10 / 3600, 5 / 3600, 1 / 3600,
];

/**
 * The coarsest step that still puts at least `want` lines across `span` degrees.
 *
 * Coarsest rather than closest, because a graticule that is too dense is worse than one that is
 * too sparse: it hides the map it is drawn over.
 */
export function chooseStep(span: number, want = 4): number {
	if (!Number.isFinite(span) || span <= 0) return STEPS[STEPS.length - 1]!;
	for (const step of STEPS) {
		if (span / step >= want) return step;
	}
	// Finer than an arcsecond — a plan of a single building. Divide the span instead of pretending
	// one of the ladder's steps fits.
	return span / want;
}

/**
 * Every multiple of `step` inside [lo, hi], inclusive.
 *
 * Multiplied back from an integer index rather than accumulated, because repeated addition of
 * 1/60 drifts: by the time it crosses a degree the line is visibly off the label it carries.
 */
export function ticks(lo: number, hi: number, step: number): number[] {
	if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(step > 0) || hi < lo) return [];
	const first = Math.ceil(lo / step);
	const last = Math.floor(hi / step);
	// A span far wider than the step would produce an unbounded list on a degenerate input.
	if (last - first > 10_000) return [];
	const out: number[] = [];
	for (let i = first; i <= last; i++) out.push(i * step);
	return out;
}

export interface Graticule {
	readonly step: number;
	readonly lats: readonly number[];
	readonly lngs: readonly number[];
}

/**
 * The grid for a visible world region.
 *
 * ONE STEP FOR BOTH AXES, because cells that are not square destroy the very cue the graticule
 * exists to give — a bowed or sheared grid has to be read against a regular one.
 *
 * CHOSEN FROM THE SHORTER SPAN, and the first draft of this got it backwards. Choosing from the
 * longer span means a wide, short region (lat 50–54 across lng −90–0) gets a 20° step, and
 * `ticks` then returns NO parallels at all: a graticule of meridians only, which cannot show
 * latitude bowing. A grid too dense on one axis is a cosmetic problem; a grid missing an axis is
 * a broken instrument.
 *
 * The cost of that choice is the long axis flooding, so it is bounded: if the shorter span's step
 * would put more than `maxLines` lines across the longer one, walk the ladder coarser until it
 * fits. For any aspect ratio a real map has, that settles with both axes populated.
 */
export function graticule(sw: LatLng, ne: LatLng, want = 4, maxLines = 200): Graticule {
	const latSpan = ne.lat - sw.lat;
	const lngSpan = ne.lng - sw.lng;
	const shorter = Math.min(latSpan, lngSpan);
	const longer = Math.max(latSpan, lngSpan);

	let step = chooseStep(shorter, want);
	while (step > 0 && longer / step > maxLines) {
		// The NEXT rung up, not the coarsest. `STEPS` runs coarse to fine, so a plain `find` for
		// "greater than step" returns 45° on the first iteration and jumps the whole ladder — the
		// first version of this did exactly that, and a 0.02°-tall strip ended up with a 45° step
		// and no parallels, which is the failure this function was just rewritten to avoid.
		const coarser = [...STEPS].reverse().find((s) => s > step);
		// AND NEVER so coarse that the SHORT axis loses its lines. For a pathological aspect ratio
		// the two goals genuinely conflict, and this is the deliberate choice: an axis with no
		// lines is a broken instrument, where a dense axis is merely busy. `ticks` has its own
		// hard cap, so the long axis cannot run away unbounded.
		if (coarser === undefined || shorter / coarser < 1) break;
		step = coarser;
	}
	return { step, lats: ticks(sw.lat, ne.lat, step), lngs: ticks(sw.lng, ne.lng, step) };
}

/**
 * A graticule label: whole degrees where the step allows it, otherwise degrees and minutes.
 *
 * Hemisphere letters rather than a sign, because a leading minus on a map label reads as a dash
 * and "-0" reads as nothing at all.
 */
export function label(value: number, axis: "lat" | "lng", step: number): string {
	// FROM THE ROUNDED MAGNITUDE, matching `format.ts`'s readout. Taken from the raw sign instead,
	// a tick at -0.004° labels itself "0°W" while the hover readout at the same place says
	// "0.00°E" — two of this plugin's own strings disagreeing about which hemisphere the user is
	// looking at. Zero belongs to the positive hemisphere by convention, not to neither.
	const abs = Math.abs(value);
	const shown = step >= 1 ? Math.round(abs) : abs;
	const hemisphere = shown === 0 ? (axis === "lat" ? "N" : "E") : axis === "lat" ? (value < 0 ? "S" : "N") : value < 0 ? "W" : "E";
	if (step >= 1) return `${Math.round(abs)}°${hemisphere}`;
	const deg = Math.floor(abs + 1e-9);
	const minutes = (abs - deg) * 60;
	if (step >= 1 / 60) return `${deg}°${String(Math.round(minutes)).padStart(2, "0")}'${hemisphere}`;
	const wholeMin = Math.floor(minutes + 1e-9);
	const seconds = Math.round((minutes - wholeMin) * 60);
	return `${deg}°${String(wholeMin).padStart(2, "0")}'${String(seconds).padStart(2, "0")}"${hemisphere}`;
}
