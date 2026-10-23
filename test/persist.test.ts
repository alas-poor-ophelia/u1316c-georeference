import { describe, expect, test } from "bun:test";
import { compareIdentity, hashBytes, identify } from "../src/persist/identity";
import { formatLink, linkMatchesPath, linkTarget, parseLink, retarget } from "../src/persist/links";
import { fromFrontmatter, looksLikeGeoref, toFrontmatter } from "../src/persist/serialize";
import { KEY, type Georeference } from "../src/persist/types";

const bytes = (...vals: number[]): ArrayBuffer => new Uint8Array(vals).buffer;

const GEOREF: Georeference = {
	id: "geb-0001",
	imageLink: "[[britain-5c.png]]",
	image: { width: 2400, height: 3200, byteLength: 4, hash: hashBytes(bytes(1, 2, 3, 4)) },
	crs: "earth",
	fits: [
		{
			bounds: null,
			transform: { model: "tps", lambda: 0 },
			points: [
				{ px: 412, py: 338, lat: 53.9591, lng: -1.0815, label: "Eboracum" },
				{ px: 900, py: 1200, lat: 51.51, lng: -0.13 },
				{ px: 300, py: 400, lat: 55.95, lng: -3.19 },
			],
		},
	],
};

describe("frontmatter round trip", () => {
	test("survives intact", () => {
		const { value, problems } = fromFrontmatter(toFrontmatter(GEOREF));
		expect(problems).toEqual([]);
		expect(value).toEqual(GEOREF);
	});

	test("the mercator model survives intact, with no lambda gained", () => {
		const record: Georeference = { ...GEOREF, fits: [{ ...GEOREF.fits[0]!, transform: { model: "mercator" } }] };
		const { value, problems } = fromFrontmatter(toFrontmatter(record));
		expect(problems).toEqual([]);
		expect(value).toEqual(record);
	});

	test("a point with no label does not gain an undefined one", () => {
		const fm = toFrontmatter(GEOREF);
		const fits = fm[KEY.fits] as { points: Record<string, unknown>[] }[];
		expect("label" in fits[0]!.points[1]!).toBe(false);
	});
});

describe("reading frontmatter never throws, whatever is in it", () => {
	const garbage: ReadonlyArray<[string, unknown]> = [
		["null", null],
		["a string", "not a mapping"],
		["an array", [1, 2, 3]],
		["an empty object", {}],
		["a number where the fits list goes", { [KEY.id]: "x", [KEY.image]: "[[a.png]]", [KEY.fits]: 7 }],
		["points that are strings", { [KEY.id]: "x", [KEY.image]: "[[a.png]]", [KEY.fits]: [{ transform: { model: "affine" }, points: ["nope"] }] }],
		["an unknown model", { [KEY.id]: "x", [KEY.image]: "[[a.png]]", [KEY.fits]: [{ transform: { model: "mercator-ish" }, points: [] }] }],
		["NaN coordinates", { [KEY.id]: "x", [KEY.image]: "[[a.png]]", [KEY.fits]: [{ transform: { model: "affine" }, points: [{ px: 0, py: 0, lat: "north", lng: 0 }] }] }],
	];

	for (const [label, fm] of garbage) {
		test(`${label} yields problems rather than an exception`, () => {
			const r = fromFrontmatter(fm);
			expect(r.value).toBeNull();
			expect(r.problems.length).toBeGreaterThan(0);
		});
	}

	test("an unknown model's problem tells an older build the note may come from a newer Geb", () => {
		const fm = { [KEY.id]: "x", [KEY.image]: "[[a.png]]", [KEY.fits]: [{ transform: { model: "future" }, points: [] }] };
		const r = fromFrontmatter(fm);
		expect(r.problems.join("\n")).toContain("(a model this Geb does not know may come from a newer Geb)");
	});

	test("too few points for the chosen model is refused with a count", () => {
		const fm = toFrontmatter(GEOREF);
		(fm[KEY.fits] as { points: unknown[] }[])[0]!.points = [{ px: 1, py: 1, lat: 1, lng: 1 }];
		const r = fromFrontmatter(fm);
		expect(r.value).toBeNull();
		expect(r.problems.some((p) => p.includes("needs 3"))).toBe(true);
	});

	test("a missing crs is reported and defaulted rather than failing the whole record", () => {
		const fm = toFrontmatter(GEOREF);
		delete fm[KEY.crs];
		const r = fromFrontmatter(fm);
		expect(r.value?.crs).toBe("earth");
		expect(r.problems.some((p) => p.includes(KEY.crs))).toBe(true);
	});

	test("looksLikeGeoref is cheap and does not need a valid record", () => {
		expect(looksLikeGeoref({ [KEY.id]: "x" })).toBe(true);
		expect(looksLikeGeoref({ tags: ["journal"] })).toBe(false);
		expect(looksLikeGeoref(null)).toBe(false);
	});
});

