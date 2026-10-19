/**
 * Persistence layer: georeference records in note frontmatter, image identity, rename handling.
 *
 * Like the kernel, this imports nothing from Obsidian — an eslint fence keeps it that way. The
 * vault lives behind `VaultPort`, implemented once against the real app in src/plugin and faked
 * in the tests, so rename behaviour is testable without launching anything.
 */
export { compareIdentity, hashBytes, identify } from "./identity";
export { formatLink, linkMatchesPath, linkTarget, parseLink, retarget, type ParsedLink } from "./links";
export { reconcile, type ReconcileOutcome } from "./reconcile";
export { handleRename, type RenameOutcome } from "./rename";
export { fromFrontmatter, looksLikeGeoref, toFrontmatter } from "./serialize";
export {
	KEY,
	type Georeference,
	type ImageIdentity,
	type ParseResult,
	type Staleness,
	type StoredFit,
	type StoredPoint,
	type VaultPort,
} from "./types";
