/**
 * The settings: reading data.json over the defaults, the create dialog's default note path, the
 * copy that names the folder, `References` over a configured folder, the shell's default model
 * for a new map, and the place-note keys as the tab reads and writes them.
 *
 * `obsidian` ships types only, so the module is stubbed (the shared stub, see obsidian-stub.ts)
 * before the plugin files are loaded.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { App } from "obsidian";
import { ApiController } from "../src/api/controller";
import type { GebSettings, SettingsHost } from "../src/plugin/settings";
import { NO_PLACE_KEYS, PLACE_KEY_ROLES } from "../src/query/types";
import { COPY } from "../src/view/copy";
import { MapShell } from "../src/view/shell";
import { FakeVault } from "./fake-vault";
import { OBSIDIAN_STUB } from "./obsidian-stub";
import { BYTES, ID, openShell, Recorder, seedVault } from "./shell-harness";

void mock.module("obsidian", () => OBSIDIAN_STUB);
const { coastlinePath, DEFAULT_SETTINGS, defaultNotePath, GebSettingTab, matchFolderCase, readSettings } = await import("../src/plugin/settings");
const { References } = await import("../src/plugin/references");

describe("folder guards", () => {
	test("a folder that climbs out of the vault or into its configuration folder is the default", () => {
		for (const bad of ["../elsewhere", "Geb/../..", "cfg/plugins", "./cfg"]) {
			expect(readSettings({ referenceFolder: bad }, "cfg").referenceFolder).toBe(DEFAULT_SETTINGS.referenceFolder);
			expect(readSettings({ newNoteFolder: bad }, "cfg").newNoteFolder).toBe("");
		}
		// Without a configuration folder to name, only the climb is refused.
		expect(readSettings({ referenceFolder: "cfg/plugins" }).referenceFolder).toBe("cfg/plugins");
		// A hidden folder below the root is the user's business.
		expect(readSettings({ referenceFolder: "Geb/.hidden" }, "cfg").referenceFolder).toBe("Geb/.hidden");
	});
	test("matchFolderCase takes the vault's spelling when only the case differs", () => {
		expect(matchFolderCase("geb/reference", ["Maps", "Geb/reference", "Geb"])).toBe("Geb/reference");
		expect(matchFolderCase("Geb/reference", ["Geb/Reference"])).toBe("Geb/Reference");
		expect(matchFolderCase("Geb/reference", ["Geb", "Other"])).toBe("Geb/reference");
	});
});

describe("readSettings", () => {
	test("nothing stored is the defaults", () => {
		for (const raw of [undefined, null, {}, "junk", 42, []]) expect(readSettings(raw)).toEqual(DEFAULT_SETTINGS);
	});

	test("the defaults are the ones the tab promises", () => {
		expect(DEFAULT_SETTINGS).toEqual({ referenceFolder: "Geb/reference", showReferenceByDefault: true, defaultModel: "tps", newNoteFolder: "", placeKeys: NO_PLACE_KEYS });
	});

	test("a partial file keeps what it has and defaults the rest", () => {
		expect(readSettings({ defaultModel: "affine" })).toEqual({ ...DEFAULT_SETTINGS, defaultModel: "affine" });
		expect(readSettings({ showReferenceByDefault: false, newNoteFolder: "maps" })).toEqual({
			...DEFAULT_SETTINGS,
			showReferenceByDefault: false,
			newNoteFolder: "maps",
		});
	});

	test("wrong types are the defaults", () => {
		expect(readSettings({ referenceFolder: 7, showReferenceByDefault: "no", defaultModel: 3, newNoteFolder: ["x"] })).toEqual(DEFAULT_SETTINGS);
	});

	test("an unknown model is the default", () => {
		expect(readSettings({ defaultModel: "helmert" }).defaultModel).toBe("tps");
		expect(readSettings({ defaultModel: "mercator" }).defaultModel).toBe("mercator");
	});

	test("folders are normalised, with no slash at either end", () => {
		expect(readSettings({ referenceFolder: "/Geb/reference/" }).referenceFolder).toBe("Geb/reference");
		expect(readSettings({ referenceFolder: "Data\\lines//coast" }).referenceFolder).toBe("Data/lines/coast");
		expect(readSettings({ newNoteFolder: "/maps/" }).newNoteFolder).toBe("maps");
	});

	test("an empty note folder means beside the image; an empty reference folder is the default", () => {
		expect(readSettings({ newNoteFolder: "/" }).newNoteFolder).toBe("");
		expect(readSettings({ newNoteFolder: "" }).newNoteFolder).toBe("");
		// The vault root would draw every GeoJSON file in the vault over every map.
		expect(readSettings({ referenceFolder: "" }).referenceFolder).toBe("Geb/reference");
		expect(readSettings({ referenceFolder: "/" }).referenceFolder).toBe("Geb/reference");
	});

	test("place-note keys are a list or one comma-separated string, trimmed, without blanks or repeats", () => {
		expect(readSettings({ placeKeys: { lat: " y , breite,,y ", lng: ["x", " x ", "", 7] } }).placeKeys).toEqual({
			...NO_PLACE_KEYS,
			lat: ["y", "breite"],
			lng: ["x"],
		});
	});

	test("a place-note key that is a built-in key, or that an earlier role holds, is dropped", () => {
		// `long` is already read as a longitude, and `y` already answers for latitude; neither may
		// answer for a second role. Case is kept, so `Lat` is a property of its own.
		expect(readSettings({ placeKeys: { lat: ["y", "lat", "Lat"], lng: ["long", "y", "x"], location: "location, geb-from" } }).placeKeys).toEqual({
			...NO_PLACE_KEYS,
			lat: ["y", "Lat"],
			lng: ["x"],
		});
	});

	test("place-note keys of the wrong type are the default", () => {
		for (const placeKeys of [7, "y", ["y"], null]) expect(readSettings({ placeKeys }).placeKeys).toEqual(NO_PLACE_KEYS);
		expect(readSettings({ placeKeys: { lat: 7, lng: { x: 1 }, crs: true } }).placeKeys).toEqual(NO_PLACE_KEYS);
	});
});

/** The tab over a host that records its calls. The stubbed base class sets no `app`, so it is set here. */
function tabOver(settings: GebSettings): { tab: InstanceType<typeof GebSettingTab>; host: SettingsHost; calls: string[] } {
	const calls: string[] = [];
	const host = {
		settings,
		saveSettings: () => {
			calls.push("save");
			return Promise.resolve();
		},
		referenceFolderChanged: () => calls.push("referenceFolderChanged"),
		placeKeysChanged: () => calls.push("placeKeysChanged"),
		offerCoastlineDownload: () => undefined,
	} as unknown as SettingsHost;
	const tab = new GebSettingTab({} as App, host);
	tab.app = { vault: { configDir: "cfg" } } as unknown as App;
	return { tab, host, calls };
}

