/**
 * Phase 6: time adapters and the filter over the shared line.
 *
 * THE GATE: two adapters registered, and a date parsed under adapter A compares correctly against
 * one parsed under adapter B on the shared line — a single-adapter implementation must not pass.
 * The last test here is that gate, written so that an implementation ignoring `calendar` and
 * reading every bound under the default adapter fails it.
 *
 * The line's arithmetic is pinned against an INDEPENDENT formulation (`Date.UTC`, proleptic
 * Gregorian, astronomical years) and against the one constant Seshat publishes, rather than
 * against values typed from memory.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { ApiController } from "../src/api/controller";
import type { CodedError, TimeAdapter } from "../src/api/types";
import { TimeAdapterRegistry } from "../src/api/time";
import { toFrontmatter } from "../src/persist/serialize";
import { adapterProblem, GREGORIAN_YEAR, tryParse } from "../src/time/adapters";
import { presentAt, span } from "../src/time/filter";
import { civilFromDays, DAY_LIMIT, daysFromCivil, isDay } from "../src/time/line";
import { FakeVault } from "./fake-vault";
import { georef, ID, NOTE, BYTES } from "./shell-harness";

const codeOf = (fn: () => unknown): string | null => {
	try {
		fn();
		return null;
	} catch (e) {
		return (e as CodedError).code ?? null;
	}
};

describe("the shared line", () => {
	test("day 0 is 1970-01-01, and 0000-01-01 is the constant Seshat publishes", () => {
		expect(daysFromCivil(1970, 1, 1)).toBe(0);
		expect(daysFromCivil(0, 1, 1)).toBe(-719528);
	});

	test("agrees with Date.UTC, an independent formulation, across eras and every month", () => {
		// Date.UTC is proleptic Gregorian with astronomical years, as the line is. Years are set
		// through setUTCFullYear so that 0..99 are not mistaken for 1900..1999.
		for (let year = -4000; year <= 4000; year += 7) {
			for (const month of [1, 2, 3, 6, 12]) {
				for (const day of [1, 28, month === 2 ? 28 : 30]) {
					const d = new Date(0);
					d.setUTCFullYear(year, month - 1, day);
					const expected = Math.round(d.getTime() / 86_400_000);
					expect(daysFromCivil(year, month, day)).toBe(expected);
					expect(civilFromDays(expected)).toEqual({ year, month, day });
				}
			}
		}
	});

	test("leap days: 2000-02-29 exists, 1900-02-28 is followed by 1900-03-01", () => {
		expect(civilFromDays(daysFromCivil(2000, 2, 29))).toEqual({ year: 2000, month: 2, day: 29 });
		expect(civilFromDays(daysFromCivil(1900, 2, 28) + 1)).toEqual({ year: 1900, month: 3, day: 1 });
	});

	test("isDay: whole, safe, within the bound", () => {
		expect(isDay(0)).toBe(true);
		expect(isDay(-DAY_LIMIT)).toBe(true);
		expect(isDay(DAY_LIMIT + 1)).toBe(false);
		expect(isDay(1.5)).toBe(false);
		expect(isDay(Number.NaN)).toBe(false);
		expect(isDay("3")).toBe(false);
	});
});

describe("the built-in year adapter", () => {
	test("reads a signed integer as the first day of that astronomical year, and formats back", () => {
		expect(GREGORIAN_YEAR.parse("1970")).toBe(0);
		expect(GREGORIAN_YEAR.parse("0")).toBe(-719528);
		expect(GREGORIAN_YEAR.parse(" -752 ")).toBe(daysFromCivil(-752, 1, 1));
		expect(GREGORIAN_YEAR.parse("+866")).toBe(daysFromCivil(866, 1, 1));
		expect(GREGORIAN_YEAR.format(0)).toBe("1970");
		expect(GREGORIAN_YEAR.format(daysFromCivil(450, 7, 4))).toBe("450");
		expect(GREGORIAN_YEAR.format(-719528)).toBe("0");
	});

	test("refuses what is not a plain year, and a year beyond the line", () => {
		for (const bad of ["450 BC", "1066-10-14", "c. 450", "", "4.5", "1e3", "9999999", "0x10", "+-1"]) expect(GREGORIAN_YEAR.parse(bad)).toBeNull();
		// The line's ends in years, measured: -25410 to 29349. One past each is refused by isDay,
		// not by the regex — "29350" is six digits and well formed.
		expect(GREGORIAN_YEAR.parse("29349")).not.toBeNull();
		expect(GREGORIAN_YEAR.parse("29350")).toBeNull();
		expect(GREGORIAN_YEAR.parse("-25410")).toBeNull(); // its FIRST day is past the end
		expect(GREGORIAN_YEAR.parse("-25409")).not.toBeNull();
	});

	test("last names the year's final day, so a span written as years is inclusive of its last year", () => {
		expect(GREGORIAN_YEAR.last!("866")).toBe(daysFromCivil(867, 1, 1) - 1);
		expect(civilFromDays(GREGORIAN_YEAR.last!("866")!)).toEqual({ year: 866, month: 12, day: 31 });
		expect(GREGORIAN_YEAR.last!("c. 866")).toBeNull();
		// At the very end of the line the year's last day is off it: refused, like any other.
		expect(GREGORIAN_YEAR.last!("29349")).toBeNull();
	});
});

describe("tryParse never trusts an adapter", () => {
	const base = { id: "t:x", name: "x", format: () => "" };
	test("a throw becomes a fault naming the adapter, not an exception", () => {
		const got = tryParse({ ...base, parse: () => { throw new Error("boom"); } }, "1", false);
		expect(got.day).toBeNull();
		expect(got.fault).toContain("boom");
		expect(got.fault).toContain("t:x");
	});
	test("an answer off the line, fractional, or not a number is a fault", () => {
		for (const bad of [1e9, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3" as unknown as number]) {
			const got = tryParse({ ...base, parse: () => bad }, "1", false);
			expect(got.day).toBeNull();
			expect(got.fault).toContain("not a whole day");
		}
	});
	test("null is a plain no, with no fault; undefined is treated the same", () => {
		expect(tryParse({ ...base, parse: () => null }, "1", false)).toEqual({ day: null, fault: null });
		expect(tryParse({ ...base, parse: () => undefined as unknown as null }, "1", false)).toEqual({ day: null, fault: null });
	});
	test("end asks last when there is one, and falls back to parse when there is not", () => {
		expect(tryParse({ ...base, parse: () => 10, last: () => 20 }, "1", true).day).toBe(20);
		expect(tryParse({ ...base, parse: () => 10, last: () => 20 }, "1", false).day).toBe(10);
		expect(tryParse({ ...base, parse: () => 10 }, "1", true).day).toBe(10);
	});
});

describe("the registry", () => {
	const auc: TimeAdapter = {
		id: "test:auc",
		name: "Ab urbe condita",
		parse: (t) => {
			const m = /^\s*(\d+)\s*$/.exec(t);
			return m === null ? null : daysFromCivil(Number(m[1]) - 753, 1, 1);
		},
		last: (t) => {
			const m = /^\s*(\d+)\s*$/.exec(t);
			return m === null ? null : daysFromCivil(Number(m[1]) - 752, 1, 1) - 1;
		},
		format: (d) => String(civilFromDays(d).year + 753),
	};

	test("the built-in is present, resolves as the default, and cannot be replaced or removed", () => {
		const r = new TimeAdapterRegistry();
		expect(r.list()).toEqual([{ id: "gregorian", name: "Gregorian year" }]);
		expect(r.resolve(undefined)).toBe(GREGORIAN_YEAR);
		expect(r.resolve("gregorian")).toBe(GREGORIAN_YEAR);
		expect(codeOf(() => r.register({ ...GREGORIAN_YEAR }))).toBe("geb-duplicate-id");
		r.clear();
		expect(r.resolve("gregorian")).toBe(GREGORIAN_YEAR);
	});

	test("register returns an unregister that runs once and removes only what it registered", () => {
		const r = new TimeAdapterRegistry();
		const off = r.register(auc);
		expect(r.resolve("test:auc")?.id).toBe("test:auc");
		expect(codeOf(() => r.register(auc))).toBe("geb-duplicate-id");
		off();
		expect(r.resolve("test:auc")).toBeNull();
		// Run twice: the second call is a no-op even when the id is free again.
		r.register(auc);
		off();
		expect(r.resolve("test:auc")?.id).toBe("test:auc");
	});

	test("a stale unregister from before a clear must not remove the adapter someone else registered since", () => {
		// The real sequence: a consumer registers, the plugin unloads (clear), another consumer
		// registers under the same id on the next ready, and the FIRST consumer's unregister
		// finally runs — for the first time, so the run-once guard does not save anyone.
		const r = new TimeAdapterRegistry();
		const off = r.register(auc);
		r.clear();
		const other = { ...auc, name: "Someone else's AUC" };
		r.register(other);
		off();
		expect(r.resolve("test:auc")?.name).toBe("Someone else's AUC");
	});

	test("an unknown id resolves to null; clear keeps only the built-in", () => {
		const r = new TimeAdapterRegistry();
		r.register(auc);
		expect(r.resolve("test:julian")).toBeNull();
		r.clear();
		expect(r.list().map((a) => a.id)).toEqual(["gregorian"]);
	});

	test("the registry keeps its own record: mutating the object afterwards changes nothing", () => {
		const r = new TimeAdapterRegistry();
		const mutable = { id: "test:m", name: "Mutable", parse: () => 1, format: () => "1" };
		const off = r.register(mutable);
		mutable.id = "test:other";
		mutable.name = "Renamed";
		expect(r.list().map((a) => a.id)).toEqual(["gregorian", "test:m"]);
		expect(r.list()[1]?.name).toBe("Mutable");
		expect(r.resolve("test:other")).toBeNull();
		// The same object registered again under its new id is a second, separate entry...
		const off2 = r.register(mutable);
		expect(r.list().map((a) => a.id)).toEqual(["gregorian", "test:m", "test:other"]);
		// ...and each unregister removes exactly its own.
		off();
		expect(r.list().map((a) => a.id)).toEqual(["gregorian", "test:other"]);
		off2();
		expect(r.list().map((a) => a.id)).toEqual(["gregorian"]);
	});

	test("a malformed adapter is refused with the reason, not stored", () => {
		expect(adapterProblem(null)).toContain("object");
		expect(adapterProblem({ id: "a b", name: "x", parse: () => 0, format: () => "" })).toContain("whitespace");
		expect(adapterProblem({ id: "x", name: "", parse: () => 0, format: () => "" })).toContain("name");
		expect(adapterProblem({ id: "x", name: "x", format: () => "" })).toContain("parse");
		expect(adapterProblem({ id: "x", name: "x", parse: () => 0 })).toContain("format");
		expect(adapterProblem(auc)).toBeNull();
		const r = new TimeAdapterRegistry();
		expect(codeOf(() => r.register({ id: "", name: "x", parse: () => 0, format: () => "" }))).toBe("geb-bad-adapter");
		expect(r.list()).toHaveLength(1);
	});
});

describe("the filter", () => {
	const r = new TimeAdapterRegistry();
	const resolve = (c: string | undefined): TimeAdapter | null => r.resolve(c);
	const y = (n: number): number => daysFromCivil(n, 1, 1);

	test("absent bounds are infinite, and a feature with neither is always present", () => {
		expect(span({}, resolve)).toEqual({ from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY, problem: null });
		expect(presentAt({}, -DAY_LIMIT, resolve)).toBe(true);
		expect(presentAt({ to: "866" }, y(-3000), resolve)).toBe(true);
		expect(presentAt({ to: "866" }, y(867), resolve)).toBe(false);
		expect(presentAt({ from: "71" }, y(2026), resolve)).toBe(true);
		expect(presentAt({ from: "71" }, y(70), resolve)).toBe(false);
	});

	test("inclusive at both ends: from the first day of the from-year through the LAST day of the to-year", () => {
		const d = { from: "71", to: "866" };
		expect(presentAt(d, y(71), resolve)).toBe(true);
		expect(presentAt(d, y(71) - 1, resolve)).toBe(false);
		expect(presentAt(d, y(866), resolve)).toBe(true);
		expect(presentAt(d, y(867) - 1, resolve)).toBe(true);
		expect(presentAt(d, y(867), resolve)).toBe(false);
		// A one-year span is the whole year, not a single day.
		expect(presentAt({ from: "866", to: "866" }, y(866) + 200, resolve)).toBe(true);
	});

	test("an adapter that throws or answers off the line leaves that side open and is reported", () => {
		const r2 = new TimeAdapterRegistry();
		r2.register({ id: "test:throws", name: "t", parse: () => { throw new Error("boom"); }, format: () => "" });
		r2.register({ id: "test:far", name: "f", parse: () => 1e9, format: () => "" });
		const res = (c: string | undefined): TimeAdapter | null => r2.resolve(c);
		const s1 = span({ from: "1", to: "2", calendar: "test:throws" }, res);
		expect(s1).toMatchObject({ from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY });
		expect(s1.problem).toContain("boom");
		const s2 = span({ from: "1", calendar: "test:far" }, res);
		expect(s2.from).toBe(Number.NEGATIVE_INFINITY);
		expect(s2.problem).toContain("not a whole day");
	});

	test("an unreadable bound is unbounded on that side AND reported; the other side still applies", () => {
		const s = span({ from: "c. 450", to: "866" }, resolve);
		expect(s.from).toBe(Number.NEGATIVE_INFINITY);
		expect(s.to).toBe(y(867) - 1);
		expect(s.problem).toContain('geb-from "c. 450"');
		expect(presentAt({ from: "c. 450", to: "866" }, y(-5000), resolve)).toBe(true);
		expect(presentAt({ from: "c. 450", to: "866" }, y(900), resolve)).toBe(false);
	});

	test("an unknown calendar is unbounded both sides and reported by name", () => {
		const s = span({ from: "1", to: "2", calendar: "test:none" }, resolve);
		expect(s).toMatchObject({ from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY });
		expect(s.problem).toContain("test:none");
	});

	test("from after to is reported, and nothing falls inside", () => {
		const s = span({ from: "900", to: "100" }, resolve);
		expect(s.problem).toContain("after");
		expect(presentAt({ from: "900", to: "100" }, y(500), resolve)).toBe(false);
	});
});

describe("the API: the phase-6 gate", () => {
	let v: FakeVault;
	let c: ApiController;
	/** Ab urbe condita: AUC year N is astronomical year N - 753. AUC 1 = 753 BC = year -752. */
	const auc: TimeAdapter = {
		id: "test:auc",
		name: "Ab urbe condita",
		parse: (t) => {
			const m = /^\s*(\d+)\s*$/.exec(t);
			return m === null ? null : daysFromCivil(Number(m[1]) - 753, 1, 1);
		},
		last: (t) => {
			const m = /^\s*(\d+)\s*$/.exec(t);
			return m === null ? null : daysFromCivil(Number(m[1]) - 752, 1, 1) - 1;
		},
		format: (d) => String(civilFromDays(d).year + 753),
	};
	/** A second shift, so an implementation hard-coding one per-calendar offset cannot pass: raw days. */
	const days: TimeAdapter = {
		id: "test:day",
		name: "Day on the line",
		parse: (t) => (/^-?\d+$/.test(t.trim()) ? Number(t) : null),
		format: (d) => String(d),
	};
	const y = (n: number): number => daysFromCivil(n, 1, 1);

	beforeEach(() => {
		v = new FakeVault();
		v.addFile(`${ID}.png`, BYTES);
		v.addNote(NOTE, toFrontmatter(georef()));
		// Four places inside the map: the same historical span (71 through 866) written under the
		// default adapter, under AUC, and as raw days on the line, plus an undated one.
		v.addNote("places/Roman.md", { lat: 53.96, lng: -1.08, "geb-from": 71, "geb-to": 866 });
		v.addNote("places/RomanAUC.md", { lat: 51.51, lng: -0.13, "geb-from": "824", "geb-to": "1619", "geb-calendar": "test:auc" });
		v.addNote("places/RomanDays.md", { lat: 55.95, lng: -3.19, "geb-from": String(y(71)), "geb-to": String(y(867) - 1), "geb-calendar": "test:day" });
		v.addNote("places/Timeless.md", { lat: 52.63, lng: 1.3 });
		c = new ApiController(v, "0.0.1");
		c.markReady();
		c.api.registerTimeAdapter(days);
	});

	const present = (at?: number): string[] =>
		(c.api.featuresIn(ID, at === undefined ? undefined : { at }) ?? []).map((p) => p.feature.notePath.replace("places/", "").replace(".md", "")).sort();

	test("a date under adapter A compares correctly with a date under adapter B on the shared line", () => {
		const off = c.api.registerTimeAdapter(auc);
		expect(c.api.listTimeAdapters().map((a) => a.id)).toEqual(["gregorian", "test:day", "test:auc"]);
		// AUC 824 is the year 71; AUC 1619 is 866. Same span, three calendars.
		expect(c.api.toDay("824", "test:auc")).toBe(c.api.toDay("71"));
		expect(c.api.toDay("1619", "test:auc")).toBe(c.api.toDay("866", "gregorian"));
		expect(c.api.toDay("1", "test:auc")).toBe(c.api.toDay("-752"));
		expect(c.api.toDay(String(y(71)), "test:day")).toBe(c.api.toDay("71"));
		// ORDER across adapters, not only equality: AUC 824 precedes the year 72 and follows 70.
		expect(c.api.toDay("824", "test:auc")!).toBeLessThan(c.api.toDay("72")!);
		expect(c.api.toDay("824", "test:auc")!).toBeGreaterThan(c.api.toDay("70")!);

		const all = ["Roman", "RomanAUC", "RomanDays", "Timeless"];
		// No filter: everything, as before.
		expect(present()).toEqual(all);
		// Inside the span under every calendar.
		expect(present(y(400))).toEqual(all);
		// At the exact bounds, under every calendar: the first day of 71, the last day of 866.
		expect(present(y(71))).toEqual(all);
		expect(present(y(867) - 1)).toEqual(all);
		// Outside: an implementation reading "824" and "1619" under the default adapter would
		// still return RomanAUC here (824 <= 900 <= 1619), which is how this gate catches it; one
		// hard-coding AUC's shift alone would misread RomanDays.
		expect(present(y(867))).toEqual(["Timeless"]);
		expect(present(y(900))).toEqual(["Timeless"]);
		expect(present(y(70))).toEqual(["Timeless"]);
		// The line's ends are legal instants.
		expect(present(DAY_LIMIT)).toEqual(["Timeless"]);
		expect(present(-DAY_LIMIT)).toEqual(["Timeless"]);
		// And no date problems while the adapters are registered.
		expect(c.api.listProblems().filter((p) => p.code === "bad-date")).toEqual([]);

		// Unregistered, the AUC note's calendar is unknown: present at every instant, and reported.
		off();
		expect(present(y(900))).toEqual(["RomanAUC", "Timeless"]);
		const problems = c.api.listProblems().filter((p) => p.code === "bad-date");
		expect(problems).toHaveLength(1);
		expect(problems[0]?.notePath).toBe("places/RomanAUC.md");
		expect(problems[0]?.message).toContain("test:auc");
	});

	test("a broken adapter degrades one note's bounds, never the query surface", () => {
		c.api.registerTimeAdapter({ id: "test:auc", name: "broken", parse: () => { throw new Error("boom"); }, format: () => { throw new Error("bang"); } });
		// featuresIn and listProblems keep answering; the note is present everywhere and reported.
		expect(present(y(900))).toEqual(["RomanAUC", "Timeless"]);
		const p = c.api.listProblems().find((x) => x.notePath === "places/RomanAUC.md");
		expect(p?.code).toBe("bad-date");
		expect(p?.message).toContain("boom");
		// Asked by name, the caller is told.
		expect(codeOf(() => c.api.toDay("1", "test:auc"))).toBe("geb-bad-adapter");
		expect(codeOf(() => c.api.fromDay(0, "test:auc"))).toBe("geb-bad-adapter");
	});

	test("an adapter answering off the line is a bad adapter to toDay, and a problem to a query", () => {
		c.api.registerTimeAdapter({ id: "test:far", name: "far", parse: () => 1e9, format: () => 42 as unknown as string });
		expect(codeOf(() => c.api.toDay("1", "test:far"))).toBe("geb-bad-adapter");
		expect(codeOf(() => c.api.fromDay(0, "test:far"))).toBe("geb-bad-adapter");
		v.addNote("places/Far.md", { lat: 54.89, lng: -2.93, "geb-from": "1", "geb-calendar": "test:far" });
		c.host.invalidate("places/Far.md");
		c.flush();
		expect(present(y(-5000))).toContain("Far");
		expect(c.api.listProblems().find((x) => x.notePath === "places/Far.md")?.message).toContain("not a whole day");
	});

	test("toDay and fromDay round-trip under each adapter, and refuse what they must", () => {
		c.api.registerTimeAdapter(auc);
		expect(c.api.fromDay(c.api.toDay("824", "test:auc")!, "test:auc")).toBe("824");
		expect(c.api.fromDay(c.api.toDay("71")!)).toBe("71");
		expect(c.api.toDay("not a year")).toBeNull();
		expect(codeOf(() => c.api.toDay("1", "test:julian"))).toBe("geb-unknown-calendar");
		expect(codeOf(() => c.api.fromDay(1.5))).toBe("geb-bad-argument");
		expect(codeOf(() => c.api.fromDay(DAY_LIMIT + 1))).toBe("geb-bad-argument");
		expect(codeOf(() => c.api.toDay(824 as unknown as string))).toBe("geb-bad-argument");
	});

	test("featuresIn refuses an `at` that is not a day on the line", () => {
		expect(codeOf(() => c.api.featuresIn(ID, { at: 0.5 }))).toBe("geb-bad-argument");
		expect(codeOf(() => c.api.featuresIn(ID, { at: Number.NaN }))).toBe("geb-bad-argument");
		expect(c.api.featuresIn("no-such-map", { at: 0 })).toBeNull();
	});

	test("a typo in a date keeps the pin and names the note", () => {
		v.addNote("places/Typo.md", { lat: 54.89, lng: -2.93, "geb-from": "c. 450", "geb-to": 866 });
		c.host.invalidate("places/Typo.md");
		c.flush();
		expect(present(y(-5000))).toContain("Typo");
		expect(present(y(900))).not.toContain("Typo");
		const p = c.api.listProblems().find((x) => x.notePath === "places/Typo.md");
		expect(p?.code).toBe("bad-date");
		expect(p?.message).toContain("c. 450");
	});

	test("registration is refused for a taken id and a malformed adapter, and the registry is cleared on unload", () => {
		expect(codeOf(() => c.api.registerTimeAdapter({ ...GREGORIAN_YEAR }))).toBe("geb-duplicate-id");
		expect(codeOf(() => c.api.registerTimeAdapter({ id: "x y", name: "bad", parse: () => null, format: () => "" }))).toBe("geb-bad-adapter");
		const off = c.api.registerTimeAdapter(auc);
		expect(c.api.listTimeAdapters()).toHaveLength(3);
		c.unload();
		expect(codeOf(() => c.api.listTimeAdapters())).toBe("geb-unloaded");
		// The stale unregister is harmless after unload.
		expect(() => off()).not.toThrow();
	});
});
