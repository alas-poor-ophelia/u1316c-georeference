/**
 * Georeference record to and from note frontmatter.
 *
 * READING NEVER THROWS. Frontmatter is a text field in a user's note; it can hold anything, and
 * a user who breaks one map's YAML should not take down the plugin for every other map. So
 * `fromFrontmatter` returns a result carrying the value (or null) plus the problems it found, and
 * the caller decides what to surface. Writing is the strict direction.
 *
 * TOLERANT READING IS A DATA-LOSS TRAP UNLESS IT IS FLAGGED. Dropping a malformed control point
 * and carrying on is the right thing to do on READ. Writing that record back out then deletes the
 * point permanently — and the save looks like it worked. So anything DROPPED, as opposed to merely
 * defaulted, sets `lossy`, and the write path is gated on it. The distinction is deliberate: a
 * missing `geb-crs` is defaulted and reported but costs nothing to re-save; a control point whose
 * latitude reads `"51,5"` is data the user has to see in order to fix.
 */
import { getCrs, inDomain } from "../core/crs";
import { MIN_POINTS, type TransformKind } from "../core/types";
import { KEY, type Georeference, type ParseResult, type StoredFit, type StoredPoint } from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const finiteNumber = (v: unknown): number | null =>
	typeof v === "number" && Number.isFinite(v) ? v : null;

const KINDS: readonly TransformKind[] = ["affine", "polynomial2", "tps"];
const isKind = (v: unknown): v is TransformKind => typeof v === "string" && (KINDS as readonly string[]).includes(v);

/** Collects problems and tracks whether anything was dropped rather than defaulted. */
interface Ctx {
	readonly problems: string[];
	lossy: boolean;
	readonly crs: string;
}

export function toFrontmatter(g: Georeference): Record<string, unknown> {
	return {
		[KEY.id]: g.id,
		[KEY.image]: g.imageLink,
		[KEY.imageSize]: [g.image.width, g.image.height],
		[KEY.imageBytes]: g.image.byteLength,
		[KEY.imageHash]: g.image.hash,
		[KEY.crs]: g.crs,
		[KEY.fits]: g.fits.map((f) => ({
			bounds: f.bounds,
			transform: f.transform.lambda === undefined
				? { model: f.transform.model }
				: { model: f.transform.model, lambda: f.transform.lambda },
			points: f.points.map((p) => (p.label === undefined
				? { px: p.px, py: p.py, lat: p.lat, lng: p.lng }
				: { px: p.px, py: p.py, lat: p.lat, lng: p.lng, label: p.label })),
		})),
	};
}

/**
 * `geb-image: [[britain-5c.png]]` typed by hand and left unquoted is not a string: YAML reads the
 * double brackets as a nested sequence, so the value arrives as `[["britain-5c.png"]]`. It used to
 * fall through as "not a georeference" and be skipped in silence. Recover it and say so, because
 * the user's note looks correct to them.
 */
function readImageLink(v: unknown, ctx: Ctx): string {
	if (typeof v === "string") return v.trim();
	if (Array.isArray(v)) {
		const flat = v.flat(2).filter((x): x is string => typeof x === "string");
		if (flat.length === 1) {
			ctx.problems.push(`${KEY.image} is unquoted, so YAML read it as a list. Quote it: ${KEY.image}: "[[${flat[0]!}]]"`);
			return `[[${flat[0]!}]]`;
		}
	}
	return "";
}

