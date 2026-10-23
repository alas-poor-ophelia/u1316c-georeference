/**
 * The map view's DECISIONS, with no DOM in them.
 *
 * A map view's bugs are invisible by eye and obvious to an assertion, which is why stage A split
 * the arithmetic out of the element. This file is the next layer up: everything the view decides
 * — what to load, when to reload, where each pin and graticule line sits in image pixels, what the
 * readout says, how a wheel or a drag moves the viewport, what a tap means while editing — happens
 * here against the public API and a small `Surface` it paints onto. The Obsidian `ItemView` in
 * view.ts is a thin adapter that implements `Surface` with real elements; the tests implement it
 * with a recorder and drive this class over the same `ApiController` and fake vault the API tests
 * use. Nothing here imports `obsidian`, so it runs under `bun test`.
 *
 * THE DOGFOODING GATE APPLIES. This file reaches Geb only through `GebAPI`; the eslint fence
 * forbids everything else. Where the API was awkward, the answer was to change the API — which
 * stage A found once already, and which this stage exists to find again. Stage C found two more:
 * the minimum and recommended point counts, which the editor needs and the surface did not carry.
 *
 * FRAMES ARE IN IMAGE PIXELS PLUS A VIEWPORT, not in screen pixels. The surface applies the
 * viewport as one transform on a stage holding the image and the overlay, so a pin computed once
 * at image (412, 338) stays nailed to that pixel through every zoom. Converting here would mean
 * re-deriving every pin on every wheel tick; applying one transform means the browser does it.
 *
 * THREE STATES, NOT TWO. The first version of this class modelled "open" and "closed" and nothing
 * between, and a cross-model review found four visible defects that all lived in the gap: a map
 * showing an error message still held its last good image, so a toolbar click resurrected a dead
 * or stale map over the message; a map that failed its FIRST load had no note path to match
 * change events against, so the event designed to announce its repair could never reach it; and
 * the surface's size was read while the adapter had hidden the viewport to show a message, so the
 * first fit was computed against 0x0 and the map opened at 1:1 in the corner. So: `message` is
 * a state here. Entering it clears the map, which makes every public method a no-op by the same
 * `image === null` guard, and leaving it is a first placement again. The size precondition is
 * handled by refusing to fit against an empty surface and fitting on the next resize instead.
 *
 * THE EDITOR IS A DRAFT, SAVED ONCE. Control points live here while a user places them, each
 * placement is fitted through `previewFit` (no vault, never throws) so the residuals are live, and
 * one `createGeoref` or `updateGeoref` commits the lot. The API's own guidance, and the only shape
 * that works: a new map cannot be persisted below its model's minimum point count, and a saved
 * map's every edit would otherwise be a disk write plus a full refit per click. The saved fit
 * stays on screen underneath the draft — its graticule and readout are the sanity check — while
 * the draft's own markers carry the affine residual of the fit they would make.
 *
 * A MAP WITH NO NOTE YET is the one case the API cannot describe, so the shell is handed the image
 * path directly, asks the surface to measure it (only a DOM can decode an image), and shows it
 * with no fit until the first save. From then on it is an ordinary map waiting for Obsidian's
 * change event — the index describes the pre-write state until that arrives, by design.
 */
import { isCodedError } from "../api/errors";
import type {
	ControlPoint,
	FitInfo,
	FitPreview,
	GebAPI,
	GebEventPayload,
	LatLng,
	Pixel,
	PinInfo,
	PixelResult,
	ReferenceSet,
	TransformKind,
} from "../api/types";
import { COPY } from "./copy";
import { coordinate, trust } from "./format";
import { graticule as planGraticule, label as graticuleLabel } from "./graticule";
import { nearestIndex, pinAt, uncertaintyRadius } from "./pins";
import { boxIntersects, cullToBox, decimate, lineBox, type Box } from "./reference-lines";
import { fitToContainer, IDENTITY, insideImage, panBy, toImage, zoomAbout, type Size, type Viewport } from "./viewport";

/** A pin to draw, in image pixels. */
export interface FramePin {
	readonly x: number;
	readonly y: number;
	/** The note's basename, which is what a person recognises. */
	readonly label: string;
	readonly notePath: string;
	/** Outside the control-point hull: resolved, but fuzzy. Drawn differently, never hidden. */
	readonly extrapolated: boolean;
	/** Uncertainty as a radius in image pixels, or null when the feature declares none. */
	readonly uncertaintyPx: number | null;
}

/**
 * One run of a graticule line, as a polyline in image pixels. Curved under a spline, which is
 * the point. A line the transform refuses in the middle arrives as TWO runs sharing a label —
 * both fragments are drawn, because a line that stops is the diagnostic the graticule exists for.
 */
export interface FrameLine {
	readonly axis: "lat" | "lng";
	/** Set on the longest run of each line only; the other fragments carry an empty label. */
	readonly label: string;
	readonly points: readonly Pixel[];
}

/**
 * One run of a reference line (a coastline, a river) drawn through the fit, in image pixels. A
 * line the transform refuses part-way, or that leaves the image, arrives as several runs.
 */
export interface FrameRefLine {
	readonly points: readonly Pixel[];
}

/** A draft control point to draw, in image pixels. */
export interface FrameControlPoint {
	readonly x: number;
	readonly y: number;
	readonly label: string;
	readonly selected: boolean;
	/**
	 * The affine residual of the draft's fit at this point, in image pixels — or null while the
	 * draft cannot be fitted OR has too few points for the number to mean anything. An affine fit
	 * over exactly three points reproduces them whatever the coordinates say, and a marker reading
	 * "0.0 px" beside a mistyped coordinate is the confident lie this plugin exists to avoid.
	 */
	readonly errorPx: number | null;
	/** The point with the largest residual, where a user should look first. */
	readonly worst: boolean;
}

/** The editor's state, for the toolbar. Null when not editing. */
export interface FrameEdit {
	readonly model: TransformKind;
	readonly crs: string;
	readonly pointCount: number;
	readonly minPoints: number;
	readonly recommendedPoints: number;
	readonly selected: number | null;
	/** The draft fits, so Save is possible. */
	readonly fittable: boolean;
	readonly dirty: boolean;
	readonly saving: boolean;
	/** The map has no note yet. */
	readonly creating: boolean;
	/** Why Save is or is not offered, for its tooltip. */
	readonly saveTip: string;
	/**
	 * The label of the point just deleted, so the adapter can offer to undo it. Set in the ONE
	 * frame painted right after the delete; `undoDelete` stays possible until the draft next changes.
	 */
	readonly lastDeletedLabel: string | null;
}

/** One control point's line in the fit report. */
export interface FitReportRow {
	readonly label: string;
	readonly px: number;
	readonly py: number;
	readonly lat: number;
	readonly lng: number;
	/** The affine residual, in image pixels. */
	readonly error: number;
	/** The leave-one-out error, or null where the kernel computed none (affine, a spline below four). */
	readonly loo: number | null;
	/** On the hull, so its leave-one-out error is extrapolated and not diagnostic. */
	readonly hull: boolean;
}

/** Everything the fit report dialog shows, for the fit on screen. Plain data. */
export interface FitReport {
	readonly model: TransformKind;
	readonly pointCount: number;
	readonly rms: number;
	readonly worst: { readonly label: string; readonly error: number } | null;
	readonly looRms: number | null;
	readonly coveragePct: number | null;
	/** Every note, the kernel's and the view's, in the order the status line ranks them. */
	readonly notes: readonly string[];
	readonly rows: readonly FitReportRow[];
}

