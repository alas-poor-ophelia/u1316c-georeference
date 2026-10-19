import { beforeEach, describe, expect, test } from "bun:test";
import { handleRename } from "../src/persist/rename";
import { KEY } from "../src/persist/types";
import { FakeVault } from "./fake-vault";

const NOTE = "maps/Britain 5c.md";
const IMAGE = "att/britain-5c.png";
const RENAMED = "att/britain-5th-century.png";

let v: FakeVault;

function seed(link = "[[britain-5c.png]]"): void {
	v = new FakeVault();
	v.addFile(IMAGE);
	v.addNote(NOTE, { [KEY.id]: "geb-0001", [KEY.image]: link, [KEY.crs]: "earth", [KEY.fits]: [] });
}

const link = (note = NOTE): unknown => v.readFrontmatter(note)?.[KEY.image];

beforeEach(() => seed());

describe("the two orderings Obsidian can produce", () => {
	test("Vault.rename leaves the link stale, and Geb rewrites it", async () => {
		v.movePreservingLinks(IMAGE, RENAMED);
		const out = await handleRename(v, IMAGE, RENAMED);
		expect(out[0]!.action).toBe("rewritten");
		expect(link()).toBe("[[britain-5th-century.png]]");
	});

	test("if Obsidian rewrote first, Geb writes nothing", async () => {
		v.moveUpdatingLinks(IMAGE, RENAMED, KEY.image);
		const out = await handleRename(v, IMAGE, RENAMED);
		expect(out[0]!.action).toBe("unchanged");
		expect(v.writes).toHaveLength(0);
	});

	test("if Geb runs first and Obsidian rewrites after, the result is still correct", async () => {
		// This is the ordering review believes is the real one — FileManager.renameFile fires the
		// vault event BEFORE it rewrites backlinks — and the fake previously only modelled the
		// opposite, which made the test above assert a possibly unreachable state. Both orderings
		// are now exercised, and the handler has to be safe under either.
		v.movePreservingLinks(IMAGE, RENAMED);
		await handleRename(v, IMAGE, RENAMED);
		// Obsidian's updater now runs over a link Geb already fixed.
		v.moveUpdatingLinks(RENAMED, RENAMED, KEY.image);
		expect(link()).toBe("[[britain-5th-century.png]]");
	});

	test("the write decision is re-derived from the live value, not the cached one", async () => {
		// If the live frontmatter already resolves to the target, the mutator must no-op even
		// though the cached value said otherwise. Otherwise a stale cache is a lost update.
		v.movePreservingLinks(IMAGE, RENAMED);
		const stale = v.readFrontmatter(NOTE)!;
		stale[KEY.image] = "[[britain-5th-century.png]]"; // someone else got there first
		const out = await handleRename(v, IMAGE, RENAMED);
		expect(out[0]!.action).toBe("unchanged");
	});
});

describe("converging the target, not the text", () => {
	test("an impostor sharing the basename does not capture the link", async () => {
		// The defect this replaces: resolution ran FIRST, so after the rename the link resolved to
		// the other file, desired text equalled stored text, and the handler reported "unchanged"
		// while the georeference silently pointed at a DIFFERENT image.
		v.addFile("other/britain-5c.png");
		v.movePreservingLinks(IMAGE, RENAMED);
		const out = await handleRename(v, IMAGE, RENAMED);
		expect(out[0]!.action).toBe("rewritten");
		expect(link()).toBe("[[britain-5th-century.png]]");
		expect(link()).not.toBe("[[britain-5c.png]]");
	});

	test("an alias survives an unrelated rename", async () => {
		// Rebuilding the canonical text discarded the user's alias on ANY event anywhere.
		seed("[[britain-5c.png|My lovely map]]");
		v.addFile("att/portrait.png");
		v.movePreservingLinks("att/portrait.png", "art/portrait.png");
		const out = await handleRename(v, "att/portrait.png", "art/portrait.png");
		expect(out[0]!.action).toBe("unchanged");
		expect(link()).toBe("[[britain-5c.png|My lovely map]]");
	});

	test("an alias survives a real retarget", async () => {
		seed("[[britain-5c.png|My lovely map]]");
		v.movePreservingLinks(IMAGE, RENAMED);
		await handleRename(v, IMAGE, RENAMED);
		expect(link()).toBe("[[britain-5th-century.png|My lovely map]]");
	});

	test("a non-canonical but working link is left alone", async () => {
		// Full-path form resolves fine. Normalising it would be Geb overriding a user choice.
		seed(`[[${IMAGE}]]`);
		v.addFile("att/portrait.png");
		const out = await handleRename(v, "att/portrait.png", "art/portrait.png");
		expect(out[0]!.action).toBe("unchanged");
		expect(link()).toBe(`[[${IMAGE}]]`);
	});
});

