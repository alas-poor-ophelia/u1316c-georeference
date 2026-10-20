/**
 * Content-keyed memoisation of fitted transforms.
 *
 * WHY THIS IS THE WHOLE OF STEP 2. The vault scan is 7–13 ms over 50,000 notes; the worst case
 * in the whole layer is 214 ms, and it is ONE `buildFit` of a 300-point spline. Memoise fits by
 * content and a full rebuild costs the scan plus a refit of only what actually changed — which is
 * why the alternative of an incremental index was rejected: its entire complexity budget
 * (duplicate-id ordering, problem ownership, deletion paths, in-place mutation while a consumer
 * iterates) buys something a 13 ms rebuild already gives.
 *
 * WHY IT CANNOT GO STALE. The key IS the content, so a hit is by definition a fit of exactly
 * these inputs. There is no invalidation step to forget, no event to miss, and no dirty flag to
 * clear at the wrong moment. That matters here specifically: this plugin's persistence layer has
 * already produced two bugs from decisions taken against a stale cache, and phase 3 refused
 * caching outright because "an index keyed on the vault has no honest invalidation key short of
 * designing one". This is that key.
 *
 * WHAT GOES IN IT, and why it is derived rather than listed. Two independent reviewers wrote the
 * same key by hand — the fields `buildFit` reads — and both omitted `label`, because a label does
 * not affect the fit. It affects `diagnostics`, which is a memoised GETTER inside the `Fit`, so
 * the cached OBJECT reads more than the eager computation does and the difference is invisible at
 * the moment you write the key. So the key is derived by walking the parsed record: a field added
 * to `StoredFit` later is covered without anyone editing this file, and a point dropped upstream
 * by the CRS range check is absent from the key automatically.
 *
 * NOT HASHED, which is a deliberate departure from the architecture call's "a hash of the
 * serialised record". A hash collision here would serve the wrong transform for a map — silent
 * wrongness, the one failure this plugin forbids — and the canonical string costs nothing worth
 * having: a 300-point spline's key is some tens of kilobytes beside a memoised `Fit` holding that
 * spline's solved matrix, so the key is noise next to its own value. Zero collision risk for no
 * meaningful memory.
 */
import type { Fit } from "../core/fit";
import type { StoredFit } from "../persist/types";

/**
 * Canonical serialisation: object keys sorted at every level, absent keys omitted.
 *
 * Not `JSON.stringify`, which follows INSERTION order. The parser happens to build points in one
 * fixed order today, so a key straight from `JSON.stringify` would work by accident and break the
 * day anything constructs a record differently — a patch applied field by field, a future
 * migration, a third party writing frontmatter by hand.
 *
 * Exported because the index host needs the same guarantee when it fingerprints a FEATURE to
 * decide whether to fire `features-changed`. One canonical serialiser in the codebase, not two
 * that drift.
 */
export function canonical(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	if (typeof v === "object") {
		const entries = Object.entries(v as Record<string, unknown>)
			.filter(([, value]) => value !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, value]) => `${JSON.stringify(k)}:${canonical(value)}`).join(",")}}`;
	}
	if (typeof v === "number") {
		// `JSON.stringify` turns a non-finite number into `null`, which would make NaN collide
		// with an absent `bounds`. The parser's `finiteNumber` means this should be unreachable;
		// it is spelled out rather than trusted because the cost of being wrong is a wrong map.
		if (!Number.isFinite(v)) return `#${String(v)}`;
		// -0 and 0 deliberately collapse: they are the same coordinate and the same pixel, so they
		// are the same fit. This project has been bitten by -0 before, so it is said out loud.
		return JSON.stringify(v === 0 ? 0 : v);
	}
	return JSON.stringify(v) ?? "null";
}

/**
 * The key for one stored fit under one coordinate system.
 *
 * `crs` is not a field of the fit — it is a SELECTOR over its points, applied when the record is
 * parsed, because `inDomain` drops a control point outside the system's range. Two records
 * identical but for their coordinate system are not the same fit.
 */
export function fitKey(fit: StoredFit, crs: string): string {
	return `${canonical(crs)}|${canonical(fit)}`;
}

/**
 * A bounded store of fits, keyed by content.
 *
 * SELF-SWEEPING. Unbounded, this leaks one dense solve per edit: a user dragging a control point
 * on a 300-point spline mints a new key per drag and the old fits are never reachable again.
 * `buildIndex` sweeps at the end of each build, so an entry survives only if that build reused
 * it — no protocol for a caller to forget.
 */
export class FitMemo {
	private readonly byKey = new Map<string, Fit>();
	private touched = new Set<string>();
	private hitCount = 0;
	private missCount = 0;

	/** Fits retained right now. */
	get size(): number {
		return this.byKey.size;
	}

	/** Solves avoided, and solves performed. Counted so the benefit is assertable, not assumed. */
	get hits(): number {
		return this.hitCount;
	}
	get misses(): number {
		return this.missCount;
	}

	/**
	 * The memoised fit for this key, building it if absent.
	 *
	 * `build` may throw — degenerate control points do — and a throw is NOT cached. Caching the
	 * failure would need a second entry shape for "known bad", and a degenerate fit is a map the
	 * user is actively repairing, so re-solving it is the cheap case anyway.
	 */
	reuse(key: string, build: () => Fit): Fit {
		this.touched.add(key);
		const hit = this.byKey.get(key);
		if (hit !== undefined) {
			this.hitCount += 1;
			return hit;
		}
		this.missCount += 1;
		const made = build();
		this.byKey.set(key, made);
		return made;
	}

	/**
	 * Drop everything, for unload.
	 *
	 * Explicit rather than leaning on `sweep()` happening to clear a memo whose touched set is
	 * already empty — true today, and exactly the kind of incidental behaviour that stops being
	 * true without anyone noticing.
	 */
	clear(): void {
		this.byKey.clear();
		this.touched = new Set();
	}

	/** Drop every entry the build that just finished did not reuse. */
	sweep(): void {
		for (const key of [...this.byKey.keys()]) {
			if (!this.touched.has(key)) this.byKey.delete(key);
		}
		this.touched = new Set();
	}
}
