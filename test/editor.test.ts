/**
 * The control-point editor, driven over the real API with no Obsidian in the room.
 *
 * Same arrangement as shell.test.ts: `MapShell` over the real `ApiController` and `FakeVault`,
 * painting onto a recorder. What is asserted is what the editor DECIDES — what a tap means, when
 * the draft can be saved, what the status says, what reaches the vault — against answers the API
 * gave for the same points, never against numbers typed from memory.
 *
 * Two things this file is careful about, both lessons already paid for:
 *   - a residual at the exactly-determined count is zero whatever the coordinates say, so the
 *     markers must show NOTHING there rather than a flattering number (H-1603);
 *   - after a write the index describes the pre-write world until the vault's own change event,
 *     and the fake is asked to lag its reads so a test cannot pass by accident where Obsidian
 *     would not (the "cache IS stale" measurement).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { ApiController } from "../src/api/controller";
import type { ControlPoint } from "../src/api/types";
import { trust } from "../src/view/format";
import { DEFAULT_MODEL, MapShell, MESSAGES, STATUS, type CreateSource } from "../src/view/shell";
import { fitToContainer, toImage, toScreen } from "../src/view/viewport";
import { FakeVault } from "./fake-vault";
import { CLEAN, IMAGE } from "./fixtures";
import { BYTES, COLLINEAR, CONTAINER, ID, NOTE, openShell, PLACES, Recorder, seedVault, vaultChanged } from "./shell-harness";

let v: FakeVault;
let c: ApiController;
let s: Recorder;

const NEW_ID = "new-map";
const NEW_IMAGE = "scans/new-map.png";
const CREATE: CreateSource = { imagePath: NEW_IMAGE, notePath: "maps/new-map.md" };

/** Let the surface's image measurement resolve. (`Bun.sleep`: the scanner wants no bare timer, and a CLI has no `window`.) */
const settled = (): Promise<void> => Bun.sleep(0);

/** A shell on an image with no note, measured and painted. */
async function creating(draft?: { model: "affine" | "polynomial2" | "tps"; points: readonly ControlPoint[] }): Promise<MapShell> {
	v.addFile(NEW_IMAGE, BYTES);
	c.markReady();
	const shell = new MapShell(c.api, NEW_ID, s, draft === undefined ? { create: CREATE } : { create: CREATE, draft });
	shell.open();
	await settled();
	return shell;
}

/** Where a control point sits on screen under the current viewport. */
const screenOf = (shell: MapShell, p: ControlPoint): { x: number; y: number } => toScreen(shell.view, { x: p.px, y: p.py });

beforeEach(() => {
	v = new FakeVault();
	seedVault(v);
	c = new ApiController(v, "0.0.1");
	s = new Recorder();
});

describe("a map with no note yet", () => {
	test("shows the image once the surface has measured it, with the editor open and nothing fitted", async () => {
		const shell = await creating();
		expect(s.messages).toEqual([]);
		const f = s.last;
		expect(f.image).toEqual({ src: `res:${NEW_IMAGE}`, width: IMAGE.width, height: IMAGE.height });
		expect(f.viewport).toEqual(fitToContainer(IMAGE, CONTAINER));
		expect(f.lines).toEqual([]);
		expect(f.pins).toEqual([]);
		expect(f.controlPoints).toEqual([]);
		expect(f.edit).toMatchObject({ creating: true, pointCount: 0, fittable: false, dirty: false, saving: false, model: DEFAULT_MODEL, selected: null });
		expect(f.edit?.minPoints).toBe(c.api.minPoints[DEFAULT_MODEL]);
		// The status says what the API said about an empty draft, not a number.
		const empty = c.api.previewFit([], { kind: DEFAULT_MODEL });
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(f.status).toBe(empty.message);
		expect(shell.draft).toEqual({ model: DEFAULT_MODEL, points: [] });
	});

	test("a measurement that lands after the shell closed paints nothing", async () => {
		v.addFile(NEW_IMAGE, BYTES);
		c.markReady();
		const shell = new MapShell(c.api, NEW_ID, s, { create: CREATE });
		shell.open();
		shell.close();
		await settled();
		expect(s.frames).toEqual([]);
		expect(s.messages).toEqual([]);
	});

	test("a broken image is a message, not a blank stage", async () => {
		s.measured = () => Promise.reject(new Error("decode failed"));
		await creating();
		expect(s.frames).toEqual([]);
		expect(s.lastMessage).toBe(MESSAGES.badImage(NEW_IMAGE));
	});

	test("a tap on empty image asks for the coordinate of THAT pixel; off the image it is nothing", async () => {
		const shell = await creating();
		const at = { x: 300, y: 200 };
		const tap = shell.tap(at);
		expect(tap.kind).toBe("place");
		if (tap.kind === "place") expect(tap.pixel).toEqual(toImage(shell.view, at)!);
		// The image is centred in the container; a corner of the container is outside it.
		expect(shell.tap({ x: 1, y: 1 }).kind).toBe("miss");
		expect(s.opened).toEqual([]);
	});

	test("the readout while placing is the pixel under the pointer, because there is no fit to ask", async () => {
		const shell = await creating();
		const at = { x: 300, y: 200 };
		shell.hoverAt(at);
		const img = toImage(shell.view, at)!;
		expect(s.last.readout).toBe(`${Math.round(img.x)}, ${Math.round(img.y)} px`);
	});
});

