/**
 * Reading coordinates off a place note.
 *
 * WRITE NARROW, READ BROAD. Geb writes one canonical form — flat `lat` and `lng` scalars, which
 * stay filterable by Windrose's property filter and by Dataview. It READS the forms the ecosystem
 * already uses, so a vault full of notes authored for Leaflet or Map View works on arrival.
 *
 * THE LIMIT ON BREADTH IS SILENT WRONGNESS, not merely ambiguity. Two cases forced that
 * distinction, both found by review:
 *
 *   - `Number()` is far too generous for a coordinate. It accepts "0x10" as 16, "0b11" as 3 and
 *     "1e1" as 10. A coordinate is a plain decimal; nothing else should parse.
 *   - `location: "51,5"` is a European decimal comma meaning 51.5, and the "exactly two finite
 *     numbers" rule read it as lat 51, lng 5 — a plausible pin in the wrong country, reported as
 *     a success. It cannot be disambiguated, so it is REFUSED and explained.
 *
 * A note with no coordinate keys at all is not a problem; it is simply not a place. But a note
 * that TRIED to be a place and failed is reported, because "why didn't my note appear" is
 * otherwise unanswerable.
 */
import { getCrs, inDomain } from "../core/crs";
import { EARTH } from "../core/crs";
import { FEATURE_KEY, type CoordinateSource, type Feature, type Problem, type ProblemCode } from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** A plain decimal, optionally signed. No hex, no binary, no exponent — none of those is a coordinate. */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

function num(v: unknown): number | null {
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	if (typeof v !== "string") return null;
	const t = v.trim();
	if (!DECIMAL.test(t)) return null;
	const n = Number(t);
	return Number.isFinite(n) ? n : null;
}

/** Was a key present at all, whatever its value? Distinguishes "not a place" from "broken". */
const present = (fm: Record<string, unknown>, k: string): boolean => fm[k] !== undefined && fm[k] !== null;

interface LocationRead {
	readonly pair: { lat: number; lng: number } | null;
	readonly problem: { code: ProblemCode; message: string } | null;
}

/** `location: [lat, lng]` or `location: "lat, lng"` — the Leaflet and Map View convention. */
function readLocation(v: unknown): LocationRead {
	const none: LocationRead = { pair: null, problem: null };

	if (Array.isArray(v)) {
		if (v.length !== 2) {
			return { pair: null, problem: { code: "coords-incomplete", message: `location needs exactly two values, got ${v.length}` } };
		}
		const lat = num(v[0]);
		const lng = num(v[1]);
		if (lat === null || lng === null) {
			return { pair: null, problem: { code: "coords-incomplete", message: "location holds values that are not plain decimals" } };
		}
		return { pair: { lat, lng }, problem: null };
	}

	if (typeof v !== "string") return none;
	const t = v.trim();
	if (t === "") return none;

	const parts = t.split(",");
	if (parts.length !== 2) {
		// Not two comma-separated values at all. "York, England" lands here only if it has one
		// comma, and then fails the decimal test below; three-part strings stop here.
		return parts.length < 2
			? none
			: { pair: null, problem: { code: "coords-incomplete", message: `location needs exactly two values, got ${parts.length}` } };
	}

	const [a, b] = [parts[0]!.trim(), parts[1]!.trim()];
	// The decimal-comma trap: "51,5" is one number to much of Europe and two to this parser.
	// Both halves being bare digits with no sign and no point is exactly that shape.
	if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
		return {
			pair: null,
			problem: {
				code: "coords-ambiguous",
				message: `location "${t}" could be one number with a decimal comma or two coordinates. Write it as a list: location: [${a}, ${b}]`,
			},
		};
	}

	const lat = num(a);
	const lng = num(b);
	if (lat === null || lng === null) return none;
	return { pair: { lat, lng }, problem: null };
}

interface Pair {
	readonly lat: number;
	readonly lng: number;
	readonly source: CoordinateSource;
}

/**
 * Coordinate precedence: Geb's own canonical keys, then the long-form spellings, then `location`.
 *
 * Canonical first because Geb writes those, so when both are present the one Geb maintains wins.
 * An INCOMPLETE canonical pair is reported rather than quietly falling through to `location` —
 * a note with `lat` and a stray `location` used to pin at the location while ignoring the user's
 * own latitude entirely.
 */
