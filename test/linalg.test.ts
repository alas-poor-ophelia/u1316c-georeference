/**
 * The solver, tested directly — which it was not.
 *
 * Every fit in Geb goes through `solve`, and until this file existed there was no `test/linalg*`
 * at all: the solver was exercised only incidentally, through fits whose correctness was asserted
 * end to end. That is a real gap rather than a tidiness complaint, because an end-to-end fit can
 * absorb a solver defect in a way a direct test cannot — the pivot-threshold bug in this module's
 * history produced a forward and a reverse fit that were garbage but AGREED WITH EACH OTHER, so
 * every round-trip assertion passed.
 *
 * Expected values here are derived by hand, not pinned from a run. The systems are small enough
 * for that to be practical, which is the point of choosing them: a 2x2 solved by substitution and
 * a least-squares line solved from the normal-equation formulae are independent of this code.
 */
import { describe, expect, test } from "bun:test";
import { SingularMatrixError } from "../src/core/errors";
import { invert, leastSquares, RELATIVE_PIVOT_EPSILON, solve } from "../src/core/linalg";

describe("solve", () => {
	test("a 2x2 system, against substitution by hand", () => {
		//  x + 2y = 5
		// 3x -  y = 1   =>  x = 1, y = 2
		const x = solve([[1, 2], [3, -1]], [[5], [1]]);
		expect(x[0]![0]!).toBeCloseTo(1, 12);
		expect(x[1]![0]!).toBeCloseTo(2, 12);
	});

	test("a system whose leading pivot is ZERO, which only partial pivoting survives", () => {
		// 0x + 1y = 3
		// 1x + 0y = 4   =>  x = 4, y = 3
		//
		// Without the row swap the first pivot is 0 and the elimination divides by it, giving
		// NaN or a spurious singularity. This is the test that pins the swap; the fits above
		// never present a system in this form, so nothing else does.
		const x = solve([[0, 1], [1, 0]], [[3], [4]]);
		expect(x[0]![0]!).toBeCloseTo(4, 12);
		expect(x[1]![0]!).toBeCloseTo(3, 12);
	});

	test("several right-hand sides share one elimination", () => {
		// The shape every coordinate fit uses: x and y outputs over one design matrix. Each column
		// must equal what it would be solved alone, or the sharing is wrong.
		const a = [[2, 1], [1, 3]];
		const both = solve(a, [[5, 1], [10, 2]]);
		const first = solve(a, [[5], [10]]);
		const second = solve(a, [[1], [2]]);
		expect(both[0]![0]!).toBeCloseTo(first[0]![0]!, 12);
		expect(both[1]![0]!).toBeCloseTo(first[1]![0]!, 12);
		expect(both[0]![1]!).toBeCloseTo(second[0]![0]!, 12);
		expect(both[1]![1]!).toBeCloseTo(second[1]![0]!, 12);
	});

	test("neither input is modified, as the docstring promises", () => {
		// An unchecked claim in a comment is a claim waiting to stop being true, and an in-place
		// solver would corrupt the caller's design matrix on the second of two fits.
		const a = [[2, 1], [1, 3]];
		const b = [[5], [10]];
		const aBefore = JSON.stringify(a);
		const bBefore = JSON.stringify(b);
		solve(a, b);
		expect(JSON.stringify(a)).toBe(aBefore);
		expect(JSON.stringify(b)).toBe(bBefore);
	});

	test("a singular system throws rather than returning garbage", () => {
		// Proportional rows: no unique solution exists, and the whole reason this throws is that
		// the alternative is two mutually inconsistent wrong answers nothing downstream can catch.
		expect(() => solve([[1, 2], [2, 4]], [[3], [6]])).toThrow(SingularMatrixError);
		expect(() => solve([[0, 0], [0, 0]], [[1], [1]])).toThrow(SingularMatrixError);
		expect(() => solve([], [])).toThrow(SingularMatrixError);
	});

	test("a malformed system is refused by shape, not misread", () => {
		expect(() => solve([[1, 2], [3, 4]], [[1]])).toThrow(SingularMatrixError);
		expect(() => solve([[1, 2, 3], [4, 5, 6]], [[1], [2]])).toThrow(SingularMatrixError);
	});

	test("the pivot threshold is RELATIVE, so it means the same at any coordinate scale", () => {
		// The same singular system scaled up by 1e6 must still be singular, and the same
		// well-conditioned system scaled down by 1e-6 must still solve. An absolute threshold —
		// which this module shipped once — gets exactly one of those two right.
		for (const k of [1e-6, 1, 1e6]) {
			expect(() => solve([[k, 2 * k], [2 * k, 4 * k]], [[k], [2 * k]])).toThrow(SingularMatrixError);
			const x = solve([[k, 0], [0, k]], [[3 * k], [4 * k]]);
			expect(x[0]![0]!).toBeCloseTo(3, 9);
			expect(x[1]![0]!).toBeCloseTo(4, 9);
		}
		expect(RELATIVE_PIVOT_EPSILON).toBeGreaterThan(0);
	});
});