/** Everything the surface needs to paint one state of the view. Plain data. */
export interface Frame {
	readonly image: { readonly src: string; readonly width: number; readonly height: number };
	readonly viewport: Viewport;
	readonly pins: readonly FramePin[];
	readonly lines: readonly FrameLine[];
	/**
	 * The reference lines through the fit on screen — the draft's while editing, else the saved
	 * one. SAME ARRAY across hovers, pans and visibility toggles; a new one only when the fit it
	 * was mapped through, the image, or the reference set changes. While `referenceVisible` is
	 * false it may be stale (a hidden overlay is not planned); it is re-planned on the next show.
	 * Always empty on a map whose CRS is not `earth`.
	 */
	readonly reference: readonly FrameRefLine[];
	/** Whether the adapter should draw `reference`. The user's toggle, default on. */
	readonly referenceVisible: boolean;
	/** The draft's control points. Empty when not editing. Same array until the draft changes. */
	readonly controlPoints: readonly FrameControlPoint[];
	/** Same object until the editor's state changes, so the adapter can skip the toolbar. */
	readonly edit: FrameEdit | null;
	/** The map has no note yet. The adapter's layout state follows this, not its own copy. */
	readonly creating: boolean;
	/** Whether "Edit" may be offered: a loaded fit, no draft, and no write awaiting the index. */
	readonly canEdit: boolean;
	/** The hover readout, or an empty string when the pointer is not over the image. */
	readonly readout: string;
	/** The trust summary for the status line. */
	readonly status: string;
	/**
	 * The convex hull of the control points in image pixels — the draft's while editing, else the
	 * loaded fit's — counter-clockwise. Empty below three points or when they enclose no area.
	 * Same array until those points change.
	 */
	readonly hull: readonly { readonly x: number; readonly y: number }[];
	/** The hull's area as a whole percentage of the image's, or null when there is no hull. */
	readonly coveragePct: number | null;
	/** Guidance over a new map whose draft is still empty, or null. */
	readonly banner: string | null;
	/** A save has been written and the index has not yet handed it back. */
	readonly pending: boolean;
	/** The fit on screen, for the report dialog: the draft's while editing, else the loaded one. */
	readonly report: FitReport | null;
}

/**
 * What the shell needs from whatever is displaying it. The DOM adapter and the test recorder.
 *
 * `size()` MAY BE EMPTY — a collapsed leaf, a hidden element — and the shell copes: it will not
 * fit the image against nothing, and fits on the next `resize()` instead. The adapter must
 * therefore keep calling `resize()` when its element becomes measurable.
 */
export interface Surface {
	/** The viewport's current size in CSS pixels. Zero-area when not laid out. */
	size(): Size;
	/** Turn a vault path into something an `<img>` can load. The only Obsidian plumbing. */
	imageSrc(path: string): string;
	/**
	 * The natural size of the image at `src`. Only a DOM can decode an image, and a map with no
	 * note yet has no stored size — `createGeoref` demands one. Rejects when it cannot load.
	 */
	measureImage(src: string): Promise<Size>;
	paint(frame: Frame): void;
	/** Replace the map with a message: not ready, no such map, unloaded. */
	message(text: string): void;
	openNote(path: string): void;
}

/** An image with no georeference note yet, and where its note will go once it has one. */
export interface CreateSource {
	readonly imagePath: string;
	readonly notePath: string;
}

/** The in-progress edit, as the workspace layout remembers it across a restart. */
export interface Draft {
	readonly model: TransformKind;
	readonly points: readonly ControlPoint[];
}

/** What a tap meant. The adapter acts on it; the shell decides it. */
export type Tap =
	| { readonly kind: "miss" }
	| { readonly kind: "note"; readonly notePath: string }
	| { readonly kind: "selected"; readonly index: number }
	/** Editing, on empty image: the adapter should ask for the coordinate of this pixel. */
	| { readonly kind: "place"; readonly pixel: Pixel };

const MISS: Tap = { kind: "miss" };
/** One empty list, so a map with no points hands every frame the same hull. */
const NO_POINTS: readonly ControlPoint[] = [];

/** Zoom bounds relative to the fit-to-container scale, so they mean the same on any image. */
const ZOOM_OUT_LIMIT = 0.25;
const ZOOM_IN_LIMIT = 32;
/** Wheel delta to zoom factor. 0.002 makes one notch of a typical mouse wheel about 1.2x. */
const WHEEL_SENSITIVITY = 0.002;
/** A single wheel event may not jump more than this either way, whatever the device reports. */
const WHEEL_STEP_LIMIT = 2;
const BUTTON_ZOOM_STEP = 1.25;
/** Hit radius for a click on a pin, in CSS pixels, so it feels the same at every zoom. */
export const PIN_HIT_RADIUS_CSS = 10;
/** A finger is wider than a cursor. Touch guidelines put a target near 44 px; this is its radius. */
export const PIN_HIT_RADIUS_TOUCH_CSS = 22;
/** Samples along each graticule line. A spline bends them, and 32 is smooth at any zoom. */
const LINE_SAMPLES = 32;
/** Grid of pixels probed to learn what world region the image pictures. */
const REGION_SAMPLES = 4;
/** A new map starts as a spline: a hand-drawn map has warp, and at three points a spline IS affine. */
export const DEFAULT_MODEL: TransformKind = "tps";
const DEFAULT_CRS = "earth";
/**
 * Reference vertices closer than this to the last one kept are dropped, in image pixels. At the
 * zoom a map opens at, a hairline cannot show detail finer than a pixel and a half, and a 10 m
 * coastline over a county-sized image puts many vertices inside every pixel.
 */
export const REFERENCE_MIN_PX = 1.5;
/** The only CRS reference data is read in. A map of anywhere else draws none. */
const REFERENCE_CRS = "earth";
/** One empty overlay, so a map that has none hands every frame the same array. */
const NO_REFERENCE: readonly FrameRefLine[] = [];
const NO_REFERENCE_SET: ReferenceSet = { lines: [], sources: [], problems: [] };

/**
 * What a reference overlay was mapped through. Two keys that agree mean the overlay planned
 * under one is still right under the other, so it is handed out again BY IDENTITY. Content, not
 * object identity: `previewFit` returns a new object per call, and a selection change or a hover
 * must not cost a re-plan.
 */
interface ReferenceKey {
	/** Bumped by `reloadReference`: the set behind the overlay changed. */
	readonly gen: number;
	readonly crs: string;
	readonly width: number;
	readonly height: number;
	/** `none`: there is no fit to map through, so the overlay is empty. */
	readonly source: "saved" | "draft" | "none";
	readonly model: TransformKind | null;
	readonly lambda: number | undefined;
	readonly points: readonly ControlPoint[];
	/**
	 * The world box the lines are culled to (`cullBox`). In the key because the points alone do
	 * not say it: `gridBox` comes from the SAVED fit, and the cull box while editing is its union
	 * with the draft's, so the same draft over a re-probed saved fit can need a different cull.
	 */
	readonly box: Box | null;
}

export const MESSAGES = {
	indexing: "Waiting for Obsidian to finish indexing the vault.",
	unloaded: "Geb has been unloaded. Reopen this view once it is enabled again.",
	noImage: (id: string): string => `The image for "${id}" does not resolve. Check the link in its georeference note.`,
	noGeoref: (id: string): string => `No georeference with id "${id}" is loaded.`,
	badImage: (path: string): string => `The image at "${path}" could not be loaded.`,
} as const;

export const STATUS = {
	saving: "Saving…",
	saved: "Saved. Waiting for Obsidian to index the note.",
	unsaved: "unsaved",
	failed: (reason: string): string => `Save failed: ${reason}`,
} as const;

/** Save's tooltip when it is offered. The adapter's own wording, moved here with the decision. */
const SAVE_TIP = "Write the control points to the georeference note";

interface EditState {
	readonly model: TransformKind;
	readonly points: readonly ControlPoint[];
	readonly selected: number | null;
	readonly preview: FitPreview;
}

export class MapShell {
	private viewport: Viewport = IDENTITY;
	private fitScale = 1;
	/** Once the user has zoomed or panned, a resize or reload must not snap the view back. */
	private userAdjusted = false;
	/** A fit was wanted while the surface had no size; do it on the next resize. */
	private pendingFit = false;

	private notePath: string | null = null;
	private crs = DEFAULT_CRS;
	/** Non-null exactly when a map is on screen. Every public method is a no-op otherwise. */
	private image: { readonly path: string; readonly width: number; readonly height: number } | null = null;
	private src = "";
	/** Null while the map has no note, or has one the index has not loaded yet. */
	private fit: FitInfo | null = null;
	private pins: readonly PinInfo[] = [];
	/**
	 * Pin geometry, computed ONCE per load and handed to every frame by reference. A hover moves
	 * the pointer sixty times a second, and each move repaints; if every repaint rebuilt this
	 * array the adapter could not tell "the readout changed" from "the pins changed" and would
	 * rebuild the whole overlay per move. Same array means nothing moved, and that is a check the
	 * adapter can make in one comparison.
	 */
	private framePins: readonly FramePin[] = [];
	private lines: readonly FrameLine[] = [];
	/** The world box the graticule was planned over, padded by one grid step; the overlay's box. */
	private gridBox: Box | null = null;
	/** The reference overlay, and what it was mapped through. Same array while the key holds. */
	private reference: readonly FrameRefLine[] = NO_REFERENCE;
	private referenceKey: ReferenceKey | null = null;
	private referenceGen = 0;
	private referenceVisible: boolean;
	private readonly references: () => ReferenceSet;
	private hover: Pixel | null = null;