function readPair(notePath: string, fm: Record<string, unknown>, problems: Problem[]): Pair | null {
	const add = (code: ProblemCode, message: string): void => {
		problems.push({ notePath, code, message });
	};

	const tryPair = (
		latKey: string,
		lngKeys: readonly string[],
		source: CoordinateSource,
	): Pair | null | "broken" => {
		const anyPresent = present(fm, latKey) || lngKeys.some((k) => present(fm, k));
		if (!anyPresent) return null;
		const lat = num(fm[latKey]);
		let lng: number | null = null;
		for (const k of lngKeys) {
			lng = num(fm[k]);
			if (lng !== null) break;
		}
		if (lat !== null && lng !== null) return { lat, lng, source };
		add(
			"coords-incomplete",
			`${latKey}/${lngKeys.join(" or ")} is present but does not form a pair of plain decimals`,
		);
		return "broken";
	};

	const canonical = tryPair(FEATURE_KEY.lat, [FEATURE_KEY.lng, FEATURE_KEY.long], "lat-lng");
	if (canonical !== null && canonical !== "broken") {
		if (present(fm, FEATURE_KEY.location)) {
			const other = readLocation(fm[FEATURE_KEY.location]);
			if (other.pair !== null && (other.pair.lat !== canonical.lat || other.pair.lng !== canonical.lng)) {
				add("coords-conflict", `lat/lng and location disagree; using lat/lng (${canonical.lat}, ${canonical.lng})`);
			}
		}
		return canonical;
	}
	if (canonical === "broken") return null;

	const longForm = tryPair(FEATURE_KEY.latitude, [FEATURE_KEY.longitude], "latitude-longitude");
	if (longForm !== null && longForm !== "broken") return longForm;
	if (longForm === "broken") return null;

	if (!present(fm, FEATURE_KEY.location)) return null;
	const loc = readLocation(fm[FEATURE_KEY.location]);
	if (loc.problem !== null) add(loc.problem.code, loc.problem.message);
	return loc.pair === null ? null : { ...loc.pair, source: "location" };
}

const CERTAINTIES = ["exact", "approximate", "disputed"] as const;

/** Read a place note's coordinates, or null if it has none (or none usable). */
export function readFeature(notePath: string, fm: unknown, problems: Problem[]): Feature | null {
	if (!isRecord(fm)) return null;
	const add = (code: ProblemCode, message: string): void => {
		problems.push({ notePath, code, message });
	};

	const pair = readPair(notePath, fm, problems);
	if (pair === null) return null;

	const crsId = typeof fm[FEATURE_KEY.crs] === "string" && fm[FEATURE_KEY.crs] !== ""
		? (fm[FEATURE_KEY.crs] as string)
		: EARTH.id;

	// Validated against the CRS registry, not compared to a hardcoded "earth". A misspelled or
	// differently-cased crs used to skip the range check AND match no map, in silence.
	const crs = getCrs(crsId);
	if (crs === null) {
		add("unknown-crs", `crs "${crsId}" is not a known coordinate system, so this note will appear on no map`);
		return null;
	}
	if (!inDomain(crs, pair.lat, pair.lng)) {
		add("coords-out-of-range", `coordinates outside ${crs.name}'s range (lat ${pair.lat}, lng ${pair.lng})`);
		return null;
	}

	const uncertainty = num(fm[FEATURE_KEY.uncertainty]);
	if (present(fm, FEATURE_KEY.uncertainty) && (uncertainty === null || uncertainty < 0)) {
		add("bad-uncertainty", `${FEATURE_KEY.uncertainty} must be a non-negative number; ignoring it`);
	}

	const rawCertainty = fm[FEATURE_KEY.certainty];
	let certainty: Feature["certainty"];
	if (typeof rawCertainty === "string") {
		// Case-insensitive on purpose: "Exact" is what a user types.
		const match = CERTAINTIES.find((c) => c === rawCertainty.trim().toLowerCase());
		if (match === undefined) add("bad-certainty", `${FEATURE_KEY.certainty} should be one of ${CERTAINTIES.join(", ")}`);
		else certainty = match;
	} else if (present(fm, FEATURE_KEY.certainty)) {
		add("bad-certainty", `${FEATURE_KEY.certainty} should be text`);
	}

	// Dates stay raw. Interpreting them belongs to a time adapter, not here.
	const text = (k: string): string | undefined => {
		const v = fm[k];
		if (typeof v === "string" && v.trim() !== "") return v.trim();
		if (typeof v === "number" && Number.isFinite(v)) return String(v);
		return undefined;
	};
	const from = text(FEATURE_KEY.from);
	const to = text(FEATURE_KEY.to);
	const calendar = text(FEATURE_KEY.calendar);

	return {
		notePath,
		lat: pair.lat,
		lng: pair.lng,
		crs: crsId,
		source: pair.source,
		...(uncertainty !== null && uncertainty >= 0 ? { uncertainty } : {}),
		...(certainty === undefined ? {} : { certainty }),
		...(from === undefined ? {} : { from }),
		...(to === undefined ? {} : { to }),
		...(calendar === undefined ? {} : { calendar }),
	};
}
