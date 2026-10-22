/**
 * Geb's public types, as a STANDALONE file.
 *
 * Dependency-free on purpose: a consumer plugin can copy this one file and type its integration
 * without any access to Geb's source tree. Everything Geb borrows from its own kernel — control
 * points, diagnostics, coordinate systems — is inlined here rather than imported.
 *
 * That inlining is the risk, and `test/types/conformance.ts` is the answer to it: it asserts each
 * type here is IDENTICAL to its twin in src/api, not merely assignable, and a drift fails the
 * typecheck and so fails the build. The runtime half is `API_KEYS`, compared against
 * `Object.keys()` of a real api object — because a type can be right while the object is missing
 * a method.
 *
 * Every member is tagged with the API version that introduced it.
 */

export const API_VERSION = 1;

/** *(API 1)* */
export type TransformKind = "affine" | "polynomial2" | "tps";

/** *(API 1)* */
export interface TransformOptions {
	readonly kind: TransformKind;
	/** Thin-plate spline smoothing. 0 interpolates exactly; larger values approximate. *(API 1)* */
	readonly lambda?: number;
}

/** A user-placed correspondence: this pixel of the image is that place in the world. *(API 1)* */
export interface ControlPoint {
	readonly px: number;
	readonly py: number;
	readonly lat: number;
	readonly lng: number;
	readonly label?: string;
}

/** *(API 1)* */
export interface LatLng {
	readonly lat: number;
	readonly lng: number;
}

/** One control point's error under a fit. *(API 1)* */
export interface PointResidual {
	readonly index: number;
	readonly label?: string;
	/** Error in pixels. */
	readonly error: number;
	/** On the convex hull, so a leave-one-out error here is extrapolated. */
	readonly onHull: boolean;
}

/** How much to trust a fit. *(API 1)* */
export interface Diagnostics {
	/** Always present. The trust display. */
	readonly affine: readonly PointResidual[];
	readonly affineRms: number;
	/** Present only for a thin-plate spline over four or more points. */
	readonly loo?: readonly PointResidual[];
	/** RMS over INTERIOR points only; absent when every point is on the hull. */
	readonly looRms?: number;
	readonly notes: readonly string[];
}

/** Whether a stored image identity still matches the file. *(API 1)* */
export type Staleness = "same" | "changed" | "unknown";

/** Which frontmatter form supplied a place note's coordinates. *(API 1)* */
export type CoordinateSource = "lat-lng" | "latitude-longitude" | "location";

/** *(API 1)* */
export type ProblemCode =
	| "coords-out-of-range"
	| "coords-incomplete"
	| "coords-ambiguous"
	| "coords-conflict"
	| "unknown-crs"
	| "bad-uncertainty"
	| "bad-certainty"
	| "bad-text"
	| "bad-date"
	| "duplicate-id"
	| "lossy-record"
	| "extra-fits"
	| "record-problem";

/** *(API 1)* */
export type RejectionCode = "unparsable" | "unknown-image-size" | "no-fits" | "degenerate-fit" | "duplicate-id";

/** *(API 1)* */
export type GebErrorCode =
	| "geb-unloaded"
	| "geb-not-ready"
	| "geb-no-such-georef"
	| "geb-no-such-point"
	| "geb-no-such-image"
	| "geb-degenerate-fit"
	| "geb-too-few-points"
	| "geb-unknown-crs"
	| "geb-duplicate-id"
	| "geb-note-exists"
	| "geb-lossy-record"
	| "geb-bad-argument"
	| "geb-unknown-calendar"
	| "geb-bad-adapter";

/** How date text becomes a day on the shared line (day 0 = 1970-01-01, whole days), and back. *(API 1)* */
export interface TimeAdapter {
	readonly id: string;
	readonly name: string;
	/** The FIRST day the text names, or null. */
	parse(text: string): number | null;
	/** The LAST day the text names, for text naming a span (a year). Optional; used for `geb-to`. */
	last?(text: string): number | null;
	format(day: number): string;
}

/** *(API 1)* */
export interface TimeAdapterInfo {
	readonly id: string;
	readonly name: string;
}

/** *(API 1)* */
export interface FeaturesInOptions {
	readonly at?: number;
}

/** *(API 1)* */
export interface CrsInfo {
	readonly id: string;
	readonly name: string;
	readonly radius: number;
	readonly distanceUnit: string;
	readonly latRange: readonly [number, number];
	readonly lngRange: readonly [number, number];
	readonly projection: "equirectangular" | "mercator" | "unknown";
}

/** *(API 1)* */
export interface GeorefSummary {
	readonly id: string;
	readonly notePath: string;
	readonly crs: string;
	readonly model: TransformKind;
	readonly pointCount: number;
	readonly lambda?: number;
}

/** *(API 1)* */
export interface ImageInfo {
	readonly path: string | null;
	readonly width: number;
	readonly height: number;
	readonly byteLength: number;
	readonly hash: string;
	/** `"unknown"` until reconciliation has checked this note. Never defaulted to `"same"`. */
	readonly staleness: Staleness;
}

