/**
 * Live gate: the editor driven inside a REAL Obsidian. Run: bun run gate:live
 *
 * WHY THIS EXISTS. The shell is tested to the bone without a DOM, and that is exactly the limit:
 * the adapter, the two dialogs, the command, the file menu, image decoding, the layout round
 * trip, the plugin reload path, and whether Obsidian's own events arrive in the order the shell
 * assumes — none of that can be answered by a fake. The first run of this gate found that the
 * plugin never became ready in a small vault at all. Hand testing is for fit and feel; this is
 * for everything a hand would otherwise have to check every time.
 *
 * HOW IT REACHES THE APP. The Obsidian CLI shim (`Obsidian.com`) talks to the RUNNING app over
 * its single-instance pipe; `eval` runs JavaScript inside an OPEN vault window. So the gate needs
 * the user's Obsidian running, opens the fixture vault (`test/live/geb-live`) in it if it is not
 * open — registering it with the same IPC call the vault switcher uses — accepts the trust dialog
 * a new vault shows, copies the freshly built plugin in, reloads it, and drives the editor with
 * REAL mouse input through Electron's `sendInputEvent`, so pointer capture and hit testing behave
 * as they do under a hand. Nothing here touches any vault but the fixture.
 *
 * THE SHIM'S RULES, learned the expensive way (H-62, H-1598): output is prefixed "=> "; double
 * quotes inside `code=` are stripped; a top-level return is illegal. Every payload here is sent
 * as `new Function(atob(...))` — base64 has no quotes, so none of that applies — and each check is
 * a real TypeScript function whose SOURCE is shipped, so the checks are typechecked and linted
 * like any other code against the real `App` and `GebAPI` types. They run in the window, not
 * here: they may close over nothing, and the helpers they call are defined by the prelude.
 *
 * NO `node:` IMPORTS, as for the other gates: the community-store scan reads this directory.
 */
import type { App, WorkspaceLeaf } from "obsidian";
import type { ControlPoint, GebAPI, TransformKind } from "../src/api/types";
import { COPY } from "../src/view/copy";

const REPO = `${import.meta.dir}/..`;
const VAULT_NAME = "geb-live";
const VAULT_DIR = `${REPO}/test/live/${VAULT_NAME}`.replace(/\\/g, "/");
const PLUGIN_DIR = `${VAULT_DIR}/.obsidian/plugins/geb`;
const SHOTS_DIR = `${REPO}/test/live/screenshots`;
const OBSIDIAN = `${process.env.LOCALAPPDATA ?? ""}/Programs/Obsidian/Obsidian.com`;
/** Generous: a busy app answers the shim slowly, and the timeout is a last resort, not a budget. */
const CLI_TIMEOUT_MS = 180_000;

// --- what the checks may use inside the window ----------------------------------------------

/** The undocumented corners of `app` the checks lean on, typed narrowly rather than loosely. */
interface LiveApp extends App {
	readonly plugins: {
		isEnabled(): boolean;
		setEnable(on: boolean): Promise<void>;
		enablePlugin(id: string): Promise<void>;
		readonly enabledPlugins: Set<string>;
		readonly plugins: { readonly geb?: { readonly api: GebAPI | null } };
	};
	readonly commands: { executeCommandById(id: string): boolean };
	readonly setting: { close(): void };
}

/** What the view serialises into the layout. */
interface LeafState {
	readonly georefId?: string;
	readonly create?: { readonly imagePath: string; readonly notePath: string };
	readonly draft?: { readonly model: TransformKind; readonly points: readonly ControlPoint[] };
}

// Ambient, never emitted: these exist in the window (or in the prelude below), not here.
declare const app: LiveApp;
declare const sleep: (ms: number) => Promise<void>;
declare const until: (what: string, pred: () => boolean, ms?: number) => Promise<void>;
declare const api: () => GebAPI;
declare const q: (sel: string) => HTMLElement | null;
declare const qa: (sel: string) => HTMLElement[];
declare const mouse: (type: "mouseDown" | "mouseUp" | "mouseMove", x: number, y: number, down?: boolean) => void;
declare const click: (x: number, y: number) => Promise<void>;
declare const setInput: (el: HTMLElement, value: string) => void;
declare const buttonNamed: (text: string, within?: string) => HTMLButtonElement | null;
declare const stage: () => { left: number; top: number; scale: number; ox: number; oy: number };
declare const toScreen: (px: number, py: number) => { x: number; y: number };
declare const gebLeaf: () => WorkspaceLeaf | null;
declare const leafState: () => LeafState;
/** Stop Chromium throttling this window's timers to once a second while another window covers it. */
declare const unthrottle: () => void;
/** Throws unless the image has decoded and the stage is fitted to a laid-out viewport. */
declare const fitted: (what: string) => unknown;

/** Shipped ahead of every check. Plain JS in a string: it runs in the window, so no TS here. */
// The fixture's names, above the prelude because the prelude bakes the id in.
const GEOREF_ID = "map";
const IMAGE_PATH = "fixtures/map.png";
const NOTE_PATH = "maps/live/map.md";

