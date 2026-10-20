/**
 * An in-memory `VaultPort` for driving the persistence layer without Obsidian.
 *
 * It APPROXIMATES Obsidian's link behaviour rather than reproducing it, and three of the earlier
 * approximations were not merely incomplete but actively MISLEADING. They are fixed here, and
 * named, because a fake that is wrong in the generous direction manufactures passing tests:
 *
 *   - Extension-less resolution used to apply to every file, so `[[britain-5c]]` resolved to a
 *     PNG. Real Obsidian omits the extension only for markdown. The old "all four link forms"
 *     test was therefore false comfort.
 *   - `resolveLink` ignored `sourcePath` and returned the first match in insertion order. Real
 *     Obsidian prefers a match in or near the source's own folder, which is exactly what decides
 *     the basename-collision case.
 *   - `makeLink` counted basenames case-sensitively while `resolveLink` matched
 *     case-insensitively, so the two disagreed about what "unique" meant.
 *
 * What remains approximate, each one a test that CANNOT fail here:
 *
 *   - `listCandidateImages` treats every non-`.md` file as an image candidate, while the real
 *     adapter filters by `IMAGE_EXTENSIONS` (png, jpg, jpeg, gif, bmp, webp, avif, svg). Adding
 *     that filter to this fake leaves the whole suite green, so the adapter's filter is
 *     unexercised and no test here can show a `.txt` being refused as an image.
 *   - `readFrontmatter` hands back the LIVE mutable object. Obsidian's metadata cache lags behind
 *     a write, so a stale-read bug cannot surface here. The reconcile and rename paths re-read
 *     inside the mutator precisely because of that lag, and this fake cannot prove it matters.
 *   - The exact shortest-path ranking for an ambiguous link.
 *   - `createNote` stores the frontmatter RECORD directly. The real adapter creates an empty note
 *     and hands the record to Obsidian's `processFrontMatter`, which serialises it to YAML — so a
 *     record that cannot survive that round trip (a nested list of mappings quoted wrongly, a key
 *     YAML reads back as a different type) is invisible here. This fake cannot fail a YAML
 *     round-trip test, and `geb-fits` is exactly the nested shape most at risk.
 *   - `trashNote` removes the note outright. The real one trashes it, recoverably, so no test
 *     here can show that a deleted georeference is still retrievable by the user.
 *
 * Anything depending on those belongs in a real-vault test, not here.
 */
import type { VaultPort } from "../src/persist/types";
import { looksLikeGeoref } from "../src/persist/serialize";

const basename = (p: string): string => {
	const i = p.lastIndexOf("/");
	return i >= 0 ? p.slice(i + 1) : p;
};
const stripExt = (p: string): string => {
	const dot = p.lastIndexOf(".");
	const slash = p.lastIndexOf("/");
	return dot > slash ? p.slice(0, dot) : p;
};

export class FakeVault implements VaultPort {
	readonly notes = new Map<string, Record<string, unknown>>();
	readonly files = new Set<string>();
	readonly binaries = new Map<string, ArrayBuffer>();
	/** Every writeFrontmatter call, so a test can assert that nothing was written. */
	readonly writes: string[] = [];
	/** Every createNote and trashNote call, for the same reason. */
	readonly creates: string[] = [];
	readonly trashed: string[] = [];
	/** Note paths whose writes should reject, for testing per-note isolation. */
	readonly failWrites = new Set<string>();

	addNote(path: string, frontmatter: Record<string, unknown>): void {
		this.notes.set(path, { ...frontmatter });
		this.files.add(path);
	}

	addFile(path: string, bytes?: ArrayBuffer): void {
		this.files.add(path);
		if (bytes !== undefined) this.binaries.set(path, bytes);
	}

	/** Move a file or note, leaving links untouched — what `Vault.rename` does. */
	movePreservingLinks(oldPath: string, newPath: string): void {
		this.files.delete(oldPath);
		this.files.add(newPath);
		const fm = this.notes.get(oldPath);
		if (fm !== undefined) {
			this.notes.delete(oldPath);
			this.notes.set(newPath, fm);
		}
		const bin = this.binaries.get(oldPath);
		if (bin !== undefined) {
			this.binaries.delete(oldPath);
			this.binaries.set(newPath, bin);
		}
	}

	/** Move a file AND rewrite links that pointed at it — what `FileManager.renameFile` does. */
	moveUpdatingLinks(oldPath: string, newPath: string, key: string): void {
		this.movePreservingLinks(oldPath, newPath);
		for (const fm of this.notes.values()) {
			const v = fm[key];
			if (typeof v !== "string") continue;
			const target = v.replace(/^\[\[|\]\]$/g, "");
			if (target.toLowerCase() === basename(oldPath).toLowerCase() || target.toLowerCase() === oldPath.toLowerCase()) {
				fm[key] = `[[${basename(newPath)}]]`;
			}
		}
	}

