/**
 * The read-your-writes guarantee, which is the whole reason src/persist/write.ts exists.
 *
 * Every test here runs with `lagReads` ON, so the fake serves the pre-write state from
 * `readFrontmatter` exactly as Obsidian's metadata cache does until its `changed` event fires.
 * With the lag off, every one of these passes against a re-reading implementation and proves
 * nothing — which is why the lag had to be built into the fake before the tests were worth
 * writing.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { hashBytes } from "../src/persist/identity";
import { toFrontmatter } from "../src/persist/serialize";
import { KEY, type Georeference, type StoredPoint } from "../src/persist/types";
import { createAndCapture, writeAndCapture } from "../src/persist/write";
import { FakeVault } from "./fake-vault";

const BYTES = new Uint8Array([1, 2, 3, 4]).buffer;
const NOTE = "maps/britain-5c.md";

const record = (id = "geb-0001"): Georeference => ({
	id,
	imageLink: "[[britain-5c.png]]",
	image: { width: 2400, height: 3200, byteLength: BYTES.byteLength, hash: hashBytes(BYTES) },
	crs: "earth",
	fits: [
		{
			bounds: null,
			transform: { model: "tps" },
			points: [
				{ px: 412, py: 338, lat: 53.9591, lng: -1.0815, label: "Eboracum" },
				{ px: 900, py: 1200, lat: 51.51, lng: -0.13 },
				{ px: 200, py: 150, lat: 55.95, lng: -3.19 },
			],
		},
	],
});

let v: FakeVault;

beforeEach(() => {
	v = new FakeVault();
	v.addFile("britain-5c.png", BYTES);
	v.lagReads = true;
});

describe("a write returns what it wrote, not what the cache holds", () => {
	test("a point added is in the returned record while the cache still shows the old one", () => {
		v.addNote(NOTE, toFrontmatter(record()));

		const added: StoredPoint = { px: 50, py: 60, lat: 52.2, lng: 0.12, label: "Camboricum" };
		return writeAndCapture(v, NOTE, (fm) => {
			const fits = fm[KEY.fits] as { points: StoredPoint[] }[];
			fits[0]!.points.push(added);
		}).then((result) => {
			// The guarantee.
			expect(result.value).not.toBeNull();
			expect(result.value!.fits[0]!.points).toHaveLength(4);
			expect(result.value!.fits[0]!.points[3]!.label).toBe("Camboricum");

			// And the proof the guarantee was needed: the cache is still behind at this instant,
			// so an implementation that re-read would have returned three points.
			const cached = v.readFrontmatter(NOTE) as { [k: string]: unknown };
			expect((cached[KEY.fits] as { points: StoredPoint[] }[])[0]!.points).toHaveLength(3);

			// Once the cache catches up, both agree. The lag is a window, not a divergence.
			v.settleCache();
			const settled = v.readFrontmatter(NOTE) as { [k: string]: unknown };
			expect((settled[KEY.fits] as { points: StoredPoint[] }[])[0]!.points).toHaveLength(4);
		});
	});

	test("a created georeference is returned even though the cache has never seen the note", async () => {
		// The harder lag: a brand-new note is absent from the cache entirely, so a read-back
		// returns null and a re-reading implementation would tell the caller its own new
		// georeference does not exist.
		const result = await createAndCapture(v, "maps/new.md", toFrontmatter(record("geb-0002")));

		expect(result.value).not.toBeNull();
		expect(result.value!.id).toBe("geb-0002");
		expect(v.readFrontmatter("maps/new.md")).toBeNull();

		v.settleCache();
		expect(v.readFrontmatter("maps/new.md")).not.toBeNull();
	});

	test("the capture is taken AFTER the mutation, not before it", async () => {
		// Computing the result before the write and returning it afterwards is the lost-update bug
		// wearing a new hat: Obsidian's own link updater may touch the note in between. Here the
		// mutator itself changes the id, so a capture taken before the mutation reports the old one.
		v.addNote(NOTE, toFrontmatter(record("before")));
		const result = await writeAndCapture(v, NOTE, (fm) => {
			fm[KEY.id] = "after";
		});
		expect(result.value!.id).toBe("after");
	});

	test("a write that makes the record unusable reports it rather than throwing", async () => {
		// The write already happened; the caller needs to know what is now in the note. Throwing
		// would leave the user holding a note Geb refuses to acknowledge.
		v.addNote(NOTE, toFrontmatter(record()));
		const result = await writeAndCapture(v, NOTE, (fm) => {
			delete fm[KEY.id];
		});
		expect(result.value).toBeNull();
		expect(result.problems.join("; ")).toContain(KEY.id);
	});

	/**
	 * Caught EXPLICITLY rather than through `.rejects.toThrow()`.
	 *
	 * Bun types `.rejects.toThrow()` as non-thenable, so awaiting it is a lint error — and simply
	 * dropping the `await` is the trap: if the matcher IS a promise at runtime, the assertion
	 * never runs and the test passes no matter what the code does. This project has already lost a
	 * test to that exact shape (`expect(out).resolves`, which asserts nothing). Here the `await`
	 * is on a real promise and the assertion fails if nothing was thrown.
	 */
	const rejection = async (p: Promise<unknown>): Promise<Error> => {
		let caught: unknown = null;
		try {
			await p;
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);
		return caught as Error;
	};

	test("a rejected write propagates and captures nothing", async () => {
		v.addNote(NOTE, toFrontmatter(record()));
		v.failWrites.add(NOTE);
		const e = await rejection(writeAndCapture(v, NOTE, () => undefined));
		expect(e.message).toContain("write refused");
	});

	test("creating over an existing path is refused, not an overwrite", async () => {
		v.addNote(NOTE, toFrontmatter(record()));
		const e = await rejection(createAndCapture(v, NOTE, toFrontmatter(record("geb-0003"))));
		expect(e.message).toContain("already exists");
		// The original survives untouched.
		v.settleCache();
		expect((v.readFrontmatter(NOTE) as Record<string, unknown>)[KEY.id]).toBe("geb-0001");
	});
});
