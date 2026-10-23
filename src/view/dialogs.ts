/**
 * The view's read-only dialogs and its one confirmation: the fit report, the model guide, and
 * "discard these changes?".
 *
 * They decide nothing. The report shows a `FitReport` the shell already built, the guide shows
 * copy, and the confirmation hands its answer back as one callback. The arithmetic of what a row
 * or a summary line says is split out as pure functions, so it is tested without a DOM.
 */
import { type App, Modal } from "obsidian";
import type { TransformKind } from "../api/types";
import { COPY } from "./copy";
import { coordinate } from "./format";
import type { FitReport, FitReportRow, FrameEdit } from "./shell";

/** The report's summary as term and value pairs, omitting what the fit cannot say. */
export function reportSummary(report: FitReport): [string, string][] {
	// The Mercator model's RMS is measured in the projected plane, so the row says so.
	const rmsLabel = report.model === "mercator" ? COPY.report.rmsMercator : COPY.report.rms;
	const lines: [string, string][] = [[rmsLabel, report.rms.toFixed(1)]];
	if (report.worst !== null) lines.push([COPY.report.worst, `${report.worst.label} ${report.worst.error.toFixed(1)} px`]);
	if (report.looRms !== null) lines.push([COPY.report.loo, report.looRms.toFixed(1)]);
	return lines;
}

/**
 * One table row, in the order of `COPY.report.columns`. A hull point with no leave-one-out error
 * says why rather than leaving a blank that reads as "fine".
 */
export function reportRowCells(row: FitReportRow): string[] {
	const loo = row.loo !== null ? row.loo.toFixed(1) : row.hull ? COPY.report.notDiagnostic : "";
	return [row.label, `${Math.round(row.px)}, ${Math.round(row.py)}`, coordinate({ lat: row.lat, lng: row.lng }), row.error.toFixed(1), loo, row.hull ? "yes" : ""];
}

/**
 * What a Discard must ask before it drops work, or null when there is nothing to lose. A new
 * map's draft is all there is of it, so its points are the question; a saved map keeps its fit.
 */
export function discardPrompt(edit: FrameEdit): string | null {
	if (edit.creating) return edit.pointCount > 0 ? COPY.discard.fresh(edit.pointCount) : null;
	return edit.dirty ? COPY.discard.saved : null;
}

export class FitReportModal extends Modal {
	constructor(
		app: App,
		private readonly report: FitReport,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		const report = this.report;
		this.titleEl.setText(COPY.report.title);
		contentEl.addClass("geb-report");

		const dl = contentEl.createEl("dl");
		for (const [term, value] of reportSummary(report)) {
			dl.createEl("dt", { text: term });
			dl.createEl("dd", { text: value });
		}
		if (report.coveragePct !== null) contentEl.createEl("p", { text: COPY.report.coverage(report.coveragePct) });

		if (report.notes.length > 0) {
			contentEl.createEl("h4", { text: COPY.report.notes });
			const ul = contentEl.createEl("ul");
			for (const note of report.notes) ul.createEl("li", { text: note });
		}

		const table = contentEl.createEl("table");
		const head = table.createEl("thead").createEl("tr");
		const c = COPY.report.columns;
		for (const h of [c.point, c.pixel, c.coordinate, c.error, c.loo, c.hull]) head.createEl("th", { text: h });
		const body = table.createEl("tbody");
		for (const row of report.rows) {
			const tr = body.createEl("tr");
			for (const cell of reportRowCells(row)) tr.createEl("td", { text: cell });
		}
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

const MODEL_TEXT: Readonly<Record<TransformKind, string>> = {
	affine: COPY.models.affine,
	mercator: COPY.models.mercator,
	polynomial2: COPY.models.polynomial2,
	tps: COPY.models.tps,
};

export class ModelsModal extends Modal {
	constructor(
		app: App,
		/** The names the model select shows, so the guide and the select cannot disagree. */
		private readonly models: readonly { readonly kind: TransformKind; readonly name: string }[],
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText(COPY.models.title);
		contentEl.addClass("geb-models");
		for (const m of this.models) {
			contentEl.createEl("h4", { text: m.name });
			contentEl.createEl("p", { text: MODEL_TEXT[m.kind] });
		}
		contentEl.createEl("p", { text: COPY.models.spread });
		contentEl.createEl("p", { text: COPY.models.rms });
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

/** A yes-or-no question whose yes is destructive. Cancel, Escape and the close button all say no. */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly title: string,
		private readonly body: string,
		private readonly confirmText: string,
		private readonly cancelText: string,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText(this.title);
		contentEl.createEl("p", { text: this.body });
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		const confirm = buttons.createEl("button", { cls: "mod-warning", text: this.confirmText });
		confirm.addEventListener("click", () => {
			this.close();
			this.onConfirm();
		});
		const cancel = buttons.createEl("button", { text: this.cancelText });
		cancel.addEventListener("click", () => this.close());
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