describe("anything DROPPED is flagged lossy, so it is never written back", () => {
	// Reading tolerantly is right. Saving what a tolerant read produced deletes the data the user
	// needs in order to fix it, and the save looks like it worked. The distinction that matters is
	// dropped versus defaulted.
	const withExtraPoint = (p: Record<string, unknown>): Record<string, unknown> => {
		const fm = toFrontmatter(GEOREF);
		(fm[KEY.fits] as { points: unknown[] }[])[0]!.points.push(p);
		return fm;
	};

	test("a clean record is not lossy", () => {
		expect(fromFrontmatter(toFrontmatter(GEOREF)).lossy).toBe(false);
	});

	test("a defaulted crs is reported but not lossy", () => {
		const fm = toFrontmatter(GEOREF);
		delete fm[KEY.crs];
		const r = fromFrontmatter(fm);
		expect(r.problems.length).toBeGreaterThan(0);
		expect(r.lossy).toBe(false);
	});

	test("a malformed point is lossy", () => {
		const r = fromFrontmatter(withExtraPoint({ px: 1, py: 1, lat: "51,5", lng: 0 }));
		expect(r.lossy).toBe(true);
	});

	test("a latitude outside Earth's range is lossy and reported", () => {
		// Previously `lat: 999, lng: -5000` produced an empty problems list.
		const r = fromFrontmatter(withExtraPoint({ px: 1, py: 1, lat: 999, lng: -5000 }));
		expect(r.lossy).toBe(true);
		expect(r.problems.some((p) => p.includes("outside Earth"))).toBe(true);
	});

	test("a negative pixel position is lossy and reported", () => {
		const r = fromFrontmatter(withExtraPoint({ px: -9, py: 1e9, lat: 51, lng: 0 }));
		expect(r.lossy).toBe(true);
		expect(r.problems.some((p) => p.includes("negative pixel"))).toBe(true);
	});

	test("a non-text label is kept and reported, not silently discarded", () => {
		const r = fromFrontmatter(withExtraPoint({ px: 1, py: 1, lat: 51, lng: 0, label: 1066 }));
		expect(r.problems.some((p) => p.includes("label is not text"))).toBe(true);
		expect(r.value?.fits[0]!.points.some((p) => p.label === "1066")).toBe(true);
	});

	test("a fit dropped for too few points is lossy even when its siblings load", () => {
		const fm = toFrontmatter(GEOREF);
		(fm[KEY.fits] as unknown[]).push({ transform: { model: "affine" }, points: [{ px: 1, py: 1, lat: 1, lng: 1 }] });
		const r = fromFrontmatter(fm);
		expect(r.value).not.toBeNull();
		expect(r.lossy).toBe(true);
	});
});

describe("an unquoted image link", () => {
	test("is recovered from YAML's nested list and the fix is explained", () => {
		// `geb-image: [[britain-5c.png]]` typed by hand is not a string: YAML reads the brackets as
		// a nested sequence. It used to fall through as "not a georeference" in silence, while the
		// user's note looked perfectly correct to them.
		const fm = toFrontmatter(GEOREF);
		fm[KEY.image] = [["britain-5c.png"]];
		const r = fromFrontmatter(fm);
		expect(r.value?.imageLink).toBe("[[britain-5c.png]]");
		expect(r.problems.some((p) => p.includes("unquoted"))).toBe(true);
	});
});

