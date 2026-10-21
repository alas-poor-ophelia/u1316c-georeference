/**
 * The view's pure logic. Everything here runs without a DOM, which is the point of splitting it
 * out — a map view's arithmetic bugs are invisible by eye and obvious to an assertion.
 */
import { describe, expect, test } from "bun:test";
import type { FitInfo, PinInfo } from "../src/api/types";
import { coordinate, shortfall, trust } from "../src/view/format";
import { chooseStep, graticule, label, ticks } from "../src/view/graticule";
import { extrapolated, pinAt, uncertaintyRadius } from "../src/view/pins";
import { fitToContainer, IDENTITY, insideImage, panBy, toImage, toScreen, zoomAbout } from "../src/view/viewport";

const IMAGE = { width: 2000, height: 1000 };

describe("the viewport transform", () => {
	test("fitToContainer centres the image and fits its longer axis", () => {
		// A 2:1 image in a square container: width binds, and the letterboxing is vertical.
		const v = fitToContainer(IMAGE, { width: 1000, height: 1000 });
		expect(v.scale).toBe(0.5);
		expect(v.offsetX).toBe(0);
		expect(v.offsetY).toBe(250);
	});

	test("a degenerate image or container yields the identity rather than dividing by zero", () => {
		expect(fitToContainer({ width: 0, height: 0 }, { width: 100, height: 100 })).toEqual(IDENTITY);
		expect(fitToContainer(IMAGE, { width: 0, height: 100 })).toEqual(IDENTITY);
	});

	test("toScreen and toImage are exact inverses", () => {
		// The gate for this file. The hover readout runs one direction and the pins run the other,
		// and a user comparing a readout against the pin under the cursor is comparing both.
		const v = fitToContainer(IMAGE, { width: 1337, height: 777 });
		for (const p of [
			{ x: 0, y: 0 },
			{ x: IMAGE.width, y: IMAGE.height },
			{ x: 1234.5, y: 678.25 },
			{ x: -40, y: 5 },
		]) {
			const back = toImage(v, toScreen(v, p));
			expect(back).not.toBeNull();
			expect(back!.x).toBeCloseTo(p.x, 9);
			expect(back!.y).toBeCloseTo(p.y, 9);
		}
	});

	test("toImage refuses a zero or non-finite scale rather than returning Infinity", () => {
		// Without this a coordinate readout shows "Infinity°N" the moment a container collapses.
		expect(toImage({ scale: 0, offsetX: 0, offsetY: 0 }, { x: 10, y: 10 })).toBeNull();
		expect(toImage({ scale: Number.NaN, offsetX: 0, offsetY: 0 }, { x: 10, y: 10 })).toBeNull();
	});

	test("zoomAbout keeps the anchored image pixel under the anchor", () => {
		// What makes a wheel zoom feel right. Zooming about the origin instead slides the map away
		// from the pointer, which reads as a bug even though the scale is correct.
		const v = fitToContainer(IMAGE, { width: 1000, height: 1000 });
		const anchor = { x: 700, y: 400 };
		const before = toImage(v, anchor)!;
		const zoomed = zoomAbout(v, anchor, 2.5, { min: 0.05, max: 40 });
		const after = toImage(zoomed, anchor)!;
		expect(after.x).toBeCloseTo(before.x, 9);
		expect(after.y).toBeCloseTo(before.y, 9);
		expect(zoomed.scale).toBeCloseTo(v.scale * 2.5, 9);
	});

	test("zoom clamps, and a clamped zoom does not move the image", () => {
		const v = { scale: 1, offsetX: 10, offsetY: 20 };
		const atMax = zoomAbout(v, { x: 0, y: 0 }, 1000, { min: 0.5, max: 4 });
		expect(atMax.scale).toBe(4);
		// Already at the limit: the SAME OBJECT must come back. `toEqual` passed either way — with
		// the guard removed the offset maths is a no-op at ratio 1 — so the guard is not about the
		// numbers, it is about identity: a view that skips a re-render when the viewport is
		// unchanged needs the reference to be stable.
		const again = zoomAbout(atMax, { x: 500, y: 500 }, 1000, { min: 0.5, max: 4 });
		expect(again).toBe(atMax);
	});

	test("a non-finite pan or zoom factor is ignored, not propagated", () => {
		const v = { scale: 2, offsetX: 1, offsetY: 2 };
		expect(panBy(v, Number.NaN, 5)).toEqual(v);
		expect(zoomAbout(v, { x: 0, y: 0 }, Number.POSITIVE_INFINITY, { min: 0.1, max: 10 })).toEqual(v);
	});

	test("insideImage includes the edges", () => {
		expect(insideImage(IMAGE, { x: 0, y: 0 })).toBe(true);
		expect(insideImage(IMAGE, { x: 2000, y: 1000 })).toBe(true);
		expect(insideImage(IMAGE, { x: 2000.5, y: 500 })).toBe(false);
		expect(insideImage(IMAGE, { x: -0.5, y: 500 })).toBe(false);
	});
});

