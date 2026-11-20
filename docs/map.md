# The map

Code: `web/src/map/` (logic, no React), `web/src/history/` (the explored store), `web/src/rides/` ([rides.md](rides.md)),
`web/src/components/` (chrome, replaceable). Tests: `web/test`, `e2e/map.spec.ts`.

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
- `kind`: `enum` (integer codes with labels) → categorical colours; `share` (0..`max`, shown as a
  percentage) and `number` (`min`..`max`, optional `unit`) → a sequential ramp.

## Base map

Protomaps PMTiles with `@protomaps/basemaps` (light and dark flavour follow the system theme; the
tileset's schema version must match the package's major version). Label language: the browser's if
supported, else English. **Glyphs and sprites are vendored** in `web/public/map/` (see
[its NOTICE](../web/public/map/NOTICE.md)): no third-party server is contacted at run time. Only the
three font stacks the style uses and the Latin glyph ranges (0–511, general punctuation) are
there; other scripts render without that glyph. The overlay sits between the base map's roads and
its labels.

## Modes

A switch in the chrome (`controller.ts` applies it by changing paint properties only: no tiles
reload).

- **plain**: the overlay is hidden.
- **attribute**: `line-color` from the chosen manifest attribute (`expressions.ts`). Unknown values
  are information: an enum value labelled "unknown", and any edge lacking the property, get a
  neutral grey and a legend entry. Categorical colours: Okabe–Ito, at most 8 hues (more values
  repeat them lighter, then darker); sequential: viridis, trimmed per theme. Tapping an edge opens
  the inspect panel with every attribute (a 14 px box around the tap, the nearest edge wins).
  Colours live in `palette.ts`, not in the theme tokens: they must work on both base maps.
- **explored**: never ridden is muted, ridden is highlighted (colour by `feature-state.ridden`).

## Explored map

`ExploredStore` (`history/explored-store.ts`): `setRidden(ids | Map<id, {count, lastRidden}>)`
replaces the set, `clear()`, `subscribe()`. The ride library ([rides.md](rides.md)) fills it from its saved matches
(`RidesState.attachExplored`); the map reads it. `ExploredLayer` mirrors it into `feature-state` (`ridden`, `count`)
in chunks of 5000 ids, yielding to the main thread between chunks, and applies only the difference.
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
graph.
