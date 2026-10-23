/**
 * The transform models, as pure 2D-to-2D fitters.
 *
 * The three plane models do not know which side is the world and which is the image: a fitter
 * takes interleaved source pairs and interleaved destination pairs and returns a mapping between
 * them. That is what makes the reverse fit free — fit.ts simply calls the same fitter with the
 * arguments swapped. The one exception is a projected model (`mercator`), which must project the
 * world side and nothing else, so `fitMapping` takes a `direction` naming which argument that is;
 * the [lat, lng] order it relies on is the kernel-wide convention in types.ts.
 *
 * CONDITIONING. Raw inputs are badly scaled for a least-squares fit: longitude runs to 180 while
 * pixels run to several thousand, and an order-2 polynomial squares both. Every fitter normalises
 * each side to zero centroid and an RMS radius of sqrt(2) first (Hartley normalisation), fits in
 * that space, and undoes it on apply. Without this an order-2 fit over a continent-sized map
 * loses most of its significant digits in the normal equations.
 */
import { FitError, InvalidInputError, SingularMatrixError } from "./errors";
import { leastSquares, solve } from "./linalg";
import { MERCATOR, type Projection } from "./projection";
import { MIN_POINTS, type Mapping, type TransformKind, type TransformOptions } from "./types";

export { FitError } from "./errors";

interface Norm {
	readonly cx: number;
	readonly cy: number;
	readonly scale: number;
}

function normalisation(pts: Float64Array): Norm {
	const n = pts.length / 2;
	let cx = 0;
	let cy = 0;
	for (let i = 0; i < n; i++) {
		cx += pts[2 * i]!;
		cy += pts[2 * i + 1]!;
	}
	cx /= n;
	cy /= n;
	let acc = 0;
	for (let i = 0; i < n; i++) {
		const dx = pts[2 * i]! - cx;
		const dy = pts[2 * i + 1]! - cy;
		acc += dx * dx + dy * dy;
	}
	const rms = Math.sqrt(acc / n);
	// All points coincident: fall back to unit scale rather than dividing by zero.
	const scale = rms > 0 ? Math.SQRT2 / rms : 1;
	return { cx, cy, scale };
}

const fwd = (n: Norm, x: number, y: number): [number, number] => [(x - n.cx) * n.scale, (y - n.cy) * n.scale];
const inv = (n: Norm, x: number, y: number): [number, number] => [x / n.scale + n.cx, y / n.scale + n.cy];

function checkInputs(src: Float64Array, dst: Float64Array, kind: TransformKind): number {
	if (src.length !== dst.length) throw new FitError("source and destination lengths differ");
	if (src.length % 2 !== 0) throw new FitError("coordinate arrays must hold interleaved pairs");
	const n = src.length / 2;
	const need = MIN_POINTS[kind];
	if (n < need) throw new FitError(`${kind} needs at least ${need} control points, got ${n}`);
	// A non-finite coordinate does not merely give a wrong answer, it corrupts the sort comparator
	// in the hull routine: an eight-point set with one NaN produced an ELEVEN-vertex hull.
	for (let i = 0; i < src.length; i++) {
		if (!Number.isFinite(src[i]!)) throw new InvalidInputError(`source coordinate ${i} is not finite`);
		if (!Number.isFinite(dst[i]!)) throw new InvalidInputError(`destination coordinate ${i} is not finite`);
	}
	return n;
}

/** Shared apply loop: normalise in, evaluate, denormalise out. */
function makeApply(
	srcN: Norm,
	dstN: Norm,
	evaluate: (nx: number, ny: number) => [number, number],
): (src: Float64Array, dst: Float64Array) => void {
	return (src, dst) => {
		if (dst.length < src.length) throw new FitError("destination buffer is too small");
		const n = src.length / 2;
		for (let i = 0; i < n; i++) {
			const [nx, ny] = fwd(srcN, src[2 * i]!, src[2 * i + 1]!);
			const [ex, ey] = evaluate(nx, ny);
			const [ox, oy] = inv(dstN, ex, ey);
			dst[2 * i] = ox;
			dst[2 * i + 1] = oy;
		}
	};
}

// ---------------------------------------------------------------------------------------------
// Affine and order-2 polynomial. Both are least-squares fits over a design matrix, so they share
// everything but the basis.
// ---------------------------------------------------------------------------------------------

