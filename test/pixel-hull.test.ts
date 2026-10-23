/**
 * The view's pixel hull is a second copy of the kernel's monotone chain, kept because the view is
 * fenced out of the kernel. This test is what makes the copy acceptable: over random point sets
 * the two must name the same vertices, and the copy must keep its own two promises — counter-
 * clockwise order in image space, and an empty hull when the points enclose no area.
 */
import { describe, expect, test } from "bun:test";
import { convexHull } from "../src/core/hull";
import { pixelHull } from "../src/view/shell";

/** A small deterministic generator, so a failure reproduces. */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

const key = (p: { x: number; y: number }): string => `${p.x},${p.y}`;

function signedArea(poly: readonly { x: number; y: number }[]): number {
	let twice = 0;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i]!;
		const b = poly[(i + 1) % poly.length]!;
		twice += a.x * b.y - b.x * a.y;
	}
	return twice / 2;
}

describe("pixelHull against the kernel's convexHull", () => {
	test("names the same vertices on 200 random clouds of 3 to 12 points", () => {
		const rand = lcg(7827);
		for (let trial = 0; trial < 200; trial++) {
			const n = 3 + Math.floor(rand() * 10);
			const points = Array.from({ length: n }, () => ({
				px: Math.round(rand() * 400),
				py: Math.round(rand() * 300),
				lat: 0,
				lng: 0,
			}));
			const ours = pixelHull(points);
			const theirs = convexHull(points.map((p) => ({ x: p.px, y: p.py })));
			const theirArea = Math.abs(signedArea(theirs));
			if (theirArea === 0) {
				expect(ours).toEqual([]);
				continue;
			}
			expect(new Set(ours.map(key))).toEqual(new Set(theirs.map(key)));
			expect(Math.abs(signedArea(ours))).toBeCloseTo(theirArea, 9);
		}
	});

	test("is counter-clockwise in image space (y down), so the shoelace area is positive", () => {
		const hull = pixelHull([
			{ px: 0, py: 0, lat: 0, lng: 0 },
			{ px: 100, py: 0, lat: 0, lng: 0 },
			{ px: 100, py: 50, lat: 0, lng: 0 },
			{ px: 0, py: 50, lat: 0, lng: 0 },
			{ px: 50, py: 25, lat: 0, lng: 0 },
		]);
		expect(hull).toHaveLength(4);
		expect(signedArea(hull)).toBeGreaterThan(0);
		expect(hull.map(key)).not.toContain("50,25");
	});

	test("is empty for collinear points and for fewer than three", () => {
		expect(pixelHull([{ px: 0, py: 0, lat: 0, lng: 0 }, { px: 10, py: 10, lat: 0, lng: 0 }, { px: 20, py: 20, lat: 0, lng: 0 }])).toEqual([]);
		expect(pixelHull([{ px: 0, py: 0, lat: 0, lng: 0 }, { px: 10, py: 0, lat: 0, lng: 0 }])).toEqual([]);
	});
});
