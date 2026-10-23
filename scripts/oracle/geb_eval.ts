/**
 * Geb's side of the independent numerical oracle.
 *
 * Usage: bun scripts/oracle/geb_eval.ts <cases.json> <out.json>
 *
 * For each case: fit with `fitMapping`, apply to the probe points AND to the control points (so
 * exact interpolation can be checked), and write the raw outputs. NO COMPARISON HAPPENS HERE —
 * that is `oracle.py`'s job, and the separation is the point. This file must stay ignorant of
 * what the right answer is, or it stops being half of an oracle and becomes a second opinion
 * from the same source.
 *
 * Compared in REAL UNITS, never as coefficients: every fitter normalises internally (Hartley,
 * see mapping.ts) and undoes it on apply, so coefficients from the two sides are not comparable.
 * A previous in-repo oracle re-normalised a subset and so solved a different problem, agreeing at
 * lambda = 0 and disagreeing 1-3% above it.
 *
 * NO `node:` IMPORTS. The Obsidian community-store scan reads the whole tracked tree, not just
 * src/, and flags Node built-ins because they are unavailable on mobile — `scripts` is in
 * `lint:scanner`'s paths for exactly that reason. A sibling plugin was delisted within an hour of
 * publishing because the scanner read its harness directory. Bun's own file APIs carry no such
 * rule, and this script is not under a test timeout, so the async read costs nothing here.
 */
import { fitMapping } from "../../src/core/mapping";
import type { TransformOptions } from "../../src/core/types";

interface Case {
	readonly name: string;
	readonly kind: "affine" | "polynomial2" | "tps" | "mercator";
	/** `null` or absent both mean "do not pass a lambda at all". */
	readonly lambda?: number | null;
	/** Only `mercator` reads it: which side of the fit holds [lat, lng]. Absent means "forward". */
	readonly direction?: "forward" | "reverse" | null;
	readonly src: number[];
	readonly dst: number[];
	readonly probes: number[];
}

const [casesPath, outPath] = process.argv.slice(2);
if (casesPath === undefined || outPath === undefined) {
	throw new Error("usage: bun scripts/oracle/geb_eval.ts <cases.json> <out.json>");
}

const cases = JSON.parse(await Bun.file(casesPath).text()) as Case[];

const results: Record<string, unknown> = {};
for (const c of cases) {
	try {
		// `lambda` is OMITTED rather than set to undefined: the repo runs with
		// `exactOptionalPropertyTypes`, under which `{lambda: undefined}` is not a
		// `TransformOptions`. Spelling it out keeps this file inside `bun run typecheck`.
		const opts: TransformOptions =
			c.lambda === null || c.lambda === undefined ? { kind: c.kind } : { kind: c.kind, lambda: c.lambda };

		const m =
				c.direction === null || c.direction === undefined
					? fitMapping(Float64Array.from(c.src), Float64Array.from(c.dst), opts)
					: fitMapping(Float64Array.from(c.src), Float64Array.from(c.dst), opts, c.direction);

		const probeOut = new Float64Array(c.probes.length);
		m.apply(Float64Array.from(c.probes), probeOut);
		const srcOut = new Float64Array(c.src.length);
		m.apply(Float64Array.from(c.src), srcOut);

		results[c.name] = { ok: true, probeOut: Array.from(probeOut), srcOut: Array.from(srcOut) };
	} catch (e) {
		// A throw is a RESULT, not a harness failure: the oracle must be able to record
		// "Geb refused this input" and compare that against whether the reference could answer.
		const err = e as Error;
		results[c.name] = { ok: false, errorName: err.constructor.name, message: err.message };
	}
}

await Bun.write(outPath, JSON.stringify(results));
