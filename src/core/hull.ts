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
	if (pts.length < 3) return [...pts];
	const sorted = [...pts].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

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
 */
export function inHull(hull: readonly Vec2[], p: Vec2, epsilon = 1e-9): boolean {
	if (hull.length < 3) return false;
	for (let i = 0; i < hull.length; i++) {
		const a = hull[i]!;
		const b = hull[(i + 1) % hull.length]!;
		const side = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
		if (side < -epsilon) return false;
	}
	return true;
}
