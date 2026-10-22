/**
 * The shared time line: WHOLE DAYS, day 0 = 1970-01-01 in the proleptic Gregorian calendar — the
 * same scalar Seshat uses for its calendars (a "Unix day"), bounded to ±10,000,000 as Seshat
 * bounds it. Every time adapter maps onto THIS line; none defines its own number line, which is
 * what makes a date under one calendar comparable with a date under another at all.
 *
 * RE-DERIVED, NOT IMPORTED. Seshat exports neither its epoch nor a civil-date conversion — its
 * Gregorian calendar is data for an engine, not a function. The arithmetic here is Howard
 * Hinnant's `days_from_civil` / `civil_from_days`, exact for every proleptic Gregorian date, and
 * the tests pin it against an INDEPENDENT formulation (`Date.UTC`, which is also proleptic
 * Gregorian) across thousands of dates, and against the one constant Seshat does publish:
 * 0000-01-01 is day -719528.
 *
 * YEARS ARE ASTRONOMICAL: year 0 exists and is 1 BC, -1 is 2 BC. That is Seshat's convention and
 * ISO 8601's, and it is what makes a plain signed integer in frontmatter mean one thing.
 */

/** The same bound Seshat applies: about ±27,000 years. Beyond it a day is refused, not clamped. */
export const DAY_LIMIT = 10_000_000;

/** A value on the line: a safe integer within the bound. */
export function isDay(n: unknown): n is number {
	return typeof n === "number" && Number.isSafeInteger(n) && Math.abs(n) <= DAY_LIMIT;
}

/** The day of a proleptic Gregorian date. Month 1..12, day 1..31; not validated for calendar sense. */
export function daysFromCivil(year: number, month: number, day: number): number {
	const y = month <= 2 ? year - 1 : year;
	const era = Math.floor(y / 400);
	const yoe = y - era * 400;
	const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
	return era * 146097 + doe - 719468;
}

/** The proleptic Gregorian date of a day on the line. The inverse of `daysFromCivil`. */
export function civilFromDays(dayOnLine: number): { readonly year: number; readonly month: number; readonly day: number } {
	const z = dayOnLine + 719468;
	const era = Math.floor(z / 146097);
	const doe = z - era * 146097;
	const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
	const y = yoe + era * 400;
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
	const mp = Math.floor((5 * doy + 2) / 153);
	const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
	const month = mp + (mp < 10 ? 3 : -9);
	return { year: y + (month <= 2 ? 1 : 0), month, day };
}
