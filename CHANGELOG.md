# Changelog

## 0.1.0 (beta)

The first release.

**Georeferencing.** Place control points on any image in the vault and save them to a georeference note that Geb creates beside the image. Four transform models: affine, a Mercator affine, a second-order polynomial and a thin-plate spline. A fit report with the affine RMS, the largest error, leave-one-out errors and the share of the image your points span. A trusted area drawn around the control points; pins outside it are marked as extrapolated. Control points can be moved by dragging, edited and deleted with undo.

**Pins.** Every note with a coordinate in its frontmatter appears on every map that covers it. Coordinates are read from `lat`/`lng`, `latitude`/`longitude`, or a `location` pair, with decimal commas and degree-minute-second text accepted in the point dialog. Problems are reported, never swallowed.

**Reference lines.** GeoJSON files in a vault folder are drawn through the fit, so drift is visible while points are placed. A command downloads Natural Earth's 1:10 million coastline into that folder after confirmation.

**Ways in.** Right-click an image, the map icon on an open image, a ribbon icon listing every map, an Open map action on georeference notes, and command-palette entries.

**Settings.** Reference folder, coastline download, reference lines on by default, default transform model, and a folder for new georeference notes.

**Time.** Place notes may carry `geb-from`, `geb-to` and `geb-calendar`; a query can ask for the notes present at a moment. Other calendars register an adapter through the API. No slider in the view yet.

**Robustness.** Rename or move an image and the note's link follows; an image moved while Obsidian was closed is found again by its bytes; a changed image is reported as changed. Nothing is written to the vault until the first Save, and the plugin never writes to your own notes.

**Public API.** `app.plugins.plugins.geb.api` for other plugins, documented in `API.md`, with typed errors and a `geb:ready` event.

### Known limits in this beta

- Only the Earth coordinate system exists; a map that is not of Earth has nothing to orient on.
- One fit per image; no insets.
- No antimeridian handling: a map that crosses 180° must use one continuous longitude range.
- No time slider and no problems panel in the view; both are API-only.
- A map keeps its own reference-lines toggle once you have changed it, so the "show by default" setting applies to maps you have not touched.

### What to report

Any pin that lands off its feature with the fit report looking healthy; any note with a coordinate that does not appear and is not listed in `listProblems`; anything the plugin writes that you did not ask for. Issues go to [the repository](https://github.com/alas-poor-ophelia/u1316c-georeference/issues).
