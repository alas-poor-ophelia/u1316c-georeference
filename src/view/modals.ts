/**
 * The editor's dialogs: a world coordinate for a placed pixel, and where a new map's note goes.
 *
 * Obsidian `Modal`s, which the fence allows — this IS the Obsidian layer. They decide nothing
 * about the map: the shell owns the draft and the API owns what is valid. The checks here exist
 * so that a value the API would refuse is refused beside the field it was typed into, with the
 * reason, rather than after a click with a notice. The API's own validation still runs on save.
 */
import { type App, FuzzySuggestModal, Modal, Notice, Setting, type TextComponent } from "obsidian";
import type { ControlPoint, FeatureInfo, GebAPI, GeorefSummary } from "../api/types";
import { COPY } from "./copy";
import { parsePair } from "./coords";
import { readPointForm } from "./pointform";

/** What `PointModal` starts from: a pixel always, a coordinate when editing an existing point. */
export interface PointDraft {
	readonly px: number;
	readonly py: number;
	readonly lat?: number;
	readonly lng?: number;
	readonly label?: string;
}

type Field = "px" | "py" | "lat" | "lng" | "label";

export class PointModal extends Modal {
	private readonly inputs = new Map<Field, TextComponent>();
	private errorEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly api: GebAPI,
		/** The map's coordinate system, so a latitude of 500 is refused here with the range. */
		private readonly crs: string,
		private readonly initial: PointDraft,
		private readonly onSubmit: (point: ControlPoint) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		const fresh = this.initial.lat === undefined;
		this.titleEl.setText(fresh ? "New control point" : "Control point");
		contentEl.addClass("geb-point-modal");
		// A first-time user has just clicked the map and now faces two empty fields. Say where the
		// numbers come from, once, on a new point; a point being corrected needs no reminder.
		if (fresh) contentEl.createEl("p", { cls: "setting-item-description", text: COPY.coords.source });

		this.field("px", "Pixel x", numberText(this.initial.px));
		this.field("py", "Pixel y", numberText(this.initial.py));
		// Coordinates at FULL precision: three decimals of latitude is a hundred metres, and a
		// user opening this dialog to fix a label must not have the coordinate rounded under them.
		this.field("lat", "Latitude", exactText(this.initial.lat), COPY.coords.latHint);
		this.field("lng", "Longitude", exactText(this.initial.lng), COPY.coords.lngHint);
		this.field("label", "Label", this.initial.label ?? "", "Optional. Shown beside the marker and named in the residuals.");

		new Setting(contentEl)
			.setName("From a place note")
			.setDesc("Use the coordinate and label from a note that already carries coordinates.")
			.addButton((b) =>
				b.setButtonText("Pick…").onClick(() => {
					new PlacePicker(this.app, this.features(), (f) => this.fill(f)).open();
				}),
			);

		this.errorEl = contentEl.createDiv({ cls: "geb-form-error" });
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Save point")
				.setCta()
				.onClick(() => this.submit()),
		);
	}

	override onClose(): void {
		this.contentEl.empty();
		this.inputs.clear();
		this.errorEl = null;
	}

	private field(key: Field, name: string, value: string, desc?: string): void {
		const s = new Setting(this.contentEl).setName(name);
		if (desc !== undefined) s.setDesc(desc);
		s.addText((t) => {
			t.setValue(value);
			// Enter anywhere submits, as a form would.
			t.inputEl.addEventListener("keydown", (e) => {
				// Not while an input method is composing: that Enter commits the composition.
				if (e.key === "Enter" && !e.isComposing) this.submit();
			});
			// A PASTED pair fills both fields. On the paste event only, never on input: wired to
			// every keystroke it fired at "51 3" and overwrote the longitude a user was typing.
			if (key === "lat") {
				t.inputEl.addEventListener("paste", (e) => {
					if (this.splitPair(e.clipboardData?.getData("text") ?? "")) e.preventDefault();
				});
			}
			this.inputs.set(key, t);
		});
	}

	private features(): readonly FeatureInfo[] {
		try {
			return this.api.listFeatures();
		} catch {
			// Not ready, or unloaded: an empty list, and the picker says so.
			return [];
		}
	}

	private fill(f: FeatureInfo): void {
		this.inputs.get("lat")?.setValue(String(f.lat));
		this.inputs.get("lng")?.setValue(String(f.lng));
		const label = this.inputs.get("label");
		if (label !== undefined && label.getValue().trim() === "") label.setValue(basename(f.notePath));
	}

	private submit(): void {
		const text = (key: Field): string => this.inputs.get(key)?.getValue() ?? "";
		const read = readPointForm(
			{ px: text("px"), py: text("py"), lat: text("lat"), lng: text("lng"), label: text("label") },
			this.crsInfo(),
		);
		if (!read.ok) return this.errorEl?.setText(read.error);
		this.onSubmit(read.point);
		this.close();
	}

	/**
	 * A pair pasted into the latitude field is split across both. `parsePair` is null for a single
	 * number, so typing "51.5074" never fires this; it runs once, on the paste that completes a pair.
	 */
	/** Fill both fields from pasted text holding a pair. True when it did, so the paste is consumed. */
	private splitPair(text: string): boolean {
		const lat = this.inputs.get("lat");
		const lng = this.inputs.get("lng");
		if (lat === undefined || lng === undefined || lng.getValue().trim() !== "") return false;
		const pair = parsePair(text);
		if (pair === null) return false;
		lat.setValue(String(pair.lat));
		lng.setValue(String(pair.lng));
		new Notice(COPY.coords.pairFilled);
		return true;
	}

	private crsInfo(): { readonly name: string; readonly latRange: readonly [number, number]; readonly lngRange: readonly [number, number] } | null {
		try {
			return this.api.getCrs(this.crs);
		} catch {
			return null;
		}
	}
}

