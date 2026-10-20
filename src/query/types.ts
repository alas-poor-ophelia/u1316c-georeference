/**
 * The coverage layer: which maps cover a coordinate, and which notes land on a map.
 *
 * Same fence as the kernel and the persistence layer — no Obsidian imports. Everything comes
 * through `VaultPort`.
 *
 * NO CACHING, and the numbers say that is affordable. Measured: 50,000 notes with 10,000 carrying
 * coordinates builds in 7 to 13 ms; fifty spline georeferences of thirty points each in 29 ms;
 * queries afterwards are 0.06 ms. What it does NOT survive is a rebuild per render frame, per
 * keystroke while control points are being placed on a large spline, or per file-change event
 * during a sync burst — a thousand changes against 30 ms is thirty seconds. So the rebuild
 * trigger is a real design decision, and it is deferred to the API phase on purpose rather than
 * guessed at here. See the note in SCOPE.md.
 */
import type { Fit, ImageSize } from "../core/fit";
import type { Georeference } from "../persist/types";

/** A place note with coordinates, as read from frontmatter. */
export interface Feature {
	readonly notePath: string;
	readonly lat: number;
	readonly lng: number;
	readonly crs: string;
	/** Radius of uncertainty, in the CRS's distance unit. */
	readonly uncertainty?: number;
	readonly certainty?: "exact" | "approximate" | "disputed";
	/**
	 * Date range as RAW TEXT. Interpreted in phase 6 by a time adapter, never parsed here — the
	 * core must treat time as an opaque comparable scalar, and deciding what "450" means is the
	 * adapter's job. Exposed on the API so a Dataview user can act on it before the slider exists.
	 */
	readonly from?: string;
	readonly to?: string;
	/** Which adapter should parse `from` and `to`. */
	readonly calendar?: string;
	/** Which frontmatter form supplied the coordinates. Read when two forms disagree. */
	readonly source: CoordinateSource;
}

export type CoordinateSource = "lat-lng" | "latitude-longitude" | "location";

/**
 * Why a note or record needed reporting.
 *
 * A code rather than only prose, because the note path used to be baked into a flat string and a
 * UI had to parse text in order to link to the note or sort by severity.
 */
export type ProblemCode =
	| "coords-out-of-range"
	/** One half of a coordinate pair is present and the other is missing or unreadable. */
	| "coords-incomplete"
	/** A string that could be one number with a decimal comma, or two integers. */
	| "coords-ambiguous"
	/** Two coordinate forms are present and disagree. */
	| "coords-conflict"
	| "unknown-crs"
	| "bad-uncertainty"
	| "bad-certainty"
	| "duplicate-id"
	/** Loaded, but with data dropped; must not be saved until the user fixes it. */
	| "lossy-record"
	| "extra-fits"
	/** Something the persistence layer reported while parsing the record. */
	| "record-problem";

export interface Problem {
	readonly notePath: string;
	readonly code: ProblemCode;
	readonly message: string;
}

/** A georeference loaded from its note and turned into a usable fit. */
export interface LoadedGeoref {
	readonly notePath: string;
	readonly record: Georeference;
	readonly size: ImageSize;
	/** v1 stores a list of fits and uses exactly one. */
	readonly fit: Fit;
}

export type RejectionCode = "unparsable" | "unknown-image-size" | "no-fits" | "degenerate-fit" | "duplicate-id";

/** A georeference that could not be used, and why. Reported rather than dropped in silence. */
export interface RejectedGeoref {
	readonly notePath: string;
	readonly code: RejectionCode;
	/** The record's id where one could be read, so a UI can name what went missing. */
	readonly id?: string;
	readonly reason: string;
}

export interface WorldIndex {
	readonly georefs: readonly LoadedGeoref[];
	readonly features: readonly Feature[];
	readonly rejected: readonly RejectedGeoref[];
	/** Problems that did not stop a record loading. */
	readonly problems: readonly Problem[];
}

/** One map that covers a coordinate, with where on it the coordinate lands. */
export interface Coverage {
	readonly georefId: string;
	readonly notePath: string;
	readonly x: number;
	readonly y: number;
	/**
	 * Outside the convex hull of the control points: resolved, but extrapolated and so fuzzy.
	 * A historian who pinned four places in the south still gets her Orkney pin — marked.
	 */
	readonly extrapolated: boolean;
}

/** A feature placed on a map. */
export interface Pin extends Coverage {
	readonly feature: Feature;
}

/** Frontmatter keys read on place notes. */
export const FEATURE_KEY = {
	lat: "lat",
	lng: "lng",
	long: "long",
	latitude: "latitude",
	longitude: "longitude",
	location: "location",
	crs: "crs",
	uncertainty: "geb-uncertainty",
	certainty: "geb-certainty",
	from: "geb-from",
	to: "geb-to",
	calendar: "geb-calendar",
} as const;
