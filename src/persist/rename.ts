/**
 * Rename handling, which Geb owns outright.
 *
 * `metadataCache.on('changed')` explicitly does not fire on rename, so `Vault.on('rename')` is
 * the only notification there is; and Obsidian's own rewriting of frontmatter links is unreliable,
 * least reliably of all for image attachments. So Geb repairs rather than trusts.
 *
 * CONVERGE THE TARGET, NOT THE TEXT. An earlier version computed the canonical link text and
 * wrote it whenever the stored text differed. Two defects followed, both found by review:
 *
 *   - It resolved the link FIRST and only fell back to matching the old path. With a second file
 *     of the same basename in the vault, a rename let the wrong file capture the link: the stored
 *     text already equalled the desired text, so the handler reported "unchanged" while the
 *     georeference silently pointed at a DIFFERENT image. An old-path match is definitive
 *     evidence of what the link meant; resolution is only the fallback, and the order matters.
 *   - Rebuilding the whole text discarded the user's alias and subpath on any unrelated rename
 *     anywhere in the vault. Those are the user's; the target is the only part Geb owns.
 *
 * IDEMPOTENT PER EVENT IS NOT CONVERGENT. The old path exists nowhere but in the event that
 * carried it, so a write that fails — or a rename that arrives while Geb is disabled, or while
 * the vault is still indexing, or as a delete-plus-create from sync — leaves a record no later
 * rename can repair. Event-independent recovery lives in reconcile.ts and is the real safety net;
 * this handler is the fast path.
 */
import { linkMatchesPath, linkTarget, retarget } from "./links";
import { looksLikeGeoref } from "./serialize";
import { KEY, type VaultPort } from "./types";

export interface RenameOutcome {
	readonly notePath: string;
	readonly action: "rewritten" | "unchanged" | "unresolved" | "not-ours" | "failed";
	readonly from?: string;
	readonly to?: string;
	readonly error?: string;
}

async function convergeNote(
	port: VaultPort,
	notePath: string,
	oldPath: string,
	newPath: string,
): Promise<RenameOutcome> {
	const fm = port.readFrontmatter(notePath);
	if (!looksLikeGeoref(fm)) return { notePath, action: "not-ours" };

	const stored = fm?.[KEY.image];
	const link = typeof stored === "string" ? stored.trim() : "";
	if (link === "") return { notePath, action: "not-ours" };

	// Which file this link MEANT. Old-path match first: it is evidence about intent, and it
	// outranks resolution precisely because resolution can land on an impostor after a rename.
	const resolved = port.resolveLink(linkTarget(link), notePath);
	const target = linkMatchesPath(link, oldPath) ? newPath : resolved === null ? null : resolved.path;
	if (target === null) return { notePath, action: "unresolved", from: link };

	// Already pointing at the right file? Then leave the text completely alone — alias, subpath,
	// path form and all. Resolution agreeing with the target is the whole test; the text being
	// non-canonical is not Geb's business.
	if (resolved !== null && resolved.path === target) return { notePath, action: "unchanged" };

	const canonical = linkTarget(port.makeLink(target, notePath));
	const desired = retarget(link, canonical);

	// The decision above came from the metadata cache; the write lands on disk. If Obsidian's own
	// link updater got there in between — the likely ordering for FileManager.renameFile, which
	// fires this event before rewriting backlinks — the cached value is stale and writing it back
	// would be a lost update. So re-derive from the LIVE value inside the mutator and no-op if it
	// already resolves to the target.
	let wrote = false;
	await port.writeFrontmatter(notePath, (live) => {
		const liveRaw = live[KEY.image];
		const liveLink = typeof liveRaw === "string" ? liveRaw.trim() : "";
		if (liveLink !== "") {
			const liveResolved = port.resolveLink(linkTarget(liveLink), notePath);
			if (liveResolved !== null && liveResolved.path === target) return;
		}
		live[KEY.image] = liveLink === "" ? desired : retarget(liveLink, canonical);
		wrote = true;
	});

	return wrote ? { notePath, action: "rewritten", from: link, to: desired } : { notePath, action: "unchanged" };
}

/**
 * Converge every georeference's image link after a vault rename.
 *
 * Per-note isolation is deliberate: without it one note whose write rejected threw the whole
 * loop, stranding every note after it in the iteration order — and since the old path lives only
 * in this event, those notes were then unrepairable by any later rename.
 *
 * `shouldContinue` lets a caller stop between notes, so an in-flight handler does not keep
 * writing frontmatter after the plugin has been unloaded.
 */
export async function handleRename(
	port: VaultPort,
	oldPath: string,
	newPath: string,
	shouldContinue: () => boolean = () => true,
): Promise<RenameOutcome[]> {
	const out: RenameOutcome[] = [];
	for (const notePath of port.listGeorefNotes()) {
		if (!shouldContinue()) break;
		try {
			out.push(await convergeNote(port, notePath, oldPath, newPath));
		} catch (e) {
			out.push({ notePath, action: "failed", error: e instanceof Error ? e.message : String(e) });
		}
	}
	return out;
}
