/**
 * Kernel error hierarchy.
 *
 * Everything a bad fit can throw descends from `FitError`, so a caller wraps `buildFit` in one
 * catch and gets a useful message. Previously `SingularMatrixError` escaped from the solver
 * untouched, so a user who clicked three points along a coastline got "singular at column 8" —
 * true, and no help whatsoever.
 */
export class FitError extends Error {
	constructor(
		message: string,
		options?: { readonly cause?: unknown },
	) {
		super(message, options);
		this.name = "FitError";
	}
}

/** The system has no unique solution: collinear or coincident control points, usually. */
export class SingularMatrixError extends FitError {
	constructor(message: string) {
		super(message);
		this.name = "SingularMatrixError";
	}
}

/** A control point or option value that cannot produce a meaningful fit. */
export class InvalidInputError extends FitError {
	constructor(message: string) {
		super(message);
		this.name = "InvalidInputError";
	}
}
