/**
 * What the dialogs say, without a DOM: the report's summary and rows, and when Discard asks.
 *
 * `obsidian` ships types only, so the module is stubbed before dialogs.ts is loaded; nothing
 * here touches a modal.
 */
import { describe, expect, mock, test } from "bun:test";
import { COPY } from "../src/view/copy";
import { coordinate } from "../src/view/format";
import type { FitReport, FitReportRow, FrameEdit } from "../src/view/shell";

void mock.module("obsidian", () => ({ Modal: class {} }));
const { discardPrompt, reportRowCells, reportSummary } = await import("../src/view/dialogs");

const ROW: FitReportRow = { label: "York", px: 10.4, py: 20.6, lat: 53.96, lng: -1.08, error: 1.234, loo: 2.26, hull: false };

const REPORT: FitReport = {
	model: "tps",
	pointCount: 5,
	rms: 1.26,
	worst: { label: "York", error: 2.04 },
	looRms: 3.14,
	coveragePct: 42,
	notes: [],
	rows: [ROW],
};

const EDIT: FrameEdit = {
	model: "tps",
	crs: "earth",
	pointCount: 4,
	minPoints: 3,
	recommendedPoints: 6,
	selected: null,
	fittable: true,
	dirty: false,
	saving: false,
	creating: false,
	saveTip: COPY.tips.saveClean,
	lastDeletedLabel: null,
};

describe("the fit report", () => {
	test("the summary gives each number to one decimal", () => {
		expect(reportSummary(REPORT)).toEqual([
			[COPY.report.rms, "1.3"],
			[COPY.report.worst, "York 2.0 px"],
			[COPY.report.loo, "3.1"],
		]);
	});

	test("what the fit cannot say is left out, not shown as zero", () => {
		expect(reportSummary({ ...REPORT, worst: null, looRms: null })).toEqual([[COPY.report.rms, "1.3"]]);
	});

	test("a row: integer pixel, formatted coordinate, errors to one decimal", () => {
		expect(reportRowCells(ROW)).toEqual(["York", "10, 21", coordinate({ lat: 53.96, lng: -1.08 }), "1.2", "2.3", ""]);
	});

	test("a hull point with no leave-one-out error says it is not diagnostic", () => {
		expect(reportRowCells({ ...ROW, loo: null, hull: true })).toEqual(["York", "10, 21", coordinate({ lat: 53.96, lng: -1.08 }), "1.2", COPY.report.notDiagnostic, "yes"]);
	});

	test("an inner point with no leave-one-out error is blank", () => {
		expect(reportRowCells({ ...ROW, loo: null })[4]).toBe("");
	});
});

describe("when Discard asks first", () => {
	test("a clean draft of a saved map is dropped without asking", () => {
		expect(discardPrompt(EDIT)).toBeNull();
	});

	test("a dirty draft of a saved map asks, and says the saved fit stays", () => {
		expect(discardPrompt({ ...EDIT, dirty: true })).toBe(COPY.discard.saved);
	});

	test("a new map with points asks, and counts them", () => {
		expect(discardPrompt({ ...EDIT, creating: true, pointCount: 2 })).toBe(COPY.discard.fresh(2));
	});

	test("a new map with no points has nothing to lose", () => {
		expect(discardPrompt({ ...EDIT, creating: true, pointCount: 0, dirty: true })).toBeNull();
	});
});
