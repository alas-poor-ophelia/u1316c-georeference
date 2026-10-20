/**
 * The coverage query: which georeferenced maps cover a coordinate, and which notes land on a map.
 *
 * This is the payoff the whole design is arranged around — one note for Eboracum appearing on
 * every map that covers York — and it is why coordinates tag to a coordinate reference system
 * rather than to a map file. Keying them per-map would mean N entries for N maps of one region,
 * which is precisely the thing being bought here.
 *
 * The three extent rules are not implemented again: `toPixel` already applies all of them. It
 * carries the image corners into world space (coverage is what the map PICTURES, not what its
 * control points happen to span), refuses a point whose round trip does not close (so a folded
 * polynomial cannot map a far coordinate to a pixel inside a map of Britain), and marks a point
 * outside the control-point hull as extrapolated rather than refusing it.
 *
 * Those are two distinct layers and they reject different things: validity says the transform is
 * meaningless there, bounds says the map does not picture it. A test that only ever exercises the
 * second one is not testing the first — which is exactly what happened here until review proved
 * it by deleting the validity gate and watching every test still pass.
 */
import { toPixel } from "../core/fit";
import { EARTH } from "../core/crs";
import type { Coverage, LoadedGeoref, Pin, WorldIndex } from "./types";

function place(g: LoadedGeoref, lat: number, lng: number): Coverage | null {
	const px = toPixel(g.fit, lat, lng, g.size);
	// null means the transform is not meaningful there; outside the image means the map does not
	// picture it. Both are "not covered", for different reasons.
	if (px === null || !px.inBounds) return null;
	return {
		georefId: g.record.id,
		notePath: g.notePath,
		x: px.x,
		y: px.y,
		extrapolated: px.extrapolated,
	};
}

/**
 * Every map that covers this coordinate.
 *
 * A linear scan, and correct at this scale: measured at 0.06 ms across twenty maps. Calling this
 * "the core data structure" in the design doc overstated it — the index is a list, and a spatial
 * index would be premature until something measures otherwise.
 */
export function georefsCovering(
	index: WorldIndex,
	lat: number,
	lng: number,
	crs: string = EARTH.id,
): Coverage[] {
	const out: Coverage[] = [];
	for (const g of index.georefs) {
		// A coordinate in one system says nothing about a map georeferenced in another. This is
		// what WILL let an Earth map and a Faerun map coexist in one vault — but the registry
		// holds only `earth` today, so a second world is not yet reachable through a place note:
		// `readFeature` refuses an unregistered crs. What this guard does now is keep a map whose
		// crs is misspelled from answering Earth queries.
		if (g.record.crs !== crs) continue;
		const c = place(g, lat, lng);
		if (c !== null) out.push(c);
	}
	return out;
}

/**
 * Every place note that lands on this map, or `null` if no such map is LOADED.
 *
 * The null is the whole point of the signature. Returning `[]` for an id that is not in the index
 * made "this map was rejected — a duplicate id, degenerate control points — and has no pins"
 * indistinguishable from "this map loaded fine and has no pins". A caller rendering an empty
 * pin layer would tell the user their map was empty when in fact it never loaded, which is the
 * silent failure this layer exists to prevent. On `null`, look the id up in `index.rejected` for
 * the reason.
 *
 * `find` on the id is safe because `buildIndex` rejects a duplicate id rather than loading both:
 * otherwise the second note would be permanently unreachable through this function while still
 * appearing in `georefsCovering` under the same id.
 */
export function featuresIn(index: WorldIndex, georefId: string): Pin[] | null {
	const g = index.georefs.find((x) => x.record.id === georefId);
	if (g === undefined) return null;

	const out: Pin[] = [];
	for (const feature of index.features) {
		// Reachable today through a MISSPELLED map, not through a second world: a georeference
		// with `geb-crs: "erath"` loads (reported, but loaded), so its crs really can differ from
		// every feature's. Without this filter that map would pin every Earth feature through a
		// transform that means nothing for them.
		if (feature.crs !== g.record.crs) continue;
		const c = place(g, feature.lat, feature.lng);
		if (c !== null) out.push({ ...c, feature });
	}
	return out;
}
