/**
 * Writing a georeference, and reading back WHAT WAS WRITTEN rather than what the cache thinks.
 *
 * THE WHOLE POINT OF THIS FILE, and it is MEASURED rather than inferred. Geb's reads and its
 * writes go through two different Obsidian mechanisms: `readFrontmatter` returns
 * `metadataCache.getFileCache(f)?.frontmatter`, while `writeFrontmatter` calls
 * `fileManager.processFrontMatter(f, mutate)`. Nothing orders those against each other.
 *
 * Measured in a live vault on Obsidian 1.14.4, six identical runs: at the instant the write's
 * promise resolves, the cache returns the PRE-WRITE frontmatter — every time. The write resolves
 * in 2–4 ms and `changed` arrives 3–11 ms from the same origin, so the stale window is a few
 * milliseconds wide and entirely reliable. For a note that has just been CREATED the cache
 * returns null both immediately and after a microtask tick: it does not know the note at all.
 *
 * Any API that wrote and then re-read would therefore hand the caller back the pre-write state —
 * deterministically, not as a race, and on the very first write a UI makes. A control point would
 * appear to vanish and then reappear one unrelated event later. This is the same shape as the two
 * bugs the persistence layer already paid for: a decision taken from the metadata cache and
 * applied to something just written to disk.
 *
 * The fix is to never re-read. `processFrontMatter` hands the mutator the live frontmatter object,
 * so the post-mutation truth is in hand INSIDE the callback — parse it there and capture it in a
 * closure. Note what this is not: computing the result before the write and returning it after is
 * the lost-update bug wearing a new hat, because Obsidian's own link updater may have touched the
 * note in between. `rename.ts` already re-derives inside the mutator for exactly that reason.
 *
 * `VaultPort.writeFrontmatter` needs no signature change. The closure is the channel.
 */
import { fromFrontmatter } from "./serialize";
import type { Georeference, ParseResult, VaultPort } from "./types";

/**
 * Mutate a note's frontmatter and return the record as it stands AFTER the mutation, parsed from
 * the live object inside the mutator.
 *
 * A null `value` means the mutation produced frontmatter that is not a usable georeference. That
 * is reported to the caller rather than thrown, because the write has already happened and the
 * caller needs to know what is now in the note — pretending otherwise would leave the user with a
 * note Geb refuses to acknowledge.
 */
export async function writeAndCapture(
	port: VaultPort,
	notePath: string,
	mutate: (fm: Record<string, unknown>) => void,
): Promise<ParseResult<Georeference>> {
	let captured: ParseResult<Georeference> | null = null;
	await port.writeFrontmatter(notePath, (live) => {
		mutate(live);
		captured = fromFrontmatter(live);
	});
	// `processFrontMatter` not running the mutator would be an Obsidian contract break, not a user
	// error, so this says so plainly instead of inventing an empty result.
	if (captured === null) {
		throw new Error(`frontmatter mutator never ran for ${notePath}; nothing was captured`);
	}
	return captured;
}

/**
 * Create a note holding this georeference and return the record parsed from what was written.
 *
 * CAPTURED INSIDE THE MUTATOR, for the same reason as above and one sharper one: a note that has
 * just been created is not in the metadata cache at all, so reading it back returns nothing and
 * the caller would be told its own new georeference does not exist. The first draft of this
 * function did exactly that, three lines below the comment explaining why not to.
 */
export async function createAndCapture(
	port: VaultPort,
	notePath: string,
	frontmatter: Record<string, unknown>,
): Promise<ParseResult<Georeference>> {
	let captured: ParseResult<Georeference> | null = null;
	await port.createNote(notePath, (fm) => {
		Object.assign(fm, frontmatter);
		captured = fromFrontmatter(fm);
	});
	if (captured === null) {
		throw new Error(`frontmatter mutator never ran for ${notePath}; nothing was captured`);
	}
	return captured;
}
