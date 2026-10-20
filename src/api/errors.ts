/**
 * Coded errors for the public API.
 *
 * A CODE, not just prose, for the same reason the coverage layer's problems carry one: a consumer
 * has to branch on what went wrong, and branching on a message means the message can never be
 * reworded. The shape is inherited from Wadjet wholesale — `Object.assign(new Error(msg), { code })`
 * — so a consumer that already handles one plugin's errors handles Geb's the same way.
 */

export type CodedError = Error & { code: GebErrorCode };

/**
 * Every code the API can throw. A closed union on purpose: a consumer can exhaustively switch on
 * it, and adding one is then a visible type change rather than a surprise at runtime.
 */
export type GebErrorCode =
	/** The plugin has been unloaded. Every method throws this; consumers re-acquire on `geb:ready`. */
	| "geb-unloaded"
	/**
	 * Obsidian has not finished indexing, so the vault cannot be read yet.
	 *
	 * THROWN RATHER THAN ANSWERED WITH AN EMPTY LIST. Before the metadata cache resolves,
	 * `buildIndex` reads a partial cache and returns a vault with no georeferences and no
	 * problems — indistinguishable from an empty vault, which is the "still indexing" trap the
	 * reconciliation layer already had to handle once. An empty answer here would be a confident
	 * lie, so the query refuses instead.
	 */
	| "geb-not-ready"
	| "geb-no-such-georef"
	| "geb-no-such-point"
	/** The image link does not resolve, so its bytes cannot be read. */
	| "geb-no-such-image"
	/** Control points that cannot be fitted — collinear, or coincident. */
	| "geb-degenerate-fit"
	/** Fewer points than the model needs at all. */
	| "geb-too-few-points"
	| "geb-unknown-crs"
	/** Another note already claims this id. */
	| "geb-duplicate-id"
	/** The note path is already taken. A create must never overwrite. */
	| "geb-note-exists"
	/**
	 * The record on disk loaded with data DROPPED rather than defaulted, so writing it back would
	 * delete exactly what the user needs in order to fix it. Reads are tolerant; writes are not.
	 */
	| "geb-lossy-record"
	/** The arguments are the wrong shape — a non-finite coordinate, a negative index. */
	| "geb-bad-argument";

export function codedError(code: GebErrorCode, message: string): CodedError {
	return Object.assign(new Error(message), { code });
}

/** Narrowing helper for consumers and for tests, so neither has to duck-type the `code`. */
export function isCodedError(e: unknown): e is CodedError {
	return e instanceof Error && typeof (e as { code?: unknown }).code === "string";
}
