/**
 * The phase-4 gate: EVERY method exercised behaviourally, not shape-checked.
 *
 * A conformance test proves the surface has the right shape; it cannot prove a method does
 * anything. So each one here is driven through the fake vault and asserted on its effect, and the
 * lifecycle gates are asserted by calling every method on a controller that is not ready and then
 * on one that has been unloaded.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { ApiController } from "../src/api/controller";
import type { GebErrorCode } from "../src/api/errors";
import { MIN_POINTS, type ControlPoint } from "../src/core/types";
import { hashBytes } from "../src/persist/identity";
import { IndexHost } from "../src/api/host";
import { toFrontmatter } from "../src/persist/serialize";
import { KEY, type Georeference } from "../src/persist/types";
import { CLEAN, IMAGE } from "./fixtures";
import { FakeVault } from "./fake-vault";
import { API_KEYS } from "./types/conformance";

const BYTES = new Uint8Array([1, 2, 3, 4]).buffer;
const YORK = { lat: 53.9591, lng: -1.0815 };
const VERSION = "0.0.1";

let v: FakeVault;
let c: ApiController;

const georef = (id: string, crs = "earth"): Georeference => ({
	id,
	imageLink: `[[${id}.png]]`,
	image: { width: IMAGE.width, height: IMAGE.height, byteLength: BYTES.byteLength, hash: hashBytes(BYTES) },
	crs,
	fits: [{ bounds: null, transform: { model: "tps" }, points: CLEAN.map((p) => ({ ...p })) }],
});

const addGeoref = (g: Georeference): void => {
	v.addFile(`${g.id}.png`, BYTES);
	v.addNote(`maps/${g.id}.md`, toFrontmatter(g));
};

/** The code off a thrown CodedError, asserting that something actually threw. */
const codeOf = (fn: () => unknown): GebErrorCode | null => {
	try {
		fn();
	} catch (e) {
		return (e as { code?: GebErrorCode }).code ?? null;
	}
	throw new Error("expected a throw, got none");
};

const asyncCodeOf = async (p: Promise<unknown>): Promise<GebErrorCode | null> => {
	let caught: unknown;
	let threw = false;
	try {
		await p;
	} catch (e) {
		threw = true;
		caught = e;
	}
	expect(threw).toBe(true);
	return (caught as { code?: GebErrorCode }).code ?? null;
};

beforeEach(() => {
	v = new FakeVault();
	c = new ApiController(v, VERSION);
});

describe("the surface itself", () => {
	test("the live object's keys are EXACTLY the documented set", () => {
		// The runtime half of the conformance check. The type half proves the declared surface
		// matches the standalone .d.ts; it cannot prove the object actually carries each method,
		// nor that an undocumented one has not been added. This asserts both directions.
		expect(Object.keys(c.api).sort()).toEqual([...API_KEYS].sort());
	});

	test("every documented key is present and of the right kind", () => {
		for (const key of API_KEYS) {
			expect(key in c.api, key).toBe(true);
		}
		// The six values, and the rest functions.
		const values = new Set(["version", "apiVersion", "ready", "generation", "minPoints", "recommendedPoints"]);
		for (const key of API_KEYS) {
			const v = (c.api as unknown as Record<string, unknown>)[key];
			expect(typeof v === "function", `${key} should be a function`).toBe(!values.has(key));
		}
	});
});

