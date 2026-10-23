/**
 * Coordinate parsing as people write coordinates. Every accepted form is pinned, and every
 * refusal that protects against a confident misread (a sign and a letter together, 60 minutes,
 * a fraction in the middle of a degrees-minutes-seconds value).
 */
import { describe, expect, test } from "bun:test";
import { parseAngle, parsePair } from "../src/view/coords";

const DMS = 51 + 30 / 60 + 26 / 3600;

describe("parseAngle", () => {
	test.each([
		["51.5074", 51.5074, null],
		["-0.1278", -0.1278, null],
		["+51.5", 51.5, null],
		["51,5", 51.5, null],
		[".5", 0.5, null],
		["51.5074° N", 51.5074, "lat"],
		["51.5074°N", 51.5074, "lat"],
		["0.1278° W", -0.1278, "lng"],
		["N 51.5", 51.5, "lat"],
		["w0.1278", -0.1278, "lng"],
		["s 33.9", -33.9, "lat"],
		["51°30'26\"N", DMS, "lat"],
		["51° 30' 26\" N", DMS, "lat"],
		["51 30 26 N", DMS, "lat"],
		["51d30m26s", DMS, null],
		["N51d30m26s", DMS, "lat"],
		["51°30′26″", DMS, null],
		["51°30’26”", DMS, null],
		["51°30'", 51.5, null],
		["51 30", 51.5, null],
		["0°7'39\"W", -(7 / 60 + 39 / 3600), "lng"],
		["51°30'26.5\"", 51 + 30 / 60 + 26.5 / 3600, null],
		["51°30,5'", 51 + 30.5 / 60, null],
		["51°30'26''", DMS, null],
	])("reads %s", (text, value, axis) => {
		const got = parseAngle(text);
		expect(got).not.toBeNull();
		expect(got!.value).toBeCloseTo(value, 9);
		expect(got!.axis).toBe(axis as "lat" | "lng" | null);
	});

	test.each([
		"",
		"   ",
		"abc",
		"N",
		"-51.5 N",
		"N -51.5",
		"N51.5S",
		"51°60'",
		"51°30'60\"",
		"51.5° 30'",
		"51 .5",
		"51.5.1",
		"51°30'26\"N extra",
		"--51",
		// Letter units make a trailing S a seconds mark, so this cannot mean South and is refused.
		"51d 30m S",
		// A bare minute or second mark must not backtrack into "1 degree 2 minutes" (review probe).
		"12'",
		"45'",
		"1234'",
		"12\"",
		// Seconds without minutes, and marks in the wrong position.
		"51 30\"",
		"51°30\"",
		"51M",
		"10m",
		"12m34s",
	])("refuses %s", (text) => {
		expect(parseAngle(text)).toBeNull();
	});

	test("never yields negative zero", () => {
		expect(Object.is(parseAngle("-0")!.value, 0)).toBe(true);
		expect(Object.is(parseAngle("0 S")!.value, 0)).toBe(true);
	});
});

describe("parsePair", () => {
	const LONDON = { lat: 51.5074, lng: -0.1278 };
	test.each([
		["51.5074, -0.1278"],
		["51.5074 -0.1278"],
		["51.5074;-0.1278"],
		["51.5074° N, 0.1278° W"],
		["51.5074°N 0.1278°W"],
		["0.1278° W, 51.5074° N"],
		["  51.5074 ,  -0.1278  "],
	])("reads %s as London", (text) => {
		const got = parsePair(text);
		expect(got).not.toBeNull();
		expect(got!.lat).toBeCloseTo(LONDON.lat, 9);
		expect(got!.lng).toBeCloseTo(LONDON.lng, 9);
	});

	test("reads a degrees-minutes-seconds pair with spaces inside each half", () => {
		const got = parsePair("51 30 26 N 0 7 39 W");
		expect(got!.lat).toBeCloseTo(DMS, 9);
		expect(got!.lng).toBeCloseTo(-(7 / 60 + 39 / 3600), 9);
		const marked = parsePair("51°30'26\"N 0°7'39\"W");
		expect(marked).toEqual(got);
	});

	test("a decimal comma with no space is one number, not a pair", () => {
		expect(parsePair("51,5")).toBeNull();
		expect(parsePair("51,5, -0,1")).toEqual({ lat: 51.5, lng: -0.1 });
	});

	test.each(["51.5074", "", "51.5 N 0.1 N", "0.1 E 0.2 W", "51.5, abc"])("refuses %s", (text) => {
		expect(parsePair(text)).toBeNull();
	});

	// Two reviewers' probes: a single spaced-out angle, or a run of bare numbers, is never split
	// into a pair. Each of these used to come back as a confident wrong point.
	test.each(["51 30 26 N", "51 30 26", "51 30", "51 3", "12 34 56", "1 2 3", "51 30 0 7", "1 2 3 4", "10 20 30"])(
		"never splits %s",
		(text) => {
			expect(parsePair(text)).toBeNull();
		},
	);

	test("still splits a spaced pair whose halves are bounded by marks or letters", () => {
		expect(parsePair("51°30' 0°7'")).toEqual({ lat: 51.5, lng: 7 / 60 });
		expect(parsePair("51 30 N 0 7 W")!.lat).toBeCloseTo(51.5, 9);
		expect(parsePair("51 -0.1")).toEqual({ lat: 51, lng: -0.1 });
	});
});
