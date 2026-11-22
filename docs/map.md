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

**Theme.** `lib/theme.ts` holds a three-way preference, system / light / dark, in localStorage
(`kompass.theme`; absent = system). `index.html` applies it to `<html class="dark">` before the first
paint (same key and rule), and "system" follows the OS setting live. `useTheme()` returns the theme in
force; the chrome reads the `dark` class and the map is given that theme, so a switch swaps the style
in place (camera, layers and the route survive via `reapply()`). The control is "Appearance" at the
bottom of the Map & rides panel.

One style in a light and a dark theme (design rounds [2](design/map-round-2.md) and
[3](design/map-round-3.md); light is the product, dark is kept working), with a few **map style
options** (below). Built by `style.ts` from these parts, bottom to top:

| part | from | code |
|---|---|---|
| land cover and land use | Protomaps tiles (`landuse`) | `basemap.ts` |
| hillshade, contour lines | the manifest's `terrain` | `style.ts` (`terrainLayers`) |
| lakes and the sea (above the relief: flat water is not shaded and carries no contours) | Protomaps tiles | `basemap.ts` |
| rivers, canals, streams (from z13), ditches and drains (from z15), buildings | Protomaps tiles | `basemap.ts` (`waterways`, `WATERWAY_WIDTHS`) |
| band of signed cycle routes (from z9) | overlay | `ways.ts` (`routeLayer`) |
| the ways' casings and dashed rims, the cycle paths' halo | overlay | `ways.ts` (`wayLayers().under`) |
| the information band, the explored band, the cost layer | overlay | `style.ts`, `info.ts`, `cost.ts` |
| the ways' lines and fills, bridge rails, ferries | overlay | `ways.ts` (`wayLayers().over`) |
| motorways, railways, borders | Protomaps tiles | `basemap.ts` |
| rides | GeoJSON | `style.ts` |
| contour heights, summits, place and road names, POIs | Protomaps tiles, contours | `basemap.ts`, `@protomaps/basemaps` |

### The line system

The ground is a straw tone and the forest clearly green, apart in hue, so every band is the lightest
thing on the map. Roads keep the familiar tiers. **Every track is one cased band** at one width,
whatever its grade, so a track reads as one continuous line: its **fill** tells the grade (white,
cream, ochre, pale tan) and its **rim** whether it is paved (solid) or not (dashed from z13, plain and
lighter below). Paths are thin solid dark lines, so a dense forest network stays legible and the
tracks stand out from it. The fill ramp from paved to gravel is ordered in lightness (it survives grey
scale and colour blindness); the "simple" track style draws every track white and leaves only the rim.

Each edge gets a **tier** (the width), a **grade** and from both a **look** (`LOOK`, one row of `looks()`
each, `ways.ts`):

- **grade** 1 to 5 (0 = nothing mapped): the track grade where mapped (a paved surface always makes
  it 1), else read off `surface_class` (compacted 2, gravel 3, soft 4); with neither, tracks and paths
  are *unknown* and drawn as such (a fact, not a guess), roads, cycle paths and footways count as paved.
- **look**: main and secondary roads always their tier's band; tertiary and smaller roads their tier's
  band when paved, else the look of their grade at the road's width; tracks the look of their grade;
  separate cycle paths violet; paths paved, unpaved or not mapped.

| look | light fill / rim (default options) | shape | for |
|---|---|---|---|
| main road | `#ffe45e` / `#9c8514` | band | trunk, primary |
| secondary | `#fff1a1` / `#a8933a` | band | |
| tertiary | `#ffffff` / `#7a7468` | band | |
| road | `#ffffff` / `#8f897d` | band | minor road, street, service (paved) |
| paved track | `#fffdf8` / `#7a5b36` | band, solid rim | grade 1 track |
| compacted | `#fbefca` / `#a58b68` | band, dashed rim | grade 2 track or unpaved road |
| gravel | `#efc786` / `#a58b68` | band, dashed rim | grade 3 track or unpaved road |
| soft | `#f0e9dc` / `#a58b68` | band, dashed rim | grade 4 and 5 |
| not mapped | `#f1eee8` / `#a0978a` | band, dashed grey rim | a track with neither surface nor grade |
| cycle path | `#5b54d6` on a light halo | solid line | `cycleway`, a path signed as a separate cycle path |
| paved path | `#8a857c` | solid line | |
| path | `#4a3f35` | solid line | an unpaved path (grade 2–5) |
| path, not mapped | `#6e645a` | solid line | |
| ferry | `#4b84b3` | dashes `3 / 2.5`, never a band | `highway` = ferry |

