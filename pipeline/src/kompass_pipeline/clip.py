"""Stage `clip`: merge the covering Geofabrik extracts and clip them to the region disk."""

from __future__ import annotations

import json
from pathlib import Path

from shapely import to_geojson

from . import geofabrik, tools
from .config import Region


def run(region: Region, osm_dir: Path, work: Path) -> None:
    tools.require("osmium")
    work.mkdir(parents=True, exist_ok=True)
    poly = work / "region.geojson"
    poly.write_text(
        json.dumps({"type": "Feature", "properties": {}, "geometry": json.loads(to_geojson(region.circle()))})
    )
    extracts = geofabrik.fetch_extracts(region.circle(), osm_dir)
    merged = work / "merged.osm.pbf"
    if len(extracts) == 1:
        src = extracts[0]
    else:
        tools.run(["osmium", "merge", "--overwrite", *extracts, "-o", merged])
        src = merged
    # smart: complete ways, and multipolygons (forests, lakes) crossing the disk's edge stay whole
    out = work / "region.osm.pbf"
    tmp = work / "region.tmp.osm.pbf"
    tools.run(["osmium", "extract", "--overwrite", "-s", "smart", "-p", poly, src, "-o", tmp])
    tmp.replace(out)
    merged.unlink(missing_ok=True)
