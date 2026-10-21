/**
 * The Obsidian leaf that shows a georeferenced map: a thin adapter over `MapShell`.
 *
 * Everything that decides anything lives in shell.ts and is tested there without an app. This
 * file owns the elements, turns DOM events into shell calls, and paints frames — the shell hands
 * it image-pixel geometry plus a viewport, and one CSS transform on the stage does the rest.
 *
 * WHY A LEAF VIEW AND NOT A CODE-BLOCK EMBED. The control-point editor (stage C) writes
 * frontmatter to a georeference note, and an embed inside that same note would be re-rendered by
 * its own save — editing the thing you are standing on. A leaf holds its viewport and selection
 * across re-renders, serialises its georef id into the workspace layout, and restores on reopen.
 * An embed can come later as a read-only consumer of the same shell.
 *
 * MOBILE IS A TARGET (`isDesktopOnly: false`), so every gesture is a pointer event — mouse and
 * touch alike — the readout updates on move and on tap, zoom has buttons as well as a wheel, and
 * the places where touch differs from a mouse are handled by `pointerType`, not by guessing.
 *
 * THE MESSAGE IS AN OVERLAY, NOT A REPLACEMENT. The first version hid the viewport element to
 * show a message, and the shell's very next act was to measure that element for its first fit —
 * 0x0, so the map opened at 1:1 in the corner. The viewport now stays laid out at all times; the
 * message covers it, the stage underneath is hidden, and the toolbar is disabled.
 */
import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { GebAPI, Pixel } from "../api/types";
import { MapShell, PIN_HIT_RADIUS_CSS, PIN_HIT_RADIUS_TOUCH_CSS, type Frame, type Surface } from "./shell";

export const VIEW_TYPE = "geb-georef";

export interface GeorefViewState {
	readonly georefId: string;
}

/** Movement past this many CSS pixels turns a press into a drag rather than a tap. */
const DRAG_THRESHOLD = 3;
/** Screen-size pin: radius of the dot and offset of its label, in CSS pixels. */
const PIN_RADIUS = 5;
const LABEL_OFFSET = 8;
/** Wheel `deltaMode` 1 (lines) and 2 (pages) scaled to pixels, so a notch means the same everywhere. */
const DELTA_LINE_PX = 16;
const DELTA_PAGE_PX = 400;

export class GeorefView extends ItemView implements Surface {
	georefId = "";
	private shell: MapShell | null = null;
	/** Set by onClose. A setState that arrives afterwards must not boot a shell nobody closes. */
	private disposed = false;

