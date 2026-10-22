/**
 * `types/geb.d.ts` conformance, checked by `tsc --noEmit` and therefore by `bun run build`.
 *
 * The standalone type file is dependency-free so a consumer can copy it, which means every type
 * it borrows from Geb's kernel is DUPLICATED there. Duplication drifts. This file makes drift a
 * build failure instead of a support question: each pair is asserted IDENTICAL, not merely
 * assignable, so widening a field on one side and not the other fails here.
 *
 * `API_KEYS` is the runtime half. A type can be perfectly correct while the real object is
 * missing a method or has grown an undocumented one, so `test/api.test.ts` compares this list
 * against `Object.keys()` of a live api object. Both halves are needed; neither is sufficient.
 *
 * There is nothing to run — this file exists to be type-checked.
 */
import type * as D from "../../types/geb.d.ts";
import type * as A from "../../src/api/types";
import type { GebErrorCode } from "../../src/api/errors";
import type { Diagnostics, PointResidual } from "../../src/core/residuals";
import type { ControlPoint, LatLng, TransformKind, TransformOptions } from "../../src/core/types";
import type { Staleness } from "../../src/persist/types";
import type { CoordinateSource, ProblemCode, RejectionCode } from "../../src/query/types";

/**
 * Strict type IDENTITY, not assignability.
 *
 * The two-conditional-function trick is the standard way to get it: assignability would let a
 * public type quietly gain a field, or lose a `readonly`, and still pass.
 */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export type Expect<T extends true> = T;

/**
 * Every shared type, asserted in both directions by construction.
 *
 * A tuple rather than separate aliases so that adding a public type without adding its assertion
 * is visible: the list is the checklist.
 */
export type Conformance = [
	// The kernel types the public surface re-publishes.
	Expect<Equal<D.TransformKind, TransformKind>>,
	Expect<Equal<D.TransformOptions, TransformOptions>>,
	Expect<Equal<D.ControlPoint, ControlPoint>>,
	Expect<Equal<D.LatLng, LatLng>>,
	Expect<Equal<D.PointResidual, PointResidual>>,
	Expect<Equal<D.Diagnostics, Diagnostics>>,
	Expect<Equal<D.Staleness, Staleness>>,
	Expect<Equal<D.CoordinateSource, CoordinateSource>>,
	Expect<Equal<D.ProblemCode, ProblemCode>>,
	Expect<Equal<D.RejectionCode, RejectionCode>>,
	Expect<Equal<D.GebErrorCode, GebErrorCode>>,

	// The API's own types.
	Expect<Equal<D.CrsInfo, A.CrsInfo>>,
	Expect<Equal<D.GeorefSummary, A.GeorefSummary>>,
	Expect<Equal<D.ImageInfo, A.ImageInfo>>,
	Expect<Equal<D.FitInfo, A.FitInfo>>,
	Expect<Equal<D.FitPreview, A.FitPreview>>,
	Expect<Equal<D.PixelResult, A.PixelResult>>,
	Expect<Equal<D.WorldResult, A.WorldResult>>,
	Expect<Equal<D.CoverageInfo, A.CoverageInfo>>,
	Expect<Equal<D.FeatureInfo, A.FeatureInfo>>,
	Expect<Equal<D.PinInfo, A.PinInfo>>,
	Expect<Equal<D.ProblemInfo, A.ProblemInfo>>,
	Expect<Equal<D.RejectedInfo, A.RejectedInfo>>,
	Expect<Equal<D.CreateGeorefInput, A.CreateGeorefInput>>,
	Expect<Equal<D.UpdateGeorefPatch, A.UpdateGeorefPatch>>,
	Expect<Equal<D.GebEvent, A.GebEvent>>,
	Expect<Equal<D.GebEventPayload, A.GebEventPayload>>,
	Expect<Equal<D.TimeAdapter, A.TimeAdapter>>,
	Expect<Equal<D.TimeAdapterInfo, A.TimeAdapterInfo>>,
	Expect<Equal<D.FeaturesInOptions, A.FeaturesInOptions>>,

	// And the surface itself, which subsumes every signature above.
	Expect<Equal<D.GebAPI, A.GebAPI>>,
];

/**
 * The runtime half: every key the api object must have, and no others.
 *
 * `satisfies ReadonlyArray<keyof D.GebAPI>` ties it to the declared surface, so a key here that
 * does not exist on the type is a typecheck failure — and `test/api.test.ts` asserts the reverse,
 * that the live object's keys are exactly this set.
 */
export const API_KEYS = [
	"version",
	"apiVersion",
	"ready",
	"generation",
	"minPoints",
	"recommendedPoints",
	"listCrs",
	"getCrs",
	"listGeorefs",
	"getGeoref",
	"getImageInfo",
	"getFit",
	"previewFit",
	"toPixel",
	"toLatLng",
	"georefsCovering",
	"listFeatures",
	"featuresIn",
	"listProblems",
	"listRejected",
	"registerTimeAdapter",
	"listTimeAdapters",
	"toDay",
	"fromDay",
	"createGeoref",
	"updateGeoref",
	"deleteGeoref",
	"addPoint",
	"updatePoint",
	"removePoint",
	"on",
] as const satisfies ReadonlyArray<keyof D.GebAPI>;
