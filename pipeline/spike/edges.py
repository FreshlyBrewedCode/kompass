"""Stage 2: OSM region extract -> edges_raw.parquet (bike-routable ways split at junctions).

Usage: python edges.py <region.osm.pbf> <out_dir>

Two streaming passes with pyosmium:
  1. barrier nodes and bicycle route / ferry relations (filtered in C++, tiny),
  2. highway / ferry ways with node locations (flex_mem index), filtered to the routable set.
Coordinates and node ids go into flat arrays, tags into one list per key. Splitting, lengths and
geometry are vectorised with numpy / shapely. Attribute derivation happens in attrs.py.
"""
import sys
import time
from array import array
from pathlib import Path

import numpy as np
import osmium
import pyarrow as pa
import pyarrow.parquet as pq
import shapely
from pyproj import Transformer

# --- routable filter ---------------------------------------------------------------------------
# Kept: everything a bicycle can physically use. Legal doubt (foot-only, private, bicycle=no,
# steps, ...) is NOT a reason to drop; it is marked in `bike_access` and left to the profile.
KEEP_HIGHWAY = {
    "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link",
    "tertiary", "tertiary_link", "unclassified", "residential", "living_street", "service",
    "road", "track", "path", "cycleway", "footway", "bridleway", "steps", "pedestrian",
}
# Dropped: physically or categorically not for bikes, or not (yet) a way at all.
# motorway(_link), construction, proposed, abandoned, raceway, bus_guideway, busway, platform,
# corridor, elevator, via_ferrata, escape, rest_area, services; plus area=yes (squares as rings),
# and `access=no` + `highway=construction`-like lifecycle prefixes are simply not matched.

TAG_KEYS = [
    "highway", "service", "route", "surface", "tracktype", "smoothness",
    "maxspeed", "maxspeed:forward", "maxspeed:backward", "maxspeed:type", "source:maxspeed",
    "zone:traffic", "lanes", "access", "bicycle", "motor_vehicle", "vehicle", "motorcar", "foot",
    "oneway", "oneway:bicycle", "junction", "cycleway", "cycleway:both", "cycleway:left",
    "cycleway:right", "segregated", "bicycle_road", "cyclestreet", "width", "est_width",
    "trail_visibility", "mtb:scale", "sac_scale", "informal", "motorroad", "bridge", "tunnel",
    "layer", "name", "ref", "is_sidepath", "footway", "path", "lit", "incline",
]

BARRIER_KEEP = {
    "gate", "lift_gate", "swing_gate", "bollard", "stile", "kissing_gate", "cycle_barrier",
    "block", "chain", "turnstile", "full-height_turnstile", "fence", "wall", "log", "sump_buster",
}
ROUTE_LEVEL = {"lcn": 1, "rcn": 2, "ncn": 3, "icn": 4}


def pass1(pbf):
    """Barrier nodes and route relation membership (way id -> best network level / mtb flag)."""
    barriers, route_level, mtb, ferry = {}, {}, set(), set()
    fp = (osmium.FileProcessor(pbf, osmium.osm.NODE | osmium.osm.RELATION)
          .with_filter(osmium.filter.KeyFilter("barrier", "route")))
    for o in fp:
        if o.is_node():
            b = o.tags.get("barrier")
            if b in BARRIER_KEEP:
                barriers[o.id] = b
        elif o.is_relation():
            r = o.tags.get("route")
            if r in ("bicycle", "mtb"):
                lvl = ROUTE_LEVEL.get(o.tags.get("network"), 1)
                for m in o.members:
                    if m.type == "w":
                        if r == "mtb":
                            mtb.add(m.ref)
                        else:
                            route_level[m.ref] = max(route_level.get(m.ref, 0), lvl)
            elif r == "ferry":
                for m in o.members:
                    if m.type == "w":
                        ferry.add(m.ref)
    return barriers, route_level, mtb, ferry


def keep_way(tags, ferry_rel, wid):
    hw = tags.get("highway")
    if hw in KEEP_HIGHWAY:
        return tags.get("area") != "yes"
    if tags.get("route") == "ferry" or (wid in ferry_rel and hw is None):
        return tags.get("bicycle") != "no"
    return False


def pass2(pbf, ferry_rel):
    way_ids = array("q")
    offsets = array("q", [0])
    node_ids = array("q")
    xs, ys = array("i"), array("i")  # 1e-7 degrees, OSM precision
    cols = {k: [] for k in TAG_KEYS}
    fp = (osmium.FileProcessor(pbf, osmium.osm.NODE | osmium.osm.WAY)
          .with_locations(osmium.index.create_map("flex_mem"))
          .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
          .with_filter(osmium.filter.KeyFilter("highway", "route")))
    intern = sys.intern
    for w in fp:
        t = w.tags
        if not keep_way(t, ferry_rel, w.id):
            continue
        n = len(w.nodes)
        if n < 2:
            continue
        for nd in w.nodes:
            node_ids.append(nd.ref)
            loc = nd.location
            xs.append(loc.x)
            ys.append(loc.y)
        offsets.append(len(node_ids))
        way_ids.append(w.id)
        for k in TAG_KEYS:
            v = t.get(k)
            cols[k].append(intern(v) if v is not None else None)
    return (np.frombuffer(way_ids, np.int64), np.frombuffer(offsets, np.int64),
            np.frombuffer(node_ids, np.int64), np.frombuffer(xs, np.int32),
            np.frombuffer(ys, np.int32), cols)


