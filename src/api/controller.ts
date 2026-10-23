/**
 * The API controller: builds the public object, owns its lifecycle, and gates every method.
 *
 * NO INDEX STATE. Every query calls `buildIndex` and throws the snapshot away. That is deliberate
 * and it is the first of three steps: this version is complete, honest and slow, and it is the
 * thing to fall back to if the memoisation that follows proves wrong. Nothing here caches, so
 * nothing here can serve a stale answer.
 *
 * TWO GATES, in this order:
 *
 *   `live()`     — the plugin is loaded. Throws `geb-unloaded`, because a consumer holding a
 *                  reference across a reload must find out rather than receive an empty answer.
 *   `snapshot()` — the above, plus Obsidian has finished indexing. Throws `geb-not-ready`:
 *                  before the metadata cache resolves, `buildIndex` reads a partial cache and
 *                  reports an empty vault with no problems, which is a confident lie and the same
 *                  "still indexing" trap the reconciliation layer already had to handle.
 *
 * The guard is applied inline at each method, Wadjet-style, rather than through a proxy — it is
 * then visible at every call site, and a method added without one is visible in review.
 *
 * NULL VERSUS THROW, decided once and applied everywhere:
 *   - A LOADED georeference answers.
 *   - A REJECTED one throws `geb-no-such-georef` CARRYING THE REASON. This is the hole the
 *     architecture review found: the index records why a map was rejected and the surface had no
 *     way to say so, which is a map vanishing in silence.
 *   - A genuinely ABSENT id is `null` from `getGeoref` (the existence probe) and a throw from
 *     everything that needs a map to work on.
 *   - `null` from `toPixel`, `toLatLng` and `featuresIn` means something else entirely: the
 *     kernel has no meaningful answer there, or no such loaded map. Never "not found".
 */
import { EARTH, getCrs, listCrs } from "../core/crs";
import { buildFit, toLatLng, toPixel, type Fit, type ImageSize } from "../core/fit";
import { MIN_POINTS, RECOMMENDED_POINTS, type ControlPoint, type LatLng, type TransformKind, type TransformOptions } from "../core/types";
import { hashBytes } from "../persist/identity";
import { linkTarget } from "../persist/links";
import { toFrontmatter } from "../persist/serialize";
import { KEY, type Georeference, type ParseResult, type Staleness, type StoredFit, type VaultPort } from "../persist/types";
import { createAndCapture, writeAndCapture } from "../persist/write";
import { featuresIn, georefsCovering } from "../query/coverage";
import { canonical } from "../query/fit-memo";
import type { LoadedGeoref, Problem, WorldIndex } from "../query/types";
import { tryParse, type TimeAdapter } from "../time/adapters";
import { presentAt, span } from "../time/filter";
import { DAY_LIMIT, isDay } from "../time/line";
import { IndexHost, type ChangeSet } from "./host";
import { codedError } from "./errors";
import { TimeAdapterRegistry } from "./time";
import {
	API_VERSION,
	type CreateGeorefInput,
	type FitInfo,
	type FitPreview,
	type GebAPI,
	type GebEvent,
	type GebEventPayload,
	type GeorefSummary,
	type ImageInfo,
	type PixelResult,
	type UpdateGeorefPatch,
} from "./types";

type Listener = (payload: GebEventPayload) => void;

/**
 * A deep copy for a consumer.
 *
 * Nothing that reaches here carries a function — the projections below exist precisely to keep a
 * `Fit` and its `Mapping` off the surface — but the fallback means a field added later turns a
 * handout into a shallow copy rather than a `DataCloneError` inside someone else's plugin.
 */
function handout<T>(v: T): T {
	try {
		return structuredClone(v);
	} catch {
		return v;
	}
}

const summarise = (record: Georeference, notePath: string): GeorefSummary => {
	const first = record.fits[0]!;
	return {
		id: record.id,
		notePath,
		crs: record.crs,
		model: first.transform.model,
		pointCount: first.points.length,
		...(first.transform.lambda === undefined ? {} : { lambda: first.transform.lambda }),
	};
};

