// ESLint 9 flat config.
//  - eslint-plugin-obsidianmd `recommended` (the preset the Obsidian community-plugin store scan
//    runs) applies to the plugin source only: src/. Scripts and tests are Bun programs where
//    console output and node: imports are the point. eslint.scanner-replica.mjs is the raw,
//    unmodified replica of the store scan for `bun run lint:scanner`.
//  - typescript-eslint type-checked rules everywhere.
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

const SRC = ["src/**/*.ts"];
// Scope the preset to src/: file-agnostic entries get `files: src/**`; entries that already
// name their files have every pattern AND-ed with src/** (a nested array in `files` means all
// patterns must match); the package.json checks and pure `ignores` entries are left alone.
const andSrc = (f) => (Array.isArray(f) ? [...f, "src/**/*"] : [f, "src/**/*"]);
const obsidianForSrc = obsidianmd.configs.recommended.map((c) => {
	if (c.ignores && !c.rules && !c.plugins && !c.languageOptions) return c;
	if (!c.files) return { ...c, files: SRC };
	if (c.files.some((f) => String(f).includes("package.json"))) return c;
	return { ...c, files: c.files.map(andSrc) };
});

export default tseslint.config(
	{
		ignores: ["node_modules/**", ".claude/**", "main.js", "**/*.json", "**/*.mjs", "**/*.cjs", "docs/**"],
	},
	...obsidianForSrc,
	...tseslint.configs.recommendedTypeChecked,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
		},
	},
	{
		// src/core is the transform kernel: pure TypeScript, no Obsidian imports, so the whole
		// surface is testable without an app. This fence is what keeps that true.
		files: ["src/core/**/*.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{ patterns: [{ group: ["obsidian", "../plugin/*", "../plugin/**"], message: "src/core imports nothing from Obsidian or the plugin layer." }] },
			],
		},
	},
	{
		// src/persist, src/query and src/api hold the same property for a harder case: they are
		// ABOUT the vault, and still never import it. Everything they need is behind VaultPort,
		// which the plugin layer implements and the tests fake — so rename behaviour, coverage
		// queries and the whole public API are driven by a fake without launching anything.
		// src/api is in here deliberately: an API that reached for `app` directly could not be
		// behaviourally tested, and the phase-4 gate requires exactly that.
		files: ["src/persist/**/*.ts", "src/query/**/*.ts", "src/api/**/*.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{ patterns: [{ group: ["obsidian", "../plugin/*", "../plugin/**"], message: "src/persist, src/query and src/api reach the vault only through VaultPort." }] },
			],
		},
	},
	{
		// THE PHASE-5 GATE, as a fence rather than a promise.
		//
		// The build order says the view must create a georeference and its control points
		// "through the public API only, with no private access — that is what makes the
		// dogfooding claim real". Asserted in prose that claim is unfalsifiable: nothing stops a
		// view from importing `buildFit` directly the first time the public surface is awkward,
		// and the awkwardness is precisely the signal the dogfooding exists to surface.
		//
		// So the view may reach for Obsidian (it IS the Obsidian layer) and for `src/api/types`
		// and `src/api/errors` — the published surface and its error codes, the same two things a
		// third-party consumer gets. Everything else in the plugin is off limits: the kernel, the
		// persistence layer, the query layer, and the API's own controller and host. If the view
		// needs something it cannot reach, the answer is to add it to the public API, which is the
		// whole point of building the view second.
		files: ["src/view/**/*.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							group: [
								"../core",
								"../core/*",
								"../core/**",
								"../persist",
								"../persist/*",
								"../persist/**",
								"../query",
								"../query/*",
								"../query/**",
								"../api/controller",
								"../api/host",
								"../plugin/*",
								"../plugin/**",
								// ONE LEVEL DEEPER TOO. The `files` glob above admits src/view/anything/x.ts,
								// but the patterns above are written for src/view/x.ts depth — a file one
								// directory down reaches the kernel as `../../core`, which matched nothing,
								// so the fence had a door in it exactly where a growing view would walk.
								// Found by the stage-B recon; closed before the first subdirectory existed.
								"../../core",
								"../../core/*",
								"../../core/**",
								"../../persist",
								"../../persist/*",
								"../../persist/**",
								"../../query",
								"../../query/*",
								"../../query/**",
								"../../api/controller",
								"../../api/host",
								"../../plugin/*",
								"../../plugin/**",
							],
							message:
								"The view consumes Geb ONLY through the public API (src/api/types, src/api/errors) — that is the phase-5 dogfooding gate. If something is missing, add it to the API.",
						},
					],
				},
			],
		},
	},
	{
		// Scripts and tests are Bun programs: console output and node: imports are the job.
		files: ["test/**/*.ts", "scripts/**/*.ts"],
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-non-null-assertion": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-return": "off",
			"@typescript-eslint/no-unsafe-argument": "off",
		},
	},
);
