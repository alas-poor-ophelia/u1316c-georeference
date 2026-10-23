/**
 * The point dialog's validation: the plain forms that always worked, the forms people actually
 * paste, and each refusal with the sentence the user sees.
 */
import { describe, expect, test } from "bun:test";
import { COPY } from "../src/view/copy";
import { readPointForm } from "../src/view/pointform";

const CRS = { name: "WGS84", latRange: [-90, 90], lngRange: [-180, 180] } as const;
const base = { px: "10", py: "20", lat: "51.5", lng: "-0.12", label: "" };

describe("readPointForm", () => {
	test("plain decimals", () => {
		expect(readPointForm(base, CRS)).toEqual({ ok: true, point: { px: 10, py: 20, lat: 51.5, lng: -0.12 } });
	});

	test("label is trimmed and kept", () => {
		const r = readPointForm({ ...base, label: "  York " }, CRS);
		expect(r).toEqual({ ok: true, point: { px: 10, py: 20, lat: 51.5, lng: -0.12, label: "York" } });
	});

	test("decimal comma", () => {
		const r = readPointForm({ ...base, lat: "51,5", lng: "-0,12" }, CRS);
		expect(r).toEqual({ ok: true, point: { px: 10, py: 20, lat: 51.5, lng: -0.12 } });
	});

	test("DMS with an N letter", () => {
		const r = readPointForm({ ...base, lat: "51°30'N", lng: "0°7'W" }, CRS);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.point.lat).toBeCloseTo(51.5, 9);
			expect(r.point.lng).toBeCloseTo(-7 / 60, 9);
		}
	});

	test("wrong axis letter in either field", () => {
		expect(readPointForm({ ...base, lat: "51.5 E" }, CRS)).toEqual({ ok: false, error: COPY.coords.wrongAxis });
		expect(readPointForm({ ...base, lng: "0.1 N" }, CRS)).toEqual({ ok: false, error: COPY.coords.wrongAxis });
	});

	test("unreadable coordinate", () => {
		expect(readPointForm({ ...base, lat: "north" }, CRS)).toEqual({ ok: false, error: COPY.coords.unreadable });
		expect(readPointForm({ ...base, lng: "" }, CRS)).toEqual({ ok: false, error: COPY.coords.unreadable });
	});

	test("a pair in the latitude field with a blank longitude fills both", () => {
		const r = readPointForm({ ...base, lat: "51.5074, -0.1278", lng: "" }, CRS);
		expect(r).toEqual({ ok: true, point: { px: 10, py: 20, lat: 51.5074, lng: -0.1278 } });
	});

	test("a pair in the latitude field with a non-blank longitude is one angle, and unreadable", () => {
		const r = readPointForm({ ...base, lat: "51.5074, -0.1278", lng: "3" }, CRS);
		expect(r).toEqual({ ok: false, error: COPY.coords.unreadable });
	});

	test("pixel messages", () => {
		expect(readPointForm({ ...base, px: "x" }, CRS)).toEqual({ ok: false, error: "Pixel x and y must be numbers." });
		expect(readPointForm({ ...base, py: "" }, CRS)).toEqual({ ok: false, error: "Pixel x and y must be numbers." });
		expect(readPointForm({ ...base, px: "-1" }, CRS)).toEqual({ ok: false, error: "Pixel x and y cannot be negative." });
	});

	test("CRS range message", () => {
		expect(readPointForm({ ...base, lat: "95" }, CRS)).toEqual({ ok: false, error: "Latitude must be between -90 and 90 for WGS84." });
		expect(readPointForm({ ...base, lng: "200" }, CRS)).toEqual({ ok: false, error: "Longitude must be between -180 and 180 for WGS84." });
	});

	test("no CRS means no range check", () => {
		expect(readPointForm({ ...base, lat: "95" }, null).ok).toBe(true);
	});
});
