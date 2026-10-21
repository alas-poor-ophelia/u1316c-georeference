/**
 * Shared fixture for the view-shell tests: a vault with one map and three place notes, the real
 * `ApiController` over it, and a recording `Surface` in place of elements.
 *
 * A module rather than a block at the top of one test file because two files drive the shell —
 * the behaviour suite and the review-driven suite — and a fixture copied between them drifts.
 */
import type { ApiController } from "../src/api/controller";
import { hashBytes } from "../src/persist/identity";
import { toFrontmatter } from "../src/persist/serialize";
import type { Georeference } from "../src/persist/types";
import { MapShell, type Frame, type Surface } from "../src/view/shell";
import type { FakeVault } from "./fake-vault";
import { CLEAN, IMAGE } from "./fixtures";

export const BYTES = new Uint8Array([9, 8, 7, 6]).buffer;
export const ID = "britain-5c";
export const NOTE = `maps/${ID}.md`;
export const CONTAINER = { width: 800, height: 600 };

/** York, interior to the hull; London; and Orkney, far outside it, so one pin is extrapolated. */
export const PLACES = {
	"places/Eboracum.md": { lat: 53.9591, lng: -1.0815 },
	"places/Londinium.md": { lat: 51.5074, lng: -0.1278 },
	"places/Orkney.md": { lat: 59.0, lng: -3.0 },
} as const;

/** Three collinear points: a note holding these is REJECTED with a reason. */
export const COLLINEAR = [
	{ px: 0, py: 0, lat: 0, lng: 0 },
	{ px: 10, py: 10, lat: 1, lng: 1 },
	{ px: 20, py: 20, lat: 2, lng: 2 },
];

export class Recorder implements Surface {
	frames: Frame[] = [];
	messages: string[] = [];
	opened: string[] = [];
	sizeValue = { ...CONTAINER };
	size(): { width: number; height: number } {
		return this.sizeValue;
	}
	imageSrc(path: string): string {
		return `res:${path}`;
	}
	paint(frame: Frame): void {
		this.frames.push(frame);
	}
	message(text: string): void {
		this.messages.push(text);
	}
	openNote(path: string): void {
		this.opened.push(path);
	}
	get last(): Frame {
		const f = this.frames[this.frames.length - 1];
		if (f === undefined) throw new Error("nothing painted");
		return f;
	}
	get lastMessage(): string {
		const m = this.messages[this.messages.length - 1];
		if (m === undefined) throw new Error("no message");
		return m;
	}
}

export const georef = (id = ID): Georeference => ({
	id,
	imageLink: `[[${id}.png]]`,
	image: { width: IMAGE.width, height: IMAGE.height, byteLength: BYTES.byteLength, hash: hashBytes(BYTES) },
	crs: "earth",
	fits: [{ bounds: null, transform: { model: "tps" }, points: CLEAN.map((p) => ({ ...p })) }],
});

/** The standard vault: the map, its image, and the three places. */
export function seedVault(v: FakeVault): void {
	v.addFile(`${ID}.png`, BYTES);
	v.addNote(NOTE, toFrontmatter(georef()));
	for (const [path, at] of Object.entries(PLACES)) v.addNote(path, at);
}

/** A shell opened on a READY API, which is the ordinary case. */
export function openShell(c: ApiController, s: Surface, id = ID): MapShell {
	c.markReady();
	const shell = new MapShell(c.api, id, s);
	shell.open();
	return shell;
}

/** Model the vault notification Obsidian's metadata cache would send for `path`, then flush. */
export function vaultChanged(v: FakeVault, c: ApiController, path: string): void {
	v.settleCache();
	c.host.invalidate(path);
	c.flush();
}
