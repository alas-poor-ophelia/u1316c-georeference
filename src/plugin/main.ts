import { debounce, FileView, MarkdownView, normalizePath, Notice, Plugin, TFile, type Debouncer, type EventRef, type View } from "obsidian";
import { ApiController } from "../api/controller";
import type { GebAPI } from "../api/types";
import { reconcile, type ReconcileOutcome } from "../persist/reconcile";
import { handleRename } from "../persist/rename";
import type { VaultPort } from "../persist/types";
import { COPY } from "../view/copy";
import { CreateGeorefModal, MapPicker, type CreateChoice } from "../view/modals";
import type { CreateSource } from "../view/shell";
import { GeorefView, VIEW_TYPE } from "../view/view";
import { IMAGE_EXTENSIONS, ObsidianVault } from "./vault-adapter";

/**
 * The one place the plugin's display name lives. Wadjet scatters its display name
 * across seven call sites while its id says something else; Geb does not repeat that.
 */
export const DISPLAY_NAME = "U+1316C Georeference";

function isImage(file: TFile): boolean {
	return IMAGE_EXTENSIONS.has(file.extension.toLowerCase());
}

export default class GebPlugin extends Plugin {
	private vault: VaultPort | null = null;
	/** Checked between notes so an in-flight handler stops writing once the plugin is gone. */
	private alive = false;
	private controller: ApiController | null = null;
	/**
	 * The debounce that decides when EVENTS fire — never whether an answer is current.
	 *
	 * A query against a dirty index rebuilds synchronously, so this timer can never starve a
	 * caller. It exists because Obsidian fires `changed` per note during a sync burst, and waking
	 * every consumer per note would be the pathology the architecture call warned about. 150 ms is
	 * long enough to coalesce a burst and short enough that a single edit feels immediate.
	 */
	private flushSoon: Debouncer<[], void> | null = null;

	/**
	 * The public surface, reachable as `app.plugins.plugins.geb.api`.
	 *
	 * Present from `onload`, but `api.ready` stays false until Obsidian has indexed the vault —
	 * every vault-backed method throws `geb-not-ready` until then, because an empty answer read
	 * off a half-built metadata cache would be a confident lie. Consumers wait for `geb:ready`.
	 */
	api: GebAPI | null = null;