/** Place notes by name, for filling a control point from one. */
class PlacePicker extends FuzzySuggestModal<FeatureInfo> {
	constructor(
		app: App,
		private readonly items: readonly FeatureInfo[],
		private readonly onPick: (f: FeatureInfo) => void,
	) {
		super(app);
		this.setPlaceholder(items.length === 0 ? "No place notes carry coordinates yet." : "Place note…");
	}

	getItems(): FeatureInfo[] {
		return [...this.items];
	}

	getItemText(f: FeatureInfo): string {
		return `${basename(f.notePath)}  ${f.lat}, ${f.lng}`;
	}

	onChooseItem(f: FeatureInfo): void {
		this.onPick(f);
	}
}

/** What a new map needs before its first point: an id and a note path, prefilled and editable once. */
export interface CreateChoice {
	readonly id: string;
	readonly notePath: string;
}

export class CreateGeorefModal extends Modal {
	private id: string;
	private notePath: string;
	private errorEl: HTMLElement | null = null;

	constructor(
		app: App,
		defaults: CreateChoice,
		/** Why this choice cannot be used — an id already claimed, a note already there — or null. */
		private readonly refuse: (choice: CreateChoice) => string | null,
		private readonly onSubmit: (choice: CreateChoice) => void,
	) {
		super(app);
		this.id = defaults.id;
		this.notePath = defaults.notePath;
	}

	override onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText("Georeference this image");
		new Setting(contentEl)
			.setName("Georeference ID")
			.setDesc(COPY.create.idHint)
			.addText((t) => t.setValue(this.id).onChange((v) => (this.id = v)));
		new Setting(contentEl)
			.setName("Note path")
			.setDesc(COPY.create.notePathHint)
			.addText((t) => t.setValue(this.notePath).onChange((v) => (this.notePath = v)));
		this.errorEl = contentEl.createDiv({ cls: "geb-form-error" });
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Place points")
				.setCta()
				.onClick(() => this.submit()),
		);
	}

	override onClose(): void {
		this.contentEl.empty();
		this.errorEl = null;
	}

	private submit(): void {
		const id = this.id.trim();
		let notePath = this.notePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
		if (notePath !== "" && !notePath.toLowerCase().endsWith(".md")) notePath += ".md";
		if (id === "") return this.errorEl?.setText("An ID is required.");
		if (notePath === "" || notePath.endsWith("/.md")) return this.errorEl?.setText("A note path is required.");
		const why = this.refuse({ id, notePath });
		if (why !== null) return this.errorEl?.setText(why);
		this.onSubmit({ id, notePath });
		this.close();
	}
}

/** Pixels, to a thousandth: a tap never chose more than that. */
function numberText(n: number | undefined): string {
	return n === undefined ? "" : String(Math.round(n * 1000) / 1000);
}

function exactText(n: number | undefined): string {
	return n === undefined ? "" : String(n);
}

/** "places/Eboracum.md" -> "Eboracum". */
function basename(path: string): string {
	const file = path.slice(path.lastIndexOf("/") + 1);
	return file.endsWith(".md") ? file.slice(0, -3) : file;
}

/** Every loaded map, for the ribbon icon and the "Open maps" command. */
export class MapPicker extends FuzzySuggestModal<GeorefSummary> {
	constructor(
		app: App,
		private readonly items: readonly GeorefSummary[],
		private readonly onPick: (g: GeorefSummary) => void,
	) {
		super(app);
		this.setPlaceholder(COPY.doors.placeholder);
	}

	getItems(): GeorefSummary[] {
		return [...this.items];
	}

	getItemText(g: GeorefSummary): string {
		return g.id + "  " + g.notePath;
	}

	onChooseItem(g: GeorefSummary): void {
		this.onPick(g);
	}
}