	/** Set while the map has no note. Cleared the moment `createGeoref` resolves. */
	private create: CreateSource | null;
	private edit: EditState | null = null;
	/** Same two objects until the draft changes, for the same reason as `framePins`. */
	private frameControlPoints: readonly FrameControlPoint[] = [];
	private frameEdit: FrameEdit | null = null;
	private saving = false;
	/**
	 * WHAT WAS WRITTEN, while the index has not yet handed it back. A state, not a flag: while it
	 * is set the map on screen is known to be stale, so editing is refused (a draft begun from the
	 * stale fit would overwrite the write that just landed), a change event for some other note
	 * must not read as "no such georeference", and the status says what is being waited for. It
	 * clears when a load returns the same content — never on a timer, and never on an event alone,
	 * because an event can arrive before the write resolves and the index can still be behind.
	 */
	private pending: Draft | null = null;
	/** Where on the point the user pressed, so a drag moves the point by the pointer's motion. */
	private grabOffset: Pixel = { x: 0, y: 0 };
	/** Why the last save failed, until the next edit or save attempt. */
	private problem: string | null = null;
	/** Which `measureImage` answer is still wanted: a reload or a close orphans earlier ones. */
	private measureGen = 0;
	/** The point the last delete removed and where it was, until the draft next changes. */
	private undo: { readonly point: ControlPoint; readonly index: number } | null = null;
	/** The deleted point's label, for the one frame that announces the delete. */
	private deletedNotice: string | null = null;
	/**
	 * Hull and report, rebuilt only when the points or the fit they describe change, so a hover's
	 * repaint hands the adapter the same objects and it can skip the overlay and the dialog.
	 */
	private hullOf: readonly ControlPoint[] | null = null;
	private frameHull: readonly Pixel[] = [];
	private reportOf: FitInfo | null = null;
	private frameReport: FitReport | null = null;

	private unsubscribes: (() => void)[] = [];
	private closed = false;

	constructor(
		private readonly api: GebAPI,
		readonly georefId: string,
		private readonly surface: Surface,
		options: {
			readonly create?: CreateSource;
			readonly draft?: Draft;
			/** The reference lines to draw through the fit. Absent: none. Read only when planning. */
			readonly references?: () => ReferenceSet;
			/**
			 * The overlay's initial visibility, default on. A CONSTRUCTOR OPTION rather than a setter
			 * call before `open()` so the first frame is already right: the adapter restores the
			 * flag from layout state before it builds the shell, and a hidden overlay must not be
			 * planned on the way to being hidden. `setReferenceVisible` changes it afterwards.
			 */
			readonly referenceVisible?: boolean;
		} = {},
	) {
		this.references = options.references ?? ((): ReferenceSet => NO_REFERENCE_SET);
		this.referenceVisible = options.referenceVisible ?? true;
		this.create = options.create ?? null;
		// A map with no note is only ever here to be edited, so it starts editing; a restored
		// draft resumes whatever was in progress, note or no note.
		if (options.draft !== undefined) this.setEdit(options.draft.model, options.draft.points, null);
		else if (this.create !== null) this.setEdit(DEFAULT_MODEL, [], null);
	}

	// --- lifecycle -------------------------------------------------------------------------

	/**
	 * Subscribe and load. Safe to call before `api.ready`: the shell shows a message and loads
	 * itself on the `ready` event, which is how a view restored from the workspace layout at
	 * startup comes up without a race.
	 */
	open(): void {
		this.closed = false;
		try {
			for (const ev of ["ready", "unload", "georefs-changed", "fit-changed", "features-changed"] as const) {
				this.unsubscribes.push(this.api.on(ev, (p) => this.onEvent(p)));
			}
		} catch (e) {
			// `on` itself throws once the API is unloaded. There is nothing to subscribe to.
			this.showMessage(isCodedError(e) ? e.message : String(e));
			return;
		}
		this.load();
	}

	close(): void {
		this.closed = true;
		this.measureGen++;
		for (const off of this.unsubscribes) off();
		this.unsubscribes = [];
	}

	private onEvent(p: GebEventPayload): void {
		if (this.closed) return;
		switch (p.type) {
			case "ready":
				this.load();
				return;
			case "unload":
				this.close();
				this.showMessage(MESSAGES.unloaded);
				return;
			case "georefs-changed":
			case "fit-changed":
				// `paths` names the notes that moved. Empty means "somewhere", so reload; otherwise
				// reload only if it was this map — a view of another map is not woken by this one.
				// AND A MAP THIS VIEW HAS NEVER MANAGED TO LOAD HAS NO PATH TO MATCH, so any change
				// might be its arrival or its repair: reload. The first version matched on the
				// path only, and a rejected note the user then fixed could never reach its view.
				if (this.notePath === null || p.paths.length === 0 || p.paths.includes(this.notePath)) this.load();
				return;
			case "features-changed":
				// The paths here are PLACE notes, not this map's note, and any of them may have
				// landed on or left this map. Re-asking is the only honest response.
				this.load();
				return;
		}
	}

	/**
	 * Read everything from the API and paint. Every read is a synchronous snapshot, so one call
	 * cannot observe a half-updated world; the viewport survives a reload unless this is the
	 * first time the image has been placed — which includes coming back from a message.
	 *
	 * A MAP WITH NO NOTE has nothing to read: the API cannot describe an image nobody has
	 * georeferenced, so the shell places the image on its own and lets the draft carry on. The
	 * same is true for the moment after its first save, when the note exists on disk and the
	 * index still describes a world without it — a change event for some other note must not
	 * turn that moment into "no such georeference" and throw the image away.
	 */
	private load(): void {
		if (this.create !== null) {
			this.placeImage(this.create.imagePath);
			return;
		}
		if (!this.api.ready) {
			this.showMessage(MESSAGES.indexing);
			return;
		}
		try {
			const summary = this.api.getGeoref(this.georefId);
			if (summary === null) {
				if (this.pending !== null && this.image !== null) {
					this.paint();
					return;
				}
				this.showMessage(MESSAGES.noGeoref(this.georefId));
				return;
			}
			this.notePath = summary.notePath;
			this.crs = summary.crs;
			const image = this.api.getImageInfo(this.georefId);
			if (image.path === null) {
				this.showMessage(MESSAGES.noImage(this.georefId));
				return;
			}
			this.fit = this.api.getFit(this.georefId);
			this.pins = this.api.featuresIn(this.georefId) ?? [];
			this.framePins = this.pins.map((p) => this.framePin(p));
			const firstPlacement = this.image === null;
			this.image = { path: image.path, width: image.width, height: image.height };
			this.src = this.surface.imageSrc(image.path);
			this.lines = this.planLines();
			if (this.caughtUp()) this.pending = null;
			// A restored draft was fitted before the map loaded; now the lambda and the dirty
			// comparison have something to be relative to.
			if (this.edit !== null) this.setEdit(this.edit.model, this.edit.points, this.edit.selected, false);
			if (firstPlacement) this.fitImage();
			else this.paint();
		} catch (e) {
			// A rejected map throws here WITH ITS REASON, which is exactly what to show: a map
			// that failed to load must never read as a map that was never there.
			this.showMessage(isCodedError(e) ? e.message : String(e));
		}
	}

	/** The index has handed back what was written, so the map on screen is no longer stale. */
	private caughtUp(): boolean {
		const p = this.pending;
		const f = this.fit;
		if (p === null) return true;
		return f !== null && f.model === p.model && samePoints(f.points, p.points);
	}

