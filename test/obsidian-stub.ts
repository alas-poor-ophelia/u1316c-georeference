/**
 * The one stand-in for the `obsidian` module, which ships types only. Every test file that
 * stubs it uses THIS object: Bun keeps the first stub's export names for the whole run, so two
 * files stubbing it with different names fail whichever runs second.
 *
 * `normalizePath` follows Obsidian's: slashes collapsed, none at either end, "" is "/".
 */
export const OBSIDIAN_STUB = {
	normalizePath: (p: string): string => {
		const out = p.replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, "");
		return out === "" ? "/" : out.normalize("NFC");
	},
	debounce: (fn: () => void): (() => void) & { cancel: () => void } => Object.assign(() => fn(), { cancel: (): void => undefined }),
	Modal: class {},
	PluginSettingTab: class {},
};
