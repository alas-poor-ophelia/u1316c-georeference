import { beforeEach, describe, expect, test } from "bun:test";
import { hashBytes } from "../src/persist/identity";
import { reconcile } from "../src/persist/reconcile";
import { toFrontmatter } from "../src/persist/serialize";
import { KEY, type Georeference } from "../src/persist/types";
import { FakeVault } from "./fake-vault";

const NOTE = "maps/Britain 5c.md";
const IMAGE = "att/britain-5c.png";
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;

let v: FakeVault;

const record = (overrides: Partial<Georeference> = {}): Georeference => ({
	id: "geb-0001",
	imageLink: "[[britain-5c.png]]",
	image: { width: 2400, height: 3200, byteLength: BYTES.byteLength, hash: hashBytes(BYTES) },
	crs: "earth",
	fits: [
		{
			bounds: null,
			transform: { model: "affine" },
			points: [
				{ px: 1, py: 1, lat: 51, lng: -1 },
				{ px: 2, py: 9, lat: 52, lng: -2 },
				{ px: 9, py: 2, lat: 53, lng: -3 },
			],
		},
	],
	...overrides,
});

function seed(g: Georeference = record(), imagePath = IMAGE): void {
	v = new FakeVault();
	v.addFile(imagePath, BYTES);
	v.addNote(NOTE, toFrontmatter(g));
}

beforeEach(() => seed());

describe("reconciliation is the safety net the rename handler cannot be", () => {
	test("a healthy georeference is ok and nothing is written", async () => {
		const out = await reconcile(v);
		expect(out).toEqual([{ notePath: NOTE, action: "ok" }]);
		expect(v.writes).toHaveLength(0);
	});

	test("an image moved while Geb was not watching is re-found by content and repaired", async () => {
		// The whole reason this exists. The old path lived only in a rename event nobody received
		// — Geb was disabled, or the vault was indexing, or sync delivered a delete plus a create.
		// The stored content hash is the only identifier of the image that survives that.
		v.files.delete(IMAGE);
		v.binaries.delete(IMAGE);
		v.addFile("elsewhere/renamed-entirely.png", BYTES);

		const out = await reconcile(v);
		expect(out[0]!.action).toBe("relinked");
		expect(out[0]!.detail).toContain("elsewhere/renamed-entirely.png");
		expect(v.readFrontmatter(NOTE)?.[KEY.image]).toBe("[[renamed-entirely.png]]");
	});

	test("repair preserves an alias", async () => {
		seed(record({ imageLink: "[[britain-5c.png|My lovely map]]" }));
		v.files.delete(IMAGE);
		v.binaries.delete(IMAGE);
		v.addFile("elsewhere/renamed.png", BYTES);
		await reconcile(v);
		expect(v.readFrontmatter(NOTE)?.[KEY.image]).toBe("[[renamed.png|My lovely map]]");
	});

	test("a genuinely missing image is reported broken, not guessed at", async () => {
		v.files.delete(IMAGE);
		v.binaries.delete(IMAGE);
		const out = await reconcile(v);
		expect(out[0]!.action).toBe("broken");
		expect(v.writes).toHaveLength(0);
	});

	test("an image that resolves but has been re-saved is reported stale", async () => {
		// Control points are in image-space pixels, so a re-save or resize shifts every one of
		// them with no error anywhere. This is the only thing that notices.
		v.binaries.set(IMAGE, new Uint8Array([9, 9, 9]).buffer);
		const out = await reconcile(v);
		expect(out[0]!.action).toBe("stale");
		expect(out[0]!.detail).toContain(IMAGE);
	});

	test("only same-size candidates are hashed, so a big vault costs nothing", async () => {
		// Bound the work: filter by byte length, which Obsidian reports without reading the file.
		v.files.delete(IMAGE);
		v.binaries.delete(IMAGE);
		for (let i = 0; i < 50; i++) v.addFile(`bulk/${i}.png`, new Uint8Array(BYTES.byteLength + 1 + i).buffer);
		v.addFile("found/it.png", BYTES);
		const out = await reconcile(v);
		expect(out[0]!.action).toBe("relinked");
		expect(out[0]!.detail).toContain("found/it.png");
	});

	test("a record with no stored hash cannot be re-found, and says so", async () => {
		seed(record({ image: { width: 0, height: 0, byteLength: 0, hash: "" } }));
		v.files.delete(IMAGE);
		const out = await reconcile(v);
		expect(out[0]!.action).toBe("broken");
	});
});

describe("records that must not be written back", () => {
	test("a lossy record is reported and left alone", async () => {
		// Reading tolerantly and then saving what was read would delete exactly the data the user
		// needs in order to fix it, and the save would look like it worked.
		const fm = toFrontmatter(record());
		(fm[KEY.fits] as { points: unknown[] }[])[0]!.points.push({ px: 5, py: 5, lat: 999, lng: 0 });
		v.addNote(NOTE, fm);
		const out = await reconcile(v);
		expect(out[0]!.action).toBe("lossy");
		expect(out[0]!.detail).toContain("outside Earth");
		expect(v.writes).toHaveLength(0);
	});

	test("unreadable frontmatter is reported, not skipped in silence", async () => {
		v.addNote(NOTE, { [KEY.id]: "geb-0001" });
		const out = await reconcile(v);
		expect(out[0]!.action).toBe("unparsable");
		expect(out[0]!.detail).toBeDefined();
	});
});

describe("duplicate ids", () => {
	test("are reported and never resolved by picking a winner", async () => {
		// Obsidian's "Make a copy" produces this. Choosing between them would silently discard one
		// of the user's maps.
		v.addNote("maps/Copy of Britain 5c.md", toFrontmatter(record()));
		const out = await reconcile(v);
		const dup = out.find((o) => o.action === "duplicate-id");
		expect(dup).toBeDefined();
		expect(dup!.detail).toContain("geb-0001");
		expect(v.writes).toHaveLength(0);
	});
});

describe("lifecycle", () => {
	test("shouldContinue stops the walk, so an unloaded plugin stops writing", async () => {
		const out = await reconcile(v, () => false);
		expect(out).toHaveLength(0);
	});
});
