# The map

Code: `web/src/map/` (logic, no React), `web/src/history/` (the explored store), `web/src/rides/` ([rides.md](rides.md)),
`web/src/components/` (map view, inspect panel; the chrome is the planner shell, [planner.md](planner.md)). Tests: `web/test`, `e2e/map.spec.ts`.

## Region data

Nothing about a region is compiled into the app. At start it fetches `<dataUrl>manifest.json`.

- **Data URL**, first match wins: the `?data=` query parameter, the `VITE_KOMPASS_DATA_URL` build
  variable, the default `./data/` (relative to the app, so a sub-path works). Relative URLs resolve
  against the page.
- **Hosting.** Static files, and the host must support HTTP `Range` (PMTiles reads parts of a file).
  `bun run dev` serves `KOMPASS_DATA_DIR` (default `data/build/region`) at `/data/`;
  `bun run serve -- --port 7950 --data <dir>` serves a build plus a data directory (also
  `scripts/static-files.ts`, which streams slices: memory stays flat for a 460 MB file).
- **No data** (404 or an index page) → an empty state; **a broken manifest** → an error naming the
  field. No map is created in either case.

A build directory holds `manifest.json`, the base map and the overlay. The pipeline writes the
manifest; the app validates it (`manifest.ts`):

```json
{ "schemaVersion": 1, "builtAt": "<ISO>", "bounds": [w, s, e, n], "center": [lon, lat],
  "basemap": { "file": "basemap.pmtiles", "maxzoom": 15 },
  "overlay": { "file": "overlay.pmtiles", "layer": "edges", "minzoom": 8, "maxzoom": 14,
    "attributes": [
      { "key": "surface_class", "label": "Surface", "kind": "enum",
        "values": [ { "value": 0, "label": "unknown" }, … ] },
      { "key": "forest", "label": "In forest", "kind": "share", "max": 1 },
      { "key": "grade_max", "label": "Max grade", "kind": "number", "unit": "%", "min": 0, "max": 25 } ] } }
```

- `buildId` ties the files of one build together; `graph` (absent until `kompass compile` ran) lists
  the engine's graph files with their sizes: [graph-format.md](graph-format.md).
- `basemap` may be `null`: the style falls back to a plain background (the e2e fixture has a tiny
  synthetic one; tests also cover `null`).
- Overlay features carry an **integer feature id equal to the edge id** (`feature-state` and the
  inspect panel rely on it) and one integer or float property per attribute. The layer is
  overzoomed past `maxzoom`.
- **Drawing properties** (`overlay.drawing`, a list of keys; absent or empty in overlays built before
  they existed, so the style must work without them): integer properties for drawing only, not
  information layers (so not in `attributes`, no labels). Written only when not 0, so a missing
  property means 0:

  | key | values | meaning |
  |---|---|---|
  | `bridge` | 1 | the edge is on a bridge |
  | `tunnel` | 1 | the edge is in a tunnel |
  | `layer` | -5..5 | OSM `layer`, to order crossings (bridges above, tunnels below) |
  | `service_kind` | 1 parking_aisle, 2 driveway | kind of a `highway=service` edge; other service roads have none |

  Ferries are `highway` = `ferry` (label looked up in the manifest, like every road class), from z8.
  Tracks are in the overlay from **z12** (grade 1 to 3 from **z11**), paths and the rest from z13
  (`MINZOOM` in `pipeline/tiles.py`); `highway`, `tracktype` and `surface_class` are on every
  feature.
- `kind`: `enum` (integer codes with labels), `share` (0..`max`, shown as a percentage) and `number`
  (`min`..`max`, optional `unit`).
- `terrain` may be `null` or absent (the map is drawn flat), and so may its `contours`. The contour
  lines carry `ele` in metres.

## The outdoor style

One style in a light and a dark theme (the system setting), built by `style.ts` from these parts,
bottom to top:

