/**
 * The index host: what invalidates it, what it rebuilds, and which events that earns.
 *
 * The events are the part worth testing hardest, because an event that fires too often is noise a
 * consumer learns to ignore, and one that fires too rarely is a map changing on screen without
 * the screen being told.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { IndexHost } from "../src/api/host";
import { hashBytes } from "../src/persist/identity";
import { toFrontmatter } from "../src/persist/serialize";
import { KEY, type Georeference, type StoredPoint } from "../src/persist/types";
import { CLEAN, IMAGE } from "./fixtures";
import { FakeVault } from "./fake-vault";

const BYTES = new Uint8Array([1, 2, 3, 4]).buffer;
const YORK = { lat: 53.9591, lng: -1.0815 };
const MAP = "maps/britain-5c.md";
const PLACE = "places/Eboracum.md";

const stored = (): StoredPoint[] =>
	CLEAN.map((p) => ({ px: p.px, py: p.py, lat: p.lat, lng: p.lng, ...(p.label === undefined ? {} : { label: p.label }) }));

const record = (id: string, points: StoredPoint[] = stored()): Georeference => ({
	id,
	imageLink: `[[${id}.png]]`,
	image: { width: IMAGE.width, height: IMAGE.height, byteLength: BYTES.byteLength, hash: hashBytes(BYTES) },
	crs: "earth",
	fits: [{ bounds: null, transform: { model: "tps" }, points }],
});

let v: FakeVault;
let host: IndexHost;

beforeEach(() => {
	v = new FakeVault();
	v.addFile("britain-5c.png", BYTES);
	v.addNote(MAP, toFrontmatter(record("britain-5c")));
	v.addNote(PLACE, { lat: YORK.lat, lng: YORK.lng });
	host = new IndexHost(v);
});

describe("the first build is the initial state, not a change", () => {
	test("it fires nothing and does not move the generation", () => {
		expect(host.generation).toBe(0);
		const change = host.flush();
		expect(change).toEqual({ events: [], paths: [] });
		expect(host.generation).toBe(0);
		expect(host.snapshot().georefs).toHaveLength(1);
	});

	test("a second flush with nothing dirty does no work at all", () => {
		host.flush();
		expect(host.flush()).toBeNull();
	});
});

describe("what each change earns", () => {
	beforeEach(() => {
		host.flush();
	});

	test("a map's control points moving fires fit-changed, and NOT georefs-changed", () => {
		const moved = stored();
		moved[0] = { ...moved[0]!, px: moved[0]!.px + 30 };
		v.notes.set(MAP, toFrontmatter(record("britain-5c", moved)));

		host.invalidate(MAP);
		const change = host.flush()!;
		expect(change.events).toEqual(["fit-changed"]);
		expect(change.paths).toEqual([MAP]);
		expect(host.generation).toBe(1);
	});

	test("a map APPEARING fires georefs-changed", () => {
		v.addFile("britain-detail.png", BYTES);
		const detail = record("britain-detail", stored().map((p) => ({ ...p, px: p.px * 0.5 })));
		v.addNote("maps/britain-detail.md", toFrontmatter(detail));

		host.invalidate("maps/britain-detail.md");
		expect(host.flush()!.events).toEqual(["georefs-changed"]);
	});

	test("a map becoming REJECTED fires georefs-changed, so it cannot vanish in silence", () => {
		// The case a consumer watching only fit-changed would never hear. The map is still there
		// on disk; it simply stopped being usable, and the screen has to be told.
		const collinear: StoredPoint[] = [
			{ px: 0, py: 0, lat: 0, lng: 0 },
			{ px: 10, py: 10, lat: 1, lng: 1 },
			{ px: 20, py: 20, lat: 2, lng: 2 },
		];
		v.notes.set(MAP, toFrontmatter({ ...record("britain-5c", collinear), fits: [{ bounds: null, transform: { model: "affine" }, points: collinear }] }));

		host.invalidate(MAP);
		const change = host.flush()!;
		expect(change.events).toContain("georefs-changed");
		expect(host.snapshot().rejected[0]!.code).toBe("degenerate-fit");
	});

	test("a map being deleted fires georefs-changed", () => {
		v.notes.delete(MAP);
		host.invalidate(MAP);
		expect(host.flush()!.events).toEqual(["georefs-changed"]);
		expect(host.snapshot().georefs).toEqual([]);
	});

	test("a place note's coordinates moving fires features-changed only", () => {
		v.notes.set(PLACE, { lat: 51.51, lng: -0.13 });
		host.invalidate(PLACE);
		const change = host.flush()!;
		expect(change.events).toEqual(["features-changed"]);
		expect(change.paths).toEqual([PLACE]);
	});

	test("a place note's non-coordinate FIELD moving also fires features-changed", () => {
		// `geb-from` is raw text a time adapter will read. It is part of the feature a consumer
		// holds, so changing it is a change to that feature even though no pin moves.
		v.notes.set(PLACE, { lat: YORK.lat, lng: YORK.lng, "geb-from": "450" });
		host.invalidate(PLACE);
		expect(host.flush()!.events).toEqual(["features-changed"]);
	});

	test("a RENAMED control point fires fit-changed, because diagnostics carry its name", () => {
		// Not a cosmetic change: the label rides into each residual, so a consumer showing the
		// trust display is showing stale text until it re-reads.
		const renamed = stored();
		renamed[0] = { ...renamed[0]!, label: "Eboracum (Roman York)" };
		v.notes.set(MAP, toFrontmatter(record("britain-5c", renamed)));

		host.invalidate(MAP);
		expect(host.flush()!.events).toEqual(["fit-changed"]);
	});

	test("an edit that changes NOTHING fires nothing and does not move the generation", () => {
		// Obsidian's `changed` fires on body edits with identical frontmatter. Without the
		// fingerprint diff, every keystroke in a map note would wake every consumer.
		host.invalidate(MAP);
		const change = host.flush()!;
		expect(change.events).toEqual([]);
		expect(change.paths).toEqual([]);
		expect(host.generation).toBe(0);
	});
});

describe("scope and staleness", () => {
	beforeEach(() => {
		host.flush();
	});

	test("the diff is scoped to the pending paths, so one edit reports one path", () => {
		v.notes.set(PLACE, { lat: 51.51, lng: -0.13 });
		const moved = stored();
		moved[0] = { ...moved[0]!, px: moved[0]!.px + 30 };
		v.notes.set(MAP, toFrontmatter(record("britain-5c", moved)));

		// Only the place note is announced, even though the map changed too — a consumer told
		// "everything changed" has learned nothing it could act on.
		host.invalidate(PLACE);
		expect(host.flush()!.paths).toEqual([PLACE]);
	});

	test("a pathless invalidate WIDENS an already-scoped one", () => {
		// The case that makes the `pending.clear()` load-bearing, and the one my first test
		// missed: pending already names a path when a signal arrives that says only "something
		// changed, somewhere". Keeping the narrow scope would diff the wrong note and miss the
		// real change entirely.
		const moved = stored();
		moved[0] = { ...moved[0]!, px: moved[0]!.px + 30 };
		v.notes.set(MAP, toFrontmatter(record("britain-5c", moved)));

		host.invalidate(PLACE); // a path that did NOT change
		host.invalidate(); // ...then "somewhere"
		const change = host.flush()!;
		expect(change.paths).toEqual([MAP]);
		expect(change.events).toEqual(["fit-changed"]);
	});

	test("a rejection changing its REASON still fires georefs-changed", () => {
		// The clause my other tests could not reach. A map crossing loaded-to-rejected is caught
		// by the loaded-ness check alone, so the rejection FINGERPRINT only earns its place when a
		// map is rejected both before and after for different reasons — which a consumer showing
		// the reason to the user has to be told about.
		const collinear: StoredPoint[] = [
			{ px: 0, py: 0, lat: 0, lng: 0 },
			{ px: 10, py: 10, lat: 1, lng: 1 },
			{ px: 20, py: 20, lat: 2, lng: 2 },
		];
		const degenerate = { ...record("britain-5c", collinear), fits: [{ bounds: null, transform: { model: "affine" as const }, points: collinear }] };
		v.notes.set(MAP, toFrontmatter(degenerate));
		host.invalidate(MAP);
		host.flush();
		expect(host.snapshot().rejected[0]!.code).toBe("degenerate-fit");

		// Now reject it for a DIFFERENT reason: the image size goes missing.
		v.notes.set(MAP, toFrontmatter({ ...degenerate, image: { ...degenerate.image, width: 0, height: 0 } }));
		host.invalidate(MAP);
		const change = host.flush()!;
		expect(host.snapshot().rejected[0]!.code).toBe("unknown-image-size");
		expect(change.events).toEqual(["georefs-changed"]);
	});

	test("invalidating with NO path means 'somewhere', and diffs everything", () => {
		// Obsidian's batch-settled `resolved` names no file. The honest response is a full diff,
		// not a scoped one that would miss whatever moved.
		v.notes.set(PLACE, { lat: 51.51, lng: -0.13 });
		host.invalidate();
		const change = host.flush()!;
		expect(change.paths).toEqual([PLACE]);
		expect(change.events).toEqual(["features-changed"]);
	});

	test("a query while dirty rebuilds first, so no caller can read a stale index", () => {
		// The debounce decides when EVENTS fire; it must never decide whether an answer is
		// current. A consumer querying between an invalidation and the flush gets the new world.
		v.notes.set(PLACE, { lat: 51.51, lng: -0.13 });
		host.invalidate(PLACE);
		expect(host.isDirty).toBe(true);
		expect(host.snapshot().features[0]!.lat).toBe(51.51);
		expect(host.isDirty).toBe(false);
	});

	test("a rename invalidates both paths, and the move is reported at both", () => {
		v.movePreservingLinks(MAP, "maps/archive/britain-5c.md");
		host.invalidate(MAP);
		host.invalidate("maps/archive/britain-5c.md");

		const change = host.flush()!;
		expect(change.events).toEqual(["georefs-changed"]);
		expect([...change.paths].sort()).toEqual(["maps/archive/britain-5c.md", MAP]);
		expect(host.snapshot().georefs[0]!.notePath).toBe("maps/archive/britain-5c.md");
	});

	test("clear drops the snapshot, the fits and the fingerprints", () => {
		host.snapshot();
		expect(host.memo.size).toBe(1);
		host.clear();
		expect(host.memo.size).toBe(0);
		expect(host.isDirty).toBe(true);
		// And the next build is a first build again: the initial state, not a flood of events.
		expect(host.flush()).toEqual({ events: [], paths: [] });
	});

	test("the crs changing on a map fires fit-changed, because it reshapes the fit's domain", () => {
		const fm = v.notes.get(MAP)!;
		fm[KEY.crs] = "erath";
		host.invalidate(MAP);
		// Unknown crs: the map still loads (reported), so it is a fit change rather than a
		// disappearance — its key moved because the crs is part of the key.
		expect(host.flush()!.events).toContain("fit-changed");
	});
});

describe("a query inside the debounce window", () => {
	test("rebuilds the index but does not swallow the events the flush then announces", () => {
		host.flush();
		v.addNote("places/Londinium.md", { lat: 51.5, lng: -0.1 });
		host.invalidate("places/Londinium.md");
		// The query rebuilds synchronously, as it must. The change it found is held, not lost:
		// found live, where the view of a just-saved map waited forever for an event that a
		// command-palette check had already consumed.
		expect(host.snapshot().features.map((f) => f.notePath)).toContain("places/Londinium.md");
		expect(host.isDirty).toBe(false);
		const out = host.flush();
		expect(out).not.toBeNull();
		expect(out?.events).toEqual(["features-changed"]);
		expect(out?.paths).toEqual(["places/Londinium.md"]);
		// Announced once, and a quiet flush is still quiet.
		expect(host.flush()).toBeNull();
	});

	test("two query-time rebuilds before one flush announce the union", () => {
		host.flush();
		v.addNote("places/Londinium.md", { lat: 51.5, lng: -0.1 });
		host.invalidate("places/Londinium.md");
		host.snapshot();
		v.notes.delete(MAP);
		v.files.delete(MAP);
		host.invalidate(MAP);
		host.snapshot();
		const out = host.flush();
		expect([...(out?.events ?? [])].sort()).toEqual(["features-changed", "georefs-changed"]);
		expect([...(out?.paths ?? [])].sort()).toEqual([MAP, "places/Londinium.md"]);
	});
});