/** The projection that keeps a `Fit` off the public surface: no `Mapping`, no lazy getter. */
const project = (fit: Fit, lambda: number | undefined): FitInfo => ({
	model: fit.kind,
	pointCount: fit.points.length,
	...(lambda === undefined ? {} : { lambda }),
	points: fit.points.map((p) => ({ ...p })),
	hull: fit.hull.map((h) => ({ ...h })),
	// Touching the getter here is deliberate and the only place it happens: the cost is paid once,
	// for a caller who asked for diagnostics, rather than for every georeference in the vault.
	diagnostics: fit.diagnostics,
});

/** One query through the same path as `toPixel`; a malformed element is a null, never a throw. */
const pixelOrNull = (fit: Fit, p: LatLng, size: ImageSize): PixelResult | null => {
	if (typeof p !== "object" || p === null) return null;
	const px = toPixel(fit, p.lat, p.lng, size);
	return px === null ? null : { x: px.x, y: px.y, inBounds: px.inBounds, extrapolated: px.extrapolated };
};

const storedFit =(points: readonly ControlPoint[], model: TransformKind, lambda: number | undefined): StoredFit => ({
	bounds: null,
	transform: { model, ...(lambda === undefined ? {} : { lambda }) },
	points: points.map((p) => ({ ...p })),
});

/**
 * `ready` and `generation` are plain WRITABLE properties internally and readonly on the public
 * interface, which is Wadjet's shape. A getter would need the controller in scope inside an
 * object literal, and aliasing `this` to get it there is both banned by lint and worse to read.
 */
interface Lifecycle {
	ready: boolean;
	generation: number;
}
type BuiltApi = Omit<GebAPI, keyof Lifecycle> & Lifecycle;

export class ApiController {
	private readonly listeners = new Map<GebEvent, Set<Listener>>();
	private alive = true;
	/** Writes Geb performed. Added to the host's own counter so both move `generation`. */
	private writes = 0;
	/**
	 * What reconciliation found, per note path. ABSENT means "not checked", which is why
	 * `getImageInfo` reports `"unknown"` by default — only reconciliation reads bytes, and
	 * claiming `"same"` for an image nobody looked at is an answer nobody earned.
	 */
	private readonly staleness = new Map<string, Staleness>();
	/** Time adapters, keyed on id. Cleared on unload; consumers re-register on ready. */
	private readonly time = new TimeAdapterRegistry();
	/** The last draft `previewToPixels` fitted; see `draftFit`. Cleared on unload. */
	private draft: { readonly key: string; readonly fit: Fit; readonly size: ImageSize } | null = null;
	/** Solves `previewToPixels` performed, counted so the memo hit is assertable by mechanism. */
	draftSolves = 0;
	private readonly built: BuiltApi;
	readonly api: GebAPI;

	constructor(
		private readonly port: VaultPort,
		private readonly pluginVersion: string,
		/**
		 * The cached index. Injectable so a test can drive invalidation directly and read the
		 * memo's solve counters — proving reuse by MECHANISM rather than by timing a stopwatch.
		 */
		readonly host: IndexHost = new IndexHost(port),
	) {
		this.built = this.build();
		this.api = this.built;
	}

	markReady(): void {
		this.built.ready = true;
		this.emit("ready");
	}

	/** Listeners are cleared LAST, so an `unload` subscriber still hears the event about it. */
	unload(): void {
		this.emit("unload");
		this.alive = false;
		this.built.ready = false;
		this.listeners.clear();
		// A memoised fit for a 300-point spline holds that spline's solved matrix; there is no
		// reason to keep one alive after the plugin is gone.
		this.host.clear();
		this.draft = null;
		// Hygiene with no observable effect on the surface: every method throws after unload and
		// the plugin discards this controller. Kept because a retained reference should not keep a
		// map of verdicts alive, and labelled because no test can prove it.
		this.staleness.clear();
		// The registry is the plugin instance's: a consumer re-registers on the next `ready`.
		this.time.clear();
	}

	/** The adapter for a calendar id, or a coded throw: a consumer naming a calendar must learn it is unknown. */
	private adapter(calendar: string | undefined): TimeAdapter {
		const a = this.time.resolve(calendar);
		if (a === null) throw codedError("geb-unknown-calendar", `No time adapter is registered for calendar "${calendar ?? ""}".`);
		return a;
	}