/** *(API 1)* */
export interface FitInfo {
	readonly model: TransformKind;
	readonly pointCount: number;
	readonly lambda?: number;
	readonly points: readonly ControlPoint[];
	readonly hull: readonly LatLng[];
	readonly diagnostics: Diagnostics;
}

/** *(API 1)* */
export type FitPreview =
	| { readonly ok: true; readonly fit: FitInfo }
	| { readonly ok: false; readonly code: GebErrorCode; readonly message: string };

/** *(API 1)* */
export interface PixelResult {
	readonly x: number;
	readonly y: number;
	readonly inBounds: boolean;
	readonly extrapolated: boolean;
}

/** *(API 1)* */
export interface WorldResult {
	readonly lat: number;
	readonly lng: number;
	readonly extrapolated: boolean;
}

/** *(API 1)* */
export interface CoverageInfo {
	readonly georefId: string;
	readonly notePath: string;
	readonly x: number;
	readonly y: number;
	readonly extrapolated: boolean;
}

/** Dates stay RAW — a time adapter interprets them. *(API 1)* */
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
	readonly source: CoordinateSource;
}

/** *(API 1)* */
export interface PinInfo extends CoverageInfo {
	readonly feature: FeatureInfo;
}

/** *(API 1)* */
export interface ProblemInfo {
	readonly notePath: string;
	readonly code: ProblemCode;
	readonly message: string;
}

/** *(API 1)* */
export interface RejectedInfo {
	readonly notePath: string;
	readonly code: RejectionCode;
	readonly id?: string;
	readonly reason: string;
}

/** *(API 1)* */
export interface CreateGeorefInput {
	readonly notePath: string;
	readonly id: string;
	readonly imagePath: string;
	readonly imageWidth: number;
	readonly imageHeight: number;
	readonly crs?: string;
	readonly model: TransformKind;
	readonly lambda?: number;
	readonly points: readonly ControlPoint[];
}

/** *(API 1)* */
export interface UpdateGeorefPatch {
	readonly crs?: string;
	readonly model?: TransformKind;
	readonly lambda?: number;
	readonly points?: readonly ControlPoint[];
}

/** *(API 1)* */
export type GebEvent = "ready" | "unload" | "georefs-changed" | "fit-changed" | "features-changed";

/**
 * Frozen on emission, including the array inside it. *(API 1)*
 *
 * `paths` carries the note paths that actually moved, so a consumer can re-read ONE map rather
 * than re-enumerating the vault. Empty for `ready` and `unload`, and empty for a change whose
 * originating signal did not say where.
 */
export interface GebEventPayload {
	readonly type: GebEvent;
	readonly generation: number;
	readonly paths: readonly string[];
}

export interface GebAPI {
	readonly version: string;
	readonly apiVersion: 1;
	readonly ready: boolean;
	readonly generation: number;
	/** The fewest control points each model can be fitted from at all. *(API 1)* */
	readonly minPoints: Readonly<Record<TransformKind, number>>;
	/** The count below which a model is fittable but its residuals carry no information. *(API 1)* */
	readonly recommendedPoints: Readonly<Record<TransformKind, number>>;

	listCrs(): readonly CrsInfo[];
	getCrs(id: string): CrsInfo | null;

	listGeorefs(): readonly GeorefSummary[];
	getGeoref(id: string): GeorefSummary | null;
	getImageInfo(id: string): ImageInfo;
	getFit(id: string): FitInfo;

	previewFit(points: readonly ControlPoint[], opts: TransformOptions): FitPreview;

	toPixel(georefId: string, lat: number, lng: number): PixelResult | null;
	toLatLng(georefId: string, x: number, y: number): WorldResult | null;

	georefsCovering(lat: number, lng: number, crs?: string): readonly CoverageInfo[];
	listFeatures(): readonly FeatureInfo[];
	featuresIn(georefId: string, opts?: FeaturesInOptions): readonly PinInfo[] | null;

	listProblems(): readonly ProblemInfo[];
	listRejected(): readonly RejectedInfo[];

	registerTimeAdapter(adapter: TimeAdapter): () => void;
	listTimeAdapters(): readonly TimeAdapterInfo[];
	toDay(text: string, calendar?: string): number | null;
	fromDay(day: number, calendar?: string): string;

	createGeoref(input: CreateGeorefInput): Promise<GeorefSummary>;
	updateGeoref(georefId: string, patch: UpdateGeorefPatch): Promise<GeorefSummary>;
	deleteGeoref(georefId: string): Promise<void>;
	addPoint(georefId: string, point: ControlPoint): Promise<GeorefSummary>;
	updatePoint(georefId: string, index: number, point: ControlPoint): Promise<GeorefSummary>;
	removePoint(georefId: string, index: number): Promise<GeorefSummary>;

	on(event: GebEvent, cb: (payload: GebEventPayload) => void): () => void;
}