describe("the place-note keys in the settings tab", () => {
	test("each role is a text row whose value is its names joined with commas", () => {
		const { tab } = tabOver({ ...DEFAULT_SETTINGS, placeKeys: { ...NO_PLACE_KEYS, lat: ["y", "breite"] } });
		expect(tab.getControlValue("placeKeys.lat")).toBe("y, breite");
		expect(tab.getControlValue("placeKeys.lng")).toBe("");
		expect(tab.getControlValue("referenceFolder")).toBe(DEFAULT_SETTINGS.referenceFolder);
	});

	test("typing into a row stores the names and says the keys changed", async () => {
		const { tab, host, calls } = tabOver(DEFAULT_SETTINGS);
		await tab.setControlValue("placeKeys.lat", " y, breite ");
		expect(host.settings.placeKeys).toEqual({ ...NO_PLACE_KEYS, lat: ["y", "breite"] });
		expect(calls).toEqual(["save", "placeKeysChanged"]);
	});

	test("a change that leaves the names as they were, or another setting, does not say the keys changed", async () => {
		const { tab, calls } = tabOver({ ...DEFAULT_SETTINGS, placeKeys: { ...NO_PLACE_KEYS, lat: ["y"] } });
		// A trailing comma or space is the field mid-keystroke; the stored names are the same.
		await tab.setControlValue("placeKeys.lat", "y, ");
		await tab.setControlValue("defaultModel", "affine");
		expect(calls).toEqual(["save", "save"]);
	});

	test("the row being typed into yields a name another role holds, so a keystroke cannot take it", async () => {
		// Typing `xylo` for latitude passes through `x`. Under first-role-wins alone, that keystroke
		// would move `x` from longitude to latitude, and finishing the word would not move it back.
		const { tab, host } = tabOver({ ...DEFAULT_SETTINGS, placeKeys: { ...NO_PLACE_KEYS, lng: ["x"] } });
		await tab.setControlValue("placeKeys.lat", "x");
		await tab.setControlValue("placeKeys.lat", "xylo");
		expect(host.settings.placeKeys).toEqual({ ...NO_PLACE_KEYS, lat: ["xylo"], lng: ["x"] });
	});

	test("every role has a row, under one heading", () => {
		const { tab } = tabOver(DEFAULT_SETTINGS);
		const group = tab.getSettingDefinitions().find((d) => "heading" in d && d.heading === COPY.settings.placeKeys.heading);
		expect(group).toBeDefined();
		const keys = (group as { items: { control: { key: string } }[] }).items.map((i) => i.control.key);
		expect(keys).toEqual(PLACE_KEY_ROLES.map((r) => `placeKeys.${r}`));
	});
});

