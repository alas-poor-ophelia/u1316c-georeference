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
import { NO_PLACE_KEYS, type PlaceKeys, type WorldIndex } from "../query/types";

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
	/**
	 * A pathless invalidation is owed a FULL diff, until a rebuild gives it one. Clearing `pending`
	 * was not enough: a path invalidated after it, inside the same debounce window, refilled the
	 * set and narrowed the rebuild to that one note, so every other note that moved under a new
	 * place-note key, or a folder's worth of notes, was never announced.
	 */
	private everywhere = false;
	private gen = 0;
	/** The first build is the initial STATE, not a change. See `rebuild`. */
	private everBuilt = false;
	private readonly fits = new FitMemo();
	/**
	 * What query-time rebuilds found and nobody has announced yet. A query between an
	 * invalidation and the debounced flush used to rebuild, clear the dirty flag and DISCARD its
	 * change set, so the flush that followed saw nothing to do and the events were lost — and the
	 * plugin's own command-palette check is such a query. Found live: a saved map's view sat on
	 * "waiting for Obsidian" forever while the index already held the map.
	 */
	private held: { readonly events: Set<ChangeEvent>; readonly paths: Set<string> } | null = null;

	constructor(
		private readonly port: VaultPort,
		/**
		 * The user's own place-note property names, READ AT EACH REBUILD rather than captured, so a
		 * settings change takes effect on the next rebuild after an `invalidate()`. A getter, not the
		 * settings object, because src/api knows nothing of the plugin.
		 */
		private readonly placeKeys: () => PlaceKeys = () => NO_PLACE_KEYS,
	) {}

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
		else {
			this.pending.clear();
			this.everywhere = true;
		}
	}

	/** The current snapshot, rebuilt first if the vault has moved under us. The change is HELD. */
	snapshot(): WorldIndex {
		if (this.dirty || this.current === null) this.hold(this.rebuild());
		return this.current!;
	}

	/**
	 * Rebuild if dirty, then report everything that changed since the last flush — including what
	 * a query-time rebuild found in between. Returns null when there was nothing to do, so a
	 * debounced caller does not emit an event for a flush that did no work.
	 */
	flush(): ChangeSet | null {
		let built: ChangeSet | null = null;
		if (this.dirty || this.current === null) {
			built = this.rebuild();
			this.hold(built);
		}
		const held = this.held;
		this.held = null;
		if (held !== null) return { events: [...held.events], paths: [...held.paths] };
		return built;
	}

	/** Keep a change set until a flush announces it. An empty one is nothing to keep. */
	private hold(change: ChangeSet): void {
		if (change.events.length === 0 && change.paths.length === 0) return;
		const held = this.held ?? { events: new Set<ChangeEvent>(), paths: new Set<string>() };
		for (const e of change.events) held.events.add(e);
		for (const p of change.paths) held.paths.add(p);
		this.held = held;
	}

	/** Drop everything. The solved fits are the expensive part. */
	clear(): void {
		this.current = null;
		this.held = null;
		this.sigs = new Map();
		this.pending.clear();
		this.everywhere = false;
		this.dirty = true;
		this.everBuilt = false;
		this.fits.clear();
	}

	private rebuild(): ChangeSet {
		const before = this.sigs;
		const next = buildIndex(this.port, this.fits, this.placeKeys());
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
			this.everywhere = false;
			return { events: [], paths: [] };
		}

		// SCOPED TO THE PENDING PATHS when we know them. A `changed` event naming one note must
		// not make every consumer re-read everything, which is what an event carrying no paths
		// amounts to. An empty pending set means the signal was batch-settled and told us
		// nothing, so every path either side is in play — and stays so until this rebuild, whatever
		// paths arrived after it.
		const scope =
			!this.everywhere && this.pending.size > 0
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
		this.everywhere = false;
		if (moved.length > 0) this.gen += 1;
		return { events: [...events], paths: moved };
	}
}