describe("invert", () => {
	test("a 2x2 inverse, against the closed form", () => {
		// [[4,7],[2,6]] has determinant 10, so the inverse is [[6,-7],[-2,4]] / 10.
		const m = invert([[4, 7], [2, 6]]);
		expect(m[0]![0]!).toBeCloseTo(0.6, 12);
		expect(m[0]![1]!).toBeCloseTo(-0.7, 12);
		expect(m[1]![0]!).toBeCloseTo(-0.2, 12);
		expect(m[1]![1]!).toBeCloseTo(0.4, 12);
	});

	test("A times its inverse is the identity, at 3x3", () => {
		// Determinant 6. My first attempt used [[2,0,1],[1,3,2],[1,1,1]], whose determinant is
		// ZERO — so `invert` threw, correctly, and the test failed for being wrong about its own
		// fixture rather than about the code.
		const a = [[2, 0, 1], [1, 3, 2], [1, 1, 2]];
		const ai = invert(a);
		for (let i = 0; i < 3; i++) {
			for (let j = 0; j < 3; j++) {
				let acc = 0;
				for (let k = 0; k < 3; k++) acc += a[i]![k]! * ai[k]![j]!;
				expect(acc).toBeCloseTo(i === j ? 1 : 0, 10);
			}
		}
	});
});

describe("leastSquares", () => {
	test("an exactly representable line comes back exactly", () => {
		// y = 1 + 2x through (0,1), (1,3), (2,5).
		const c = leastSquares([[1, 0], [1, 1], [1, 2]], [[1], [3], [5]]);
		expect(c[0]![0]!).toBeCloseTo(1, 12);
		expect(c[1]![0]!).toBeCloseTo(2, 12);
	});

	test("an overdetermined fit matches the normal-equation formulae computed by hand", () => {
		// Points (0,0), (1,1), (2,2), (3,4). n = 4, Sx = 6, Sy = 7, Sxy = 17, Sxx = 14.
		//   b = (n.Sxy - Sx.Sy) / (n.Sxx - Sx^2) = (68 - 42) / (56 - 36) = 26 / 20 = 1.3
		//   a = (Sy - b.Sx) / n                  = (7 - 7.8) / 4        = -0.2
		const c = leastSquares([[1, 0], [1, 1], [1, 2], [1, 3]], [[0], [1], [2], [4]]);
		expect(c[0]![0]!).toBeCloseTo(-0.2, 12);
		expect(c[1]![0]!).toBeCloseTo(1.3, 12);
	});

	test("a design matrix with a redundant column is singular, not quietly resolved", () => {
		// The second and third columns are identical, so the system has no unique solution. This
		// is the shape near-collinear control points produce, and answering anyway is the failure
		// mode the whole kernel is arranged to avoid.
		const design = [[1, 0, 0], [1, 1, 1], [1, 2, 2], [1, 3, 3]];
		expect(() => leastSquares(design, [[0], [1], [2], [3]])).toThrow(SingularMatrixError);
	});
});