describe("placing points", () => {
	test("each placement is fitted live, the new point is selected, and save is offered at the model's minimum", async () => {
		const shell = await creating();
		const need = c.api.minPoints[DEFAULT_MODEL];
		for (let i = 0; i < need - 1; i++) shell.placePoint(CLEAN[i]!);
		let f = s.last;
		expect(f.edit).toMatchObject({ pointCount: need - 1, fittable: false, dirty: true, selected: need - 2 });
		expect(f.controlPoints).toHaveLength(need - 1);
		const short = c.api.previewFit(CLEAN.slice(0, need - 1), { kind: DEFAULT_MODEL });
		expect(short.ok).toBe(false);
		if (!short.ok) expect(f.status).toBe(`${short.message} · ${STATUS.unsaved}`);

		shell.placePoint(CLEAN[need - 1]!);
		f = s.last;
		expect(f.edit).toMatchObject({ pointCount: need, fittable: true, dirty: true, selected: need - 1 });
		const fit = c.api.previewFit(CLEAN.slice(0, need), { kind: DEFAULT_MODEL });
		expect(fit.ok).toBe(true);
		if (fit.ok) expect(f.status).toBe(`${trust(fit.fit).summary} · ${STATUS.unsaved}`);
	});

	test("markers carry NO residual at the exactly-determined count, and the API's residuals above it", async () => {
		const shell = await creating();
		const informative = c.api.recommendedPoints.affine;
		for (let i = 0; i < informative - 1; i++) shell.placePoint(CLEAN[i]!);
		// Fittable, and every residual is structurally zero: the marker must say nothing.
		expect(s.last.edit?.fittable).toBe(true);
		for (const cp of s.last.controlPoints) expect(cp.errorPx).toBeNull();
		expect(s.last.controlPoints.some((cp) => cp.worst)).toBe(false);

		shell.placePoint(CLEAN[informative - 1]!);
		const preview = c.api.previewFit(CLEAN.slice(0, informative), { kind: DEFAULT_MODEL });
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		const errors = preview.fit.diagnostics.affine;
		const cps = s.last.controlPoints;
		cps.forEach((cp, i) => expect(cp.errorPx).toBe(errors.find((r) => r.index === i)!.error));
		const worst = [...errors].sort((a, b) => b.error - a.error)[0]!;
		expect(cps.filter((cp) => cp.worst)).toHaveLength(1);
		expect(cps[worst.index]!.worst).toBe(true);
		expect(cps[worst.index]!.label).toBe(CLEAN[worst.index]!.label!);
	});

	test("a degenerate draft says why and cannot be saved, and the draft is kept", async () => {
		const shell = await creating();
		for (const p of COLLINEAR) shell.placePoint(p);
		const preview = c.api.previewFit(COLLINEAR, { kind: DEFAULT_MODEL });
		expect(preview.ok).toBe(false);
		if (!preview.ok) expect(s.last.status).toBe(`${preview.message} · ${STATUS.unsaved}`);
		expect(s.last.edit?.fittable).toBe(false);
		expect(await shell.save()).toBe(false);
		// Refused HERE, before the API: not a failed write, and nothing reached the vault.
		expect(s.last.status.startsWith("Save failed")).toBe(false);
		expect(v.creates).toEqual([]);
		expect(shell.draft?.points).toHaveLength(3);
	});

	test("changing the model refits the draft against that model's minimum", async () => {
		const shell = await creating();
		for (const p of CLEAN.slice(0, 4)) shell.placePoint(p);
		shell.setModel("polynomial2");
		expect(s.last.edit).toMatchObject({ model: "polynomial2", fittable: false, minPoints: c.api.minPoints.polynomial2 });
		for (const p of CLEAN.slice(4)) shell.placePoint(p);
		expect(s.last.edit).toMatchObject({ model: "polynomial2", fittable: true });
		const fit = c.api.previewFit(CLEAN, { kind: "polynomial2" });
		expect(fit.ok).toBe(true);
		if (fit.ok) expect(s.last.status).toBe(`${trust(fit.fit).summary} · ${STATUS.unsaved}`);
	});

	test("a tap selects the nearest draft point within the hit radius, scaled by the zoom", async () => {
		const shell = await creating();
		for (const p of CLEAN.slice(0, 4)) shell.placePoint(p);
		const target = CLEAN[1]!;
		const css = screenOf(shell, target);
		const tap = shell.tap({ x: css.x + 4, y: css.y - 3 });
		expect(tap).toEqual({ kind: "selected", index: 1 });
		expect(s.last.edit?.selected).toBe(1);
		expect(s.last.controlPoints[1]?.selected).toBe(true);
		// Zoomed in 8x, four CSS pixels is half an image pixel: the same offset still hits. At
		// one eighth it is 32 image pixels, which must not — the radius is a SCREEN size.
		for (let i = 0; i < 12; i++) shell.zoomOut();
		const far = screenOf(shell, target);
		expect(shell.tap({ x: far.x + 20, y: far.y }).kind).toBe("place");
	});

	test("two draft points under one tap: the NEARER wins, whichever was placed first", async () => {
		const shell = await creating();
		const a = CLEAN[0]!;
		// Placed first, three image pixels off; the second is on the tapped pixel exactly.
		shell.placePoint({ ...a, px: a.px + 3, py: a.py, label: "near-ish" });
		shell.placePoint({ ...a, label: "exact" });
		shell.placePoint(CLEAN[1]!);
		const tap = shell.tap(screenOf(shell, a));
		expect(tap).toEqual({ kind: "selected", index: 1 });
	});

	test("editing and deleting a point, and the delete that takes the draft below the minimum", async () => {
		const shell = await creating();
		for (const p of CLEAN.slice(0, 3)) shell.placePoint(p);
		const moved = { ...CLEAN[0]!, lat: CLEAN[0]!.lat + 0.5, label: "Moved" };
		shell.replacePoint(0, moved);
		expect(shell.draft?.points[0]).toEqual(moved);
		expect(s.last.controlPoints[0]?.label).toBe("Moved");
		shell.deletePoint(0);
		expect(shell.draft?.points).toHaveLength(2);
		expect(s.last.edit).toMatchObject({ pointCount: 2, fittable: false, selected: null });
		// Out of range is ignored, not thrown.
		shell.deletePoint(7);
		shell.replacePoint(7, moved);
		expect(shell.draft?.points).toHaveLength(2);
	});

	test("a point dragged or typed off the edge sits on the edge, not off the map", async () => {
		const shell = await creating();
		for (const p of CLEAN.slice(0, 3)) shell.placePoint(p);
		const grabbed = shell.grab(screenOf(shell, CLEAN[2]!));
		expect(grabbed).toBe(2);
		shell.movePoint(2, { x: -5000, y: 100 });
		expect(shell.draft?.points[2]?.px).toBe(0);
		shell.movePoint(2, { x: 5000, y: 100 });
		expect(shell.draft?.points[2]?.px).toBe(IMAGE.width);
		// The coordinate is untouched by a drag; only the pixel moves.
		expect(shell.draft?.points[2]?.lat).toBe(CLEAN[2]!.lat);
		// The dialog's route too: a typed pixel is clamped the same way.
		shell.replacePoint(0, { ...CLEAN[0]!, px: -3, py: IMAGE.height + 40 });
		expect(shell.draft?.points[0]).toEqual({ ...CLEAN[0]!, px: 0, py: IMAGE.height });
		// A press on empty image grabs nothing, so the adapter pans instead.
		expect(shell.grab({ x: 1, y: 1 })).toBeNull();
	});

	test("a drag moves a point by the pointer's motion, from wherever on it the press began", async () => {
		const shell = await creating();
		for (const p of CLEAN.slice(0, 3)) shell.placePoint(p);
		const css = screenOf(shell, CLEAN[1]!);
		// Pressed four CSS pixels right of the centre, as a real press is.
		expect(shell.grab({ x: css.x + 4, y: css.y })).toBe(1);
		shell.movePoint(1, { x: css.x + 4 + 30, y: css.y });
		const expected = toImage(shell.view, { x: css.x + 30, y: css.y })!;
		expect(shell.draft?.points[1]?.px).toBeCloseTo(expected.x, 9);
		expect(shell.draft?.points[1]?.py).toBeCloseTo(expected.y, 9);
		// The readout followed the pointer through the drag.
		const at = toImage(shell.view, { x: css.x + 34, y: css.y })!;
		expect(s.last.readout).toBe(`${Math.round(at.x)}, ${Math.round(at.y)} px`);
	});
});