	/**
	 * Show an image the API knows nothing about. The surface decodes it, asynchronously, and
	 * only the answer to the LATEST request is used: a close or a second load in between makes
	 * an earlier answer a message from a world that no longer exists.
	 */
	private placeImage(path: string): void {
		const src = this.surface.imageSrc(path);
		if (this.image !== null && this.src === src) {
			this.paint();
			return;
		}
		const gen = ++this.measureGen;
		void this.surface.measureImage(src).then(
			(size) => {
				if (gen !== this.measureGen) return;
				if (!(size.height > 0 && size.width > 0)) {
					this.showMessage(MESSAGES.badImage(path));
					return;
				}
				const first = this.image === null;
				this.image = { path, width: size.width, height: size.height };
				this.src = src;
				this.fit = null;
				this.notePath = null;
				this.pins = [];
				this.framePins = [];
				this.lines = [];
				this.clearReference();
				if (first) this.fitImage();
				else this.paint();
			},
			() => {
				if (gen === this.measureGen) this.showMessage(MESSAGES.badImage(path));
			},
		);
	}

	/**
	 * Enter the message state: the map is GONE, not merely covered. With `image` null every
	 * public method returns at its first line, so a toolbar click or a stray hover cannot paint a
	 * dead map back over the message. Coming back is a first placement, and refits.
	 *
	 * The DRAFT SURVIVES. A message is Geb unloading or the vault still indexing, and a user's
	 * twenty placed points are not the thing to lose over that; they come back with the image.
	 */
	private showMessage(text: string): void {
		this.image = null;
		this.fit = null;
		this.pins = [];
		this.framePins = [];
		this.lines = [];
		this.clearReference();
		this.hover = null;
		this.pendingFit = false;
		this.surface.message(text);
	}

	/** Forget the overlay and its grid box, where the graticule is forgotten. */
	private clearReference(): void {
		this.gridBox = null;
		this.reference = NO_REFERENCE;
		this.referenceKey = null;
	}

	// --- viewport ----------------------------------------------------------------------------

	/** The current viewport. Exposed for tests; the surface receives it in every frame. */
	get view(): Viewport {
		return this.viewport;
	}

	/**
	 * Fit the whole image in the container and centre it. Also the baseline the zoom limits use.
	 *
	 * REFUSES AN EMPTY SURFACE. Measured through a surface that hides its element while a message
	 * shows — as the adapter did — `size()` returned 0x0, `fitToContainer` returned the identity,
	 * and the map opened at 1:1 in the top-left with its zoom limits built on a scale of 1. So a
	 * zero-area size defers the fit to the next `resize()`, and paints with what it has so the
	 * surface at least shows the image.
	 */
	fitImage(): void {
		if (this.image === null) return;
		const size = this.surface.size();
		if (!(size.width > 0 && size.height > 0)) {
			this.pendingFit = true;
			this.paint();
			return;
		}
		this.viewport = fitToContainer(this.image, size);
		this.fitScale = this.viewport.scale;
		this.userAdjusted = false;
		this.pendingFit = false;
		this.paint();
	}

	/** The container changed size. Re-fit unless the user has taken the viewport somewhere. */
	resize(): void {
		if (this.image === null) return;
		if (this.pendingFit || !this.userAdjusted) this.fitImage();
		else this.paint();
	}

	private get limits(): { min: number; max: number } {
		return { min: this.fitScale * ZOOM_OUT_LIMIT, max: this.fitScale * ZOOM_IN_LIMIT };
	}

	/** Wheel zoom about the pointer, so the pixel under the cursor stays under the cursor. */
	wheel(at: Pixel, deltaY: number): void {
		if (this.image === null || !Number.isFinite(deltaY)) return;
		const raw = Math.exp(-deltaY * WHEEL_SENSITIVITY);
		const factor = Math.min(WHEEL_STEP_LIMIT, Math.max(1 / WHEEL_STEP_LIMIT, raw));
		this.zoomBy(factor, at);
	}

	zoomIn(): void {
		this.zoomBy(BUTTON_ZOOM_STEP, this.centre());
	}

	zoomOut(): void {
		this.zoomBy(1 / BUTTON_ZOOM_STEP, this.centre());
	}

	private zoomBy(factor: number, anchor: Pixel): void {
		if (this.image === null) return;
		const next = zoomAbout(this.viewport, anchor, factor, this.limits);
		if (next === this.viewport) return;
		this.viewport = next;
		this.userAdjusted = true;
		this.paint();
	}

	/**
	 * Pan by a CSS-pixel delta, as a drag reports it. `at` is where the pointer now is, so the
	 * readout follows the cursor through the drag instead of freezing where the press began.
	 */
	drag(dx: number, dy: number, at?: Pixel): void {
		if (this.image === null) return;
		this.viewport = panBy(this.viewport, dx, dy);
		this.userAdjusted = true;
		if (at !== undefined) this.hover = at;
		this.paint();
	}

	private centre(): Pixel {
		const s = this.surface.size();
		return { x: s.width / 2, y: s.height / 2 };
	}

	// --- pointer -----------------------------------------------------------------------------

	/**
	 * The pointer moved to `at` in CSS pixels, or left (`null`). Updates the readout. Converting
	 * the pointer INTO image space and asking the API there is what keeps the readout and the
	 * pins in agreement: they are the two directions of the same viewport.
	 */
	hoverAt(at: Pixel | null): void {
		if (this.image === null) return;
		this.hover = at;
		this.paint();
	}

	/**
	 * A tap or click at `at` in CSS pixels, within `hitRadiusCss` — the adapter passes a
	 * finger-sized radius for a touch. Viewing: opens the nearest pin's note. Editing: selects the
	 * nearest draft point, or asks for a new one on empty image. The editor owns every tap, so a
	 * place pin under a draft is not opened — a user placing points is not reading notes.
	 */
	tap(at: Pixel, hitRadiusCss: number = PIN_HIT_RADIUS_CSS): Tap {
		if (this.image === null) return MISS;
		const img = toImage(this.viewport, at);
		if (img === null) return MISS;
		if (this.edit !== null) {
			const i = this.draftPointAt(img, hitRadiusCss);
			// Mid-save the draft is being written: nothing may change it, so a tap means nothing.
			if (this.saving) return MISS;
			if (i !== null) {
				this.select(i);
				return { kind: "selected", index: i };
			}
			if (!insideImage(this.image, img)) return MISS;
			return { kind: "place", pixel: img };
		}
		const hit = pinAt(this.pins, img, hitRadiusCss / this.viewport.scale);
		if (hit === null) return MISS;
		this.surface.openNote(hit.feature.notePath);
		return { kind: "note", notePath: hit.feature.notePath };
	}

	/**
	 * A press at `at` while editing: the index of the draft point under it, now selected, or null.
	 * The adapter turns a drag that began on a point into `movePoint` calls instead of a pan.
	 */
	grab(at: Pixel, hitRadiusCss: number = PIN_HIT_RADIUS_CSS): number | null {
		if (this.locked) return null;
		const img = toImage(this.viewport, at);
		if (img === null) return null;
		const i = this.draftPointAt(img, hitRadiusCss);
		const p = i === null ? undefined : this.edit?.points[i];
		if (i !== null && p !== undefined) {
			// The press is rarely dead centre; without the offset the point jumps under the pointer
			// on the first moved pixel, and under a finger that is a jump the finger then hides.
			this.grabOffset = { x: p.px - img.x, y: p.py - img.y };
			this.select(i);
		}
		return i;
	}

	private draftPointAt(img: Pixel, hitRadiusCss: number): number | null {
		if (this.edit === null) return null;
		return nearestIndex(
			this.edit.points.map((p) => ({ x: p.px, y: p.py })),
			img,
			hitRadiusCss / this.viewport.scale,
		);
	}

	private readout(): string {
		if (this.hover === null || this.image === null) return "";
		const img = toImage(this.viewport, this.hover);
		if (img === null || !insideImage(this.image, img)) return "";
		// While editing, the pixel is the thing being chosen, so it is shown — and for a map with
		// no fit yet it is all there is to show.
		const px = this.edit === null ? "" : `${Math.round(img.x)}, ${Math.round(img.y)} px`;
		const world = this.worldReadout(img);
		if (world === "") return px;
		return px === "" ? world : `${world} · ${px}`;
	}

	private worldReadout(img: Pixel): string {
		if (this.fit === null) return "";
		const w = this.api.toLatLng(this.georefId, img.x, img.y);
		// Off the edge of where the transform means anything: say nothing rather than a number.
		if (w === null) return "";
		return coordinate(w) + (w.extrapolated ? " · extrapolated" : "");
	}