| part | from | code |
|---|---|---|
| land cover and land use, water | Protomaps tiles (`landuse`, `water`) | `basemap.ts` |
| hillshade, contour lines | the manifest's `terrain` | `style.ts` (`terrainLayers`) |
| rivers, buildings | Protomaps tiles | `basemap.ts` |
| band of signed cycle routes (from z9) | overlay | `ways.ts` (`routeLayer`) |
| roads **below z13** | Protomaps tiles | `basemap.ts` (`lowZoomRoads`) |
| roads, tracks and paths **from z13 on** | overlay | `ways.ts` (`wayLayers`) |
| the information band, the explored band (between the ways' rims and their lines) | overlay | `style.ts`, `info.ts` |
| motorways, railways, borders | Protomaps tiles | `basemap.ts` |
| rides | GeoJSON | `style.ts` |
| contour heights, summits, place and road names, POIs | Protomaps tiles, contours | `basemap.ts`, `@protomaps/basemaps` |

- **Who draws the roads.** Never both. Below z13 the overlay does not carry every class, so the base
  tiles draw the roads (and tracks from z12, as a hint). From z13 on the overlay has every edge and
  draws them all; the base tiles' road layers stop there (`WAYS_MINZOOM`). Both use the same colours
  and meet at the same widths. Motorways and railways are not in the overlay (not rideable): the base
  tiles draw them at every zoom, above the ways. Bridges and tunnels are not told apart.
- **The line vocabulary** (`ways.ts`, top comment): a paved road is a cased band (white to yellow by
  class), a paved track the same but narrow with a brown rim. Everything unpaved is one brown line
  whose dash is its firmness: solid = paved path, long dashes = compacted, short dashes = gravel,
  dots = soft. Firmness comes from `surface_class`, else `tracktype`, else the kind of way (a track
  is taken for gravel, a path for soft); such a guess is drawn in a lighter brown. Width is the kind
  of way. Violet is cycling: separate cycle paths (lines) and signed routes (a soft band under the
  way, wider for higher networks). Grey is private or no bicycle access. Paved paths running along
  a road (`road_near_share` ≥ 60 %: pavements, roadside cycle tracks) show from z15 only.
- The classes are looked up **by enum label** in the manifest (`enumCodes`), never by code. A
  manifest lacking an attribute still gives a valid, simpler style.
- **Dashes** are one layer per pattern with a constant `line-dasharray` (4 line layers), not a
  data-driven dash: that keeps MapLibre on its plain line shader.
- **From `@protomaps/basemaps`** come only the label layers and earth, water and buildings, recoloured
  through a flavour (the tileset's schema version must match the package's major version). Label
  language: the browser's if supported, else English. **Glyphs and sprites are vendored** in
  `web/public/map/` (see [its NOTICE](../web/public/map/NOTICE.md)): no third-party server is contacted
  at run time. Only three font stacks and the Latin glyph ranges (0–511, general punctuation) are
  there; other scripts render without that glyph.

### Where to tune

- Colours of the map, per theme: `carto.ts`, one table. Colours of what lies on top (information
  layers, explored, rides, selection): `palette.ts`. Neither are theme tokens: they are picked
  against the map, not the chrome. The strong hues stay free for the route and the layers.
- Widths: `ROAD_WIDTHS`, `LINE_WIDTHS` (px at z13, 15, 17, 19) and `DASHES` in `ways.ts`; the base
  roads' widths below z13 in `basemap.ts` end where those start.
- Which land use kind gets which fill: `landFills` in `basemap.ts`.
- Relief strength: `hillshadeStrength`, `shade`, `highlight` in `carto.ts`; contour opacity and
  labels in `terrainLayers`.
- Check a change in both themes at z10, z13 and z15–16 on the demo region (AGENTS.md), in a forest,
  a village and a town: what is calm in the hills can be loud in a city, and the other way round.

### Terrain

`terrain.pmtiles` is a `raster-dem` source for MapLibre's `hillshade` layer; `contours.pmtiles` holds
precomputed contour lines (the pipeline thins them by zoom: 100 m from z10, 20 m from z13, 10 m at
z14). Precomputed rather than traced in the browser (`maplibre-contour`): no CPU work on the phone,
no extra worker and dependency, and the pipeline can smooth the surface model first. The hillshade
is the only fragment-heavy layer of the style; a toggle turns the relief off.

## Information on demand

The map is the default view. On top of it the user picks **one information layer** (the layers
control; `?layer=<attribute key>|explored` in the URL), and toggles the relief and the cycle routes
(`?terrain=0`, `?routes=0`). `controller.ts` (`setLayers`) switches only the layers concerned
(filter, colour, zoom range, visibility): no tiles reload.

- **An attribute layer** is a coloured band *under* the lines of the edges worth showing, so the
  map's own vocabulary stays readable on it. What is worth showing is a default per attribute
  (`RULES` in `info.ts`): "Surface" leaves smooth asphalt alone and shows unknown in grey, access
  layers leave the ordinary values out, shares draw from a threshold on ("Forest edge" from 30 %),
  "Max grade" from 6 %. Ordered enums and numbers use a sequential ramp (viridis, trimmed per
  theme), other enums categorical hues (Okabe–Ito) or the rule's own colours. Missing values are not
  drawn. The legend names what is left out. A new attribute works without a rule (every value, or
  every non-zero value).
- **Explored**: a teal band on ridden edges (`feature-state.ridden`); never ridden stays the map.
- **Inspect**: tapping a way opens the panel with every attribute (from z13, where the ways are
  drawn; a 14 px box around the tap, the nearest edge wins). In the planner a tap adds a waypoint, so
  inspecting is a mode ("Inspect a way" in Map & rides, with an information layer on);
  `RegionMap.setPicking` switches the map's own tap handling.

## Explored map

`ExploredStore` (`history/explored-store.ts`): `setRidden(ids | Map<id, {count, lastRidden}>)`
replaces the set, `clear()`, `subscribe()`. The ride library ([rides.md](rides.md)) fills it from its saved matches
(`RidesState.attachExplored`); the map reads it. `ExploredLayer` mirrors it into `feature-state` (`ridden`, `count`)
in chunks of 5000 ids, yielding to the main thread between chunks, and applies only the difference (an edge
whose count is unchanged is left alone, so a refold while rides are still being matched is cheap).
The band has three calm steps of intensity by `count`: ridden once (opacity 0.5), 2 to 4 times (0.7), 5 or
more (0.9). Recency (`lastRidden`) is in the store but not drawn: the routing's novelty preferences use it.
MapLibre keeps feature state per source and applies it to tiles as they load, so ids that are not on
screen yet are fine; a new style (theme change) drops it, hence `reapply()` after every `style.load`.

Dev hooks: `?fakeRidden=<n>` marks up to `n` edges of the loaded tiles as ridden; `?dev` (or any dev
build) exposes `window.__kompass` (`map`, `store`, …) and shows "Fake some / Clear" in the explored
card. The e2e uses them.

## Fixture

`e2e/fixtures/region/` is a committed synthetic region (60 edges on a grid around 0°N 0°E, open
sea in reality) in exactly this format, rebuilt by `e2e/fixtures/build-region.ts` from the GeoJSON in
`e2e/fixtures/src/`: the map tiles with tippecanoe, `edges.parquet` with the pipeline's writer
(`edges-parquet.py`) and the engine's graph with `kompass compile`. As in a real build, the edge ids
are the row numbers of the Hilbert-sorted edges (0..59), the same in the overlay, the parquet and the
graph. Its edges use the pipeline's enum tables and cycle through every line style of the map;
its relief is invented hills, built by `e2e/fixtures/build-terrain.py` with the pipeline's terrain stage.
