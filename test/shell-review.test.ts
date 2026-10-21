/**
 * The defects a cross-model review found by running the shell against a surface that behaved as
 * the real adapter did — hiding its element while a message showed, so `size()` was 0x0 — and
 * by reading the pointer-events spec. Each is pinned by the scenario that exposed it, so the next
 * rewrite of either file meets the same wall. The behaviour suite is shell.test.ts.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { ApiController } from "../src/api/controller";
import { toFrontmatter } from "../src/persist/serialize";
import { KEY } from "../src/persist/types";
import { coordinate } from "../src/view/format";
import { MapShell, MESSAGES } from "../src/view/shell";
import { fitToContainer, toImage } from "../src/view/viewport";
import { FakeVault } from "./fake-vault";
import { CLEAN, IMAGE } from "./fixtures";
import { BYTES, COLLINEAR, CONTAINER, georef, ID, NOTE, openShell, Recorder, seedVault, vaultChanged } from "./shell-harness";

let v: FakeVault;
let c: ApiController;
let s: Recorder;

beforeEach(() => {
	v = new FakeVault();
	seedVault(v);
	c = new ApiController(v, "0.0.1");
	s = new Recorder();
});

const opened = (): MapShell => openShell(c, s);

/**
 * Break the map's note so it is rejected, or mend it, then deliver the vault's notification.
 * The points live INSIDE the stored fit under `geb-fits`; a first version wrote a `geb-points`
 * key nobody reads, changed nothing, and the test failed with "no message".
 */
const rewritePoints = async (points: readonly { px: number; py: number; lat: number; lng: number }[]): Promise<void> => {
	await v.writeFrontmatter(NOTE, (fm) => {
		fm[KEY.fits] = [{ bounds: null, transform: { model: "tps" }, points: points.map((p) => ({ ...p })) }];
	});
	vaultChanged(v, c, NOTE);
};

describe("the message state", () => {
	test("a surface with no size yet does not get a fit computed against 0x0", () => {
		// The adapter hid the viewport to show a message; the shell's first act was to measure
		// it. fitToContainer(0x0) is the identity, and the map opened at 1:1 in the corner with
		// its zoom limits built on a scale of 1.
		s.sizeValue = { width: 0, height: 0 };
		const shell = opened();
		// Painted, so the surface can show the image at all — but no fit claimed.
		expect(s.frames.length).toBeGreaterThan(0);
		// THE DISCRIMINATING STEP. A resize already refits an untouched view, so on its own it
		// cannot tell a deferred fit from a fit computed against nothing: both land in the same
		// place. Adjust the view first. A fit that was genuinely deferred is still owed and must
		// win; a fit that was silently computed against 0x0 left the view "adjusted" from a
		// baseline of 1:1, and the resize would leave it there.
		shell.zoomIn();
		s.sizeValue = { ...CONTAINER };
		shell.resize();
		expect(shell.view).toEqual(fitToContainer(IMAGE, CONTAINER));
	});

	test("after unload, no toolbar action or hover can paint the dead map back", () => {
		const shell = opened();
		c.unload();
		const painted = s.frames.length;
		const centre = { x: CONTAINER.width / 2, y: CONTAINER.height / 2 };
		shell.zoomIn();
		shell.zoomOut();
		shell.fitImage();
		shell.drag(5, 5);
		shell.wheel(centre, -100);
		// ON the image this time. The earlier test hovered off it, where the readout returns
		// before touching the API, which is how a hover that threw `geb-unloaded` went unseen.
		shell.hoverAt(centre);
		shell.resize();
		expect(shell.tap(centre)).toBe(false);
		expect(s.frames.length).toBe(painted);
		expect(s.lastMessage).toBe(MESSAGES.unloaded);
	});

	test("a map rejected AFTER being shown goes to its reason, and nothing resurrects it", async () => {
		const shell = opened();
		const painted = s.frames.length;
		await rewritePoints(COLLINEAR);
		expect(s.lastMessage).not.toBe(MESSAGES.noGeoref(ID));
		expect(s.lastMessage.length).toBeGreaterThan(10);
		shell.fitImage();
		shell.zoomIn();
		expect(s.frames.length).toBe(painted);
	});

	test("a map that failed its FIRST load is picked up when it appears", () => {
		c.markReady();
		const shell = new MapShell(c.api, "late", s);
		shell.open();
		expect(s.messages).toEqual([MESSAGES.noGeoref("late")]);
		expect(s.frames).toHaveLength(0);
		// It had no note path to match a change event against; the first version therefore
		// ignored the very event announcing its arrival and stayed on the message for ever.
		v.addFile("late.png", BYTES);
		v.addNote("maps/late.md", toFrontmatter(georef("late")));
		vaultChanged(v, c, "maps/late.md");
		expect(s.frames).toHaveLength(1);
		expect(s.last.image.src).toBe("res:late.png");
	});

	test("coming back from a message is a first placement: the image is fitted again", async () => {
		const shell = opened();
		shell.drag(100, 100);
		await rewritePoints(COLLINEAR);
		await rewritePoints(CLEAN);
		expect(shell.view).toEqual(fitToContainer(IMAGE, CONTAINER));
	});
});