	// --- editing -----------------------------------------------------------------------------

	/** The draft, for the workspace layout to remember. Null when not editing. */
	get draft(): Draft | null {
		return this.edit === null ? null : { model: this.edit.model, points: this.edit.points };
	}

	/** True until the first save of a map that had no note. The adapter's layout state follows it. */
	get creating(): boolean {
		return this.create !== null;
	}

	// --- reference overlay -------------------------------------------------------------------

	/**
	 * Show or hide the reference overlay. Hiding repaints with the SAME `reference` array, so the
	 * adapter's identity check sees only the flag move; showing plans the overlay if it was never
	 * planned for the fit now on screen (a hidden overlay is not planned at all). Before the map
	 * loads it only records the flag.
	 */
	setReferenceVisible(visible: boolean): void {
		if (visible === this.referenceVisible) return;
		this.referenceVisible = visible;
		this.paint();
	}

	/** The reference set changed (`geb:reference-changed`): plan again from it, a new array. */
	reloadReference(): void {
		this.referenceGen++;
		this.paint();
	}

	/**
	 * Nothing may change the draft when there is none, when no map is on screen, or while it is
	 * being written — an edit landing mid-write would be neither in the file nor on screen.
	 */
	private get locked(): boolean {
		return this.edit === null || this.image === null || this.saving;
	}

	/**
	 * Start editing the loaded fit's points. Refused while a write awaits the index: the fit on
	 * screen is the PRE-write one, and a draft copied from it would carry the old points straight
	 * back over the save that just landed. The adapter disables the button on the same condition.
	 */
	beginEdit(): void {
		if (this.image === null || this.edit !== null || this.pending !== null || this.saving) return;
		this.setEdit(this.fit?.model ?? DEFAULT_MODEL, this.fit?.points ?? [], null);
	}

	/**
	 * Drop the draft. For a saved map the loaded fit is still on screen and nothing was written;
	 * for a map with no note the points are gone and the image stays, ready for a fresh start.
	 */
	discardEdit(): void {
		if (this.edit === null || this.saving) return;
		this.problem = null;
		this.undo = null;
		if (this.create !== null) {
			this.setEdit(this.edit.model, [], null);
			return;
		}
		this.edit = null;
		this.frameControlPoints = [];
		this.frameEdit = null;
		this.paint();
	}

	setModel(model: TransformKind): void {
		if (this.locked || this.edit === null) return;
		this.undo = null;
		this.setEdit(model, this.edit.points, this.edit.selected);
	}

	/** Append a point, selected. The adapter calls this once the user has given a coordinate. */
	placePoint(point: ControlPoint): void {
		if (this.locked || this.edit === null) return;
		this.undo = null;
		this.setEdit(this.edit.model, [...this.edit.points, this.clamp(point)], this.edit.points.length);
	}

	replacePoint(index: number, point: ControlPoint): void {
		if (this.locked || this.edit === null || this.edit.points[index] === undefined) return;
		const next = this.clamp(point);
		const points = this.edit.points.map((p, i) => (i === index ? next : p));
		this.undo = null;
		this.setEdit(this.edit.model, points, index);
	}

	/**
	 * Remove a point, and remember it until the draft next changes in any way — a placement, a
	 * move, a model change, another delete, a discard or a save — so one slip of a finger on a
	 * twenty-point draft costs one tap, not a re-typed coordinate.
	 */
	deletePoint(index: number): void {
		if (this.locked || this.edit === null) return;
		const point = this.edit.points[index];
		if (point === undefined) return;
		const points = this.edit.points.filter((_, i) => i !== index);
		this.undo = { point, index };
		this.deletedNotice = point.label === undefined || point.label === "" ? `point ${index + 1}` : point.label;
		this.setEdit(this.edit.model, points, null);
	}

	/** Put the last deleted point back where it was, selected. False when there is nothing to undo. */
	undoDelete(): boolean {
		const u = this.undo;
		if (this.locked || this.edit === null || u === null) return false;
		const points = [...this.edit.points];
		const index = Math.min(u.index, points.length);
		points.splice(index, 0, u.point);
		this.undo = null;
		this.deletedNotice = null;
		this.setEdit(this.edit.model, points, index);
		return true;
	}

	select(index: number | null): void {
		if (this.locked || this.edit === null) return;
		const next = index !== null && this.edit.points[index] === undefined ? null : index;
		if (next === this.edit.selected) return;
		this.setEdit(this.edit.model, this.edit.points, next);
	}

	/**
	 * Move a point's pixel with the pointer, in CSS pixels, keeping its coordinate and the offset
	 * the press began with. The readout follows the pointer as it does through a pan.
	 */
	movePoint(index: number, at: Pixel): void {
		if (this.locked || this.edit === null) return;
		const p = this.edit.points[index];
		if (p === undefined) return;
		const img = toImage(this.viewport, at);
		if (img === null) return;
		this.hover = at;
		this.replacePoint(index, { ...p, px: img.x + this.grabOffset.x, py: img.y + this.grabOffset.y });
	}

	/** A point off the edge sits on the edge rather than off the map, however it got there. */
	private clamp(p: ControlPoint): ControlPoint {
		const image = this.image;
		if (image === null) return p;
		const px = Math.min(image.width, Math.max(0, p.px));
		const py = Math.min(image.height, Math.max(0, p.py));
		return px === p.px && py === p.py ? p : { ...p, px, py };
	}

	/**
	 * Commit the draft through the public API, once. Resolves to whether it was written; the
	 * reason it was not is in the status line, and the draft stays so the user can fix it.
	 *
	 * AFTER A SAVE THE SCREEN MAY NOT CHANGE YET. The index describes the pre-write state until
	 * Obsidian's own change event arrives — the API's documented contract — so the shell records
	 * what it wrote as `pending`, says so in the status, and loads once more straight away: if the
	 * event beat the write's own promise, which nothing forbids, that load is the one that finds
	 * the new fit, and waiting for a further event would wait forever.
	 */
	async save(): Promise<boolean> {
		const e = this.edit;
		if (e === null || this.image === null || this.saving || !e.preview.ok) return false;
		this.saving = true;
		this.problem = null;
		this.undo = null;
		this.deletedNotice = null;
		this.refreshEdit();
		this.paint();
		let written = false;
		try {
			const lambda = this.fit?.lambda;
			if (this.create !== null) {
				await this.api.createGeoref({
					notePath: this.create.notePath,
					id: this.georefId,
					imagePath: this.create.imagePath,
					imageWidth: this.image.width,
					imageHeight: this.image.height,
					crs: this.crs,
					model: e.model,
					points: e.points,
				});
				this.create = null;
			} else {
				await this.api.updateGeoref(this.georefId, {
					model: e.model,
					points: e.points,
					...(lambda === undefined ? {} : { lambda }),
				});
			}
			this.pending = { model: e.model, points: e.points };
			this.edit = null;
			this.frameControlPoints = [];
			this.frameEdit = null;
			written = true;
			return true;
		} catch (err) {
			this.problem = errorText(err);
			return false;
		} finally {
			this.saving = false;
			this.refreshEdit();
			if (!this.closed) {
				if (written) this.load();
				else this.paint();
			}
		}
	}

	/**
	 * The one place the draft changes. Fits it, rebuilds the two frame objects the adapter
	 * compares by reference, and paints. `previewFit` never throws for bad points — a degenerate
	 * draft is an ordinary state — but it does throw once Geb is unloaded, and a restored draft
	 * can arrive before anything has checked that; the result shape absorbs it.
	 */
	private setEdit(model: TransformKind, points: readonly ControlPoint[], selected: number | null, repaint = true): void {
		const lambda = this.fit?.lambda;
		let preview: FitPreview;
		try {
			preview = this.api.previewFit(points, { kind: model, ...(lambda === undefined ? {} : { lambda }) });
		} catch (err) {
			preview = { ok: false, code: isCodedError(err) ? err.code : "geb-bad-argument", message: errorText(err) };
		}
		this.edit = { model, points, selected, preview };
		this.problem = null;
		this.frameControlPoints = this.controlPointFrames(this.edit);
		this.refreshEdit();
		if (repaint) this.paint();
	}