describe("graticule spacing", () => {
	test("a world-sized span gets coarse lines and a town-sized span gets fine ones", () => {
		expect(chooseStep(180)).toBe(45);
		expect(chooseStep(40)).toBe(10);
		expect(chooseStep(8)).toBe(2);
		expect(chooseStep(0.5)).toBeCloseTo(5 / 60, 9);
	});

	test("the step is the COARSEST that still gives enough lines", () => {
		// Too dense is worse than too sparse: a graticule hides the map it is drawn over.
		const span = 40;
		const step = chooseStep(span, 4);
		expect(span / step).toBeGreaterThanOrEqual(4);
		// And one rung coarser would NOT have given enough — that is what "coarsest" means.
		//
		// ASSERTED THROUGH `chooseStep`, because the line that used to be here was `span / 15`:
		// pure arithmetic over the test's own constants, containing no call to the implementation
		// at all, so a completely wrong ladder passed it. Walking `want` instead makes the ladder
		// itself observable. Measured on span 40: want 2 gives 20, want 3 and 4 give 10, want 5
		// and 8 give 5, want 12 gives 2 — the rungs between 45 and 1, in order.
		expect(chooseStep(span, 2)).toBe(20);
		expect(chooseStep(span, 3)).toBe(10);
		expect(chooseStep(span, 5)).toBe(5);
		expect(chooseStep(span, 12)).toBe(2);
		// Monotone: asking for more lines can never return a coarser step.
		for (let want = 2; want < 12; want++) {
			expect(chooseStep(span, want + 1)).toBeLessThanOrEqual(chooseStep(span, want));
		}
	});

	test("a span finer than an arcsecond divides the span instead of forcing a rung", () => {
		const step = chooseStep(0.0001, 4);
		expect(step).toBeCloseTo(0.0001 / 4, 12);
	});

	test("ticks land on exact multiples, with no accumulated drift", () => {
		// Built by multiplication from an integer index rather than repeated addition: adding
		// 1/60 sixty times does not reach 1, and the line ends up beside the label it carries.
		const step = 1 / 60;
		const out = ticks(0, 1, step);
		expect(out).toHaveLength(61);
		expect(out[60]!).toBeCloseTo(1, 12);
		// EXACT equality with the multiplied value. A 1e-9 tolerance passed against an
		// accumulating implementation too — sixty additions of 1/60 drift by about 1e-16, which is
		// far under any tolerance loose enough to look reasonable. Only exactness pins the method.
		out.forEach((t, i) => {
			expect(t).toBe(i * step);
		});
	});

	test("ticks handles an inverted, empty or absurd range without hanging", () => {
		expect(ticks(10, 5, 1)).toEqual([]);
		expect(ticks(0, 0, 1)).toEqual([0]);
		expect(ticks(0, 1, 0)).toEqual([]);
		// A span of a million degrees at arcsecond spacing must not try to build the list.
		expect(ticks(0, 1_000_000, 1 / 3600)).toEqual([]);
	});

	test("a WIDE SHORT region still gets parallels, and the cells stay square", () => {
		// This caught a real design flaw on its first run. Choosing the step from the LONGER span
		// gave this region a 20° step, and `ticks(50, 54, 20)` returns nothing — a graticule of
		// meridians with no parallels, which cannot show latitude bowing at all. A grid too dense
		// on one axis is cosmetic; a grid missing an axis is a broken instrument.
		const g = graticule({ lat: 50, lng: -90 }, { lat: 54, lng: 0 });
		expect(g.lats.length).toBeGreaterThan(0);
		expect(g.lngs.length).toBeGreaterThan(0);
		const latGap = g.lats[1]! - g.lats[0]!;
		const lngGap = g.lngs[1]! - g.lngs[0]!;
		expect(latGap).toBeCloseTo(lngGap, 12);
	});

	test("a square region gets the same step on both axes", () => {
		const g = graticule({ lat: 40, lng: -10 }, { lat: 60, lng: 10 });
		expect(g.lats[1]! - g.lats[0]!).toBeCloseTo(g.lngs[1]! - g.lngs[0]!, 12);
		expect(g.lats.length).toBeGreaterThanOrEqual(4);
	});

	test("a realistically wide region bounds the dense axis", () => {
		// 4° tall by 90° wide — a plausible view of northern Europe. The shorter span wants a 1°
		// step, which would be 90 meridians; `maxLines` lets that stand at 200 but would step up
		// if it did not.
		const g = graticule({ lat: 50, lng: -90 }, { lat: 54, lng: 0 }, 4, 200);
		expect(g.lngs.length).toBeLessThanOrEqual(201);
		expect(g.lats.length).toBeGreaterThan(0);
		expect(g.lats[1]! - g.lats[0]!).toBeCloseTo(g.lngs[1]! - g.lngs[0]!, 12);
	});

	test("a PATHOLOGICAL aspect ratio keeps the short axis and lets the long one be busy", () => {
		// 0.02° tall by 90° wide — a 4500:1 view no real map has. Here the two goals genuinely
		// conflict: no single step both populates the height and bounds the width. The documented
		// choice is to keep the short axis, because an axis with no lines is a broken instrument
		// while a busy axis is merely busy. Asserting `maxLines` here would be asserting the
		// wrong half of a trade-off the code makes on purpose.
		const g = graticule({ lat: 50, lng: -90 }, { lat: 50.02, lng: 0 }, 4, 200);
		expect(g.lats.length).toBeGreaterThanOrEqual(2);
		expect(g.lngs.length).toBeGreaterThan(200);
		expect(g.lats[1]! - g.lats[0]!).toBeCloseTo(g.lngs[1]! - g.lngs[0]!, 12);
	});

	test("labels use hemisphere letters, and a rounded zero is not negative", () => {
		expect(label(53.5, "lat", 1)).toBe("54°N");
		expect(label(-1.0815, "lng", 1)).toBe("1°W");
		// Was "0°W" until the hemisphere moved to the ROUNDED magnitude. That expectation was
		// pinning the inconsistency with `coordinate`, not a behaviour worth keeping.
		expect(label(-0.004, "lng", 1)).toBe("0°E");
		expect(label(51.5, "lat", 1 / 60)).toBe("51°30'N");
		expect(label(51.50833, "lat", 1 / 3600)).toBe("51°30'30\"N");
	});

	test("a label's hemisphere agrees with the readout's at the zero line", () => {
		// These two modules print the same place. Taken from the raw sign, a tick at -0.004°
		// labels itself "0°W" while `coordinate` at the same spot says "0.00°E" — two of the
		// plugin's own strings disagreeing about which hemisphere the user is looking at.
		expect(label(0, "lng", 1)).toBe("0°E");
		expect(label(-0, "lat", 1)).toBe("0°N");
		expect(label(-0.004, "lat", 1)).toBe("0°N");
		expect(coordinate({ lat: -0.004, lng: -0.004 }, 1)).toBe("0.0°N, 0.0°E");
	});
});

