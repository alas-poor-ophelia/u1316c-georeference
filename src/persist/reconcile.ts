/**
 * Event-independent reconciliation.
 *
 * WHY THIS EXISTS. The rename handler is idempotent for the event it was given, which is not the
 * same as convergent. The old path lives nowhere but in that one event, so every way of missing
 * it leaves a record that no later rename can repair:
 *
 *   - the write failed, or threw
 *   - Geb was disabled, or not yet loaded, when the rename happened
 *   - the vault was still indexing, so the metadata cache had nothing and the note was skipped
 *   - sync or the filesystem delivered the move as a delete plus a create, not a rename
 *
 * So the stored content hash stops being decoration and becomes the recovery key: it is the only
 * identifier of the image that survives a rename nobody observed. Reconciliation resolves what it
 * can, and for what it cannot, re-finds the image by content and repairs the link.
 *
 * COST. Hashing every image in a vault would be absurd, so candidates are filtered by byte length
 * first — which Obsidian reports without reading the file — and that normally leaves one file or
 * none. A vault with no broken links hashes nothing at all.
 */
import { compareIdentity, hashBytes } from "./identity";
import { linkTarget, retarget } from "./links";
import { fromFrontmatter } from "./serialize";
import { KEY, type Georeference, type Staleness, type VaultPort } from "./types";

export interface ReconcileOutcome {
	readonly notePath: string;
	readonly action:
		| "ok"
		/** The link was broken and the image was re-found by content hash. Link repaired. */
		| "relinked"
		/** The link is broken and no file in the vault matches the stored content. */
		| "broken"
		/** The image resolves but is not the file the control points were placed on. */
		| "stale"
		/** The frontmatter could not be read as a georeference at all. */
		| "unparsable"
		/** Read but with data dropped; must not be written back until the user fixes it. */
		| "lossy"
		/** Another note claims the same id. */
		| "duplicate-id"
		| "failed";
	readonly detail?: string;
}

async function identityOf(port: VaultPort, path: string): Promise<{ byteLength: number; hash: string }> {
	const buf = await port.readBinary(path);
	return { byteLength: buf.byteLength, hash: hashBytes(buf) };
}

/** Re-find an image by content among the files whose size already matches. */
async function findByContent(port: VaultPort, g: Georeference): Promise<string | null> {
	if (g.image.hash === "" || g.image.byteLength <= 0) return null;
	for (const c of port.listCandidateImages()) {
		if (c.byteLength !== g.image.byteLength) continue;
		try {
			const { hash } = await identityOf(port, c.path);
			if (hash === g.image.hash) return c.path;
		} catch {
			// An unreadable candidate is not a match; keep looking rather than failing the note.
		}
	}
	return null;
}

async function reconcileNote(port: VaultPort, notePath: string): Promise<ReconcileOutcome> {
	const parsed = fromFrontmatter(port.readFrontmatter(notePath));
	if (parsed.value === null) {
		return { notePath, action: "unparsable", detail: parsed.problems.join("; ") };
	}
	if (parsed.lossy) {
		// Reported rather than silently carried: a lossy record that gets written back deletes
		// exactly the data the user needs in order to fix it.
		return { notePath, action: "lossy", detail: parsed.problems.join("; ") };
	}
	const g = parsed.value;

	const resolved = port.resolveLink(linkTarget(g.imageLink), notePath);
	if (resolved !== null) {
		const current = await identityOf(port, resolved.path);
		const verdict: Staleness = compareIdentity(g.image, current);
		if (verdict === "changed") {
			return {
				notePath,
				action: "stale",
				detail: `${resolved.path} is not the image these control points were placed on`,
			};
		}
		return { notePath, action: "ok" };
	}

	const found = await findByContent(port, g);
	if (found === null) {
		return { notePath, action: "broken", detail: `${g.imageLink} resolves to nothing and no file matches its stored content` };
	}

	const canonical = linkTarget(port.makeLink(found, notePath));
	await port.writeFrontmatter(notePath, (live) => {
		const raw = live[KEY.image];
		const liveLink = typeof raw === "string" ? raw.trim() : "";
		live[KEY.image] = liveLink === "" ? `[[${canonical}]]` : retarget(liveLink, canonical);
	});
	return { notePath, action: "relinked", detail: `re-found by content hash at ${found}` };
}

/**
 * Walk every georeference and repair what can be repaired.
 *
 * Intended to run once after the vault finishes indexing, not on every event. Duplicate ids are
 * reported but never resolved: two notes claiming one id is a user decision — Obsidian's "Make a
 * copy" produces it — and picking a winner would silently discard one of their maps.
 */
export async function reconcile(
	port: VaultPort,
	shouldContinue: () => boolean = () => true,
): Promise<ReconcileOutcome[]> {
	const out: ReconcileOutcome[] = [];
	const seen = new Map<string, string>();

	for (const notePath of port.listGeorefNotes()) {
		if (!shouldContinue()) break;
		try {
			const fm = port.readFrontmatter(notePath);
			const id = typeof fm?.[KEY.id] === "string" ? (fm[KEY.id] as string).trim() : "";
			if (id !== "") {
				const first = seen.get(id);
				if (first !== undefined) {
					out.push({ notePath, action: "duplicate-id", detail: `id ${id} is also claimed by ${first}` });
					continue;
				}
				seen.set(id, notePath);
			}
			out.push(await reconcileNote(port, notePath));
		} catch (e) {
			out.push({ notePath, action: "failed", detail: e instanceof Error ? e.message : String(e) });
		}
	}
	return out;
}
