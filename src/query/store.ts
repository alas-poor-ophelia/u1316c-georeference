/**
 * Building the coverage snapshot: georeference notes into usable fits, place notes into features.
 *
 * Every failure is REPORTED, never dropped silently. A georeference that cannot be loaded is the
 * user's map not appearing, and "it just didn't show up" is the hardest kind of bug for them to
 * report and for us to diagnose. Problems carry a code and a note path rather than prose with the
 * path baked into it, so a UI can link to the note and sort by severity without parsing text.
 */
import { buildFit } from "../core/fit";
import { fromFrontmatter } from "../persist/serialize";
import { KEY, type VaultPort } from "../persist/types";
import { readFeature } from "./features";
import type { Feature, LoadedGeoref, Problem, RejectedGeoref, WorldIndex } from "./types";

function loadGeoref(
	port: VaultPort,
	notePath: string,
	problems: Problem[],
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
		const fit = buildFit(
			first.points,
			first.transform.lambda === undefined
				? { kind: first.transform.model }
				: { kind: first.transform.model, lambda: first.transform.lambda },
			first.bounds,
		);
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
 */
export function buildIndex(port: VaultPort): WorldIndex {
	const problems: Problem[] = [];
	const georefs: LoadedGeoref[] = [];
	const rejected: RejectedGeoref[] = [];
	const seenIds = new Map<string, string>();

	for (const notePath of port.listGeorefNotes()) {
		const result = loadGeoref(port, notePath, problems);
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
		if (fm !== null && typeof fm[KEY.id] === "string") continue;
		const f = readFeature(notePath, fm, problems);
		if (f !== null) features.push(f);
	}

	return { georefs, features, rejected, problems };
}
