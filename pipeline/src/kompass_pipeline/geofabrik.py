"""Picking the Geofabrik extracts that cover the region, and caching their downloads."""

from __future__ import annotations

import json
from pathlib import Path

from shapely import Polygon
from shapely.geometry import shape
from shapely.ops import unary_union

from .net import download

INDEX_URL = "https://download.geofabrik.de/index-v1.json"


def pick_extracts(region: Polygon, index: dict) -> list[tuple[str, str]]:
    """The smallest-level Geofabrik extracts covering `region`, as (id, pbf url): start at the
    smallest single area covering it, then descend into children while the children that intersect
    the region still cover the part of it that lies in the parent."""
    feats = index["features"]
    by_id = {f["properties"]["id"]: f for f in feats}
    geom = {i: shape(f["geometry"]) for i, f in by_id.items() if f.get("geometry")}
    kids: dict[str | None, list[str]] = {}
    for i, f in by_id.items():
        kids.setdefault(f["properties"].get("parent"), []).append(i)

    def refine(i: str) -> list[str]:
        part = region.intersection(geom[i])
        ch = [c for c in kids.get(i, []) if c in geom and geom[c].intersects(part)]
        if ch and unary_union([geom[c] for c in ch]).buffer(0.01).covers(part):
            return [x for c in ch for x in refine(c)]
        return [i]

    tops = sorted((i for i in geom if geom[i].covers(region)), key=lambda i: geom[i].area)
    if not tops:
        raise RuntimeError("no single Geofabrik area covers the region")
    return [(i, by_id[i]["properties"]["urls"]["pbf"]) for i in refine(tops[0])]


def fetch_extracts(region_circle: Polygon, osm_dir: Path) -> list[Path]:
    """The covering extracts, downloaded into `osm_dir` (cached: `index/` and `geofabrik/`)."""
    index_path = download(INDEX_URL, osm_dir / "index" / "index-v1.json")
    picks = pick_extracts(region_circle, json.loads(index_path.read_text()))
    print(f"  covering extracts: {', '.join(i for i, _ in picks)}", flush=True)
    return [download(url, osm_dir / "geofabrik" / url.rsplit("/", 1)[-1]) for _, url in picks]
