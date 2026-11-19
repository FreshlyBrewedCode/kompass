# Spike #3: region pipeline to `edges.parquet`

Throwaway experiment (never merged to `main`); the verdict, numbers and proposed schema are in
issue #3. The real pipeline is to be written from these scripts.

## Run

Tools come from nix ad hoc, linked under `$KOMPASS_DATA/tools` (default `/data/src/kompass/data`):

```sh
cd $KOMPASS_DATA/tools
for p in uv osmium-tool tippecanoe pmtiles gdal duckdb time expat.out bzip2.out lz4.out zlib; do
  nix build nixpkgs#$p -o ${p%.out}; done
nix build nixpkgs#stdenv.cc.cc.lib -o gcclib   # -> gcclib-lib (libstdc++ for PyPI wheels)
mv time gnutime
source pipeline/spike/env.sh && cd pipeline/spike && uv sync
```

Then:

```sh
uv run python region.py extracts $KOMPASS_DATA/region.local.json index-v1.json  # Geofabrik index
# download the listed extracts into one directory, then:
./build.sh $KOMPASS_DATA/region.local.json <extracts dir> $KOMPASS_DATA/dem/glo30 $KOMPASS_DATA/build/spike3
```

The region centre is only ever read from the gitignored config.

## Stages

| script | does |
|---|---|
| `region.py` | region circle (true metric radius) and the smallest set of Geofabrik extracts covering it |
| `clip.sh` | `osmium merge` the extracts, `osmium extract -s smart` with the circle |
| `edges.py` | pyosmium: barrier nodes + bicycle/mtb/ferry relations, then routable ways with locations; split at junctions |
| `tags.py` | raw tags -> typed attributes and enums (the code tables are the proposed contract) |
| `samples.py` | edges -> samples every 10 m in UTM 32N; all joins are array lookups on these |
| `context.py` | forest / forest rim / water / built-up / near-road shares via a 10 m raster |
| `vector_check.py` | the same forest share by exact vector intersection on a sample (speed + agreement) |
| `dem_fetch.py`, `elevation.py` | Copernicus GLO-30 tiles, warp to UTM 25 m, profile per edge, ascent and max grade |
| `graph.py` | components (prune < 1 km) and bridges with dead-end pocket size (iterative Tarjan) |
| `finalize.py` | join, Hilbert sort, GeoParquet write |
| `report.py` | coverage tables and sanity statistics |
| `tiles_export.py`, `tiles.sh` | overlay PMTiles (tippecanoe) and the Protomaps base map extract |