const AFFINE_BASIS = (x: number, y: number): number[] => [1, x, y];
const POLY2_BASIS = (x: number, y: number): number[] => [1, x, y, x * x, x * y, y * y];

function fitPolynomial(src: Float64Array, dst: Float64Array, kind: "affine" | "polynomial2"): Mapping {
	const n = checkInputs(src, dst, kind);
	const basis = kind === "affine" ? AFFINE_BASIS : POLY2_BASIS;
	const srcN = normalisation(src);
	const dstN = normalisation(dst);

	const design: number[][] = [];
	const rhs: number[][] = [];
	for (let i = 0; i < n; i++) {
		const [nx, ny] = fwd(srcN, src[2 * i]!, src[2 * i + 1]!);
		const [dx, dy] = fwd(dstN, dst[2 * i]!, dst[2 * i + 1]!);
		design.push(basis(nx, ny));
		rhs.push([dx, dy]);
	}

	// A singular system here is a correct refusal, not a bug: an order-2 polynomial genuinely
	// cannot determine its cross-terms across a direction the control points do not span, and
	// answering anyway is the "confident finite garbage" this kernel exists to avoid. But the
	// solver can only speak about matrices, and measured, `polynomial2` refuses a 1 px perpendicular
	// jitter over a 1000 px line for every seed tried — a configuration a user would describe as
	// "nine places along the coast", not as degenerate. So the refusal keeps its reason and gains a
	// route forward, because an error a user cannot act on gets read as the tool being broken.
	let coeffs: number[][];
	try {
		coeffs = leastSquares(design, rhs);
	} catch (e) {
		if (e instanceof SingularMatrixError && kind === "polynomial2") {
			throw new SingularMatrixError(
				`${e.message} An order-2 polynomial is the most demanding model here: it needs control points spread across two dimensions, not strung along a line. An affine fit over the same points will usually succeed.`,
			);
		}
		throw e;
	}

	const evaluate = (nx: number, ny: number): [number, number] => {
		const b = basis(nx, ny);
		let ex = 0;
		let ey = 0;
		for (let k = 0; k < b.length; k++) {
			ex += coeffs[k]![0]! * b[k]!;
			ey += coeffs[k]![1]! * b[k]!;
		}
		return [ex, ey];
	};

	return { kind, pointCount: n, apply: makeApply(srcN, dstN, evaluate) };
}

// ---------------------------------------------------------------------------------------------
// Thin-plate spline.
// ---------------------------------------------------------------------------------------------

/** The thin-plate radial basis, U(r) = r^2 ln r, taken on r^2 to avoid a square root. */
function tpsKernel(r2: number): number {
	return r2 <= 0 ? 0 : 0.5 * r2 * Math.log(r2);
}

/**
 * A fitted thin-plate spline. Carries the inverse of its own system matrix because the honest
 * residual diagnostic needs it: at lambda = 0 a spline interpolates exactly, so ordinary
 * residuals are identically zero and leave-one-out is the only thing that says anything. Rippa's
 * formula reads leave-one-out errors straight off this inverse rather than refitting N times.
 */
export class TpsMapping implements Mapping {
	readonly kind = "tps" as const;

	constructor(
		readonly pointCount: number,
		/** Normalised control-point coordinates on the source side, interleaved. */
		readonly nodes: Float64Array,
		/** Spline weights then the affine tail, per output axis: [w_0..w_{n-1}, a0, a1, a2]. */
		readonly coeffs: readonly (readonly number[])[],
		/**
		 * Normalised destination values the fit was built from, per control point. Kept because
		 * the leave-one-out oracle must re-solve the SAME problem with one row removed, and at
		 * lambda > 0 these cannot be recovered by evaluating the fit (it no longer interpolates).
		 */
		readonly targets: readonly (readonly number[])[],
		/** Inverse of the (n+3) x (n+3) system matrix. Rippa's formula needs its diagonal. */
		readonly systemInverse: readonly (readonly number[])[],
		readonly lambda: number,
		private readonly srcN: Norm,
		private readonly dstN: Norm,
		private readonly applyFn: (src: Float64Array, dst: Float64Array) => void,
	) {}