	/**
	 * Date problems are found at QUERY time, not at index time: the index stores raw text and
	 * adapters come and go, so a bound that is unreadable today may read fine once its calendar
	 * is registered. A feature with such a bound is still returned by every query — unbounded on
	 * that side — and this is where it says so.
	 */
	private dateProblems(index: WorldIndex): Problem[] {
		const out: Problem[] = [];
		for (const f of index.features) {
			const s = span(f, (c) => this.time.resolve(c));
			if (s.problem !== null) out.push({ notePath: f.notePath, code: "bad-date", message: s.problem });
		}
		return out;
	}

	private assertLive(): void {
		if (!this.alive) {
			throw codedError("geb-unloaded", "Geb has been unloaded. Re-acquire the api on the geb:ready event.");
		}
	}

	private snapshot(): WorldIndex {
		this.assertLive();
		if (!this.built.ready) {
			throw codedError(
				"geb-not-ready",
				"The vault has not finished indexing. Wait for geb:ready — an empty answer now would be wrong rather than empty.",
			);
		}
		return this.host.snapshot();
	}

	/**
	 * Rebuild if the vault moved, and emit whatever that earned.
	 *
	 * Called by the plugin on a debounce after a vault change. A flush that found nothing emits
	 * nothing, so a body edit that left the frontmatter alone is silent rather than noise.
	 */
	flush(): ChangeSet | null {
		if (!this.alive || !this.built.ready) return null;
		const change = this.host.flush();
		if (change === null) return null;
		this.built.generation = this.host.generation + this.writes;
		for (const event of change.events) this.emit(event, change.paths);
		return change;
	}

	private emit(type: GebEvent, paths: readonly string[] = []): void {
		const payload: GebEventPayload = Object.freeze({
			type,
			generation: this.built.generation,
			paths: Object.freeze([...paths]),
		});
		for (const cb of this.listeners.get(type) ?? []) {
			try {
				cb(payload);
			} catch (e) {
				// One bad subscriber must not stop the others, and must never break unload.
				console.error(`Geb: a ${type} listener threw`, e);
			}
		}
	}

	/** Found, or thrown WITH THE REASON if the id belongs to a map that was rejected. */
	private require(index: WorldIndex, georefId: string): LoadedGeoref {
		const g = index.georefs.find((x) => x.record.id === georefId);
		if (g !== undefined) return g;
		const rejected = index.rejected.find((r) => r.id === georefId);
		throw codedError(
			"geb-no-such-georef",
			rejected === undefined
				? `No loaded georeference has id "${georefId}".`
				: `Georeference "${georefId}" is at ${rejected.notePath} but could not be used (${rejected.code}): ${rejected.reason}`,
		);
	}

	/**
	 * The fit for a draft, or null when the points cannot be fitted at all (too few, degenerate).
	 *
	 * ONE entry, keyed by content: the overlay asks again on every pan frame with the same points,
	 * and a user dragging a point mints a new key per drag, so anything larger than the last draft
	 * would only accumulate dead solves. The size is the caller's image when it passes one, and
	 * otherwise what the draft implies: the rectangle from the origin to the furthest control
	 * pixel. The caller's size matters because it sets the round-trip tolerance: four clustered
	 * points imply a small rectangle, and a tolerance built from it rejects answers `toPixels`
	 * accepts for the saved fit over the same points. The size is part of the key for that reason.
	 */
	private draftFit(
		points: readonly ControlPoint[],
		opts: TransformOptions,
		given: ImageSize | undefined,
	): { fit: Fit; size: ImageSize } | null {
		if (points.length < MIN_POINTS[opts.kind]) return null;
		const sized = given === undefined ? null : { width: given.width, height: given.height };
		const key = canonical({ points, opts, size: sized });
		if (this.draft !== null && this.draft.key === key) return this.draft;
		try {
			const fit = buildFit(points, opts, null);
			const size = sized ?? {
				width: Math.max(1, ...points.map((p) => p.px)),
				height: Math.max(1, ...points.map((p) => p.py)),
			};
			this.draftSolves += 1;
			this.draft = { key, fit, size };
			return this.draft;
		} catch {
			// Same stance as `preview`: degenerate points are an ordinary state mid-edit.
			return null;
		}
	}

