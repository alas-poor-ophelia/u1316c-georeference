/**
 * Mutation gate for the MATHS. Run: bun run gate:mutation
 *
 * WHY THIS EXISTS. A green suite over code nobody mutated is evidence of nothing. Geb's coverage
 * query and its view were both mutation-audited by hand during their phases; `src/core` — the
 * actual arithmetic — never was, and a 2026-10-20 review found the consequence: a test asserting
 * `worst > 0` against a measured 3.4e-12, which a fitter that ignored its smoothing parameter
 * entirely would still pass. This gate makes that class of hole a build failure instead of a
 * discovery.
 *
 * WHAT A RESULT MEANS. Each mutant is a deliberate defect. The suite MUST go red for every one.
 * A mutant the suite still passes is a SURVIVOR: that line of maths is unpinned, and the fix is a
 * new assertion, never a change to this file's expectations.
 *
 * THE FOUR RULES THIS HARNESS OBEYS, each one bought with a previous failure:
 *   1. Every mutant replaces a WHOLE EXPRESSION, so the mutated file still parses. A mutant that
 *      leaves a syntax error (a dangling `&&`) can HANG the runner rather than fail it.
 *   2. The original is restored in a `finally`, and then read back and compared byte for byte. A
 *      harness killed at its time limit otherwise leaves a mutated file in the working tree — and
 *      the Obsidian store scan reads the tracked tree. `finally` IS NOT ENOUGH ON ITS OWN, which
 *      is the correction that produced the recovery journal below: a `finally` does not run when
 *      the process is killed by a signal, so `timeout 2 bun run gate:mutation` left a mutated
 *      file behind — the precise case this rule named. Three layers now: a signal handler, and a
 *      journal on disk that a later run finds and restores from before it trusts anything.
 *   3. Each mutant runs under its OWN timeout, so one hang cannot consume the whole budget.
 *   4. A `find` string must match EXACTLY ONCE. A pattern that matches twice silently mutates the
 *      wrong place and reports a meaningless verdict, so an ambiguous mutant is an error here,
 *      not a guess.
 *
 * NO `node:` IMPORTS — see the header of gate-scanner.ts. `scripts` is inside `lint:scanner`'s
 * paths because the community-store scan reads the whole tracked tree, and a sibling plugin was
 * delisted for exactly that. This script is not under a test timeout, so Bun's async file APIs
 * cost nothing here.
 */

// This file uses top-level `await` but imports nothing, and TypeScript only allows that in a
// MODULE. An empty export is the standard way to say "this is a module" without inventing a
// dependency — and inventing one here would be worse than it looks, because `scripts` is inside
// `lint:scanner`'s paths and the community-store scan reads every tracked import.
export {};

interface Mutant {
	/** What the defect is, in the register of a bug report. */
	readonly label: string;
	readonly file: string;
	/** Must occur exactly once in the file. */
	readonly find: string;
	readonly replace: string;
}

/**
 * The mutants, grouped by the property each one attacks.
 *
 * Chosen to re-introduce defects this repo has ACTUALLY had (the exact-zero pivot test, the
 * graticule choosing its step from the longer span, the hemisphere taken from the raw sign) plus
 * the load-bearing steps no test was known to pin (Hartley centring and scaling, the thin-plate
 * kernel, the smoothing scale, Rippa's denominator, the destination-scale conversion).
 */
