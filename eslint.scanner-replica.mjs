// Raw replica of the Obsidian community-plugin store scan: eslint-plugin-obsidianmd's
// `recommended` preset with nothing added and nothing relaxed. `bun run lint:scanner` runs it
// so the store's verdict is known before a release, independent of eslint.config.mjs.
// Mirrors the file of the same name in Wadjet and Windrose.
//
// SCOPE. The store scan does NOT distinguish plugin code from test or harness code: everything
// in the tracked tree is scanned. A sibling plugin was delisted over warnings raised entirely
// inside test and harness modules it had assumed were out of scope, so `lint:scanner` runs over
// src, scripts AND test rather than src alone. Replicating the scan over only the plugin source
// would reproduce the exact blind spot that caused that delisting.
//
// Nothing here relaxes a RULE. The only addition is a `globals` declaration for the Bun scripts,
// which tells eslint what exists at runtime; without it `no-undef` fires on every runtime global,
// which the real scan plainly does not do or no plugin would ever pass.
import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.{ts,tsx}"],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
				ecmaVersion: 2022,
				sourceType: "module",
			},
		},
	},
	{
		// Environment declaration only — see the header.
		files: ["scripts/**/*.ts", "test/**/*.ts"],
		languageOptions: {
			globals: { Bun: "readonly", process: "readonly", console: "readonly" },
		},
	},
	{ ignores: ["node_modules/**", "main.js", "test/live/geb-live/.obsidian/**", "**/*.json", "**/*.mjs", "**/*.cjs"] },
];
