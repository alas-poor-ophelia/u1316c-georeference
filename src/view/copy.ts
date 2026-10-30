/**
 * Every sentence the view and the dialogs show a user, in one place.
 *
 * One module so that a wording change is a one-line change, so that the test for a string tests
 * the string the user sees, and so that a reviewer can read the whole voice of the plugin in a
 * minute. Status-line functions take their numbers at runtime. The model descriptions are prose
 * and name the counts outright, because "Needs {n} points" reads as a form letter; a test holds
 * those sentences against the kernel's `MIN_POINTS` and `RECOMMENDED_POINTS` so they cannot
 * drift apart in silence.
 *
 * Status-line fragments join with " · " (see `format.ts`), so no fragment uses that separator or
 * a dash inside itself.
 */

import type { TransformKind } from "../api/types";

export const COPY = {
	/** Over the map while a new draft has no points. */
	emptyBanner: "Tap or click the map to place your first control point. Nothing is saved until you select Save.",

	/** Status line while the draft has fewer points than the model's minimum. */
	belowMin: (n: number, min: number): string =>
		// At zero the banner over the map already says what to do; the status only counts.
		n === 0 ? `0 of ${min} points` : `${n} of ${min} points, add another to reach ${min}`,
	/** Appended to the point count while below the recommended count. */
	recommendedSuffix: (rec: number): string => `(${rec} recommended)`,
	/** Polynomial at six or seven points. */
	barelyDetermined: (n: number, rec: number): string => `Barely determined at ${n} points, ${rec} or more steadies the fit`,
	/** Shown with any fit, next to the dashed hull. */
	spreadNote: "The dashed outline is the trusted area. Notes outside it are extrapolated.",

	models: {
		title: "Transform models",
		affine: "Stretches, rotates, and shears the image. It cannot bend. Needs 3 points, and 4 is better. Suits a few points or a map drawn in a consistent projection.",
		polynomial2: "Adds gentle curvature for maps that warp smoothly. Needs 6 points. It is barely determined at 6 or 7, so use 8 or more.",
		tps: "Bends to pass exactly through every point. Needs 3 points, where it matches affine. It works well from about 6 well-spread points on scanned or hand-drawn maps.",
		mercator: "An affine fitted after projecting coordinates the way web map tiles and modern atlases draw them. Needs 3 points, and 4 is better. Exact on a Mercator base, where a flat affine drifts. Worse than the spline elsewhere. Its RMS is measured in the projected plane. Control points above 85 degrees of latitude are refused.",
		spread: "Spread matters more than count. Four points spanning the map beat eight along one edge. The dashed outline joins the outermost points. Inside it the fit is trusted. Outside it error grows with distance. In one test, four points along a single wall scored 0.3 px RMS yet placed a distant town 20 px off.",
		rms: "The RMS shows how closely an affine fit matches your points, in image pixels. It is shown for every model on purpose. A spline passes exactly through its points and would read zero even with a mistyped coordinate. A low RMS means your points agree with each other, not that the map is right far from them.",
		sourcesTitle: "Where coordinates come from",
		sources: "Every control point needs the real coordinate of a spot you can see on the image. A web map gives it: right-click a place in Google Maps or OpenStreetMap, copy the pair, and paste it into the Latitude field. Wikipedia gives one for any town, cape or summit. A map that prints its own grid gives the best points of all, at the grid intersections. Choose spots that are points, such as a cape, a river mouth or a crossroads, and spread them to the corners.",
		button: "Which model?",
		tip: "Compare the models and learn about spread and RMS",
		/** Status-line names: short and dash-free, because fragments share one line and may not carry a dash. */
		short: { affine: "Affine", mercator: "Mercator", polynomial2: "Polynomial", tps: "Spline" } as Readonly<Record<TransformKind, string>>,
	},

	report: {
		title: "Fit report",
		button: "Details",
		tip: "Open the full fit report",
		rms: "Affine RMS (px)",
		/** The Mercator model's residual lives in the projected plane, so its label and the status line say so. */
		rmsMercator: "Affine RMS in the Mercator plane (px)",
		planeSuffix: "in Mercator plane",
		worst: "Largest error (px)",
		loo: "Leave-one-out (px)",
		coverage: (pct: number): string => `Control points span ${pct}% of the image`,
		notes: "Notes",
		columns: { point: "Point", pixel: "Pixel (x, y)", coordinate: "Coordinate", error: "Error (px)", loo: "Left out (px)", hull: "On hull" },
		notDiagnostic: "Not diagnostic",
	},

	legend: {
		control: "Control point",
		place: "Place note",
		extrapolated: "Extrapolated",
		hull: "Trusted area (hull)",
	},

	deleted: (label: string): string => `Deleted ${label}.`,
	undo: "Undo",

	discard: {
		title: "Discard changes?",
		saved: "Unsaved changes will be lost. The saved fit stays on the map.",
		fresh: (n: number): string => `This removes all ${n} points. Nothing has been saved, so nothing is deleted from disk.`,
		confirm: "Discard",
		cancel: "Cancel",
	},

	coords: {
		/** Over a NEW point's fields: the first thing a first-time user needs to know. */
		source: "Copy this spot's coordinate from a web map (right-click a place in Google Maps or OpenStreetMap), from Wikipedia, or from the map's own printed grid. A place note that already carries it can be picked below.",
		latHint: "Decimal (51.5074 or 51,5074) or DMS (51°30'26″N), with a sign or N/S. Paste a pair to fill both fields.",
		lngHint: "Decimal (-0.1278 or -0,1278) or DMS (0°7'39″W), with a sign or E/W.",
		unreadable: "Cannot read this coordinate. Try 51.5074, 51,5074 or 51°30'26″N, with a sign or an N/S/E/W letter, not both.",
		wrongAxis: "Wrong hemisphere letter. Latitude takes N or S, longitude E or W.",
		pairFilled: "Filled latitude and longitude from the pasted pair.",
	},

	create: {
		notePathHint: "The georeference note is created here the first time you save. The image stays where it is.",
		idHint: "How Geb and other plugins refer to this map. You can change it later under geb-id in the note's frontmatter.",
	},

	notReady: "Obsidian is still indexing the vault. Try again in a moment.",

	/** The reference overlay: GeoJSON lines from the vault drawn through the fit, and the coastline download. */
	reference: {
		button: "Reference",
		tip: "Toggle reference lines over the map",
		none: "No reference lines cover this map, or it is not a map of Earth",
		problems: "Unreadable reference files",
		folderHint: (folder: string): string => `Put your own GeoJSON files in the vault folder ${folder} to draw them as reference lines.`,
		download: {
			command: "Download Natural Earth coastline",
			title: "Download Natural Earth coastline?",
			body: (path: string): string =>
				`Downloads the Natural Earth 1:10 million coastline from the project's mirror on GitHub. The file is public domain and about 10 MB. It is saved as ${path} in your vault. You can delete it at any time.`,
			confirm: "Download",
			cancel: "Cancel",
			done: (path: string): string => `Coastline reference saved to ${path}`,
			failed: (reason: string): string => `Could not download the coastline: ${reason}`,
			offline: "No network connection. Try again when you are online.",
			exists: (folder: string): string => `The coastline file already exists in ${folder}`,
		},
	},

	/** The settings tab: each row's name and description, in the order the tab shows them. */
	settings: {
		referenceFolder: {
			name: "Reference folder",
			desc: "GeoJSON files in this vault folder are drawn as reference lines over every map. The coastline download is saved here too.",
		},
		coastline: {
			name: "Natural Earth coastline",
			desc: "A public domain coastline, about 10 MB, saved in the reference folder. Shows whether a fit follows the shore.",
			download: "Download",
			downloaded: "Downloaded",
		},
		showReference: {
			name: "Show reference lines by default",
			desc: "Draw reference lines when a map opens. The Reference button still toggles them per map.",
		},
		defaultModel: {
			name: "Default transform model",
			desc: "The model a new map starts with. You can change it per map while editing.",
		},
		newNoteFolder: {
			name: "Folder for new georeference notes",
			desc: "Where the georeference note goes when you georeference an image. Leave empty to create it beside the image.",
		},
		/** One row per role. Each names the built-in keys it comes after, because those win when both are there. */
		placeKeys: {
			heading: "Place note properties",
			roles: {
				lat: { name: "Also read latitude from", desc: "Property names, separated by commas, read after lat." },
				lng: { name: "Also read longitude from", desc: "Property names, separated by commas, read after lng and long." },
				location: { name: "Also read a coordinate pair from", desc: 'Property names, separated by commas, read after location. A list [lat, lng] or "lat, lng".' },
				crs: { name: "Also read the coordinate system from", desc: "Property names, separated by commas, read after crs." },
				uncertainty: { name: "Also read the uncertainty from", desc: "Property names, separated by commas, read after geb-uncertainty." },
				certainty: { name: "Also read the certainty from", desc: "Property names, separated by commas, read after geb-certainty." },
				from: { name: "Also read the start date from", desc: "Property names, separated by commas, read after geb-from." },
				to: { name: "Also read the end date from", desc: "Property names, separated by commas, read after geb-to." },
				calendar: { name: "Also read the calendar from", desc: "Property names, separated by commas, read after geb-calendar." },
			},
		},
	},

	/** The visible ways into a map: the ribbon, a command, and a header action on notes and images. */
	doors: {
		ribbon: "Open maps",
		command: "Open maps",
		placeholder: "Search maps…",
		none: 'No maps yet. Open an image\'s context menu and choose "Georeference this image" to create one.',
		note: "Open map",
		image: "Georeference this image or open its map",
	},

	tips: {
		saveNeed: (n: number): string => (n === 1 ? "Place one more point to save" : `Place ${n} more points to save`),
		saveClean: "Nothing to save",
		editPending: "Edit is available once Obsidian has indexed the saved note.",
		/** The Edit button stays pressed while editing; choosing it again is the way out. */
		editStop: "Stop editing",
		editStopDirty: "Stop editing. You will be asked about unsaved changes.",
	},
} as const;
