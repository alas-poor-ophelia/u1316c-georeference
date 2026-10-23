/**
 * The plugin's settings: their shape, how a possibly-malformed data.json is read over the
 * defaults, and the settings tab.
 *
 * DECLARATIVE, not `display()`. The manifest's minAppVersion is 1.13.0, where Obsidian renders a
 * tab from `getSettingDefinitions()` and indexes it for the settings search; a `display()` would
 * be bypassed. The values are read and written through `getControlValue`/`setControlValue`, so
 * every change goes through `readSettings`' normalisation and the side effects in one place.
 */
import { normalizePath, PluginSettingTab, type App, type Plugin, type Setting, type SettingDefinitionItem } from "obsidian";
import type { TransformKind } from "../api/types";
import { COPY } from "../view/copy";
import { DEFAULT_MODEL, MODELS } from "../view/shell";

export interface GebSettings {
	/** Vault folder whose GeoJSON files are drawn as reference lines; the coastline download lands here. */
	readonly referenceFolder: string;
	/** Whether a map draws its reference lines when it opens. The per-map toggle wins once touched. */
	readonly showReferenceByDefault: boolean;
	/** The model a NEW map starts with. A saved map keeps its saved model. */
	readonly defaultModel: TransformKind;
	/** Where a new georeference note goes; empty means beside the image. */
	readonly newNoteFolder: string;
}

export const DEFAULT_SETTINGS: GebSettings = {
	referenceFolder: "Geb/reference",
	showReferenceByDefault: true,
	defaultModel: DEFAULT_MODEL,
	newNoteFolder: "",
};

const MODEL_KINDS: ReadonlySet<string> = new Set(MODELS.map((m) => m.kind));

/** A vault folder as stored: normalised, with no leading or trailing slash. The vault root is "". */
export function normaliseFolder(raw: string): string {
	return normalizePath(raw).replace(/^\/+|\/+$/g, "");
}

/** A folder may not climb out of the vault or into its configuration folder (`Vault.configDir`, when given). */
function folderUsable(folder: string, configDir: string | undefined): boolean {
	const parts = folder.split("/");
	return parts.every((p) => p !== "." && p !== "..") && (configDir === undefined || parts[0] !== configDir);
}

/** A folder from data.json: a string, normalised and usable; anything else is the default. */
function folderOr(raw: unknown, fallback: string, configDir: string | undefined): string {
	if (typeof raw !== "string") return fallback;
	const folder = normaliseFolder(raw);
	return folderUsable(folder, configDir) ? folder : fallback;
}

/**
 * `folder` spelled as the vault already spells it, when a folder differs from it only in case;
 * otherwise as given. `References` matches its folder case-insensitively, but the vault's own
 * lookups do not, and a write under the other spelling would make a second folder on a
 * case-sensitive disk and collide on Windows.
 */
export function matchFolderCase(folder: string, existing: Iterable<string>): string {
	const want = folder.toLowerCase();
	for (const path of existing) if (path.toLowerCase() === want) return path;
	return folder;
}

/**
 * The settings in `raw` (what `loadData()` returned) merged over the defaults. Nothing in the
 * file is trusted beyond its type: a missing, wrongly typed or unknown value is the default.
 */
export function readSettings(raw: unknown, configDir?: string): GebSettings {
	const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const reference = folderOr(r.referenceFolder, DEFAULT_SETTINGS.referenceFolder, configDir);
	return {
		// The reference folder cannot be the vault root: every GeoJSON file in the vault would be
		// drawn over every map. An empty one is the default instead.
		referenceFolder: reference === "" ? DEFAULT_SETTINGS.referenceFolder : reference,
		showReferenceByDefault: typeof r.showReferenceByDefault === "boolean" ? r.showReferenceByDefault : DEFAULT_SETTINGS.showReferenceByDefault,
		defaultModel: typeof r.defaultModel === "string" && MODEL_KINDS.has(r.defaultModel) ? (r.defaultModel as TransformKind) : DEFAULT_SETTINGS.defaultModel,
		newNoteFolder: folderOr(r.newNoteFolder, DEFAULT_SETTINGS.newNoteFolder, configDir),
	};
}

/** Where the coastline download is saved, inside the reference folder. */
export function coastlinePath(referenceFolder: string): string {
	return normalizePath(`${referenceFolder}/coastline-10m.geojson`);
}

/**
 * The create dialog's default note path for an image: `<folder>/<basename>.md` when a folder is
 * configured, otherwise beside the image.
 */
