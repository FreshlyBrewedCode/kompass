"""Stages `overlay` and `basemap`: the map tiles (PMTiles) the web app draws.

The overlay is `edges.parquet` as one line layer, `edges`, z8..14:
- the feature id is the integer `edge_id` (MapLibre `feature-state` needs integer ids; the overlay,
  the graph tiles and `edges.parquet` are one build: the build id is in the tiles' description),
- the attributes are the schema's `OVERLAY` list, so the debug map colours by style expressions alone,
- nothing is dropped at any zoom (`--no-feature-limit`); instead minor road classes only appear at
  higher zooms, which keeps the low-zoom tiles small. Tile sizes are checked after a build.
The base map is the Protomaps daily build, cut to the region disk by `pmtiles extract`.
"""

from __future__ import annotations

import json
import time
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import shapely

from . import schema, tools

LAYER = "edges"
OVERLAY_MINZOOM = 8
OVERLAY_MAXZOOM = 14
BASEMAP_MAXZOOM = 15

#: first zoom a highway class appears at; everything not listed is z13
MINZOOM = {
    "trunk": 8,
    "primary": 8,
    "ferry": 8,
    "trunk_link": 10,
    "primary_link": 10,
    "secondary": 9,
    "secondary_link": 11,
    "tertiary": 10,
    "tertiary_link": 11,
    "cycleway": 10,
    "unclassified": 11,
    "residential": 11,
    "track": 11,
    "path": 12,
    "footway": 12,
    "bridleway": 12,
    "living_street": 12,
}
DEFAULT_MINZOOM = 13
ROUTE_MINZOOM = 10  # edges on a bicycle route show early

PROTOMAPS_BUILDS = "https://build-metadata.protomaps.dev/builds.json"
PROTOMAPS_URL = "https://build.protomaps.com/{key}.pmtiles"
BATCH = 100_000


def minzooms(highway: np.ndarray, route_level: np.ndarray) -> np.ndarray:
    """Per-edge first zoom for highway class codes and route levels."""
    table = np.array([MINZOOM.get(label, DEFAULT_MINZOOM) for _, label in schema.BY_NAME["highway"].enum])
    mz = table[highway]
    return np.where(route_level > 0, np.minimum(mz, ROUTE_MINZOOM), mz)


def overlay_columns() -> list[str]:
    cols = {c for a in schema.OVERLAY for c in a.source} | {"edge_id", "geometry", "highway", "route_level"}
    return sorted(cols)


def feature_lines(batch: dict[str, np.ndarray]) -> Iterator[str]:
    """GeoJSON-sequence lines (feature id = edge_id, per-feature minzoom, overlay attributes)."""
    geo = shapely.to_geojson(shapely.set_precision(shapely.from_wkb(batch["geometry"]), 1e-6))
    mz = minzooms(batch["highway"], batch["route_level"])
    props = []
    for a in schema.OVERLAY:
        arr = batch[a.source[0]]
        for extra in a.source[1:]:
            arr = np.maximum(arr, batch[extra])
        props.append((a.key, arr))
    for i in range(len(geo)):
        p = {}
        for key, arr in props:
            v = arr[i]
            if v == v:  # skip NaN / null
                p[key] = int(v) if float(v).is_integer() else round(float(v), 1)
        yield (
            f'{{"type":"Feature","id":{int(batch["edge_id"][i])},"tippecanoe":{{"minzoom":{int(mz[i])}}},'
            f'"properties":{json.dumps(p, separators=(",", ":"))},"geometry":{geo[i]}}}\n'
        )


def export_geojsonseq(edges: Path, out: Path) -> int:
    pf = pq.ParquetFile(edges)
    n = 0
    with out.open("w") as f:
        for rb in pf.iter_batches(batch_size=BATCH, columns=overlay_columns()):
            batch = {}
            for name in rb.schema.names:
                col = rb.column(name)
                # nullable columns become float with NaN; the others keep their integer dtype
                batch[name] = (
                    col.to_numpy(zero_copy_only=False)
                    if col.null_count == 0
                    else col.to_pandas().to_numpy(dtype="float64", na_value=np.nan)
                )
            f.writelines(feature_lines(batch))
            n += len(rb)
    return n


def build_id_of(edges: Path) -> str | None:
    meta = pq.read_schema(edges).metadata or {}
    return meta.get(schema.META_BUILD_ID.encode(), b"").decode() or None


def overlay(edges: Path, work: Path, out: Path) -> None:
    tools.require("tippecanoe")
    seq = work / "overlay.geojsonseq"
    t0 = time.time()
    n = export_geojsonseq(edges, seq)
    print(f"  exported {n} features: {time.time() - t0:.0f}s", flush=True)
    tmp = out.with_name("overlay.part.pmtiles")
    build_id = build_id_of(edges) or "unknown"
    # z8..z14 (MapLibre overzooms past 14). Edges keep their ids: the GeoJSON `id` is an integer.
    tools.run(
        [
            "tippecanoe",
            "-q",
            "-f",
            "-o",
            tmp,
            "-l",
            LAYER,
            f"-Z{OVERLAY_MINZOOM}",
            f"-z{OVERLAY_MAXZOOM}",
            "--no-feature-limit",
            "--no-tile-size-limit",
            "--no-simplification-of-shared-nodes",
            "-n",
            "kompass-overlay",
            "-N",
            f"kompass build {build_id}",
            seq,
        ]
    )
    tmp.replace(out)
    seq.unlink()


def latest_protomaps_key() -> str:
    req = urllib.request.Request(PROTOMAPS_BUILDS, headers={"User-Agent": "kompass-pipeline"})
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)[-1]["key"].split(".")[0]


def basemap(polygon: Path, out: Path, build_key: str | None = None) -> None:
    """Protomaps daily build clipped to the region disk, z0..15 (network bound)."""
    tools.require("pmtiles")
    key = build_key or latest_protomaps_key()
    tmp = out.with_name("basemap.part.pmtiles")
    tmp.unlink(missing_ok=True)
    tools.run(
        [
            "pmtiles",
            "extract",
            PROTOMAPS_URL.format(key=key),
            tmp,
            f"--region={polygon}",
            f"--maxzoom={BASEMAP_MAXZOOM}",
            "--download-threads=4",
        ]
    )
    tmp.replace(out)
