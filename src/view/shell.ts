/**
 * The map view's DECISIONS, with no DOM in them.
 *
 * A map view's bugs are invisible by eye and obvious to an assertion, which is why stage A split
 * the arithmetic out of the element. This file is the next layer up: everything the view decides
 * — what to load, when to reload, where each pin and graticule line sits in image pixels, what the
 * readout says, how a wheel or a drag moves the viewport — happens here against the public API
 * and a small `Surface` it paints onto. The Obsidian `ItemView` in view.ts is a thin adapter that
 * implements `Surface` with real elements; the tests implement it with a recorder and drive this
 * class over the same `ApiController` and fake vault the API tests use. Nothing here imports
 * `obsidian`, so it runs under `bun test`.
 *
 * THE DOGFOODING GATE APPLIES. This file reaches Geb only through `GebAPI`; the eslint fence
 * forbids everything else. Where the API was awkward, the answer was to change the API — which
 * stage A found once already, and which this stage exists to find again.
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
 */
import { isCodedError } from "../api/errors";
import type { FitInfo, GebAPI, GebEventPayload, ImageInfo, LatLng, Pixel, PinInfo } from "../api/types";
import { coordinate, trust } from "./format";
import { graticule as planGraticule, label as graticuleLabel } from "./graticule";
import { pinAt, uncertaintyRadius } from "./pins";
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

/** Everything the surface needs to paint one state of the view. Plain data. */
export interface Frame {
	readonly image: { readonly src: string; readonly width: number; readonly height: number };
	readonly viewport: Viewport;
	readonly pins: readonly FramePin[];
	readonly lines: readonly FrameLine[];
	/** The hover readout, or an empty string when the pointer is not over the image. */
	readonly readout: string;
	/** The trust summary for the status line. */
	readonly status: string;
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
	paint(frame: Frame): void;
	/** Replace the map with a message: not ready, no such map, unloaded. */
	message(text: string): void;
	openNote(path: string): void;
}

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

export const MESSAGES = {
	indexing: "Waiting for Obsidian to finish indexing the vault.",
	unloaded: "Geb has been unloaded. Reopen this view once it is enabled again.",
	noImage: (id: string): string => `The image for "${id}" does not resolve. Check the link in its georeference note.`,
	noGeoref: (id: string): string => `No georeference with id "${id}" is loaded.`,
} as const;

export class MapShell {
	private viewport: Viewport = IDENTITY;
	private fitScale = 1;
	/** Once the user has zoomed or panned, a resize or reload must not snap the view back. */
	private userAdjusted = false;
	/** A fit was wanted while the surface had no size; do it on the next resize. */
	private pendingFit = false;

	private notePath: string | null = null;
	/** Non-null exactly when a map is on screen. Every public method is a no-op otherwise. */
	private image: ImageInfo | null = null;
	private src = "";
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
	private hover: Pixel | null = null;

	private unsubscribes: (() => void)[] = [];
	private closed = false;

	constructor(
		private readonly api: GebAPI,
		readonly georefId: string,
		private readonly surface: Surface,
	) {}

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
	 */
	private load(): void {
		if (!this.api.ready) {
			this.showMessage(MESSAGES.indexing);
			return;
		}
		try {
			const summary = this.api.getGeoref(this.georefId);
			if (summary === null) {
				this.showMessage(MESSAGES.noGeoref(this.georefId));
				return;
			}
			this.notePath = summary.notePath;
			const image = this.api.getImageInfo(this.georefId);
			if (image.path === null) {
				this.showMessage(MESSAGES.noImage(this.georefId));
				return;
			}
			this.fit = this.api.getFit(this.georefId);
			this.pins = this.api.featuresIn(this.georefId) ?? [];
			this.framePins = this.pins.map((p) => this.framePin(p));
			const firstPlacement = this.image === null;
			this.image = image;
			this.src = this.surface.imageSrc(image.path);
			this.lines = this.planLines();
			if (firstPlacement) this.fitImage();
			else this.paint();
		} catch (e) {
			// A rejected map throws here WITH ITS REASON, which is exactly what to show: a map
			// that failed to load must never read as a map that was never there.
			this.showMessage(isCodedError(e) ? e.message : String(e));
		}
	}

	/**
	 * Enter the message state: the map is GONE, not merely covered. With `image` null every
	 * public method returns at its first line, so a toolbar click or a stray hover cannot paint a
	 * dead map back over the message. Coming back is a first placement, and refits.
	 */
	private showMessage(text: string): void {
		this.image = null;
		this.fit = null;
		this.pins = [];
		this.framePins = [];
		this.lines = [];
		this.hover = null;
		this.pendingFit = false;
		this.surface.message(text);
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
	 * A tap or click at `at` in CSS pixels. Opens the nearest pin's note within `hitRadiusCss`
	 * and returns whether one was hit, so the adapter can decide what an unhit tap means on a
	 * touch screen — and can pass a finger-sized radius for one.
	 */
	tap(at: Pixel, hitRadiusCss: number = PIN_HIT_RADIUS_CSS): boolean {
		if (this.image === null) return false;
		const img = toImage(this.viewport, at);
		if (img === null) return false;
		const hit = pinAt(this.pins, img, hitRadiusCss / this.viewport.scale);
		if (hit === null) return false;
		this.surface.openNote(hit.feature.notePath);
		return true;
	}

	private readout(): string {
		if (this.hover === null || this.image === null) return "";
		const img = toImage(this.viewport, this.hover);
		if (img === null || !insideImage(this.image, img)) return "";
		const w = this.api.toLatLng(this.georefId, img.x, img.y);
		// Off the edge of where the transform means anything: say nothing rather than a number.
		if (w === null) return "";
		return coordinate(w) + (w.extrapolated ? " · extrapolated" : "");
	}

	// --- painting ----------------------------------------------------------------------------

	private paint(): void {
		if (this.image === null || this.fit === null) return;
		this.surface.paint({
			image: { src: this.src, width: this.image.width, height: this.image.height },
			viewport: this.viewport,
			pins: this.framePins,
			lines: this.lines,
			readout: this.readout(),
			status: trust(this.fit).summary,
		});
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
		const region = this.worldRegion();
		if (region === null) return [];
		const g = planGraticule(region.sw, region.ne);
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
}

/** "places/Eboracum.md" -> "Eboracum". */
function basename(path: string): string {
	const file = path.slice(path.lastIndexOf("/") + 1);
	return file.endsWith(".md") ? file.slice(0, -3) : file;
}
