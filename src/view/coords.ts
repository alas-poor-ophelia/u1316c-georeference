/**
 * Reading a coordinate the way people actually write them.
 *
 * A user arrives with a coordinate copied from Wikipedia, a gazetteer, a GPS app or a paper
 * atlas, and those four sources spell the same place four ways: `51.5074`, `51.5074° N`,
 * `51°30'26"N`, `51 30 26 N`. The point dialog used to accept the first form only and reject the
 * rest with "must be numbers, in decimal degrees", which made the user do the arithmetic. This
 * module reads all four, plus a pasted pair, and returns a plain number.
 *
 * Pure and dependency-free, so every form is pinned by a test rather than by hope.
 */

export type Axis = "lat" | "lng";

export interface ParsedAngle {
	/** Signed decimal degrees. */
	readonly value: number;
	/** The axis a hemisphere letter implies, or null when the text carried no letter. */
	readonly axis: Axis | null;
}

/** Degree, minute and second marks as they come off keyboards and out of copied web pages. */
const DEG = "°º˚";
const MIN = "'′’‘";
const SEC = "\"″”“";

const HEMISPHERE: Readonly<Record<string, { readonly sign: 1 | -1; readonly axis: Axis }>> = {
	N: { sign: 1, axis: "lat" },
	S: { sign: -1, axis: "lat" },
	E: { sign: 1, axis: "lng" },
	W: { sign: -1, axis: "lng" },
};

/**
 * One angle. Accepts decimal degrees (dot or comma), an optional sign, an optional hemisphere
 * letter before or after, and degrees-minutes-seconds with marks or with spaces. Returns null
 * for anything it cannot read with confidence — a sign AND a hemisphere letter together, minutes
 * or seconds of 60 or more, two letters, trailing junk.
 */
export function parseAngle(input: string): ParsedAngle | null {
	let text = input.trim().toUpperCase();
	if (text === "") return null;

	// A hemisphere letter at either end, at most one. In the letter form "51d30m26s" the trailing
	// S is a seconds mark, not South: when degree or minute LETTERS are present, the end letter
	// is read as a unit and never as a hemisphere.
	let hemi: { sign: 1 | -1; axis: Axis } | null = null;
	const letterUnits = /\d\s*[DM]/.test(text);
	const lead = /^([NSEW])\s*/.exec(text);
	const trail = letterUnits ? null : /\s*([NSEW])$/.exec(text);
	if (lead !== null && trail !== null) return null;
	const letter = lead?.[1] ?? trail?.[1];
	if (letter !== undefined) {
		hemi = HEMISPHERE[letter]!;
		text = lead !== null ? text.slice(lead[0].length) : text.slice(0, text.length - trail![0].length);
	}

	// An explicit sign.
	let sign: 1 | -1 = 1;
	if (text.startsWith("-") || text.startsWith("+")) {
		if (hemi !== null) return null;
		sign = text.startsWith("-") ? -1 : 1;
		text = text.slice(1).trimStart();
	}
	if (text === "") return null;

	const magnitude = parseMagnitude(text);
	if (magnitude === null) return null;
	const value = sign * (hemi?.sign ?? 1) * magnitude;
	return { value: value === 0 ? 0 : value, axis: hemi?.axis ?? null };
}

/** An unsigned angle: plain decimal, or degrees with optional minutes and seconds. */
function parseMagnitude(text: string): number | null {
	// Plain decimal degrees, dot or comma. The common case, taken first so "51,5" is never
	// mistaken for a degrees-minutes pair.
	const plain = /^(\d+(?:[.,]\d*)?|[.,]\d+)$/.exec(text);
	if (plain !== null) return Number(plain[1]!.replace(",", "."));

	// Degrees-minutes-seconds. Each part may carry its mark or be separated by whitespace; only
	// the LAST part may be fractional, as the notation is written. Each position accepts only its
	// OWN mark or letter, so "51M" is not fifty-one degrees; two apostrophes are a seconds mark;
	// seconds need minutes before them. The lookahead after each number stops the engine from
	// backtracking "12'" into one degree and two minutes — a reviewer's probe, not a guess.
	const part = (marks: string): string => `(\\d+(?:[.,]\\d+)?)(?!\\d)\\s*(?:${marks})?\\s*`;
	const dms = new RegExp(`^${part(`[${DEG}D]`)}(?:${part(`[${MIN}M]`)}(?:${part(`''|[${SEC}S]`)})?)?$`);
	const m = dms.exec(text);
	if (m === null) return null;
	const parts = [m[1], m[2], m[3]].filter((p): p is string => p !== undefined).map((p) => Number(p.replace(",", ".")));
	if (parts.some((n) => !Number.isFinite(n))) return null;
	// A fraction is allowed only on the last part given: "51.5° 30'" is not a coordinate.
	for (let i = 0; i < parts.length - 1; i++) if (!Number.isInteger(parts[i])) return null;
	if (parts.slice(1).some((n) => n >= 60)) return null;
	return parts.reduce((acc, n, i) => acc + n / 60 ** i, 0);
}

/**
 * A pasted pair: "51.5074, -0.1278", "51.5074 -0.1278", "51°30'26\"N 0°7'39\"W",
 * "51.5074° N, 0.1278° W". The first angle is taken as latitude unless its hemisphere letters say
 * otherwise, in which case the pair is swapped. Returns null for a single angle or anything the
 * two halves cannot both read; a plain "51,5" with no space is ONE decimal-comma number, not two.
 */
export function parsePair(input: string): { readonly lat: number; readonly lng: number } | null {
	const text = input.trim();
	if (text === "") return null;
	// ONE angle is never a pair. "51 30 26 N" is a degrees-minutes-seconds latitude, and splitting
	// it at a space would read it as 51 and 30°26' — a wrong point saved with no error, which a
	// reviewer caught before a user did. Whatever `parseAngle` can read whole, this leaves alone.
	if (parseAngle(text) !== null) return null;

	const candidates: [string, string][] = [];
	const semicolon = text.indexOf(";");
	if (semicolon > 0) candidates.push([text.slice(0, semicolon), text.slice(semicolon + 1)]);
	// A comma followed by whitespace, or a comma between two angles that each contain a dot or
	// a mark — never the comma of "51,5".
	for (const m of text.matchAll(/,/g)) {
		const i = m.index;
		const left = text.slice(0, i);
		const right = text.slice(i + 1);
		if (/\s/.test(right.charAt(0)) || /[.°º˚'′"″NSEW]/i.test(left + right.replace(/^\s+/, ""))) candidates.push([left, right]);
	}
	// Whitespace between two angles. A half may itself contain spaces only when it carries a mark
	// or a hemisphere letter to say where it ends ("51 30 26 N 0 7 39 W"); a run of bare numbers
	// such as "51 30 0 7" has no honest split and is refused rather than guessed.
	const bounded = (half: string): boolean => !/\s/.test(half.trim()) || /[°º˚'′’‘"″”“NSEW]/i.test(half);
	for (const m of text.matchAll(/\s+/g)) {
		const left = text.slice(0, m.index);
		const right = text.slice(m.index + m[0].length);
		if (bounded(left) && bounded(right)) candidates.push([left, right]);
	}

	for (const [a, b] of candidates) {
		const first = parseAngle(a);
		const second = parseAngle(b);
		if (first === null || second === null) continue;
		if (first.axis === "lng" || second.axis === "lat") {
			if (first.axis === "lat" || second.axis === "lng") continue;
			return { lat: second.value, lng: first.value };
		}
		return { lat: first.value, lng: second.value };
	}
	return null;
}
