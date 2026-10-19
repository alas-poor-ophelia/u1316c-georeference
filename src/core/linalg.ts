/**
 * Small dense linear algebra. Everything here runs on systems of at most a few dozen rows:
 * an affine fit is 3x3, an order-2 polynomial is 6x6, and a thin-plate spline over 20 control
 * points is 23x23. There is no reason to pull in a matrix library for that, and a dependency
 * in an Obsidian plugin is a dependency the community-store scan walks.
 */

/** Thrown when a system has no unique solution — collinear control points, usually. */
export class SingularMatrixError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SingularMatrixError";
	}
}

/**
 * Solve A x = B for x by Gauss-Jordan elimination with partial pivoting.
 *
 * `a` is n x n and `b` is n x m, so several right-hand sides share one elimination — which is
 * exactly the shape of a coordinate fit, where the x and y outputs share a design matrix.
 * Both inputs are copied; neither is modified.
 */
export function solve(a: readonly (readonly number[])[], b: readonly (readonly number[])[]): number[][] {
	const n = a.length;
	if (n === 0) throw new SingularMatrixError("empty system");
	if (b.length !== n) throw new SingularMatrixError(`right-hand side has ${b.length} rows, expected ${n}`);
	const m = b[0]?.length ?? 0;

	const A: number[][] = a.map((row) => {
		if (row.length !== n) throw new SingularMatrixError("matrix is not square");
		return [...row];
	});
	const B: number[][] = b.map((row) => [...row]);

	for (let col = 0; col < n; col++) {
		// Partial pivot: the largest magnitude in this column at or below the diagonal.
		let pivot = col;
		let best = Math.abs(A[col]?.[col] ?? 0);
		for (let r = col + 1; r < n; r++) {
			const v = Math.abs(A[r]?.[col] ?? 0);
			if (v > best) {
				best = v;
				pivot = r;
			}
		}
		if (best === 0) throw new SingularMatrixError(`singular at column ${col}`);
		if (pivot !== col) {
			const ta = A[col]!;
			A[col] = A[pivot]!;
			A[pivot] = ta;
			const tb = B[col]!;
			B[col] = B[pivot]!;
			B[pivot] = tb;
		}

		const prow = A[col]!;
		const brow = B[col]!;
		const d = prow[col]!;
		for (let c = col; c < n; c++) prow[c] = prow[c]! / d;
		for (let c = 0; c < m; c++) brow[c] = brow[c]! / d;

		for (let r = 0; r < n; r++) {
			if (r === col) continue;
			const factor = A[r]![col]!;
			if (factor === 0) continue;
			const arow = A[r]!;
			const browR = B[r]!;
			for (let c = col; c < n; c++) arow[c] = arow[c]! - factor * prow[c]!;
			for (let c = 0; c < m; c++) browR[c] = browR[c]! - factor * brow[c]!;
		}
	}

	return B;
}

/** Invert an n x n matrix. Used for Rippa's closed-form leave-one-out, which needs the diagonal. */
export function invert(a: readonly (readonly number[])[]): number[][] {
	const n = a.length;
	const identity: number[][] = Array.from({ length: n }, (_, i) =>
		Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
	);
	return solve(a, identity);
}

/**
 * Least-squares solution of an overdetermined system via the normal equations (Aᵀ A x = Aᵀ b).
 *
 * The normal equations square the condition number, which would matter for a large or badly
 * scaled design matrix. Here the design matrix has at most six columns over at most a few dozen
 * control points, and the coordinates are pre-centred by the callers, so it is comfortably fine.
 */
export function leastSquares(design: readonly (readonly number[])[], rhs: readonly (readonly number[])[]): number[][] {
	const rows = design.length;
	const cols = design[0]?.length ?? 0;
	const m = rhs[0]?.length ?? 0;

	const ata: number[][] = Array.from({ length: cols }, () => new Array<number>(cols).fill(0));
	const atb: number[][] = Array.from({ length: cols }, () => new Array<number>(m).fill(0));

	for (let r = 0; r < rows; r++) {
		const drow = design[r]!;
		const brow = rhs[r]!;
		for (let i = 0; i < cols; i++) {
			const di = drow[i]!;
			for (let j = 0; j < cols; j++) ata[i]![j] = ata[i]![j]! + di * drow[j]!;
			for (let j = 0; j < m; j++) atb[i]![j] = atb[i]![j]! + di * brow[j]!;
		}
	}

	return solve(ata, atb);
}