The **dashed rim** is soft: the dashes at 60 % (`RIM_DASH_OPACITY`) on a casing of the band's fill
with 30 % of the rim in it (`RIM_UNDER_TINT`), so the edge stays continuous and the gaps keep the
band's width; full-strength dashes on the bare fill flickered and made a field of tracks busy. It
starts at `RIM_DASH_MINZOOM` = 13 (around z14 is how a phone is held: paved or not must read there),
with a finer dash below z15 (`RIM_DASH_FINE`, 0.75 / 0.45 casing widths; from z15 `RIM_DASH`, 1.1 /
0.7), where the long dash on a narrow band turned into a zipper. Below z13 the rim is plain in the
lighter unpaved colour. The start is a whole zoom on purpose: the casing's colour steps there, and
MapLibre takes a zoom step in a data expression per tile, at the tile's whole zoom (at 13.5 the casing
stayed dark until z14 and hid the dashes). **Widths** (px at the default line
weight; a band's fill, the roads' casing adds 1.0 / 1.4 / 1.6 / 1.8 / 2.0 / 2.3 at z10 / 12 / 13 /
14 / 15 / 16, a track's rim 0 / 1.0 / 1.6 / 1.9 / 2.2 / 2.6; a cycle path's halo adds 0.8 / 1.2 /
1.6 / 1.9 / 2.2 / 2.6):

| tier | z8 | z10 | z12 | z13 | z14 | z15 | z16 | z18 |
|---|---|---|---|---|---|---|---|---|
| main road (band) | 1.4 | 2.2 | 3.6 | 4.6 | 6.2 | 8.4 | 11.5 | 22 |
| secondary | 0.9 | 1.7 | 3.1 | 4.0 | 5.4 | 7.4 | 10.2 | 19 |
| tertiary | 0.5 | 1.1 | 2.4 | 3.3 | 4.6 | 6.4 | 8.8 | 17 |
| minor road | 0.4 | 0.7 | 1.7 | 2.6 | 3.7 | 5.2 | 7.4 | 14 |
| street | 0.3 | 0.6 | 1.4 | 2.2 | 3.2 | 4.6 | 6.6 | 13 |
| service | 0.3 | 0.4 | 0.8 | 1.3 | 2.0 | 2.8 | 4.2 | 8.5 |
| driveway, car-park aisle | 0.2 | 0.3 | 0.5 | 0.8 | 1.3 | 1.9 | 2.8 | 6 |
| track (band, every grade) | 0.3 | 0.45 | 1.25 | 2.6 | 3.6 | 4.7 | 6.2 | 10.8 |
| cycle path | 0.4 | 0.7 | 1.2 | 1.5 | 1.8 | 2.2 | 2.7 | 4 |
| path | 0.3 | 0.45 | 0.75 | 0.85 | 1.0 | 1.2 | 1.5 | 2.3 |

- **By zoom.** The overlay draws every way it carries at every zoom (the base tiles draw no road,
  track or path): main roads and ferries from z8, secondary z9, tertiary and cycle paths z11, minor
  roads and streets z12, tracks of grade 1–3 z11, all tracks z12, paths and the rest z13 (signed cycle
  routes earlier; `MINZOOM` in `pipeline/tiles.py`). Tracks and paths fade in: half opacity up to z11,
  full from z12.5, and a track band has no rim at z10 and barely one at z11, so the roads stay the skeleton of the
  overview. Contour lines are faint (fainter still at z11–12, where they would read as tracks): the
  relief shading carries the terrain.
  Driveways show from z14, car-park aisles from z15 (`service_kind`), paved paths along a road
  (`road_near_share` ≥ 60 %: pavements, roadside cycle tracks) from z15.