const MUTANTS: readonly Mutant[] = [
	// --- linalg.ts: the singularity guard -------------------------------------------------
	{
		label: "pivot threshold back to an exact-zero test (the original phase-1 defect)",
		file: "src/core/linalg.ts",
		find: "export const RELATIVE_PIVOT_EPSILON = 1e-10;",
		replace: "export const RELATIVE_PIVOT_EPSILON = 0;",
	},
	{
		label: "partial pivoting disabled (never swap to the largest row)",
		file: "src/core/linalg.ts",
		find: "if (v > best) {",
		replace: "if (false) {",
	},
	{
		label: "singularity guard never fires",
		file: "src/core/linalg.ts",
		find: "if (best <= tol) {",
		replace: "if (false) {",
	},

	// --- mapping.ts: conditioning ---------------------------------------------------------
	{
		label: "Hartley scaling removed (normalise to unit scale regardless of spread)",
		file: "src/core/mapping.ts",
		find: "const scale = rms > 0 ? Math.SQRT2 / rms : 1;",
		replace: "const scale = 1;",
	},
	{
		label: "Hartley centring removed (centroid forced to the origin)",
		file: "src/core/mapping.ts",
		find: "\treturn { cx, cy, scale };",
		replace: "\treturn { cx: 0, cy: 0, scale };",
	},

	// --- mapping.ts: the models -----------------------------------------------------------
	{
		label: "affine basis loses its y term",
		file: "src/core/mapping.ts",
		find: "const AFFINE_BASIS = (x: number, y: number): number[] => [1, x, y];",
		replace: "const AFFINE_BASIS = (x: number, y: number): number[] => [1, x, x];",
	},
	{
		label: "order-2 basis loses its cross term",
		file: "src/core/mapping.ts",
		find: "const POLY2_BASIS = (x: number, y: number): number[] => [1, x, y, x * x, x * y, y * y];",
		replace: "const POLY2_BASIS = (x: number, y: number): number[] => [1, x, y, x * x, x, y * y];",
	},
	{
		label: "thin-plate kernel is r^2 instead of r^2 log r",
		file: "src/core/mapping.ts",
		find: "\treturn r2 <= 0 ? 0 : 0.5 * r2 * Math.log(r2);",
		replace: "\treturn r2 <= 0 ? 0 : r2;",
	},
	{
		label: "smoothing scale not divided by the point count (the 13.9x spread defect)",
		file: "src/core/mapping.ts",
		find: "\treturn lambda / n;",
		replace: "\treturn lambda;",
	},

	// --- geometry.ts: the quantity the residuals cannot express ---------------------------
	{
		label: "axis ratio drops the covariance cross-term (a diagonal line reads as a round cloud)",
		file: "src/core/geometry.ts",
		find: "\tconst det = cxx * cyy - cxy * cxy;",
		replace: "\tconst det = cxx * cyy;",
	},
	{
		label: "axis ratio returns a variance ratio instead of a length ratio",
		file: "src/core/geometry.ts",
		find: "\treturn Math.sqrt(Math.max(0, smaller) / larger);",
		replace: "\treturn Math.max(0, smaller) / larger;",
	},
	{
		label: "near-collinear threshold set so the caveat can never fire",
		file: "src/core/geometry.ts",
		find: "export const NEARLY_COLLINEAR_RATIO = 0.01;",
		replace: "export const NEARLY_COLLINEAR_RATIO = 0;",
	},
	{
		label: "near-collinear caveat removed from diagnose",
		file: "src/core/residuals.ts",
		find: "\tif (ratio < NEARLY_COLLINEAR_RATIO) {",
		replace: "\tif (false) {",
	},

	// --- geometry.ts: the antimeridian detector, and its false positives -------------------
	{
		label: "antimeridian caveat removed from diagnose",
		file: "src/core/residuals.ts",
		find: "\tif (wrapsAntimeridian(points)) {",
		replace: "\tif (false) {",
	},
	{
		label: "antimeridian decided from longitude values alone (flags ordinary world maps)",
		file: "src/core/geometry.ts",
		find: "\treturn asTyped > WRAP_MIN_AS_TYPED_RMS_PX && rewrapped * WRAP_IMPROVEMENT_FACTOR < asTyped;",
		replace: "\treturn true;",
	},
	{
		label: "longitudes unwrapped on the wrong side of the gap",
		file: "src/core/geometry.ts",
		find: "\treturn points.map((p) => (p.lng <= cut ? { ...p, lng: p.lng + 360 } : p));",
		replace: "\treturn points.map((p) => (p.lng > cut ? { ...p, lng: p.lng + 360 } : p));",
	},

	// --- residuals.ts: the exactly-determined caveat --------------------------------------
	{
		label: "exactly-determined caveat removed (RMS 0.0 px at three points with no warning)",
		file: "src/core/residuals.ts",
		find: "\tif (points.length <= AFFINE_PARAMETERS) {",
		replace: "\tif (false) {",
	},
	{
		label: "three points advertised as recommended for affine again",
		file: "src/core/types.ts",
		find: "\taffine: 4,",
		replace: "\taffine: 3,",
	},

	// --- residuals.ts: the leave-one-out diagnostic ---------------------------------------
	{
		label: "Rippa's denominator dropped (report the raw coefficient as the error)",
		file: "src/core/residuals.ts",
		find: "\t\tconst ex = m.coeffs[i]![0]! / denom;",
		replace: "\t\tconst ex = m.coeffs[i]![0]!;",
	},
	{
		label: "destination-scale conversion inverted for an error magnitude",
		file: "src/core/residuals.ts",
		find: "\t\tout.push(Math.hypot(ex, ey) / m.dstScale);",
		replace: "\t\tout.push(Math.hypot(ex, ey) * m.dstScale);",
	},
	{
		label: "leave-one-out RMS averages hull points in with the interior",
		file: "src/core/residuals.ts",
		find: "const interior = loo.filter((r) => !r.onHull).map((r) => r.error);",
		replace: "const interior = loo.map((r) => r.error);",
	},

	// --- hull.ts --------------------------------------------------------------------------
	{
		label: "hull keeps collinear points instead of discarding them",
		file: "src/core/hull.ts",
		find: "while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop();",
		replace: "while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) < 0) out.pop();",
	},
	{
		label: "point-in-hull test accepts points far outside the boundary",
		file: "src/core/hull.ts",
		find: "\t\tif (distance < -epsilon) return false;",
		replace: "\t\tif (distance < -1) return false;",
	},
	{
		label: "hull tolerance compared against an area again, so it varies with coordinate scale",
		file: "src/core/hull.ts",
		find: "\t\tconst distance = (ex * (p.y - a.y) - ey * (p.x - a.x)) / edge;",
		replace: "\t\tconst distance = ex * (p.y - a.y) - ey * (p.x - a.x);",
	},

	// --- residuals.ts: the outlier note's two conditions ----------------------------------
	{
		label: "outlier note loses its absolute floor (fires on float noise in a perfect fit)",
		file: "src/core/residuals.ts",
		find: "worstError > MASKING_NOTE_FLOOR_PX",
		replace: "true",
	},
	{
		label: "median reverts to the upper-middle element",
		file: "src/core/residuals.ts",
		find: "\treturn n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;",
		replace: "\treturn sorted[mid]!;",
	},

	// --- fit.ts: extent is gated like every other answer ----------------------------------
	{
		label: "extent gate removed (a folded polynomial reports a confident wrong corner)",
		file: "src/core/fit.ts",
		find: "\t\tif (!roundTripFromPixel(fit.forward, fit.reverse, x, y, tolerancePx).ok) return null;",
		replace: "\t\tif (false) return null;",
	},

	// --- graticule.ts: inclusive really means inclusive -----------------------------------
	{
		label: "boundary tick lost to floating-point division again",
		file: "src/view/graticule.ts",
		find: "\tconst last = Math.floor(hi / step + slack);",
		replace: "\tconst last = Math.floor(hi / step);",
	},
	{
		label: "negative-zero guard removed from the origin tick",
		file: "src/view/graticule.ts",
		find: "\tif (Object.is(first, -0)) first = 0;",
		replace: "\tif (false) first = 0;",
	},

	// --- view/shell.ts: the view's decisions ----------------------------------------------
	{
		label: "shell reloads on every map's change, not only its own",
		file: "src/view/shell.ts",
		find: "\t\t\t\tif (this.notePath === null || p.paths.length === 0 || p.paths.includes(this.notePath)) this.load();",
		replace: "\t\t\t\tthis.load();",
	},
	{
		label: "a map with no note path yet ignores the change that brings it",
		file: "src/view/shell.ts",
		find: "\t\t\t\tif (this.notePath === null || p.paths.length === 0 || p.paths.includes(this.notePath)) this.load();",
		replace: "\t\t\t\tif (p.paths.length === 0 || (this.notePath !== null && p.paths.includes(this.notePath))) this.load();",
	},
	{
		label: "the message state keeps the stale map, so the toolbar can resurrect it",
		file: "src/view/shell.ts",
		find: "\t\tthis.image = null;\n\t\tthis.fit = null;",
		replace: "\t\tthis.fit = null;",
	},
	{
		label: "a fit is computed against an empty surface instead of deferred",
		file: "src/view/shell.ts",
		find: "\t\tif (!(size.width > 0 && size.height > 0)) {",
		replace: "\t\tif (false) {",
	},
	{
		label: "graticule points outside the image are kept",
		file: "src/view/shell.ts",
		find: "\t\t\tif (p === null || !insideImage(image, p)) {",
		replace: "\t\t\tif (p === null) {",
	},
	{
		label: "uncertainty ring sized from the north probe alone",
		file: "src/view/shell.ts",
		find: "\t\treturn Math.max(rN, rE);",
		replace: "\t\treturn rN;",
	},
	{
		label: "a drag ignores where the pointer is, so the readout freezes",
		file: "src/view/shell.ts",
		find: "\t\tif (at !== undefined) this.hover = at;",
		replace: "\t\tvoid at;",
	},
	{
		label: "shell drops the pins",
		file: "src/view/shell.ts",
		find: "\t\t\tthis.pins = this.api.featuresIn(this.georefId) ?? [];",
		replace: "\t\t\tthis.pins = [];",
	},
	{
		label: "readout no longer says when a coordinate is extrapolated",
		file: "src/view/shell.ts",
		find: "\t\treturn coordinate(w) + (w.extrapolated ? \" · extrapolated\" : \"\");",
		replace: "\t\treturn coordinate(w);",
	},
	{
		label: "readout answers for pointer positions off the image",
		file: "src/view/shell.ts",
		find: "\t\tif (img === null || !insideImage(this.image, img)) return \"\";",
		replace: "\t\tif (img === null) return \"\";",
	},
	{
		label: "tap hit radius not scaled into image pixels",
		file: "src/view/shell.ts",
		find: "\t\tconst hit = pinAt(this.pins, img, hitRadiusCss / this.viewport.scale);",
		replace: "\t\tconst hit = pinAt(this.pins, img, hitRadiusCss);",
	},
	{
		label: "every reload re-fits the image, discarding the user's viewport",
		file: "src/view/shell.ts",
		find: "\t\t\tconst firstPlacement = this.image === null;",
		replace: "\t\t\tconst firstPlacement = true;",
	},
	{
		label: "first load never fits the image to the container",
		file: "src/view/shell.ts",
		find: "\t\t\tif (firstPlacement) this.fitImage();\n\t\t\telse this.paint();",
		replace: "\t\t\tthis.paint();",
	},
	{
		label: "a drag does not mark the viewport as user-adjusted (resize snaps it back)",
		file: "src/view/shell.ts",
		find: "\t\tthis.viewport = panBy(this.viewport, dx, dy);\n\t\tthis.userAdjusted = true;",
		replace: "\t\tthis.viewport = panBy(this.viewport, dx, dy);",
	},
	{
		label: "wheel zoom unbounded per event",
		file: "src/view/shell.ts",
		find: "\t\tconst factor = Math.min(WHEEL_STEP_LIMIT, Math.max(1 / WHEEL_STEP_LIMIT, raw));",
		replace: "\t\tconst factor = raw;",
	},
	{
		label: "unload leaves the dead map on screen with no message",
		file: "src/view/shell.ts",
		find: "\t\t\t\tthis.showMessage(MESSAGES.unloaded);",
		replace: "\t\t\t\tvoid MESSAGES.unloaded;",
	},
	{
		label: "pins copied on every paint (the adapter rebuilds the overlay per hover)",
		file: "src/view/shell.ts",
		find: "			pins: this.framePins,",
		replace: "			pins: [...this.framePins],",
	},
	{
		label: "pin labels keep the .md extension",
		file: "src/view/shell.ts",
		find: "\treturn file.endsWith(\".md\") ? file.slice(0, -3) : file;",
		replace: "\treturn file;",
	},

	// --- validity.ts: the round-trip gate -------------------------------------------------
	{
		label: "round-trip tolerance so wide the gate never refuses anything",
		file: "src/core/validity.ts",
		find: "export const DEFAULT_ROUND_TRIP_TOLERANCE_FRACTION = 0.005;",
		replace: "export const DEFAULT_ROUND_TRIP_TOLERANCE_FRACTION = 1e9;",
	},
	{
		label: "round-trip gate always passes",
		file: "src/core/validity.ts",
		find: "\treturn { ok: Number.isFinite(error) && error <= tolerancePx, error };\n}\n\n/**\n * The same test starting from a pixel",
		replace: "\treturn { ok: true, error };\n}\n\n/**\n * The same test starting from a pixel",
	},

	// --- view: the arithmetic the eye cannot check ----------------------------------------
	{
		label: "zoom anchor ratio inverted (map slides away from the cursor)",
		file: "src/view/viewport.ts",
		find: "\tconst ratio = next / v.scale;",
		replace: "\tconst ratio = v.scale / next;",
	},
	{
		label: "screen-to-image forgets the offset",
		file: "src/view/viewport.ts",
		find: "\treturn { x: (p.x - v.offsetX) / v.scale, y: (p.y - v.offsetY) / v.scale };",
		replace: "\treturn { x: p.x / v.scale, y: p.y / v.scale };",
	},
	{
		label: "graticule step chosen from the LONGER span (the no-parallels defect)",
		file: "src/view/graticule.ts",
		find: "\tlet step = chooseStep(shorter, want);",
		replace: "\tlet step = chooseStep(longer, want);",
	},
	{
		label: "graticule step-up jumps the whole ladder instead of one rung",
		file: "src/view/graticule.ts",
		find: "\t\tconst coarser = [...STEPS].reverse().find((s) => s > step);",
		replace: "\t\tconst coarser = STEPS.find((s) => s > step);",
	},
	{
		label: "readout hemisphere taken from the raw sign, not the rounded value",
		file: "src/view/format.ts",
		find: "\tconst hemisphere = rounded === 0 ? (kind === \"lat\" ? \"N\" : \"E\") : kind === \"lat\" ? (rounded < 0 ? \"S\" : \"N\") : rounded < 0 ? \"W\" : \"E\";",
		replace: "\tconst hemisphere = kind === \"lat\" ? (value < 0 ? \"S\" : \"N\") : value < 0 ? \"W\" : \"E\";",
	},
	{
		label: "trust display reports the chosen model's RMS shape without the worst point",
		file: "src/view/format.ts",
		find: "\tconst worst = [...d.affine].sort((a, b) => b.error - a.error)[0];",
		replace: "\tconst worst = [...d.affine].sort((a, b) => a.error - b.error)[0];",
	},
];