	apply(src: Float64Array, dst: Float64Array): void {
		this.applyFn(src, dst);
	}

	/** Normalise a raw source pair into the space `nodes` and `coeffs` live in. */
	toNormalised(x: number, y: number): [number, number] {
		return fwd(this.srcN, x, y);
	}

	/** Undo the destination-side normalisation. */
	fromNormalisedDst(x: number, y: number): [number, number] {
		return inv(this.dstN, x, y);
	}

	/**
	 * Destination-side scale factor. A DIFFERENCE between two destination values converts back to
	 * real units by dividing by this — the translation cancels, so `fromNormalisedDst` would be
	 * wrong for an error magnitude.
	 */
	get dstScale(): number {
		return this.dstN.scale;
	}
}

/**
 * Scale the smoothing term so a given `lambda` means roughly the same thing whatever the control
 * point count. Measured: the diagonal set to `lambda` alone gave a 13.9x spread in mean
 * control-point residual across n = 8 to 128, because the kernel rows it competes with sum over n
 * terms. Dividing by n brings that to 3.3x, and the remainder is non-monotonic across n, so most
 * of what is left is fixture sampling rather than a systematic trend.
 *
 * NOT fully portable even so, and the frontmatter stores it as if it were. The forward and
 * reverse fits apply the same lambda in their own normalised destination spaces, so at lambda = 1
 * the round trip at control points drifts by up to 1.6 pixels where lambda = 0 gives exactly 0.
 * That eats validity tolerance. lambda defaults to 0 and nothing in v1 exposes it; before it
 * reaches a UI it needs either a shared scale across the two directions or a documented ceiling.
 */
function smoothingDiagonal(lambda: number, n: number): number {
	return lambda / n;
}

function fitTps(src: Float64Array, dst: Float64Array, lambda: number): TpsMapping {
	if (!Number.isFinite(lambda) || lambda < 0) {
		throw new InvalidInputError(`lambda must be a finite number >= 0, got ${lambda}`);
	}
	const n = checkInputs(src, dst, "tps");
	const srcN = normalisation(src);
	const dstN = normalisation(dst);

	const nodes = new Float64Array(n * 2);
	const target: number[][] = [];
	for (let i = 0; i < n; i++) {
		const [nx, ny] = fwd(srcN, src[2 * i]!, src[2 * i + 1]!);
		nodes[2 * i] = nx;
		nodes[2 * i + 1] = ny;
		const [dx, dy] = fwd(dstN, dst[2 * i]!, dst[2 * i + 1]!);
		target.push([dx, dy]);
	}

	// [ K  P ] [ w ]   [ v ]
	// [ Pᵀ 0 ] [ a ] = [ 0 ]
	const size = n + 3;
	const diag = smoothingDiagonal(lambda, n);
	const A: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < n; j++) {
			if (i === j) {
				A[i]![j] = diag;
				continue;
			}
			const dx = nodes[2 * i]! - nodes[2 * j]!;
			const dy = nodes[2 * i + 1]! - nodes[2 * j + 1]!;
			A[i]![j] = tpsKernel(dx * dx + dy * dy);
		}
		A[i]![n] = 1;
		A[i]![n + 1] = nodes[2 * i]!;
		A[i]![n + 2] = nodes[2 * i + 1]!;
		A[n]![i] = 1;
		A[n + 1]![i] = nodes[2 * i]!;
		A[n + 2]![i] = nodes[2 * i + 1]!;
	}

	const B: number[][] = Array.from({ length: size }, () => [0, 0]);
	for (let i = 0; i < n; i++) B[i] = [target[i]![0]!, target[i]![1]!];

	// One inversion serves both the solve and Rippa's formula, so there is no second factorisation.
	const identity: number[][] = Array.from({ length: size }, (_, i) =>
		Array.from({ length: size }, (_, j) => (i === j ? 1 : 0)),
	);
	const Ainv = solve(A, identity);

	const coeffs: number[][] = Array.from({ length: size }, () => [0, 0]);
	for (let r = 0; r < size; r++) {
		let sx = 0;
		let sy = 0;
		for (let c = 0; c < size; c++) {
			sx += Ainv[r]![c]! * B[c]![0]!;
			sy += Ainv[r]![c]! * B[c]![1]!;
		}
		coeffs[r] = [sx, sy];
	}

	const evaluate = (nx: number, ny: number): [number, number] => {
		let ex = coeffs[n]![0]! + coeffs[n + 1]![0]! * nx + coeffs[n + 2]![0]! * ny;
		let ey = coeffs[n]![1]! + coeffs[n + 1]![1]! * nx + coeffs[n + 2]![1]! * ny;
		for (let i = 0; i < n; i++) {
			const dx = nx - nodes[2 * i]!;
			const dy = ny - nodes[2 * i + 1]!;
			const u = tpsKernel(dx * dx + dy * dy);
			ex += coeffs[i]![0]! * u;
			ey += coeffs[i]![1]! * u;
		}
		return [ex, ey];
	};

	return new TpsMapping(n, nodes, coeffs, target, Ainv, lambda, srcN, dstN, makeApply(srcN, dstN, evaluate));
}

