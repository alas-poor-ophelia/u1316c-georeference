/**
 * The strings the view shows a user: a coordinate readout, and a verdict on a fit.
 *
 * Pure, so the awkward cases are testable. They are the usual suspects and this project has met
 * most of them already: negative zero printing as "-0", a rounded value whose hemisphere letter
 * disagrees with its sign, and a trust summary that reads "0.0 px" for a fit nobody should trust.
 */
import type { FitInfo, LatLng } from "../api/types";
import { COPY } from "./copy";

/**
 * A hover readout. Six decimals is about 10 cm at the equator — past the precision any hand-placed
 * control point earns, and enough that the last digit moving tells a user the readout is live.
 */
export function coordinate(p: LatLng, decimals = 6): string {
	return `${axis(p.lat, "lat", decimals)}, ${axis(p.lng, "lng", decimals)}`;
}

function axis(value: number, kind: "lat" | "lng", decimals: number): string {
	if (!Number.isFinite(value)) return "—";
	// Rounded FIRST, then the hemisphere taken from the rounded value. Taking it from the raw sign
	// prints "0.000000°S" for a latitude of -0.0000001, which is a southern hemisphere claim made
	// on the strength of a rounding error. And `Math.abs` before `toFixed` is what stops the
	// negative zero this project has been bitten by twice reaching a label as "-0.000000".
	const factor = 10 ** decimals;
	const rounded = Math.round(value * factor) / factor;
	const magnitude = Math.abs(rounded).toFixed(decimals);
	const hemisphere = rounded === 0 ? (kind === "lat" ? "N" : "E") : kind === "lat" ? (rounded < 0 ? "S" : "N") : rounded < 0 ? "W" : "E";
	return `${magnitude}°${hemisphere}`;
}

export interface Trust {
	/** Root-mean-square affine residual, in image pixels. The headline number. */
	readonly rms: number;
	/** The worst single control point, so a user knows where to look. */
	readonly worst: { readonly label: string; readonly error: number } | null;
	/**
	 * Caveats the kernel attached — too few points for the model, every point on the hull — and,
	 * when `trust` was told the recommended count, the view's own guidance after them.
	 */
	readonly notes: readonly string[];
	/** A short verdict for a status line. */
	readonly summary: string;
}

/**
 * Summarise a fit for a status line.
 *
 * THE AFFINE RESIDUALS, not the spline's. A thin-plate spline interpolates its control points
 * exactly, so its own residuals are ~0 for any input including a mistyped coordinate — a trust
 * display built on them would report perfect confidence in a broken map. The affine residuals are
 * always meaningful because an affine fit cannot bend to absorb a mistake, which is why the kernel
 * computes them for every model.
 *
 * GIVEN THE MODEL'S RECOMMENDED COUNT, the summary also carries the view's guidance: the count
 * says how far short of it the fit is, a polynomial below it is called barely determined, and the
 * note about the dashed hull goes LAST, after every caveat the kernel ranked. Without it the
 * summary is the kernel's alone, which is what a caller with no view to point at wants.
 */
export function trust(fit: FitInfo, recommended?: number): Trust {
	const d = fit.diagnostics;
	const worst = [...d.affine].sort((a, b) => b.error - a.error)[0];
	const named =
		worst === undefined
			? null
			: { label: worst.label ?? `point ${worst.index + 1}`, error: worst.error };

	const short = recommended !== undefined && fit.pointCount < recommended;
	const count = `${fit.model}, ${fit.pointCount} points`;
	const notes = [...d.notes];
	if (recommended !== undefined) {
		// Fittable and short of the recommended count is the polynomial's "six or seven": both
		// numbers come from the kernel, so neither is written down here.
		if (short && fit.model === "polynomial2") notes.push(COPY.barelyDetermined(fit.pointCount, recommended));
		notes.push(COPY.spreadNote);
	}

	const parts = [short && recommended !== undefined ? `${count} ${COPY.recommendedSuffix(recommended)}` : count, `RMS ${d.affineRms.toFixed(1)} px`];
	if (named !== null && d.affine.length > 1) parts.push(`worst ${named.label} ${named.error.toFixed(1)} px`);
	// ALWAYS SHOW THE LEADING CAVEAT, not a bare count. This used to collapse to "2 caveats" the
	// moment a second one appeared, which is the worst possible behaviour: the caveats that fire
	// together are the serious ones — a wrapped antimeridian plus a three-point fit — and the user
	// got a number instead of either. The kernel orders `notes` most-invalidating first precisely
	// so this line can take the first and say how many more there are.
	if (notes.length === 1) parts.push(notes[0]!);
	else if (notes.length > 1) parts.push(`${notes[0]!} (+${notes.length - 1} more)`);

	return { rms: d.affineRms, worst: named, notes: recommended === undefined ? d.notes : notes, summary: parts.join(" · ") };
}

/**
 * How many points the chosen model still wants before its numbers mean much.
 *
 * Returns 0 when it has enough. A spline over exactly three points IS an affine transform — it is
 * fittable and it is not yet doing spline work, and saying so is kinder than letting a user trust
 * a curve that is a plane.
 */
export function shortfall(fit: FitInfo, recommended: number): number {
	return Math.max(0, recommended - fit.pointCount);
}