- **Crossings** (`bridge`, `tunnel`, `layer`): the bands are sorted by crossing level, then tier
  (`line-sort-key`): a bridge is at least level 1, a tunnel at most −1. From z13 a bridge gets two
  dark rails just outside its casing, above whatever passes underneath; a way in a tunnel is drawn at
  40 % opacity. Overlays without these properties (`overlay.drawing` empty: built before they
  existed) draw everything level, without rails, and the base tiles add plain tracks at z12.
- **Faint:** private or no bicycle access (45 % opacity).
- **What lies on top** (information band, explored band, cost layer): between the ways' casings and
  their fills, wider than the casing by 1.6 to 4 px (`underlayWidth`, per tier), so it shows as a
  coloured rim around the way's own fill. None of them draws a ferry (no rings on the lakes); the
  information band and the cost layer cover only what the ways draw at that zoom (`shown`: no aisle
  or pavement before its way shows), the explored band every way ridden.
- **The key** ("Map & rides", the Map tab): the tracks always, as a small legend, the roads, paths and
  the rest folded below; `KEY_ROWS` drawn with `keyStrokes` and `cartoFor` (the same colours, widths,
  rims and options as the layers), at z15, on field and on forest. Its tests check that each row's
  sample edge is classified as the row says and that every look is in the key.
- The classes are looked up **by enum label** in the manifest (`enumCodes`), never by code. A
  manifest lacking an attribute still gives a valid, simpler style.
- **Dashes** are one layer per pattern (the dashed rim, the ferry), never a data-driven dash: that keeps
  MapLibre on its plain line shader. The rim's dash steps by zoom only (finer below z15). The paths' line layer keeps a
  transparent halo layer under it (only cycle paths show theirs), so a tap finds every line.
- **Dark** keeps the same system with dark colours (lemon becomes a muted gold, the white roads
  greys, the bands keep their ramp brighter than the land, the tracks a brown rim); it is kept working,
  not polished. The ground options apply to light only.

### Map style options

"Map style" in Map & rides (the Map tab), for trying the style out: one choice per device in
localStorage (`kompass.mapLook`, JSON; absent = the defaults; `lib/map-look.ts`), parsed by `parseLook`
(`map/look.ts`, unknown values fall back to the default). A change rebuilds the style in place, like
the theme (`RegionMap.setLook`). `cartoFor(theme, look)` (`carto.ts`) turns the options into colours;
the widths take the weight.

| option | choices (first: default) | what it changes |
|---|---|---|
| Tracks | graded, simple | graded: the fill tells the grade; simple: every track white, only the rim tells paved from unpaved |
| Lines | normal, bold | every way and what lies under it (information, explored, cost) 1.25× wider |
| Ground | straw, meadow, pale | the open land and forest colours (`GROUNDS`): straw, a yellow-green meadow, or round 2's pale ground |
| Relief | soft, normal, strong | the hillshade strength ×0.6 / 1 / 1.5 (hidden without terrain) |
| Contour lines | on, off | the contour lines and their heights (the relief toggle hides both) |
- **From `@protomaps/basemaps`** come only the label layers and earth, water and buildings, recoloured
  through a flavour (the tileset's schema version must match the package's major version). Label
  language: the browser's if supported, else English. **Glyphs and sprites are vendored** in
  `web/public/map/` (see [its NOTICE](../web/public/map/NOTICE.md)): no third-party server is contacted
  at run time. Only three font stacks and the Latin glyph ranges (0–511, general punctuation) are
  there; other scripts render without that glyph.

### Where to tune

- Colours of the map, per theme: `carto.ts`, one table (the straw ground and the graded tracks), plus
  `GROUNDS` and `cartoFor` for the options. Colours of what lies on top (information layers, explored,
  rides, selection): `palette.ts`. Neither are theme tokens: they are picked against the map, not the
  chrome. The strong hues stay free for the route and the layers; the ochre gravel band is the route's
  nearest neighbour, which the route's white rim keeps apart. Every band fill but the ochre stays
  lighter than the open land of the straw and meadow grounds (a unit test checks it).
