# Geb API (API 1)

Geb georeferences a map image inside Obsidian: you place control points saying "this pixel is
that place", and Geb can then convert between pixels and world coordinates on that image.

**This is a georeferencing and coverage API, not a map renderer.** It gives you numbers and
records. It draws nothing, it owns no view, and it does not do routing, distance or projection
maths beyond converting between an image and a coordinate system. `distance` is deliberately
absent: a correct implementation is geodesic, and that ships with the flattening work or not at
all.

Everything below is tagged with the API version that introduced it. Types live in
[`types/geb.d.ts`](types/geb.d.ts) — a standalone, dependency-free file you can copy into your
own plugin.

## Acquiring it

```ts
const geb = app.plugins.plugins["geb"]?.api;
```

`api` exists from the moment Geb loads, but **`api.ready` is false until Obsidian has finished
indexing the vault**, and every vault-backed method throws `geb-not-ready` until then. Wait for
the workspace event:

```ts
this.registerEvent(this.app.workspace.on("geb:ready", () => { /* re-acquire and query */ }));
this.registerEvent(this.app.workspace.on("geb:unload", () => { /* drop your reference */ }));
```

Why it refuses rather than answering: before the metadata cache resolves, the vault scan sees a
partial cache and would report an empty vault with no problems — indistinguishable from a vault
that genuinely has no maps. An empty answer there is a confident lie, so the query refuses.

After unload every method throws `geb-unloaded`. Re-acquire on `geb:ready`; do not cache the
object across a reload.

## Errors

Errors are `Error` objects with a `code` property, so you can branch without matching on prose.

<!-- geb:error-codes -->
| code | when |
|---|---|
| `geb-unloaded` | The plugin has been unloaded. |
| `geb-not-ready` | The vault has not finished indexing. |
| `geb-no-such-georef` | No loaded georeference has that id. If a note claims it but could not be used, the message says why. |
| `geb-no-such-point` | No control point at that index. |
| `geb-no-such-image` | The image link does not resolve, so its bytes cannot be read. |
| `geb-degenerate-fit` | Control points that cannot be fitted — collinear, or coincident. |
| `geb-too-few-points` | Fewer points than the model needs at all. |
| `geb-unknown-crs` | Not a coordinate system in the registry. |
| `geb-duplicate-id` | Another note already claims that id. |
| `geb-note-exists` | The note path is already taken. A create never overwrites. |
| `geb-lossy-record` | The record loaded with data *dropped*, so writing it back would delete what you need to fix it. |
| `geb-bad-argument` | The arguments are the wrong shape. |
| `geb-unknown-calendar` | No time adapter is registered under that calendar id. |
| `geb-bad-adapter` | The object handed to `registerTimeAdapter` is not an adapter. |
<!-- /geb:error-codes -->

## Lifecycle and identity