const PRELUDE = `
const sleep = (ms) => new Promise((r) => window.setTimeout(r, ms));
const until = async (what, pred, ms = 10000) => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
		await sleep(50);
	}
};
const api = () => app.plugins.plugins.geb.api;
// Geb selectors resolve INSIDE the gate's own leaf once it exists: the Guildmaster's other maps
// share this window, and the first .geb-stage in the document was theirs (622 px wide) while
// the gate waited for 240. Modals, prompts and the ribbon are document-level and stay so.
const scopeFor = (sel) => { const l = sel.startsWith('.geb-') ? gebLeaf() : null; return l ? l.view.containerEl : document; };
const q = (sel) => scopeFor(sel).querySelector(sel);
const qa = (sel) => Array.from(scopeFor(sel).querySelectorAll(sel));
const wc = () => require('@electron/remote').getCurrentWebContents();
const mouse = (type, x, y, down = false) => {
	const ev = { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
	if (down) ev.modifiers = ['leftButtonDown'];
	wc().sendInputEvent(ev);
};
const click = async (x, y) => { mouse('mouseMove', x, y); await sleep(30); mouse('mouseDown', x, y); await sleep(60); mouse('mouseUp', x, y); await sleep(60); };
const setInput = (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
const buttonNamed = (text, within = '') => qa(within + ' button').find((b) => (b.textContent || '').trim() === text) || null;
const stage = () => {
	const vp = q('.geb-viewport').getBoundingClientRect();
	const m = /translate\\(([-\\d.]+)px, ([-\\d.]+)px\\) scale\\(([-\\d.]+)\\)/.exec(q('.geb-stage').style.transform);
	if (!m) throw new Error('stage has no transform: ' + q('.geb-stage').style.transform);
	return { left: vp.left, top: vp.top, ox: Number(m[1]), oy: Number(m[2]), scale: Number(m[3]) };
};
const toScreen = (px, py) => { const s = stage(); return { x: s.left + s.ox + px * s.scale, y: s.top + s.oy + py * s.scale }; };
// The gate's OWN map leaf, by id: the Guildmaster's other maps share this window (H-1620's
// lesson, one tab over), and the first geb leaf in the workspace was theirs on 2026-10-23.
const gebLeaf = () => app.workspace.getLeavesOfType('geb-georef').find((l) => (l.getViewState().state || {}).georefId === '${GEOREF_ID}') || null;
const leafState = () => { const l = gebLeaf(); return (l && l.getViewState().state) || {}; };
const unthrottle = () => { wc().setBackgroundThrottling(false); };
const fitted = (what) => {
	const img = q('.geb-image');
	const vp = q('.geb-viewport').getBoundingClientRect();
	const s = stage();
	const expected = Math.min(vp.width / 240, vp.height / 320);
	const info = { what, complete: img.complete, naturalWidth: img.naturalWidth, src: (img.getAttribute('src') || '').slice(0, 80), vp: [Math.round(vp.width), Math.round(vp.height)], scale: s.scale, expected };
	if (!img.complete || img.naturalWidth !== 240) throw new Error(what + ': image not decoded ' + JSON.stringify(info));
	if (vp.height < 200) throw new Error(what + ': viewport not laid out ' + JSON.stringify(info));
	// The scale is read back from the stage's serialised CSS transform, which Chromium writes with
	// about six significant digits (3.84424 for 3.84423828125). A tolerance finer than that only
	// passed while the viewport height happened to be a whole number of pixels.
	if (Math.abs(s.scale - expected) > 1e-4) throw new Error(what + ': not fitted to the container ' + JSON.stringify(info));
	return info;
};
`;

// --- the fixture's ground truth ---------------------------------------------------------------
/** The fixture image is 240x320; under this rule every point is exactly affine, so residuals are ~0. */
const world = (px: number, py: number): { lat: number; lng: number } => ({ lat: 60 - py / 10, lng: px / 10 - 10 });
const POINTS = [
	{ px: 40, py: 40, label: "NW" },
	{ px: 200, py: 40, label: "NE" },
	{ px: 200, py: 280, label: "SE" },
	{ px: 40, py: 280, label: "SW" },
].map((p) => ({ ...p, ...world(p.px, p.py) }));
type FixturePoint = (typeof POINTS)[number];

// --- the shim -----------------------------------------------------------------------------------

async function cli(args: string[], vault = VAULT_NAME): Promise<string> {
	const proc = Bun.spawn([OBSIDIAN, ...(vault === "" ? [] : [`vault=${vault}`]), ...args], { stdout: "pipe", stderr: "pipe", timeout: CLI_TIMEOUT_MS });
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	const code = await proc.exited;
	const text = (out + err).trim();
	if (code !== 0) throw new Error(`obsidian ${args[0] ?? ""} exited ${code}: ${text}`);
	return text.startsWith("=> ") ? text.slice(3) : text;
}

/** UTF-8 to base64 without `Buffer`, which the scanner's globals do not include. */
function base64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

interface Wrapped<T> {
	readonly ok: boolean;
	readonly value?: T;
	readonly error?: string;
}

/** Run `body` (a function body returning a JSON-able value) inside the vault window. */
async function evalIn<T>(body: string, vault = VAULT_NAME): Promise<T> {
	const wrapped = `${PRELUDE}\nreturn (async () => { try { return JSON.stringify({ ok: true, value: await (async () => { ${body} })() }); } catch (e) { return JSON.stringify({ ok: false, error: String((e && e.stack) || e) }); } })();`;
	const raw = await cli(["eval", `code=(async () => { const f = new Function(atob('${base64(wrapped)}')); return await f(); })()`], vault);
	let parsed: Wrapped<T>;
	try {
		parsed = JSON.parse(raw) as Wrapped<T>;
	} catch {
		throw new Error(`eval returned something that is not the wrapper's JSON: ${raw.slice(0, 300)}`);
	}
	if (!parsed.ok) throw new Error(parsed.error ?? "unknown error in the window");
	return parsed.value as T;
}

