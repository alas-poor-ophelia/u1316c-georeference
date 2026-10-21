import { debounce, Notice, Plugin, TFile, type Debouncer, type EventRef } from "obsidian";
import { ApiController } from "../api/controller";
import type { GebAPI } from "../api/types";
import { reconcile, type ReconcileOutcome } from "../persist/reconcile";
import { handleRename } from "../persist/rename";
import type { VaultPort } from "../persist/types";
import { GeorefView, VIEW_TYPE } from "../view/view";
import { ObsidianVault } from "./vault-adapter";

/**
 * The one place the plugin's display name lives. Wadjet scatters its display name
 * across seven call sites while its id says something else; Geb does not repeat that.
 */
export const DISPLAY_NAME = "U+1316C Georeference";

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
			const holder: { ref: EventRef | null } = { ref: null };
			holder.ref = this.app.metadataCache.on("resolved", () => {
				if (holder.ref !== null) this.app.metadataCache.offref(holder.ref);
				// READY IS DECLARED HERE AND NOWHERE ELSE. `resolved` is the only signal that the
				// metadata cache is fully built, and every vault-backed API method refuses until
				// it has fired — this is the same "the vault was still indexing" hazard
				// reconciliation already handles, arriving in the query layer.
				this.controller?.markReady();
				this.app.workspace.trigger("geb:ready");
				// REGISTERED ONLY NOW, after the cache has resolved. Obsidian fires `changed` once
				// per file while indexing — 50,000 of them on a large vault — and every one would
				// be an invalidation of an index the first build is about to make anyway.
				this.watchVault();
				void this.runReconcile();
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
	private georefIdOfActiveFile(): string | null {
		const api = this.api;
		const file = this.app.workspace.getActiveFile();
		if (api === null || !api.ready || file === null) return null;
		return api.listGeorefs().find((g) => g.notePath === file.path)?.id ?? null;
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
	private async openView(georefId: string): Promise<void> {
		const existing = this.app.workspace
			.getLeavesOfType(VIEW_TYPE)
			.find((l) => l.getViewState().state?.georefId === georefId);
		const leaf = existing ?? this.app.workspace.getLeaf(true);
		if (existing === undefined) {
			const state: Record<string, unknown> = { georefId };
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