def split(way_ids, offsets, node_ids):
    """Split every way at nodes shared with another kept way (or repeated within it) and at its
    ends. Closed segments (from == to) get an extra split in the middle, so no edge is a loop."""
    uniq, inv, counts = np.unique(node_ids, return_inverse=True, return_counts=True)
    is_junction = counts[inv] >= 2
    starts, ends, eway, pos_a, pos_b = [], [], [], [], []
    for wi in range(len(way_ids)):
        a, b = offsets[wi], offsets[wi + 1]
        cut = np.flatnonzero(is_junction[a + 1:b - 1]) + 1
        pts = [0, *cut.tolist(), b - a - 1]
        k = 0
        while k < len(pts) - 1:
            p, q = pts[k], pts[k + 1]
            if node_ids[a + p] == node_ids[a + q] and q - p >= 2:
                pts.insert(k + 1, (p + q) // 2)  # break loops in the middle
                continue
            if q > p:
                starts.append(a + p)
                ends.append(a + q)
                eway.append(wi)
                pos_a.append(p)
                pos_b.append(q)
            k += 1
    return (np.array(starts), np.array(ends), np.array(eway),
            np.array(pos_a, np.uint16), np.array(pos_b, np.uint16), len(uniq),
            int((counts >= 2).sum()))


def main(pbf, out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    barriers, route_level, mtb, ferry_rel = pass1(pbf)
    t1 = time.time()
    print(f"pass1: {len(barriers)} barriers, {len(route_level)} route ways, {len(mtb)} mtb ways, "
          f"{t1 - t0:.1f}s", flush=True)
    way_ids, offsets, node_ids, xs, ys, cols = pass2(pbf, ferry_rel)
    t2 = time.time()
    print(f"pass2: {len(way_ids)} ways, {len(node_ids)} way-nodes, {t2 - t1:.1f}s", flush=True)

    starts, ends, eway, pos_a, pos_b, n_nodes, n_junction = split(way_ids, offsets, node_ids)
    t3 = time.time()
    print(f"split: {len(starts)} edges, {n_nodes} distinct way nodes, {n_junction} junctions, "
          f"{t3 - t2:.1f}s", flush=True)

    # Geometry: per edge the coordinate run [start, end] inclusive.
    seg_len = ends - starts + 1
    idx = np.repeat(starts - np.concatenate([[0], np.cumsum(seg_len)[:-1]]), seg_len) + np.arange(seg_len.sum())
    lon = xs[idx] * 1e-7
    lat = ys[idx] * 1e-7
    part = np.repeat(np.arange(len(starts)), seg_len)
    geoms = shapely.linestrings(np.column_stack([lon, lat]), indices=part)
    # Length in a metric CRS (ETRS89 / UTM 32N is fine for Germany west of 12 deg E).
    ex, ny = Transformer.from_crs("EPSG:4326", "EPSG:25832", always_xy=True).transform(lon, lat)
    d = np.hypot(np.diff(ex), np.diff(ny))
    d[part[1:] != part[:-1]] = 0.0
    length = np.add.reduceat(np.concatenate([[0.0], d]), np.concatenate([[0], np.cumsum(seg_len)[:-1]]))
    # Barriers along the edge (interior and end nodes).
    bar_ids = np.fromiter(barriers.keys(), np.int64, len(barriers))
    is_bar = np.isin(node_ids[idx], bar_ids)
    n_bar = np.add.reduceat(is_bar.astype(np.int32), np.concatenate([[0], np.cumsum(seg_len)[:-1]]))
    t4 = time.time()
    print(f"geometry+length: {t4 - t3:.1f}s, total {length.sum() / 1000:.0f} km", flush=True)

    wid = way_ids[eway]
    table = {
        "way_id": wid,
        "way_pos_from": pos_a,
        "way_pos_to": pos_b,
        "node_from": node_ids[starts],
        "node_to": node_ids[ends],
        "length_m": length.astype(np.float32),
        "n_barriers": n_bar.astype(np.uint8),
        "route_level": np.array([route_level.get(int(w), 0) for w in wid], np.uint8),
        "mtb_route": np.isin(wid, np.fromiter(mtb, np.int64, len(mtb))),
        "geometry": shapely.to_wkb(geoms),
    }
    for k, v in cols.items():
        arr = pa.array(v, pa.string())
        table["tag_" + k.replace(":", "_")] = arr.take(pa.array(eway))
    pq.write_table(pa.table(table), out / "edges_raw.parquet", compression="zstd")
    print(f"write: {time.time() - t4:.1f}s; total {time.time() - t0:.1f}s", flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:3])