	/**
	 * When true, `readFrontmatter` serves the state as of BEFORE the most recent write to a path,
	 * modelling Obsidian's metadata cache lagging behind `processFrontMatter`.
	 *
	 * Without this the fake is more permissive than reality in the one way that matters most for
	 * the API: it hands back the live object, so a read-after-write always sees the write and a
	 * test of "the write must return what it wrote rather than re-reading" cannot fail. That bug
	 * is deterministic in the real app and would hit the first write a UI makes.
	 */
	lagReads = false;
	/** Pre-write state per path while lagging. A null entry means "did not exist yet". */
	private readonly lagged = new Map<string, Record<string, unknown> | null>();

	/** The metadata cache catching up — what Obsidian's `changed` event stands for. */
	settleCache(): void {
		this.lagged.clear();
	}

	readFrontmatter(notePath: string): Record<string, unknown> | null {
		if (this.lagReads && this.lagged.has(notePath)) return this.lagged.get(notePath) ?? null;
		return this.notes.get(notePath) ?? null;
	}

	private lag(notePath: string, before: Record<string, unknown> | null): void {
		if (this.lagReads && !this.lagged.has(notePath)) {
			this.lagged.set(notePath, before === null ? null : structuredClone(before));
		}
	}

	writeFrontmatter(notePath: string, mutate: (fm: Record<string, unknown>) => void): Promise<void> {
		const fm = this.notes.get(notePath);
		if (fm === undefined) return Promise.reject(new Error(`no such note: ${notePath}`));
		if (this.failWrites.has(notePath)) return Promise.reject(new Error(`write refused: ${notePath}`));
		this.writes.push(notePath);
		this.lag(notePath, fm);
		mutate(fm);
		return Promise.resolve();
	}

	resolveLink(linkText: string, sourcePath: string): { readonly path: string } | null {
		const t = linkText.toLowerCase();
		const exact = [...this.files].filter((f) => f.toLowerCase() === t);
		if (exact.length > 0) return { path: exact[0]! };

		const byBase = [...this.files].filter((f) => basename(f).toLowerCase() === t);
		// Extension-less targets resolve only for markdown, as in real Obsidian.
		const byStem = [...this.files].filter(
			(f) => f.toLowerCase().endsWith(".md") && stripExt(basename(f)).toLowerCase() === t,
		);
		const candidates = byBase.length > 0 ? byBase : byStem;
		if (candidates.length === 0) return null;
		if (candidates.length === 1) return { path: candidates[0]! };

		// Ambiguous: prefer the source's own folder, then the shallowest path. An approximation of
		// Obsidian's ranking, but one that at least depends on sourcePath — the old version
		// returned insertion order, which is what made the collision case untestable.
		const dir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
		const sameFolder = candidates.filter((f) => f.startsWith(`${dir}/`));
		const pool = sameFolder.length > 0 ? sameFolder : candidates;
		return { path: [...pool].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0]! };
	}

	makeLink(targetPath: string, _sourcePath: string): string {
		const base = basename(targetPath).toLowerCase();
		let seen = 0;
		for (const f of this.files) if (basename(f).toLowerCase() === base) seen++;
		return seen === 1 ? `[[${basename(targetPath)}]]` : `[[${targetPath}]]`;
	}

	readBinary(path: string): Promise<ArrayBuffer> {
		const b = this.binaries.get(path);
		return b === undefined ? Promise.reject(new Error(`no such file: ${path}`)) : Promise.resolve(b);
	}

	listNotes(): readonly string[] {
		return [...this.notes.keys()];
	}

	listGeorefNotes(): readonly string[] {
		return [...this.notes.entries()].filter(([, fm]) => looksLikeGeoref(fm)).map(([p]) => p);
	}

	listCandidateImages(): readonly { readonly path: string; readonly byteLength: number }[] {
		const out: { path: string; byteLength: number }[] = [];
		for (const p of this.files) {
			if (p.toLowerCase().endsWith(".md")) continue;
			out.push({ path: p, byteLength: this.binaries.get(p)?.byteLength ?? 0 });
		}
		return out;
	}

	createNote(notePath: string, mutate: (fm: Record<string, unknown>) => void): Promise<void> {
		// Rejecting on an existing path is the one behaviour of `vault.create` worth reproducing:
		// a create that overwrote would destroy a note.
		if (this.notes.has(notePath) || this.files.has(notePath)) {
			return Promise.reject(new Error(`already exists: ${notePath}`));
		}
		// A note that has just been created is not in the cache AT ALL, which is a harder lag than
		// a stale value: a read-back returns null and the caller is told its own new georeference
		// does not exist.
		this.lag(notePath, null);
		const fm: Record<string, unknown> = {};
		mutate(fm);
		this.notes.set(notePath, fm);
		this.files.add(notePath);
		this.creates.push(notePath);
		return Promise.resolve();
	}

	trashNote(notePath: string): Promise<void> {
		if (!this.notes.has(notePath)) return Promise.reject(new Error(`no such note: ${notePath}`));
		this.notes.delete(notePath);
		this.files.delete(notePath);
		this.trashed.push(notePath);
		return Promise.resolve();
	}
}