// ---------------------------------------------------------------------------------------------
// Affine in a projected plane.
// ---------------------------------------------------------------------------------------------

/**
 * An affine fit between projected world coordinates and pixels, wrapped so callers still speak
 * raw [lat, lng]. This is the ONE place in this file that has to know which side is the world,
 * because a projection only applies to it; `direction` says which argument that is.
 *
 * `checkInputs` runs on the RAW arrays first, so a non-finite coordinate is reported as the
 * caller's input rather than as a projected value the caller never saw.
 */
function fitProjected(
	src: Float64Array,
	dst: Float64Array,
	kind: "mercator",
	projection: Projection,
	direction: "forward" | "reverse" | undefined,
): Mapping {
	// No default: a silent "forward" on a reverse fit would project the pixel side and produce a
	// plausible-looking wrong map, so a caller must say which argument is the world.
	if (direction === undefined) throw new InvalidInputError("mercator needs a fit direction");
	const n = checkInputs(src, dst, kind);
	if (direction === "forward") {
		const inner = fitPolynomial(projection.forward(src), dst, "affine");
		return {
			kind,
			pointCount: n,
			// One scratch array per batch, not per point: the projection allocates once.
			apply: (s, d) => inner.apply(projection.forward(s), d),
		};
	}
	const inner = fitPolynomial(src, projection.forward(dst), "affine");
	return {
		kind,
		pointCount: n,
		apply: (s, d) => {
			inner.apply(s, d);
			// Only the pairs this batch wrote: `dst` may be longer than `src`.
			projection.inverse(d.subarray(0, s.length));
		},
	};
}

/**
 * Fit a mapping from interleaved source pairs to interleaved destination pairs.
 *
 * The default branch is not dead code. TypeScript guarantees nothing about a `kind` that arrived
 * from note frontmatter, and without it an unrecognised model returned a Fit whose `forward` and
 * `reverse` were both `undefined` — a shape that only fails much later, somewhere unrelated.
 *
 * `direction` matters only to a projected model, which must know which side holds [lat, lng]:
 * "forward" is world to pixel, "reverse" pixel to world. The three plane models ignore it, which
 * is why the reverse fit is still the same call with the arguments swapped. A mercator fit
 * REQUIRES it and throws without one; the other models ignore it.
 */
export function fitMapping(
	src: Float64Array,
	dst: Float64Array,
	opts: TransformOptions,
	direction?: "forward" | "reverse",
): Mapping {
	switch (opts.kind) {
		case "affine":
		case "polynomial2":
			return fitPolynomial(src, dst, opts.kind);
		case "tps":
			return fitTps(src, dst, opts.lambda ?? 0);
		case "mercator":
			return fitProjected(src, dst, opts.kind, MERCATOR, direction);
		default: {
			const bad: never = opts.kind;
			throw new InvalidInputError(`unknown transform model: ${JSON.stringify(bad)}`);
		}
	}
}

/**
 * The thin-plate kernel and the smoothing scale, exposed for the independent leave-one-out oracle
 * in residuals.ts. That oracle must NOT call back into `fitTps`, because re-fitting a subset
 * would re-normalise it and so solve a different problem — which is exactly the bug that made the
 * previous oracle disagree with the closed form by 1 to 3 percent whenever lambda was non-zero.
 */
export const INTERNAL_FOR_ORACLE = { tpsKernel, smoothingDiagonal } as const;