	private refreshEdit(): void {
		const e = this.edit;
		if (e === null) {
			this.frameEdit = null;
			return;
		}
		const min = this.api.minPoints[e.model];
		const dirty = this.isDirty();
		this.frameEdit = {
			model: e.model,
			crs: this.crs,
			pointCount: e.points.length,
			minPoints: min,
			recommendedPoints: this.api.recommendedPoints[e.model],
			selected: e.selected,
			fittable: e.preview.ok,
			dirty,
			saving: this.saving,
			creating: this.create !== null,
			saveTip: e.points.length < min ? COPY.tips.saveNeed(min - e.points.length) : e.preview.ok && !dirty ? COPY.tips.saveClean : SAVE_TIP,
			lastDeletedLabel: this.deletedNotice,
		};
	}

	private isDirty(): boolean {
		const e = this.edit;
		if (e === null) return false;
		if (this.fit === null) return e.points.length > 0;
		return e.model !== this.fit.model || !samePoints(e.points, this.fit.points);
	}

	/**
	 * Residuals are shown only from the count at which they carry information. Below it the
	 * marker says nothing rather than "0.0 px": the number would be true and worthless.
	 */
	private controlPointFrames(e: EditState): readonly FrameControlPoint[] {
		const informative = e.preview.ok && e.points.length >= this.api.recommendedPoints.affine;
		const errors = new Map<number, number>();
		let worst: number | null = null;
		if (informative && e.preview.ok) {
			for (const r of e.preview.fit.diagnostics.affine) {
				errors.set(r.index, r.error);
				if (worst === null || r.error > (errors.get(worst) ?? 0)) worst = r.index;
			}
		}
		return e.points.map((p, i) => ({
			x: p.px,
			y: p.py,
			label: p.label === undefined || p.label === "" ? `${i + 1}` : p.label,
			selected: i === e.selected,
			errorPx: errors.get(i) ?? null,
			worst: i === worst,
		}));
	}

	// --- painting ----------------------------------------------------------------------------

	private paint(): void {
		if (this.image === null) return;
		const image = this.image;
		const e = this.edit;
		const shown = e === null ? this.fit : e.preview.ok ? e.preview.fit : null;
		const points = e?.points ?? this.fit?.points ?? NO_POINTS;
		if (points !== this.hullOf) {
			this.hullOf = points;
			this.frameHull = pixelHull(points);
		}
		const coveragePct = coverage(this.frameHull, image);
		this.syncReference();
		if (shown !== this.reportOf) {
			this.reportOf = shown;
			this.frameReport = shown === null ? null : this.report(shown, coverage(pixelHull(shown.points), image));
		}
		this.surface.paint({
			image: { src: this.src, width: this.image.width, height: this.image.height },
			viewport: this.viewport,
			pins: this.framePins,
			lines: this.lines,
			reference: this.reference,
			referenceVisible: this.referenceVisible,
			controlPoints: this.frameControlPoints,
			edit: this.frameEdit,
			creating: this.create !== null,
			canEdit: this.edit === null && this.pending === null && !this.saving && this.fit !== null,
			readout: this.readout(),
			status: this.status(),
			hull: this.frameHull,
			coveragePct,
			banner: e !== null && this.create !== null && e.points.length === 0 ? COPY.emptyBanner : null,
			pending: this.pending !== null,
			report: this.frameReport,
		});
		// The delete is announced once. The next frame, whatever moved it, is an ordinary one.
		if (this.deletedNotice !== null) {
			this.deletedNotice = null;
			this.refreshEdit();
		}
	}

	/**
	 * The fit report: the status line's numbers, every note in full, and a row per point. The
	 * leave-one-out column is null wherever the kernel declined to compute it — an affine fit, a
	 * spline below four points — rather than a zero that would read as a perfect score.
	 */
	private report(fit: FitInfo, coveragePct: number | null): FitReport {
		const t = trust(fit, this.api.recommendedPoints[fit.model]);
		const d = fit.diagnostics;
		const affine = new Map(d.affine.map((r) => [r.index, r]));
		const loo = new Map((d.loo ?? []).map((r) => [r.index, r.error]));
		return {
			model: fit.model,
			pointCount: fit.pointCount,
			rms: t.rms,
			worst: t.worst,
			looRms: d.looRms ?? null,
			coveragePct,
			notes: t.notes,
			rows: fit.points.map((p, i) => ({
				label: p.label === undefined || p.label === "" ? `point ${i + 1}` : p.label,
				px: p.px,
				py: p.py,
				lat: p.lat,
				lng: p.lng,
				error: affine.get(i)?.error ?? 0,
				loo: loo.get(i) ?? null,
				hull: affine.get(i)?.onHull ?? false,
			})),
		};
	}

	/**
	 * The status line. While editing it describes the DRAFT's fit — that is what the user is
	 * shaping — and the kernel's own caveats ride along, so a three-point affine says why its
	 * residuals are zero without this layer repeating it. A draft outranks "saved, waiting": a
	 * restored draft on a map still being indexed is the thing the user is looking at.
	 *
	 * TOO FEW POINTS IS GUIDANCE, NOT AN ERROR. A new map opens with none, and greeting it with
	 * "thin-plate spline needs at least 3 control points; got 0." reads as something already gone
	 * wrong. Only that one refusal is reworded: any other — collinear points, a degenerate solve —
	 * is the kernel saying something the user must hear in its own words.
	 */
	private status(): string {
		if (this.problem !== null) return STATUS.failed(this.problem);
		if (this.saving) return STATUS.saving;
		const e = this.edit;
		if (e !== null) {
			const p = e.preview;
			const base = p.ok
				? trust(p.fit, this.api.recommendedPoints[e.model]).summary
				: p.code === "geb-too-few-points"
					? COPY.belowMin(e.points.length, this.api.minPoints[e.model])
					: p.message;
			return this.isDirty() ? `${base} · ${STATUS.unsaved}` : base;
		}
		if (this.pending !== null) return STATUS.saved;
		return this.fit === null ? "" : trust(this.fit, this.api.recommendedPoints[this.fit.model]).summary;
	}

	private framePin(p: PinInfo): FramePin {
		return {
			x: p.x,
			y: p.y,
			label: basename(p.feature.notePath),
			notePath: p.feature.notePath,
			extrapolated: p.extrapolated,
			uncertaintyPx: this.uncertaintyPx(p),
		};
	}

	/**
	 * A feature's uncertainty is stored in the CRS's distance unit, and only the kernel can turn
	 * that into pixels. So ask it: probe one uncertainty north AND one east of the pin, measure
	 * each distance in pixels, and take the larger. The projection maths stays where it belongs.
	 *
	 * BOTH AXES, because one is wrong. On an equirectangular map a degree of longitude is
	 * `cos(lat)` of a degree of latitude, so at 54°N the north probe alone drew a ring about 1.7x
	 * too narrow east–west — a circle that looked authoritative and was not. The larger of the two
	 * is the conservative circle: it never claims more precision than the map has in either
	 * direction. (An ellipse would be exact; a circle that is honest is enough for v1.)
	 */
	private uncertaintyPx(p: PinInfo): number | null {
		const u = p.feature.uncertainty;
		if (u === undefined || !(u > 0)) return null;
		const crs = this.api.getCrs(p.feature.crs);
		if (crs === null || !(crs.radius > 0)) return null;
		const dLat = (u / crs.radius) * (180 / Math.PI);
		const cosLat = Math.cos((p.feature.lat * Math.PI) / 180);
		const dLng = cosLat > 1e-9 ? dLat / cosLat : dLat;
		const here = { x: p.x, y: p.y };
		const north = this.api.toPixel(this.georefId, p.feature.lat + dLat, p.feature.lng);
		const east = this.api.toPixel(this.georefId, p.feature.lat, p.feature.lng + dLng);
		const rN = uncertaintyRadius(here, north === null ? null : { x: north.x, y: north.y });
		const rE = uncertaintyRadius(here, east === null ? null : { x: east.x, y: east.y });
		if (rN === null) return rE;
		if (rE === null) return rN;
		return Math.max(rN, rE);
	}

	// --- graticule ---------------------------------------------------------------------------