/** Ship a real function: its source runs in the window with `arg` as its one parameter. */
async function inWindow<A, T>(fn: (arg: A) => Promise<T> | T, arg: A): Promise<T> {
	return evalIn<T>(`return await (${fn.toString()})(${JSON.stringify(arg)});`);
}

// --- getting the fixture vault open and the plugin loaded -----------------------------------------

async function vaultAnswers(): Promise<boolean> {
	try {
		return (await cli(["eval", "code=app.vault.getName()"])) === VAULT_NAME;
	} catch {
		return false;
	}
}

/**
 * Open the fixture folder as a vault in the running app, through the IPC call the vault switcher
 * itself makes. Sent from whichever vault window answers first, because `eval` reaches only open
 * windows. (`obsidian://open?path=` is NOT this: it opens a note in a known vault and raises a
 * native dialog that freezes the whole CLI until someone closes it.)
 */
async function openVault(): Promise<void> {
	if (await vaultAnswers()) return;
	const known = await cli(["vaults", "verbose"], "");
	const others = known
		.split(/\r?\n/)
		.map((l) => l.split("\t")[0] ?? "")
		.filter((n) => n !== "" && n !== VAULT_NAME);
	let opened = false;
	for (const name of others) {
		try {
			const r = await evalIn<unknown>(`return window.electron.ipcRenderer.sendSync('vault-open', ${JSON.stringify(VAULT_DIR)}, false);`, name);
			if (r === true) {
				opened = true;
				break;
			}
			throw new Error(String(r));
		} catch {
			// Not an open window, or it refused. Try the next.
		}
	}
	if (!opened) throw new Error("could not open the fixture vault from any open window — is Obsidian running?");
	const t0 = Date.now();
	while (!(await vaultAnswers())) {
		if (Date.now() - t0 > 30_000) throw new Error("the fixture vault window never answered");
		await Bun.sleep(1000);
	}
}

async function installPlugin(): Promise<void> {
	for (const f of ["main.js", "manifest.json", "styles.css"]) {
		const src = Bun.file(`${REPO}/${f}`);
		if (!(await src.exists())) throw new Error(`${f} is missing — run bun run build first`);
		await Bun.write(`${PLUGIN_DIR}/${f}`, src);
	}
}

/** A fresh vault shows the trust dialog with plugins off; a known one may just need the reload. */
async function loadPlugin(): Promise<void> {
	await inWindow(async () => {
		const btn = qa(".modal-container button").find((b) => /trust author/i.test(b.textContent ?? ""));
		if (btn) btn.click();
		if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
		if (!app.plugins.enabledPlugins.has("geb")) await app.plugins.enablePlugin("geb");
		await until("geb to load", () => app.plugins.plugins.geb !== undefined, 15_000);
	}, null);
	await cli(["plugin:reload", "id=geb"]);
	await inWindow(async () => {
		await until("api.ready after reload", () => app.plugins.plugins.geb?.api?.ready === true, 15_000);
		// MEASURED: with the fixture window behind the user's own, every 30 ms sleep in a check took a
		// full second (Chromium throttles an occluded window's timers to 1 Hz) and the checks ran
		// past the shim's timeout. Input events themselves cost a millisecond; it was the waits.
		unthrottle();
	}, null);
}

/** The files the fixture vault is made of. Anything else in it is a previous run's debris. */
const FIXTURE_FILES = ["README.md", "places/Alpha.md", "fixtures/map.png", "Geb/reference/test-coast.geojson"];

/**
 * Whatever a previous run left behind: leaves, modals, the written note and its folder, and any
 * file that is not fixture — a run killed mid-click once left an "Untitled" note behind, because
 * a click meant for the map landed on the explorer's new-note button.
 */
async function resetFixture(): Promise<void> {
	await inWindow(async ({ notePath, keep, id, imagePath }) => {
		// ONLY THE GATE'S OWN LEAVES. The Guildmaster's maps and images share this window.
		for (const l of app.workspace.getLeavesOfType("geb-georef")) {
			const st = (l.getViewState().state ?? {}) as { georefId?: unknown; create?: { notePath?: unknown } };
			if (st.georefId === id || st.create?.notePath === notePath) l.detach();
		}
		for (const l of app.workspace.getLeavesOfType("image")) {
			if ((l.view as { file?: { path?: string } | null }).file?.path === imagePath) l.detach();
		}
		// CLOSED, not just removed from the DOM: a stray click once opened Settings, and a settings
		// dialog whose element is gone but whose state is open is still open to the app.
		app.setting.close();
		for (const m of qa(".modal-container")) m.remove();
		const folder = app.vault.getFolderByPath("maps");
		if (folder !== null) await app.fileManager.trashFile(folder);
		// ONLY what a run of this gate can create: its note folder above, and the "Untitled" note a
		// stray click on the explorer's new-note button leaves at the root. This used to trash every
		// file that was not a fixture, and on 2026-10-22 that swept two folders of hand-test material
		// the Guildmaster had copied into the vault, with no error and no notice. A harness that
		// shares a vault with a person must never delete what it did not write.
		for (const f of app.vault.getFiles()) {
			if (!keep.includes(f.path) && /^Untitled( \d+)?\.md$/.test(f.path)) await app.fileManager.trashFile(f);
		}
		await until("the note to be gone", () => app.vault.getAbstractFileByPath(notePath) === null, 5000);
		// ITS OWN note only: the vault may hold other maps, the hand-test fixtures among them.
		await until("the index to drop it", () => !api().listGeorefs().some((g) => g.notePath === notePath), 10_000);
	}, { notePath: NOTE_PATH, keep: FIXTURE_FILES, id: GEOREF_ID, imagePath: IMAGE_PATH });
}