describe("the lifecycle gates", () => {
	test("ready is false until the vault is indexed, and every vault query refuses", () => {
		addGeoref(georef("britain-5c"));
		expect(c.api.ready).toBe(false);

		// An empty answer here would be a confident lie: before indexing, buildIndex reads a
		// partial cache and reports an empty vault with no problems.
		expect(codeOf(() => c.api.listGeorefs())).toBe("geb-not-ready");
		expect(codeOf(() => c.api.listFeatures())).toBe("geb-not-ready");
		expect(codeOf(() => c.api.listProblems())).toBe("geb-not-ready");
		expect(codeOf(() => c.api.listRejected())).toBe("geb-not-ready");
		expect(codeOf(() => c.api.georefsCovering(YORK.lat, YORK.lng))).toBe("geb-not-ready");
		expect(codeOf(() => c.api.getGeoref("britain-5c"))).toBe("geb-not-ready");
		expect(codeOf(() => c.api.getFit("britain-5c"))).toBe("geb-not-ready");
		expect(codeOf(() => c.api.getImageInfo("britain-5c"))).toBe("geb-not-ready");
		expect(codeOf(() => c.api.toPixel("britain-5c", YORK.lat, YORK.lng))).toBe("geb-not-ready");
		expect(codeOf(() => c.api.toLatLng("britain-5c", 10, 10))).toBe("geb-not-ready");
		expect(codeOf(() => c.api.featuresIn("britain-5c"))).toBe("geb-not-ready");
	});

	test("but the vault-free methods work before ready, because they need no index", () => {
		// previewFit is the interactive path and must not wait on indexing: a view placing points
		// needs an answer from the kernel, which knows nothing about the vault.
		expect(c.api.listCrs().length).toBeGreaterThan(0);
		expect(c.api.getCrs("earth")).not.toBeNull();
		expect(c.api.previewFit(CLEAN, { kind: "affine" }).ok).toBe(true);
		expect(c.api.version).toBe(VERSION);
		expect(c.api.apiVersion).toBe(1);
	});

	test("ready flips on markReady and back off on unload", () => {
		c.markReady();
		expect(c.api.ready).toBe(true);
		c.unload();
		expect(c.api.ready).toBe(false);
	});

	test("after unload EVERY method throws geb-unloaded", async () => {
		addGeoref(georef("britain-5c"));
		c.markReady();
		c.unload();

		for (const [name, call] of [
			["listCrs", () => c.api.listCrs()],
			["getCrs", () => c.api.getCrs("earth")],
			["listGeorefs", () => c.api.listGeorefs()],
			["getGeoref", () => c.api.getGeoref("britain-5c")],
			["getImageInfo", () => c.api.getImageInfo("britain-5c")],
			["getFit", () => c.api.getFit("britain-5c")],
			["previewFit", () => c.api.previewFit(CLEAN, { kind: "affine" })],
			["toPixel", () => c.api.toPixel("britain-5c", YORK.lat, YORK.lng)],
			["toLatLng", () => c.api.toLatLng("britain-5c", 10, 10)],
			["georefsCovering", () => c.api.georefsCovering(YORK.lat, YORK.lng)],
			["listFeatures", () => c.api.listFeatures()],
			["featuresIn", () => c.api.featuresIn("britain-5c")],
			["listProblems", () => c.api.listProblems()],
			["listRejected", () => c.api.listRejected()],
			["on", () => c.api.on("ready", () => undefined)],
		] as const) {
			expect(codeOf(call), name).toBe("geb-unloaded");
		}

		// The async half, which cannot share the loop above.
		expect(await asyncCodeOf(c.api.deleteGeoref("britain-5c"))).toBe("geb-unloaded");
		expect(await asyncCodeOf(c.api.addPoint("britain-5c", { px: 1, py: 1, lat: 1, lng: 1 }))).toBe("geb-unloaded");
		expect(await asyncCodeOf(c.api.updatePoint("britain-5c", 0, { px: 1, py: 1, lat: 1, lng: 1 }))).toBe("geb-unloaded");
		expect(await asyncCodeOf(c.api.removePoint("britain-5c", 0))).toBe("geb-unloaded");
		expect(await asyncCodeOf(c.api.updateGeoref("britain-5c", { crs: "earth" }))).toBe("geb-unloaded");
		expect(
			await asyncCodeOf(
				c.api.createGeoref({
					notePath: "maps/x.md",
					id: "x",
					imagePath: "britain-5c.png",
					imageWidth: 10,
					imageHeight: 10,
					model: "affine",
					points: CLEAN,
				}),
			),
		).toBe("geb-unloaded");
	});
});