function parsePoint(v: unknown, where: string, ctx: Ctx): StoredPoint | null {
	if (!isRecord(v)) {
		ctx.problems.push(`${where} is not a mapping`);
		ctx.lossy = true;
		return null;
	}
	const px = finiteNumber(v.px);
	const py = finiteNumber(v.py);
	const lat = finiteNumber(v.lat);
	const lng = finiteNumber(v.lng);
	if (px === null || py === null || lat === null || lng === null) {
		ctx.problems.push(`${where} needs finite px, py, lat and lng`);
		ctx.lossy = true;
		return null;
	}

	// Range checks against the CRS record itself, not a hardcoded Earth literal. The rule used to
	// be spelled out here AND in the coverage layer, keyed on the string "earth", which is how a
	// misspelled or differently-cased crs slipped through both unchecked.
	const crs = getCrs(ctx.crs);
	if (crs !== null && !inDomain(crs, lat, lng)) {
		ctx.problems.push(`${where} is outside ${crs.name}'s coordinate range (lat ${lat}, lng ${lng})`);
		ctx.lossy = true;
		return null;
	}
	if (px < 0 || py < 0) {
		ctx.problems.push(`${where} has a negative pixel position (${px}, ${py})`);
		ctx.lossy = true;
		return null;
	}

	let label: string | undefined;
	if (typeof v.label === "string") {
		label = v.label;
	} else if (typeof v.label === "number" || typeof v.label === "boolean") {
		// A numeric label (`label: 1066`) was previously discarded without a word about it.
		ctx.problems.push(`${where} label is not text; using its text form`);
		label = String(v.label);
	} else if (v.label !== undefined && v.label !== null) {
		// Anything else — a nested mapping or list — has no sensible text form. Stringifying it
		// would write the literal "[object Object]" into the user's note as a place name, which is
		// worse than dropping it, so it is dropped and reported.
		ctx.problems.push(`${where} label is not text and has no text form; dropping it`);
		ctx.lossy = true;
	}

	return label === undefined ? { px, py, lat, lng } : { px, py, lat, lng, label };
}

function parseFit(v: unknown, where: string, ctx: Ctx): StoredFit | null {
	if (!isRecord(v)) {
		ctx.problems.push(`${where} is not a mapping`);
		ctx.lossy = true;
		return null;
	}

	const t = v.transform;
	if (!isRecord(t) || !isKind(t.model)) {
		ctx.problems.push(`${where} needs a transform with a model of ${KINDS.join(", ")}`);
		ctx.lossy = true;
		return null;
	}
	const lambda = finiteNumber(t.lambda);
	if (t.lambda !== undefined && (lambda === null || lambda < 0)) {
		ctx.problems.push(`${where} transform lambda must be a finite number >= 0; ignoring it`);
		ctx.lossy = true;
	}

	const rawPoints = Array.isArray(v.points) ? v.points : [];
	if (!Array.isArray(v.points)) {
		ctx.problems.push(`${where} has no points list`);
		ctx.lossy = true;
	}
	const points = rawPoints
		.map((p, i) => parsePoint(p, `${where} point ${i}`, ctx))
		.filter((p): p is StoredPoint => p !== null);

	const need = MIN_POINTS[t.model];
	if (points.length < need) {
		ctx.problems.push(`${where} has ${points.length} usable points; ${t.model} needs ${need}`);
		ctx.lossy = true;
		return null;
	}

	let bounds: StoredFit["bounds"] = null;
	if (isRecord(v.bounds)) {
		const x = finiteNumber(v.bounds.x);
		const y = finiteNumber(v.bounds.y);
		const width = finiteNumber(v.bounds.width);
		const height = finiteNumber(v.bounds.height);
		if (x === null || y === null || width === null || height === null) {
			ctx.problems.push(`${where} bounds needs finite x, y, width and height; treating as the whole image`);
			ctx.lossy = true;
		} else if (width <= 0 || height <= 0 || x < 0 || y < 0) {
			ctx.problems.push(`${where} bounds must be non-negative with a positive size; treating as the whole image`);
			ctx.lossy = true;
		} else {
			bounds = { x, y, width, height };
		}
	} else if (v.bounds !== null && v.bounds !== undefined) {
		ctx.problems.push(`${where} bounds is neither a mapping nor null; treating as the whole image`);
		ctx.lossy = true;
	}

	const transform = lambda === null || lambda < 0 ? { model: t.model } : { model: t.model, lambda };
	return { bounds, transform, points };
}