// --- the checks ----------------------------------------------------------------------------------

interface Check {
	readonly name: string;
	run(): Promise<string>;
}

const CHECKS: readonly Check[] = [
	{
		name: "plugin loads and declares ready (the small-vault readiness defect)",
		run: () =>
			inWindow(() => {
				const a = api();
				if (a.apiVersion !== 1) throw new Error(`apiVersion ${String(a.apiVersion)}`);
				if (!a.ready) throw new Error("not ready");
				if (a.minPoints.tps !== 3) throw new Error("minPoints missing");
				// Clean means the gate's OWN note is absent; other maps in the vault are not its business.
				if (a.listGeorefs().some((g) => g.notePath === "maps/live/map.md")) throw new Error("fixture not clean");
				const f = a.listFeatures().map((x) => x.notePath);
				if (!f.includes("places/Alpha.md")) throw new Error(`place note not indexed: ${f.join(", ")}`);
				return `ready, ${f.length} place note(s)`;
			}, null),
	},
	{
		name: "the command opens the create dialog, prefilled from the image, and a nested note path is accepted",
		run: () =>
			inWindow(
				async ({ imagePath, notePath, id }) => {
					const file = app.vault.getFileByPath(imagePath);
					if (file === null) throw new Error("fixture image missing");
					await app.workspace.getLeaf(true).openFile(file);
					await until("the image to be active", () => app.workspace.getActiveFile()?.path === imagePath);
					const ran = app.commands.executeCommandById("geb:georeference-image");
					if (!ran) throw new Error("the command was not offered for the active image");
					await until("the create dialog", () => q(".modal-container") !== null);
					const inputs = qa(".modal-container input") as HTMLInputElement[];
					if (inputs.length !== 2) throw new Error(`expected 2 inputs, got ${inputs.length}`);
					const prefilled = { id: inputs[0]!.value, notePath: inputs[1]!.value };
					if (prefilled.id !== id) throw new Error(`prefilled id ${prefilled.id}`);
					if (prefilled.notePath !== "fixtures/map.md") throw new Error(`prefilled note path ${prefilled.notePath}`);
					setInput(inputs[1]!, notePath);
					const cta = q(".modal-container button.mod-cta");
					if (cta === null) throw new Error("no CTA button");
					cta.click();
					await until("the dialog to close", () => q(".modal-container") === null);
					await until("the editor leaf", () => gebLeaf() !== null);
					// `setViewState` hands the view its state asynchronously; the leaf exists a beat earlier.
					await until("the leaf to take its state", () => leafState().georefId === id);
					const state = leafState();
					if (state.create?.notePath !== notePath) throw new Error(`leaf state ${JSON.stringify(state)}`);
					await until("the image to be measured", () => q(".geb-stage")?.style.width === "240px");
					await until("the status line", () => (q(".geb-status")?.textContent ?? "") !== "");
					await until("the image to decode", () => (q(".geb-image") as HTMLImageElement).complete);
					fitted("after create");
					const title = gebLeaf()!.view.getDisplayText();
					if (title !== `New map: ${id}`) throw new Error(`title ${title}`);
					const bar = q(".geb-edit-bar");
					if (bar === null || bar.style.display === "none") throw new Error("edit bar hidden in create mode");
					return `prefilled ${prefilled.id} / ${prefilled.notePath}; stage ${q(".geb-stage")!.style.width} x ${q(".geb-stage")!.style.height}; status "${q(".geb-status")!.textContent ?? ""}"`;
				},
				{ imagePath: IMAGE_PATH, notePath: NOTE_PATH, id: GEOREF_ID },
			),
	},
	{
		name: "real clicks place four points through the point dialog, each prefilled with the clicked pixel",
		run: () =>
			inWindow(
				async ({ points }: { points: readonly FixturePoint[] }) => {
					const placed: string[] = [];
					for (let i = 0; i < points.length; i++) {
						const p = points[i]!;
						const s = toScreen(p.px, p.py);
						await click(s.x, s.y);
						await until(`the point dialog for ${p.label}`, () => q(".modal-container") !== null);
						const inputs = qa(".modal-container input") as HTMLInputElement[];
						if (inputs.length !== 5) throw new Error(`expected 5 inputs, got ${inputs.length}`);
						const gotPx = Number(inputs[0]!.value);
						const gotPy = Number(inputs[1]!.value);
						// The click lands within a screen pixel of the target, which is under one image
						// pixel at any zoom the fit-to-container viewport chooses for this image.
						if (Math.abs(gotPx - p.px) > 1.5 || Math.abs(gotPy - p.py) > 1.5) throw new Error(`${p.label}: dialog prefilled ${gotPx}, ${gotPy} for click at ${p.px}, ${p.py}`);
						// Typed exactly, so the fit is exact and the residuals are provably ~0.
						setInput(inputs[0]!, String(p.px));
						setInput(inputs[1]!, String(p.py));
						setInput(inputs[2]!, String(p.lat));
						setInput(inputs[3]!, String(p.lng));
						setInput(inputs[4]!, p.label);
						q(".modal-container button.mod-cta")!.click();
						await until("the dialog to close", () => q(".modal-container") === null);
						await until(`${i + 1} marker(s)`, () => qa(".geb-overlay .geb-cp").length === i + 1);
						placed.push(`${p.label}@${gotPx.toFixed(1)},${gotPy.toFixed(1)}`);
					}
					const status = q(".geb-status")!.textContent ?? "";
					if (!/4 points/.test(status) || !/unsaved/.test(status)) throw new Error(`status "${status}"`);
					const draft = leafState().draft;
					if (draft === undefined || draft.points.length !== 4) throw new Error("the layout state does not carry the draft");
					return `${placed.join(" ")}; status "${status}"`;
				},
				{ points: POINTS },
			),
	},
	{
		name: "Save creates the note in a folder that did not exist, and the map loads with a graticule",
		run: () =>
			inWindow(
				async ({ id, notePath, points }: { id: string; notePath: string; points: readonly FixturePoint[] }) => {
					const save = buttonNamed("Save", ".geb-edit-bar");
					if (save === null || save.disabled) throw new Error("Save not offered");
					save.click();
					await until("the note to exist", () => app.vault.getAbstractFileByPath(notePath) !== null);
					await until("the index to load the map", () => api().getGeoref(id) !== null, 15_000);
					await until("the graticule", () => qa(".geb-graticule").length > 0, 15_000);
					await until("the edit bar to hide", () => q(".geb-edit-bar")!.style.display === "none");
					fitted("after save");
					const fit = api().getFit(id);
					if (fit.pointCount !== 4) throw new Error(`fit has ${fit.pointCount} points`);
					if (fit.model !== "tps") throw new Error(`model ${fit.model}`);
					const rms = fit.diagnostics.affineRms;
					if (!(rms < 1e-6)) throw new Error(`affine RMS ${rms} for an exactly affine fixture`);
					for (let i = 0; i < 4; i++) {
						const w = fit.points[i]!;
						const want = points[i]!;
						if (w.label !== want.label || w.lat !== want.lat) throw new Error(`point ${i} stored as ${JSON.stringify(w)}`);
					}
					if (app.vault.getFolderByPath("maps/live") === null) throw new Error("the nested folder was not created");
					const state = leafState();
					if (state.create !== undefined || state.draft !== undefined) throw new Error(`leaf still carries ${JSON.stringify(state)}`);
					const title = gebLeaf()!.view.getDisplayText();
					if (title !== `Map: ${id}`) throw new Error(`title ${title}`);
					const edit = buttonNamed("Edit", ".geb-toolbar");
					if (edit === null || edit.disabled || edit.style.display === "none") throw new Error("Edit not offered after the save");
					const status = q(".geb-status")!.textContent ?? "";
					return `${qa(".geb-graticule").length} graticule runs, RMS ${rms.toExponential(1)} px, status "${status}"`;
				},
				{ id: GEOREF_ID, notePath: NOTE_PATH, points: POINTS },
			),
	},
	{
		name: "the Mercator model can be chosen, saved and reloaded",
		run: () =>
			inWindow(
				async ({ id, notePath }: { id: string; notePath: string }) => {
					// Only the model round trip is asserted: the fixture is equirectangular, so a Mercator
					// fit's RMS here says nothing about the model, and the checks below were written against
					// the default model, which is restored at the end.
					const choose = async (kind: string, unsavedFirst: boolean): Promise<void> => {
						// Edit is DISABLED while a save awaits the index (the post-write window is a state,
						// not a flag), and the check before this one ends on the graticule, not on that
						// window closing. Wait for the door to open before pushing it.
						await until("Edit to be offered", () => !buttonNamed("Edit", ".geb-toolbar")!.disabled, 15_000);
						buttonNamed("Edit", ".geb-toolbar")!.click();
						await until("the edit bar", () => q(".geb-edit-bar")!.style.display !== "none");
						const select = q(".geb-edit-bar select") as HTMLSelectElement | null;
						if (select === null) throw new Error("no model select in the edit bar");
						select.value = kind;
						select.dispatchEvent(new Event("change", { bubbles: true }));
						if (unsavedFirst) await until(`the status to name ${kind}`, () => (q(".geb-status")?.textContent ?? "").startsWith(`${kind}, 4 points`));
						buttonNamed("Save", ".geb-edit-bar")!.click();
						await until("the save to land", () => !/unsaved/.test(q(".geb-status")?.textContent ?? "") && api().getFit(id).model === kind, 15_000);
						await until("the edit bar to hide", () => q(".geb-edit-bar")!.style.display === "none");
					};
					// Whatever model the note had, it has again afterwards, even if a step throws:
					// the checks after this one were written against the default and share the note.
					const original = api().getFit(id).model;
					let stored: unknown;
					let status = "";
					try {
						await choose("mercator", true);
						const file = app.vault.getFileByPath(notePath);
						if (file === null) throw new Error("the saved note is missing");
						await until("the note's frontmatter to carry the model", () => {
							const fits = app.metadataCache.getFileCache(file)?.frontmatter?.["geb-fits"] as { transform?: { model?: unknown } }[] | undefined;
							stored = fits?.[0]?.transform?.model;
							return stored === "mercator";
						}, 15_000);
						status = q(".geb-status")?.textContent ?? "";
					} finally {
						if (api().getFit(id).model !== original) await choose(original, false);
					}
					return `stored model ${String(stored)}, status "${status}"; restored to ${api().getFit(id).model}`;
				},
				{ id: GEOREF_ID, notePath: NOTE_PATH },
			),
	},
	{
		name: "the doors: a ribbon icon lists the maps, and a georeference note's header action opens its map",
		run: () =>
			inWindow(
				async ({ notePath, id }: { notePath: string; id: string }) => {
					if (q('.side-dock-ribbon-action[aria-label="Open maps"]') === null) throw new Error("no ribbon icon");
					const file = app.vault.getFileByPath(notePath);
					if (file === null) throw new Error("the saved note is missing");
					const noteLeaf = app.workspace.getLeaf(true);
					await noteLeaf.openFile(file);
					// THIS note's action, not the first in the document: the Guildmaster's own georef
					// note was open one tab over, and its door opened their map, not ours.
					const action = (): HTMLElement | null => noteLeaf.view.containerEl.querySelector('.view-action[aria-label="Open map"]');
					await until("the note's header action", () => action() !== null);
					// From a closed map, so the action is seen to OPEN one rather than reveal one.
					gebLeaf()?.detach();
					action()!.click();
					await until("the map leaf", () => gebLeaf() !== null);
					await until("the leaf to take its state", () => leafState().georefId === id);
					noteLeaf.detach();
					return "ribbon icon present; the note's header action opened its map";
				},
				{ notePath: NOTE_PATH, id: GEOREF_ID },
			),
	},
	{
		name: "a place note lands on the map as a pin at the pixel the fixture rule predicts",
		run: () =>
			inWindow(
				async ({ id }) => {
					const pins = api().featuresIn(id);
					const alpha = pins?.find((p) => p.feature.notePath === "places/Alpha.md");
					if (alpha === undefined) throw new Error(`Alpha not on the map: ${JSON.stringify(pins)}`);
					// Alpha is lat 56, lng -4: pixel (60, 40) under the rule.
					if (Math.abs(alpha.x - 60) > 1e-6 || Math.abs(alpha.y - 40) > 1e-6) throw new Error(`Alpha at ${alpha.x}, ${alpha.y}`);
					// ALPHA'S pin, not "the one pin": the fixture rule covers all of Britain, so any
					// hand-test place notes sharing the vault land on this map too, and rightly.
					const alphaDrawn = (): boolean => qa(".geb-overlay .geb-pin-label").some((l) => l.textContent === "Alpha");
					await until("the Alpha pin to be drawn", alphaDrawn);
					return `Alpha at (${alpha.x}, ${alpha.y}), extrapolated=${String(alpha.extrapolated)}`;
				},
				{ id: GEOREF_ID },
			),
	},
	{
		name: "the reference line is drawn, the toggle hides and shows it, it stays while a point is placed, and Discard drops that draft",
		run: () =>
			inWindow(
				async ({ id, label, confirm, px, py, lat, lng }) => {
					// The tracked fixture Geb/reference/test-coast.geojson; this check never writes there.
					const lines = (): number => qa(".geb-overlay .geb-reference").length;
					await until("the reference line to be drawn", () => lines() > 0, 15_000);
					const drawn = lines();
					buttonNamed(label, ".geb-toolbar")!.click();
					await until("the reference line to hide", () => lines() === 0);
					buttonNamed(label, ".geb-toolbar")!.click();
					await until("the reference line to return", () => lines() > 0);
					// GEOMETRY, not just a count: the fixture line runs (-8, 58) to (12, 30), and under the
					// fixture rule lat = 60 - py/10, lng = px/10 - 10 every vertex lies on the one segment
					// from pixel (20, 20) to (220, 300). A line drawn through a wrong fit, or with x and y
					// swapped, would still count as one polyline.
					// AMONG EVERY RUN, not the first: the vault may hold other reference files (the owner's
					// own coastline draws on this map too), so the fixture line is found by its shape.
					const runs = (): [number, number][][] =>
						qa(".geb-overlay .geb-reference").map((el) =>
							(el.getAttribute("points") ?? "")
								.trim()
								.split(/\s+/)
								.filter((pair) => pair !== "")
								.map((pair) => pair.split(",").map(Number) as [number, number]),
						);
					const allPoints = (): string => qa(".geb-overlay .geb-reference").map((el) => el.getAttribute("points") ?? "").join("|");
					// Distance to the SEGMENT (20,20)-(220,300): clamp the projection to its ends.
					const offSegment = ([x, y]: [number, number]): number => {
						const dx = 200;
						const dy = 280;
						const t = Math.max(0, Math.min(1, ((x - 20) * dx + (y - 20) * dy) / (dx * dx + dy * dy)));
						return Math.hypot(x - (20 + t * dx), y - (20 + t * dy));
					};
					const nearEnd = ([x, y]: [number, number]): boolean => Math.hypot(x - 20, y - 20) <= 2 || Math.hypot(x - 220, y - 300) <= 2;
					const fixtureRun = runs().find((verts) => verts.length >= 2 && nearEnd(verts[0]!) && nearEnd(verts[verts.length - 1]!) && verts.every((v) => offSegment(v) <= 2));
					if (fixtureRun === undefined) {
						const starts = runs().map((v) => (v[0] ? `(${v[0][0].toFixed(1)}, ${v[0][1].toFixed(1)})` : "(empty)")).slice(0, 6).join(" ");
						throw new Error(`no drawn run lies on the fixture line (20,20)-(220,300) within 2 px; ${runs().length} run(s), starting ${starts}`);
					}
					const worst = Math.max(...fixtureRun.map(offSegment));
					const before = allPoints();
					buttonNamed("Edit", ".geb-toolbar")!.click();
					await until("the edit bar", () => q(".geb-edit-bar")!.style.display !== "none");
					const s = toScreen(px, py);
					await click(s.x, s.y);
					await until("the point dialog", () => q(".modal-container") !== null);
					const inputs = qa(".modal-container input") as HTMLInputElement[];
					setInput(inputs[2]!, String(lat));
					setInput(inputs[3]!, String(lng));
					q(".modal-container button.mod-cta")!.click();
					await until("the dialog to close", () => q(".modal-container") === null);
					await until("5 markers", () => qa(".geb-overlay .geb-cp").length === 5);
					const whileEditing = lines();
					if (whileEditing === 0) throw new Error("the reference line vanished while editing");
					// The overlay follows the draft: a fifth point refits, and the line is re-planned.
					await until("the reference lines to follow the draft", () => allPoints() !== "" && allPoints() !== before);
					buttonNamed("Discard", ".geb-edit-bar")!.click();
					await until("the discard confirmation", () => buttonNamed(confirm, ".modal") !== null);
					buttonNamed(confirm, ".modal")!.click();
					await until("markers to clear", () => qa(".geb-overlay .geb-cp").length === 0);
					await until("the edit bar to hide", () => q(".geb-edit-bar")!.style.display === "none");
					if (api().getFit(id).pointCount !== 4) throw new Error("Discard wrote something");
					return `${drawn} line(s) drawn on the fixture line (worst ${worst.toFixed(2)} px), hidden, shown, ${whileEditing} while editing and re-planned, draft discarded`;
				},
				// lng 4, not the rule's 2: a point ON the fixture rule leaves the fit unbent, and the 'overlay moved'
				// assertion would then pass on float noise alone (a reviewer's catch).
				{ id: GEOREF_ID, label: COPY.reference.button, confirm: COPY.discard.confirm, px: 120, py: 160, lat: 44, lng: 4 },
			),
	},
	{
		name: "Edit, drag a point with the mouse, Save: the write lands and the map reloads from the vault",
		run: () =>
			inWindow(
				async ({ id, points }: { id: string; points: readonly FixturePoint[] }) => {
					buttonNamed("Edit", ".geb-toolbar")!.click();
					await until("the edit bar", () => q(".geb-edit-bar")!.style.display !== "none");
					await until("markers", () => qa(".geb-overlay .geb-cp").length === 4);
					const before = api().getFit(id).points[0]!;
					const s = stage();
					const p0 = points[0]!;
					const from = toScreen(p0.px, p0.py);
					// Press a little off centre, as a hand does, then drag 30 by 20 screen pixels.
					const grabAt = { x: from.x + 3, y: from.y + 2 };
					mouse("mouseMove", grabAt.x, grabAt.y);
					await sleep(30);
					mouse("mouseDown", grabAt.x, grabAt.y);
					await sleep(60);
					for (let k = 1; k <= 4; k++) {
						mouse("mouseMove", grabAt.x + (30 * k) / 4, grabAt.y + (20 * k) / 4, true);
						await sleep(40);
					}
					mouse("mouseUp", grabAt.x + 30, grabAt.y + 20);
					await sleep(100);
					if (q(".modal-container") !== null) throw new Error("a drag opened a dialog");
					const moved = leafState().draft?.points[0];
					if (moved === undefined) throw new Error("no draft after the drag");
					const expect = { px: p0.px + 30 / s.scale, py: p0.py + 20 / s.scale };
					if (Math.abs(moved.px - expect.px) > 1 || Math.abs(moved.py - expect.py) > 1) throw new Error(`dragged to ${moved.px}, ${moved.py}; expected ${expect.px}, ${expect.py}`);
					if (moved.lat !== before.lat) throw new Error("a drag changed the coordinate");
					const status = q(".geb-status")!.textContent ?? "";
					if (!/unsaved/.test(status)) throw new Error(`status after drag "${status}"`);
					buttonNamed("Save", ".geb-edit-bar")!.click();
					await until("the fit to reload from the vault", () => Math.abs(api().getFit(id).points[0]!.px - expect.px) < 1, 15_000);
					await until("the edit bar to hide", () => q(".geb-edit-bar")!.style.display === "none");
					await until("markers to clear", () => qa(".geb-overlay .geb-cp").length === 0);
					const after = api().getFit(id);
					if (!(after.diagnostics.affineRms > 1)) throw new Error(`moving a point should have cost residual; RMS ${after.diagnostics.affineRms}`);
					const a0 = after.points[0]!;
					return `point 0 ${before.px.toFixed(1)},${before.py.toFixed(1)} -> ${a0.px.toFixed(1)},${a0.py.toFixed(1)}; RMS now ${after.diagnostics.affineRms.toFixed(1)} px`;
				},
				{ id: GEOREF_ID, points: POINTS },
			),
	},
	{
		name: "a dirty draft survives the leaf being closed and reopened from its layout state, and Discard reverts it",
		run: () =>
			inWindow(
				async ({ id, confirm }) => {
					buttonNamed("Edit", ".geb-toolbar")!.click();
					await until("markers", () => qa(".geb-overlay .geb-cp").length === 4);
					const p3 = api().getFit(id).points[3]!;
					const at = toScreen(p3.px, p3.py);
					await click(at.x, at.y);
					await until("a selected marker", () => qa(".geb-overlay .geb-cp-selected").length === 1);
					buttonNamed("Delete point", ".geb-edit-bar")!.click();
					await until("3 markers", () => qa(".geb-overlay .geb-cp").length === 3);
					const saved = gebLeaf()!.getViewState();
					if ((saved.state as LeafState).draft?.points.length !== 3) throw new Error(`layout state ${JSON.stringify(saved.state)}`);
					gebLeaf()!.detach();
					await until("the leaf to go", () => gebLeaf() === null);
					const leaf = app.workspace.getLeaf(true);
					await leaf.setViewState({ type: saved.type, state: saved.state ?? {}, active: true });
					await until("the restored leaf", () => gebLeaf() !== null);
					await until("3 restored markers", () => qa(".geb-overlay .geb-cp").length === 3, 15_000);
					const status = q(".geb-status")!.textContent ?? "";
					if (!/3 points/.test(status) || !/unsaved/.test(status)) throw new Error(`restored status "${status}"`);
					buttonNamed("Discard", ".geb-edit-bar")!.click();
					// A dirty draft asks first; the markers must still be there while it asks.
					await until("the discard confirmation", () => buttonNamed(confirm, ".modal") !== null);
					if (qa(".geb-overlay .geb-cp").length !== 3) throw new Error("Discard acted before it was confirmed");
					buttonNamed(confirm, ".modal")!.click();
					await until("markers to clear", () => qa(".geb-overlay .geb-cp").length === 0);
					await until("the edit bar to hide", () => q(".geb-edit-bar")!.style.display === "none");
					if (api().getFit(id).pointCount !== 4) throw new Error("Discard wrote something");
					if (leafState().draft !== undefined) throw new Error("the layout still carries a draft after Discard");
					return `restored 3-point draft, status "${status}", confirmed and discarded`;
				},
				{ id: GEOREF_ID, confirm: COPY.discard.confirm },
			),
	},
	{
		name: "the leaf survives a plugin reload and shows the map again (inferred in stage B, measured here)",
		run: async () => {
			await cli(["plugin:reload", "id=geb"]);
			return inWindow(
				async ({ id }) => {
					await until("api.ready after reload", () => app.plugins.plugins.geb?.api?.ready === true, 15_000);
					await until("the leaf to be back", () => gebLeaf() !== null, 15_000);
					await until(
						"the map to show",
						() => {
							const m = q(".geb-message");
							return (m === null || m.style.display === "none") && /4 points/.test(q(".geb-status")?.textContent ?? "");
						},
						20_000,
					);
					// Give the leaf a moment to settle, then it must be fitted and the image decoded.
					await sleep(500);
					fitted("after reload");
					const leaves = app.workspace.getLeavesOfType("geb-georef").filter((l) => (l.getViewState().state ?? {}).georefId === id).length;
					if (leaves !== 1) throw new Error(`${leaves} of our leaves after reload`);
					if (leafState().georefId !== id) throw new Error("leaf lost its id");
					return `1 leaf, status "${q(".geb-status")!.textContent ?? ""}"`;
				},
				{ id: GEOREF_ID },
			);
		},
	},
	{
		name: "nothing is left open and the app logged no error from geb",
		run: async () => {
			const modals = await inWindow(() => qa(".modal-container").length, null);
			if (modals !== 0) throw new Error(`${modals} modal(s) left open`);
			const errors = await cli(["dev:errors"]);
			const ours = errors.split(/\r?\n/).filter((l) => /geb/i.test(l));
			if (ours.length > 0) throw new Error(`errors mentioning geb:\n${ours.join("\n")}`);
			return "no modals, no errors";
		},
	},
];

