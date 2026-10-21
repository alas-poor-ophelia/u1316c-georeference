/**
 * The editor's dialogs: a world coordinate for a placed pixel, and where a new map's note goes.
 *
 * Obsidian `Modal`s, which the fence allows — this IS the Obsidian layer. They decide nothing
 * about the map: the shell owns the draft and the API owns what is valid. The checks here exist
 * so that a value the API would refuse is refused beside the field it was typed into, with the
 * reason, rather than after a click with a notice. The API's own validation still runs on save.
 */
import { type App, FuzzySuggestModal, Modal, Setting, type TextComponent } from "obsidian";
import type { ControlPoint, FeatureInfo, GebAPI } from "../api/types";

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
		this.titleEl.setText(this.initial.lat === undefined ? "New control point" : "Control point");
		contentEl.addClass("geb-point-modal");

		this.field("px", "Pixel x", numberText(this.initial.px));
		this.field("py", "Pixel y", numberText(this.initial.py));
		// Coordinates at FULL precision: three decimals of latitude is a hundred metres, and a
		// user opening this dialog to fix a label must not have the coordinate rounded under them.
		this.field("lat", "Latitude", exactText(this.initial.lat), "Decimal degrees; south is negative.");
		this.field("lng", "Longitude", exactText(this.initial.lng), "Decimal degrees; west is negative.");
		this.field("label", "Label", this.initial.label ?? "", "Optional. Shown beside the marker and named in the residuals.");

		new Setting(contentEl)
			.setName("From a place note")
			.setDesc("Take the coordinate and label from a note that already carries one.")
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
		const px = this.number("px");
		const py = this.number("py");
		const lat = this.number("lat");
		const lng = this.number("lng");
		const label = this.inputs.get("label")?.getValue().trim() ?? "";
		const bad = (why: string): void => this.errorEl?.setText(why);

		if (px === null || py === null) return bad("Pixel x and y must be numbers.");
		if (px < 0 || py < 0) return bad("Pixel x and y cannot be negative.");
		if (lat === null || lng === null) return bad("Latitude and longitude must be numbers, in decimal degrees.");
		const crs = this.crsInfo();
		if (crs !== null) {
			const [latLo, latHi] = crs.latRange;
			const [lngLo, lngHi] = crs.lngRange;
			if (lat < latLo || lat > latHi) return bad(`Latitude must be between ${latLo} and ${latHi} for ${crs.name}.`);
			if (lng < lngLo || lng > lngHi) return bad(`Longitude must be between ${lngLo} and ${lngHi} for ${crs.name}.`);
		}
		this.onSubmit(label === "" ? { px, py, lat, lng } : { px, py, lat, lng, label });
		this.close();
	}

	private crsInfo(): { readonly name: string; readonly latRange: readonly [number, number]; readonly lngRange: readonly [number, number] } | null {
		try {
			return this.api.getCrs(this.crs);
		} catch {
			return null;
		}
	}

	/** A finite number from the field, or null. Accepts a decimal comma: a European keyboard is not a typo. */
	private number(key: Field): number | null {
		const raw = this.inputs.get(key)?.getValue().trim().replace(",", ".") ?? "";
		if (raw === "" || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(raw)) return null;
		const n = Number(raw);
		return Number.isFinite(n) ? n : null;
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
			.setDesc("How other notes and plugins will refer to this map. Cannot be changed later without editing the note.")
			.addText((t) => t.setValue(this.id).onChange((v) => (this.id = v)));
		new Setting(contentEl)
			.setName("Note path")
			.setDesc("Where the georeference note is created. The image itself is not moved or changed.")
			.addText((t) => t.setValue(this.notePath).onChange((v) => (this.notePath = v)));
		this.errorEl = contentEl.createDiv({ cls: "geb-form-error" });
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Start placing points")
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