	/**
	 * The lat/lng grid over the image, as polylines in image pixels.
	 *
	 * The region to grid is what the image PICTURES, which the API answers one pixel at a time:
	 * probe a grid of pixels, keep the world coordinates that come back, and take their bounds.
	 * Then trace each parallel and meridian through `toPixel`, breaking the line wherever the
	 * transform refuses — a spline extrapolating past the hull is refused by the round-trip gate,
	 * and a line that simply stops there is more honest than one that wanders off — and wherever
	 * it leaves the image, because the bounding box of a rotated map's footprint overshoots the
	 * image and a grid drawn into the background around it is noise.
	 */
	private planLines(): FrameLine[] {
		this.gridBox = null;
		const region = this.worldRegion();
		if (region === null) return [];
		const g = planGraticule(region.sw, region.ne);
		// The reference overlay's box, computed here so it costs no second probe of the image.
		this.gridBox = padded(region, g.step);
		const out: FrameLine[] = [];
		for (const lat of g.lats) {
			out.push(...this.traceLine("lat", lat, g.step, (t) => ({ lat, lng: region.sw.lng + t * (region.ne.lng - region.sw.lng) })));
		}
		for (const lng of g.lngs) {
			out.push(...this.traceLine("lng", lng, g.step, (t) => ({ lat: region.sw.lat + t * (region.ne.lat - region.sw.lat), lng })));
		}
		return out;
	}

	private worldRegion(): { sw: LatLng; ne: LatLng } | null {
		if (this.image === null) return null;
		let minLat = Number.POSITIVE_INFINITY;
		let maxLat = Number.NEGATIVE_INFINITY;
		let minLng = Number.POSITIVE_INFINITY;
		let maxLng = Number.NEGATIVE_INFINITY;
		let seen = 0;
		for (let i = 0; i <= REGION_SAMPLES; i++) {
			for (let j = 0; j <= REGION_SAMPLES; j++) {
				const w = this.api.toLatLng(this.georefId, (i / REGION_SAMPLES) * this.image.width, (j / REGION_SAMPLES) * this.image.height);
				if (w === null) continue;
				seen++;
				minLat = Math.min(minLat, w.lat);
				maxLat = Math.max(maxLat, w.lat);
				minLng = Math.min(minLng, w.lng);
				maxLng = Math.max(maxLng, w.lng);
			}
		}
		// Two answers make a span; one makes a point, and a point has no grid.
		if (seen < 2 || !(maxLat > minLat) || !(maxLng > minLng)) return null;
		return { sw: { lat: minLat, lng: minLng }, ne: { lat: maxLat, lng: maxLng } };
	}

	/**
	 * Trace one line through the transform. EVERY run of two or more points is returned, not just
	 * the longest: where the gate refuses the middle of a line, the two fragments either side are
	 * exactly what shows a user their spline has folded, and the first version of this threw the
	 * shorter one away. The label rides on the longest run so it appears once.
	 */
	private traceLine(axis: "lat" | "lng", value: number, step: number, at: (t: number) => LatLng): FrameLine[] {
		const image = this.image;
		if (image === null) return [];
		const runs: Pixel[][] = [];
		let run: Pixel[] = [];
		const flush = (): void => {
			if (run.length >= 2) runs.push(run);
			run = [];
		};
		for (let k = 0; k <= LINE_SAMPLES; k++) {
			const w = at(k / LINE_SAMPLES);
			const p = this.api.toPixel(this.georefId, w.lat, w.lng);
			if (p === null || !insideImage(image, p)) {
				flush();
				continue;
			}
			run.push({ x: p.x, y: p.y });
		}
		flush();
		if (runs.length === 0) return [];
		let longest = 0;
		for (let i = 1; i < runs.length; i++) if (runs[i]!.length > runs[longest]!.length) longest = i;
		const text = graticuleLabel(value, axis, step);
		return runs.map((points, i) => ({ axis, label: i === longest ? text : "", points }));
	}

	// --- reference overlay: planning -------------------------------------------------------

	/**
	 * What the overlay should be mapped through right now: the draft's fit while editing (the
	 * overlay exists to help place points, so it follows the draft), else the saved fit.
	 */
	private wantedReferenceKey(): ReferenceKey | null {
		const image = this.image;
		if (image === null) return null;
		const base = { gen: this.referenceGen, crs: this.crs, width: image.width, height: image.height, box: this.cullBox() };
		const e = this.edit;
		if (e !== null) {
			if (!e.preview.ok) return { ...base, source: "none", model: null, lambda: undefined, points: NO_POINTS };
			return { ...base, source: "draft", model: e.model, lambda: this.fit?.lambda, points: e.points };
		}
		const f = this.fit;
		if (f === null) return { ...base, source: "none", model: null, lambda: undefined, points: NO_POINTS };
		return { ...base, source: "saved", model: f.model, lambda: f.lambda, points: f.points };
	}

	/**
	 * Called by every paint. Re-plans only when visible AND the key moved, so a hover costs one
	 * key comparison and a hidden overlay costs nothing. Every path that can change the fit on
	 * screen — load, a draft edit, discard, save, a reload of the set — paints, so none of them
	 * has to remember to call this.
	 */
	private syncReference(): void {
		if (!this.referenceVisible) return;
		const want = this.wantedReferenceKey();
		if (want === null) return;
		if (this.referenceKey !== null && sameReferenceKey(this.referenceKey, want)) return;
		this.referenceKey = want;
		const e = this.edit;
		if (want.source === "none" || want.crs !== REFERENCE_CRS) {
			this.reference = NO_REFERENCE;
		} else if (want.source === "draft" && e !== null) {
			const opts = { kind: e.model, ...(want.lambda === undefined ? {} : { lambda: want.lambda }) };
			const points = e.points;
			// The loaded image's size, so the draft's round-trip tolerance is the saved map's.
			const size = { width: want.width, height: want.height };
			this.reference = this.planReference(want.box, (q) => this.api.previewToPixels(points, opts, q, size));
		} else {
			this.reference = this.planReference(want.box, (q) => this.api.toPixels(this.georefId, q));
		}
	}

	/**
	 * The reference lines through `map`, as runs in image pixels.
	 *
	 * Cull first, in world space, because mapping is the cost: lines whose bbox misses the box go
	 * without a look, and the rest keep only the segments near the box (`cullToBox`). Every
	 * surviving run is concatenated into ONE query so the transform is entered once, not once per
	 * vertex; the runs are cut back apart by their offsets, then again wherever the transform
	 * refuses or the point leaves the image, exactly as `traceLine` cuts the graticule. Runs under
	 * two points are dropped, and the rest are decimated to what a screen can show.
	 *
	 * THE BOX is `cullBox`: the graticule's region padded by one grid step, and while editing its
	 * union with the draft's extrapolated box, so a draft that moves the map's region is culled
	 * where it now is. Earth only: any other CRS draws nothing.
	 *
	 * KNOWN LIMIT: the box is not wrapped across the antimeridian. A map spanning 180 degrees gets
	 * a box from about -180 to 180 by its probe's min/max, which culls nothing rather than too
	 * much — correct, only slower — but a box built from points either side of it can be wrong.
	 */
	private planReference(box: Box | null, map: (q: LatLng[]) => readonly (PixelResult | null)[]): FrameRefLine[] {
		const image = this.image;
		if (image === null || this.crs !== REFERENCE_CRS) return [];
		if (box === null) return [];
		const runs: LatLng[][] = [];
		for (const line of this.references().lines) {
			if (!boxIntersects(lineBox(line), box)) continue;
			for (const run of cullToBox(line, box)) runs.push(run);
		}
		if (runs.length === 0) return [];
		const queries: LatLng[] = [];
		for (const run of runs) for (const p of run) queries.push(p);
		let mapped: readonly (PixelResult | null)[];
		try {
			mapped = map(queries);
		} catch {
			// An unloaded API throws; an overlay must never be what takes the map down with it.
			return [];
		}
		const out: FrameRefLine[] = [];
		let offset = 0;
		for (const run of runs) {
			let cut: Pixel[] = [];
			const flush = (): void => {
				if (cut.length >= 2) out.push({ points: decimate(cut, REFERENCE_MIN_PX) });
				cut = [];
			};
			for (let k = 0; k < run.length; k++) {
				const hit = mapped[offset + k] ?? null;
				if (hit === null || !insideImage(image, hit)) {
					flush();
					continue;
				}
				cut.push({ x: hit.x, y: hit.y });
			}
			flush();
			offset += run.length;
		}
		return out;
	}