- Widths: `BAND_WIDTHS`, `CASING_WIDTHS`, `LINE_WIDTHS`, `HALO_WIDTHS` (px at `ZOOMS`); the dashes:
  `RIM_DASH`, `RIM_DASH_FINE`, `RIM_DASH_OPACITY`, `RIM_UNDER_TINT`, `FERRY_DASH` in `ways.ts`; the
  waterways: `WATERWAY_WIDTHS` in `basemap.ts`; the fade of tracks and paths: `TRACK_FADE`; the
  options' factors: `WEIGHT_SCALE`, `RELIEF_SCALE` in `look.ts`.
- Which land use kind gets which fill: `landFills` in `basemap.ts`.
- Relief strength: `hillshadeStrength`, `shade`, `highlight` in `carto.ts`; contour opacity and
  labels in `terrainLayers`.
- Check a change on the demo region with `bun scripts/map-shots.ts` (a dev server on the demo region:
  phone z10–z16, desktop z12 and z14, dark, a route, explored, surface, cost, traffic, the key;
  `--look '{"tracks":"simple"}'` for other options, `--dpr 3` for a phone's density), in a
  forest, a village and a town: what is calm in the hills can be loud in a city, and the other way
  round.

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
  every non-zero value). "Traffic alongside" (`road_near_traffic`, how loud the motor roads within
  20 m are, [profile.md](profile.md#traffic)) draws from 25 % on (a tertiary road at country speed;
  a 50 km/h street is about 7 %), from z12, like "Near a motor road"; on a road it includes the road
  itself, so the main roads always show.
- **Explored**: a teal band on ridden edges (`feature-state.ridden`); never ridden stays the map.
- **Cost**: every visible edge coloured by the current profile's factor (below).
- **Inspect**: tapping a way opens the panel with every attribute (a 14 px box around the tap, the
  nearest edge wins; below z13 the overlay does not carry every way yet). In the planner a tap adds a waypoint, so
  inspecting is a mode ("Inspect a way" in Map & rides, with an information layer on);
  `RegionMap.setPicking` switches the map's own tap handling.

### Cost layer

The cost debug view's map part (`cost.ts`: the scale and layers, pure; `cost-layer.ts`: the runtime;
the planner wires it, [planner.md](planner.md#cost-the-debug-view)).

- **Per viewport**: `edgeCosts` by the view's box grown by a quarter on each side, then `feature-state`
  on the overlay (`ct` position on the scale, `ck` kind, `cd` chevron) in chunks of 4000, only what
  changed. A pan with the same profile keeps what it already coloured; a new profile hides the edges the
  new answer does not cover. From z13 (`COST_MINZOOM`: below, the overlay lacks edges): the key says
  to zoom in. A new style re-applies the last answer.
- **The scale** diverges at factor 1 and is logarithmic on each side, scaled to the profile's
  `min_factor` (−1) and `max_factor` (+1): green preferred, grey neutral, magenta avoided
  (`COST_STOPS` in `palette.ts`, per theme). Per edge the better direction counts. Edges at the clamp
  are drawn 1.55× wider (there a stronger slider changes nothing); closed ones (both directions) are a
  dashed ink line; from z15 a chevron (`›` / `‹`) points along the cheaper or only direction where the
  two differ by more than 10 %. The tapped edge gets an ink outline. Like the information band it lies
  under the ways' lines (the chevrons above them).
- **Cost**: on the demo region (headless Chromium, SwiftShader, dev server), from a profile change to
  the colours written: z13, 390×844, 1.5 k edges: query 0.8 ms + apply 0.8 ms; z13, 1440×900, 10 k
  edges: 1.4 + 3.1 ms; z15: under 1 ms. A pan at z15 writes nothing new. A 60 ms debounce on profile
  changes (a slider drag) comes on top; the GPU repaint is not in these numbers.

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
