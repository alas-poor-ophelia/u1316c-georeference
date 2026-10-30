/**
 * Building the coverage snapshot: georeference notes into usable fits, place notes into features.
 *
 * Every failure is REPORTED, never dropped silently. A georeference that cannot be loaded is the
 * user's map not appearing, and "it just didn't show up" is the hardest kind of bug for them to
 * report and for us to diagnose. Problems carry a code and a note path rather than prose with the
 * path baked into it, so a UI can link to the note and sort by severity without parsing text.
 */
import { buildFit, type Fit } from "../core/fit";
import { fromFrontmatter, looksLikeGeoref } from "../persist/serialize";
import type { VaultPort } from "../persist/types";
import { readFeature } from "./features";
import { fitKey, type FitMemo } from "./fit-memo";
import { NO_PLACE_KEYS, type Feature, type LoadedGeoref, type PlaceKeys, type Problem, type RejectedGeoref, type WorldIndex } from "./types";

function loadGeoref(
	port: VaultPort,
	notePath: string,
	problems: Problem[],
	memo: FitMemo | undefined,
): LoadedGeoref | RejectedGeoref {
	const parsed = fromFrontmatter(port.readFrontmatter(notePath));
	if (parsed.value === null) {
		return {
			notePath,
			code: "unparsable",
			reason: parsed.problems.join("; ") || "not a usable georeference",
		};
	}
	const record = parsed.value;

	// A lossy record still loads: the user wants their map to work, and the lossy flag's job is to
	// stop a WRITE, not a read. But it is reported, because something they typed was discarded.
	if (parsed.lossy) {
		problems.push({
			notePath,
			code: "lossy-record",
			message: `loaded with data dropped, so it must not be saved until fixed — ${parsed.problems.join("; ")}`,
		});
	} else if (parsed.problems.length > 0) {
		problems.push({ notePath, code: "record-problem", message: parsed.problems.join("; ") });
	}

	// Without the image's dimensions there is no way to say what the map pictures, and coverage is
	// defined as what it pictures. Geb writes this itself, so only a hand-made record lacks it.
	const { width, height } = record.image;
	if (!(width > 0 && height > 0)) {
		return { notePath, code: "unknown-image-size", id: record.id, reason: "image size is unknown, so coverage cannot be determined" };
	}

	// A DEFENSIVE BACKSTOP, not a reachable path: `fromFrontmatter` already returns a null value
	// when `fits` is empty, so such a note is rejected as `unparsable` before it gets here and
	// `no-fits` cannot currently be emitted. Kept because it is what makes `fits[0]` safe without
	// a non-null assertion, and because the invariant lives in another file. Pinned by the test
	// "an empty fits list is rejected by the parser, before the store's backstop".
	const first = record.fits[0];
	if (first === undefined) return { notePath, code: "no-fits", id: record.id, reason: "no fits" };
	if (record.fits.length > 1) {
		problems.push({
			notePath,
			code: "extra-fits",
			message: `${record.fits.length} fits stored; v1 uses the first and ignores the rest`,
		});
	}

	try {
		const opts =
			first.transform.lambda === undefined
				? { kind: first.transform.model }
				: { kind: first.transform.model, lambda: first.transform.lambda };
		const build = (): Fit => buildFit(first.points, opts, first.bounds);
		// With no memo this is exactly the call it replaced — the degenerate case is the default,
		// so passing nothing leaves behaviour identical to before the memo existed.
		const fit = memo === undefined ? build() : memo.reuse(fitKey(first, record.crs), build);
		return { notePath, record, size: { width, height }, fit };
	} catch (e) {
		// Degenerate control points throw rather than returning garbage. That is the kernel doing
		// its job; here it means this one map is unusable and the rest of the vault is not.
		return {
			notePath,
			code: "degenerate-fit",
			id: record.id,
			reason: e instanceof Error ? e.message : String(e),
		};
	}
}

const isLoaded = (g: LoadedGeoref | RejectedGeoref): g is LoadedGeoref => "fit" in g;

/**
 * Snapshot the vault.
 *
 * Built fresh on demand; nothing is cached. The cost is measured and affordable for an
 * event-driven or per-user-action rebuild, and not for a per-frame or per-keystroke one — see the
 * note in types.ts. Who triggers a rebuild is a phase-4 decision, deliberately not guessed here.
 *
 * `keys` are the user's own place-note property names, from settings; none by default.
 */
export function buildIndex(port: VaultPort, memo?: FitMemo, keys: PlaceKeys = NO_PLACE_KEYS): WorldIndex {
	const problems: Problem[] = [];
	const georefs: LoadedGeoref[] = [];
	const rejected: RejectedGeoref[] = [];
	const seenIds = new Map<string, string>();

	for (const notePath of port.listGeorefNotes()) {
		const result = loadGeoref(port, notePath, problems, memo);
		if (!isLoaded(result)) {
			rejected.push(result);
			continue;
		}

		// A duplicate id is rejected rather than loaded alongside the first. Obsidian's "Make a
		// copy" produces it, and loading both left the second permanently unreachable through
		// featuresIn while still appearing in georefsCovering under the same id — two maps
		// collapsing into one as far as any consumer keyed on id could tell.
		const first = seenIds.get(result.record.id);
		if (first !== undefined) {
			rejected.push({
				notePath,
				code: "duplicate-id",
				id: result.record.id,
				reason: `id "${result.record.id}" is already used by ${first}; give this map its own id`,
			});
			problems.push({ notePath, code: "duplicate-id", message: `shares its id with ${first}` });
			continue;
		}
		seenIds.set(result.record.id, notePath);
		georefs.push(result);
	}

	const features: Feature[] = [];
	for (const notePath of port.listNotes()) {
		const fm = port.readFrontmatter(notePath);
		// A georeference note is not also a place note. Without this, a sidecar that happened to
		// carry lat/lng would be pinned on itself and on every other map.
		//
		// The SAME predicate the vault adapter uses to list georeferences, deliberately: this was
		// a second copy of `typeof geb-id === "string"`, so a note with `geb-id: 1066` was neither
		// listed as a georeference nor excluded from here — it was pinned as a place instead.
		if (looksLikeGeoref(fm)) continue;
		const f = readFeature(notePath, fm, problems, keys);
		if (f !== null) features.push(f);
	}

	// Swept at the END of the build, so an entry survives only if THIS build reused it. A
	// user dragging one control point mints a new key per drag, and the superseded fits are
	// unreachable forever after — unbounded, that leaks a dense solve apiece.
	memo?.sweep();
	return { georefs, features, rejected, problems };
}
