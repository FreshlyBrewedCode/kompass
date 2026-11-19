#!/usr/bin/env bash
# Stage 8: overlay PMTiles (tippecanoe) and the Protomaps base map extract.
#   tiles.sh <build dir> [protomaps build key, e.g. 20261118]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); source "$here/env.sh"
build=$1; pm=${2:-$(curl -sf https://build-metadata.protomaps.dev/builds.json | python3 -c 'import json,sys; print(json.load(sys.stdin)[-1]["key"].split(".")[0])')}
for mode in full idonly; do
  (cd "$here" && command time -f "export $mode: %e s, %M KB" uv run python -W ignore tiles_export.py "$build" $mode)
  # z8..z14 (MapLibre overzooms past 14). Minor classes appear from their minzoom; nothing is
  # dropped at any zoom (no size limit; tile sizes are checked afterwards). Edges keep their ids (feature-state needs integer ids).
  command time -f "tippecanoe $mode: %e s, %M KB" tippecanoe -q -f -o "$build/overlay_$mode.pmtiles" \
    -l edges -Z8 -z14 --no-feature-limit --no-tile-size-limit \
    --no-simplification-of-shared-nodes "$build/overlay_$mode.geojsonseq" 2>&1 | grep -v "^$" || true
  ls -la "$build/overlay_$mode.pmtiles"
done
# Base map: Protomaps daily build, clipped to the region circle, up to z15.
command time -f "pmtiles extract: %e s, %M KB" pmtiles extract "https://build.protomaps.com/$pm.pmtiles" \
  "$build/basemap.pmtiles" --region="$build/region.geojson" --maxzoom=15 --download-threads=4
ls -la "$build/basemap.pmtiles"
