/**
 * The three transform models, as pure 2D-to-2D fitters.
 *
 * Nothing here knows which side is the world and which is the image: a fitter takes interleaved
 * source pairs and interleaved destination pairs and returns a mapping between them. That is what
 * makes the reverse fit free — fit.ts simply calls the same fitter with the arguments swapped —
 * and it is why there is no latitude/longitude axis convention anywhere in this file.
 *
 * CONDITIONING. Raw inputs are badly scaled for a least-squares fit: longitude runs to 180 while
 * pixels run to several thousand, and an order-2 polynomial squares both. Every fitter normalises
 * each side to zero centroid and unit RMS radius first (Hartley normalisation), fits in that
 * space, and undoes it on apply. Without this an order-2 fit over a continent-sized map loses
 * most of its significant digits in the normal equations.
 */
import { leastSquares, solve } from "./linalg";
import { MIN_POINTS, type Mapping, type TransformKind, type TransformOptions } from "./types";

export class FitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FitError";
	}
}

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

	const coeffs = leastSquares(design, rhs);
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

function fitTps(src: Float64Array, dst: Float64Array, lambda: number): TpsMapping {
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
	const A: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < n; j++) {
			if (i === j) {
				A[i]![j] = lambda;
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

	return new TpsMapping(n, nodes, coeffs, Ainv, lambda, srcN, dstN, makeApply(srcN, dstN, evaluate));
}

/** Fit a mapping from interleaved source pairs to interleaved destination pairs. */
export function fitMapping(src: Float64Array, dst: Float64Array, opts: TransformOptions): Mapping {
	switch (opts.kind) {
		case "affine":
		case "polynomial2":
			return fitPolynomial(src, dst, opts.kind);
		case "tps":
			return fitTps(src, dst, opts.lambda ?? 0);
	}
}