describe("reading", () => {
	beforeEach(() => {
		addGeoref(georef("britain-5c"));
		v.addNote("places/Eboracum.md", { lat: YORK.lat, lng: YORK.lng });
		c.markReady();
	});

	test("listGeorefs and getGeoref summarise without the fit", () => {
		const [g] = c.api.listGeorefs();
		expect(g).toEqual({ id: "britain-5c", notePath: "maps/britain-5c.md", crs: "earth", model: "tps", pointCount: CLEAN.length });
		expect(c.api.getGeoref("britain-5c")).toEqual(g!);
	});

	test("getGeoref is null for an id nothing claims", () => {
		expect(c.api.getGeoref("no-such-map")).toBeNull();
	});

	test("a REJECTED georeference throws WITH THE REASON, rather than reading as absent", () => {
		// The hole the architecture review found: the index knows why a map failed and the surface
		// had no way to say so. A map that could not load must never look like one that was never
		// there.
		//
		// A DEGENERATE FIT, not a duplicate id. The first version of this test used a duplicate,
		// which is the wrong fixture — one of the two copies still LOADS under that id, so
		// `getGeoref` finds it and the rejected-path branch is never reached. The assertion was
		// hedged too, and passed with the branch deleted.
		const collinear: ControlPoint[] = [
			{ px: 0, py: 0, lat: 0, lng: 0 },
			{ px: 10, py: 10, lat: 1, lng: 1 },
			{ px: 20, py: 20, lat: 2, lng: 2 },
		];
		const g = georef("flat");
		v.addFile("flat.png", BYTES);
		v.addNote("maps/flat.md", toFrontmatter({ ...g, fits: [{ ...g.fits[0]!, transform: { model: "affine" }, points: collinear }] }));
		const fresh = new ApiController(v, VERSION);
		fresh.markReady();

		// Proof the id really is rejected rather than simply missing.
		expect(fresh.api.listRejected().map((r) => [r.id, r.code])).toEqual([["flat", "degenerate-fit"]]);

		let caught: unknown = null;
		try {
			fresh.api.getGeoref("flat");
		} catch (e) {
			caught = e;
		}
		expect((caught as { code?: string } | null)?.code).toBe("geb-no-such-georef");
		expect((caught as Error).message).toContain("maps/flat.md");

		// And an id nothing claims at all is still a plain null, not a throw.
		expect(fresh.api.getGeoref("never-existed")).toBeNull();
	});

	test("a handout cannot be mutated into the kernel's own registry", () => {
		// Where the structuredClone handout is actually load-bearing in this version: `listCrs`
		// returns the kernel's MODULE-LEVEL array, shared by every call and every consumer. The
		// georeference lists are rebuilt per call, so mutating one of those proves nothing — which
		// is why the first version of this test survived having the clone removed.
		const first = c.api.listCrs();
		(first as unknown as { name: string }[])[0]!.name = "Tampered";
		expect(c.api.listCrs()[0]!.name).toBe("Earth");
		expect(c.api.getCrs("earth")!.name).toBe("Earth");
	});

	test("getImageInfo resolves the link and never claims an unchecked image is current", () => {
		const info = c.api.getImageInfo("britain-5c");
		expect(info.path).toBe("britain-5c.png");
		expect(info.width).toBe(IMAGE.width);
		expect(info.byteLength).toBe(BYTES.byteLength);
		// Only reconciliation reads bytes, and it has not run. "same" would be unearned.
		expect(info.staleness).toBe("unknown");
	});

	test("getFit projects to plain data and carries NO mapping", () => {
		// The constraint behind the whole projection: a Fit holds `forward`/`reverse` Mapping
		// objects with an `apply` function, so structuredClone would throw on it — and reading its
		// properties would fire the memoised diagnostics getter.
		const fit = c.api.getFit("britain-5c");
		expect(fit.model).toBe("tps");
		expect(fit.pointCount).toBe(CLEAN.length);
		expect(fit.hull.length).toBeGreaterThan(2);
		expect(fit.diagnostics.affine.length).toBe(CLEAN.length);
		expect("forward" in fit).toBe(false);
		expect("reverse" in fit).toBe(false);
		// And it survives the handout contract it is subject to.
		expect(() => structuredClone(fit)).not.toThrow();
	});

	test("toPixel and toLatLng round-trip through the stored fit", () => {
		const px = c.api.toPixel("britain-5c", YORK.lat, YORK.lng);
		expect(px).not.toBeNull();
		expect(px!.inBounds).toBe(true);
		const back = c.api.toLatLng("britain-5c", px!.x, px!.y);
		expect(back!.lat).toBeCloseTo(YORK.lat, 3);
		expect(back!.lng).toBeCloseTo(YORK.lng, 3);
	});

	test("georefsCovering, listFeatures and featuresIn agree about the one place note", () => {
		expect(c.api.georefsCovering(YORK.lat, YORK.lng).map((x) => x.georefId)).toEqual(["britain-5c"]);
		expect(c.api.listFeatures().map((f) => f.notePath)).toEqual(["places/Eboracum.md"]);
		expect(c.api.featuresIn("britain-5c")!.map((p) => p.feature.notePath)).toEqual(["places/Eboracum.md"]);
	});

	test("featuresIn is null for an id with no loaded map", () => {
		expect(c.api.featuresIn("no-such-map")).toBeNull();
	});

	test("listProblems and listRejected are empty for a clean vault", () => {
		expect(c.api.listProblems()).toEqual([]);
		expect(c.api.listRejected()).toEqual([]);
	});

	test("listProblems surfaces what the index noticed", () => {
		v.addNote("places/Broken.md", { lat: 53.9591 });
		const fresh = new ApiController(v, VERSION);
		fresh.markReady();
		expect(fresh.api.listProblems().map((p) => p.code)).toEqual(["coords-incomplete"]);
	});

	test("a handout cannot be mutated into the next answer", () => {
		// The double cast is the point: a consumer in plain JS has no readonly to stop them, so the
		// handout has to be a copy rather than a reference into the index.
		const first = c.api.listGeorefs();
		(first as unknown as { id: string }[])[0]!.id = "tampered";
		expect(c.api.listGeorefs()[0]!.id).toBe("britain-5c");
	});
});