describe("wikilink text", () => {
	test("the target is extracted from every form Obsidian writes", () => {
		expect(linkTarget("[[britain-5c.png]]")).toBe("britain-5c.png");
		expect(linkTarget("[[britain-5c.png|My map]]")).toBe("britain-5c.png");
		expect(linkTarget("[[attachments/britain-5c.png]]")).toBe("attachments/britain-5c.png");
		expect(linkTarget("  [[a.png]]  ")).toBe("a.png");
		expect(linkTarget("bare.png")).toBe("bare.png");
	});

	test("matching a vanished image path requires the extension", () => {
		const p = "attachments/britain-5c.png";
		expect(linkMatchesPath("[[attachments/britain-5c.png]]", p)).toBe(true);
		expect(linkMatchesPath("[[britain-5c.png]]", p)).toBe(true);
		expect(linkMatchesPath("[[BRITAIN-5C.PNG]]", p)).toBe(true);
		// Obsidian omits the extension only for markdown. Accepting it for every file meant a
		// renamed britain-5c.png could hijack a link that pointed at britain-5c.md.
		expect(linkMatchesPath("[[britain-5c]]", p)).toBe(false);
		expect(linkMatchesPath("[[attachments/britain-5c]]", p)).toBe(false);
	});

	test("and omits it for notes, as Obsidian does", () => {
		const p = "notes/Britain.md";
		expect(linkMatchesPath("[[Britain]]", p)).toBe(true);
		expect(linkMatchesPath("[[Britain.md]]", p)).toBe(true);
		expect(linkMatchesPath("[[notes/Britain]]", p)).toBe(true);
	});

	test("and does not match an unrelated file", () => {
		expect(linkMatchesPath("[[portrait.png]]", "attachments/britain-5c.png")).toBe(false);
		expect(linkMatchesPath("[[]]", "attachments/britain-5c.png")).toBe(false);
	});

	test("retargeting keeps the alias and the subpath, which are the user's", () => {
		expect(retarget("[[old.png|My map]]", "new.png")).toBe("[[new.png|My map]]");
		expect(retarget("[[old.png#region]]", "new.png")).toBe("[[new.png#region]]");
		expect(retarget("[[old.png#region|My map]]", "new.png")).toBe("[[new.png#region|My map]]");
		expect(retarget("[[old.png]]", "new.png")).toBe("[[new.png]]");
	});

	test("parse and format round-trip every form", () => {
		for (const s of ["[[a.png]]", "[[a.png|alias]]", "[[a.png#sub]]", "[[a.png#sub|alias]]"]) {
			expect(formatLink(parseLink(s))).toBe(s);
		}
	});
});

describe("image identity", () => {
	test("the same bytes hash the same, different bytes do not", () => {
		expect(hashBytes(bytes(1, 2, 3))).toBe(hashBytes(bytes(1, 2, 3)));
		expect(hashBytes(bytes(1, 2, 3))).not.toBe(hashBytes(bytes(1, 2, 4)));
	});

	test("a transposition changes the hash, which an additive checksum would miss", () => {
		expect(hashBytes(bytes(1, 2, 3, 4))).not.toBe(hashBytes(bytes(1, 2, 4, 3)));
	});

	test("the algorithm is named in the digest, so changing it is not mistaken for a changed image", () => {
		expect(hashBytes(bytes(1))).toStartWith("fnv1a64:");
	});

	test("a re-saved image is detected as changed", () => {
		const before = identify(bytes(1, 2, 3, 4), 2400, 3200);
		const after = identify(bytes(1, 2, 3, 4, 5), 2400, 3200);
		expect(compareIdentity(before, after)).toBe("changed");
	});

	test("a resize at the same byte length is still detected", () => {
		const before = identify(bytes(1, 2, 3, 4), 2400, 3200);
		const after = { ...before, width: 1200, height: 1600 };
		expect(compareIdentity(before, after)).toBe("changed");
	});

	test("an unchanged image is same", () => {
		const id = identify(bytes(9, 9, 9), 100, 50);
		expect(compareIdentity(id, identify(bytes(9, 9, 9), 100, 50))).toBe("same");
	});

	test("a record with no stored identity is unknown, never same", () => {
		// Treating an absent hash as evidence of sameness is how a staleness check quietly stops
		// checking anything at all.
		const current = identify(bytes(1), 10, 10);
		expect(compareIdentity(null, current)).toBe("unknown");
		expect(compareIdentity({ width: 0, height: 0, byteLength: 0, hash: "" }, current)).toBe("unknown");
	});

	test("dimensions are compared only when both sides have them", () => {
		// The persistence layer can read bytes but cannot decode an image, so it passes no
		// dimensions. Comparing a present value against an absent one would mark every record
		// changed, and a check that cries wolf gets switched off.
		const stored = identify(bytes(4, 5, 6), 800, 600);
		const bytesOnly = { byteLength: stored.byteLength, hash: stored.hash };
		expect(compareIdentity(stored, bytesOnly)).toBe("same");
	});
});

describe("a label with no text form", () => {
	test("is dropped and reported rather than written as [object Object]", () => {
		// Stringifying an object would put the literal "[object Object]" into the user's note as a
		// place name, which is worse than dropping it. Caught by lint, which was right.
		const fm = toFrontmatter(GEOREF);
		(fm[KEY.fits] as { points: unknown[] }[])[0]!.points.push({ px: 1, py: 1, lat: 51, lng: 0, label: { a: 1 } });
		const r = fromFrontmatter(fm);
		expect(r.lossy).toBe(true);
		expect(r.problems.some((p) => p.includes("no text form"))).toBe(true);
		expect(r.value?.fits[0]!.points.every((p) => p.label !== "[object Object]")).toBe(true);
	});
});
