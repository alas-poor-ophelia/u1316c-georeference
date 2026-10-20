/**
 * The index host: one cached snapshot, one dirty flag, and the change events derived from it.
 *
 * WHAT INVALIDATES, AND WHAT MUST NOT. Only the vault's own change notifications mark this dirty
 * — `changed`, `rename`, `create`, `delete`. A WRITE NEVER DOES, and that is the load-bearing
 * rule of the whole design rather than an oversight.
 *
 * Geb reads through Obsidian's metadata cache and writes through its frontmatter processor, and
 * nothing orders those two against each other. So if a write marked the index dirty, the next
 * query would rebuild from a cache that still holds the PRE-write frontmatter, publish it as
 * current, and clear the flag. The user's control point would appear to vanish and return one
 * unrelated event later.
 *
 * MEASURED, not inferred: in a live vault on Obsidian 1.14.4, six identical runs, the cache
 * returns the pre-write value at the instant the write resolves — every time, within a window of
 * a few milliseconds. `changed` does then fire for that note carrying the new frontmatter, which
 * is what makes invalidating on the EVENT correct and invalidating on the write wrong. (It does
 * not fire on rename, which is why `Vault.on('rename')` is hooked separately.)
 *
 * So: writes return the record they wrote (src/persist/write.ts), and the index catches up when
 * the cache does. The consequence is explicit in API.md — for a moment after your own write, the
 * index still describes the previous state. Use the returned record.
 *
 * NO TIMER IN HERE. `flush()` is explicit, and the plugin layer debounces it, because src/api is
 * fenced against Obsidian precisely so the whole surface can be driven by a fake. A timer here
 * would need faking too, and a test that waits on wall-clock time is a test that flakes.
 *
 * A QUERY NEVER READS A STALE INDEX. `snapshot()` rebuilds synchronously when dirty, so the
 * debounce can never starve a caller — the timer only decides when EVENTS fire, never whether an
 * answer is current.
 */
import { buildIndex } from "../query/store";
import { canonical, fitKey, FitMemo } from "../query/fit-memo";
import type { VaultPort } from "../persist/types";
import type { WorldIndex } from "../query/types";

/** The three things that can change at one note path, each as a comparable fingerprint. */
interface PathSignature {
	/** The fit key of a loaded georeference here. */
	readonly fit?: string;
	/** Code and reason of a rejected georeference here. */
	readonly rejected?: string;
	/** The whole feature, canonically serialised. */
	readonly feature?: string;
}

export type ChangeEvent = "georefs-changed" | "fit-changed" | "features-changed";

/** Which events a rebuild earned, and the paths that earned them. */
export interface ChangeSet {
	readonly events: readonly ChangeEvent[];
	readonly paths: readonly string[];
}

function signatures(index: WorldIndex): Map<string, PathSignature> {
	const out = new Map<string, PathSignature>();
	const put = (path: string, part: PathSignature): void => {
		out.set(path, { ...out.get(path), ...part });
	};
	for (const g of index.georefs) put(g.notePath, { fit: fitKey(g.record.fits[0]!, g.record.crs) });
	for (const r of index.rejected) put(r.notePath, { rejected: `${r.code}:${r.reason}` });
	for (const f of index.features) put(f.notePath, { feature: canonical(f) });
	return out;
}

export class IndexHost {
	private current: WorldIndex | null = null;
	private sigs = new Map<string, PathSignature>();
	private dirty = true;
	private readonly pending = new Set<string>();
	private gen = 0;
	/** The first build is the initial STATE, not a change. See `rebuild`. */
	private everBuilt = false;
	private readonly fits = new FitMemo();

	constructor(private readonly port: VaultPort) {}

	/** Exposed for the solve-count assertions; the memo is otherwise this host's business. */
	get memo(): FitMemo {
		return this.fits;
	}

	get generation(): number {
		return this.gen;
	}

	get isDirty(): boolean {
		return this.dirty;
	}

	get pendingPaths(): readonly string[] {
		return [...this.pending];
	}

	/**
	 * A vault change at this path. NOT to be called by a write — see the header.
	 *
	 * `undefined` means "something changed but we do not know where", which is what the metadata
	 * cache's batch-settled signal gives us. It forces a full diff rather than a scoped one.
	 */
	invalidate(path?: string): void {
		this.dirty = true;
		if (path !== undefined) this.pending.add(path);
		else this.pending.clear();
	}

	/** The current snapshot, rebuilt first if the vault has moved under us. */
	snapshot(): WorldIndex {
		if (this.dirty || this.current === null) this.rebuild();
		return this.current!;
	}

	/**
	 * Rebuild if dirty and report what changed. Returns null when there was nothing to do, so a
	 * debounced caller does not emit an event for a flush that did no work.
	 */
	flush(): ChangeSet | null {
		if (!this.dirty && this.current !== null) return null;
		return this.rebuild();
	}

	/** Drop everything. The solved fits are the expensive part. */
	clear(): void {
		this.current = null;
		this.sigs = new Map();
		this.pending.clear();
		this.dirty = true;
		this.everBuilt = false;
		this.fits.clear();
	}

	private rebuild(): ChangeSet {
		const before = this.sigs;
		const next = buildIndex(this.port, this.fits);
		const after = signatures(next);

		// THE FIRST BUILD IS NOT A CHANGE. Diffing it against an empty map would report every map
		// in the vault as newly appeared, fire all three events on startup, and move the
		// generation — so a consumer caching on generation would re-read immediately after the
		// `ready` event it was waiting for.
		if (!this.everBuilt) {
			this.everBuilt = true;
			this.current = next;
			this.sigs = after;
			this.dirty = false;
			this.pending.clear();
			return { events: [], paths: [] };
		}

		// SCOPED TO THE PENDING PATHS when we know them. A `changed` event naming one note must
		// not make every consumer re-read everything, which is what an event carrying no paths
		// amounts to. An empty pending set means the signal was batch-settled and told us
		// nothing, so every path either side is in play.
		const scope =
			this.pending.size > 0
				? this.pending
				: new Set<string>([...before.keys(), ...after.keys()]);

		const events = new Set<ChangeEvent>();
		const moved: string[] = [];
		for (const path of scope) {
			const a = before.get(path);
			const b = after.get(path);
			if (a?.fit === b?.fit && a?.rejected === b?.rejected && a?.feature === b?.feature) continue;
			moved.push(path);

			// A map appearing, vanishing, or crossing between loaded and rejected is a change to
			// the SET of georeferences. A consumer listening only to `fit-changed` would otherwise
			// never learn that a map became REJECTED — a map disappearing in silence, which is the
			// one failure this plugin forbids.
			const wasLoaded = a?.fit !== undefined;
			const isLoaded = b?.fit !== undefined;
			if (wasLoaded !== isLoaded || a?.rejected !== b?.rejected) events.add("georefs-changed");

			// `fit-changed` is narrower on purpose: an EXISTING map whose transform moved, which
			// is what makes a consumer recompute pin positions rather than re-enumerate maps.
			if (wasLoaded && isLoaded && a.fit !== b.fit) events.add("fit-changed");

			if (a?.feature !== b?.feature) events.add("features-changed");
		}

		this.current = next;
		this.sigs = after;
		this.dirty = false;
		this.pending.clear();
		if (moved.length > 0) this.gen += 1;
		return { events: [...events], paths: moved };
	}
}
