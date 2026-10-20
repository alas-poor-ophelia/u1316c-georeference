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
<!-- /geb:error-codes -->

## Lifecycle and identity

<!-- geb:methods -->
| member | kind | notes |
|---|---|---|
| `version` | value | Geb's own version, from the manifest. *(API 1)* |
| `apiVersion` | value | `1`. *(API 1)* |
| `ready` | value | False until the vault is indexed, false again after unload. *(API 1)* |
| `generation` | value | Monotonic; moves whenever Geb's view of the world may have changed. *(API 1)* |
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
| `featuresIn` | method | Every place note landing on one map. `null` means no such **loaded** map. *(API 1)* |
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
click, and on a large spline that refit is measured in hundreds of milliseconds.

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

## Not in API 1

- `toPixelBatch` / `toLatLngBatch` — deferred deliberately, not forgotten. A `Float64Array` has
  nowhere to put "the transform is meaningless here" or "this point is extrapolated", so the
  validity and hull gating has to be designed into the return shape before the function exists.
  Adding it thinly would let a batch consumer bypass both.
- `registerTimeAdapter`, and the `at` filter on `featuresIn` — date fields (`geb-from`, `geb-to`,
  `geb-calendar`) are read and handed to you as **raw text**. Deciding what "450" means belongs to
  a time adapter, which arrives with its own phase.