// --- run ------------------------------------------------------------------------------------------
// Printed through the error stream like the other gates: the store's lint forbids console.log.

async function main(): Promise<number> {
	if (!(await Bun.file(OBSIDIAN).exists())) {
		console.error(`Obsidian CLI not found at ${OBSIDIAN}`);
		console.error("GATE FAILED");
		return 2;
	}
	console.error(`live gate against ${VAULT_NAME} (${VAULT_DIR})`);
	await installPlugin();
	await openVault();
	await loadPlugin();
	await cli(["dev:errors", "clear"]);
	await resetFixture();

	let failed = 0;
	let skipped = 0;
	for (const [i, check] of CHECKS.entries()) {
		if (failed > 0) {
			// The checks build on one another; after a failure the rest would only report its wake.
			skipped += 1;
			console.error(`  skip ${check.name}`);
			continue;
		}
		const started = Date.now();
		const took = (): string => `${((Date.now() - started) / 1000).toFixed(1)} s`;
		try {
			const note = await check.run();
			console.error(`  ok   ${check.name} (${took()})\n       ${note}`);
		} catch (e) {
			failed += 1;
			console.error(`  FAIL ${check.name} (${took()})\n       ${e instanceof Error ? e.message : String(e)}`);
			try {
				// What the app itself caught, so the cause sits in the same log as the symptom.
				const errs = (await cli(["dev:errors"])).split(/\r?\n/).filter((l) => l.trim() !== "" && !/^No errors/.test(l));
				if (errs.length > 0) console.error(`       app errors:\n${errs.slice(0, 12).map((l) => `         ${l}`).join("\n")}`);
			} catch {
				// The buffer is a courtesy too.
			}
			try {
				await cli(["dev:screenshot", `path=${SHOTS_DIR}/fail-${i + 1}.png`]);
				console.error(`       screenshot: test/live/screenshots/fail-${i + 1}.png`);
			} catch {
				// A screenshot is a courtesy, not a check.
			}
		}
	}
	try {
		await cli(["dev:screenshot", `path=${SHOTS_DIR}/final.png`]);
	} catch {
		// Same.
	}
	await resetFixture();
	console.error(`${CHECKS.length - failed - skipped}/${CHECKS.length} live checks passed${skipped > 0 ? `, ${skipped} skipped` : ""}`);
	console.error(failed === 0 ? "GATE GREEN" : "GATE FAILED");
	return failed === 0 ? 0 : 1;
}

process.exit(await main());
