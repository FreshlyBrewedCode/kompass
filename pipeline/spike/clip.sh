#!/usr/bin/env bash
# Stage 1: merge the covering Geofabrik extracts and clip them to the region circle.
#   clip.sh <region.local.json> <dir with *.osm.pbf> <build dir>
# The circle comes from region.py (centre read from the config, never from code).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); source "$here/env.sh"
cfg=$1; src=$2; build=$3
mkdir -p "$build"
(cd "$here" && uv run python -W ignore region.py circle "$cfg" "$build/region.geojson")
command time -v osmium merge --overwrite "$src"/*.osm.pbf -o "$build/merged.osm.pbf" 2> "$build/merge.time"
# smart: complete ways, and multipolygons (forests, lakes) crossing the circle edge stay whole
command time -v osmium extract --overwrite -s smart -p "$build/region.geojson" "$build/merged.osm.pbf" \
  -o "$build/region.osm.pbf" 2> "$build/extract.time"
rm "$build/merged.osm.pbf"
for f in merge extract; do grep -E "Elapsed|Maximum resident" "$build/$f.time" | sed "s/^/$f: /"; done
ls -la "$build/region.osm.pbf"
