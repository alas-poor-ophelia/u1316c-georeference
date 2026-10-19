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
		// src/persist holds the same property for a harder case: it is ABOUT the vault, and still
		// never imports it. Everything it needs is behind VaultPort, which the plugin layer
		// implements and the tests fake — so rename behaviour is testable without an app.
		files: ["src/persist/**/*.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{ patterns: [{ group: ["obsidian", "../plugin/*", "../plugin/**"], message: "src/persist reaches the vault only through VaultPort." }] },
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