describe("defaultNotePath", () => {
	test("empty folder: beside the image", () => {
		expect(defaultNotePath("scans/britain.png", "")).toBe("scans/britain.md");
		expect(defaultNotePath("britain.png", "")).toBe("britain.md");
		expect(defaultNotePath("a/b/old.map.jpeg", "")).toBe("a/b/old.map.md");
	});

	test("a folder: there, whatever folder the image is in", () => {
		expect(defaultNotePath("scans/britain.png", "maps")).toBe("maps/britain.md");
		expect(defaultNotePath("britain.png", "maps/old")).toBe("maps/old/britain.md");
	});

	test("the coastline is saved inside the reference folder", () => {
		expect(coastlinePath("Geb/reference")).toBe("Geb/reference/coastline-10m.geojson");
		expect(coastlinePath("Data/lines")).toBe("Data/lines/coastline-10m.geojson");
	});
});

describe("copy that names the folder", () => {
	test("each sentence includes the folder or path it is given", () => {
		expect(COPY.reference.folderHint("Data/lines")).toContain("Data/lines");
		expect(COPY.reference.download.body("Data/lines/coastline-10m.geojson")).toContain("Data/lines/coastline-10m.geojson");
		expect(COPY.reference.download.exists("Data/lines")).toContain("Data/lines");
	});
});

// --- References over a configured folder ------------------------------------------------------

const LINE = JSON.stringify({ type: "LineString", coordinates: [[0, 50], [1, 51]] });

type FakePlugin = ConstructorParameters<typeof References>[0];

/** The slice of a Plugin that `References` touches: the vault's files and events, and the trigger. */
function fakePlugin(): {
	plugin: FakePlugin;
	add: (path: string, text: string) => void;
	triggered: string[];
	read: (path: string) => Promise<ArrayBuffer>;
	reads: string[];
} {
	const files = new Map<string, ArrayBuffer>();
	const triggered: string[] = [];
	const reads: string[] = [];
	const vault = {
		getFiles: () => [...files.entries()].map(([path, b]) => ({ path, stat: { mtime: 1, size: b.byteLength } })),
		on: () => ({}),
	};
	const plugin = {
		app: { vault, workspace: { trigger: (ev: string) => triggered.push(ev) } },
		registerEvent: () => undefined,
	} as unknown as FakePlugin;
	return {
		plugin,
		add: (path, text) => files.set(path, new TextEncoder().encode(text).buffer),
		triggered,
		reads,
		read: (path) => {
			reads.push(path);
			const b = files.get(path);
			return b === undefined ? Promise.reject(new Error("missing")) : Promise.resolve(b);
		},
	};
}