/** Per-mutant ceiling. The clean suite runs in well under a second, so this is generous. */
const TIMEOUT_MS = 60_000;

/**
 * Run the suite once, under a hard ceiling.
 *
 * `Bun.spawn`'s own `timeout` rather than a `setTimeout` race, for two reasons. The community-store
 * scanner flags a bare `setTimeout` — it wants `window.setTimeout`, which does not exist in a CLI
 * script — and the spawn option is the better mechanism regardless: the kill belongs to the
 * runtime, so it cannot be missed by a promise that has already settled.
 *
 * VERIFIED RATHER THAN ASSUMED, because a silently ignored option would let one hanging mutant
 * block the entire gate with no sign of why: a 30 s sleep under a 1.5 s ceiling died at 1,543 ms
 * with SIGTERM and exit code 143.
 */
async function runSuite(): Promise<{ code: number; timedOut: boolean }> {
	const proc = Bun.spawn(["bun", "test"], { stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS });
	const code = await proc.exited;
	// A signal kill is never an ordinary test failure: it is the ceiling firing, or an outside
	// interruption. Either way this mutant's verdict is "no result", not "caught".
	return { code, timedOut: proc.signalCode !== null };
}

/**
 * Where the pristine originals are journalled while mutants are applied.
 *
 * ON DISK AND NOT ONLY IN MEMORY, because an in-memory copy dies with the process that holds it.
 * A run killed by a signal leaves this directory behind, and the next run restores from it before
 * reading anything — which is what stops a stranded mutant from being adopted as the "original"
 * and then silently baked into every later comparison. Inside node_modules/.cache so it is
 * already ignored by git and invisible to the community-store scan.
 */