<!-- geb:methods -->
| member | kind | notes |
|---|---|---|
| `version` | value | Geb's own version, from the manifest. *(API 1)* |
| `apiVersion` | value | `1`. *(API 1)* |
| `ready` | value | False until the vault is indexed, false again after unload. *(API 1)* |
| `generation` | value | Monotonic; moves whenever Geb's view of the world may have changed. *(API 1)* |
| `minPoints` | value | Per model, the fewest control points it can be fitted from at all. *(API 1)* |
| `recommendedPoints` | value | Per model, the count below which the fit's residuals carry no information. *(API 1)* |
| `listCrs` | method | Every known coordinate system. *(API 1)* |
| `getCrs` | method | One by id, or `null`. *(API 1)* |
| `listGeorefs` | method | Every loaded map, summarised. *(API 1)* |
| `getGeoref` | method | One by id. `null` if nothing claims it; **throws with the reason** if a note claims it but it could not be used. *(API 1)* |
| `getImageInfo` | method | Resolved path, natural size, byte length, hash, staleness. *(API 1)* |
| `getFit` | method | Model, control points, hull, diagnostics. *(API 1)* |
| `previewFit` | method | Fit **caller-supplied** points with no vault involved. Returns a result, never throws on bad points. *(API 1)* |
| `toPixel` | method | World to pixel on one map, or `null` where the transform is meaningless. *(API 1)* |
| `toLatLng` | method | Pixel to world, or `null`. *(API 1)* |
| `georefsCovering` | method | Every map that covers a coordinate. *(API 1)* |
| `listFeatures` | method | Every place note carrying coordinates. *(API 1)* |
| `featuresIn` | method | Every place note landing on one map, optionally only those present `at` a day on the shared time line. `null` means no such **loaded** map. *(API 1)* |
| `registerTimeAdapter` | method | The one registry. Returns an unregister function. See **Time**. *(API 1)* |
| `listTimeAdapters` | method | Every registered adapter, built-in first. *(API 1)* |
| `toDay` | method | Date text to a day on the shared line under a calendar, or `null`. *(API 1)* |
| `fromDay` | method | A day on the shared line to text under a calendar. *(API 1)* |
| `listProblems` | method | Everything Geb noticed and did not act on. *(API 1)* |
| `listRejected` | method | Every georeference that could not be used, and why. *(API 1)* |
| `createGeoref` | method | Creates the note. Returns the record **as parsed back from what was written**. *(API 1)* |
| `updateGeoref` | method | Patches crs, model, lambda or points. *(API 1)* |
| `deleteGeoref` | method | Sends the note to the user's trash, recoverably. *(API 1)* |
| `addPoint` | method | Appends a control point. *(API 1)* |
| `updatePoint` | method | Replaces the point at an index. *(API 1)* |
| `removePoint` | method | Drops the point at an index. Refused if it would leave too few to fit. *(API 1)* |
| `on` | method | Subscribe to `ready` or `unload`. Returns an unsubscribe that runs at most once. *(API 1)* |
<!-- /geb:methods -->

## Events

<!-- geb:events -->
| event | fires when |
|---|---|
| `ready` | The vault is indexed and the API is usable. |
| `unload` | Geb is going away. Drop your reference. |
| `georefs-changed` | The set of usable maps moved — one appeared, vanished, or crossed between loaded and **rejected**. |
| `fit-changed` | An existing map's transform moved, so pin positions must be recomputed. |
| `features-changed` | A place note's coordinates or fields moved. |
<!-- /geb:events -->

Every payload is frozen and carries `{ type, generation, paths }`. **`paths` names the notes that
actually moved**, so you can re-read one map rather than re-enumerating the vault; it is empty for
`ready` and `unload`, and empty when the originating signal did not say where.

A consumer watching only `fit-changed` will never learn that a map became unusable. That is what
`georefs-changed` is for, and why it fires on a rejection as well as on a disappearance.

**An edit that changes nothing fires nothing.** Obsidian's `changed` event fires on body edits with
identical frontmatter, so Geb fingerprints every note's georeference and feature content and only
emits where a fingerprint actually moved. Typing in a map note does not wake you.

## The consistency contract

Read this once; it explains two behaviours that look like bugs.

**The index mirrors Obsidian's metadata cache, not the disk.** Everything Geb reads comes from
`metadataCache`, so Geb is exactly as current as Obsidian is.

**A query is never stale, but two queries may straddle a change.** Every query returns a snapshot
built synchronously — if the vault moved since the last one, it rebuilds before answering, so no
single call can observe a half-updated world. Two separate calls can land either side of a
rebuild: `getGeoref(id)` can succeed and `featuresIn(id)` then return `null` for the same id.
`generation` is how you detect that. It moves when a rebuild found something different and when
Geb writes, and it does **not** move for a rebuild that changed nothing — so it is a safe "may I
keep what I have" check.

**For a moment after your own write, the index still describes the previous state.** This is
deliberate. See below.

## Two things that will surprise you, and why

**`previewFit` is how you build interactively.** It fits points you hand it, with no vault
involved and no `ready` gate, and it returns a discriminated result rather than throwing — so a
view placing its second control point does not need a try/catch per click. Hold your in-progress
points yourself, call `previewFit` as the user places them, and commit once with `createGeoref`.
Persisting every placement instead means a disk write, a metadata reparse and a full refit per
click, and on a large spline that refit is measured in hundreds of milliseconds. Geb's own editor
is built exactly this way, through this surface and nothing else. Two values help it, and will
help you: `minPoints[model]` is where `previewFit` starts succeeding, and `recommendedPoints[model]`
is where its residuals start meaning anything — an affine fit over exactly three points
reproduces them whatever the coordinates say, so a residual shown below that count is a
flattering zero, not a measurement.