	/**
	 * The box to cull to: the saved fit's `gridBox`, and while editing its UNION with `draftBox`.
	 * `gridBox` alone is stale the moment a draft moves the map's world region — lines would be
	 * culled at where the map USED to be — and the draft box alone would drop the saved region a
	 * user may be about to move back to. Null when neither exists.
	 *
	 * A draft still identical to the saved fit (just begun, or edited back) keeps `gridBox` alone:
	 * it IS the saved fit, so that box is not stale, and a union would move the key and hand the
	 * adapter a new array for the same picture.
	 */
	private cullBox(): Box | null {
		const e = this.edit;
		const f = this.fit;
		if (e !== null && f !== null && e.model === f.model && samePoints(e.points, f.points)) return this.gridBox;
		return unionBox(this.gridBox, this.draftBox());
	}

	/**
	 * The draft's box: the control points' world bbox extrapolated linearly to the whole image by
	 * the points' pixel bbox, padded by one grid step. Points placed in one corner say little about
	 * the far corner, and the extrapolation is what a near-affine draft will put there; anything
	 * bent further is what the union with `gridBox` and the pad are for. Null without a draft fit.
	 */
	private draftBox(): Box | null {
		const e = this.edit;
		const image = this.image;
		if (e === null || !e.preview.ok || image === null) return null;
		let south = Number.POSITIVE_INFINITY;
		let north = Number.NEGATIVE_INFINITY;
		let west = Number.POSITIVE_INFINITY;
		let east = Number.NEGATIVE_INFINITY;
		let px0 = Number.POSITIVE_INFINITY;
		let px1 = Number.NEGATIVE_INFINITY;
		let py0 = Number.POSITIVE_INFINITY;
		let py1 = Number.NEGATIVE_INFINITY;
		// The sign of each axis's covariance with its pixel axis: which image edge each world end
		// lies past. Latitude usually falls as `py` grows; a mirrored scan need not.
		let mx = 0;
		let my = 0;
		let mlat = 0;
		let mlng = 0;
		for (const p of e.points) {
			south = Math.min(south, p.lat);
			north = Math.max(north, p.lat);
			west = Math.min(west, p.lng);
			east = Math.max(east, p.lng);
			px0 = Math.min(px0, p.px);
			px1 = Math.max(px1, p.px);
			py0 = Math.min(py0, p.py);
			py1 = Math.max(py1, p.py);
			mx += p.px;
			my += p.py;
			mlat += p.lat;
			mlng += p.lng;
		}
		if (!(north >= south && east >= west)) return null;
		const n = e.points.length;
		mx /= n;
		my /= n;
		mlat /= n;
		mlng /= n;
		let covLng = 0;
		let covLat = 0;
		for (const p of e.points) {
			covLng += (p.px - mx) * (p.lng - mlng);
			covLat += (p.py - my) * (p.lat - mlat);
		}
		const [w, ea] = extrapolate(px0, px1, west, east, image.width, covLng >= 0);
		const [s, no] = extrapolate(py0, py1, south, north, image.height, covLat >= 0);
		const sw = { lat: s, lng: w };
		const ne = { lat: no, lng: ea };
		return padded({ sw, ne }, planGraticule(sw, ne).step);
	}
}

/** A world region grown by `by` degrees on every side. */
function padded(region: { readonly sw: LatLng; readonly ne: LatLng }, by: number): Box {
	return { south: region.sw.lat - by, west: region.sw.lng - by, north: region.ne.lat + by, east: region.ne.lng + by };
}

/**
 * Whether an overlay planned under `a` is still right under `b`. `source` is deliberately NOT
 * compared: a draft just begun from the saved fit, or discarded back to it, describes the same fit
 * by its points, model and lambda, and re-planning it would hand the adapter a new array for an
 * identical picture. `none` still differs from any fit through its null model.
 */
function sameReferenceKey(a: ReferenceKey, b: ReferenceKey): boolean {
	return (
		a.gen === b.gen &&
		a.crs === b.crs &&
		a.width === b.width &&
		a.height === b.height &&
		a.model === b.model &&
		a.lambda === b.lambda &&
		sameBox(a.box, b.box) &&
		(a.points === b.points || samePoints(a.points, b.points))
	);
}

function sameBox(a: Box | null, b: Box | null): boolean {
	if (a === null || b === null) return a === b;
	return a.south === b.south && a.west === b.west && a.north === b.north && a.east === b.east;
}

/** The smallest box holding both; either may be absent. */
function unionBox(a: Box | null, b: Box | null): Box | null {
	if (a === null) return b;
	if (b === null) return a;
	return {
		south: Math.min(a.south, b.south),
		west: Math.min(a.west, b.west),
		north: Math.max(a.north, b.north),
		east: Math.max(a.east, b.east),
	};
}

/**
 * The world interval the whole image axis `[0, extent]` implies, from points spanning pixels
 * `[p0, p1]` and world `[w0, w1]`: linear, so a draft whose points cover one corner still culls
 * for the rest of the image. `rising` says the world value grows with the pixel (longitude on a
 * map drawn east-right); latitude on a north-up map falls as `py` grows, so its low end is the
 * one past the BOTTOM edge. A zero pixel span has no slope to extend by, so the points' own
 * interval stands; the caller pads it.
 */
function extrapolate(p0: number, p1: number, w0: number, w1: number, extent: number, rising: boolean): [number, number] {
	const span = p1 - p0;
	if (!(span > 0)) return [w0, w1];
	const perPx = (w1 - w0) / span;
	const before = p0 * perPx;
	const after = (extent - p1) * perPx;
	return rising ? [w0 - before, w1 + after] : [w0 - after, w1 + before];
}

/**
 * The convex hull of the points' PIXELS, counter-clockwise, or empty when they enclose no area.
 *
 * The fit carries its hull in world space, and the view draws in image pixels; an affine image of
 * the world hull would be close and not the same polygon under a spline. The kernel's own
 * `convexHull` is behind the dogfooding fence, so this is the same monotone chain, over pixels.
 * KNOWN LIMIT: the kernel flags hull membership in world space (lng, lat) and this outline is
 * drawn in pixel space; under a strongly bent spline, or a map crossing the antimeridian, a
 * report row's hull flag and the drawn outline can disagree. For a near-affine map they agree.
 * Exported so a test can hold it against the kernel's: a second copy of an algorithm is only
 * acceptable while something proves the two still agree.
 */
export function pixelHull(points: readonly ControlPoint[]): Pixel[] {
	const pts = points.map((p) => ({ x: p.px, y: p.py })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
	if (pts.length < 3) return [];
	pts.sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
	const cross = (o: Pixel, a: Pixel, b: Pixel): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
	const chain = (seq: readonly Pixel[]): Pixel[] => {
		const out: Pixel[] = [];
		for (const p of seq) {
			while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop();
			out.push(p);
		}
		out.pop();
		return out;
	};
	const hull = [...chain(pts), ...chain([...pts].reverse())];
	return hull.length >= 3 ? hull : [];
}

/** A hull's area as a whole percentage of the image's, by the shoelace formula. */
function coverage(hull: readonly Pixel[], image: Size): number | null {
	if (hull.length < 3 || !(image.width > 0 && image.height > 0)) return null;
	let twice = 0;
	for (let i = 0; i < hull.length; i++) {
		const a = hull[i]!;
		const b = hull[(i + 1) % hull.length]!;
		twice += a.x * b.y - b.x * a.y;
	}
	// Capped: a note may hold a point beyond the image's edge, and a trusted area wider than the
	// map is a data error to report elsewhere, not a percentage over a hundred.
	return Math.min(100, Math.round((Math.abs(twice) / 2 / (image.width * image.height)) * 100));
}

/** "places/Eboracum.md" -> "Eboracum". */
function basename(path: string): string {
	const file = path.slice(path.lastIndexOf("/") + 1);
	return file.endsWith(".md") ? file.slice(0, -3) : file;
}

/** For the status line: the message, without a thrown value's own "Error:" prefix. */
function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Field-by-field, so a draft that merely re-orders nothing and re-types nothing is clean. */
function samePoints(a: readonly ControlPoint[], b: readonly ControlPoint[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((p, i) => {
		const q = b[i]!;
		return p.px === q.px && p.py === q.py && p.lat === q.lat && p.lng === q.lng && (p.label ?? "") === (q.label ?? "");
	});
}
