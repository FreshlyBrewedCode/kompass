#!/usr/bin/env bash
# Spike #3: the whole region pipeline, one stage at a time (never two heavy jobs at once),
# each under GNU time so wall time and peak RSS land in <build>/<stage>.time.
#   build.sh <region.local.json> <dir with the covering Geofabrik *.osm.pbf> <dem dir> <build dir>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); source "$here/env.sh"
cfg=$1; osm=$2; dem=$3; build=$4
mkdir -p "$build"
PY=(uv run --project "$here" python -W ignore)
stage() { local name=$1; shift; echo "== $name"; command time -v "$@" 2> "$build/$name.time"; \
  grep -E "Elapsed|Maximum resident" "$build/$name.time" | sed "s/^\s*/   /"; }

"$here/clip.sh" "$cfg" "$osm" "$build"
[ -n "$(ls "$dem"/*.tif 2>/dev/null)" ] || "${PY[@]}" "$here/dem_fetch.py" "$cfg" "$dem"
stage edges "${PY[@]}" "$here/edges.py" "$build/region.osm.pbf" "$build"
stage context_osm bash -c "osmium tags-filter --overwrite '$build/region.osm.pbf' \
  a/landuse=forest,residential,commercial,industrial,retail,construction,garages,railway,farmyard,cemetery,allotments \
  a/natural=wood,water a/waterway=riverbank w/waterway=river,canal -o '$build/context.osm.pbf' && \
  osmium export --overwrite '$build/context.osm.pbf' -f geojsonseq -a type,id -o '$build/context.geojsonseq'"
stage context "${PY[@]}" "$here/context.py" "$build"
rm -f "$build/dem_utm.tif"
stage elevation "${PY[@]}" "$here/elevation.py" "$build" "$dem"
stage graph "${PY[@]}" "$here/graph.py" "$build"
stage finalize "${PY[@]}" "$here/finalize.py" "$build"
"${PY[@]}" "$here/report.py" "$build" > "$build/report.md"
"$here/tiles.sh" "$build" "${PROTOMAPS_BUILD:-}"
rm -f "$build"/overlay_*.geojsonseq "$build/context.geojsonseq"
