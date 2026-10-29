# U+1316C Georeference (Geb)

Pin your notes to a map image inside Obsidian. The image never changes.

You place a few control points that say "this pixel is this latitude and longitude," Geb fits a transform, and every note in your vault that carries a coordinate lands on the image as a pin. Geb puts a coordinate system over your picture; it is not a basemap.

## What Geb is not

Read this first. It is the fastest way to know whether Geb is the tool you want.

- **It does not warp or resample your image.** Your map is a source, not a basemap. If you want a historical map rubber-sheeted onto a true projection, Geb is the wrong tool; that destroys the thing you are reading.
- **It makes no network requests on its own.** No basemap tiles, no map services, no telemetry. The one download it can make is a public-domain coastline for checking a fit. It happens only when you ask, after a dialog names the source, the size and the destination.
- **It does not download gazetteers.** No Pleiades, no GeoNames. Geb reads notes; turn a gazetteer into notes with a script.
- **It does not create or edit your notes.** Geb writes only to its own georeference notes.
- **It does no GIS analysis.** No buffers, overlays or topology. That is QGIS.
- **It handles points only.** No lines, no polygons.
- **It is not a survey instrument.** Geb approximates, and shows you by how much.
- **It has no calendar of its own.** Dates go through a time adapter, a small plug-in that reads the dates of one calendar. Plain Gregorian years work out of the box.
- **It never asks what area your map covers.** Coverage is derived from the control points you place.

## How it works

Three kinds of file take part. None of them is special to Obsidian.

- **The image.** Any PNG, JPEG, GIF, WebP, BMP, SVG or AVIF already in your vault. Geb never changes it.
- **The georeference note.** A Markdown note Geb creates when you first save a map. Its frontmatter names the image and holds the control points. You can read it, move it, rename it and version it like any other note. Delete it and the map is gone; the image is untouched.
- **Place notes.** Your own notes with a coordinate in their frontmatter. Every one of them appears as a pin on every map that covers it. Geb reads them; it never writes to them.

## Installing the beta

Copy `main.js`, `manifest.json` and `styles.css` from the release into `<your vault>/.obsidian/plugins/geb/`, then enable **U+1316C Georeference** under Settings → Community plugins. Obsidian 1.13 or later, desktop and mobile.

## Your first map

1. **Start a map.** Right-click an image in the file explorer and choose **Georeference this image**. The same action is on the map icon in an open image's header, and in the command palette while an image is active.
2. **Name the map.** The dialog asks for a georeference ID, prefilled from the image's name, and the note path, prefilled beside the image. The ID is any text, unique in the vault; other plugins refer to the map by it. Press **Place points**. Nothing is written yet.
3. **Place three or more control points.** Tap or click a spot you can identify, such as a cape, a river mouth, a crossroads or the end of a wall. A dialog opens with the pixel filled in. Paste the spot's coordinate into the Latitude field as `lat, lng` and both fields fill, or type the two values; decimal degrees with a point or a comma, or degrees-minutes-seconds such as `51°30'26″N`, are all read. Coordinates come from a web map (right-click a place in Google Maps or OpenStreetMap and copy the pair), from Wikipedia, or from the map's own printed grid. If a place note already carries the coordinate, press **Pick…** and choose it.
4. **Spread them out.** Four points at the corners beat ten along one coast. The dashed outline joining your points is the trusted area: inside it the fit is interpolated, outside it error grows with distance.
5. **Check before saving.** As soon as three points are placed, Geb draws the latitude and longitude grid through the fit. If the grid bends where the map does not, a coordinate is likely mistyped. If the vault holds reference lines, the **Reference** button draws them too. **Details** opens the fit report.
6. **Save.** The georeference note is written and the map reloads from it. Your place notes land as pins. From now on **Edit** opens the control points for changes; press it again to leave. If you would lose unsaved work, Geb asks first.

Pan by dragging, zoom with the wheel or a pinch, **Fit** to see the whole image. **Open maps** on the ribbon lists every map in the vault; a georeference note's header gains an **Open map** action.

## Place notes

Geb reads a coordinate from the first of these forms it finds, in this order. One form is enough; the block shows them all.

<!-- geb:readme-place-keys -->
```yaml
lat: 53.9591            # Geb's own form: two plain decimals
lng: -1.0815
long: -1.0815           # read in place of lng
latitude: 53.9591       # the long spellings
longitude: -1.0815
location: [53.9591, -1.0815]   # the Leaflet and Map View convention, a list or "lat, lng"
crs: earth              # optional; only `earth` exists today
geb-uncertainty: 5000   # optional radius in meters, drawn as a ring around the pin
geb-certainty: disputed # optional: exact | approximate | disputed
geb-from: 71            # optional date text; a plain year under the default adapter
geb-to: 866
geb-calendar: gregorian # optional; names the adapter that reads the two above
```
<!-- /geb:readme-place-keys -->

A decimal comma is read (`51,5074`), and so is a `location` written as text. A `location` that could be either one number with a decimal comma or two coordinates is reported rather than guessed. A note with a coordinate problem is listed by the API's `listProblems`; a pin never vanishes silently. The view has no problems panel yet, so the list is reachable through the API or the developer console.

## Reading the fit

| Model | Needs | Better with | What it does |
|---|---|---|---|
| Affine | 3 points | 4 | Stretch, rotate and shear. Cannot bend. Suits a few points or a map drawn in one consistent projection. |
| Mercator (affine) | 3 points | 4 | An affine fitted after projecting coordinates the way web map tiles and modern atlases are drawn. Exact on a Mercator base, where a flat affine drifts. Points beyond 85° of latitude, north or south, are refused. |
| Polynomial (2nd order) | 6 points | 8 | Gentle curvature for maps that warp smoothly. Barely determined at 6 or 7. |
| Thin-plate spline | 3 points | 8 | Bends to pass exactly through every point. The default: it matches affine at 3 points and works well from about 6 well-spread points on scanned or hand-drawn maps. |

The status line and the fit report deliberately show the **affine RMS** in image pixels for every model: a spline passes exactly through its points and would read zero even with a mistyped coordinate. A low RMS means your points agree with each other, not that the map is right far from them. An RMS near your own placing precision, a pixel or two, is as good as it gets; what is large depends on the image's resolution. **Leave-one-out** leaves each point out in turn, refits, and reports in image pixels how far that point then lands from where you placed it; one point far above the rest is the one to check. The report also notes when your points fit a Mercator affine several times better than a flat one.

Pins outside the trusted area are drawn dashed and flagged as extrapolated.

## The georeference note

What Geb writes, and all it ever writes:

<!-- geb:readme-georef-keys -->
```yaml
geb-id: britain-5c
geb-image: "[[britain-5c.png]]"
geb-image-size: [622, 718]
geb-image-bytes: 295657
geb-image-hash: fnv1a64:67ea0caba549119d
geb-crs: earth
geb-fits:
  - bounds: null
    transform: { model: tps, lambda: 0 }
    points:
      - { px: 352, py: 364, lat: 54.953, lng: -3.213, label: Bowness-on-Solway }
