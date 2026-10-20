/**
 * The public API surface.
 *
 * NOTHING HERE MAY CONTAIN A `Fit`. The house rule is `structuredClone` on anything handed out,
 * and a `Fit` cannot be cloned: its `forward` and `reverse` are `Mapping` objects carrying an
 * `apply` FUNCTION, so the clone throws — and worse, cloning reads every own enumerable property,
 * which would invoke the memoised `diagnostics` getter and pay the cost that getter exists to
 * defer. So the surface projects: `FitInfo` carries the model, the points, the hull and the
 * diagnostics, all plain data, and the mapping stays inside the kernel where `toPixel` and
 * `toLatLng` use it.
 *
 * Every type here has a standalone twin in `types/geb.d.ts` for consumers with no access to the
 * source tree, and `test/types/conformance.ts` asserts the two are IDENTICAL rather than merely
 * assignable. A drift between them fails the typecheck, which fails the build.
 */
import type { Diagnostics } from "../core/residuals";
import type { ControlPoint, LatLng, TransformKind, TransformOptions } from "../core/types";
import type { Staleness } from "../persist/types";
import type { CoordinateSource, ProblemCode, RejectionCode } from "../query/types";
import type { GebErrorCode } from "./errors";

export const API_VERSION = 1 as const;

/** A coordinate reference system, as handed out. *(API 1)* */
export interface CrsInfo {
	readonly id: string;
	readonly name: string;
	/** Sphere radius, in `distanceUnit`. */
	readonly radius: number;
	readonly distanceUnit: string;
	readonly latRange: readonly [number, number];
	readonly lngRange: readonly [number, number];
	readonly projection: "equirectangular" | "mercator" | "unknown";
}

/** One georeferenced map, without its control points. *(API 1)* */
export interface GeorefSummary {
	readonly id: string;
	readonly notePath: string;
	readonly crs: string;
	readonly model: TransformKind;
	readonly pointCount: number;
	readonly lambda?: number;
}

/** What the map pictures, and whether the image still matches the one it was fitted on. *(API 1)* */
export interface ImageInfo {
	/** The stored link's target, or null when it resolves to nothing. */
	readonly path: string | null;
	readonly width: number;
	readonly height: number;
	readonly byteLength: number;
	readonly hash: string;
	/**
	 * `"unknown"` until reconciliation has actually checked this note — NEVER defaulted to
	 * `"same"`. Coverage trusts the stored identity and is synchronous; only reconciliation reads
	 * bytes. Reporting `"same"` for an unchecked image would be a confident answer nobody earned.
	 */
	readonly staleness: Staleness;
}

/** A fit, projected to plain data. *(API 1)* */
export interface FitInfo {
	readonly model: TransformKind;
	readonly pointCount: number;
	readonly lambda?: number;
	readonly points: readonly ControlPoint[];
	/** Convex hull of the control points, in world space. Inside it the fit interpolates. */
	readonly hull: readonly LatLng[];
	readonly diagnostics: Diagnostics;
}

/**
 * The result of fitting CALLER-SUPPLIED points, with no vault involved. *(API 1)*
 *
 * A discriminated result rather than a throw, because this is the interactive path: a view places
 * a control point, asks what the fit looks like now, and must not have to try/catch per
 * placement. Degenerate points are an ordinary state while a user is still placing them.
 */
export type FitPreview =
	| { readonly ok: true; readonly fit: FitInfo }
	| { readonly ok: false; readonly code: GebErrorCode; readonly message: string };

/** Where a coordinate lands on an image. *(API 1)* */
export interface PixelResult {
	readonly x: number;
	readonly y: number;
	readonly inBounds: boolean;
	/** Outside the control-point hull: resolved, but extrapolated and so fuzzy. */
	readonly extrapolated: boolean;
}

/** Where a pixel lands in the world. *(API 1)* */
export interface WorldResult {
	readonly lat: number;
	readonly lng: number;
	readonly extrapolated: boolean;
}

/** One map that covers a coordinate, with where on it the coordinate lands. *(API 1)* */
export interface CoverageInfo {
	readonly georefId: string;
	readonly notePath: string;
	readonly x: number;
	readonly y: number;
	readonly extrapolated: boolean;
}

/** A place note carrying coordinates. Dates stay RAW — a time adapter interprets them. *(API 1)* */
export interface FeatureInfo {
	readonly notePath: string;
	readonly lat: number;
	readonly lng: number;
	readonly crs: string;
	readonly uncertainty?: number;
	readonly certainty?: "exact" | "approximate" | "disputed";
	readonly from?: string;
	readonly to?: string;
	readonly calendar?: string;
	/** Which frontmatter form supplied the coordinates. Read when two forms disagree. */
	readonly source: CoordinateSource;
}

