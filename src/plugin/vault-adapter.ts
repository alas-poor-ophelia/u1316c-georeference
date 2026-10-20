import { TFile, type App } from "obsidian";
import { KEY, type VaultPort } from "../persist/types";

/**
 * The one place Geb touches a vault. Everything in src/persist reaches the app through this, and
 * an eslint fence keeps it that way, so the persistence logic is driven by a fake in the tests.
 *
 * Windrose does the same thing in reverse against Wadjet — one bridge file, "the one point of
 * contact" — and it is the right shape for the same reason: the coupling is confined to a file
 * you can read in one sitting.
 */
export class ObsidianVault implements VaultPort {
	constructor(private readonly app: App) {}

	private file(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(path);
		// instanceof rather than a cast: a folder sharing a path shape would otherwise sail through.
		return f instanceof TFile ? f : null;
	}

	readFrontmatter(notePath: string): Record<string, unknown> | null {
		const f = this.file(notePath);
		if (f === null) return null;
		return this.app.metadataCache.getFileCache(f)?.frontmatter ?? null;
	}

	async writeFrontmatter(notePath: string, mutate: (fm: Record<string, unknown>) => void): Promise<void> {
		const f = this.file(notePath);
		if (f === null) throw new Error(`cannot write frontmatter, no such note: ${notePath}`);
		await this.app.fileManager.processFrontMatter(f, mutate);
	}

	resolveLink(linkText: string, sourcePath: string): { readonly path: string } | null {
		const dest = this.app.metadataCache.getFirstLinkpathDest(linkText, sourcePath);
		return dest === null ? null : { path: dest.path };
	}

	/**
	 * Always wikilink form, whatever the user's "use markdown links" setting says.
	 *
	 * `generateMarkdownLink` would honour that setting and emit `[name](path)` for some users —
	 * and a markdown link in frontmatter is not parsed into `frontmatterLinks`, so the reference
	 * would stop resolving and stop appearing in the graph. `fileToLinktext` gives the same
	 * shortest-unique target Obsidian itself would choose, without the format decision.
	 */
	makeLink(targetPath: string, sourcePath: string): string {
		const f = this.file(targetPath);
		if (f === null) return `[[${targetPath}]]`;
		return `[[${this.app.metadataCache.fileToLinktext(f, sourcePath, false)}]]`;
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		const f = this.file(path);
		if (f === null) throw new Error(`no such file: ${path}`);
		return await this.app.vault.readBinary(f);
	}

	listNotes(): readonly string[] {
		return this.app.vault.getMarkdownFiles().map((f) => f.path);
	}

	listGeorefNotes(): readonly string[] {
		const out: string[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			if (fm !== undefined && typeof fm[KEY.id] === "string") out.push(f.path);
		}
		return out;
	}

	/**
	 * `stat.size` is why this method exists: reconciliation re-finds a lost image by content hash,
	 * and filtering candidates by byte length first means it reads one file or none instead of
	 * every image in the vault.
	 */
	listCandidateImages(): readonly { readonly path: string; readonly byteLength: number }[] {
		const out: { path: string; byteLength: number }[] = [];
		for (const f of this.app.vault.getFiles()) {
			if (IMAGE_EXTENSIONS.has(f.extension.toLowerCase())) {
				out.push({ path: f.path, byteLength: f.stat.size });
			}
		}
		return out;
	}
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "avif", "svg"]);