const JOURNAL = "node_modules/.cache/geb-mutation-journal";
const journalPath = (file: string): string => `${JOURNAL}/${file.replaceAll("/", "__")}`;

// RECOVERY FIRST, before this run forms any opinion about what the source says. If a previous run
// was killed between writing a mutant and restoring it, the file on disk is a mutant and the
// journal holds the truth.
const recovered: string[] = [];
for (const m of MUTANTS) {
	const j = Bun.file(journalPath(m.file));
	if (!(await j.exists())) continue;
	const pristine = await j.text();
	if ((await Bun.file(m.file).text()) !== pristine) {
		await Bun.write(m.file, pristine);
		recovered.push(m.file);
	}
	await Bun.file(journalPath(m.file)).delete();
}
if (recovered.length > 0) {
	console.error(`recovered ${recovered.length} file(s) stranded by an interrupted run: ${recovered.join(", ")}`);
}

// Every file we will touch, read once up front. Restoring from this map rather than from a
// per-iteration read means a mutant that somehow corrupts a second file is still recoverable.
const originals = new Map<string, string>();
for (const m of MUTANTS) {
	if (!originals.has(m.file)) originals.set(m.file, await Bun.file(m.file).text());
}
for (const [file, text] of originals) await Bun.write(journalPath(file), text);

