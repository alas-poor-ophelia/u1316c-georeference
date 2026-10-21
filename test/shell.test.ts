/**
 * The view shell, driven over the real API with no Obsidian in the room.
 *
 * `MapShell` is handed the same `ApiController` over the same `FakeVault` the API tests use, and
 * a recording `Surface` instead of elements. So every assertion here is about what the view DECIDES
 * — where it puts a pin, what the readout says, when it reloads — against answers the API itself
 * gave, not against numbers typed from memory.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { ApiController } from "../src/api/controller";
import { toFrontmatter } from "../src/persist/serialize";
import { coordinate } from "../src/view/format";
import { MapShell, MESSAGES } from "../src/view/shell";
import { fitToContainer, toImage, toScreen } from "../src/view/viewport";
import { FakeVault } from "./fake-vault";
import { CLEAN, IMAGE } from "./fixtures";
import { BYTES, COLLINEAR, CONTAINER, georef, ID, NOTE, openShell, PLACES, Recorder, seedVault } from "./shell-harness";

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

describe("opening", () => {
	test("before the vault is indexed it waits, and loads itself on ready", () => {
		const shell = new MapShell(c.api, ID, s);
		shell.open();
		expect(s.frames).toHaveLength(0);
		expect(s.messages).toEqual([MESSAGES.indexing]);
		c.markReady();
		expect(s.frames).toHaveLength(1);
	});

	test("paints the image fitted to the container, by the viewport module's own answer", () => {
		opened();
		const f = s.last;
		expect(f.image).toEqual({ src: `res:${ID}.png`, width: IMAGE.width, height: IMAGE.height });
		expect(f.viewport).toEqual(fitToContainer(IMAGE, CONTAINER));
	});

	test("an id no note claims is a message, not an empty map", () => {
		c.markReady();
		new MapShell(c.api, "nowhere", s).open();
		expect(s.frames).toHaveLength(0);
		expect(s.messages).toEqual([MESSAGES.noGeoref("nowhere")]);
	});

	test("a rejected map shows the API's reason rather than vanishing", () => {
		// Three collinear points cannot be fitted, so the note is REJECTED with a reason.
		v.addFile("flat.png", BYTES);
		v.addNote("maps/flat.md", toFrontmatter({ ...georef("flat"), fits: [{ bounds: null, transform: { model: "affine" }, points: COLLINEAR }] }));
		c.markReady();
		new MapShell(c.api, "flat", s).open();
		expect(s.frames).toHaveLength(0);
		expect(s.messages).toHaveLength(1);
		expect(s.messages[0]).not.toBe(MESSAGES.noGeoref("flat"));
		expect(s.messages[0]!.length).toBeGreaterThan(10);
	});

	test("the status line carries the trust summary", () => {
		opened();
		expect(s.last.status).toContain(`tps, ${CLEAN.length} points`);
		expect(s.last.status).toContain("RMS");
	});
});

describe("pins", () => {
	test("sit exactly where the API places each feature, labelled by note name", () => {
		opened();
		const api = c.api.featuresIn(ID)!;
		const f = s.last;
		expect(f.pins).toHaveLength(Object.keys(PLACES).length);
		for (const pin of f.pins) {
			const match = api.find((p) => p.feature.notePath === pin.notePath);
			expect(match).toBeDefined();
			expect(pin.x).toBe(match!.x);
			expect(pin.y).toBe(match!.y);
			expect(pin.extrapolated).toBe(match!.extrapolated);
		}
		expect(f.pins.map((p) => p.label).sort()).toEqual(["Eboracum", "Londinium", "Orkney"]);
	});

	test("a place outside the control-point hull is marked extrapolated, never dropped", () => {
		opened();
		const orkney = s.last.pins.find((p) => p.label === "Orkney");
		expect(orkney).toBeDefined();
		expect(orkney!.extrapolated).toBe(true);
		expect(s.last.pins.find((p) => p.label === "Eboracum")!.extrapolated).toBe(false);
	});

	test("with no declared uncertainty there is no ring", () => {
		opened();
		for (const pin of s.last.pins) expect(pin.uncertaintyPx).toBeNull();
	});

	test("a tap within reach of a pin opens its note; a tap elsewhere does not", () => {
		const shell = opened();
		const york = s.last.pins.find((p) => p.label === "Eboracum")!;
		const css = toScreen(shell.view, { x: york.x, y: york.y });
		expect(shell.tap({ x: css.x + 4, y: css.y - 3 }).kind).toBe("note");
		expect(s.opened).toEqual(["places/Eboracum.md"]);
		// Far from every pin: the top-left of the container.
		expect(shell.tap({ x: 2, y: 2 }).kind).toBe("miss");
		expect(s.opened).toHaveLength(1);
	});
});

describe("the readout", () => {
	test("says what the API says for the image pixel under the pointer", () => {
		const shell = opened();
		const css = { x: CONTAINER.width / 2, y: CONTAINER.height / 2 };
		shell.hoverAt(css);
		const img = toImage(shell.view, css)!;
		const w = c.api.toLatLng(ID, img.x, img.y)!;
		expect(s.last.readout).toBe(coordinate(w) + (w.extrapolated ? " · extrapolated" : ""));
	});

	test("is empty off the image even where the transform would answer", () => {
		// ON A MAP WHOSE FIT REACHES THE EDGE. On the Britain fixture the hull sits deep inside
		// the image, so a point just outside the image is hundreds of pixels outside the hull and
		// the round-trip gate refuses it — the readout is empty whether or not the shell checks
		// the image bounds, and a mutant deleting that check survived two earlier versions of
		// this test. An affine map pinned at its own corners answers everywhere, so here the
		// bounds check is the ONLY thing keeping the readout quiet, and the assertion that the
		// API does answer proves the input reached it.
		const corners = [
			{ px: 0, py: 0, lat: 60, lng: -8 },
			{ px: IMAGE.width, py: 0, lat: 60, lng: 4 },
			{ px: IMAGE.width, py: IMAGE.height, lat: 49.3333, lng: 4 },
			{ px: 0, py: IMAGE.height, lat: 49.3333, lng: -8 },
			{ px: IMAGE.width / 2, py: IMAGE.height / 2, lat: 54.66665, lng: -2 },
		];
		v.addFile("edge.png", BYTES);
		v.addNote("maps/edge.md", toFrontmatter({ ...georef("edge"), fits: [{ bounds: null, transform: { model: "affine" }, points: corners }] }));
		const shell = openShell(c, s, "edge");
		const outside = { x: -5, y: IMAGE.height / 2 };
		expect(c.api.toLatLng("edge", outside.x, outside.y)).not.toBeNull();
		shell.hoverAt(toScreen(shell.view, outside));
		expect(s.last.readout).toBe("");
	});

	test("is empty off the image, and empty again when the pointer leaves", () => {
		const shell = opened();
		// The image is centred in a wider container, so the far left edge is off the image.
		shell.hoverAt({ x: 1, y: CONTAINER.height / 2 });
		expect(s.last.readout).toBe("");
		shell.hoverAt({ x: CONTAINER.width / 2, y: CONTAINER.height / 2 });
		expect(s.last.readout).not.toBe("");
		shell.hoverAt(null);
		expect(s.last.readout).toBe("");
	});

	test("names extrapolation where the API does, and only there", () => {
		// DERIVED POSITIONS, not guessed ones. A first version hovered the image's corner, which
		// the round-trip gate refuses, so the branch under test never ran and a mutant deleting
		// the suffix survived. The pins already tell us where the API resolves AND extrapolates:
		// Orkney lies outside the hull, Eboracum inside, and both resolve by construction.
		const shell = opened();
		const pins = s.last.pins;
		const orkney = pins.find((p) => p.label === "Orkney")!;
		const york = pins.find((p) => p.label === "Eboracum")!;
		shell.hoverAt(toScreen(shell.view, { x: orkney.x, y: orkney.y }));
		expect(s.last.readout).toContain("extrapolated");
		shell.hoverAt(toScreen(shell.view, { x: york.x, y: york.y }));
		expect(s.last.readout).not.toBe("");
		expect(s.last.readout).not.toContain("extrapolated");
	});
});

describe("the viewport", () => {
	test("wheel zoom keeps the image pixel under the pointer under the pointer", () => {
		const shell = opened();
		const css = { x: 300, y: 200 };
		const before = toImage(shell.view, css)!;
		shell.wheel(css, -120);
		expect(shell.view.scale).toBeGreaterThan(fitToContainer(IMAGE, CONTAINER).scale);
		const after = toImage(shell.view, css)!;
		expect(after.x).toBeCloseTo(before.x, 9);
		expect(after.y).toBeCloseTo(before.y, 9);
		// And the frame painted carries the new viewport.
		expect(s.last.viewport).toEqual(shell.view);
	});

	test("one wheel event is bounded to 2x, whatever the device reports", () => {
		// EXACTLY 2x, not "at most 2x". A first version only asserted the upper bound against a
		// delta so large the raw factor was INFINITE — and `zoomAbout` already ignores a
		// non-finite factor, so with the clamp deleted the zoom became a no-op and the bound
		// held anyway. A finite but absurd delta (exp(4) ≈ 55x raw) is what distinguishes the
		// clamp from nothing; and the infinite case must still zoom, not freeze.
		const shell = opened();
		const base = shell.view.scale;
		shell.wheel({ x: 10, y: 10 }, -2000);
		expect(shell.view.scale / base).toBeCloseTo(2, 9);
		shell.fitImage();
		shell.wheel({ x: 10, y: 10 }, -1e6);
		expect(shell.view.scale / base).toBeCloseTo(2, 9);
		shell.fitImage();
		shell.wheel({ x: 10, y: 10 }, 2000);
		expect(shell.view.scale / base).toBeCloseTo(0.5, 9);
	});

	test("a drag pans by exactly the delta", () => {
		const shell = opened();
		const { offsetX, offsetY } = shell.view;
		shell.drag(17, -9);
		expect(shell.view.offsetX).toBe(offsetX + 17);
		expect(shell.view.offsetY).toBe(offsetY - 9);
	});

	test("the buttons zoom about the centre and fit restores the baseline", () => {
		const shell = opened();
		const fit = fitToContainer(IMAGE, CONTAINER);
		shell.zoomIn();
		expect(shell.view.scale).toBeGreaterThan(fit.scale);
		shell.zoomOut();
		expect(shell.view.scale).toBeCloseTo(fit.scale, 9);
		shell.drag(50, 50);
		shell.fitImage();
		expect(shell.view).toEqual(fit);
	});

	test("a resize re-fits an untouched view and leaves an adjusted one alone", () => {
		const shell = opened();
		s.sizeValue = { width: 400, height: 300 };
		shell.resize();
		expect(shell.view).toEqual(fitToContainer(IMAGE, s.sizeValue));
		shell.drag(10, 10);
		const adjusted = shell.view;
		s.sizeValue = { width: 1000, height: 700 };
		shell.resize();
		expect(shell.view).toEqual(adjusted);
	});
});

describe("the graticule", () => {
	test("has parallels and meridians, every point answered by the transform", () => {
		opened();
		const lines = s.last.lines;
		expect(lines.some((l) => l.axis === "lat")).toBe(true);
		expect(lines.some((l) => l.axis === "lng")).toBe(true);
		for (const line of lines) {
			expect(line.points.length).toBeGreaterThanOrEqual(2);
			expect(line.label).toContain("°");
			for (const p of line.points) {
				expect(Number.isFinite(p.x)).toBe(true);
				expect(Number.isFinite(p.y)).toBe(true);
			}
		}
	});

	test("a parallel really is a line of constant latitude through the API", () => {
		opened();
		const parallel = s.last.lines.find((l) => l.axis === "lat")!;
		const lats = parallel.points.map((p) => c.api.toLatLng(ID, p.x, p.y)).filter((w) => w !== null);
		expect(lats.length).toBeGreaterThan(2);
		const spread = Math.max(...lats.map((w) => w.lat)) - Math.min(...lats.map((w) => w.lat));
		// Round-trip through the spline: a few thousandths of a degree, not a few degrees.
		expect(spread).toBeLessThan(0.05);
	});
});

describe("staying current", () => {
	test("a change to this map's fit repaints with the new points and keeps the viewport", async () => {
		const shell = opened();
		shell.drag(33, 44);
		const adjusted = shell.view;
		const before = s.frames.length;
		await c.api.addPoint(ID, { px: 5, py: 6, lat: 52.2, lng: 0.12, label: "Camboricum" });
		// A WRITE DOES NOT INVALIDATE THE INDEX — the API documents this, and this test is where
		// it bit: with only the write, nothing repainted. In Obsidian the metadata cache's own
		// `changed` event is what invalidates the note; the fake has no such event, so the test
		// plays that role explicitly, exactly as the plugin's `watchVault` does.
		v.settleCache();
		c.host.invalidate(NOTE);
		c.flush();
		expect(s.frames.length).toBeGreaterThan(before);
		expect(s.last.status).toContain(`${CLEAN.length + 1} points`);
		expect(s.last.viewport).toEqual(adjusted);
	});

	test("a change to a place note repaints the pins", () => {
		opened();
		const before = s.last.pins.length;
		v.addNote("places/Lindum.md", { lat: 53.23, lng: -0.54 });
		v.settleCache();
		c.host.invalidate("places/Lindum.md");
		c.flush();
		expect(s.last.pins.length).toBe(before + 1);
	});

	test("a change to ANOTHER map does not wake this view", () => {
		opened();
		v.addFile("other.png", BYTES);
		v.addNote("maps/other.md", toFrontmatter({ ...georef(), id: "other", imageLink: "[[other.png]]" }));
		v.settleCache();
		const before = s.frames.length;
		c.host.invalidate("maps/other.md");
		c.flush();
		expect(s.frames.length).toBe(before);
	});

	test("unload replaces the map with a message, and closing stops all listening", () => {
		const shell = opened();
		c.unload();
		expect(s.messages[s.messages.length - 1]).toBe(MESSAGES.unloaded);
		// Nothing after this may throw, whatever the adapter still forwards.
		shell.hoverAt({ x: 1, y: 1 });
		shell.wheel({ x: 1, y: 1 }, -10);
		expect(shell.tap({ x: 1, y: 1 }).kind).toBe("miss");
	});

	test("after close, a vault change no longer paints", () => {
		const shell = opened();
		shell.close();
		const before = s.frames.length;
		v.addNote("places/Lindum.md", { lat: 53.23, lng: -0.54 });
		v.settleCache();
		c.host.invalidate("places/Lindum.md");
		c.flush();
		expect(s.frames.length).toBe(before);
	});
});

describe("frames are cheap to diff", () => {
	// THIS WAS A THROWAWAY PROBE FIRST, and the project's own field note says a probe that is
	// deleted leaves no evidence. The adapter rebuilds the SVG overlay only when the pin or line
	// ARRAYS change by reference, so the shell must hand back the same arrays across hovers and
	// new ones after a reload. Both directions are pinned here; a mutant that copies the array on
	// every paint, or that forgets to rebuild it on reload, fails this block.
	test("a hover repaints with the SAME pin and line arrays, and the same viewport", () => {
		const shell = opened();
		shell.hoverAt({ x: 400, y: 300 });
		shell.hoverAt({ x: 401, y: 300 });
		const [a, b] = s.frames.slice(-2);
		expect(a!.pins).toBe(b!.pins);
		expect(a!.lines).toBe(b!.lines);
		expect(a!.viewport).toBe(b!.viewport);
		expect(a!.readout).not.toBe(""); // and the readout genuinely changed hands
	});

	test("a reload hands back NEW arrays, with pins where the API now puts them", async () => {
		opened();
		const before = s.last;
		await c.api.addPoint(ID, { px: 5, py: 6, lat: 52.2, lng: 0.12 });
		v.settleCache();
		c.host.invalidate(NOTE);
		c.flush();
		const after = s.last;
		expect(after.pins).not.toBe(before.pins);
		expect(after.lines).not.toBe(before.lines);
		const api = c.api.featuresIn(ID)!;
		for (const pin of after.pins) {
			const match = api.find((p) => p.feature.notePath === pin.notePath)!;
			expect(pin.x).toBe(match.x);
			expect(pin.y).toBe(match.y);
		}
	});
});
