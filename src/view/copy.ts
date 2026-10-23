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

export const COPY = {
	/** Over the map while a new draft has no points. */
	emptyBanner: "Click or tap the map to place your first control point. Nothing is saved until you press Save.",

	/** Status line while the draft has fewer points than the model's minimum. */
	belowMin: (n: number, min: number): string =>
		n === 0 ? `0 of ${min} points placed · click the map to add the first` : `${n} of ${min} points placed · add another to reach ${min}`,
	/** Appended to the point count while below the recommended count. */
	recommendedSuffix: (rec: number): string => `(${rec} recommended)`,
	/** Polynomial at six or seven points. */
	barelyDetermined: (n: number, rec: number): string => `Barely determined at ${n} points. ${rec} or more will steady this fit.`,
	/** Shown with any fit, next to the dashed hull. */
	spreadNote: "The dashed outline is the trusted area. Pins outside it are extrapolated.",

	models: {
		title: "Transform models",
		affine: "A flat stretch, rotate and shear. Needs 3 points, and 4 is better. It cannot bend, so it suits a handful of points or a map drawn to a consistent projection.",
		polynomial2: "Adds gentle curvature for maps that warp smoothly. Needs 6 points and is barely determined at 6 or 7, so 8 or more are recommended.",
		tps: "Bends to pass exactly through every point. Needs 3 points, where it matches affine, and shines from about 6 well-spread points on scanned or hand-drawn maps. The default for a new map.",
		mercator: "An affine fitted after projecting coordinates as web map tiles and modern atlases are drawn. Needs 3 points, and 4 is better. Exact on a Mercator base, where a flat affine drifts. Worse than the spline elsewhere. Its RMS is measured in the projected plane, and control points above 85 degrees of latitude are refused.",
		spread: "Spread matters more than count: four points spanning the map beat eight along one edge. The dashed outline joins the outermost points. Inside it the fit is trusted, outside it error grows with distance. In one test, four points along a single wall scored 0.3 px RMS yet placed a distant town 20 px off.",
		rms: "The RMS shows how closely an affine fit matches your points, in image pixels, and it is shown for every model on purpose: a spline passes exactly through its points and would read zero even with a mistyped coordinate. A low RMS means your points agree with each other, not that the map is right far from them.",
		button: "Which model?",
		tip: "Compare the models and learn about spread and RMS",
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
		latHint: "Decimal (51.5074 or 51,5074) or DMS (51°30'26″N), with a sign or N/S. Paste a pair to fill both fields.",
		lngHint: "Decimal (-0.1278 or -0,1278) or DMS (0°7'39″W), with a sign or E/W.",
		unreadable: "Cannot read this coordinate. Try 51.5074, 51,5074 or 51°30'26″N, with a sign or an N/S/E/W letter, not both.",
		wrongAxis: "Wrong hemisphere letter: latitude takes N or S, longitude E or W.",
		pairFilled: "Filled latitude and longitude from the pasted pair.",
	},

	create: {
		notePathHint: "The georeference note is created here on your first Save. The image stays where it is.",
		idHint: "How Geb and other plugins refer to this map. You can change it later under geb-id in the note's frontmatter.",
	},

	notReady: "Obsidian is still indexing the vault. Try again in a moment.",

	/** The reference overlay: GeoJSON lines from the vault drawn through the fit, and the coastline download. */
	reference: {
		button: "Reference",
		tip: "Toggle reference lines over the map",
		none: "No reference lines cover this map, or the map is not of Earth",
		problems: "Unreadable reference files",
		folderHint: "Put your own GeoJSON files in the vault folder Geb/reference to draw them as reference lines.",
		download: {
			command: "Download Natural Earth coastline",
			title: "Download Natural Earth coastline?",
			body: "This downloads the Natural Earth 10 metre coastline from the project's mirror on GitHub. The file is public domain and about 10 MB. It is saved as Geb/reference/coastline-10m.geojson in your vault, and you can delete it at any time.",
			confirm: "Download",
			cancel: "Cancel",
			done: (path: string): string => `Coastline reference saved to ${path}`,
			failed: (reason: string): string => `Could not download the coastline: ${reason}`,
			offline: "No network connection. Try again when you are online.",
			exists: "The coastline file already exists in Geb/reference",
		},
	},

	/** The visible ways into a map: the ribbon, a command, and a header action on notes and images. */
	doors: {
		ribbon: "Open maps",
		command: "Open maps",
		placeholder: "Search maps…",
		none: 'No maps yet. Right-click an image and choose "Georeference this image" to create one.',
		note: "Open map",
		image: "Georeference this image or open its map",
	},

	tips: {
		saveNeed: (n: number): string => (n === 1 ? "Place one more point to save" : `Place ${n} more points to save`),
		saveClean: "Nothing to save",
		editPending: "Edit is available once Obsidian has indexed the saved note.",
	},
} as const;