/** A feature placed on a map. *(API 1)* */
export interface PinInfo extends CoverageInfo {
	readonly feature: FeatureInfo;
}

/**
 * Something Geb noticed and did not act on. *(API 1)*
 *
 * On the surface because of a hole the architecture review found: `buildIndex` builds this list
 * with care and the specified API exposed no way to read it, so a user whose map was rejected had
 * no public means of learning why. A map vanishing in silence is the one thing this plugin forbids.
 */
export interface ProblemInfo {
	readonly notePath: string;
	readonly code: ProblemCode;
	readonly message: string;
}

/** A georeference that could not be used at all, and why. *(API 1)* */
export interface RejectedInfo {
	readonly notePath: string;
	readonly code: RejectionCode;
	readonly id?: string;
	readonly reason: string;
}

/** What `createGeoref` needs. Image identity is COMPUTED here, not supplied. *(API 1)* */
export interface CreateGeorefInput {
	readonly notePath: string;
	readonly id: string;
	/** Vault path of the image. Its bytes are read and hashed; its link text is derived. */
	readonly imagePath: string;
	/**
	 * Natural pixel size of the image. Supplied by the caller because this layer can read bytes
	 * but cannot DECODE an image — only a view with a DOM can measure one.
	 */
	readonly imageWidth: number;
	readonly imageHeight: number;
	readonly crs?: string;
	readonly model: TransformKind;
	readonly lambda?: number;
	readonly points: readonly ControlPoint[];
}

/** Every field of a georeference a caller may change. *(API 1)* */
export interface UpdateGeorefPatch {
	readonly crs?: string;
	readonly model?: TransformKind;
	readonly lambda?: number;
	readonly points?: readonly ControlPoint[];
}

export type GebEvent = "ready" | "unload";

/** Frozen on emission, including any array inside it. *(API 1)* */
export interface GebEventPayload {
	readonly type: GebEvent;
	readonly generation: number;
}

export interface GebAPI {
	/** The plugin's own version, from the manifest. *(API 1)* */
	readonly version: string;
	readonly apiVersion: typeof API_VERSION;
	/** False until Obsidian has indexed the vault, and false again after unload. *(API 1)* */
	readonly ready: boolean;
	/**
	 * A monotonic counter that moves whenever Geb's view of the world may have changed. *(API 1)*
	 *
	 * In this version only Geb's own writes move it, because nothing is cached and every query
	 * reads the vault fresh. It exists now so a consumer caching results has something to compare,
	 * and so the later indexed version has no new concept to introduce.
	 */
	readonly generation: number;

	listCrs(): readonly CrsInfo[];
	getCrs(id: string): CrsInfo | null;

	listGeorefs(): readonly GeorefSummary[];
	/**
	 * `null` for an id no note claims. A REJECTED georeference throws instead, carrying the
	 * reason — a map that failed to load must never read as a map that was never there. *(API 1)*
	 */
	getGeoref(id: string): GeorefSummary | null;
	/** Throws `geb-no-such-georef` for an unknown or rejected id. *(API 1)* */
	getImageInfo(id: string): ImageInfo;
	/** Throws `geb-no-such-georef` for an unknown or rejected id. *(API 1)* */
	getFit(id: string): FitInfo;

	/** Fit caller-supplied points with no vault involved. The interactive path. *(API 1)* */
	previewFit(points: readonly ControlPoint[], opts: TransformOptions): FitPreview;

	toPixel(georefId: string, lat: number, lng: number): PixelResult | null;
	toLatLng(georefId: string, x: number, y: number): WorldResult | null;

	georefsCovering(lat: number, lng: number, crs?: string): readonly CoverageInfo[];
	listFeatures(): readonly FeatureInfo[];
	/** `null` means no such LOADED map — distinct from a map with no pins. *(API 1)* */
	featuresIn(georefId: string): readonly PinInfo[] | null;

	listProblems(): readonly ProblemInfo[];
	listRejected(): readonly RejectedInfo[];

	/** Every write returns the record as PARSED BACK from what was written. *(API 1)* */
	createGeoref(input: CreateGeorefInput): Promise<GeorefSummary>;
	updateGeoref(georefId: string, patch: UpdateGeorefPatch): Promise<GeorefSummary>;
	/** Sends the note to the user's trash, recoverably. *(API 1)* */
	deleteGeoref(georefId: string): Promise<void>;
	addPoint(georefId: string, point: ControlPoint): Promise<GeorefSummary>;
	updatePoint(georefId: string, index: number, point: ControlPoint): Promise<GeorefSummary>;
	removePoint(georefId: string, index: number): Promise<GeorefSummary>;

	/** Returns an unsubscribe function that runs at most once. *(API 1)* */
	on(event: GebEvent, cb: (payload: GebEventPayload) => void): () => void;
}
