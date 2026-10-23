/**
 * The Obsidian leaf that shows a georeferenced map: a thin adapter over `MapShell`.
 *
 * Everything that decides anything lives in shell.ts and is tested there without an app. This
 * file owns the elements, turns DOM events into shell calls, and paints frames — the shell hands
 * it image-pixel geometry plus a viewport, and one CSS transform on the stage does the rest.
 *
 * WHY A LEAF VIEW AND NOT A CODE-BLOCK EMBED. The control-point editor writes frontmatter to a
 * georeference note, and an embed inside that same note would be re-rendered by its own save —
 * editing the thing you are standing on. A leaf holds its viewport and selection across
 * re-renders, serialises its georef id AND ITS DRAFT into the workspace layout, and restores on
 * reopen: twenty placed points survive an app restart on a phone. An embed can come later as a
 * read-only consumer of the same shell.
 *
 * MOBILE IS A TARGET (`isDesktopOnly: false`), so every gesture is a pointer event — mouse and
 * touch alike — the readout updates on move and on tap, zoom has buttons as well as a wheel, and
 * the places where touch differs from a mouse are handled by `pointerType`, not by guessing.
 *
 * THE MESSAGE IS AN OVERLAY, NOT A REPLACEMENT. The first version hid the viewport element to
 * show a message, and the shell's very next act was to measure that element for its first fit —
 * 0x0, so the map opened at 1:1 in the corner. The viewport now stays laid out at all times; the
 * message covers it, the stage underneath is hidden, and the toolbar is disabled.
 *
 * THE EDITOR'S DIALOGS ARE THE ONLY ASYNC HERE. A tap on empty image while editing is a request
 * for a coordinate; the shell says so, this file opens the modal, and the answer goes back to the
 * shell as one call. The shell never waits on anything the DOM does.
 */