	private preview(points: readonly ControlPoint[], opts: TransformOptions): FitPreview {
		const need = MIN_POINTS[opts.kind];
		if (points.length < need) {
			return {
				ok: false,
				code: "geb-too-few-points",
				message: `${opts.kind} needs at least ${need} control points; got ${points.length}.`,
			};
		}
		try {
			return { ok: true, fit: handout(project(buildFit(points, opts, null), opts.lambda)) };
		} catch (e) {
			// Degenerate points are an ordinary state while a user is still placing them, so this
			// is a RESULT rather than a throw. The kernel throwing is it doing its job.
			return { ok: false, code: "geb-degenerate-fit", message: e instanceof Error ? e.message : String(e) };
		}
	}

	/**
	 * Turn a captured write into a summary, or say why it cannot be one.
	 *
	 * A lossy capture throws: the write has landed, and answering "fine" about a record that
	 * dropped data would hide exactly what the user needs in order to fix it.
	 */
	private captured(result: ParseResult<Georeference>, notePath: string): GeorefSummary {
		this.writes += 1;
		this.built.generation = this.host.generation + this.writes;
		if (result.value === null) {
			throw codedError(
				"geb-bad-argument",
				`The write to ${notePath} did not leave a usable georeference: ${result.problems.join("; ")}`,
			);
		}
		if (result.lossy) {
			throw codedError(
				"geb-lossy-record",
				`${notePath} loaded with data dropped and must be fixed before saving: ${result.problems.join("; ")}`,
			);
		}
		return handout(summarise(result.value, notePath));
	}

	private assertPointIndex(points: readonly unknown[], i: number): void {
		if (!Number.isInteger(i) || i < 0 || i >= points.length) {
			throw codedError("geb-no-such-point", `No control point at index ${i}; this fit has ${points.length}.`);
		}
	}

	private async editPoints(
		georefId: string,
		edit: (points: readonly ControlPoint[]) => readonly ControlPoint[],
	): Promise<GeorefSummary> {
		const g = this.require(this.snapshot(), georefId);
		const first = g.record.fits[0]!;
		const opts: TransformOptions = {
			kind: first.transform.model,
			...(first.transform.lambda === undefined ? {} : { lambda: first.transform.lambda }),
		};
		const next = edit(first.points);
		// Checked BEFORE the write, so a set of points that cannot be fitted is refused rather
		// than saved and complained about afterwards.
		const check = this.preview(next, opts);
		if (!check.ok) throw codedError(check.code, check.message);

		return this.captured(
			await writeAndCapture(this.port, g.notePath, (fm) => {
				const fits = fm[KEY.fits] as Record<string, unknown>[] | undefined;
				if (fits?.[0] !== undefined) fits[0].points = next.map((p) => ({ ...p }));
			}),
			g.notePath,
		);
	}

	private async createGeoref(input: CreateGeorefInput): Promise<GeorefSummary> {
		const index = this.snapshot();
		const crs = input.crs ?? EARTH.id;
		if (getCrs(crs) === null) throw codedError("geb-unknown-crs", `"${crs}" is not a known coordinate system.`);
		if (input.id.trim() === "") throw codedError("geb-bad-argument", "A georeference needs a non-empty id.");
		if (index.georefs.some((g) => g.record.id === input.id)) {
			throw codedError("geb-duplicate-id", `Another note already claims id "${input.id}".`);
		}
		if (!(input.imageWidth > 0 && input.imageHeight > 0)) {
			throw codedError("geb-bad-argument", "An image size is required: coverage is defined as what the map pictures.");
		}
		const check = this.preview(input.points, {
			kind: input.model,
			...(input.lambda === undefined ? {} : { lambda: input.lambda }),
		});
		if (!check.ok) throw codedError(check.code, check.message);

		let bytes: ArrayBuffer;
		try {
			bytes = await this.port.readBinary(input.imagePath);
		} catch {
			throw codedError("geb-no-such-image", `Cannot read the image at ${input.imagePath}.`);
		}
		const record: Georeference = {
			id: input.id,
			imageLink: this.port.makeLink(input.imagePath, input.notePath),
			image: { width: input.imageWidth, height: input.imageHeight, byteLength: bytes.byteLength, hash: hashBytes(bytes) },
			crs,
			fits: [storedFit(input.points, input.model, input.lambda)],
		};
		return this.captured(await createAndCapture(this.port, input.notePath, toFrontmatter(record)), input.notePath);
	}

