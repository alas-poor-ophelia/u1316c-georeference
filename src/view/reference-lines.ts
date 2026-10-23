/**
 * The arithmetic of the reference overlay, with no API in it: which part of a coastline is worth
 * mapping at all, and which of the mapped vertices are worth drawing.
 *
 * WHY THIS IS ITS OWN FILE. A 10 m coastline is 410,957 vertices in 4,133 lines (measured); the region one map
 * pictures is a few thousand of them, and at the zoom the map opens at most of those land within a
 * pixel of their neighbour. Both reductions are pure functions over plain arrays, which is the shape
 * a test can pin exactly and a mutation gate can attack, so they live apart from the shell that
 * decides WHEN to run them.
 */
import type { LatLng, Pixel, ReferenceLine } from "../api/types";

/** A world-space box in degrees. South-west to north-east, no antimeridian wrap. */
export interface Box {
	readonly south: number;
	readonly west: number;
	readonly north: number;
	readonly east: number;
}

/** Whether two boxes share any point, edges included. */
export function boxIntersects(a: Box, b: Box): boolean {
	return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

/** A reference line's `[south, west, north, east]` bbox as a `Box`. */
export function lineBox(line: ReferenceLine): Box {
	const [south, west, north, east] = line.bbox;
	return { south, west, north, east };
}

/**
 * The parts of `line` that can matter inside `box`, as runs of consecutive vertices.
 *
 * SEGMENTS, NOT VERTICES. A vertex test keeps only the vertices inside the box, and a straight
 * chord whose two ends both lie outside can still cross the whole map: a coarse coastline drawn
 * across a small-scale image is exactly that case (Parallax finding 3). So a SEGMENT is kept when
 * its own bbox meets the box, both its ends come with it, and each run is padded by ONE MORE vertex
 * either side. The padding is for the transform, not the box: a spline bends a chord, and the
 * neighbouring segment is what lets the drawn line enter the image at the angle it really does
 * instead of starting abruptly on the edge.
 *
 * Runs whose padding meets or overlaps are merged, so a line that dips out of the box for a single
 * segment comes back as one run rather than two that share vertices.
 */
export function cullToBox(line: ReferenceLine, box: Box): LatLng[][] {
	const pts = line.points;
	const runs: LatLng[][] = [];
	let start = -1;
	let end = -1;
	const flush = (): void => {
		if (start >= 0) runs.push(pts.slice(start, end + 1));
		start = -1;
	};
	for (let i = 0; i + 1 < pts.length; i++) {
		const a = pts[i]!;
		const b = pts[i + 1]!;
		// `boxIntersects` on the segment's bbox, inlined as scalars: this loop runs once per vertex
		// of every candidate line, and a Box per segment is an allocation per vertex.
		if (
			Math.min(a.lat, b.lat) > box.north ||
			Math.max(a.lat, b.lat) < box.south ||
			Math.min(a.lng, b.lng) > box.east ||
			Math.max(a.lng, b.lng) < box.west
		) {
			continue;
		}
		const lo = Math.max(0, i - 1);
		const hi = Math.min(pts.length - 1, i + 2);
		if (start >= 0 && lo <= end) {
			end = Math.max(end, hi);
			continue;
		}
		flush();
		start = lo;
		end = hi;
	}
	flush();
	return runs;
}

/**
 * Drop the vertices a screen cannot show: keep one when it is FURTHER than `minPx` from the last
 * vertex kept, and always keep the first and the last.
 *
 * Measured from the last KEPT vertex, not the previous one, or a line of many short steps would
 * lose every vertex — each one is close to its neighbour — and collapse into its two ends. The last
 * vertex is kept unconditionally so a run ends where it ends: dropping it would shorten every
 * coastline at the image edge by up to `minPx`, which at the zoom of a close look is visible.
 */
export function decimate(points: readonly Pixel[], minPx: number): Pixel[] {
	if (points.length <= 2) return [...points];
	const min2 = minPx * minPx;
	const out: Pixel[] = [points[0]!];
	let last = points[0]!;
	for (let i = 1; i < points.length - 1; i++) {
		const p = points[i]!;
		const dx = p.x - last.x;
		const dy = p.y - last.y;
		if (dx * dx + dy * dy > min2) {
			out.push(p);
			last = p;
		}
	}
	out.push(points[points.length - 1]!);
	return out;
}
