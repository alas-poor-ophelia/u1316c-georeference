/**
 * The `mercator` model: an affine fit between Web-Mercator-projected world coordinates and pixels.
 *
 * TWO KINDS OF EVIDENCE HERE, and the difference matters. `CLEAN_MERCATOR` is built from an exact
 * Mercator truth, so the cases on it are exact: the model either reproduces it or it does not.
 * The Britain cases are a real map, but their expected pixels come from the transform recovered by
 * snapping a coastline to it, so they show CONSISTENCY WITH THAT RECOVERY, not ground truth. Each
 * test name says which it is, states its inequality, and gives the value measured when it was
 * written, so a regression reads as a number moving rather than a bare red.
 */
import { describe, expect, test } from "bun:test";
import { InvalidInputError } from "../src/core/errors";
import { buildFit, extent, toLatLng, toPixel } from "../src/core/fit";
import { MERCATOR_CONTROL_LAT, mercatorLat, mercatorY } from "../src/core/projection";
import { diagnose } from "../src/core/residuals";
import type { ControlPoint, TransformKind } from "../src/core/types";
import { fitKey } from "../src/query/fit-memo";
import {
	BRITAIN_12,
	BRITAIN_TOWNS,
	BRITAIN_WALL_ENDS,
	CLEAN,
	CLEAN_LINEAR,
	CLEAN_MERCATOR,
	IMAGE,
	PLACES,
	mercatorTruth,
} from "./fixtures";

/** A tolerance wide enough that the round-trip gate never hides an answer being measured. */
const UNGATED = 1e9;

const rms = (values: readonly number[]): number => Math.sqrt(values.reduce((a, v) => a + v * v, 0) / values.length);

/** RMS pixel error of a fit over the held-out Britain towns. */
function townsRms(points: readonly ControlPoint[], kind: TransformKind): number {
	const fit = buildFit(points, { kind });
	return rms(
		BRITAIN_TOWNS.map((t) => {
			const p = toPixel(fit, t.lat, t.lng, IMAGE, UNGATED)!;
			return Math.hypot(p.x - t.px, p.y - t.py);
		}),
	);
}

/** Worst pixel error of a fit over every PLACES point, against the exact Mercator truth. */
function worstOnPlaces(points: readonly ControlPoint[], kind: TransformKind): number {
	const fit = buildFit(points, { kind });
	let worst = 0;
	for (const p of PLACES) {
		const [x, y] = mercatorTruth(p.lat, p.lng);
		const q = toPixel(fit, p.lat, p.lng, IMAGE, UNGATED)!;
		worst = Math.max(worst, Math.hypot(q.x - x, q.y - y));
	}
	return worst;
}

const hintOf = (points: readonly ControlPoint[], kind: TransformKind): string | undefined =>
	diagnose(points, { kind }).notes.find((n) => n.includes("Mercator affine"));

function subsets<T>(items: readonly T[], k: number): T[][] {
	const out: T[][] = [];
	const walk = (start: number, acc: T[]): void => {
		if (acc.length === k) {
			out.push([...acc]);
			return;
		}
		for (let i = start; i < items.length; i++) walk(i + 1, [...acc, items[i]!]);
	};
	walk(0, []);
	return out;
}

/** London, Edinburgh, Norwich, Exeter: four of the eight, spread across the fixture. */
const FOUR = [0, 2, 4, 5].map((i) => CLEAN_MERCATOR[i]!);

describe("the projection", () => {
	test("the equator projects to exactly 0, not to -6.4e-15 as the ln(tan) form gives", () => {
		expect(mercatorY(0)).toBe(0);
	});

	test("mercatorY(60) / mercatorY(30) equals the textbook 1.31696 / 0.54931 = 2.3975 to 1e-4", () => {
		expect(Math.abs(mercatorY(60) / mercatorY(30) - 1.31696 / 0.54931)).toBeLessThan(1e-4);
	});

	test("mercatorLat undoes mercatorY to under 1e-12 degrees over [-89, 89]", () => {
		let worst = 0;
		for (let lat = -89; lat <= 89; lat += 0.5) worst = Math.max(worst, Math.abs(mercatorLat(mercatorY(lat)) - lat));
		expect(worst).toBeLessThan(1e-12);
	});

	test("evaluation runs past the control limit (85.0529 is finite) and stops past 89.9 (89.95 is NaN)", () => {
		expect(Number.isFinite(mercatorY(85.0529))).toBe(true);
		expect(mercatorY(89.95)).toBeNaN();
		expect(mercatorY(-89.95)).toBeNaN();
	});
});

