import type { LatLng, ReferenceLine } from "../api/types";

/** A file larger than this is refused rather than parsed (the 10 m coastline is about 10 MB). */
export const REFERENCE_MAX_BYTES = 64 * 1024 * 1024;

/** The refusal predicate, apart from the reading so it can be tested without a 64 MB string. */
export function exceedsReferenceCap(byteLength: number): boolean {
	return byteLength > REFERENCE_MAX_BYTES;
}

type Raw = readonly unknown[];

/** Every coordinate array the geometry holds as a line: rings of polygons count as lines. */
function collectLines(geometry: unknown, out: Raw[], depth: number): boolean {
	if (typeof geometry !== "object" || geometry === null || depth > 8) return false;
	const g = geometry as { type?: unknown; coordinates?: unknown; geometries?: unknown };
	const coords = g.coordinates;
	switch (g.type) {
		case "LineString":
			if (!Array.isArray(coords)) return false;
			out.push(coords as Raw);
			return true;
		case "MultiLineString":
		case "Polygon":
			if (!Array.isArray(coords)) return false;
			for (const l of coords as Raw) if (Array.isArray(l)) out.push(l as Raw);
			return true;
		case "MultiPolygon":
			if (!Array.isArray(coords)) return false;
			for (const poly of coords as Raw) {
				if (!Array.isArray(poly)) continue;
				for (const l of poly as Raw) if (Array.isArray(l)) out.push(l as Raw);
			}
			return true;
		case "GeometryCollection": {
			if (!Array.isArray(g.geometries)) return false;
			let any = false;
			for (const sub of g.geometries as Raw) if (collectLines(sub, out, depth + 1)) any = true;
			return any || (g.geometries as Raw).length === 0;
		}
		case "Point":
		case "MultiPoint":
			// Valid GeoJSON with nothing to draw as a line.
			return true;
		default:
			return false;
	}
}

/** Walk the document's features and geometries; false when it is not GeoJSON at all. */
function collectDocument(doc: unknown, out: Raw[]): boolean {
	if (typeof doc !== "object" || doc === null) return false;
	const d = doc as { type?: unknown; features?: unknown; geometry?: unknown };
	if (d.type === "FeatureCollection") {
		if (!Array.isArray(d.features)) return false;
		for (const f of d.features as Raw) {
			if (typeof f === "object" && f !== null) {
				const geom = (f as { geometry?: unknown }).geometry;
				if (geom !== null && geom !== undefined) collectLines(geom, out, 0);
			}
		}
		return true;
	}
	if (d.type === "Feature") {
		if (d.geometry !== null && d.geometry !== undefined) collectLines(d.geometry, out, 0);
		return true;
	}
	return collectLines(doc, out, 0);
}

/**
 * One raw line to its runs. Returns null when a coordinate is unusable (the whole line is dropped).
 * Longitudes above 180 are read as 0..360 and wrapped; a run breaks wherever consecutive longitudes
 * are more than 180 apart, which is an antimeridian crossing.
 *
 * A vertex ON the antimeridian belongs to both sides. Taken as written, `170, 180, 190` in a
 * 0..360 file reads `170, 180, -170`: the step to -170 breaks the run and the 180..190 segment is
 * a lone vertex, dropped. So a vertex at exactly +-180 takes its PREVIOUS neighbour's side, and a
 * run broken just after one starts again from its mirror; `190, 180, 170` the same way round.
 */
function toRuns(line: Raw): LatLng[][] | null {
	const runs: LatLng[][] = [];
	let run: LatLng[] = [];
	let prev = 0;
	let prevLat = 0;
	for (const c of line) {
		if (!Array.isArray(c) || c.length < 2) return null;
		const lng0 = (c as unknown[])[0];
		const lat = (c as unknown[])[1];
		if (typeof lng0 !== "number" || typeof lat !== "number" || !Number.isFinite(lng0) || !Number.isFinite(lat)) return null;
		let lng = lng0 > 180 && lng0 <= 360 ? lng0 - 360 : lng0;
		if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
		if (run.length > 0 && Math.abs(lng) === 180 && Math.abs(lng - prev) > 180) lng = -lng;
		if (run.length > 0 && Math.abs(lng - prev) > 180) {
			runs.push(run);
			run = Math.abs(prev) === 180 ? [{ lat: prevLat, lng: -prev }] : [];
		}
		run.push({ lat, lng });
		prev = lng;
		prevLat = lat;
	}
	runs.push(run);
	return runs;
}

function bboxOf(points: readonly LatLng[]): [number, number, number, number] {
	let s = Infinity;
	let w = Infinity;
	let n = -Infinity;
	let e = -Infinity;
	for (const p of points) {
		if (p.lat < s) s = p.lat;
		if (p.lat > n) n = p.lat;
		if (p.lng < w) w = p.lng;
		if (p.lng > e) e = p.lng;
	}
	return [s, w, n, e];
}

/**
 * Reference lines from GeoJSON text. Never throws: unreadable text yields no lines and one problem
 * naming `source`; a line with a bad coordinate is dropped with a problem naming the source and the
 * line's index, and the rest of the file survives. Empty and one-point lines vanish silently.
 */
export function parseGeoJsonLines(text: string, source: string): { lines: ReferenceLine[]; problems: string[] } {
	const lines: ReferenceLine[] = [];
	const problems: string[] = [];
	try {
		let doc: unknown;
		try {
			doc = JSON.parse(text);
		} catch {
			return { lines, problems: [`${source}: not JSON`] };
		}
		const raw: Raw[] = [];
		if (!collectDocument(doc, raw)) return { lines, problems: [`${source}: not GeoJSON`] };
		raw.forEach((line, index) => {
			const runs = toRuns(line);
			if (runs === null) {
				problems.push(`${source}: line ${index} has a bad coordinate and was skipped`);
				return;
			}
			for (const points of runs) {
				if (points.length < 2) continue;
				lines.push({ bbox: bboxOf(points), points });
			}
		});
	} catch {
		return { lines: [], problems: [`${source}: could not be read`] };
	}
	return { lines, problems };
}