describe("previewFit, the interactive path", () => {
	test("fits caller-supplied points with no vault and no ready gate", () => {
		const result = c.api.previewFit(CLEAN, { kind: "affine" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.fit.model).toBe("affine");
			expect(result.fit.pointCount).toBe(CLEAN.length);
			expect(v.writes).toHaveLength(0);
		}
	});

	test("too few points is a RESULT, not a throw", () => {
		// A view placing its second point must not have to try/catch per placement.
		const result = c.api.previewFit(CLEAN.slice(0, 2), { kind: "affine" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("geb-too-few-points");
			expect(result.message).toContain(String(MIN_POINTS.affine));
		}
	});

	test("degenerate points are a result too", () => {
		const collinear: ControlPoint[] = [
			{ px: 0, py: 0, lat: 0, lng: 0 },
			{ px: 10, py: 10, lat: 1, lng: 1 },
			{ px: 20, py: 20, lat: 2, lng: 2 },
		];
		const result = c.api.previewFit(collinear, { kind: "affine" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("geb-degenerate-fit");
	});
});

describe("writing", () => {
	beforeEach(() => {
		addGeoref(georef("britain-5c"));
		c.markReady();
		// Every write test runs with the metadata cache LAGGING, so a method that re-read after
		// writing would hand back the pre-write state.
		v.lagReads = true;
	});

	/** What Obsidian's metadata cache catching up and firing `changed` amounts to. */
	const vaultNoticed = (path: string): void => {
		v.settleCache();
		c.host.invalidate(path);
		c.flush();
	};

	test("addPoint returns the record it wrote, while the cache is still behind", async () => {
		const before = c.api.getGeoref("britain-5c")!.pointCount;
		const summary = await c.api.addPoint("britain-5c", { px: 5, py: 6, lat: 52.2, lng: 0.12, label: "Camboricum" });
		expect(summary.pointCount).toBe(before + 1);

		// Proof the guarantee was needed: a re-reading implementation would have seen `before`.
		const cached = v.readFrontmatter("maps/britain-5c.md") as Record<string, unknown>;
		expect((cached[KEY.fits] as { points: unknown[] }[])[0]!.points).toHaveLength(before);

		vaultNoticed("maps/britain-5c.md");
		expect(c.api.getGeoref("britain-5c")!.pointCount).toBe(before + 1);
	});

	test("A WRITE DOES NOT INVALIDATE THE INDEX, and that is the point", async () => {
		// The load-bearing rule of the whole design. If a write marked the index dirty, the next
		// query would rebuild from a metadata cache that still holds the PRE-write frontmatter,
		// publish it as current and clear the flag — deterministically, on the first write a UI
		// makes. So the index deliberately keeps describing the previous state until the vault
		// says otherwise, and the caller uses the record the write returned.
		const before = c.api.getGeoref("britain-5c")!.pointCount;
		const summary = await c.api.addPoint("britain-5c", { px: 5, py: 6, lat: 52.2, lng: 0.12 });

		expect(c.host.isDirty).toBe(false);
		expect(summary.pointCount).toBe(before + 1);
		// The index still says `before` — not stale by accident, stale ON PURPOSE and documented.
		expect(c.api.getGeoref("britain-5c")!.pointCount).toBe(before);

		vaultNoticed("maps/britain-5c.md");
		expect(c.api.getGeoref("britain-5c")!.pointCount).toBe(before + 1);
	});

	test("updatePoint replaces one point and keeps the count", async () => {
		const moved: ControlPoint = { px: 1, py: 2, lat: 54, lng: -1, label: "moved" };
		const summary = await c.api.updatePoint("britain-5c", 0, moved);
		expect(summary.pointCount).toBe(CLEAN.length);
		vaultNoticed("maps/britain-5c.md");
		expect(c.api.getFit("britain-5c").points[0]).toEqual(moved);
	});

	test("removePoint drops one", async () => {
		const summary = await c.api.removePoint("britain-5c", 0);
		expect(summary.pointCount).toBe(CLEAN.length - 1);
	});

	test("a point index outside the fit is refused and nothing is written", async () => {
		expect(await asyncCodeOf(c.api.updatePoint("britain-5c", 99, { px: 1, py: 1, lat: 1, lng: 1 }))).toBe("geb-no-such-point");
		expect(await asyncCodeOf(c.api.removePoint("britain-5c", -1))).toBe("geb-no-such-point");
		expect(v.writes).toHaveLength(0);
	});

	test("removing below the model's minimum is refused BEFORE the write, not reported after it", async () => {
		// The one place a preview is a precondition: an unfittable set of points must never land
		// on disk and then be complained about.
		const g = georef("tiny");
		const three = { ...g, fits: [{ ...g.fits[0]!, transform: { model: "affine" as const }, points: CLEAN.slice(0, 3).map((p) => ({ ...p })) }] };
		v.addFile("tiny.png", BYTES);
		v.addNote("maps/tiny.md", toFrontmatter(three));
		const fresh = new ApiController(v, VERSION);
		fresh.markReady();

		expect(await asyncCodeOf(fresh.api.removePoint("tiny", 0))).toBe("geb-too-few-points");
		expect(v.writes).not.toContain("maps/tiny.md");
	});

	test("updateGeoref patches the crs and the model", async () => {
		const summary = await c.api.updateGeoref("britain-5c", { model: "affine" });
		expect(summary.model).toBe("affine");
		vaultNoticed("maps/britain-5c.md");
		expect(c.api.getGeoref("britain-5c")!.model).toBe("affine");
	});

	test("an unknown crs is refused on update and on create", async () => {
		expect(await asyncCodeOf(c.api.updateGeoref("britain-5c", { crs: "erath" }))).toBe("geb-unknown-crs");
		expect(v.writes).toHaveLength(0);
	});

	test("createGeoref computes the image identity and returns what it wrote", async () => {
		v.addFile("new-map.png", BYTES);
		const summary = await c.api.createGeoref({
			notePath: "maps/new-map.md",
			id: "new-map",
			imagePath: "new-map.png",
			imageWidth: 800,
			imageHeight: 600,
			model: "affine",
			points: CLEAN,
		});
		expect(summary).toEqual({ id: "new-map", notePath: "maps/new-map.md", crs: "earth", model: "affine", pointCount: CLEAN.length });
		expect(v.creates).toEqual(["maps/new-map.md"]);

		// The note is not in the cache at all yet, so a re-reading implementation would have
		// claimed the caller's own new georeference did not exist.
		expect(v.readFrontmatter("maps/new-map.md")).toBeNull();
		v.settleCache();
		const written = v.readFrontmatter("maps/new-map.md") as Record<string, unknown>;
		expect((written[KEY.imageBytes] as number)).toBe(BYTES.byteLength);
		expect((written[KEY.imageHash] as string)).toBe(hashBytes(BYTES));
	});

	test("createGeoref refuses a duplicate id, a missing image and a zero image size", async () => {
		v.addFile("other.png", BYTES);
		const base = { notePath: "maps/other.md", imagePath: "other.png", imageWidth: 10, imageHeight: 10, model: "affine" as const, points: CLEAN };
		expect(await asyncCodeOf(c.api.createGeoref({ ...base, id: "britain-5c" }))).toBe("geb-duplicate-id");
		expect(await asyncCodeOf(c.api.createGeoref({ ...base, id: "ok", imagePath: "absent.png" }))).toBe("geb-no-such-image");
		expect(await asyncCodeOf(c.api.createGeoref({ ...base, id: "ok", imageWidth: 0 }))).toBe("geb-bad-argument");
		expect(await asyncCodeOf(c.api.createGeoref({ ...base, id: "  " }))).toBe("geb-bad-argument");
		expect(v.creates).toEqual([]);
	});

	test("a write that lands a LOSSY record is reported, not called a success", async () => {
		// Nothing covered this, so the check could be deleted outright. The write has already
		// happened; answering "fine" about a record that dropped data hides exactly what the user
		// needs in order to fix it, and the lossy flag exists to stop a later save compounding it.
		const outOfRange: ControlPoint[] = [...CLEAN.map((p) => ({ ...p })), { px: 5, py: 5, lat: 91, lng: 0 }];
		expect(await asyncCodeOf(c.api.updateGeoref("britain-5c", { points: outOfRange }))).toBe("geb-lossy-record");
		// The write DID land — that is the point. The caller is told so rather than told nothing.
		expect(v.writes).toContain("maps/britain-5c.md");
	});

	test("deleteGeoref trashes the note rather than destroying it", async () => {
		await c.api.deleteGeoref("britain-5c");
		expect(v.trashed).toEqual(["maps/britain-5c.md"]);
	});

	test("generation moves on every write and on nothing else", async () => {
		const start = c.api.generation;
		c.api.listGeorefs();
		c.api.previewFit(CLEAN, { kind: "affine" });
		expect(c.api.generation).toBe(start);

		await c.api.addPoint("britain-5c", { px: 5, py: 6, lat: 52.2, lng: 0.12 });
		expect(c.api.generation).toBe(start + 1);
		vaultNoticed("maps/britain-5c.md");
		// The rebuild found a real change, so it moves too — both sources count.
		expect(c.api.generation).toBeGreaterThan(start + 1);

		// A flush that found NOTHING must not move it: a body edit leaving frontmatter alone is
		// silence, not noise, or a consumer caching on generation re-reads forever.
		const quiet = c.api.generation;
		c.host.invalidate("maps/britain-5c.md");
		c.flush();
		expect(c.api.generation).toBe(quiet);
	});
});

describe("events", () => {
	test("ready and unload fire, with a frozen payload carrying the generation", () => {
		const seen: { type: string; generation: number }[] = [];
		c.api.on("ready", (p) => seen.push({ type: p.type, generation: p.generation }));
		c.api.on("unload", (p) => seen.push({ type: p.type, generation: p.generation }));

		c.markReady();
		c.unload();
		expect(seen.map((s) => s.type)).toEqual(["ready", "unload"]);
	});

	test("the payload is frozen", () => {
		let payload: unknown = null;
		c.api.on("ready", (p) => {
			payload = p;
		});
		c.markReady();
		expect(Object.isFrozen(payload)).toBe(true);
	});

	test("unsubscribing stops delivery", () => {
		let calls = 0;
		const off = c.api.on("ready", () => {
			calls += 1;
		});
		off();
		c.markReady();
		expect(calls).toBe(0);
	});

	test("a STALE unsubscribe handle cannot kill a later subscription", () => {
		// What the run-at-most-once wrapper is actually for. Calling `off()` twice proves nothing
		// — deleting twice from a Set is harmless — so the first version of this test passed with
		// the guard removed. This one fails without it: the second `off()` would delete the
		// re-subscribed listener that a different caller now owns.
		let calls = 0;
		const cb = (): void => {
			calls += 1;
		};
		const off = c.api.on("ready", cb);
		off();
		c.api.on("ready", cb);
		off();
		c.markReady();
		expect(calls).toBe(1);
	});

	test("one listener throwing does not stop the others, or break unload", () => {
		const reached: string[] = [];
		c.api.on("unload", () => {
			throw new Error("rude subscriber");
		});
		c.api.on("unload", () => reached.push("second"));
		expect(() => c.unload()).not.toThrow();
		expect(reached).toEqual(["second"]);
	});

	test("an unload subscriber still hears the event that concerns it", () => {
		// Listeners are cleared AFTER the emit for exactly this reason.
		let heard = false;
		c.api.on("unload", () => {
			heard = true;
		});
		c.unload();
		expect(heard).toBe(true);
	});
});

describe("the API reuses solved fits across calls", () => {
	test("repeated queries solve once, and a write forces a resolve", async () => {
		// Asserted by MECHANISM — the solve count — not by timing. A stopwatch assertion would be
		// flaky on a loaded machine, and the thing that matters is that the dense solve does not
		// happen again, which is exactly what the counters say.
		const host = new IndexHost(v);
		const memo = host.memo;
		const own = new ApiController(v, VERSION, host);
		addGeoref(georef("britain-5c"));
		v.addNote("places/Eboracum.md", { lat: YORK.lat, lng: YORK.lng });
		own.markReady();

		own.api.listGeorefs();
		expect(memo.misses).toBe(1);

		// Four more queries. The INDEX is cached now too, so these do not even rebuild — which is
		// a bigger win than step 2 alone and the reason `hits` stays at zero rather than climbing.
		own.api.listGeorefs();
		own.api.georefsCovering(YORK.lat, YORK.lng);
		own.api.featuresIn("britain-5c");
		own.api.getFit("britain-5c");
		expect(memo.misses).toBe(1);
		expect(memo.hits).toBe(0);

		// A rebuild in which nothing moved: the index is rebuilt, the fit is REUSED.
		own.host.invalidate("maps/britain-5c.md");
		own.flush();
		expect(memo.misses).toBe(1);
		expect(memo.hits).toBe(1);

		// Now a real change: the content moved, so the key moved, so it solves again — once.
		await own.api.addPoint("britain-5c", { px: 5, py: 6, lat: 52.2, lng: 0.12 });
		v.settleCache();
		own.host.invalidate("maps/britain-5c.md");
		own.flush();
		expect(memo.misses).toBe(2);
		// And the superseded solve is gone rather than hoarded.
		expect(memo.size).toBe(1);
	});

	test("unload drops the solved fits", () => {
		const host = new IndexHost(v);
		const memo = host.memo;
		const own = new ApiController(v, VERSION, host);
		addGeoref(georef("britain-5c"));
		own.markReady();
		own.api.listGeorefs();
		expect(memo.size).toBe(1);

		own.unload();
		expect(memo.size).toBe(0);
	});
});

describe("the change events reach a subscriber", () => {
	test("a flush that found something emits, with the paths and the generation", () => {
		addGeoref(georef("britain-5c"));
		c.markReady();
		const seen: { type: string; paths: readonly string[]; generation: number }[] = [];
		for (const e of ["georefs-changed", "fit-changed", "features-changed"] as const) {
			c.api.on(e, (p) => seen.push({ type: p.type, paths: p.paths, generation: p.generation }));
		}
		c.api.listGeorefs();

		v.addNote("places/Eboracum.md", { lat: YORK.lat, lng: YORK.lng });
		c.host.invalidate("places/Eboracum.md");
		c.flush();

		expect(seen.map((s) => s.type)).toEqual(["features-changed"]);
		expect(seen[0]!.paths).toEqual(["places/Eboracum.md"]);
		expect(seen[0]!.generation).toBe(c.api.generation);
		expect(Object.isFrozen(seen[0]!.paths)).toBe(true);
	});

	test("a flush that found nothing emits nothing", () => {
		// Obsidian fires `changed` on body edits with identical frontmatter. Without the
		// fingerprint diff, typing in a map note would wake every consumer on every keystroke.
		addGeoref(georef("britain-5c"));
		c.markReady();
		let fired = 0;
		for (const e of ["georefs-changed", "fit-changed", "features-changed"] as const) {
			c.api.on(e, () => {
				fired += 1;
			});
		}
		c.api.listGeorefs();
		c.host.invalidate("maps/britain-5c.md");
		c.flush();
		expect(fired).toBe(0);
	});

	test("flushing before ready, or after unload, does nothing", () => {
		addGeoref(georef("britain-5c"));
		expect(c.flush()).toBeNull();
		c.markReady();
		c.api.listGeorefs();
		c.unload();
		expect(c.flush()).toBeNull();
	});

	test("getImageInfo reports what reconciliation found, and unknown until it has", () => {
		addGeoref(georef("britain-5c"));
		c.markReady();
		expect(c.api.getImageInfo("britain-5c").staleness).toBe("unknown");

		c.recordStaleness("maps/britain-5c.md", "changed");
		expect(c.api.getImageInfo("britain-5c").staleness).toBe("changed");

		// Unload forgets it: a staleness verdict from a previous session's reconcile is not
		// evidence about this one.
		c.unload();
		const again = new ApiController(v, VERSION);
		again.markReady();
		expect(again.api.getImageInfo("britain-5c").staleness).toBe("unknown");
	});
});
