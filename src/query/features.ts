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

/**
 * A DISTANCE, which is not a coordinate: exponent notation is allowed here.
 *
 * `geb-uncertainty: 1e3` is an ordinary way to write a thousand metres. `DECIMAL` forbids
 * exponents because a latitude is never written `1e1`, and reusing the coordinate parser for a
 * radius imported a rule that only ever made sense for coordinates.
 */
const DISTANCE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function distance(v: unknown): number | null {
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	if (typeof v !== "string") return null;
	const t = v.trim();
	if (!DISTANCE.test(t)) return null;
	const n = Number(t);
	return Number.isFinite(n) ? n : null;
}

/** Minus signs that are not ASCII hyphen: the form a Wikipedia coordinate pastes as. */
const UNICODE_MINUS = /[−–—]/g;
/** Degree and minute marks, and the whitespace between a number and its hemisphere letter. */
const DECORATION = /[°'"′″\s]+/g;
/** A leading or trailing compass letter: the "N" of `N 51.5` and the "W" of `0.1° W`. */
const HEMISPHERE = /^[NSEWnsew]|[NSEWnsew]$/g;

/**
 * Did this part TRY to be a coordinate, even if it did not finish like one?
 *
 * This is the whole difference between a problem worth raising and noise, and it has now been
 * wrong in three different ways:
 *
 *   - "does it parse" reported `location: "York, England, UK"` while `"51.5, abc"` vanished.
 *   - "does it START with a digit" fixed that and broke addresses: `"221B Baker Street"` and
 *     `"2026-10-19"` became problems. Those are the commonest non-coordinate `location` text
 *     there is, so it manufactured exactly the noise it was meant to remove.
 *
 * So: it tried if it IS a plain decimal, or becomes one once degree marks and a hemisphere letter
 * come off. "51.5° N" and "N 51.5" tried; "221B Baker Street", "Jan 5" and "3 miles north" did
 * not. Stripping the decoration is only used to RECOGNISE an attempt — reading those forms is a
 * feature, not a repair, so they are still reported rather than parsed.
 */
const triedToBeCoordinate = (part: unknown): boolean => {
	// Any number is an attempt, finite or not: a non-finite one then fails `num` and is REPORTED,
	// which is the point. Testing finiteness here would make it vanish instead.
	if (typeof part === "number") return true;
	if (typeof part !== "string") return false;
	// The unicode minus is normalised for RECOGNITION ONLY — `num` still refuses it, so
	// `"−33.9, −70.6"` pasted from Wikipedia is reported rather than silently dropped. Stripping
	// it would turn a negative latitude into a positive one, which is far worse than not reading it.
	return DECIMAL.test(part.replace(UNICODE_MINUS, "-").replace(DECORATION, "").replace(HEMISPHERE, ""));
};

/**
 * The decimal-comma shape: an optionally-signed integer, a comma, then BARE digits, with NO
 * space anywhere near the comma.
 *
 * The space is the whole signal. A European decimal comma is never written `51, 5` — the digits
 * close up against it — so `"45, 90"` and `"0, 0"` are two coordinates beyond reasonable doubt
 * and used to be refused as ambiguous. Null Island written out longhand was rejected.
 */
const AMBIGUOUS = /^[+-]?\d+,\d+$/;

/**
 * Was a key present with SOMETHING in it? Distinguishes "not a place" from "broken".
 *
 * A blank value does not count. YAML reads a bare `lat:` as null and `lat: ""` as an empty
 * string, and to a user those are the same thing — a key left blank, usually by a template.
 * Counting the empty string as present reported `coords-incomplete` on every such note while the
 * bare form stayed silent: the same input, two different answers.
 */
const present = (fm: Record<string, unknown>, k: string): boolean => {
	const v = fm[k];
	if (v === undefined || v === null) return false;
	return !(typeof v === "string" && v.trim() === "");
};

interface LocationRead {
	readonly pair: { lat: number; lng: number } | null;
	readonly problem: { code: ProblemCode; message: string } | null;
}

/**
 * `location: [lat, lng]` or `location: "lat, lng"` — the Leaflet and Map View convention.
 *
 * Three gates, in order: did any part TRY to be a coordinate, are there exactly two parts, and is
 * the string the ambiguous decimal-comma shape. The FIRST is the one that decides whether a
 * malformed value is reported or ignored at all. Nothing that tried means this was never a
 * coordinate, and a problem raised against `location: "York, England, UK"` only teaches the user
 * to ignore the problem list. Something that tried and does not resolve is a note that tried to
 * be a place and failed — the case that is unanswerable if it stays silent. That gate has been
 * wrong in both directions: prose was reported while `"51.5, abc"` vanished.
 */
function readLocation(v: unknown): LocationRead {
	const none: LocationRead = { pair: null, problem: null };
	const incomplete = (message: string): LocationRead => ({ pair: null, problem: { code: "coords-incomplete", message } });

	const isString = typeof v === "string";
	const parts: unknown[] = Array.isArray(v) ? v : isString && v.trim() !== "" ? v.trim().split(",") : [];
	if (parts.length === 0) return none;

	// A PAIR NEEDS A SEPARATOR, so a lone token is a postal code, a year or a date — never half a
	// coordinate. `"90210"` and `"1066"` were reported as "needs exactly two values, got 1", and a
	// bare number is far likelier to be either of those than a latitude someone forgot to finish.
	// An ARRAY is exempt: `location: [1]` is a malformed list, which is a structural mistake.
	if (isString && parts.length < 2) return none;

	// A COORDINATE PAIR LEADS WITH ITS LATITUDE. Asking whether ANY part tried to be a number
	// reported every city-plus-postcode there is — `"Paris, 75001"`, `"Boston, 02108"`,
	// `"June 5, 2026"` — because their SECOND half is a bare number while their first is a word.
	// Only the first half decides, which separates those from `"51.5, abc"` cleanly.
	if (!triedToBeCoordinate(typeof parts[0] === "string" ? parts[0].trim() : parts[0])) return none;

	if (parts.length !== 2) return incomplete(`location needs exactly two values, got ${parts.length}`);

	// The decimal-comma trap: "51,5" is one number to much of Europe and two to this parser. Only
	// the FIRST half may carry a sign — a second sign is not one number — and testing both halves
	// for bare digits let "-0,1" through. That is London's longitude written the European way,
	// read as lat -0 lng 1: a plausible pin in the Gulf of Guinea, reported as a success.
	if (isString && AMBIGUOUS.test(v.trim())) {
		const [a, b] = [String(parts[0]).trim(), String(parts[1]).trim()];
		return {
			pair: null,
			problem: {
				code: "coords-ambiguous",
				message: `location "${v.trim()}" could be one number with a decimal comma or two coordinates. Write it as a list: location: [${a}, ${b}]`,
			},
		};
	}

	const lat = num(typeof parts[0] === "string" ? parts[0].trim() : parts[0]);
	const lng = num(typeof parts[1] === "string" ? parts[1].trim() : parts[1]);
	if (lat === null || lng === null) return incomplete("location holds a value that is not a plain decimal");
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
 *
 * A disagreement is reported against EVERY lower-precedence form, not only `location`. `lat/lng`
 * versus `latitude/longitude` used to let the canonical pair win in silence, discarding a value
 * the user had typed with no way for them to learn it had been discarded.
 */
function readPair(notePath: string, fm: Record<string, unknown>, problems: Problem[]): Pair | null {
	const add = (code: ProblemCode, message: string): void => {
		problems.push({ notePath, code, message });
	};
	type Coords = Omit<Pair, "source">;

	/**
	 * Read a pair with NO reporting — for weighing a losing form against the winner.
	 *
	 * The first-readable search over `lngKeys` is currently unreachable: only `lat-lng` has more
	 * than one longitude spelling, and it holds the highest precedence, so it is never a LOSER.
	 * Kept for symmetry with `tryPair` rather than specialised to one key, but a mutation to it
	 * cannot be caught, which is why no test claims to.
	 */
	const peek = (latKey: string, lngKeys: readonly string[]): Coords | null => {
		const lat = num(fm[latKey]);
		const lng = lngKeys.map((k) => num(fm[k])).find((n) => n !== null) ?? null;
		return lat === null || lng === null ? null : { lat, lng };
	};

	const FORMS = [
		{ source: "lat-lng" as const, label: "lat/lng", latKey: FEATURE_KEY.lat, lngKeys: [FEATURE_KEY.lng, FEATURE_KEY.long] },
		{ source: "latitude-longitude" as const, label: "latitude/longitude", latKey: FEATURE_KEY.latitude, lngKeys: [FEATURE_KEY.longitude] },
	];

	/**
	 * Every form BELOW the winner, weighed against it.
	 *
	 * A losing form that reads cleanly and disagrees is a conflict. A losing form that was there
	 * and does NOT read is also worth saying, because it was discarded unseen — the same silent
	 * discard the rescued-longitude rule below exists to prevent. For `location` the verdict comes
	 * from `readLocation` itself rather than a second rule invented here, so prose that was never
	 * a coordinate stays silent in a losing position exactly as it does in a winning one.
	 */
	const reportConflicts = (won: Pair, label: string, index: number): void => {
		type Other = {
			readonly label: string;
			readonly pair: Coords | null;
			readonly problem: { readonly code: ProblemCode; readonly message: string } | null;
		};
		const others: Other[] = [];
		for (let i = index + 1; i < FORMS.length; i++) {
			const f = FORMS[i]!;
			const anyPresent = present(fm, f.latKey) || f.lngKeys.some((k) => present(fm, k));
			const pair = peek(f.latKey, f.lngKeys);
			others.push({
				label: f.label,
				pair,
				problem:
					anyPresent && pair === null
						? { code: "coords-incomplete", message: `${f.label} is present but does not read as a pair; using ${label}` }
						: null,
			});
		}
		const loc = present(fm, FEATURE_KEY.location) ? readLocation(fm[FEATURE_KEY.location]) : null;
		others.push({
			label: "location",
			pair: loc?.pair ?? null,
			problem: loc?.problem == null ? null : { code: loc.problem.code, message: `${loc.problem.message} (using ${label})` },
		});

		for (const o of others) {
			if (o.problem !== null) add(o.problem.code, o.problem.message);
			else if (o.pair !== null && (o.pair.lat !== won.lat || o.pair.lng !== won.lng)) {
				add("coords-conflict", `${o.label} and ${label} disagree; using ${label} (${won.lat}, ${won.lng})`);
			}
		}
	};

	const tryPair = (
		latKey: string,
		lngKeys: readonly string[],
		source: CoordinateSource,
	): Pair | null | "broken" => {
		const anyPresent = present(fm, latKey) || lngKeys.some((k) => present(fm, k));
		if (!anyPresent) return null;

		const lat = num(fm[latKey]);
		const read = lngKeys.map((k) => ({ key: k, value: num(fm[k]) }));
		const chosen = read.find((r) => r.value !== null);
		if (lat === null || chosen === undefined || chosen.value === null) {
			add(
				"coords-incomplete",
				`${latKey}/${lngKeys.join(" or ")} is present but does not form a pair of plain decimals`,
			);
			return "broken";
		}

		// A longitude spelling that was present but unreadable, rescued by a later one, used to
		// resolve in silence: `{lng: "abc", long: 5}` gave 5 with no sign that `lng` was broken.
		for (const r of read) {
			if (r.key === chosen.key) continue;
			if (r.value === null) {
				if (present(fm, r.key)) add("coords-incomplete", `${r.key} is not a plain decimal; using ${chosen.key}`);
			} else if (r.value !== chosen.value) {
				add("coords-conflict", `${r.key} and ${chosen.key} disagree; using ${chosen.key} (${chosen.value})`);
			}
		}
		return { lat, lng: chosen.value, source };
	};

	for (let i = 0; i < FORMS.length; i++) {
		const f = FORMS[i]!;
		const got = tryPair(f.latKey, f.lngKeys, f.source);
		if (got === "broken") return null;
		if (got !== null) {
			reportConflicts(got, f.label, i);
			return got;
		}
	}

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

	const rawCrs = fm[FEATURE_KEY.crs];
	// TRIMMED, and blank-after-trim falls back to earth. `present` already counts `crs: " "` as a
	// blank key, but this line only compared against `""`, so `" "` became the crs id, failed the
	// registry lookup and dropped the note entirely — while `crs: ""` kept its pin. One blank
	// value, two answers, again. A trailing space on a CORRECT value lost the pin too.
	const crsText = typeof rawCrs === "string" ? rawCrs.trim() : "";
	const crsId = crsText !== "" ? crsText : EARTH.id;
	// A `crs` that is present but not usable TEXT defaulted to earth in silence, while the
	// georeference side reported the same mistake. `crs: 5` and `crs: ["faerun"]` reached here.
	//
	// `present` rather than `!== undefined`, so a blank key agrees with blank `lat` and `lng`: a
	// template leaving `crs:` empty is not making a mistake. The georeference side still reports
	// its blank `geb-crs`, and that asymmetry is deliberate — `geb-crs` is a key GEB writes, so a
	// blank one is a damaged record, where `crs` is the user's own optional annotation.
	if (present(fm, FEATURE_KEY.crs) && typeof rawCrs !== "string") {
		add("unknown-crs", `${FEATURE_KEY.crs} is not text; assuming ${EARTH.name}`);
	}

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

	// `distance`, not `num`: a radius is not a coordinate, and `1e3` metres is a normal thing to
	// write. The coordinate parser's ban on exponents was right for latitudes and wrong here.
	const uncertainty = distance(fm[FEATURE_KEY.uncertainty]);
	if (present(fm, FEATURE_KEY.uncertainty) && (uncertainty === null || uncertainty < 0)) {
		add("bad-uncertainty", `${FEATURE_KEY.uncertainty} must be a non-negative number; ignoring it`);
	}

	// The `present` gate comes FIRST so a blank key is simply absent. The string branch used to
	// run ahead of it, so `geb-certainty: ""` was reported while `geb-certainty:` and a blank
	// `geb-uncertainty` were silent — one blank value, two different answers.
	let certainty: Feature["certainty"];
	if (present(fm, FEATURE_KEY.certainty)) {
		const rawCertainty = fm[FEATURE_KEY.certainty];
		if (typeof rawCertainty !== "string") {
			add("bad-certainty", `${FEATURE_KEY.certainty} should be text`);
		} else {
			// Case-insensitive on purpose: "Exact" is what a user types.
			const match = CERTAINTIES.find((c) => c === rawCertainty.trim().toLowerCase());
			if (match === undefined) add("bad-certainty", `${FEATURE_KEY.certainty} should be one of ${CERTAINTIES.join(", ")}`);
			else certainty = match;
		}
	}

	// Dates stay raw. Interpreting them belongs to a time adapter, not here.
	// Present-but-unusable is REPORTED, like every neighbouring field. A `geb-from: [1066]` used to
	// vanish in silence while a non-text `geb-certainty` and a bad `geb-uncertainty` both said so.
	// Blank still means absent, which agrees with `present`.
	const text = (k: string): string | undefined => {
		const raw = fm[k];
		if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
		if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
		if (present(fm, k)) add("bad-text", `${k} must be text or a number; ignoring it`);
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
