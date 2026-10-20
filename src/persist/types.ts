/**
 * Persistence types, and the narrow port through which this layer touches a vault.
 *
 * Nothing here imports Obsidian — the same fence the kernel has, for the same reason. The port
 * is implemented once, against the real app, in src/plugin. Everything in src/persist is driven
 * by a fake in the tests, so rename behaviour and frontmatter round-tripping are testable without
 * launching anything.
 */
import type { TransformKind } from "../core/types";

/** What a georeference sidecar note holds. */
export interface Georeference {
	/** Stable id Geb owns. Never derived from a path, because paths move. */
	readonly id: string;
	/** Wikilink text as stored, e.g. `[[britain-5c.png]]`. */
	readonly imageLink: string;
	readonly image: ImageIdentity;
	readonly crs: string;
	readonly fits: readonly StoredFit[];
}

/**
 * One fit over one pixel area. v1 writes exactly one with `bounds: null`, but the list shape is
 * stored from the first version so insets become an addition rather than a migration.
 */
export interface StoredFit {
	readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
	readonly transform: { readonly model: TransformKind; readonly lambda?: number };
	readonly points: readonly StoredPoint[];
}

export interface StoredPoint {
	readonly px: number;
	readonly py: number;
	readonly lat: number;
	readonly lng: number;
	readonly label?: string;
}

/**
 * Enough to notice the image is not the one the control points were placed on.
 *
 * Control points are stored in image-space pixels and nothing else records WHICH image, so a
 * re-save, a resize or a replacement silently shifts every point with no error. Silent-wrong is
 * the worst failure class available, so the identity is recorded and checked.
 *
 * `byteLength` is checked first because it is free. The hash is for change detection, NOT
 * security: a non-cryptographic hash is sufficient to notice an edited file and, unlike
 * `crypto.subtle`, it needs no secure context and no async.
 */
export interface ImageIdentity {
	readonly width: number;
	readonly height: number;
	readonly byteLength: number;
	readonly hash: string;
}

export type Staleness = "same" | "changed" | "unknown";

/** A parse that never throws: frontmatter is user-editable and may hold anything at all. */
export interface ParseResult<T> {
	readonly value: T | null;
	/** Human-readable reasons the frontmatter could not be used, or was used with corrections. */
	readonly problems: readonly string[];
	/**
	 * Something in the source was DROPPED rather than merely defaulted — a malformed control
	 * point, a fit with too few usable points, an out-of-range coordinate.
	 *
	 * A lossy record must never be written back. Reading tolerantly and writing what was read
	 * would delete exactly the data the user needs to see in order to fix it, and the deletion
	 * would look like a successful save. Callers gate saving on this.
	 */
	readonly lossy: boolean;
}

/**
 * The vault operations this layer needs. Every member maps to one real Obsidian API; keeping the
 * list this short is what makes the fake in the tests honest rather than a reimplementation.
 */
export interface VaultPort {
	/** Frontmatter as the metadata cache sees it, or null if the note has none. */
	readFrontmatter(notePath: string): Record<string, unknown> | null;
	/** Mutate a note's frontmatter in place. */
	writeFrontmatter(notePath: string, mutate: (fm: Record<string, unknown>) => void): Promise<void>;
	/** Resolve a wikilink target from a source note, as Obsidian would. */
	resolveLink(linkText: string, sourcePath: string): { readonly path: string } | null;
	/** The canonical link text Obsidian would write for this target from this source. */
	makeLink(targetPath: string, sourcePath: string): string;
	/** Raw bytes of a vault file. */
	readBinary(path: string): Promise<ArrayBuffer>;
	/** Paths of every note holding a Geb georeference. */
	listGeorefNotes(): readonly string[];
	/**
	 * Paths of every markdown note in the vault.
	 *
	 * Needed to find place notes, which are ordinary notes carrying coordinates and so cannot be
	 * identified by a Geb-specific key. Frontmatter is already in Obsidian's metadata cache, so
	 * scanning it is a walk over memory rather than disk reads.
	 */
	listNotes(): readonly string[];
	/**
	 * Every file that could be a georeferenceable image, with its size.
	 *
	 * The size is the point. Reconciliation re-finds a lost image by matching the stored content
	 * hash, and hashing every image in a vault would be absurd — so it hashes only the files
	 * whose byte length already matches, which is normally one or none. Obsidian exposes this
	 * without reading the file, via `TFile.stat.size`.
	 */
	listCandidateImages(): readonly { readonly path: string; readonly byteLength: number }[];
	/**
	 * Create a note carrying this frontmatter. Rejects if the path is already taken.
	 *
	 * The API's `createGeoref` is the first thing in Geb that must MAKE a note rather than edit
	 * one, and until now this port could only read, list and write frontmatter. Frontmatter is
	 * filled by a MUTATOR, never handed over as YAML text: no part of Geb serialises YAML, and
	 * taking a mutator rather than a record means a caller can capture what it wrote from inside
	 * the callback. That matters because a newly created note is not in the metadata cache yet, so
	 * reading it back after the create returns nothing — the same read-your-writes trap that
	 * applies to editing. One capture mechanism for both, not two.
	 */
	createNote(notePath: string, mutate: (fm: Record<string, unknown>) => void): Promise<void>;
	/**
	 * Send a note to the user's trash. NOT a permanent delete.
	 *
	 * `deleteGeoref` discards a georeference its owner may have spent an hour placing control
	 * points on, and the only honest default for that is recoverable. The adapter routes it
	 * through Obsidian's own trash handling, so it obeys whatever the user configured.
	 */
	trashNote(notePath: string): Promise<void>;
}

/** Frontmatter keys. One place, so a rename of a key is a one-line change. */
export const KEY = {
	id: "geb-id",
	image: "geb-image",
	imageSize: "geb-image-size",
	imageBytes: "geb-image-bytes",
	imageHash: "geb-image-hash",
	crs: "geb-crs",
	fits: "geb-fits",
} as const;
