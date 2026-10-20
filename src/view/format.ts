/**
 * The strings the view shows a user: a coordinate readout, and a verdict on a fit.
 *
 * Pure, so the awkward cases are testable. They are the usual suspects and this project has met
 * most of them already: negative zero printing as "-0", a rounded value whose hemisphere letter
 * disagrees with its sign, and a trust summary that reads "0.0 px" for a fit nobody should trust.
 */
import type { FitInfo, LatLng } from "../api/types";

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
	/** Caveats the kernel attached — too few points for the model, every point on the hull. */
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
 */
export function trust(fit: FitInfo): Trust {
	const d = fit.diagnostics;
	const worst = [...d.affine].sort((a, b) => b.error - a.error)[0];
	const named =
		worst === undefined
			? null
			: { label: worst.label ?? `point ${worst.index + 1}`, error: worst.error };

	const parts = [`${fit.model}, ${fit.pointCount} points`, `RMS ${d.affineRms.toFixed(1)} px`];
	if (named !== null && d.affine.length > 1) parts.push(`worst ${named.label} ${named.error.toFixed(1)} px`);
	if (d.notes.length > 0) parts.push(d.notes.length === 1 ? d.notes[0]! : `${d.notes.length} caveats`);

	return { rms: d.affineRms, worst: named, notes: d.notes, summary: parts.join(" · ") };
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
