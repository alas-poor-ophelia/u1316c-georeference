import { describe, expect, test } from "bun:test";
import { buildFit, extent, toLatLng, toPixel } from "../src/core/fit";
import { FitError, fitMapping, TpsMapping } from "../src/core/mapping";
import { CLEAN, CLEAN_LINEAR, IMAGE, PLACES, truth } from "./fixtures";

const world = (pts: readonly { lat: number; lng: number }[]): Float64Array => {
	const a = new Float64Array(pts.length * 2);
	pts.forEach((p, i) => {
		a[2 * i] = p.lat;
		a[2 * i + 1] = p.lng;
	});
	return a;
};
const pixels = (pts: readonly { px: number; py: number }[]): Float64Array => {
	const a = new Float64Array(pts.length * 2);
	pts.forEach((p, i) => {
		a[2 * i] = p.px;
		a[2 * i + 1] = p.py;
	});
	return a;
};

describe("affine", () => {
	test("recovers a purely linear ground truth to floating-point precision", () => {
		const m = fitMapping(world(CLEAN_LINEAR), pixels(CLEAN_LINEAR), { kind: "affine" });
		const out = new Float64Array(CLEAN_LINEAR.length * 2);
		m.apply(world(CLEAN_LINEAR), out);
		CLEAN_LINEAR.forEach((p, i) => {
			expect(out[2 * i]!).toBeCloseTo(p.px, 6);
			expect(out[2 * i + 1]!).toBeCloseTo(p.py, 6);
		});
	});

	test("cannot absorb a non-linear warp, so its residuals are honestly non-zero", () => {
		const m = fitMapping(world(CLEAN), pixels(CLEAN), { kind: "affine" });
		const out = new Float64Array(CLEAN.length * 2);
		m.apply(world(CLEAN), out);
		const worst = Math.max(...CLEAN.map((p, i) => Math.hypot(out[2 * i]! - p.px, out[2 * i + 1]! - p.py)));
		expect(worst).toBeGreaterThan(1);
	});

	test("refuses fewer than three points", () => {
		expect(() => fitMapping(new Float64Array([1, 2, 3, 4]), new Float64Array([5, 6, 7, 8]), { kind: "affine" })).toThrow(FitError);
	});
});

describe("thin-plate spline", () => {
	test("interpolates every control point exactly, warp and all", () => {
		const m = fitMapping(world(CLEAN), pixels(CLEAN), { kind: "tps" });
		const out = new Float64Array(CLEAN.length * 2);
		m.apply(world(CLEAN), out);
		CLEAN.forEach((p, i) => {
			expect(out[2 * i]!).toBeCloseTo(p.px, 4);
			expect(out[2 * i + 1]!).toBeCloseTo(p.py, 4);
		});
	});

	test("carries its system inverse so leave-one-out needs no refit", () => {
		const m = fitMapping(world(CLEAN), pixels(CLEAN), { kind: "tps" });
		expect(m).toBeInstanceOf(TpsMapping);
		const tps = m as TpsMapping;
		expect(tps.systemInverse.length).toBe(CLEAN.length + 3);
		expect(tps.pointCount).toBe(CLEAN.length);
	});

	test("smoothing stops it interpolating exactly", () => {
		const m = fitMapping(world(CLEAN), pixels(CLEAN), { kind: "tps", lambda: 10 });
		const out = new Float64Array(CLEAN.length * 2);
		m.apply(world(CLEAN), out);
		const worst = Math.max(...CLEAN.map((p, i) => Math.hypot(out[2 * i]! - p.px, out[2 * i + 1]! - p.py)));
		expect(worst).toBeGreaterThan(0);
	});
});

describe("order-2 polynomial", () => {
	test("fits the warp better than affine does", () => {
		const measure = (kind: "affine" | "polynomial2"): number => {
			const m = fitMapping(world(CLEAN), pixels(CLEAN), { kind });
			const out = new Float64Array(CLEAN.length * 2);
			m.apply(world(CLEAN), out);
			return Math.max(...CLEAN.map((p, i) => Math.hypot(out[2 * i]! - p.px, out[2 * i + 1]! - p.py)));
		};
		expect(measure("polynomial2")).toBeLessThan(measure("affine"));
	});

	test("refuses fewer than six points", () => {
		const few = CLEAN.slice(0, 5);
		expect(() => fitMapping(world(few), pixels(few), { kind: "polynomial2" })).toThrow(FitError);
	});
});

describe("fit, both directions", () => {
	test("round-trips an interior coordinate back to itself", () => {
		const fit = buildFit(CLEAN, { kind: "tps" });
		const probe = { lat: 53.0, lng: -2.0 };
		const px = toPixel(fit, probe.lat, probe.lng, IMAGE);
		expect(px).not.toBeNull();
		const back = toLatLng(fit, px!.x, px!.y);
		expect(back).not.toBeNull();
		expect(back!.lat).toBeCloseTo(probe.lat, 2);
		expect(back!.lng).toBeCloseTo(probe.lng, 2);
	});

	test("an interior probe is not marked extrapolated; a far one is", () => {
		const fit = buildFit(CLEAN, { kind: "tps" });
		const inside = toPixel(fit, 53.0, -2.0, IMAGE);
		expect(inside?.extrapolated).toBe(false);

		// Orkney: north of every control point, so outside the hull but still on the map.
		const outside = toPixel(fit, 59.0, -3.0, IMAGE);
		expect(outside?.extrapolated).toBe(true);
	});

	test("forward agrees with the ground truth at a point nobody pinned", () => {
		const fit = buildFit(CLEAN, { kind: "tps" });
		const [tx, ty] = truth(52.5, -1.5);
		const got = toPixel(fit, 52.5, -1.5, IMAGE);
		expect(got).not.toBeNull();
		// A spline through eight points does not reproduce the warp exactly away from them; it
		// should land in the right neighbourhood, which for a 2400x3200 image means tens of pixels.
		expect(Math.hypot(got!.x - tx, got!.y - ty)).toBeLessThan(60);
	});

	test("extent carries the image corners into world space", () => {
		const fit = buildFit(CLEAN, { kind: "affine" });
		const corners = extent(fit, IMAGE);
		expect(corners).not.toBeNull();
		expect(corners!.length).toBe(4);
		// Every control point's latitude must fall inside the latitude span the corners describe.
		const lats = corners!.map((c) => c.lat);
		const lo = Math.min(...lats);
		const hi = Math.max(...lats);
		for (const p of PLACES) {
			expect(p.lat).toBeGreaterThanOrEqual(lo);
			expect(p.lat).toBeLessThanOrEqual(hi);
		}
	});
});
