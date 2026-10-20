/**
 * The coverage layer's public surface: which maps cover a coordinate, which notes land on a map.
 *
 * Fenced against Obsidian imports like the kernel and the persistence layer, so the whole thing
 * is driven by a fake in the tests.
 */
// `georefsForFeature` is deliberately absent. It had no consumer, was one line over
// `georefsCovering`, and paired with `buildIndex` it read as an invitation to rebuild the index
// once per note — the single call pattern the cost measurements say collapses.
export { featuresIn, georefsCovering } from "./coverage";
export { readFeature } from "./features";
export { buildIndex } from "./store";
export {
	FEATURE_KEY,
	type CoordinateSource,
	type Coverage,
	type Feature,
	type LoadedGeoref,
	type Pin,
	type Problem,
	type ProblemCode,
	type RejectedGeoref,
	type RejectionCode,
	type WorldIndex,
} from "./types";
