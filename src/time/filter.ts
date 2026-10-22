/**
 * The time filter: is a dated thing present at an instant on the shared line?
 *
 * MISSING BOUNDS ARE EXPLICIT. An absent `from` is negative infinity, an absent `to` is positive
 * infinity, and a feature with neither is always present. Filtering is `from <= at && at <= to`,
 * inclusive at both ends. `from` is the FIRST day its text names and `to` the LAST, so a span
 * written as years, `from: 71, to: 866`, runs from 71-01-01 through 866-12-31.
 *
 * A BOUND THAT CANNOT BE READ DOES NOT HIDE THE FEATURE. If the calendar has no adapter, the text
 * is not a date under it, or the adapter throws or answers with something off the line, that
 * side is treated as unbounded and the reason is REPORTED — the same rule as a missing bound,
 * plus a problem. A pin vanishing because of a typo in a date field, with nothing saying so, is
 * the silence this plugin forbids; a pin that shows at every instant with a problem beside it is
 * at least visible, and the problem names the note.
 *
 * THE ONE EXCEPTION is a span that reads cleanly and is empty — `from` after `to`. Both bounds
 * were understood, and what they say is "never"; that is honoured, and reported, because it is
 * almost certainly a slip.
 */
import { tryParse, type TimeAdapter } from "./adapters";

/** The date fields as a feature carries them: raw text, and which adapter should read it. */
export interface Dated {
	readonly from?: string;
	readonly to?: string;
	readonly calendar?: string;
}

/** A feature's presence on the line, and why it could not be read fully if it could not. */
export interface Span {
	readonly from: number;
	readonly to: number;
	/** Null when both bounds (or their absence) were read cleanly. */
	readonly problem: string | null;
}

/** The registry's lookup: `undefined` is the default adapter; an unknown id is null. */
export type ResolveAdapter = (calendar: string | undefined) => TimeAdapter | null;

export function span(d: Dated, resolve: ResolveAdapter): Span {
	const adapter = resolve(d.calendar);
	if (adapter === null) {
		return { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY, problem: `no time adapter is registered for calendar "${d.calendar ?? ""}"` };
	}
	const problems: string[] = [];
	const read = (text: string | undefined, key: string, absent: number, end: boolean): number => {
		if (text === undefined) return absent;
		const got = tryParse(adapter, text, end);
		if (got.day === null) {
			problems.push(got.fault ?? `${key} "${text}" is not a date under calendar "${adapter.id}"`);
			return absent;
		}
		return got.day;
	};
	const from = read(d.from, "geb-from", Number.NEGATIVE_INFINITY, false);
	const to = read(d.to, "geb-to", Number.POSITIVE_INFINITY, true);
	if (from > to) problems.push(`geb-from "${d.from ?? ""}" is after geb-to "${d.to ?? ""}", so no instant falls inside`);
	return { from, to, problem: problems.length === 0 ? null : problems.join("; ") };
}

/** Inclusive at both ends. */
export function presentAt(d: Dated, at: number, resolve: ResolveAdapter): boolean {
	const s = span(d, resolve);
	return s.from <= at && at <= s.to;
}