	override onload(): void {
		this.vault = new ObsidianVault(this.app);
		this.alive = true;
		this.controller = new ApiController(this.vault, this.manifest.version);
		this.api = this.controller.api;

		// THE VIEW IS A CONSUMER OF THE API, handed a getter rather than the object: it must see
		// `null` after unload and the new object after a reload, exactly as a third-party plugin
		// would by re-reading `app.plugins.plugins.geb.api`. Passing the object would let the
		// view keep a dead API alive past `geb:unload`.
		this.registerView(VIEW_TYPE, (leaf) => new GeorefView(leaf, () => this.api));
		this.addCommand({
			id: "open-georef-view",
			name: "Open georeference view",
			// Available only when the active note IS a loaded georeference, so the palette does
			// not offer a map for a note that has none.
			checkCallback: (checking) => {
				const id = this.georefIdOfActiveFile();
				if (id === null) return false;
				if (!checking) void this.openView(id);
				return true;
			},
		});
		// THE WAY IN FOR AN IMAGE WITH NO NOTE. Offered when the active file is an image, and from
		// the file explorer's menu on one — a note-side affordance was deferred from stage B to
		// here. An image that already has a map opens that map rather than starting a second.
		this.addCommand({
			id: "georeference-image",
			name: "Georeference this image",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (file === null || !isImage(file)) return false;
				if (!checking) this.offerGeoreference(file);
				return true;
			},
		});
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || !isImage(file)) return;
				menu.addItem((item) =>
					item
						.setTitle("Georeference this image")
						.setIcon("map")
						.onClick(() => this.offerGeoreference(file)),
				);
			}),
		);

		// VISIBLE DOORS. Until these, the only ways to a map were two palette commands, and a vault
		// of georeference notes looked like a vault of plain notes: the Guildmaster copied two
		// fixtures in and saw "no evidence of the plugin at all". A ribbon icon lists the maps, a
		// georeference note gets a header action that opens its map, and an image gets one that
		// georeferences it or opens the map it already has.
		this.addRibbonIcon("map", COPY.doors.ribbon, () => this.openMaps());
		this.addCommand({ id: "open-maps", name: COPY.doors.command, callback: () => this.openMaps() });
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshActions()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.refreshActions()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshActions()));

		// Geb owns rename handling outright: the metadata cache's `changed` event explicitly does
		// not fire on rename, so this is the only notification there is.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				void this.onRename(oldPath, file.path);
			}),
		);

		// Reconciliation is the safety net the rename handler cannot be. A rename that arrived
		// while Geb was disabled, or during indexing, or as a sync delete-plus-create, carries an
		// old path that exists nowhere afterwards — so recovery has to work from stored content
		// instead of from an event. Run it once, after the cache has actually been built:
		// `resolved` refires on every later change, so the listener detaches itself.
		this.app.workspace.onLayoutReady(() => {
			// READY IS DECLARED IN ONE PLACE. `resolved` is the signal that the metadata cache is
			// fully built, and every vault-backed API method refuses until then — the same "the
			// vault was still indexing" hazard reconciliation handles, arriving in the query layer.
			const declareReady = (): void => {
				this.controller?.markReady();
				this.app.workspace.trigger("geb:ready");
				this.refreshActions();
				// REGISTERED ONLY NOW, after the cache has resolved. Obsidian fires `changed` once
				// per file while indexing — 50,000 of them on a large vault — and every one would
				// be an invalidation of an index the first build is about to make anyway.
				this.watchVault();
				void this.runReconcile();
			};
			// BUT `resolved` MAY ALREADY HAVE FIRED. Measured live on 1.14.4, fixture vault: a
			// plugin enabled from settings, reloaded, or loaded at startup into a small vault
			// finds the cache already built, and `resolved` never fires again on its own — so a
			// listener registered now waits forever and the plugin is dead until some file
			// changes. The cache carries an undocumented `initialized` flag that is true once the
			// initial build is done; when it says so, ready is declared at once. If the flag is
			// ever absent, this falls through to waiting, which is the old behaviour.
			const cache = this.app.metadataCache as typeof this.app.metadataCache & { readonly initialized?: boolean };
			if (cache.initialized === true) {
				declareReady();
				return;
			}
			const holder: { ref: EventRef | null } = { ref: null };
			holder.ref = cache.on("resolved", () => {
				if (holder.ref !== null) cache.offref(holder.ref);
				declareReady();
			});
			this.registerEvent(holder.ref);
		});
	}

	/**
	 * The API's own `unload` event fires FIRST, then the workspace event.
	 *
	 * A consumer holding the api object hears directly before the broadcast, so it can drop its
	 * reference before anything else reacts. After this every method throws `geb-unloaded`, which
	 * is what a consumer needs instead of an empty answer from a dead plugin.
	 */
	override onunload(): void {
		this.alive = false;
		// Cancelled before the controller goes, or a pending flush fires into a dead API.
		this.flushSoon?.cancel();
		this.flushSoon = null;
		this.controller?.unload();
		this.app.workspace.trigger("geb:unload");
		this.controller = null;
		this.api = null;
		this.vault = null;
	}

	/** The id of the georeference the active note holds, through the public API, or null. */
	/** The list of maps, or a nudge toward making the first one. */
	private openMaps(): void {
		const api = this.api;
		if (api === null || !api.ready) {
			new Notice(COPY.notReady);
			return;
		}
		const maps = api.listGeorefs();
		if (maps.length === 0) {
			new Notice(COPY.doors.none);
			return;
		}
		new MapPicker(this.app, maps, (g) => void this.openView(g.id)).open();
	}

	/**
	 * Header actions, one per open file view that qualifies: a note that is a loaded map, or an
	 * image. Keyed by what the action would do, because a markdown view is reused for file after
	 * file — an action added for one note must not survive into the next.
	 */
	private readonly actions = new WeakMap<View, { readonly key: string; readonly el: HTMLElement }>();

	private refreshActions(): void {
		if (!this.alive) return;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (!(view instanceof FileView)) return;
			const wanted = view.file === null ? null : this.actionFor(view, view.file);
			const current = this.actions.get(view);
			if (current !== undefined && (wanted === null || wanted.key !== current.key)) {
				current.el.remove();
				this.actions.delete(view);
			}
			if (wanted !== null && (current === undefined || wanted.key !== current.key)) {
				this.actions.set(view, { key: wanted.key, el: view.addAction("map", wanted.title, wanted.run) });
			}
		});
	}

	private actionFor(view: FileView, file: TFile): { readonly key: string; readonly title: string; readonly run: () => void } | null {
		if (view instanceof MarkdownView) {
			const id = this.georefIdOfNote(file.path);
			return id === null ? null : { key: "note:" + id, title: COPY.doors.note, run: () => void this.openView(id) };
		}
		if (view.getViewType() === "image" && isImage(file)) {
			return { key: "image:" + file.path, title: COPY.doors.image, run: () => this.offerGeoreference(file) };
		}
		return null;
	}

	/** The id of the loaded georeference stored in the note at `path`, or null. */
	private georefIdOfNote(path: string): string | null {
		const api = this.api;
		if (api === null || !api.ready) return null;
		return api.listGeorefs().find((g) => g.notePath === path)?.id ?? null;
	}

	private georefIdOfActiveFile(): string | null {
		const file = this.app.workspace.getActiveFile();
		return file === null ? null : this.georefIdOfNote(file.path);
	}

	/** The id of the loaded georeference whose image is `path`, through the public API, or null. */
	private georefIdOfImage(api: GebAPI, path: string): string | null {
		for (const g of api.listGeorefs()) {
			try {
				if (api.getImageInfo(g.id).path === path) return g.id;
			} catch {
				// A map that vanished between the two calls: not this image's, either way.
			}
		}
		return null;
	}

	/** The entry for an image: always offered, and before the vault is indexed it says so rather than vanish. */
	private offerGeoreference(file: TFile): void {
		if (this.api?.ready !== true) {
			new Notice(COPY.notReady);
			return;
		}
		void this.georeference(file);
	}

	/**
	 * Open the editor on an image. Its existing map if it has one; otherwise ask once where the
	 * note goes and what the id is, prefilled from the image's name, and open the view in its
	 * no-note-yet mode. Nothing is written until the user saves their first points.
	 */
	private async georeference(file: TFile): Promise<void> {
		const api = this.api;
		if (api === null || !api.ready) return;
		const existing = this.georefIdOfImage(api, file.path);
		if (existing !== null) {
			await this.openView(existing);
			return;
		}
		// An unsaved create leaf for this image is invisible to the index; a second one would
		// let two notes be written for one image. Reveal the one already open instead.
		const started = this.app.workspace
			.getLeavesOfType(VIEW_TYPE)
			.find((l) => (l.getViewState().state?.create as Partial<CreateSource> | undefined)?.imagePath === file.path);
		if (started !== undefined) {
			await this.app.workspace.revealLeaf(started);
			this.app.workspace.setActiveLeaf(started, { focus: true });
			return;
		}
		const folder = file.parent === null || file.parent.path === "/" ? "" : `${file.parent.path}/`;
		const defaults: CreateChoice = { id: file.basename, notePath: normalizePath(`${folder}${file.basename}.md`) };
		const refuse = (choice: CreateChoice): string | null => {
			try {
				if (api.getGeoref(choice.id) !== null) return `Another note already claims the id "${choice.id}".`;
			} catch (e) {
				return e instanceof Error ? e.message : String(e);
			}
			if (this.app.vault.getAbstractFileByPath(normalizePath(choice.notePath)) !== null) return `A file already exists at ${choice.notePath}.`;
			return null;
		};
		new CreateGeorefModal(this.app, defaults, refuse, (choice) => {
			void this.openView(choice.id, { imagePath: file.path, notePath: normalizePath(choice.notePath) });
		}).open();
	}

	/**
	 * Reveal the leaf already showing this map, or open a new one. One leaf per map, never two.
	 *
	 * Matched on the leaf's SERIALISED STATE, not on `instanceof`. A background tab restored at
	 * startup is a `DeferredView` until it is first shown (Obsidian 1.7.2+), and after a plugin
	 * reload any surviving leaf holds the previous module's class — `instanceof` is false in both
	 * cases, and a view that cannot recognise its own leaf opens a duplicate. The state is what the
	 * workspace layout stored, and it is the same whichever class is behind the leaf.
	 */
	private async openView(georefId: string, create?: CreateSource): Promise<void> {
		const existing = this.app.workspace
			.getLeavesOfType(VIEW_TYPE)
			.find((l) => l.getViewState().state?.georefId === georefId);
		const leaf = existing ?? this.app.workspace.getLeaf(true);
		// A leaf already on this id may be sitting on "no such georeference" from an earlier
		// attempt; a create for the same id must hand it the image, not merely reveal it.
		if (existing === undefined || create !== undefined) {
			const state: Record<string, unknown> = { georefId };
			if (create !== undefined) state.create = create;
			await leaf.setViewState({ type: VIEW_TYPE, state, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
		// `revealLeaf` shows the leaf; it does not necessarily make it the active one.
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	/**
	 * Errors are caught, not thrown. A rename is a user action in the file explorer with no UI of
	 * Geb's attached, so throwing surfaces as an unexplained Obsidian error notice. Anything that
	 * needed attention is reported instead.
	 */
	private async onRename(oldPath: string, newPath: string): Promise<void> {
		const port = this.vault;
		if (port === null || !this.alive) return;
		try {
			const out = await handleRename(port, oldPath, newPath, () => this.alive);
			const bad = out.filter((o) => o.action === "unresolved" || o.action === "failed");
			if (bad.length > 0) {
				// Previously the return value was discarded entirely, so "reported, not guessed"
				// had no reporter and a broken georeference failed in silence.
				new Notice(`${DISPLAY_NAME}: ${bad.length} georeference(s) need attention after a rename. See the console.`);
				for (const o of bad) console.warn(`${DISPLAY_NAME}: ${o.notePath} -> ${o.action}`, o.error ?? o.from ?? "");
			}
		} catch (e) {
			console.error(`${DISPLAY_NAME}: rename handling failed for ${oldPath} -> ${newPath}`, e);
		}
	}

	private async runReconcile(): Promise<void> {
		const port = this.vault;
		if (port === null || !this.alive) return;
		try {
			const out = await reconcile(port, () => this.alive);
			this.report(out);
		} catch (e) {
			console.error(`${DISPLAY_NAME}: reconciliation failed`, e);
		}
	}

	private report(out: readonly ReconcileOutcome[]): void {
		// RECORDED, not just printed. `getImageInfo().staleness` promised a value that nothing
		// computed, while every outcome needed to compute it was worked out here and dropped to
		// the console. Only the three outcomes that actually compared the image's bytes say
		// anything about staleness; the rest leave it at "not checked", which reports as
		// "unknown" rather than being defaulted to "same".
		for (const o of out) {
			if (o.action === "ok" || o.action === "relinked") this.controller?.recordStaleness(o.notePath, "same");
			else if (o.action === "stale") this.controller?.recordStaleness(o.notePath, "changed");
		}

		const relinked = out.filter((o) => o.action === "relinked");
		const attention = out.filter((o) => o.action !== "ok" && o.action !== "relinked");
		for (const o of [...relinked, ...attention]) {
			console.warn(`${DISPLAY_NAME}: ${o.notePath} -> ${o.action}${o.detail === undefined ? "" : `: ${o.detail}`}`);
		}
		if (relinked.length > 0) {
			new Notice(`${DISPLAY_NAME}: repaired ${relinked.length} image link(s) by matching file contents.`);
		}
		if (attention.length > 0) {
			new Notice(`${DISPLAY_NAME}: ${attention.length} georeference(s) need attention. See the console.`);
		}
	}

	/**
	 * Hook every notification that means the vault moved — and NOTHING that means Geb wrote.
	 *
	 * That asymmetry is the load-bearing rule of the index design. Geb reads through the metadata
	 * cache and writes through the frontmatter processor, with nothing ordering the two, so
	 * invalidating on a write's completion would rebuild from a cache still holding the pre-write
	 * frontmatter and publish it as current. The index catches up when `changed` says so.
	 *
	 * `metadataCache.on('changed')` deliberately does NOT fire on rename, which is why the vault's
	 * own rename event is hooked separately — and both the old and new path are invalidated,
	 * because the fingerprint diff needs to see one disappear and the other appear.
	 */
	private watchVault(): void {
		const touch = (path?: string): void => {
			this.controller?.host.invalidate(path);
			this.flushSoon?.();
		};
		this.flushSoon = debounce(() => {
			this.controller?.flush();
		}, 150, true);

		this.registerEvent(this.app.metadataCache.on("changed", (file) => touch(file.path)));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				touch(oldPath);
				touch(file.path);
			}),
		);
		// A folder create or delete moves many notes at once and names only the folder, so the
		// honest response is "somewhere" — a full diff rather than a scoped one that misses them.
		this.registerEvent(this.app.vault.on("create", (file) => touch(file instanceof TFile ? file.path : undefined)));
		this.registerEvent(this.app.vault.on("delete", (file) => touch(file instanceof TFile ? file.path : undefined)));
	}
}
