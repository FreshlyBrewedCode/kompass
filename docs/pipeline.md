# Pipeline

A Python program (`pipeline/`, package `kompass_pipeline`, run with uv) that turns the region config
into everything the app and the engine need. Offline and local: no service, no backend. The output
is a directory per build:

| file | what |
|---|---|
| `edges.parquet` | the routing graph, [the contract with the engine](edges-parquet.md) |
| `overlay.pmtiles` | the edges as vector tiles (layer `edges`, z8..14) for the debug and explored map |
| `basemap.pmtiles` | the Protomaps base map cut to the region (z0..15) |
| `manifest.json` | bounds, centre, file names and the overlay's attributes with their enum labels |
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
   forest, along a forest edge, near water, built-up, near a motor road.
4. **elevation**: every edge sampled every 10 m on a DEM, smoothed over 50 m, giving the elevation
   at both ends, the ascent per direction and the steepest 50 m per direction. The DEM is an
   `ElevationFn` (metric x, y in, metres out); Copernicus GLO-30 is the default. It is a surface
   model, so forest gradients are noisy; a bare-ground model replaces it through the same function.
5. **graph**: connected components; those under 1 km (fragments at the rim, isolated private
   bits) are dropped.
6. **finalize**: tags become typed attributes (`tags.py`, enum labels from `schema.py`), everything
   is joined, rows are sorted by the Hilbert key and written with the schema metadata.
7. **overlay** and **basemap**: tippecanoe cuts `overlay.pmtiles` with the edge id as the feature id
   and the attributes listed in `schema.OVERLAY`; minor road classes appear at higher zooms only,
   so low-zoom tiles stay small. `pmtiles extract` cuts the base map from the latest Protomaps
   build (needs network).
8. **manifest**: `manifest.json` with the file names, zoom ranges and the overlay attributes
   (key, label, kind `enum`/`share`/`number`, enum values with labels), all derived from `schema.py`.

## Where things are defined

- The schema, enum labels and the overlay's attribute list: `schema.py`, nowhere else.
- Tag to attribute mapping: `tags.py` (raw values to enum *labels*; `schema.codes()` gives the codes).
- Colour-by attributes of the debug map: the manifest, so the app lists what the build offers.
