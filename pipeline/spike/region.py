"""Region helpers: read the local region config, build the clip circle, pick Geofabrik extracts.

Usage:
  python region.py circle   <region.local.json> <out.geojson>
  python region.py extracts <region.local.json> <geofabrik index-v1.json>
The centre is only ever read from the config file; nothing location-specific lives in code.
"""
import json
import sys

from pyproj import Transformer
from shapely.geometry import Point, shape, mapping
from shapely.ops import transform, unary_union  # noqa


def load(cfg_path):
    cfg = json.load(open(cfg_path))
    return cfg["center"]["lat"], cfg["center"]["lon"], float(cfg["radiusKm"])


def circle(cfg_path, buffer_km=0.0):
    """The region circle as a WGS84 polygon (true metric radius via a local azimuthal projection)."""
    lat, lon, r = load(cfg_path)
    aeqd = f"+proj=aeqd +lat_0={lat} +lon_0={lon} +units=m"
    to_wgs = Transformer.from_crs(aeqd, "EPSG:4326", always_xy=True).transform
    return transform(to_wgs, Point(0, 0).buffer((r + buffer_km) * 1000, 256))


def pick_extracts(region, index_path):
    """Smallest-level Geofabrik extracts covering `region`: descend from any covering parent into
    its children while the intersecting children still cover the parent's share of the region."""
    feats = json.load(open(index_path))["features"]
    by_id = {f["properties"]["id"]: f for f in feats}
    geom = {i: shape(f["geometry"]) for i, f in by_id.items() if f.get("geometry")}
    kids = {}
    for i, f in by_id.items():
        kids.setdefault(f["properties"].get("parent"), []).append(i)

    def refine(i):
        part = region.intersection(geom[i])
        ch = [c for c in kids.get(i, []) if c in geom and geom[c].intersects(part)]
        if ch and unary_union([geom[c] for c in ch]).buffer(0.01).covers(part):
            return [x for c in ch for x in refine(c)]
        return [i]

    tops = [i for i in geom if geom[i].covers(region) and not kids.get(i) is None]
    # the smallest single region covering everything is the start; then refine
    tops.sort(key=lambda i: geom[i].area)
    return [(i, by_id[i]["properties"]["urls"]["pbf"]) for i in refine(tops[0])]


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "circle":
        json.dump({"type": "Feature", "properties": {}, "geometry": mapping(circle(sys.argv[2]))},
                  open(sys.argv[3], "w"))
    elif cmd == "extracts":
        for i, url in pick_extracts(circle(sys.argv[2]), sys.argv[3]):
            print(i, url)
