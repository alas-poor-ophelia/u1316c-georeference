/**
 * Picking the pin under a click, and formatting what the view says about a place.
 *
 * Hit-testing is in image pixels, not screen pixels, because that is the space the API answers in
 * — `featuresIn` returns a pin's position on the source image. Converting the CLICK into image
 * space once (see viewport.ts) and testing there means the radius does not have to be rescaled on
 * every zoom, and a pin cannot drift from its own hit area.
 */
import type { PinInfo, Pixel } from "../api/types";

/**
 * The nearest pin within `radius` image pixels, or null.
 *
 * NEAREST, not first. Pins overlap constantly — a town and its castle are the same pixel at world
 * zoom — and "first in the list" means the answer depends on vault file order, so the same click
 * opens a different note after an unrelated rename.
 *
 * A tie is broken by note path so the choice is at least STABLE across rebuilds; two features at
 * the identical coordinate cannot be told apart by a click, and picking arbitrarily would make the
 * view flicker between them.
 */
export function pinAt(pins: readonly PinInfo[], at: Pixel, radius: number): PinInfo | null {
	if (!(radius > 0) || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return null;
	const r2 = radius * radius;
	let best: PinInfo | null = null;
	let bestD2 = Number.POSITIVE_INFINITY;
	for (const pin of pins) {
		const dx = pin.x - at.x;
		const dy = pin.y - at.y;
		const d2 = dx * dx + dy * dy;
		if (d2 > r2) continue;
		if (d2 < bestD2 || (d2 === bestD2 && best !== null && pin.feature.notePath < best.feature.notePath)) {
			best = pin;
			bestD2 = d2;
		}
	}
	return best;
}

/**
 * A pin's uncertainty as a RADIUS IN IMAGE PIXELS, or null when it has none.
 *
 * `uncertainty` is stored in the CRS's distance unit — metres for Earth — and the view cannot
 * convert metres to pixels without knowing the local scale of the fit. It is derived here from
 * two pixel positions the API has already produced: the pin itself, and a probe point one
 * uncertainty away. That keeps the projection maths inside the kernel where it belongs; this
 * function only measures the distance between two answers it was given.
 */
export function uncertaintyRadius(pin: Pixel, probe: Pixel | null): number | null {
	if (probe === null) return null;
	const r = Math.hypot(probe.x - pin.x, probe.y - pin.y);
	return Number.isFinite(r) && r > 0 ? r : null;
}

/**
 * The index of the nearest of `points` within `radius` image pixels, or null. The editor's hit
 * test for control points: the same nearest-not-first rule as `pinAt`, with a tie broken by the
 * lower index so that two points placed on one pixel are at least picked stably.
 */
export function nearestIndex(points: readonly Pixel[], at: Pixel, radius: number): number | null {
	if (!(radius > 0) || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return null;
	const r2 = radius * radius;
	let best: number | null = null;
	let bestD2 = Number.POSITIVE_INFINITY;
	points.forEach((p, i) => {
		const dx = p.x - at.x;
		const dy = p.y - at.y;
		const d2 = dx * dx + dy * dy;
		if (d2 <= r2 && d2 < bestD2) {
			best = i;
			bestD2 = d2;
		}
	});
	return best;
}

/** Pins that are extrapolated — outside the control-point hull, so resolved but fuzzy. */
export function extrapolated(pins: readonly PinInfo[]): readonly PinInfo[] {
	return pins.filter((p) => p.extrapolated);
}