export function fromFrontmatter(fm: unknown): ParseResult<Georeference> {
	if (!isRecord(fm)) {
		return { value: null, problems: ["frontmatter is missing or not a mapping"], lossy: false };
	}

	const crs = typeof fm[KEY.crs] === "string" && fm[KEY.crs] !== "" ? (fm[KEY.crs] as string) : "earth";
	const ctx: Ctx = { problems: [], lossy: false, crs };

	if (fm[KEY.crs] !== undefined && typeof fm[KEY.crs] !== "string") {
		ctx.problems.push(`${KEY.crs} is not a string; assuming earth`);
	} else if (fm[KEY.crs] === undefined) {
		ctx.problems.push(`${KEY.crs} is missing; assuming earth`);
	} else if (fm[KEY.crs] === "") {
		// An empty string is a key the user typed and left blank. It defaulted in silence, which
		// is the one outcome this parser is not allowed to produce.
		ctx.problems.push(`${KEY.crs} is empty; assuming earth`);
	} else if (getCrs(crs) === null) {
		// A misspelled or differently-cased crs used to load with no complaint at all, and then
		// match no query — a map that silently covers nothing, which is the hardest possible bug
		// for a user to report.
		ctx.problems.push(`${KEY.crs} "${crs}" is not a known coordinate system, so this map will match no query`);
	}

	const id = typeof fm[KEY.id] === "string" ? (fm[KEY.id] as string).trim() : "";
	if (id === "") ctx.problems.push(`${KEY.id} is missing or not a non-empty string`);

	const imageLink = readImageLink(fm[KEY.image], ctx);
	if (imageLink === "") ctx.problems.push(`${KEY.image} is missing or not a non-empty string`);

	// A partial or absent identity is reported as unknown by compareIdentity rather than silently
	// treated as a match, so zeroes here do not pretend to be evidence.
	const size = Array.isArray(fm[KEY.imageSize]) ? (fm[KEY.imageSize] as unknown[]) : [];
	const image = {
		width: finiteNumber(size[0]) ?? 0,
		height: finiteNumber(size[1]) ?? 0,
		byteLength: finiteNumber(fm[KEY.imageBytes]) ?? 0,
		hash: typeof fm[KEY.imageHash] === "string" ? (fm[KEY.imageHash] as string) : "",
	};

	const rawFits = Array.isArray(fm[KEY.fits]) ? (fm[KEY.fits] as unknown[]) : [];
	if (!Array.isArray(fm[KEY.fits])) {
		ctx.problems.push(`${KEY.fits} is missing or not a list`);
		if (fm[KEY.fits] !== undefined) ctx.lossy = true;
	}
	const fits = rawFits
		.map((f, i) => parseFit(f, `${KEY.fits}[${i}]`, ctx))
		.filter((f): f is StoredFit => f !== null);

	if (id === "" || imageLink === "" || fits.length === 0) {
		if (fits.length === 0 && rawFits.length > 0) ctx.problems.push("no usable fits");
		return { value: null, problems: ctx.problems, lossy: ctx.lossy };
	}
	return { value: { id, imageLink, image, crs, fits }, problems: ctx.problems, lossy: ctx.lossy };
}

/**
 * Whether a note's frontmatter even CLAIMS to be a georeference, cheaply, before full parsing.
 *
 * Key PRESENCE, whatever the value's type. This used to test `typeof fm[KEY.id] === "string"`,
 * which silently excluded the likeliest bad input there is: `geb-id: 1066` is a YAML number, so a
 * map titled by year was never listed as a georeference, never reached `fromFrontmatter`, and
 * produced no rejection and no problem anywhere. The report for a non-string id already existed —
 * it was simply unreachable, because the predicate deciding WHICH notes get parsed sat above it
 * and used a narrower test than the data.
 *
 * So this is deliberately generous: anything claiming to be a georeference gets parsed, and
 * `fromFrontmatter` decides whether it is usable and says why. `geb-fits` counts too, because a
 * note carrying fits but no id is an attempted georeference and used to be pinned as a PLACE.
 *
 * A NULL does not count, though. YAML reads a bare `geb-id:` as null, and a template leaving the
 * key blank has not claimed anything. Counting it meant a place note carrying a blank `geb-fits:`
 * vanished from `features`, and — because `handleRename` gates on this predicate and never calls
 * `fromFrontmatter` — that place note's frontmatter got REWRITTEN on an unrelated vault rename.
 *
 * EVERY georeference key counts, not just `id` and `fits`. Checking only those two re-created the
 * original defect in a narrower form: a half-filled template, `geb-id:` and `geb-fits:` left
 * blank with `geb-image` and `geb-image-size` filled in, was excluded again with nothing
 * reported. `KEY` holds exactly the georeference-only keys — a place note's own `geb-from`,
 * `geb-certainty` and the rest are not in it — so the whole record is the claim.
 */
export function looksLikeGeoref(fm: unknown): boolean {
	return isRecord(fm) && Object.values(KEY).some((k) => fm[k] != null);
}
