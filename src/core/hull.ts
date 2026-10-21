/**
 * Convex hull of the control points, and membership tests against it.
 *
 * This is what separates interpolation from extrapolation. Inside the hull a fit is interpolating
 * and trustworthy; outside it the fit is guessing, and for a thin-plate spline it guesses wildly.
 * Geb does not refuse points outside the hull — a historian who pinned four places in the south
 * should still get her Orkney pin — it marks them, so the fuzziness is labelled rather than
 * laundered.
 */

export interface Vec2 {
	readonly x: number;
	readonly y: number;
}

/**
 * Andrew's monotone chain. Returns the hull counter-clockwise, without repeating the first point.
 * Fewer than three input points, or wholly collinear input, returns the degenerate hull.
 */
export function convexHull(pts: readonly Vec2[]): Vec2[] {
	// A non-finite coordinate breaks the sort comparator, and a broken comparator does not merely
	// mis-order: an eight-point set containing one NaN produced an ELEVEN-vertex hull. The fitters
	// reject non-finite input before reaching here, but this routine is public, so it defends
	// itself rather than relying on its callers.
	const finite = pts.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
	if (finite.length < 3) return [...finite];
	const sorted = [...finite].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

	const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

	const build = (seq: readonly Vec2[]): Vec2[] => {
		const out: Vec2[] = [];
		for (const p of seq) {
			while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop();
			out.push(p);
		}
		out.pop();
		return out;
	};

	const lower = build(sorted);
	const upper = build([...sorted].reverse());
	const hull = [...lower, ...upper];
	// Collinear input collapses; fall back to the extreme pair so callers always get something.
	return hull.length >= 3 ? hull : [sorted[0]!, sorted[sorted.length - 1]!];
}

/**
 * Point-in-convex-polygon, inclusive of the boundary. `hull` must be counter-clockwise, as
 * returned by `convexHull`. A degenerate hull of fewer than three vertices contains nothing,
 * which is the right answer: three collinear control points evidence no area at all.
 *
 * `epsilon` IS A DISTANCE, in the same units as the coordinates, and getting there needed a fix.
 * The cross product below is twice the signed area of the triangle (a, b, p), which equals the
 * edge length times the perpendicular distance from `p` to that edge — so comparing it directly
 * against a fixed epsilon made the EFFECTIVE tolerance `epsilon / edgeLength`, and therefore
 * dependent on how large the coordinates happened to be. Measured, with the old absolute test:
 *
 *      hull size        distance a point could sit outside and still count as inside
 *      60°              1.7e-11°   (about 2 µm)
 *      1°               1e-9°      (0.1 mm)
 *      0.0001°          1e-5°      (about 1.1 m, or 10% of the hull's own edge)
 *
 * That last row is a single-building plan, a case `crs.ts` explicitly contemplates, where a pin a
 * metre outside the control points was reported as interpolated rather than extrapolated. Dividing
 * by the edge length makes it distance-against-distance, so one tolerance means the same thing on
 * a continent and on a floor plan. This is the same defect class `linalg.ts` fixed by scaling its
 * pivot threshold; it survived here because no test pinned the boundary.
 */
export function inHull(hull: readonly Vec2[], p: Vec2, epsilon = 1e-9): boolean {
	if (hull.length < 3) return false;
	for (let i = 0; i < hull.length; i++) {
		const a = hull[i]!;
		const b = hull[(i + 1) % hull.length]!;
		const ex = b.x - a.x;
		const ey = b.y - a.y;
		const edge = Math.hypot(ex, ey);
		// NO GUARD FOR A ZERO-LENGTH EDGE, deliberately. Two identical hull vertices define no
		// half-plane and so cannot exclude anything, and that falls out for free: the division
		// gives NaN, and `NaN < -epsilon` is false, so the edge is skipped. An explicit
		// `if (edge === 0) continue;` stood here and was removed — it was unreachable from
		// `convexHull` (duplicate points collapse to a two-vertex hull), provably identical in
		// behaviour, and so could not be pinned by any test or mutant. Its comment also claimed
		// dividing would "declare everything outside", which is not what NaN does.
		const distance = (ex * (p.y - a.y) - ey * (p.x - a.x)) / edge;
		if (distance < -epsilon) return false;
	}
	return true;
}
