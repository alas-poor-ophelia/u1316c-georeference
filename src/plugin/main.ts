import { Notice, Plugin, type EventRef } from "obsidian";
import { reconcile, type ReconcileOutcome } from "../persist/reconcile";
import { handleRename } from "../persist/rename";
import type { VaultPort } from "../persist/types";
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

	override onload(): void {
		this.vault = new ObsidianVault(this.app);
		this.alive = true;

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
				void this.runReconcile();
			});
			this.registerEvent(holder.ref);
		});
	}

	override onunload(): void {
		this.alive = false;
		this.vault = null;
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
}