describe("pin hit-testing", () => {
	const pin = (notePath: string, x: number, y: number, extra: Partial<PinInfo> = {}): PinInfo => ({
		georefId: "m",
		notePath: "maps/m.md",
		x,
		y,
		extrapolated: false,
		feature: { notePath, lat: 0, lng: 0, crs: "earth", source: "lat-lng" },
		...extra,
	});

	test("the NEAREST pin wins, not the first in the list", () => {
		// Pins overlap constantly — a town and its castle are one pixel at world zoom. "First in
		// the list" means the answer depends on vault file order, so the same click opens a
		// different note after an unrelated rename.
		const pins = [pin("far.md", 100, 100), pin("near.md", 12, 12)];
		expect(pinAt(pins, { x: 10, y: 10 }, 20)!.feature.notePath).toBe("near.md");
	});

	test("a pin outside the radius is not picked", () => {
		expect(pinAt([pin("a.md", 100, 100)], { x: 10, y: 10 }, 20)).toBeNull();
	});

	test("the radius is a circle, not a square", () => {
		// (14, 14) is inside a 20-wide box and outside a 20 radius. Testing the box instead picks
		// pins the user can see are further away than the one they clicked.
		expect(pinAt([pin("a.md", 14, 14)], { x: 0, y: 0 }, 20)!.feature.notePath).toBe("a.md");
		expect(pinAt([pin("a.md", 15, 15)], { x: 0, y: 0 }, 20)).toBeNull();
	});

	test("a tie is broken stably by note path", () => {
		// Two features at the identical coordinate cannot be told apart by a click; picking
		// arbitrarily would make the view flicker between them across rebuilds.
		const pins = [pin("b.md", 10, 10), pin("a.md", 10, 10)];
		expect(pinAt(pins, { x: 10, y: 10 }, 5)!.feature.notePath).toBe("a.md");
		expect(pinAt([...pins].reverse(), { x: 10, y: 10 }, 5)!.feature.notePath).toBe("a.md");
	});

	test("an empty list, a zero radius and a non-finite click are all refused", () => {
		expect(pinAt([], { x: 0, y: 0 }, 10)).toBeNull();
		expect(pinAt([pin("a.md", 0, 0)], { x: 0, y: 0 }, 0)).toBeNull();
		expect(pinAt([pin("a.md", 0, 0)], { x: Number.NaN, y: 0 }, 10)).toBeNull();
	});

	test("uncertainty becomes a pixel radius from two answers the API gave", () => {
		expect(uncertaintyRadius({ x: 10, y: 10 }, { x: 13, y: 14 })).toBe(5);
		expect(uncertaintyRadius({ x: 10, y: 10 }, null)).toBeNull();
		// A probe that resolved to the same pixel is not a radius of zero, it is no radius.
		expect(uncertaintyRadius({ x: 10, y: 10 }, { x: 10, y: 10 })).toBeNull();
	});

	test("extrapolated pins can be listed separately", () => {
		const pins = [pin("in.md", 1, 1), pin("out.md", 2, 2, { extrapolated: true })];
		expect(extrapolated(pins).map((p) => p.feature.notePath)).toEqual(["out.md"]);
	});
});

