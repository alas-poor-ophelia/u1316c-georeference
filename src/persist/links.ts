/**
 * Wikilink text handling.
 *
 * Geb stores its image reference as `[[britain-5c.png]]` because Obsidian parses frontmatter
 * links into the metadata cache, which makes the reference resolvable and visible to the graph.
 * It does NOT rely on Obsidian to maintain that link: the phase-0 spike established that
 * `metadataCache.on('changed')` never fires on rename, and that core's own rewriting of
 * frontmatter links is unreliable and least reliable for image attachments.
 *
 * WHAT GEB OWNS AND WHAT IT LEAVES ALONE. The rename handler converges the link's TARGET and
 * nothing else. An earlier version rebuilt the whole text from the canonical form, which rewrote
 * `[[map.png|My map]]` to `[[map.png]]` on any unrelated rename anywhere in the vault — silently
 * discarding an alias the user wrote on purpose. Alias and subpath are the user's; the target is
 * the only part Geb has any business touching.
 */

export interface ParsedLink {
	/** The link target, with no `[[ ]]`, alias or subpath. */
	readonly target: string;
	/** Text after `#`, without the `#`, or null. */
	readonly subpath: string | null;
	/** Text after `|`, or null. */
	readonly alias: string | null;
	/** Whether the original was wrapped in `[[ ]]`. */
	readonly wrapped: boolean;
}

export function parseLink(raw: string): ParsedLink {
	let s = raw.trim();
	const wrapped = s.startsWith("[[") && s.endsWith("]]");
	if (wrapped) s = s.slice(2, -2);

	let alias: string | null = null;
	const pipe = s.indexOf("|");
	if (pipe >= 0) {
		alias = s.slice(pipe + 1);
		s = s.slice(0, pipe);
	}

	let subpath: string | null = null;
	const hash = s.indexOf("#");
	if (hash >= 0) {
		subpath = s.slice(hash + 1);
		s = s.slice(0, hash);
	}

	return { target: s.trim(), subpath, alias, wrapped };
}

export function formatLink(p: ParsedLink): string {
	const inner = `${p.target}${p.subpath === null ? "" : `#${p.subpath}`}${p.alias === null ? "" : `|${p.alias}`}`;
	return p.wrapped ? `[[${inner}]]` : inner;
}

/** Just the target, for callers that only need to resolve. */
export function linkTarget(raw: string): string {
	return parseLink(raw).target;
}

/**
 * Replace a link's target, keeping its alias, subpath and bracket form.
 *
 * `newTarget` is a bare target (what `fileToLinktext` returns), not a formatted link.
 */
export function retarget(original: string, newTarget: string): string {
	const p = parseLink(original);
	return formatLink({ ...p, target: newTarget, wrapped: true });
}

const withoutExtension = (p: string): string => {
	const dot = p.lastIndexOf(".");
	const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return dot > slash ? p.slice(0, dot) : p;
};

const basename = (p: string): string => {
	const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return slash >= 0 ? p.slice(slash + 1) : p;
};

/**
 * Did this link text point at this vault path?
 *
 * Needed because after a rename the old path no longer resolves, so the only way to tell whether
 * a stale link was ours is to compare it against the path that went away.
 *
 * EXTENSION-LESS FORMS ARE ACCEPTED ONLY FOR NOTES. Obsidian omits the extension when linking to
 * markdown and requires it for everything else, and matching `[[britain-5c]]` against a renamed
 * `britain-5c.png` was a false positive waiting to happen: a note link of that name would have
 * been retargeted at an image. Images must match with their extension.
 */
export function linkMatchesPath(raw: string, path: string): boolean {
	const t = parseLink(raw).target.toLowerCase();
	if (t === "") return false;
	const p = path.toLowerCase();
	if (t === p || t === basename(p)) return true;
	if (!p.endsWith(".md")) return false;
	return t === withoutExtension(p) || t === withoutExtension(basename(p));
}
