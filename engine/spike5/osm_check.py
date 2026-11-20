"""Spike #5: what lies under the unmatched stretches? Prints aggregate counts only.

For each stretch (JSON lines from `kompass match --unmatched-out`: sampled points), the share of its
points within 15 m of an OSM way the pipeline keeps (then the edge was dropped later, e.g. a small
component, or the matcher failed), of a way it drops (`highway=construction`, `area=yes`, …), or
of a non-highway way that bikes use (`railway=abandoned`, …), or of nothing (unmapped).

  uv run --project pipeline python engine/spike5/osm_check.py <unmatched.jsonl> <region.osm.pbf>
"""

import json
import math
import sys
from collections import Counter, defaultdict

import osmium

sys.path.insert(0, __file__.rsplit("/engine/", 1)[0] + "/pipeline/src")
from kompass_pipeline.ways import KEEP_HIGHWAY  # noqa: E402

CELL = 0.001  # degrees, ~100 m
NEAR_M = 15.0

stretches = [json.loads(line) for line in open(sys.argv[1])]
cells = defaultdict(list)  # cell -> [(stretch, point index)]
for si, s in enumerate(stretches):
    for pi, (x, y) in enumerate(s["points"]):
        cells[(int(x / CELL), int(y / CELL))].append((si, pi))
best = {}  # (si, pi) -> (distance, class)


def seg_dist(px, py, ax, ay, bx, by):
    k = math.cos(math.radians(py)) * 111195.0
    ax, ay, bx, by = (ax - px) * k, (ay - py) * 111195.0, (bx - px) * k, (by - py) * 111195.0
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / l2))
    return math.hypot(ax + t * dx, ay + t * dy)


class H(osmium.SimpleHandler):
    def way(self, w):
        t = w.tags
        hw = t.get("highway")
        if hw is not None:
            cls = "kept" if hw in KEEP_HIGHWAY and t.get("area") != "yes" else f"dropped:{hw}" + (
                ":area" if t.get("area") == "yes" else "")
        elif t.get("railway") in ("abandoned", "disused", "razed"):
            cls = "railway-" + t.get("railway")
        elif t.get("route") == "ferry":
            cls = "ferry"
        else:
            return
        try:
            nodes = [(n.lon, n.lat) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        for (ax, ay), (bx, by) in zip(nodes, nodes[1:]):
            seen = set()
            for cx in range(int(min(ax, bx) / CELL) - 1, int(max(ax, bx) / CELL) + 2):
                for cy in range(int(min(ay, by) / CELL) - 1, int(max(ay, by) / CELL) + 2):
                    for key in cells.get((cx, cy), ()):
                        if key in seen:
                            continue
                        seen.add(key)
                        px, py = stretches[key[0]]["points"][key[1]]
                        d = seg_dist(px, py, ax, ay, bx, by)
                        if d < NEAR_M and d < best.get(key, (1e9, ""))[0]:
                            best[key] = (d, cls)


H().apply_file(sys.argv[2], locations=True)
by_class = Counter()
by_class_m = Counter()
for si, s in enumerate(stretches):
    n = len(s["points"])
    c = Counter(best.get((si, pi), (0, "nothing"))[1] for pi in range(n))
    top, k = c.most_common(1)[0]
    # a stretch is "nothing" if most of it is far from any way
    label = top if k >= 0.5 * n else "mixed"
    if "near" in s:
        on_graph = sum(1 for d in s["near"] if d is not None and d <= NEAR_M)
        if on_graph >= 0.5 * n:
            label += " (graph edge within 15 m: not reachable)"
    by_class[label] += 1
    by_class_m[label] += s["length_m"]
print(f"{len(stretches)} unmatched in-region stretches, {sum(s['length_m'] for s in stretches) / 1e3:.1f} km")
for label, n in by_class.most_common():
    print(f"  {label}: {n} stretches, {by_class_m[label] / 1e3:.1f} km")