/** Restore everything and drop the journal. Safe to call twice. */
async function cleanUp(): Promise<string[]> {
	const bad: string[] = [];
	for (const [file, text] of originals) {
		await Bun.write(file, text);
		if ((await Bun.file(file).text()) !== text) bad.push(file);
	}
	for (const [file] of originals) {
		const j = Bun.file(journalPath(file));
		if (await j.exists()) await j.delete();
	}
	return bad;
}

// The second layer, and MEASURED TO BE BEST-EFFORT ONLY — do not rely on it. A `finally` never
// runs for SIGINT or SIGTERM, so Ctrl-C would otherwise strand a mutant; but the restore itself is
// async, and under `timeout -s TERM` the process died before this handler's writes landed, leaving
// `src/core/hull.ts` mutated. The journal above is what actually recovered it on the next run.
// Keeping the handler because it wins the race often enough to be worth having, and saying plainly
// that it is not the guarantee: a comment that overstates its mechanism is how the previous
// version of this header came to claim `finally` covered a case it did not.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		void cleanUp().then(() => {
			console.error(`\n${sig}: restored ${originals.size} file(s) before exiting`);
			process.exit(130);
		});
	});
}

// The clean suite must be green first. Measuring "did the mutant turn it red" against an
// already-red suite would call every mutant caught and prove nothing.
const clean = await runSuite();
if (clean.code !== 0) {
	console.error(`  - clean suite is not green (exit ${clean.code}); fix real failures first`);
	console.error("GATE FAILED");
	process.exit(1);
}