```
<!-- /geb:readme-georef-keys -->

Change the ID under `geb-id` if you like. Rename or move the image and the link follows. If the image was moved while Obsidian was closed, Geb finds it again by its bytes on the next start and tells you. If the image's content changed, the fit is kept as you saved it and the API reports the image as changed; open the map, check the points still sit on their features, and save again. A note Geb cannot read is reported, never skipped.

## Reference lines and the coastline

Put GeoJSON files in the vault folder `Geb/reference` (or the folder you choose in settings) and their lines are drawn through the fit over every map, so drift is visible while you place points. Coordinates are read as GeoJSON specifies them, longitude and latitude on WGS 84; lines, multi-lines and polygon outlines are drawn, points are ignored. The command **Download Natural Earth coastline** fetches Natural Earth's 1:10 million coastline, public domain and about 10 MB, into that folder after you confirm; the file is parsed before it is written. Reference lines are culled to the map's region and cut where the fit cannot be inverted reliably, far outside the trusted area.

## Settings

- **Reference folder.** Where GeoJSON reference files are read from and the coastline is saved.
- **Natural Earth coastline.** The download, from the settings tab.
- **Show reference lines by default.** For a map whose toggle you have not touched.
- **Default transform model.** What a new map starts with. A saved map keeps its own.
- **Folder for new georeference notes.** Empty means beside the image.

## Time

When a query asks for a moment, a place note with `geb-from` and `geb-to` is on the map only between those dates. Both ends are inclusive; a missing bound is open; a note with neither is always present, and so is every note when no moment is asked for. The built-in adapter reads plain signed years, astronomical style, so year 0 is 1 BC and -1 is 2 BC. Other calendars plug in through the API. There is no time slider in the view yet; the filter is reachable through the API.

## For plugin developers

`app.plugins.plugins.geb.api` converts between pixels and coordinates, lists maps and the notes they cover, and reports every problem it finds. Types ship in `types/geb.d.ts`. See [API.md](API.md).

## Not yet

Multiple fits per image (insets and composite sheets), user-defined coordinate systems and maps that are not of Earth, antimeridian crossings, a time slider, a problems panel in the view, converting many points in one API call, and geodesic distance. The types are shaped for them; the features are not built.

## License

MIT. The Natural Earth coastline is public domain.
