import { Plugin } from "obsidian";

/**
 * The one place the plugin's display name lives. Wadjet scatters its display name
 * across seven call sites while its id says something else; Geb does not repeat that.
 */
export const DISPLAY_NAME = "U+1316C Georeference";

export default class GebPlugin extends Plugin {
	override onload(): void {
		// Phase 0 scaffold. The kernel lands in src/core and is wired here in phase 4.
	}

	override onunload(): void {
		// Nothing registered yet.
	}
}