describe("References over the configured folder", () => {
	test("a file under the configured folder is read, one under the default folder is not", async () => {
		const f = fakePlugin();
		f.add("Data/Lines/coast.geojson", LINE);
		f.add("Geb/reference/old.geojson", LINE);
		const refs = new References(f.plugin, f.read, () => "data/lines");
		refs.start();
		await Bun.sleep(0);
		// Compared case-insensitively, as the default folder always was.
		expect(refs.current().sources).toEqual(["Data/Lines/coast.geojson"]);
		refs.dispose();
	});

	test("a folder change rebuilds at once from the new folder, re-reading what it had cached", async () => {
		const f = fakePlugin();
		f.add("Data/lines/coast.geojson", LINE);
		f.add("Geb/reference/old.geojson", LINE);
		let folder = "Geb/reference";
		const refs = new References(f.plugin, f.read, () => folder);
		refs.start();
		await Bun.sleep(0);
		expect(refs.current().sources).toEqual(["Geb/reference/old.geojson"]);
		const before = f.triggered.length;

		folder = "Data/lines";
		refs.folderChanged();
		await Bun.sleep(0);
		expect(refs.current().sources).toEqual(["Data/lines/coast.geojson"]);
		expect(f.triggered.length).toBe(before + 1);

		// Back again: the cache was cleared, so the old file is read afresh.
		folder = "Geb/reference";
		refs.folderChanged();
		await Bun.sleep(0);
		expect(refs.current().sources).toEqual(["Geb/reference/old.geojson"]);
		expect(f.reads.filter((p) => p === "Geb/reference/old.geojson")).toHaveLength(2);
		refs.dispose();
	});

	test("a folder change before start builds nothing", async () => {
		const f = fakePlugin();
		f.add("Geb/reference/old.geojson", LINE);
		const refs = new References(f.plugin, f.read, () => "Geb/reference");
		refs.folderChanged();
		await Bun.sleep(0);
		expect(f.reads).toEqual([]);
		expect(refs.current().sources).toEqual([]);
	});
});

// --- the shell's default model ------------------------------------------------------------

describe("the default model setting in the shell", () => {
	let v: FakeVault;
	let c: ApiController;
	let s: Recorder;

	beforeEach(() => {
		v = new FakeVault();
		seedVault(v);
		c = new ApiController(v, "0.0.1");
		s = new Recorder();
	});

	test("a new map starts with the configured model", async () => {
		v.addFile("scans/new.png", BYTES);
		c.markReady();
		const shell = new MapShell(c.api, "new", s, { create: { imagePath: "scans/new.png", notePath: "maps/new.md" }, defaultModel: "affine" });
		shell.open();
		await Bun.sleep(0);
		expect(s.last.edit?.model).toBe("affine");
		expect(shell.draft?.model).toBe("affine");
	});

	test("without the option a new map is still a spline", async () => {
		v.addFile("scans/new.png", BYTES);
		c.markReady();
		const shell = new MapShell(c.api, "new", s, { create: { imagePath: "scans/new.png", notePath: "maps/new.md" } });
		shell.open();
		await Bun.sleep(0);
		expect(s.last.edit?.model).toBe("tps");
	});

	test("a saved map's Edit keeps its saved model whatever the setting says", async () => {
		const shell = openShell(c, s, ID, { defaultModel: "affine" });
		await Bun.sleep(0);
		expect(s.last.edit).toBeNull();
		shell.beginEdit();
		expect(s.last.edit?.model).toBe("tps");
	});
});
