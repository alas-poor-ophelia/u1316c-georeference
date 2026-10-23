/**
 * The point dialog's validation, apart from the dialog.
 *
 * Takes the five field texts and the map's coordinate system and returns a control point or the
 * sentence to show beside the form. Pure, so every refusal is pinned by a test and the Obsidian
 * layer in `modals.ts` only reads fields and shows the result. The API's own validation still
 * runs on save.
 */
import type { ControlPoint } from "../api/types";
import { COPY } from "./copy";
import { parseAngle, parsePair } from "./coords";

export interface PointFields {
	readonly px: string;
	readonly py: string;
	readonly lat: string;
	readonly lng: string;
	readonly label: string;
}

export interface PointCrs {
	readonly name: string;
	readonly latRange: readonly [number, number];
	readonly lngRange: readonly [number, number];
}

export type PointFormResult = { readonly ok: true; readonly point: ControlPoint } | { readonly ok: false; readonly error: string };

/** A finite number from a pixel field, or null. Accepts a decimal comma: a European keyboard is not a typo. */
function pixel(text: string): number | null {
	const raw = text.trim().replace(",", ".");
	if (raw === "" || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(raw)) return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
}

export function readPointForm(fields: PointFields, crs: PointCrs | null): PointFormResult {
	const bad = (error: string): PointFormResult => ({ ok: false, error });
	const px = pixel(fields.px);
	const py = pixel(fields.py);
	if (px === null || py === null) return bad("Pixel x and y must be numbers.");
	if (px < 0 || py < 0) return bad("Pixel x and y cannot be negative.");

	let lat: number;
	let lng: number;
	// A pair in the latitude field with nothing in longitude fills both. With anything in
	// longitude the latitude field is ONE angle, and a pair there is unreadable.
	const pair = fields.lng.trim() === "" ? parsePair(fields.lat) : null;
	if (pair !== null) {
		lat = pair.lat;
		lng = pair.lng;
	} else {
		const a = parseAngle(fields.lat);
		const o = parseAngle(fields.lng);
		if (a === null || o === null) return bad(COPY.coords.unreadable);
		if (a.axis === "lng" || o.axis === "lat") return bad(COPY.coords.wrongAxis);
		lat = a.value;
		lng = o.value;
	}

	if (crs !== null) {
		const [latLo, latHi] = crs.latRange;
		const [lngLo, lngHi] = crs.lngRange;
		if (lat < latLo || lat > latHi) return bad(`Latitude must be between ${latLo} and ${latHi} for ${crs.name}.`);
		if (lng < lngLo || lng > lngHi) return bad(`Longitude must be between ${lngLo} and ${lngHi} for ${crs.name}.`);
	}
	const label = fields.label.trim();
	return { ok: true, point: label === "" ? { px, py, lat, lng } : { px, py, lat, lng, label } };
}
