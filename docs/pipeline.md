# Pipeline

A Python program (`pipeline/`, package `kompass_pipeline`, run with uv) that turns the region config
into everything the app and the engine need. Offline and local: no service, no backend. The output
is a directory per build:

| file | what |
|---|---|
| `edges.parquet` | the routing graph, [the contract with the engine](edges-parquet.md) |
| `overlay.pmtiles` | the edges as vector tiles (layer `edges`, z8..14): the map's roads (tracks from z11 or z12, paths from z13), its information layers and the explored map |
| `basemap.pmtiles` | the Protomaps base map cut to the region (z0..15) |
| `terrain.pmtiles` | the DEM as raster tiles (Terrarium PNG, 256 px, z6..12) for the hillshade |
| `contours.pmtiles` | contour lines as vector tiles (layer `contours`, `ele` in metres, z10..14) |
| `manifest.json` | bounds, centre, file names, the overlay's attributes with their enum labels, the terrain |
| `graph/` | not the pipeline's: the engine's graph, compiled from `edges.parquet` by `kompass compile` ([graph-format.md](graph-format.md)) |
| `work/` | intermediates (region extract, raw edges, context, elevation), kept so stages can resume |

```sh
kompass-pipeline build --region data/region.local.json --out data/build/<name>   # all stages
kompass-pipeline <stage> --region ... --out ...                                  # one stage
```

The region config (centre and radius) is read from the file named on the command line; it is
gitignored and its contents never go into the repo. Downloads are cached next to it: Geofabrik
extracts under `data/osm/`, DEM tiles under `data/dem/`. A stage is skipped when its outputs are
newer than its inputs (`--force` redoes it), so a change reruns only what it touches. The external
tools (osmium, tippecanoe, pmtiles, gdal) come from the nix dev shell; a missing one is a clear error.

## Stages

1. **clip**: the smallest set of Geofabrik extracts covering the region is picked from the Geofabrik
   index, merged, and cut to the region disk with `osmium extract -s smart` (forests and lakes
   crossing the rim stay whole).
2. **edges**: pyosmium streams the ways; the routable ones are kept (everything a bicycle can
   physically use, legal doubt only marks), split at junctions and at ends (closed ways get an extra
   split), and given their geometry, metric length, barrier count and route relation membership.