const survivors: string[] = [];
const ambiguous: string[] = [];
const timeouts: string[] = [];
let caught = 0;

for (const m of MUTANTS) {
	const original = originals.get(m.file)!;
	const hits = original.split(m.find).length - 1;
	if (hits !== 1) {
		// Not a survivor and not a catch: the mutant itself is broken, which is a gate failure
		// because it means this file has drifted from the source it mutates.
		ambiguous.push(`${m.label} — pattern matched ${hits} times in ${m.file}, expected exactly 1`);
		continue;
	}

	try {
		await Bun.write(m.file, original.replace(m.find, m.replace));
		const r = await runSuite();
		if (r.timedOut) timeouts.push(`${m.label} (${m.file})`);
		else if (r.code === 0) survivors.push(`${m.label} (${m.file})`);
		else caught++;
	} finally {
		await Bun.write(m.file, original);
		if ((await Bun.file(m.file).text()) !== original) {
			console.error(`  - FATAL: could not restore ${m.file}`);
			await cleanUp();
			console.error("GATE FAILED");
			process.exit(1);
		}
	}
}

// Belt and braces: prove the tree is exactly as we found it before reporting anything.
const unrestored = await cleanUp();

const failures: string[] = [];
for (const a of ambiguous) failures.push(`ambiguous mutant: ${a}`);
for (const s of survivors) failures.push(`SURVIVED (no test pins this): ${s}`);
for (const t of timeouts) failures.push(`timed out — likely a hang, not a failure: ${t}`);
for (const u of unrestored) failures.push(`file not restored: ${u}`);

console.error(
	`${MUTANTS.length} mutants over ${originals.size} files: ${caught} caught, ${survivors.length} survived, ` +
		`${ambiguous.length} ambiguous, ${timeouts.length} timed out`,
);

if (failures.length > 0) {
	for (const f of failures) console.error(`  - ${f}`);
	console.error("GATE FAILED");
	process.exit(1);
}

console.error("GATE GREEN");