**Every write returns the record as parsed back from what was written.** Not the input you passed,
and not a re-read. Geb reads through Obsidian's metadata cache and writes through its frontmatter
processor, and nothing orders those two against each other — so a re-read immediately after a
write can return the *pre-write* state. Use the returned record; do not call `getGeoref` to see
what your own write did.

For the same reason, **a write does not invalidate the index**. Only the vault's own change
notifications do. If writing marked the index dirty, the next query would rebuild from a cache
still holding the pre-write frontmatter and publish that as current — deterministically, on the
first write a UI makes. So the index keeps describing the previous state until Obsidian says
otherwise, and then the matching change event fires.

**The model kinds** are `affine`, `mercator`, `polynomial2` and `tps`. `mercator` is an affine fitted
in Web-Mercator-projected coordinates, which fits a Mercator-projected source map exactly; it needs 3
points (4 recommended), refuses control points beyond 85.05 degrees of latitude, and reports its
residuals in the projected plane, not in raw latitude and longitude.

## A worked example

Pinned by a test, so it cannot drift from the code:

<!-- geb:example -->
```ts
// A vault with one map (id "britain-5c", an 8-point thin-plate spline) and one place note.
api.listGeorefs();
```

```json
[
  {
    "id": "britain-5c",
    "notePath": "maps/britain-5c.md",
    "crs": "earth",
    "model": "tps",
    "pointCount": 8
  }
]
```
<!-- /geb:example -->

## Time

**One shared line, whole days, day 0 = 1970-01-01 in the proleptic Gregorian calendar** — the
same scalar Seshat uses, bounded to ±10,000,000 days. Every adapter maps onto this line and none
defines its own, which is what makes a date under one calendar comparable with a date under
another: `toDay("1", "myplugin:auc")` and `toDay("-752")` are the same number.

**Date fields stay raw text.** A place note carries `geb-from`, `geb-to` and an optional
`geb-calendar`; the index stores exactly what was written, and an adapter reads it when a query
asks. The built-in adapter, id `gregorian`, reads a plain signed **year** (astronomical: year 0
is 1 BC, -1 is 2 BC) — so a plain integer stays filterable in Dataview. Years from -25410 to
29349 fit on the line; beyond that a year is refused, not clamped.

**A `from` is the first day its text names and a `to` is the last.** `from: 71, to: 866` runs
from 71-01-01 through 866-12-31, which is what someone who writes years means. An adapter gives
the first day from `parse` and may give the last from an optional `last`; without `last`, a `to`
ends on the day `parse` gives, which is right for text naming a single day.

**Missing bounds are explicit.** No `geb-from` is negative infinity, no `geb-to` is positive
infinity, and a feature with neither is always present. `featuresIn(id, { at })` keeps a feature
when `from <= at && at <= to`, inclusive at both ends. `at` is a day on the line; turn text into
one with `toDay` first.

**A bound that cannot be read does not hide the feature.** An unknown calendar, text the adapter
refuses, an adapter that throws, or an adapter that answers with something that is not a whole
day on the line: each makes that side unbounded and adds a `bad-date` problem to `listProblems`
naming the note — a pin vanishing because of a typo, with nothing saying so, is the silence this
plugin forbids. The one span that reads cleanly and still hides its pin is `from` after `to`:
both bounds were understood and together they say "never"; that is honoured, and reported. Date
problems are found at query time, since adapters come and go.

**Registering an adapter** returns an unregister function that runs at most once and removes only
what it registered. Ids are namespaced strings with no whitespace; `gregorian` is taken. The
registry keeps its own record of what you registered — changing your object's `id` afterwards
changes nothing. It is cleared on unload, so re-register on `geb:ready`. Registering fires no
event: re-query after you register. `toDay` and `fromDay` throw `geb-bad-adapter` when the
adapter you named is broken; queries never do.

## Not in API 1

- `toPixelBatch` / `toLatLngBatch` — deferred deliberately, not forgotten. A `Float64Array` has
  nowhere to put "the transform is meaningless here" or "this point is extrapolated", so the
  validity and hull gating has to be designed into the return shape before the function exists.
  Adding it thinly would let a batch consumer bypass both.
- Time-slider chrome — the filter exists; the control over it does not.