describe("the readout and the trust summary", () => {
	test("a coordinate reads with hemisphere letters", () => {
		expect(coordinate({ lat: 53.9591, lng: -1.0815 })).toBe("53.959100°N, 1.081500°W");
	});

	test("negative zero never reaches a label", () => {
		// Bitten by -0 twice in this project already.
		expect(coordinate({ lat: -0, lng: -0 }, 2)).toBe("0.00°N, 0.00°E");
	});

	test("the hemisphere comes from the ROUNDED value, not the raw sign", () => {
		// -0.0000001 rounded to six places is zero; printing "0.000000°S" claims a southern
		// hemisphere on the strength of a rounding error.
		expect(coordinate({ lat: -0.0000001, lng: 0.0000001 }, 6)).toBe("0.000000°N, 0.000000°E");
	});

	test("a non-finite coordinate shows a dash rather than Infinity", () => {
		expect(coordinate({ lat: Number.POSITIVE_INFINITY, lng: 0 })).toBe("—, 0.000000°E");
	});

	const fit = (over: Partial<FitInfo["diagnostics"]> = {}, pointCount = 8): FitInfo => ({
		model: "tps",
		pointCount,
		points: [],
		hull: [],
		diagnostics: {
			affine: [
				{ index: 0, label: "Eboracum", error: 1.2, onHull: false },
				{ index: 1, error: 4.8, onHull: true },
			],
			affineRms: 2.6,
			notes: [],
			...over,
		},
	});

	test("the summary names the worst point so a user knows where to look", () => {
		const t = trust(fit());
		expect(t.rms).toBe(2.6);
		expect(t.worst).toEqual({ label: "point 2", error: 4.8 });
		expect(t.summary).toContain("RMS 2.6 px");
		expect(t.summary).toContain("worst point 2 4.8 px");
	});

	test("an unlabelled point is named by its position, one-based", () => {
		// "point 0" is meaningless to someone counting pins on a screen.
		expect(trust(fit()).worst!.label).toBe("point 2");
	});

	test("caveats from the kernel are carried, not dropped", () => {
		const t = trust(fit({ notes: ["every point is on the hull"] }));
		expect(t.notes).toEqual(["every point is on the hull"]);
		expect(t.summary).toContain("every point is on the hull");
	});

	test("and with several, the LEADING one is shown rather than a bare count", () => {
		// This used to read "3 caveats" and nothing else, which inverted the intent of the test
		// above: the moment a second caveat appeared, the summary stopped carrying any of them.
		// The caveats that fire together are the serious ones — a wrapped antimeridian alongside a
		// three-point fit — and the kernel orders `notes` most-invalidating first so this line can
		// show the one that matters and count the rest.
		const many = trust(fit({ notes: ["the fit is wrong", "b", "c"] }));
		expect(many.summary).toContain("the fit is wrong");
		expect(many.summary).toContain("+2 more");
		// The full list is still available to a caller that wants to render all of them.
		expect(many.notes).toEqual(["the fit is wrong", "b", "c"]);
	});

	test("shortfall says how many more points the model wants", () => {
		expect(shortfall(fit({}, 3), 8)).toBe(5);
		expect(shortfall(fit({}, 8), 8)).toBe(0);
		expect(shortfall(fit({}, 12), 8)).toBe(0);
	});
});