	private async updateGeoref(georefId: string, patch: UpdateGeorefPatch): Promise<GeorefSummary> {
		if (patch.crs !== undefined && getCrs(patch.crs) === null) {
			throw codedError("geb-unknown-crs", `"${patch.crs}" is not a known coordinate system.`);
		}
		const g = this.require(this.snapshot(), georefId);
		if (patch.points !== undefined) {
			const check = this.preview(patch.points, {
				kind: patch.model ?? g.record.fits[0]!.transform.model,
				...(patch.lambda === undefined ? {} : { lambda: patch.lambda }),
			});
			if (!check.ok) throw codedError(check.code, check.message);
		}
		return this.captured(
			await writeAndCapture(this.port, g.notePath, (fm) => {
				if (patch.crs !== undefined) fm[KEY.crs] = patch.crs;
				const first = (fm[KEY.fits] as Record<string, unknown>[] | undefined)?.[0];
				if (first === undefined) return;
				const transform = first.transform as Record<string, unknown>;
				if (patch.model !== undefined) transform.model = patch.model;
				if (patch.lambda !== undefined) transform.lambda = patch.lambda;
				if (patch.points !== undefined) first.points = patch.points.map((p) => ({ ...p }));
			}),
			g.notePath,
		);
	}

	private build(): BuiltApi {
		const live = (): void => {
			this.assertLive();
		};

		return {
			version: this.pluginVersion,
			apiVersion: API_VERSION,
			// Getters, so the surface reports the CURRENT lifecycle rather than a value frozen at
			// construction. `ready` is false before indexing and false again after unload.
			ready: false,
			generation: 0,
			// Copies, frozen: a consumer that mutates its copy cannot move the kernel's constant.
			minPoints: Object.freeze({ ...MIN_POINTS }),
			recommendedPoints: Object.freeze({ ...RECOMMENDED_POINTS }),

			listCrs: () => (live(), handout(listCrs())),
			getCrs: (id) => (live(), handout(getCrs(id))),

			listGeorefs: () => handout(this.snapshot().georefs.map((g) => summarise(g.record, g.notePath))),
			getGeoref: (id) => {
				const index = this.snapshot();
				const g = index.georefs.find((x) => x.record.id === id);
				// Absent is null; REJECTED throws with the reason, via require.
				if (g === undefined && index.rejected.some((r) => r.id === id)) this.require(index, id);
				return g === undefined ? null : handout(summarise(g.record, g.notePath));
			},
			getImageInfo: (id) => {
				const g = this.require(this.snapshot(), id);
				const resolved = this.port.resolveLink(linkTarget(g.record.imageLink), g.notePath);
				return handout({
					path: resolved === null ? null : resolved.path,
					width: g.record.image.width,
					height: g.record.image.height,
					byteLength: g.record.image.byteLength,
					hash: g.record.image.hash,
					// Absent from the map means NOT CHECKED, and that is reported as `"unknown"`
					// rather than defaulted to `"same"`. Only reconciliation reads bytes.
					staleness: this.staleness.get(g.notePath) ?? "unknown",
				} satisfies ImageInfo);
			},
			getFit: (id) => {
				const g = this.require(this.snapshot(), id);
				return handout(project(g.fit, g.record.fits[0]!.transform.lambda));
			},

			previewFit: (points, opts) => (live(), this.preview(points, opts)),

			toPixel: (id, lat, lng) => {
				const g = this.require(this.snapshot(), id);
				const px = toPixel(g.fit, lat, lng, g.size);
				return px === null ? null : handout({ x: px.x, y: px.y, inBounds: px.inBounds, extrapolated: px.extrapolated });
			},
			// A loop over `toPixel`, not a Float64Array kernel: identical per element by construction,
			// and the round-trip gate already reuses module-level scratch buffers.
			toPixels: (id, points) => {
				const g = this.require(this.snapshot(), id);
				return handout(points.map((p) => pixelOrNull(g.fit, p, g.size)));
			},
			previewToPixels: (points, opts, queries, size) => {
				live();
				const d = this.draftFit(points, opts, size);
				return handout(queries.map((q) => (d === null ? null : pixelOrNull(d.fit, q, d.size))));
			},
			toLatLng: (id, x, y) => {
				const g = this.require(this.snapshot(), id);
				const w = toLatLng(g.fit, x, y, g.size);
				return w === null ? null : handout({ lat: w.lat, lng: w.lng, extrapolated: w.extrapolated });
			},

			georefsCovering: (lat, lng, crs) => handout(georefsCovering(this.snapshot(), lat, lng, crs ?? EARTH.id)),
			listFeatures: () => handout(this.snapshot().features),
			featuresIn: (id, opts) => {
				const pins = featuresIn(this.snapshot(), id);
				if (pins === null) return null;
				const at = opts?.at;
				if (at === undefined) return handout(pins);
				if (!isDay(at)) throw codedError("geb-bad-argument", `at must be a whole day on the shared line within ±${DAY_LIMIT}; got ${String(at)}.`);
				return handout(pins.filter((p) => presentAt(p.feature, at, (c) => this.time.resolve(c))));
			},

			listProblems: () => {
				const index = this.snapshot();
				return handout([...index.problems, ...this.dateProblems(index)]);
			},
			listRejected: () => handout(this.snapshot().rejected),

			registerTimeAdapter: (adapter) => (live(), this.time.register(adapter)),
			listTimeAdapters: () => (live(), handout(this.time.list())),
			toDay: (text, calendar) => {
				live();
				if (typeof text !== "string") throw codedError("geb-bad-argument", "toDay takes the date as text.");
				// A consumer calling an adapter by name is told when that adapter is broken; a query
				// filtering through the same adapter is not, and reports a problem instead.
				const got = tryParse(this.adapter(calendar), text, false);
				if (got.fault !== null) throw codedError("geb-bad-adapter", got.fault);
				return got.day;
			},
			fromDay: (day, calendar) => {
				live();
				const a = this.adapter(calendar);
				if (!isDay(day)) throw codedError("geb-bad-argument", `fromDay takes a whole day on the shared line within ±${DAY_LIMIT}; got ${String(day)}.`);
				let text: unknown;
				try {
					text = a.format(day);
				} catch (e) {
					throw codedError("geb-bad-adapter", `adapter "${a.id}" threw: ${e instanceof Error ? e.message : String(e)}`);
				}
				if (typeof text !== "string") throw codedError("geb-bad-adapter", `adapter "${a.id}" formatted a day as ${typeof text}, not text`);
				return text;
			},

			createGeoref: (input) => this.createGeoref(input),
			updateGeoref: (id, patch) => this.updateGeoref(id, patch),
			deleteGeoref: async (id) => {
				const notePath = this.require(this.snapshot(), id).notePath;
				await this.port.trashNote(notePath);
				this.writes += 1;
				this.built.generation = this.host.generation + this.writes;
			},
			addPoint: (id, point) => this.editPoints(id, (pts) => [...pts, point]),
			updatePoint: (id, i, point) =>
				this.editPoints(id, (pts) => {
					this.assertPointIndex(pts, i);
					return pts.map((p, at) => (at === i ? point : p));
				}),
			removePoint: (id, i) =>
				this.editPoints(id, (pts) => {
					this.assertPointIndex(pts, i);
					return pts.filter((_, at) => at !== i);
				}),

			on: (event, cb) => {
				live();
				let set = this.listeners.get(event);
				if (set === undefined) this.listeners.set(event, (set = new Set()));
				set.add(cb);
				const target = set;
				return this.once(() => {
					target.delete(cb);
				});
			},
		};
	}

	/**
	 * Record what reconciliation found about one note's image.
	 *
	 * Called by the plugin after a reconcile pass. Before this existed, `getImageInfo` promised a
	 * staleness that nothing computed, and `main.ts` dropped every outcome it had already worked
	 * out to the console.
	 */
	recordStaleness(notePath: string, value: Staleness): void {
		this.staleness.set(notePath, value);
	}

	/** Wraps an unsubscribe so it runs at most once, per the house registry pattern. */
	private once(off: () => void): () => void {
		let done = false;
		return () => {
			if (done) return;
			done = true;
			off();
		};
	}
}