3. **context**: landuse is rasterised to a 10 m grid and every edge sampled every 10 m: shares in
   forest, along a forest edge, near water, built-up, near a motor road, and how loud the roads
   near it are (`road_near_traffic`). The motor roads are burnt into one byte raster as 1 + their
   traffic level in percent (the engine's model, `traffic.py` reading `traffic.json`; the speed guess
   uses the road's built-up share, so it runs after that), louder roads last, and a grey dilation by
   the 20 m disk spreads the loudest; `> 0` is the near-a-road mask as before. No extra raster, same
   time and memory (demo: 5 s, 2.0 GB peak either way; the dilation costs what the binary one did).
4. **elevation**: every edge sampled every 10 m on a DEM, smoothed over 50 m, giving the elevation
   at both ends, the ascent per direction and the steepest 50 m per direction. The DEM is an
   `ElevationFn` (metric x, y in, metres out); Copernicus GLO-30 is the default. It is a surface
   model, so forest gradients are noisy; a bare-ground model replaces it through the same function.
5. **graph**: connected components; those under 1 km (fragments at the rim, isolated private
   bits) are dropped.
6. **finalize**: tags become typed attributes (`tags.py`, enum labels from `schema.py`), everything
   is joined, rows are sorted by the Hilbert key and written with the schema metadata.
7. **overlay** and **basemap**: tippecanoe cuts `overlay.pmtiles` with the edge id as the feature id
   and the attributes listed in `schema.OVERLAY` (the information layers, in the manifest) plus the
   drawing-only properties `schema.OVERLAY_DRAWING` (`bridge`, `tunnel`, `layer`, `service_kind`, written
   only when not 0, listed in the manifest's `overlay.drawing`; see [map.md](map.md)). Ferries are
   `highway` = `ferry`. Minor road classes appear at higher zooms only, so low-zoom tiles stay small:
   tracks of grade 1 to 3 from z11, other tracks from z12, paths and the rest at z13 (`MINZOOM`,
   `GOOD_TRACK_MINZOOM` in `tiles.py`). Nothing is dropped at any zoom.
   Check the sizes of a build with `python -m kompass_pipeline.tilestats <overlay.pmtiles>` (largest
   tile per zoom; keep it well under 500 KB). Demo region (15 km), largest tile / total per zoom, KB
   (gzip), before this change and with tracks from z12 / z11 for all / z11 for grades 1 to 3 (chosen):

   | zoom | before | all tracks z12 | all tracks z11 | chosen |
   |---|---|---|---|---|
   | 11 | 30 / 116 | 30 / 117 | 140 / 587 | 93 / 398 |
   | 12 | 45 / 296 | 84 / 854 | 84 / 854 | 84 / 854 |
   | 13 | 72 / 1538 | 73 / 1553 | 73 / 1553 | 73 / 1553 |
   | 14 | 33 / 1861 | 33 / 1880 | 33 / 1880 | 33 / 1880 |
   | file | 3.84 MB | 4.42 MB | 4.88 MB | 4.70 MB |

   The new properties cost about 1 % (+0.04 MB); the information layer `road_near_traffic` another
   2 % (4.70 → 4.79 MB, largest z11 tile 93 → 95 KB). On a 100 km region tiles are about 4 times the demo's
   at the same zoom (it was 190 KB against 45 KB at z12), so the chosen setting is expected near
   350 KB at z11 and z12: check it after a build and raise `GOOD_TRACK_MINZOOM` / `TRACK_MINZOOM` by one
   if a tile goes over 500 KB.
   `pmtiles extract` cuts the base map from the latest Protomaps
   build (needs network).
8. **terrain**: the DEM (the same `ElevationFn` as the elevation stage, so another model replaces
   GLO-30 here too) is sampled on the web-mercator pixel grid of z12, which is about the model's own
   resolution. `terrain.pmtiles`: Terrarium-encoded PNG tiles, heights rounded to 0.5 m (PNG then
   compresses well), lower zooms by 2×2 means, written as MBTiles and converted with `pmtiles`.
   `contours.pmtiles`: `gdal_contour` every 10 m on the DEM blurred by 1.5 px (a surface model:
   tree canopy makes raw lines ragged), closed lines under 400 m dropped, thinned by zoom with a
   tippecanoe filter (100 m from z10, 20 m from z13, 10 m at z14). On a 100 km region: about 3 min,
   68 MB + 40 MB, and the build's memory peak (5.8 GB, the DEM is held twice). Fine for hillshade
   and 10–20 m contours; the lines in forest follow the canopy.
9. **manifest**: `manifest.json` with the file names, zoom ranges and the overlay attributes
   (key, label, kind `enum`/`share`/`number`, enum values with labels), all derived from `schema.py`,
   and the `terrain` entry when its files exist. Rewriting it for the same edges keeps `builtAt`
   (what is matched against the build must not see a new one).

## Where things are defined

- The schema, enum labels and the overlay's attribute list: `schema.py`, nowhere else.
- The traffic model (`road_near_traffic`): the engine's `engine/core/src/traffic.rs`; the pipeline
  reads the generated `traffic.json` (`bun run gen:engine`) and its tests check it against the
  engine's examples.
- Tag to attribute mapping: `tags.py` (raw values to enum *labels*; `schema.codes()` gives the codes).
- The attributes the map can show as information layers: the manifest, so the app lists what the
  build offers. How the app draws them by default: `web/src/map/info.ts` ([map.md](map.md)).
- The demo region (`pipeline/regions/demo.json`: the Black Forest east of Freiburg, 15 km radius) is
  the committed, public-safe config: about 1 min to build, the place for screenshots.