describe("fitting: the exact cases, on CLEAN_MERCATOR", () => {
	test("mercator from 4 points reproduces all 8 PLACES within 1e-6 px (measured 5e-12)", () => {
		expect(worstOnPlaces(FOUR, "mercator")).toBeLessThan(1e-6);
	});

	test("on the same 4 points affine's worst error is above 2 px (measured 58), so the gain is real", () => {
		expect(worstOnPlaces(FOUR, "affine")).toBeGreaterThan(2);
	});

	test("on the same 4 points tps's worst error is above 1 px (measured 59)", () => {
		expect(worstOnPlaces(FOUR, "tps")).toBeGreaterThan(1);
	});

	test("the reverse fit returns the world coordinate to under 1e-9 degrees over the hull (measured 1.4e-14)", () => {
		const fit = buildFit(CLEAN_MERCATOR, { kind: "mercator" });
		let worst = 0;
		let probes = 0;
		for (let lat = 50.8; lat <= 57; lat += 0.25) {
			for (let lng = -3.4; lng <= 1.2; lng += 0.25) {
				const p = toPixel(fit, lat, lng, IMAGE);
				if (p === null || p.extrapolated) continue;
				const w = toLatLng(fit, p.x, p.y, IMAGE)!;
				worst = Math.max(worst, Math.abs(w.lat - lat), Math.abs(w.lng - lng));
				probes++;
			}
		}
		expect(probes).toBeGreaterThan(50);
		expect(worst).toBeLessThan(1e-9);
	});
});

describe("fitting: the Britain map (consistency with the recovered transform, NOT ground truth)", () => {
	test("12 control points under mercator: towns RMS below 0.6 px (measured 0.08; affine 4.33, tps 0.58)", () => {
		expect(townsRms(BRITAIN_12, "mercator")).toBeLessThan(0.6);
	});

	test("the four wall ends alone under mercator: towns RMS below 2 px (measured 0.53)", () => {
		expect(townsRms(BRITAIN_WALL_ENDS, "mercator")).toBeLessThan(2);
	});

	test("the four wall ends alone under affine: towns RMS above 8 px (measured 10.92), the contrast", () => {
		expect(townsRms(BRITAIN_WALL_ENDS, "affine")).toBeGreaterThan(8);
	});
});

describe("fitting: the latitude limits", () => {
	test("a control point at lat 86 is refused, naming the point and the limit", () => {
		const points = [...CLEAN_MERCATOR.slice(0, 4), { px: 10, py: 10, lat: 86, lng: 0, label: "Too far north" }];
		expect(() => buildFit(points, { kind: "mercator" })).toThrow(InvalidInputError);
		expect(() => buildFit(points, { kind: "mercator" })).toThrow(/Too far north.*85\.05112878/);
		// The limit belongs to the projection, so the plane models still accept the same point.
		expect(() => buildFit(points, { kind: "affine" })).not.toThrow();
	});

	test("a hand-pinned 512 px world tile keeps its extent: the top row reads above the 85.0511 control limit (measured 85.061) and finite", () => {
		// Pinned the way a person would: corners at ±85° and ±179°, pixels rounded to the pixel.
		// The fit is then not exact, and the top row lands just past the tile limit, which is why
		// evaluation stops at 89.9 and not at the control limit.
		const size = 512;
		const pin = (lat: number, lng: number): ControlPoint => ({
			lat,
			lng,
			px: Math.round(((lng + 180) / 360) * size),
			py: Math.round(((180 - mercatorY(lat)) / 360) * size),
		});
		const fit = buildFit([pin(85, -179), pin(85, 179), pin(-85, 179), pin(-85, -179), pin(0, 0)], { kind: "mercator" });
		const tile = { width: size, height: size };
		expect(extent(fit, tile)).not.toBeNull();
		const top = toLatLng(fit, size / 2, 0, tile);
		expect(top).not.toBeNull();
		expect(Number.isFinite(top!.lat)).toBe(true);
		expect(top!.lat).toBeGreaterThan(MERCATOR_CONTROL_LAT);
	});

	test("toLatLng refuses a pixel whose latitude is beyond 89.9 (89.95 is null; 89.8 still resolves)", () => {
		const fit = buildFit(CLEAN_MERCATOR, { kind: "mercator" });
		const [x0, y0] = mercatorTruth(89.8, 0);
		expect(toLatLng(fit, x0, y0, IMAGE)).not.toBeNull();
		const [x1, y1] = mercatorTruth(89.95, 0);
		expect(toLatLng(fit, x1, y1, IMAGE)).toBeNull();
	});

	test("toPixel refuses a latitude beyond 89.9 (89.95 is null; 89.8 still resolves)", () => {
		const fit = buildFit(CLEAN_MERCATOR, { kind: "mercator" });
		expect(toPixel(fit, 89.8, 0, IMAGE, UNGATED)).not.toBeNull();
		expect(toPixel(fit, 89.95, 0, IMAGE, UNGATED)).toBeNull();
	});

	test("the memo key differs between tps and mercator over the same points", () => {
		const points = CLEAN.map((p) => ({ px: p.px, py: p.py, lat: p.lat, lng: p.lng }));
		const key = (model: TransformKind): string => fitKey({ bounds: null, transform: { model }, points }, "earth");
		expect(key("mercator")).not.toBe(key("tps"));
	});
});