export function defaultNotePath(imagePath: string, folder: string): string {
	const slash = imagePath.lastIndexOf("/");
	const name = imagePath.slice(slash + 1);
	const dot = name.lastIndexOf(".");
	const basename = dot > 0 ? name.slice(0, dot) : name;
	const dir = folder !== "" ? folder : slash < 0 ? "" : imagePath.slice(0, slash);
	return normalizePath(dir === "" ? `${basename}.md` : `${dir}/${basename}.md`);
}

/** What the tab needs from the plugin. An interface rather than the class, so there is no import cycle. */
export interface SettingsHost extends Plugin {
	settings: GebSettings;
	saveSettings(): Promise<void>;
	/** The reference folder changed: drop what was read from the old one and read the new one now. */
	referenceFolderChanged(): void;
	/**
	 * Ask, through the same confirmation the palette command uses, then download. `started` is
	 * called with the download's promise once the user has said yes; a cancel never calls it.
	 */
	offerCoastlineDownload(started?: (download: Promise<void>) => void): void;
}

type Key = keyof GebSettings;

export class GebSettingTab extends PluginSettingTab {
	/** True while a download the tab started is in flight, so the button stays disabled. */
	private downloading = false;

	constructor(
		app: App,
		private readonly host: SettingsHost,
	) {
		super(app, host);
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		const s = COPY.settings;
		const models: Record<string, string> = {};
		for (const m of MODELS) models[m.kind] = m.name;
		return [
			{ name: s.referenceFolder.name, desc: s.referenceFolder.desc, render: (setting) => this.renderFolder(setting, "referenceFolder", DEFAULT_SETTINGS.referenceFolder) },
			{ name: s.coastline.name, desc: s.coastline.desc, render: (setting) => this.renderCoastline(setting) },
			{ name: s.showReference.name, desc: s.showReference.desc, control: { type: "toggle", key: "showReferenceByDefault" } },
			{ name: s.defaultModel.name, desc: s.defaultModel.desc, control: { type: "dropdown", key: "defaultModel", options: models } },
			{ name: s.newNoteFolder.name, desc: s.newNoteFolder.desc, render: (setting) => this.renderFolder(setting, "newNoteFolder", "") },
		];
	}

	override getControlValue(key: string): unknown {
		return this.host.settings[key as Key];
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		const before = this.host.settings;
		// Through readSettings, so a value typed here is normalised exactly as one read from disk.
		const next = readSettings({ ...before, [key]: value }, this.app.vault.configDir);
		this.host.settings = next;
		await this.host.saveSettings();
		if (next.referenceFolder !== before.referenceFolder) this.host.referenceFolderChanged();
	}

	/**
	 * A folder field. The framework's text control reports every keystroke and never re-reads the
	 * stored value (measured), so a field the user emptied would show "" over a setting that had
	 * snapped back to the default. This one stores each keystroke as before and, on blur, shows
	 * what is actually stored; a reference folder that changed while the field had focus also
	 * re-renders the tab, so the coastline row speaks for the folder now in use.
	 */
	private renderFolder(setting: Setting, key: "referenceFolder" | "newNoteFolder", placeholder: string): void {
		setting.controlEl.empty();
		const was = this.host.settings.referenceFolder;
		setting.addText((text) => {
			text.setPlaceholder(placeholder).setValue(this.host.settings[key]);
			text.onChange((value) => void this.setControlValue(key, value));
			text.inputEl.addEventListener("blur", () => {
				const stored = this.host.settings[key];
				if (text.getValue() !== stored) text.setValue(stored);
				if (key === "referenceFolder" && stored !== was) this.update();
			});
		});
	}

	/**
	 * The coastline row. The framework may hand the same row back on a re-render, so the control
	 * area is emptied first rather than gaining a second button. The file is looked for without
	 * regard to case, as `References` reads it.
	 */
	private renderCoastline(setting: Setting): void {
		setting.controlEl.empty();
		const b = COPY.settings.coastline;
		const want = coastlinePath(this.host.settings.referenceFolder).toLowerCase();
		const exists = this.app.vault.getFiles().some((f) => f.path.toLowerCase() === want);
		setting.addButton((button) => {
			button.setButtonText(exists ? b.downloaded : b.download);
			button.setDisabled(exists || this.downloading);
			if (exists || this.downloading) return;
			button.setCta();
			button.onClick(() => {
				this.host.offerCoastlineDownload((download) => {
					this.downloading = true;
					button.setDisabled(true);
					void download.finally(() => {
						this.downloading = false;
						this.update();
					});
				});
			});
		});
	}
}
