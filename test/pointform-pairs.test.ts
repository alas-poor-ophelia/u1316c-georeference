/**
 * The point form must never turn a single spaced-out angle in the latitude field into a pair.
 * Two reviewers found "51 30 26 N" with a blank longitude saving as latitude 51, longitude 30.43;
 * the right answer is a longitude error, because the user has not given one.
 */
import { describe, expect, test } from "bun:test";
import { COPY } from "../src/view/copy";
import { readPointForm } from "../src/view/pointform";

const fields = (lat: string, lng: string) => ({ px: "10", py: "20", lat, lng, label: "" });

describe("readPointForm and spaced angles", () => {
	test.each(["51 30 26 N", "51 30", "12 34 56", "51 30 0 7"])("%s with a blank longitude is a missing longitude, not a pair", (lat) => {
		const r = readPointForm(fields(lat, ""), null);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe(COPY.coords.unreadable);
	});

	test("a spaced DMS latitude with a longitude given reads as one angle", () => {
		const r = readPointForm(fields("51 30 26 N", "-0.1278"), null);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.point.lat).toBeCloseTo(51 + 30 / 60 + 26 / 3600, 9);
			expect(r.point.lng).toBeCloseTo(-0.1278, 9);
		}
	});

	test("a genuine pasted pair with a blank longitude still fills both", () => {
		const r = readPointForm(fields("51.5074, -0.1278", ""), null);
		expect(r.ok).toBe(true);
		if (r.ok) expect([r.point.lat, r.point.lng]).toEqual([51.5074, -0.1278]);
	});
});
