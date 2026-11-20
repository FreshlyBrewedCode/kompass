"""A stand-in route line for the map style round: a shortest path over the demo region's edges that
likes tracks and small roads. NOT the engine (the demo graph did not load in this worktree); it only
puts a believable line on the map so the variants can be judged under one.

    uv run --project pipeline python design/map-round-2/mock-route.py <demo build dir> <out.geojson>
"""

import heapq
import json
import sys

import pyarrow.parquet as pq
import shapely

build, out = sys.argv[1], sys.argv[2]
# through Titisee: forest tracks in the north-west, the village, the lake shore, tracks in the south-east
STOPS = [(8.1385, 47.9135), (8.1525, 47.9035), (8.1405, 47.8905), (8.1640, 47.8850)]

t = pq.read_table(f"{build}/edges.parquet", columns=["node_from", "node_to", "length_m", "highway", "geometry"])
a, b = t.column("node_from").to_pylist(), t.column("node_to").to_pylist()
length, highway = t.column("length_m").to_pylist(), t.column("highway").to_pylist()
geoms = shapely.from_wkb(t.column("geometry").to_numpy(zero_copy_only=False))
# highway codes of the pipeline's schema: 1..4 trunk and primary, 5..6 secondary, 14 track, 15 path
cost = [w * (6 if 1 <= h <= 6 else 0.7 if h == 14 else 1.6 if h >= 15 else 1) for w, h in zip(length, highway)]
graph: dict[int, list[tuple[int, float, int, bool]]] = {}
for i in range(len(a)):
    graph.setdefault(a[i], []).append((b[i], cost[i], i, False))
    graph.setdefault(b[i], []).append((a[i], cost[i], i, True))
ends = {}
for i, g in enumerate(geoms):
    c = shapely.get_coordinates(g)
    ends[a[i]], ends[b[i]] = tuple(c[0]), tuple(c[-1])


# only nodes of the biggest connected part can be stops
seen: dict[int, int] = {}
for start in graph:
    if start in seen:
        continue
    stack, seen[start] = [start], start
    while stack:
        for m, *_ in graph[stack.pop()]:
            if m not in seen:
                seen[m] = start
                stack.append(m)
sizes: dict[int, int] = {}
for root in seen.values():
    sizes[root] = sizes.get(root, 0) + 1
main = max(sizes, key=sizes.get)
connected = [n for n in ends if seen[n] == main]


def nearest(lon: float, lat: float) -> int:
    return min(connected, key=lambda n: (ends[n][0] - lon) ** 2 * 0.45 + (ends[n][1] - lat) ** 2)


def path(src: int, dst: int) -> list[list[float]]:
    dist, prev, heap = {src: 0.0}, {}, [(0.0, src)]
    while heap:
        d, n = heapq.heappop(heap)
        if n == dst:
            break
        if d > dist.get(n, 1e18):
            continue
        for m, w, i, rev in graph.get(n, []):
            if d + w < dist.get(m, 1e18):
                dist[m], prev[m] = d + w, (n, i, rev)
                heapq.heappush(heap, (d + w, m))
    coords: list[list[float]] = []
    n = dst
    while n != src:
        n, i, rev = prev[n]
        c = shapely.get_coordinates(geoms[i]).tolist()
        coords = (c[::-1] if rev else c) + coords
    return coords


nodes = [nearest(*s) for s in STOPS]
line: list[list[float]] = []
for u, v in zip(nodes, nodes[1:]):
    line += path(u, v)
feature = {"type": "Feature", "properties": {}, "geometry": {"type": "LineString", "coordinates": line}}
with open(out, "w") as f:
    json.dump({"type": "FeatureCollection", "features": [feature]}, f)
print(len(line), "vertices")