describe("saving a new map", () => {
	test("writes once through createGeoref, holds the image until the vault's own event, then loads the map", async () => {
		const shell = await creating();
		for (const p of CLEAN) shell.placePoint(p);
		// Zoomed, so that "the viewport is kept" below is a claim a refit would fail.
		shell.zoomIn();
		shell.zoomIn();
		const zoomed = shell.view;
		expect(zoomed).not.toEqual(fitToContainer(IMAGE, CONTAINER));
		v.lagReads = true;
		expect(await shell.save()).toBe(true);
		expect(v.creates).toEqual([CREATE.notePath]);
		expect(s.last.status).toBe(STATUS.saved);
		expect(s.last.edit).toBeNull();
		expect(s.last.controlPoints).toEqual([]);
		expect(s.last.creating).toBe(false);
		expect(s.last.canEdit).toBe(false);
		expect(shell.creating).toBe(false);
		expect(shell.draft).toBeNull();
		// Edit is refused while the write awaits the index: there is no fit to copy yet, and on a
		// saved map there would be the WRONG one.
		shell.beginEdit();
		expect(shell.draft).toBeNull();

		// The index still describes a world without the note. A change ELSEWHERE arrives first
		// — a place note — and must not turn "not indexed yet" into "no such georeference".
		v.addNote("places/Elsewhere.md", { lat: 52, lng: -1 });
		c.host.invalidate("places/Elsewhere.md");
		c.flush();
		expect(c.api.getGeoref(NEW_ID)).toBeNull();
		expect(s.messages).toEqual([]);
		expect(s.last.image.width).toBe(IMAGE.width);
		expect(s.last.status).toBe(STATUS.saved);

		// Then Obsidian indexes the note.
		vaultChanged(v, c, CREATE.notePath);
		const fit = c.api.getFit(NEW_ID);
		expect(fit.points).toEqual(CLEAN);
		expect(fit.model).toBe(DEFAULT_MODEL);
		expect(s.last.status).toBe(trust(fit).summary);
		expect(s.last.lines.length).toBeGreaterThan(0);
		// The viewport the user had is kept across the arrival.
		expect(s.last.viewport).toBe(zoomed);
		// And now, with the index caught up, editing starts from the SAVED points.
		expect(s.last.canEdit).toBe(true);
		shell.beginEdit();
		expect(shell.draft).toEqual({ model: DEFAULT_MODEL, points: CLEAN });
		expect(s.last.edit?.dirty).toBe(false);
		expect(s.last.status).toBe(trust(fit).summary);
	});

	test("an event that beats the write's own promise still completes the save", async () => {
		// Nothing orders Obsidian's change event against `vault.create` resolving. Model the
		// unfavourable order: the index catches up BEFORE createGeoref returns.
		v.addFile(NEW_IMAGE, BYTES);
		c.markReady();
		const real = c.api;
		const api = new Proxy(real, {
			get(t, k) {
				if (k !== "createGeoref") return Reflect.get(t, k, t) as unknown;
				return async (input: Parameters<typeof real.createGeoref>[0]) => {
					const out = await real.createGeoref(input);
					vaultChanged(v, c, input.notePath);
					return out;
				};
			},
		});
		const shell = new MapShell(api, NEW_ID, s, { create: CREATE });
		shell.open();
		await settled();
		for (const p of CLEAN) shell.placePoint(p);
		expect(await shell.save()).toBe(true);
		// No further event will come. The save itself must have found the map.
		const fit = c.api.getFit(NEW_ID);
		expect(s.last.status).toBe(trust(fit).summary);
		expect(s.last.lines.length).toBeGreaterThan(0);
		expect(s.last.canEdit).toBe(true);
	});

	test("edits during an in-flight save are refused, not silently dropped after it", async () => {
		v.addFile(NEW_IMAGE, BYTES);
		c.markReady();
		const real = c.api;
		let release: () => void = () => undefined;
		const gate = new Promise<void>((r) => (release = r));
		const api = new Proxy(real, {
			get(t, k) {
				if (k !== "createGeoref") return Reflect.get(t, k, t) as unknown;
				return async (input: Parameters<typeof real.createGeoref>[0]) => {
					await gate;
					return real.createGeoref(input);
				};
			},
		});
		const shell = new MapShell(api, NEW_ID, s, { create: CREATE });
		shell.open();
		await settled();
		for (const p of CLEAN) shell.placePoint(p);
		const saving = shell.save();
		expect(s.last.edit?.saving).toBe(true);
		expect(s.last.status).toBe(STATUS.saving);
		// Every way of changing the draft is a no-op until the write has landed.
		shell.placePoint({ ...CLEAN[0]!, px: 1, py: 1 });
		shell.deletePoint(0);
		shell.setModel("affine");
		shell.select(3);
		shell.movePoint(0, { x: 400, y: 400 });
		expect(shell.tap(screenOf(shell, CLEAN[2]!)).kind).toBe("miss");
		expect(shell.grab(screenOf(shell, CLEAN[2]!))).toBeNull();
		expect(shell.draft).toEqual({ model: DEFAULT_MODEL, points: CLEAN });
		release();
		expect(await saving).toBe(true);
		vaultChanged(v, c, CREATE.notePath);
		expect(c.api.getFit(NEW_ID).points).toEqual(CLEAN);
	});

	test("a plain Error from the API reads as its message, not as 'Error: …'", async () => {
		v.addFile(NEW_IMAGE, BYTES);
		c.markReady();
		const api = new Proxy(c.api, {
			get(t, k) {
				if (k !== "createGeoref") return Reflect.get(t, k, t) as unknown;
				return () => Promise.reject(new Error("disk full"));
			},
		});
		const shell = new MapShell(api, NEW_ID, s, { create: CREATE });
		shell.open();
		await settled();
		for (const p of CLEAN) shell.placePoint(p);
		expect(await shell.save()).toBe(false);
		expect(s.last.status).toBe(STATUS.failed("disk full"));
	});

	test("a refused write reports why in the status and keeps the draft", async () => {
		v.addFile(NEW_IMAGE, BYTES);
		c.markReady();
		// The id is already claimed by the seeded map.
		const shell = new MapShell(c.api, ID, s, { create: CREATE });
		shell.open();
		await settled();
		for (const p of CLEAN) shell.placePoint(p);
		expect(await shell.save()).toBe(false);
		expect(s.last.status.startsWith(STATUS.failed(""))).toBe(true);
		expect(s.last.status).toContain(ID);
		expect(s.last.edit).toMatchObject({ creating: true, pointCount: 8, saving: false });
		expect(v.creates).toEqual([]);
		// The next edit clears the complaint.
		shell.select(0);
		expect(s.last.status.startsWith(STATUS.failed(""))).toBe(false);
	});

	test("discard on a map with no note empties the draft and keeps the image", async () => {
		const shell = await creating();
		for (const p of CLEAN.slice(0, 3)) shell.placePoint(p);
		shell.discardEdit();
		expect(s.last.edit).toMatchObject({ creating: true, pointCount: 0 });
		expect(s.last.image.width).toBe(IMAGE.width);
	});
});