describe("the drawing", () => {
	test("a drag carries the pointer with it, so the readout follows the cursor", () => {
		const shell = opened();
		const at = { x: 420, y: 310 };
		shell.drag(10, 10, at);
		const img = toImage(shell.view, at)!;
		const w = c.api.toLatLng(ID, img.x, img.y)!;
		expect(s.last.readout).toBe(coordinate(w) + (w.extrapolated ? " · extrapolated" : ""));
	});

	test("every graticule point lies inside the image", () => {
		// The bounding box of what a map pictures overshoots the image for any map whose north
		// is not straight up, and lines drawn into the background around it are noise. Measured
		// before clipping: 9 of 298 traced points fell outside this fixture's image.
		opened();
		for (const line of s.last.lines) {
			for (const p of line.points) {
				expect(p.x).toBeGreaterThanOrEqual(0);
				expect(p.x).toBeLessThanOrEqual(IMAGE.width);
				expect(p.y).toBeGreaterThanOrEqual(0);
				expect(p.y).toBeLessThanOrEqual(IMAGE.height);
			}
		}
	});

	test("each graticule value is labelled exactly once, on one of its runs", () => {
		opened();
		const seen = new Map<string, number>();
		for (const line of s.last.lines) {
			if (line.label === "") continue;
			const key = `${line.axis}:${line.label}`;
			seen.set(key, (seen.get(key) ?? 0) + 1);
		}
		expect(seen.size).toBeGreaterThan(0);
		for (const n of seen.values()) expect(n).toBe(1);
	});

	test("an uncertainty ring is the larger of the north and east extents, through the API", () => {
		// `geb-uncertainty` is in the CRS's distance unit (metres on Earth). At 55N a degree of
		// longitude is only cos(55) = 0.57 of a degree of latitude, so on an equirectangular
		// fixture the east probe lands noticeably further in pixels than the north one; a ring
		// sized from the north probe alone was 1.7x too narrow east-west.
		const lat = 54.99;
		const lng = -2.36;
		v.addNote("places/Vindolanda.md", { lat, lng, "geb-uncertainty": 5000 });
		opened();
		const pin = s.last.pins.find((p) => p.label === "Vindolanda")!;
		expect(pin.uncertaintyPx).not.toBeNull();
		const crs = c.api.getCrs("earth")!;
		const dLat = (5000 / crs.radius) * (180 / Math.PI);
		const dLng = dLat / Math.cos((lat * Math.PI) / 180);
		const north = c.api.toPixel(ID, lat + dLat, lng)!;
		const east = c.api.toPixel(ID, lat, lng + dLng)!;
		const rN = Math.hypot(north.x - pin.x, north.y - pin.y);
		const rE = Math.hypot(east.x - pin.x, east.y - pin.y);
		// The two axes really do differ here, so taking the larger is a decision, not a no-op.
		expect(Math.abs(rN - rE)).toBeGreaterThan(1);
		expect(pin.uncertaintyPx).toBeCloseTo(Math.max(rN, rE), 9);
	});
});
