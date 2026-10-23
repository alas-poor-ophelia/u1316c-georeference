import { debounce, type Debouncer, type Plugin, type TAbstractFile } from "obsidian";
import type { ReferenceLine, ReferenceSet } from "../api/types";
import { exceedsReferenceCap, parseGeoJsonLines, REFERENCE_MAX_BYTES } from "../reference/geojson";

/**
 * A reference folder as the path predicates compare it: lower-cased, with one trailing slash.
 * The folder comes from the settings, which store it normalised with no slashes at either end.
 */
export function referencePrefix(folder: string): string {
	return `${folder.toLowerCase().replace(/^\/+|\/+$/g, "")}/`;
}

/** The one change event the view listens for. */
export const REFERENCE_CHANGED = "geb:reference-changed";

/** The set before the first build and after dispose: one shared object. */
export const EMPTY_REFERENCES: ReferenceSet = { lines: [], sources: [], problems: [] };
const EMPTY = EMPTY_REFERENCES;

function isReferencePath(prefix: string, path: string): boolean {
	const p = path.toLowerCase();
	return p.startsWith(prefix) && p.endsWith(".geojson");
}

/**
 * Whether `path` is the reference folder or one of its ancestors (`geb`, `geb/reference`). A
 * folder renamed whole fires ONE rename, for the folder, and none for the files moved with it, so
 * a move of `Geb` in or out of place has to rebuild on the folder's own path.
 */
function holdsReferenceFolder(prefix: string, path: string): boolean {
	return prefix.startsWith(`${path.toLowerCase()}/`);
}

interface Parsed {
	readonly mtime: number;
	readonly size: number;
	readonly lines: readonly ReferenceLine[];
	readonly problems: readonly string[];
}

/**
 * Owns the current ReferenceSet. `current()` returns the same object until a rebuild finishes, so a
 * consumer may cache by identity. Each file is parsed once per (path, mtime, size).
 */
export class References {
	private set: ReferenceSet = EMPTY;
	private readonly cache = new Map<string, Parsed>();
	private rebuildSoon: Debouncer<[], void> | null = null;
	/** Bumped per rebuild so a slow earlier one cannot overwrite a later one. */
	private generation = 0;
	private alive = true;

	constructor(
		private readonly plugin: Plugin,
		private readonly readBinary: (path: string) => Promise<ArrayBuffer>,
		/** The reference folder from the settings, read afresh on every event and rebuild. */
		private readonly folder: () => string,
	) {}

	private get prefix(): string {
		return referencePrefix(this.folder());
	}

	current(): ReferenceSet {
		return this.set;
	}

	/** Call once the layout is ready: registers the vault events, then builds the first set. */
	start(): void {
		const { vault } = this.plugin.app;
		this.rebuildSoon = debounce(() => void this.rebuild(), 300, true);
		const touch = (file: TAbstractFile, oldPath?: string): void => {
			const prefix = this.prefix;
			if (isReferencePath(prefix, file.path) || (oldPath !== undefined && isReferencePath(prefix, oldPath))) this.rebuildSoon?.();
		};
		this.plugin.registerEvent(vault.on("create", (f) => touch(f)));
		this.plugin.registerEvent(vault.on("modify", (f) => touch(f)));
		this.plugin.registerEvent(vault.on("delete", (f) => touch(f)));
		this.plugin.registerEvent(
			vault.on("rename", (f, oldPath) => {
				const prefix = this.prefix;
				if (holdsReferenceFolder(prefix, f.path) || holdsReferenceFolder(prefix, oldPath)) this.rebuildSoon?.();
				else touch(f, oldPath);
			}),
		);
		void this.rebuild();
	}

	/**
	 * The reference folder setting changed. The events need no re-registering, because they read
	 * the folder on each call; what was parsed from the old folder is dropped and the new folder
	 * is read after the same debounce a vault event gets, so the old lines may stay drawn for up
	 * to 300 ms. Before `start()` there is nothing to rebuild.
	 */
	folderChanged(): void {
		if (!this.alive || this.rebuildSoon === null) return;
		// Debounced like a vault event, not immediate: the settings field may report every
		// keystroke, and each report would otherwise re-read a 10 MB coastline.
		this.cache.clear();
		this.rebuildSoon();
	}

	dispose(): void {
		this.alive = false;
		this.rebuildSoon?.cancel();
		this.rebuildSoon = null;
		this.cache.clear();
		this.set = EMPTY;
	}

	private async rebuild(): Promise<void> {
		const mine = ++this.generation;
		const prefix = this.prefix;
		const files = this.plugin.app.vault
			.getFiles()
			.filter((f) => isReferencePath(prefix, f.path))
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		const lines: ReferenceLine[] = [];
		const sources: string[] = [];
		const problems: string[] = [];
		const seen = new Set<string>();
		for (const f of files) {
			seen.add(f.path);
			if (exceedsReferenceCap(f.stat.size)) {
				problems.push(`${f.path}: larger than ${REFERENCE_MAX_BYTES / (1024 * 1024)} MiB, not read`);
				continue;
			}
			let parsed = this.cache.get(f.path);
			if (parsed === undefined || parsed.mtime !== f.stat.mtime || parsed.size !== f.stat.size) {
				try {
					const text = new TextDecoder().decode(await this.readBinary(f.path));
					const out = parseGeoJsonLines(text, f.path);
					parsed = { mtime: f.stat.mtime, size: f.stat.size, lines: out.lines, problems: out.problems };
					this.cache.set(f.path, parsed);
				} catch (e) {
					problems.push(`${f.path}: ${e instanceof Error ? e.message : String(e)}`);
					continue;
				}
			}
			if (!this.alive || mine !== this.generation) return;
			sources.push(f.path);
			for (const l of parsed.lines) lines.push(l);
			for (const p of parsed.problems) problems.push(p);
		}
		if (!this.alive || mine !== this.generation) return;
		for (const path of [...this.cache.keys()]) if (!seen.has(path)) this.cache.delete(path);
		// Empty before and empty now: nothing to tell anyone. A vault with no reference files must
		// not wake every open map view (and its overlay planning) on each unrelated rebuild.
		const empty = lines.length === 0 && sources.length === 0 && problems.length === 0;
		if (empty && this.set.lines.length === 0 && this.set.sources.length === 0 && this.set.problems.length === 0) return;
		this.set = { lines, sources, problems };
		this.plugin.app.workspace.trigger(REFERENCE_CHANGED);
	}
}