	private viewportEl: HTMLElement | null = null;
	private stageEl: HTMLElement | null = null;
	private imageEl: HTMLImageElement | null = null;
	private overlayEl: SVGSVGElement | null = null;
	private readoutEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private messageEl: HTMLElement | null = null;
	private buttons: HTMLButtonElement[] = [];
	/** What the overlay and stage were last built from, so a repaint can skip what did not move. */
	private painted: { src: string; pins: Frame["pins"]; lines: Frame["lines"]; scale: number; viewport: Frame["viewport"] } | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		/**
		 * A GETTER, not the object, so the view sees `null` after `geb:unload` instead of holding a
		 * dead API. Inferred from the plugin lifecycle rather than measured: after a disable and
		 * re-enable Obsidian rebuilds views of a re-registered type through the NEW factory, which
		 * carries the new plugin instance's getter; a view instance that somehow survived would
		 * keep the old instance's getter, see `null` forever, and sit on its unload message — the
		 * honest outcome for a view whose plugin went away, if not the ideal one.
		 */
		private readonly getApi: () => GebAPI | null,
	) {
		super(leaf);
		this.navigation = false;
	}

	override getViewType(): string {
		return VIEW_TYPE;
	}

	override getDisplayText(): string {
		return this.georefId === "" ? "Georeference" : `Map: ${this.georefId}`;
	}

	override getIcon(): string {
		return "map";
	}

	// --- state: the georef id is what the workspace layout remembers ---------------------------

	override getState(): Record<string, unknown> {
		return { georefId: this.georefId };
	}

	/**
	 * Obsidian may call this BEFORE `onOpen` (restoring a leaf from the layout) or after it
	 * (a leaf opened by `setViewState`). Both orders work: with no DOM yet, `boot` returns and
	 * `onOpen` boots; with a DOM, `boot` replaces the shell. Verified by tracing both orders in
	 * review, not by running Obsidian — stage D does that.
	 */
	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = state as Partial<GeorefViewState> | null | undefined;
		const id = typeof s?.georefId === "string" ? s.georefId : "";
		if (id !== this.georefId) {
			this.georefId = id;
			this.boot();
		}
		await super.setState(state, result);
	}

	// --- lifecycle -----------------------------------------------------------------------------

	override onOpen(): Promise<void> {
		this.disposed = false;
		this.buildDom();
		this.boot();
		return Promise.resolve();
	}

	override onClose(): Promise<void> {
		this.disposed = true;
		this.shell?.close();
		this.shell = null;
		this.painted = null;
		this.viewportEl = null;
		this.stageEl = null;
		this.imageEl = null;
		this.overlayEl = null;
		this.readoutEl = null;
		this.statusEl = null;
		this.messageEl = null;
		this.buttons = [];
		return Promise.resolve();
	}

	override onResize(): void {
		this.shell?.resize();
	}

	/** (Re)create the shell for the current id. Idempotent; a second call replaces the first. */
	private boot(): void {
		if (this.disposed || this.viewportEl === null) return; // no DOM yet, or gone for good
		this.shell?.close();
		this.shell = null;
		this.painted = null;
		if (this.georefId === "") {
			this.message("Open this view from a georeference note.");
			return;
		}
		const api = this.getApi();
		if (api === null) {
			this.message("Geb is not loaded.");
			return;
		}
		this.shell = new MapShell(api, this.georefId, this);
		this.shell.open();
	}

	// --- DOM -----------------------------------------------------------------------------------

	private buildDom(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("geb-view");

		const toolbar = root.createDiv({ cls: "geb-toolbar" });
		const button = (label: string, title: string, onClick: () => void): void => {
			const b = toolbar.createEl("button", { text: label, attr: { "aria-label": title, title } });
			this.registerDomEvent(b, "click", () => onClick());
			this.buttons.push(b);
		};
		button("+", "Zoom in", () => this.shell?.zoomIn());
		button("−", "Zoom out", () => this.shell?.zoomOut());
		button("Fit", "Fit the whole map in the view", () => this.shell?.fitImage());
		this.statusEl = toolbar.createSpan({ cls: "geb-status" });

		const vp = root.createDiv({ cls: "geb-viewport" });
		this.viewportEl = vp;
		this.stageEl = vp.createDiv({ cls: "geb-stage" });
		this.imageEl = this.stageEl.createEl("img", { cls: "geb-image", attr: { alt: "" } });
		this.overlayEl = this.stageEl.createSvg("svg", { cls: "geb-overlay" });
		this.readoutEl = vp.createDiv({ cls: "geb-readout" });
		// Inside the viewport, over the stage: the viewport keeps its size while a message shows.
		this.messageEl = vp.createDiv({ cls: "geb-message" });
		this.messageEl.hide();

		this.wirePointer(vp);
	}

	/**
	 * One pointer model for mouse and touch, tracking ONE pointer at a time by id. A press that
	 * moves past the threshold is a drag, one that does not is a tap; moves update the readout
	 * whether or not a button is down, so a finger sliding over the map reads coordinates the way
	 * a hovering mouse does. The four places touch differs from a mouse are each handled by
	 * `pointerType` rather than assumed away:
	 *   - a finger lifting fires `pointerleave` right after `pointerup`, which would erase the
	 *     readout the tap just produced, so leave is ignored for anything but a mouse;
	 *   - a finger is wide, so its tap uses the touch hit radius;
	 *   - a second finger must not hijack the first one's drag, so other pointer ids are ignored;
	 *   - a cancelled pointer is never a tap, and a lost capture ends the drag cleanly.
	 */
	private wirePointer(vp: HTMLElement): void {
		let active: number | null = null;
		let pressed: Pixel | null = null;
		let last: Pixel | null = null;
		let dragged = false;

		const local = (e: PointerEvent | WheelEvent): Pixel => {
			const r = vp.getBoundingClientRect();
			return { x: e.clientX - r.left, y: e.clientY - r.top };
		};
		const reset = (): void => {
			active = null;
			pressed = null;
			last = null;
			dragged = false;
			vp.removeClass("geb-dragging");
		};

		this.registerDomEvent(vp, "pointerdown", (e) => {
			if (e.button !== 0 || active !== null) return;
			active = e.pointerId;
			pressed = local(e);
			last = pressed;
			dragged = false;
			vp.setPointerCapture(e.pointerId);
		});
		this.registerDomEvent(vp, "pointermove", (e) => {
			if (active !== null && e.pointerId !== active) return;
			const at = local(e);
			if (pressed !== null && last !== null) {
				if (!dragged && Math.hypot(at.x - pressed.x, at.y - pressed.y) > DRAG_THRESHOLD) {
					dragged = true;
					vp.addClass("geb-dragging");
				}
				if (dragged) {
					// The readout follows the cursor through the drag rather than freezing.
					this.shell?.drag(at.x - last.x, at.y - last.y, at);
					last = at;
					return;
				}
			}
			this.shell?.hoverAt(at);
		});
		const release = (e: PointerEvent, cancelled: boolean): void => {
			if (active === null || e.pointerId !== active) return;
			const at = local(e);
			const wasTap = !dragged && !cancelled;
			const touch = e.pointerType !== "mouse";
			reset();
			if (vp.hasPointerCapture(e.pointerId)) vp.releasePointerCapture(e.pointerId);
			if (wasTap) {
				// A tap that hits no pin still updates the readout, which is how a touch screen
				// reads a coordinate at all.
				const hit = this.shell?.tap(at, touch ? PIN_HIT_RADIUS_TOUCH_CSS : PIN_HIT_RADIUS_CSS) ?? false;
				if (!hit) this.shell?.hoverAt(at);
			}
		};
		this.registerDomEvent(vp, "pointerup", (e) => release(e, false));
		this.registerDomEvent(vp, "pointercancel", (e) => release(e, true));
		this.registerDomEvent(vp, "lostpointercapture", () => reset());
		this.registerDomEvent(vp, "pointerleave", (e) => {
			// A finger lifting "leaves" immediately after its tap; its readout must survive that.
			if (e.pointerType === "mouse" && active === null) this.shell?.hoverAt(null);
		});
		this.registerDomEvent(
			vp,
			"wheel",
			(e) => {
				e.preventDefault();
				const unit = e.deltaMode === 1 ? DELTA_LINE_PX : e.deltaMode === 2 ? DELTA_PAGE_PX : 1;
				this.shell?.wheel(local(e), e.deltaY * unit);
			},
			{ passive: false },
		);
	}

	// --- Surface -------------------------------------------------------------------------------

	size(): { width: number; height: number } {
		const r = this.viewportEl?.getBoundingClientRect();
		return { width: r?.width ?? 0, height: r?.height ?? 0 };
	}

	imageSrc(path: string): string {
		return this.app.vault.adapter.getResourcePath(path);
	}

	message(text: string): void {
		this.painted = null;
		this.messageEl?.setText(text);
		this.messageEl?.show();
		this.stageEl?.hide();
		this.readoutEl?.setText("");
		this.statusEl?.setText("");
		for (const b of this.buttons) b.disabled = true;
	}

	paint(frame: Frame): void {
		const stage = this.stageEl;
		const img = this.imageEl;
		const svg = this.overlayEl;
		if (stage === null || img === null || svg === null) return;
		this.messageEl?.hide();
		stage.show();
		for (const b of this.buttons) b.disabled = false;

		// The readout and status are cheap and always set. The transform is set when the viewport
		// moved. The overlay is REBUILT only when its geometry did — the shell hands back the same
		// `pins` and `lines` arrays until a reload, so reference equality is the whole test — or
		// when the SCALE changed, because pins and labels are counter-scaled by it. A pan alone
		// moves the stage and touches nothing inside it: the first version compared the whole
		// viewport and rebuilt every pin on every pixel of a drag.
		const prev = this.painted;
		const { width, height } = frame.image;
		const { scale, offsetX, offsetY } = frame.viewport;
		const geometryChanged = prev === null || prev.src !== frame.image.src || prev.pins !== frame.pins || prev.lines !== frame.lines || prev.scale !== scale;
		const viewportChanged = prev === null || prev.viewport !== frame.viewport;
		this.painted = { src: frame.image.src, pins: frame.pins, lines: frame.lines, scale, viewport: frame.viewport };

		if (prev === null || prev.src !== frame.image.src) img.src = frame.image.src;
		if (viewportChanged) {
			// ONE transform for image and overlay together, so they cannot disagree by a pixel.
			stage.setCssStyles({
				width: `${width}px`,
				height: `${height}px`,
				transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
			});
		}
		this.readoutEl?.setText(frame.readout);
		this.statusEl?.setText(frame.status);
		if (!geometryChanged) return;

		svg.setAttribute("width", String(width));
		svg.setAttribute("height", String(height));
		svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
		// Strokes drawn in image pixels would scale with the stage — at 32x a hairline is a road.
		// `vector-effect` is not trusted to see a CSS transform on an HTML ancestor, so the width
		// is set explicitly in image units to come out as one screen pixel.
		const hairline = String(1 / scale);

		svg.empty();
		// Graticule first, under the pins.
		for (const line of frame.lines) {
			const path = svg.createSvg("polyline", { cls: "geb-graticule" });
			path.setAttribute("points", line.points.map((p) => `${p.x},${p.y}`).join(" "));
			path.setAttribute("stroke-width", hairline);
			const first = line.points[0];
			if (line.label !== "" && first !== undefined) {
				const text = svg.createSvg("text", { cls: "geb-graticule-label" });
				// Counter-scaled so the label stays readable at every zoom.
				text.setAttribute("transform", `translate(${first.x} ${first.y}) scale(${1 / scale})`);
				text.setAttribute("dx", "3");
				text.setAttribute("dy", "-3");
				text.textContent = line.label;
			}
		}
		for (const pin of frame.pins) {
			if (pin.uncertaintyPx !== null) {
				const ring = svg.createSvg("circle", { cls: "geb-pin-uncertainty" });
				ring.setAttribute("cx", String(pin.x));
				ring.setAttribute("cy", String(pin.y));
				ring.setAttribute("r", String(pin.uncertaintyPx));
				ring.setAttribute("stroke-width", hairline);
			}
		}
		for (const pin of frame.pins) {
			// The dot and label are positioned in image pixels and counter-scaled, so a pin is
			// nailed to its pixel but drawn at a constant screen size. Dots after every ring, so
			// no ring's fill covers a neighbour's dot.
			const g = svg.createSvg("g");
			g.setAttribute("transform", `translate(${pin.x} ${pin.y}) scale(${1 / scale})`);
			const dot = g.createSvg("circle", { cls: pin.extrapolated ? "geb-pin geb-extrapolated" : "geb-pin" });
			dot.setAttribute("r", String(PIN_RADIUS));
			const label = g.createSvg("text", { cls: "geb-pin-label" });
			label.setAttribute("x", String(LABEL_OFFSET));
			label.setAttribute("y", String(PIN_RADIUS));
			label.textContent = pin.label;
		}
	}

	openNote(path: string): void {
		void this.app.workspace.openLinkText(path, "", false);
	}
}
