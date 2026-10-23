/**
 * The model descriptions in copy.ts are prose that names point counts outright. These tests hold
 * each sentence against the kernel's own constants, so a change to a minimum or a recommendation
 * fails here instead of leaving the help text quietly contradicting the status line.
 */
import { describe, expect, test } from "bun:test";
import { MIN_POINTS, RECOMMENDED_POINTS } from "../src/core/types";
import { COPY } from "../src/view/copy";

describe("model descriptions agree with the kernel's point counts", () => {
	test("affine", () => {
		expect(COPY.models.affine).toContain(`Needs ${MIN_POINTS.affine} points`);
		expect(COPY.models.affine).toContain(`${RECOMMENDED_POINTS.affine} is better`);
	});
	test("mercator", () => {
		expect(COPY.models.mercator).toContain(`Needs ${MIN_POINTS.mercator} points`);
		expect(COPY.models.mercator).toContain(`${RECOMMENDED_POINTS.mercator} is better`);
	});
	test("polynomial2", () => {
		expect(COPY.models.polynomial2).toContain(`Needs ${MIN_POINTS.polynomial2} points`);
		expect(COPY.models.polynomial2).toContain(`${RECOMMENDED_POINTS.polynomial2} or more`);
	});
	test("thin-plate spline", () => {
		expect(COPY.models.tps).toContain(`Needs ${MIN_POINTS.tps} points`);
	});
	test("no status fragment carries the status line's own separator", () => {
		const fragments = [COPY.belowMin(0, 3), COPY.belowMin(2, 3), COPY.recommendedSuffix(8), COPY.barelyDetermined(6, 8), COPY.spreadNote];
		for (const f of fragments) expect(f.split(" · ").length).toBeLessThanOrEqual(2);
	});
});