import { ItemView, Notice, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { ControlPoint, GebAPI, Pixel, TransformKind } from "../api/types";
import { COPY } from "./copy";
import { ConfirmModal, discardPrompt, FitReportModal, ModelsModal } from "./dialogs";
import { PointModal } from "./modals";
import {
	MapShell,
	PIN_HIT_RADIUS_CSS,
	PIN_HIT_RADIUS_TOUCH_CSS,
	type CreateSource,
	type Draft,
	type Frame,
	type Surface,
	type Tap,
} from "./shell";

export const VIEW_TYPE = "geb-georef";

export interface GeorefViewState {
	readonly georefId: string;
	/** Present while the map has no note yet. */
	readonly create?: CreateSource;
	/** The in-progress edit, so a restart does not lose it. */
	readonly draft?: Draft;
}

/** Movement past this many CSS pixels turns a press into a drag rather than a tap. */
const DRAG_THRESHOLD = 3;
/** Screen-size pin: radius of the dot and offset of its label, in CSS pixels. */
const PIN_RADIUS = 5;
const LABEL_OFFSET = 8;
/** A control-point marker is a square, so it reads differently from a round place pin. */
const CP_HALF = 5;
/** Wheel `deltaMode` 1 (lines) and 2 (pages) scaled to pixels, so a notch means the same everywhere. */
const DELTA_LINE_PX = 16;
const DELTA_PAGE_PX = 400;
/** The hull's dash and gap, in CSS pixels; scaled into image units like the hairline. */
const HULL_DASH = 6;
const HULL_GAP = 4;
/** Long enough to reach Undo after reading the notice, short enough not to linger. */
const UNDO_NOTICE_MS = 8000;
const EDIT_TIP = "Edit the control points";

const MODELS: readonly { readonly kind: TransformKind; readonly name: string }[] = [
	{ kind: "affine", name: "Affine" },
	{ kind: "polynomial2", name: "Polynomial (2nd order)" },
	{ kind: "tps", name: "Thin-plate spline" },
];

interface Painted {
	src: string;
	pins: Frame["pins"];
	lines: Frame["lines"];
	controlPoints: Frame["controlPoints"];
	hull: Frame["hull"];
	edit: Frame["edit"];
	scale: number;
	viewport: Frame["viewport"];
}

export class GeorefView extends ItemView implements Surface {
	georefId = "";
	private create: CreateSource | null = null;
	/** A draft from the layout, handed to the next shell booted and then forgotten. */
	private restoredDraft: Draft | null = null;
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
	private resizeObserver: ResizeObserver | null = null;
	private buttons: HTMLButtonElement[] = [];
	private editBtn: HTMLButtonElement | null = null;
	private editBar: HTMLElement | null = null;
	private modelSelect: HTMLSelectElement | null = null;
	private editPointBtn: HTMLButtonElement | null = null;
	private deletePointBtn: HTMLButtonElement | null = null;
	private saveBtn: HTMLButtonElement | null = null;
	private discardBtn: HTMLButtonElement | null = null;
	private reportBtn: HTMLButtonElement | null = null;
	private bannerEl: HTMLElement | null = null;
	private legendEl: HTMLElement | null = null;
	/** The one live undo notice: the shell holds a single undo slot, so an older notice must not outlive it. */
	private undoNotice: Notice | null = null;
	/** What the overlay and stage were last built from, so a repaint can skip what did not move. */
	private painted: Painted | null = null;
	/**
	 * The frame painted last. The shell paints synchronously inside each call, so after a
	 * `deletePoint` this is the frame that carries the deleted point's label.
	 */
	private lastFrame: Frame | null = null;

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
		if (this.georefId === "") return "Georeference";
		return this.create === null ? `Map: ${this.georefId}` : `New map: ${this.georefId}`;
	}

	override getIcon(): string {
		return "map";
	}

	// --- state: what the workspace layout remembers ----------------------------------------------

	override getState(): Record<string, unknown> {
		const state: Record<string, unknown> = { georefId: this.georefId };
		if (this.create !== null) state.create = this.create;
		const draft = this.shell?.draft ?? this.restoredDraft;
		if (draft !== null) state.draft = draft;
		return state;
	}

	/**
	 * Obsidian may call this BEFORE `onOpen` (restoring a leaf from the layout) or after it
	 * (a leaf opened by `setViewState`). Both orders work: with no DOM yet, `boot` returns and
	 * `onOpen` boots; with a DOM, `boot` replaces the shell. Verified by tracing both orders in
	 * review, not by running Obsidian — stage D does that.
	 *
	 * The draft is read here and used by the NEXT boot only. Nothing in the layout is trusted
	 * beyond its shape: a point with a non-finite number is dropped, not fitted.
	 */
	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = state as Partial<GeorefViewState> | null | undefined;
		const id = typeof s?.georefId === "string" ? s.georefId : "";
		const create = readCreate(s?.create);
		const same = id === this.georefId && create?.imagePath === this.create?.imagePath && create?.notePath === this.create?.notePath;
		if (!same) {
			this.georefId = id;
			this.create = create;
			this.restoredDraft = readDraft(s?.draft);
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
		// The draft outlives the shell: a leaf closed mid-edit and reopened from history resumes.
		this.restoredDraft = this.shell?.draft ?? this.restoredDraft;
		this.shell?.close();
		this.shell = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.painted = null;
		this.lastFrame = null;
		this.viewportEl = null;
		this.stageEl = null;
		this.imageEl = null;
		this.overlayEl = null;
		this.readoutEl = null;
		this.statusEl = null;
		this.messageEl = null;
		this.buttons = [];
		this.editBtn = null;
		this.editBar = null;
		this.modelSelect = null;
		this.editPointBtn = null;
		this.deletePointBtn = null;
		this.saveBtn = null;
		this.discardBtn = null;
		this.reportBtn = null;
		this.bannerEl = null;
		this.legendEl = null;
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
		this.lastFrame = null;
		if (this.georefId === "") {
			this.message("Open this view from a georeference note, or georeference an image.");
			return;
		}
		const api = this.getApi();
		if (api === null) {
			this.message("Geb is not loaded.");
			return;
		}
		const draft = this.restoredDraft;
		this.restoredDraft = null;
		this.shell = new MapShell(api, this.georefId, this, {
			...(this.create === null ? {} : { create: this.create }),
			...(draft === null ? {} : { draft }),
		});
		this.shell.open();
	}

	// --- DOM -----------------------------------------------------------------------------------

	private buildDom(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("geb-view");

		const toolbar = root.createDiv({ cls: "geb-toolbar" });
		const button = (parent: HTMLElement, label: string, title: string, onClick: () => void): HTMLButtonElement => {
			const b = parent.createEl("button", { text: label, attr: { "aria-label": title, title } });
			this.registerDomEvent(b, "click", () => onClick());
			this.buttons.push(b);
			return b;
		};
		button(toolbar, "+", "Zoom in", () => this.shell?.zoomIn());
		button(toolbar, "−", "Zoom out", () => this.shell?.zoomOut());
		button(toolbar, "Fit", "Fit the whole map in the view", () => this.shell?.fitImage());
		this.editBtn = button(toolbar, "Edit", EDIT_TIP, () => this.shell?.beginEdit());

		const bar = toolbar.createSpan({ cls: "geb-edit-bar" });
		this.editBar = bar;
		const select = bar.createEl("select", { cls: "dropdown", attr: { "aria-label": "Transform model" } });
		for (const m of MODELS) select.createEl("option", { text: m.name, value: m.kind });
		this.registerDomEvent(select, "change", () => this.shell?.setModel(select.value as TransformKind));
		this.modelSelect = select;
		button(bar, COPY.models.button, COPY.models.tip, () => new ModelsModal(this.app, MODELS).open());
		this.editPointBtn = button(bar, "Edit point…", "Change the selected point's coordinate", () => this.editSelected());
		this.deletePointBtn = button(bar, "Delete point", "Remove the selected point", () => this.deleteSelected());
		this.saveBtn = button(bar, "Save", "Write the control points to the georeference note", () => void this.shell?.save());
		this.discardBtn = button(bar, "Discard", "Drop the unsaved changes", () => this.discard());
		bar.hide();

		// Details and the status travel together at the right-hand end, so the button sits beside
		// the line it explains and the line still takes whatever room is left.
		const tail = toolbar.createSpan({ cls: "geb-toolbar-tail" });
		this.reportBtn = button(tail, COPY.report.button, COPY.report.tip, () => this.openReport());
		this.reportBtn.hide();
		this.statusEl = tail.createSpan({ cls: "geb-status" });

		const vp = root.createDiv({ cls: "geb-viewport" });
		this.viewportEl = vp;
		this.stageEl = vp.createDiv({ cls: "geb-stage" });
		this.imageEl = this.stageEl.createEl("img", { cls: "geb-image", attr: { alt: "" } });
		this.overlayEl = this.stageEl.createSvg("svg", { cls: "geb-overlay" });
		this.readoutEl = vp.createDiv({ cls: "geb-readout" });
		// Over the map but never in its way: both ignore the pointer, so a tap through them lands.
		this.bannerEl = vp.createDiv({ cls: "geb-banner" });
		this.bannerEl.hide();
		this.legendEl = this.buildLegend(vp);
		this.legendEl.hide();
		// Inside the viewport, over the stage: the viewport keeps its size while a message shows.
		this.messageEl = vp.createDiv({ cls: "geb-message" });
		this.messageEl.hide();

		// THE LEAF CAN BE LAID OUT AFTER onOpen, and Obsidian's `onResize` does not always say so.
		// Measured live after a plugin reload: the first fit ran against a viewport 19 px tall,
		// scale 0.06, and nothing refitted it — a map the size of a postage stamp in the corner,
		// which is the stage-B defect in a new coat. The shell's `resize` refits only until the
		// user has taken the viewport somewhere, so observing is safe at every moment after.
		this.resizeObserver = new ResizeObserver(() => this.shell?.resize());
		this.resizeObserver.observe(vp);

		this.wirePointer(vp);
	}

	/**
	 * The key to the overlay, built once. Each symbol carries the overlay's own classes, so a
	 * theme that recolours a pin or a marker recolours its legend entry with it.
	 */
	private buildLegend(vp: HTMLElement): HTMLElement {
		const legend = vp.createDiv({ cls: "geb-legend" });
		const row = (text: string, draw: (svg: SVGSVGElement) => void): void => {
			const r = legend.createDiv({ cls: "geb-legend-row" });
			const svg = r.createSvg("svg", { cls: "geb-legend-symbol" });
			svg.setAttribute("width", "14");
			svg.setAttribute("height", "14");
			svg.setAttribute("viewBox", "-7 -7 14 14");
			draw(svg);
			r.createSpan({ text });
		};
		row(COPY.legend.control, (svg) => {
			const mark = svg.createSvg("rect", { cls: "geb-cp" });
			mark.setAttribute("x", String(-CP_HALF));
			mark.setAttribute("y", String(-CP_HALF));
			mark.setAttribute("width", String(2 * CP_HALF));
			mark.setAttribute("height", String(2 * CP_HALF));
		});
		row(COPY.legend.place, (svg) => {
			svg.createSvg("circle", { cls: "geb-pin" }).setAttribute("r", String(PIN_RADIUS));
		});
		row(COPY.legend.extrapolated, (svg) => {
			const dot = svg.createSvg("circle");
			dot.classList.add("geb-pin");
			dot.classList.add("geb-extrapolated");
			dot.setAttribute("r", String(PIN_RADIUS));
		});
		row(COPY.legend.hull, (svg) => {
			const line = svg.createSvg("line", { cls: "geb-hull" });
			line.setAttribute("x1", "-7");
			line.setAttribute("y1", "0");
			line.setAttribute("x2", "7");
			line.setAttribute("y2", "0");
			line.setAttribute("stroke-width", "1.5");
			line.setAttribute("stroke-dasharray", "3 2");
		});
		return legend;
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
	 *
	 * WHILE EDITING, a press on a control point grabs it, and the drag that follows moves the
	 * point instead of the map. The shell decides which; this file only remembers the answer.
	 */
	private wirePointer(vp: HTMLElement): void {
		let active: number | null = null;
		let pressed: Pixel | null = null;
		let last: Pixel | null = null;
		let dragged = false;
		let grabbed: number | null = null;

		const local = (e: PointerEvent | WheelEvent): Pixel => {
			const r = vp.getBoundingClientRect();
			return { x: e.clientX - r.left, y: e.clientY - r.top };
		};
		const radius = (e: PointerEvent): number => (e.pointerType === "mouse" ? PIN_HIT_RADIUS_CSS : PIN_HIT_RADIUS_TOUCH_CSS);
		const reset = (): void => {
			active = null;
			pressed = null;
			last = null;
			dragged = false;
			grabbed = null;
			vp.removeClass("geb-dragging");
		};

		this.registerDomEvent(vp, "pointerdown", (e) => {
			if (e.button !== 0 || active !== null) return;
			active = e.pointerId;
			pressed = local(e);
			last = pressed;
			dragged = false;
			grabbed = this.shell?.grab(pressed, radius(e)) ?? null;
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
					if (grabbed !== null) this.shell?.movePoint(grabbed, at);
					// The readout follows the cursor through the drag rather than freezing.
					else this.shell?.drag(at.x - last.x, at.y - last.y, at);
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
			const r = radius(e);
			reset();
			if (vp.hasPointerCapture(e.pointerId)) vp.releasePointerCapture(e.pointerId);
			if (wasTap) this.onTap(this.shell?.tap(at, r) ?? { kind: "miss" }, at);
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

	/** Act on what the shell said a tap meant. A tap that opened nothing still updates the readout. */
	private onTap(tap: Tap, at: Pixel): void {
		switch (tap.kind) {
			case "note":
				return;
			case "place":
				this.askPoint({ px: tap.pixel.x, py: tap.pixel.y }, (p) => this.shell?.placePoint(p));
				return;
			case "selected":
			case "miss":
				// How a touch screen reads a coordinate at all.
				this.shell?.hoverAt(at);
				return;
		}
	}

	private askPoint(initial: ControlPoint | { px: number; py: number }, then: (p: ControlPoint) => void): void {
		const api = this.getApi();
		if (api === null) return;
		new PointModal(this.app, api, this.painted?.edit?.crs ?? "earth", initial, then).open();
	}

	private editSelected(): void {
		const i = this.painted?.edit?.selected ?? null;
		const point = i === null ? undefined : this.shell?.draft?.points[i];
		if (i === null || point === undefined) return;
		this.askPoint(point, (p) => this.shell?.replacePoint(i, p));
	}

	/**
	 * Immediate, because a confirmation on every delete teaches people to click through it; the
	 * notice's Undo is the safety net instead. The shell paints inside `deletePoint`, so the frame
	 * painted last is the one that names the point.
	 */
	private deleteSelected(): void {
		const i = this.painted?.edit?.selected ?? null;
		if (i === null) return;
		this.shell?.deletePoint(i);
		const label = this.lastFrame?.edit?.lastDeletedLabel ?? null;
		if (label === null) return;
		// A second delete replaces the undo slot, so the first notice's Undo would restore the
		// SECOND point under the first point's name. Hide it.
		this.undoNotice?.hide();
		const notice = new Notice(
			createFragment((f) => {
				f.appendText(`${COPY.deleted(label)} `);
				const undo = f.createEl("button", { text: COPY.undo });
				undo.addEventListener("click", () => {
					this.shell?.undoDelete();
					notice.hide();
				});
			}),
			UNDO_NOTICE_MS,
		);
		this.undoNotice = notice;
	}

	/** Ask first when there is work to lose; otherwise drop the draft as before. */
	private discard(): void {
		const edit = this.lastFrame?.edit ?? null;
		const body = edit === null ? null : discardPrompt(edit);
		if (body === null) {
			this.shell?.discardEdit();
			return;
		}
		new ConfirmModal(this.app, COPY.discard.title, body, COPY.discard.confirm, COPY.discard.cancel, () => this.shell?.discardEdit()).open();
	}

	private openReport(): void {
		const report = this.lastFrame?.report ?? null;
		if (report !== null) new FitReportModal(this.app, report).open();
	}

	// --- Surface -------------------------------------------------------------------------------

	size(): { width: number; height: number } {
		const r = this.viewportEl?.getBoundingClientRect();
		return { width: r?.width ?? 0, height: r?.height ?? 0 };
	}

	imageSrc(path: string): string {
		return this.app.vault.adapter.getResourcePath(path);
	}

	/** Decode off-screen. The natural size is what `createGeoref` stores and coverage is defined by. */
	measureImage(src: string): Promise<{ width: number; height: number }> {
		return new Promise((resolve, reject) => {
			// Detached: never appended, so it decodes without being laid out.
			const img = createEl("img");
			img.addEventListener("load", () => resolve({ width: img.naturalWidth, height: img.naturalHeight }));
			img.addEventListener("error", () => reject(new Error(`Could not load ${src}`)));
			img.src = src;
		});
	}

	message(text: string): void {
		this.painted = null;
		this.lastFrame = null;
		this.messageEl?.setText(text);
		this.messageEl?.show();
		this.stageEl?.hide();
		this.readoutEl?.setText("");
		this.statusEl?.setText("");
		this.statusEl?.removeAttribute("title");
		this.bannerEl?.hide();
		this.legendEl?.hide();
		this.reportBtn?.hide();
		for (const b of this.buttons) b.disabled = true;
		if (this.modelSelect !== null) this.modelSelect.disabled = true;
		// The draft survives underneath, but its controls over a message would be a lie.
		this.editBar?.hide();
		this.editBtn?.show();
	}

	paint(frame: Frame): void {
		const stage = this.stageEl;
		const img = this.imageEl;
		const svg = this.overlayEl;
		if (stage === null || img === null || svg === null) return;
		this.messageEl?.hide();
		stage.show();
		// The shell owns "this leaf is a create leaf": once the first save lands the layout must
		// stop saying so, or a restart boots the map back into create mode over its own note.
		const createCleared = frame.creating === false && this.create !== null;
		if (createCleared) this.create = null;

		// The readout and status are cheap and always set. The transform is set when the viewport
		// moved. The overlay is REBUILT only when its geometry did — the shell hands back the same
		// `pins`, `lines` and `controlPoints` arrays until something changes, so reference equality
		// is the whole test — or when the SCALE changed, because pins and labels are counter-scaled
		// by it. A pan alone moves the stage and touches nothing inside it: the first version
		// compared the whole viewport and rebuilt every pin on every pixel of a drag.
		const prev = this.painted;
		const { width, height } = frame.image;
		const { scale, offsetX, offsetY } = frame.viewport;
		const draftChanged = prev === null || prev.controlPoints !== frame.controlPoints;
		const editChanged = prev === null || prev.edit !== frame.edit;
		const geometryChanged =
			prev === null || draftChanged || prev.src !== frame.image.src || prev.pins !== frame.pins || prev.lines !== frame.lines || prev.hull !== frame.hull || prev.scale !== scale;
		const viewportChanged = prev === null || prev.viewport !== frame.viewport;
		this.painted = { src: frame.image.src, pins: frame.pins, lines: frame.lines, controlPoints: frame.controlPoints, hull: frame.hull, edit: frame.edit, scale, viewport: frame.viewport };
		this.lastFrame = frame;

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
		// The line ellipsizes in a narrow leaf; hovering it reads the whole thing.
		this.statusEl?.setAttribute("title", frame.status);
		if (frame.banner === null) this.bannerEl?.hide();
		else {
			this.bannerEl?.setText(frame.banner);
			this.bannerEl?.show();
		}
		this.legendEl?.toggle(frame.hull.length > 0 || frame.pins.length > 0);
		this.reportBtn?.toggle(frame.report !== null);
		// EVERY paint, not only when the edit state moved: the first version re-enabled every
		// button on each paint and synced the editor's enable states only on a change, so the
		// first hover after any edit showed Save enabled on a clean draft.
		this.syncToolbar(frame);
		// The layout holds the draft and the create flag, so a change to either is worth a save.
		if (draftChanged || editChanged || createCleared) this.app.workspace.requestSaveLayout();
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
		// The trusted area, over the graticule and under every pin and marker. In image pixels
		// like the graticule, so its stroke and its dashes are scaled back to screen size.
		if (frame.hull.length > 0) {
			const hull = svg.createSvg("polygon", { cls: "geb-hull" });
			hull.setAttribute("points", frame.hull.map((p) => `${p.x},${p.y}`).join(" "));
			hull.setAttribute("stroke-width", String(1.5 / scale));
			hull.setAttribute("stroke-dasharray", `${HULL_DASH / scale} ${HULL_GAP / scale}`);
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
			// `classList.add`, not `cls`: the SVG factory's `cls` refuses a token with a space in it
			// (measured live, as an InvalidCharacterError that left the point dialog open).
			const dot = g.createSvg("circle");
			dot.classList.add("geb-pin");
			if (pin.extrapolated) dot.classList.add("geb-extrapolated");
			dot.setAttribute("r", String(PIN_RADIUS));
			const label = g.createSvg("text", { cls: "geb-pin-label" });
			label.setAttribute("x", String(LABEL_OFFSET));
			label.setAttribute("y", String(PIN_RADIUS));
			label.textContent = pin.label;
		}
		// Control points last, over everything: while editing they are what the user is working on.
		for (const cp of frame.controlPoints) {
			const g = svg.createSvg("g");
			g.setAttribute("transform", `translate(${cp.x} ${cp.y}) scale(${1 / scale})`);
			const mark = g.createSvg("rect");
			mark.classList.add("geb-cp");
			if (cp.selected) mark.classList.add("geb-cp-selected");
			if (cp.worst) mark.classList.add("geb-cp-worst");
			mark.setAttribute("x", String(-CP_HALF));
			mark.setAttribute("y", String(-CP_HALF));
			mark.setAttribute("width", String(2 * CP_HALF));
			mark.setAttribute("height", String(2 * CP_HALF));
			const label = g.createSvg("text", { cls: "geb-cp-label" });
			label.setAttribute("x", String(LABEL_OFFSET));
			label.setAttribute("y", String(-CP_HALF));
			label.textContent = cp.errorPx === null ? cp.label : `${cp.label} · ${cp.errorPx.toFixed(1)} px`;
		}
	}

	/** Show the editing controls or the Edit button, and enable exactly what the state allows. */
	private syncToolbar(frame: Frame): void {
		const edit = frame.edit;
		for (const b of this.buttons) b.disabled = false;
		this.editBtn?.setAttribute("title", frame.pending ? COPY.tips.editPending : EDIT_TIP);
		if (edit === null) {
			this.editBar?.hide();
			this.editBtn?.show();
			if (this.editBtn !== null) this.editBtn.disabled = !frame.canEdit;
			return;
		}
		this.editBtn?.hide();
		this.editBar?.show();
		if (this.modelSelect !== null) this.modelSelect.value = edit.model;
		if (this.modelSelect !== null) this.modelSelect.disabled = edit.saving;
		const noSelection = edit.selected === null || edit.saving;
		if (this.editPointBtn !== null) this.editPointBtn.disabled = noSelection;
		if (this.deletePointBtn !== null) this.deletePointBtn.disabled = noSelection;
		if (this.saveBtn !== null) this.saveBtn.disabled = edit.saving || !edit.fittable || !edit.dirty;
		this.saveBtn?.setAttribute("title", edit.saveTip);
		this.saveBtn?.setAttribute("aria-label", edit.saveTip);
		if (this.discardBtn !== null) this.discardBtn.disabled = edit.saving;
	}

	openNote(path: string): void {
		void this.app.workspace.openLinkText(path, "", false);
	}
}

const MODEL_KINDS: ReadonlySet<string> = new Set(MODELS.map((m) => m.kind));

function readCreate(raw: unknown): CreateSource | null {
	const c = raw as Partial<CreateSource> | null | undefined;
	if (typeof c?.imagePath !== "string" || typeof c.notePath !== "string") return null;
	return { imagePath: c.imagePath, notePath: c.notePath };
}

function readDraft(raw: unknown): Draft | null {
	const d = raw as { model?: unknown; points?: unknown } | null | undefined;
	if (typeof d?.model !== "string" || !MODEL_KINDS.has(d.model) || !Array.isArray(d.points)) return null;
	const points: ControlPoint[] = [];
	for (const p of d.points as unknown[]) {
		const q = p as Partial<ControlPoint> | null;
		if (q === null || typeof q !== "object") continue;
		const { px, py, lat, lng, label } = q;
		if (![px, py, lat, lng].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
		points.push(typeof label === "string" && label !== "" ? { px: px!, py: py!, lat: lat!, lng: lng!, label } : { px: px!, py: py!, lat: lat!, lng: lng! });
	}
	return { model: d.model as TransformKind, points };
}