describe("editing a saved map", () => {
	test("begin copies the fit's points, clean, with the saved residuals on the markers", () => {
		const shell = openShell(c, s);
		const fit = c.api.getFit(ID);
		shell.beginEdit();
		const f = s.last;
		expect(f.edit).toMatchObject({ creating: false, model: fit.model, pointCount: fit.pointCount, dirty: false, fittable: true, selected: null });
		expect(shell.draft).toEqual({ model: fit.model, points: fit.points });
		f.controlPoints.forEach((cp, i) => expect(cp.errorPx).toBe(fit.diagnostics.affine.find((r) => r.index === i)!.error));
		// The saved map stays underneath: graticule and readout still answer.
		expect(f.lines.length).toBeGreaterThan(0);
		expect(f.status).toBe(trust(fit).summary);
	});

	test("a second beginEdit does not restart an edit in progress", () => {
		const shell = openShell(c, s);
		shell.beginEdit();
		shell.deletePoint(0);
		shell.beginEdit();
		expect(shell.draft?.points).toHaveLength(CLEAN.length - 1);
	});

	test("the readout while editing shows the world coordinate AND the pixel", () => {
		const shell = openShell(c, s);
		shell.beginEdit();
		const at = { x: 400, y: 300 };
		shell.hoverAt(at);
		const img = toImage(shell.view, at)!;
		const w = c.api.toLatLng(ID, img.x, img.y);
		expect(w).not.toBeNull();
		expect(s.last.readout.endsWith(`${Math.round(img.x)}, ${Math.round(img.y)} px`)).toBe(true);
		expect(s.last.readout.startsWith(" ")).toBe(false);
		expect(s.last.readout).toContain(" · ");
	});

	test("while editing, a tap on a place pin selects the draft point there and opens nothing", () => {
		const shell = openShell(c, s);
		shell.beginEdit();
		// Eboracum is both a place note and a control point, at the same pixel.
		const eboracum = c.api.featuresIn(ID)!.find((p) => p.feature.notePath === "places/Eboracum.md")!;
		const css = toScreen(shell.view, { x: eboracum.x, y: eboracum.y });
		const tap = shell.tap(css);
		expect(tap.kind).toBe("selected");
		expect(s.opened).toEqual([]);
		// Orkney has no control point: a tap there is a placement, not a note.
		const orkney = c.api.featuresIn(ID)!.find((p) => p.feature.notePath === "places/Orkney.md")!;
		expect(shell.tap(toScreen(shell.view, { x: orkney.x, y: orkney.y })).kind).toBe("place");
		expect(s.opened).toEqual([]);
	});

	test("moving a point marks the draft dirty, save writes updateGeoref, and the map reloads on the event", async () => {
		const shell = openShell(c, s);
		shell.beginEdit();
		const before = c.api.getFit(ID);
		const css = screenOf(shell, CLEAN[1]!);
		expect(shell.grab(css)).toBe(1);
		const to = { x: css.x + 30, y: css.y + 30 };
		shell.movePoint(1, to);
		const img = toImage(shell.view, to)!;
		expect(shell.draft?.points[1]).toEqual({ ...CLEAN[1]!, px: img.x, py: img.y });
		expect(s.last.edit?.dirty).toBe(true);
		// The screen still shows the SAVED fit until the write lands and is indexed.
		expect(s.last.status.endsWith(STATUS.unsaved)).toBe(true);

		v.lagReads = true;
		expect(await shell.save()).toBe(true);
		expect(v.writes).toEqual([NOTE]);
		expect(s.last.edit).toBeNull();
		expect(s.last.status).toBe(STATUS.saved);
		expect(c.api.getFit(ID).points[1]).toEqual(before.points[1]);

		vaultChanged(v, c, NOTE);
		const after = c.api.getFit(ID);
		expect(after.points[1]).toEqual({ ...CLEAN[1]!, px: img.x, py: img.y });
		expect(s.last.status).toBe(trust(after).summary);
		expect(s.last.controlPoints).toEqual([]);
	});

	test("save with the model changed writes the model, and the draft's lambda follows the map's", async () => {
		v.addNote("maps/smooth.md", { ...v.notes.get(NOTE)!, "geb-fits": [{ bounds: null, transform: { model: "tps", lambda: 0.5 }, points: CLEAN.map((p) => ({ ...p })) }] });
		// Two notes claiming one id would be a duplicate; give this one its own.
		const fm = v.notes.get("maps/smooth.md")!;
		fm["geb-id"] = "smooth";
		const shell = openShell(c, s, "smooth");
		shell.beginEdit();
		shell.setModel("affine");
		expect(s.last.edit?.dirty).toBe(true);
		expect(await shell.save()).toBe(true);
		vaultChanged(v, c, "maps/smooth.md");
		const after = c.api.getFit("smooth");
		expect(after.model).toBe("affine");
		expect(after.lambda).toBe(0.5);
	});

	test("discard drops the changes, writes nothing, and the saved fit is untouched", async () => {
		const shell = openShell(c, s);
		shell.beginEdit();
		shell.deletePoint(0);
		shell.setModel("affine");
		expect(s.last.edit?.dirty).toBe(true);
		shell.discardEdit();
		expect(s.last.edit).toBeNull();
		expect(shell.draft).toBeNull();
		expect(s.last.controlPoints).toEqual([]);
		expect(s.last.status).toBe(trust(c.api.getFit(ID)).summary);
		expect(v.writes).toEqual([]);
		await settled();
		expect(c.api.getFit(ID).points).toEqual(CLEAN);
	});

	test("deleting below the minimum refuses save without touching the vault", async () => {
		const shell = openShell(c, s);
		shell.beginEdit();
		shell.setModel("polynomial2");
		for (let i = 0; i < 3; i++) shell.deletePoint(0);
		expect(s.last.edit).toMatchObject({ pointCount: 5, fittable: false });
		expect(await shell.save()).toBe(false);
		expect(v.writes).toEqual([]);
	});
});

