/**
 * Time adapters: how date TEXT becomes a day on the shared line, and back.
 *
 * Frontmatter stores text plus an optional calendar id, never a pre-parsed scalar — so a note
 * reads as its author wrote it, and a Dataview user can still filter numerically under the
 * default adapter, where the text is a plain signed year. Deciding what "450" means is the
 * adapter's job and nobody else's; the core treats time as an opaque comparable scalar.
 *
 * An adapter owns `parse`, `format` and optionally `last`. It does NOT own a number line: every
 * result is a day on the one line in line.ts. A consumer registering a Julian, Islamic or
 * invented calendar maps it onto that line, and then a date under theirs compares with a date
 * under ours.
 *
 * CONSUMER CODE IS NOT TRUSTED. An adapter may throw, return a fraction, return a day past the
 * line, or return something that is not a number at all; `tryParse` turns every one of those
 * into a reason, so a broken adapter degrades one feature's bounds and never the query surface.
 */
import { civilFromDays, daysFromCivil, isDay } from "./line";

/** What a consumer registers. *(API 1)* */
export interface TimeAdapter {
	/** Namespaced, e.g. `"myplugin:julian"`. The built-in is `"gregorian"`. No whitespace. */
	readonly id: string;
	/** For a settings list or a picker. */
	readonly name: string;
	/** Text to a whole day on the shared line — the FIRST day the text names — or null when the text is not a date under this calendar. */
	parse(text: string): number | null;
	/**
	 * The LAST day the text names, for text that names a span: a year, a month, a reign. Used for
	 * `geb-to`, so `to: 866` means through the end of 866. Optional; without it a `to` bound ends
	 * on the same day `parse` gives, which is right for text that names a single day.
	 */
	last?(text: string): number | null;
	/** A day on the shared line to text under this calendar. */
	format(day: number): string;
}

/** An adapter as listed: no functions, so it can be handed out frozen. *(API 1)* */
export interface TimeAdapterInfo {
	readonly id: string;
	readonly name: string;
}

/**
 * The default: a plain signed YEAR, astronomical numbering. `parse` gives the year's first day
 * and `last` its last, so `from: 71, to: 866` spans 71-01-01 through 866-12-31 — what a historian
 * who writes years means. A year, not a date, because that is what gets typed, and because a
 * plain integer stays numerically filterable in Dataview.
 */
export const GREGORIAN_YEAR: TimeAdapter = {
	id: "gregorian",
	name: "Gregorian year",
	parse(text: string): number | null {
		const year = yearOf(text);
		if (year === null) return null;
		const day = daysFromCivil(year, 1, 1);
		return isDay(day) ? day : null;
	},
	last(text: string): number | null {
		const year = yearOf(text);
		if (year === null) return null;
		const day = daysFromCivil(year + 1, 1, 1) - 1;
		return isDay(day) ? day : null;
	},
	format(day: number): string {
		return String(civilFromDays(day).year);
	},
};

/** ASCII digits only, optionally signed, up to six of them: "450", "-752", "+1066". */
function yearOf(text: string): number | null {
	const m = /^\s*([-+]?\d{1,6})\s*$/.exec(text);
	return m === null ? null : Number(m[1]);
}

/** What `tryParse` found: a day, or why there is none. Exactly one of the two is set. */
export interface Parsed {
	readonly day: number | null;
	/** Null when the text simply is not a date under the adapter (that is a normal answer). */
	readonly fault: string | null;
}

/**
 * Ask an adapter for a day without trusting it. `end` asks for the last day the text names,
 * falling back to the first when the adapter has no `last`.
 */
export function tryParse(adapter: TimeAdapter, text: string, end: boolean): Parsed {
	let raw: unknown;
	try {
		raw = end && adapter.last !== undefined ? adapter.last(text) : adapter.parse(text);
	} catch (e) {
		return { day: null, fault: `adapter "${adapter.id}" threw: ${e instanceof Error ? e.message : String(e)}` };
	}
	if (raw === null || raw === undefined) return { day: null, fault: null };
	if (!isDay(raw)) {
		const shown = typeof raw === "number" || typeof raw === "string" || typeof raw === "boolean" ? String(raw) : `a ${typeof raw}`;
		return { day: null, fault: `adapter "${adapter.id}" returned ${shown}, which is not a whole day on the shared line` };
	}
	return { day: raw, fault: null };
}

/** The shape check a registration must pass. Exported so the API can name what was wrong. */
export function adapterProblem(a: unknown): string | null {
	if (a === null || typeof a !== "object") return "an adapter is an object with id, name, parse and format";
	const o = a as Partial<Record<keyof TimeAdapter, unknown>>;
	if (typeof o.id !== "string" || o.id.trim() === "" || /\s/.test(o.id)) return "an adapter id is a non-empty string with no whitespace";
	if (typeof o.name !== "string" || o.name.trim() === "") return "an adapter needs a name";
	if (typeof o.parse !== "function") return "an adapter needs a parse(text) function";
	if (typeof o.format !== "function") return "an adapter needs a format(day) function";
	if (o.last !== undefined && typeof o.last !== "function") return "an adapter's last, if present, is a last(text) function";
	return null;
}