describe("robustness of the loop", () => {
	test("one failing write does not strand the notes after it", async () => {
		// Without per-note isolation the whole loop threw, and since the old path lives only in
		// this event, every stranded note became unrepairable by any later rename.
		v.addFile("att/second.png");
		v.addNote("maps/Second.md", { [KEY.id]: "geb-0002", [KEY.image]: "[[second.png]]", [KEY.fits]: [] });
		v.failWrites.add(NOTE);
		v.movePreservingLinks(IMAGE, RENAMED);
		v.movePreservingLinks("att/second.png", "att/second-renamed.png");

		const out = await handleRename(v, IMAGE, RENAMED);
		expect(out).toHaveLength(2);
		expect(out.find((o) => o.notePath === NOTE)?.action).toBe("failed");
		// The second note was still visited.
		expect(out.find((o) => o.notePath === "maps/Second.md")).toBeDefined();
	});

	test("shouldContinue stops the loop between notes", async () => {
		v.addNote("maps/Second.md", { [KEY.id]: "geb-0002", [KEY.image]: "[[x.png]]", [KEY.fits]: [] });
		const out = await handleRename(v, IMAGE, RENAMED, () => false);
		expect(out).toHaveLength(0);
	});

	test("running it twice is a no-op the second time", async () => {
		v.movePreservingLinks(IMAGE, RENAMED);
		await handleRename(v, IMAGE, RENAMED);
		const after = v.writes.length;
		const second = await handleRename(v, IMAGE, RENAMED);
		expect(second[0]!.action).toBe("unchanged");
		expect(v.writes).toHaveLength(after);
	});
});

describe("renames that are none of Geb's business", () => {
	test("an unrelated file moving writes nothing", async () => {
		v.addFile("att/portrait.png");
		v.movePreservingLinks("att/portrait.png", "art/portrait.png");
		const out = await handleRename(v, "att/portrait.png", "art/portrait.png");
		expect(out[0]!.action).toBe("unchanged");
		expect(v.writes).toHaveLength(0);
	});

	test("a note without a Geb id is never visited", async () => {
		v.addNote("Daily/2026-10-19.md", { tags: ["journal"] });
		const out = await handleRename(v, IMAGE, RENAMED);
		expect(out.map((o) => o.notePath)).not.toContain("Daily/2026-10-19.md");
	});

	test("a link broken for some other reason is reported, not guessed at", async () => {
		seed("[[not-a-real-image.png]]");
		v.movePreservingLinks(IMAGE, RENAMED);
		const out = await handleRename(v, IMAGE, RENAMED);
		expect(out[0]!.action).toBe("unresolved");
		expect(v.writes).toHaveLength(0);
	});

	test("a note link is not retargeted at a renamed image of the same stem", async () => {
		// linkMatchesPath used to accept extension-less forms for any file, so renaming
		// britain-5c.png would have hijacked a link that pointed at britain-5c.md.
		seed("[[britain-5c]]");
		v.addFile("notes/britain-5c.md");
		v.movePreservingLinks(IMAGE, RENAMED);
		const out = await handleRename(v, IMAGE, RENAMED);
		expect(out[0]!.action).toBe("unchanged");
		expect(link()).toBe("[[britain-5c]]");
	});
});

describe("the sidecar note itself moving", () => {
	test("leaves a still-resolving link alone", async () => {
		// Corrected expectation. An earlier version renormalised the text here, which was Geb
		// rewriting a user's link for no functional gain — Obsidian itself does not re-canonicalise
		// links when a note moves, and a basename link resolves from anywhere in the vault.
		const moved = "archive/Britain 5c.md";
		v.movePreservingLinks(NOTE, moved);
		const out = await handleRename(v, NOTE, moved);
		expect(out).toHaveLength(1);
		expect(out[0]!.notePath).toBe(moved);
		expect(out[0]!.action).toBe("unchanged");
		expect(link(moved)).toBe("[[britain-5c.png]]");
	});
});