describe("diagnostics", () => {
	const SIX = CLEAN_MERCATOR.slice(0, 6);

	test("6 CLEAN_MERCATOR points: mercator's affineRms is below 1e-6 px (measured 2.7e-12), judged in its own plane", () => {
		expect(diagnose(SIX, { kind: "mercator" }).affineRms).toBeLessThan(1e-6);
	});

	test("the same 6 under affine: affineRms above 1 px (measured 9.7), the raw plane's curvature", () => {
		expect(diagnose(SIX, { kind: "affine" }).affineRms).toBeGreaterThan(1);
	});
});

describe("the Mercator hint", () => {
	/** Bowness, Land's End, Dungeness, Duncansby Head, Cape Wrath, St David's Head. */
	const BRITAIN_6 = [0, 4, 5, 9, 10, 11].map((i) => BRITAIN_12[i]!);
	/** Wallsend, Land's End, North Foreland, Duncansby Head, St David's Head. */
	const BRITAIN_5 = [1, 4, 6, 9, 11].map((i) => BRITAIN_12[i]!);

	test("fires on a Britain 6-point subset under tps: ratio 6.18 / 0.40 = 16 >= 2.5", () => {
		expect(hintOf(BRITAIN_6, "tps")).toContain("16 times better");
	});

	test("fires on a Britain 5-point subset under affine: ratio 5.83 / 0.29 = 20 >= 2.5", () => {
		expect(hintOf(BRITAIN_5, "affine")).toContain("20 times better");
	});

	test("never fires under mercator itself, even on the subset it fires for under tps", () => {
		expect(hintOf(BRITAIN_6, "mercator")).toBeUndefined();
	});

	test("does not fire on CLEAN (ratio 0.80 < 2.5) or CLEAN_LINEAR (raw RMS 2e-13 px, under the 1 px floor)", () => {
		expect(hintOf(CLEAN, "affine")).toBeUndefined();
		expect(hintOf(CLEAN, "tps")).toBeUndefined();
		expect(hintOf(CLEAN_LINEAR, "affine")).toBeUndefined();
	});

	test("does not fire on any 4-point set: 0 of the 495 Britain and 70 CLEAN_MERCATOR four-point subsets", () => {
		const fired = [...subsets(BRITAIN_12, 4), ...subsets(CLEAN_MERCATOR, 4)].filter((s) => hintOf(s, "affine"));
		expect(fired).toHaveLength(0);
	});

	test("the printed factor is capped at 99 when the Mercator fit is exact (CLEAN_MERCATOR, an infinite ratio)", () => {
		expect(hintOf(CLEAN_MERCATOR, "affine")).toContain("99 times better");
	});

	test("comes after the caveats the status line must show first, so it is never notes[0] under tps", () => {
		const notes = diagnose(BRITAIN_6, { kind: "tps" }).notes;
		expect(notes.findIndex((n) => n.includes("Mercator affine"))).toBe(notes.length - 1);
		expect(notes.length).toBeGreaterThan(1);
	});

	test("is still LAST when every point is on the hull and the all-hull leave-one-out note is pushed", () => {
		// Five points in convex position (a wide arc of a circle), exact Mercator pixels.
		const convex: ControlPoint[] = [
			[0, -40],
			[35, -25],
			[55, 0],
			[35, 25],
			[0, 40],
		].map(([lat, lng]) => {
			const [px, py] = mercatorTruth(lat!, lng!);
			return { px, py, lat: lat!, lng: lng! };
		});
		const notes = diagnose(convex, { kind: "tps" }).notes;
		expect(notes.some((n) => n.includes("Every control point is on the hull"))).toBe(true);
		expect(notes.findIndex((n) => n.includes("Mercator affine"))).toBe(notes.length - 1);
	});
});