describe("the draft across the shell's lifetime", () => {
	test("a restored draft resumes, and is refitted once the map has loaded", () => {
		// A map with a smoothing lambda: the draft fitted before the map loads cannot know it,
		// and a draft equal to the saved points reads as dirty until there is a fit to compare.
		const fm = { ...v.notes.get(NOTE)!, "geb-id": "smooth", "geb-fits": [{ bounds: null, transform: { model: "tps", lambda: 0.5 }, points: CLEAN.map((p) => ({ ...p })) }] };
		v.addNote("maps/smooth.md", fm);
		const draft = { model: "tps" as const, points: CLEAN };
		const shell = new MapShell(c.api, "smooth", s, { draft });
		shell.open();
		expect(s.lastMessage).toBe(MESSAGES.indexing);
		expect(shell.draft).toEqual(draft);
		c.markReady();
		expect(shell.draft).toEqual(draft);
		expect(s.last.edit).toMatchObject({ creating: false, model: "tps", pointCount: CLEAN.length, dirty: false, fittable: true });
		const fit = c.api.previewFit(CLEAN, { kind: "tps", lambda: 0.5 });
		expect(fit.ok).toBe(true);
		if (fit.ok) expect(s.last.status).toBe(trust(fit.fit).summary);
		expect(s.last.status.endsWith(STATUS.unsaved)).toBe(false);
	});

	test("a restored draft on a map with no note resumes placing", async () => {
		const shell = await creating({ model: "tps", points: CLEAN.slice(0, 2) });
		expect(s.last.edit).toMatchObject({ creating: true, pointCount: 2 });
		shell.placePoint(CLEAN[2]!);
		expect(s.last.edit?.fittable).toBe(true);
	});

	test("unload mid-edit shows the message and keeps the draft for the layout to save", async () => {
		const shell = await creating();
		for (const p of CLEAN.slice(0, 2)) shell.placePoint(p);
		c.unload();
		expect(s.lastMessage).toBe(MESSAGES.unloaded);
		expect(shell.draft?.points).toHaveLength(2);
		// And nothing paints over the message.
		const frames = s.frames.length;
		shell.placePoint(CLEAN[2]!);
		shell.zoomIn();
		expect(s.frames).toHaveLength(frames);
	});

	test("the vault still indexing is a message for a saved map but not for one with no note", async () => {
		// A map with no note has nothing to wait for: the user can place points before `ready`.
		v.addFile(NEW_IMAGE, BYTES);
		const shell = new MapShell(c.api, NEW_ID, s, { create: CREATE });
		shell.open();
		await settled();
		expect(s.messages).toEqual([]);
		expect(s.last.edit?.creating).toBe(true);
		shell.placePoint(CLEAN[0]!);
		expect(s.last.edit?.pointCount).toBe(1);
	});

	test("the editor is a no-op with no map on screen", () => {
		const shell = new MapShell(c.api, ID, s);
		shell.open();
		expect(s.lastMessage).toBe(MESSAGES.indexing);
		shell.beginEdit();
		expect(shell.draft).toBeNull();
		expect(shell.tap({ x: 10, y: 10 }).kind).toBe("miss");
		expect(shell.grab({ x: 10, y: 10 })).toBeNull();
	});
});

describe("the place notes the picker offers", () => {
	test("are the API's features, so a pick fills a point from a note's own coordinates", () => {
		c.markReady();
		const features = c.api.listFeatures();
		expect(features.map((f) => f.notePath).sort()).toEqual(Object.keys(PLACES).sort());
		const eboracum = features.find((f) => f.notePath === "places/Eboracum.md")!;
		expect({ lat: eboracum.lat, lng: eboracum.lng }).toEqual(PLACES["places/Eboracum.md"]);
	});
});
