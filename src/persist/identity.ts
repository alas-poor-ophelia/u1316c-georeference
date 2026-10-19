/**
 * Image identity: enough to notice that the image is not the one the control points were placed
 * on, which is otherwise a silent-wrong failure.
 *
 * WHY NOT A CRYPTOGRAPHIC HASH. `crypto.subtle` is the obvious reach, and it is the wrong one
 * here: it is async, and it requires a secure context, which an Obsidian desktop vault loaded
 * over `file://` is not guaranteed to be. The job is change detection, not tamper resistance —
 * nobody is adversarially forging a map scan to collide with its own hash. A synchronous
 * non-cryptographic hash paired with the byte length is ample and works everywhere, mobile
 * included.
 */
import type { ImageIdentity, Staleness } from "./types";

/** FNV-1a over one seed. Two passes with different offset bases give 64 bits of signal. */
function fnv1a(bytes: Uint8Array, offsetBasis: number): number {
	let h = offsetBasis;
	for (let i = 0; i < bytes.length; i++) {
		h ^= bytes[i]!;
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

const hex8 = (n: number): string => n.toString(16).padStart(8, "0");

/**
 * A 64-bit change-detection digest, as 16 hex characters prefixed with the algorithm so a future
 * change of hash is distinguishable from a changed image rather than looking like one.
 */
export function hashBytes(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	return `fnv1a64:${hex8(fnv1a(bytes, 0x811c9dc5))}${hex8(fnv1a(bytes, 0x01000193))}`;
}

export function identify(buffer: ArrayBuffer, width: number, height: number): ImageIdentity {
	return { width, height, byteLength: buffer.byteLength, hash: hashBytes(buffer) };
}

/**
 * Compare a stored identity against the image as it is now.
 *
 * `unknown` rather than `same` when the record predates identity tracking or is incomplete: a
 * missing hash is not evidence of sameness, and treating it as such is how a staleness check
 * quietly stops checking.
 */
export function compareIdentity(
	stored: Partial<ImageIdentity> | null,
	current: Partial<ImageIdentity>,
): Staleness {
	if (stored === null) return "unknown";
	const haveStored = typeof stored.byteLength === "number" && stored.byteLength > 0 && typeof stored.hash === "string" && stored.hash !== "";
	const haveCurrent = typeof current.byteLength === "number" && typeof current.hash === "string";
	if (!haveStored || !haveCurrent) return "unknown";

	// Byte length first: it is free, and a resize or re-save almost always moves it.
	if (stored.byteLength !== current.byteLength) return "changed";
	if (stored.hash !== current.hash) return "changed";

	// Dimensions are compared only when BOTH sides have them. The persistence layer can read bytes
	// but cannot decode an image, so it passes none; the plugin layer, which has a loaded image,
	// passes both. Comparing a present value against an absent one would report every record as
	// changed, which is how a staleness check turns into noise and then gets ignored.
	const bothSized =
		typeof stored.width === "number" && stored.width > 0 && typeof current.width === "number" &&
		typeof stored.height === "number" && stored.height > 0 && typeof current.height === "number";
	if (bothSized && (stored.width !== current.width || stored.height !== current.height)) return "changed";

	return "same";
}
