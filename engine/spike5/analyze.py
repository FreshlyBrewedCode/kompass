"""Spike #5: aggregate numbers from `kompass match --out <dir>` runs (prints aggregates only).

  python3 engine/spike5/analyze.py summary <run dir>
  python3 engine/spike5/analyze.py compare <run dir A> <run dir B> [--reversed]
  python3 engine/spike5/analyze.py explored <run dir> --out <explored.json> --build-id <id> [--min-share 0.5]
"""

import argparse
import datetime
import glob
import json
import os
import statistics


def load(d):
    rides = {}
    for f in sorted(glob.glob(os.path.join(d, "*.json"))):
        r = json.load(open(f))
        rides[os.path.basename(f)] = r
    return rides


def q(v, ps=(0.0, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0)):
    v = sorted(v)
    if not v:
        return "-"
    return " / ".join(f"{v[round(p * (len(v) - 1))]:.3g}" for p in ps)


def coverage(r, min_share=0.0):
    """edge -> (covered share union, length, per-direction share)."""
    cov = {}
    for e, rev, s, t, ln, *_ in r["pieces"]:
        lo, hi = min(s, t), max(s, t)
        c = cov.setdefault(e, {"len": ln, "iv": [], "dir": [0.0, 0.0]})
        c["iv"].append((lo, hi))
        c["dir"][rev] += hi - lo
    out = {}
    for e, c in cov.items():
        iv = sorted(c["iv"])
        tot, cur = 0.0, None
        for lo, hi in iv:
            if cur is None or lo > cur[1]:
                if cur:
                    tot += cur[1] - cur[0]
                cur = [lo, hi]
            else:
                cur[1] = max(cur[1], hi)
        tot += cur[1] - cur[0]
        if tot >= min_share:
            out[e] = (min(tot, 1.0), c["len"], c["dir"])
    return out


def classify(r):
    s = r["region_share"]
    return "in" if s >= 0.99 else ("out" if s <= 0.01 else "partial")


def summary(d):
    rides = load(d)
    cls = {"in": [], "partial": [], "out": []}
    for name, r in rides.items():
        cls[classify(r)].append(r)
    print(f"rides: {len(rides)}; in region {len(cls['in'])}, partly {len(cls['partial'])}, outside {len(cls['out'])}")
    km = lambda rs: sum(r["track_m"] for r in rs) / 1e3
    print(f"km: in {km(cls['in']):.0f}, partly {km(cls['partial']):.0f}, outside {km(cls['out']):.0f}")
    ins = cls["in"] + cls["partial"]
    share = [r["matched_m"] / max(1, r["track_m"] * r["region_share"]) for r in ins]
    print("matched share of in-region track, per ride (min/p5/p10/p25/p50/p75/p90/max):", q(share))
    tot_reg = sum(r["track_m"] * r["region_share"] for r in ins)
    tot_m = sum(r["matched_m"] for r in ins)
    print(f"matched share overall: {tot_m / tot_reg * 100:.2f} % of {tot_reg / 1e3:.0f} km")
    for lim in (0.95, 0.98, 0.99, 0.995):
        print(f"  rides under {lim * 100:.1f} %: {sum(1 for x in share if x < lim)}")
    ratio = [r["path_m"] / r["matched_m"] for r in ins if r["matched_m"] > 0]
    print("path / matched track length per ride:", q(ratio))
    print(f"  overall {sum(r['path_m'] for r in ins) / tot_m:.4f}")
    brk = [(r["chains"] - 1) / max(1e-9, r["track_m"] * r["region_share"] / 1e5) for r in cls["in"]]
    print("chain breaks per 100 km (in-region rides):", q(brk))
    print(f"  overall {sum(r['chains'] - 1 for r in cls['in']) / (km(cls['in']) / 100):.2f}")
    contra = sum(r["contra_oneway_m"] for r in ins) / sum(r["path_m"] for r in ins)
    print(f"path against a bike one-way: {contra * 100:.2f} %")
    # unmatched stretches inside the region (share of points with an edge within 300 m >= 0.9)
    um = [u[0] for r in ins for u in r["unmatched"] if u[3] >= 0.9 and u[0] > 1]
    print(f"in-region unmatched stretches > 1 m: {len(um)}, total {sum(um) / 1e3:.1f} km; lengths:", q(um))
    for lo, hi in ((1, 50), (50, 200), (200, 500), (500, 2000), (2000, 1e9)):
        sel = [x for x in um if lo <= x < hi]
        print(f"  {lo}-{hi} m: {len(sel)} ({sum(sel) / 1e3:.1f} km)")
    ms = [r["ms"] for r in rides.values()]
    per100 = [r["ms"] / (r["track_m"] / 1e5) for r in ins if r["track_m"] > 5000]
    print(f"time: total {sum(ms) / 1e3:.2f} s, per ride {q(ms)} ms; per 100 km {q(per100)} ms")
    pts = [r["points"] for r in rides.values()]
    kept = sum(r["kept"] for r in rides.values())
    print(f"points {sum(pts)}, kept {kept} ({kept / sum(pts) * 100:.0f} %), "
          f"candidates per kept point {sum(r['candidates'] for r in rides.values()) / kept:.2f}, "
          f"settled nodes per search {sum(r['settled'] for r in rides.values()) / max(1, sum(r['searches'] for r in rides.values())):.1f}")
    pieces = [len(r["pieces"]) for r in ins]
    per_km = [len(r["pieces"]) / (r["path_m"] / 1e3) for r in ins if r["path_m"] > 1000]
    print(f"pieces per ride {q(pieces)}; per km {q(per_km)}")


def ride_set(r, min_share):
    return {e: c[0] * c[1] for e, c in coverage(r, min_share).items()}


def compare(a, b, reversed_=False, min_share=0.5):
    ra, rb = load(a), load(b)
    js, dirs, worst = [], [], []
    for name in ra:
        if name not in rb or classify(ra[name]) == "out":
            continue
        ca, cb = coverage(ra[name], 0.0), coverage(rb[name], 0.0)
        sa = {e for e, c in ca.items() if c[0] >= min_share}
        sb = {e for e, c in cb.items() if c[0] >= min_share}
        w = lambda s, c: sum(c[e][1] for e in s)
        inter = w(sa & sb, ca)
        union = w(sa | sb, {**cb, **ca})
        if union > 0:
            js.append(inter / union)
        # arcs (edge, direction) covered >= min_share in that direction
        def arcs(c, flip):
            return {(e, d ^ flip) for e, x in c.items() for d in (0, 1) if x[2][d] >= min_share}
        aa, ab = arcs(ca, 0), arcs(cb, 1 if reversed_ else 0)
        ua = sum(ca.get(e, cb.get(e))[1] for e, _ in aa | ab)
        if ua:
            dirs.append(sum(ca[e][1] for e, _ in aa & ab) / ua)
        if union > 0 and inter / union < 0.9:
            worst.append((round(inter / union, 3), name))
    print(f"rides compared {len(js)}; edge-set agreement (length-weighted Jaccard, edges >= {min_share:.0%} covered):")
    print("  per ride", q(js), f"; mean {statistics.mean(js):.4f}")
    print("  arc-set agreement (edge + direction)", q(dirs), f"; mean {statistics.mean(dirs):.4f}")
    print(f"  rides under 0.9 edge agreement: {len(worst)}")
    if os.environ.get("KOMPASS_SPIKE_PRIVATE"):
        print("  ", sorted(worst))


def explored(d, out, build_id, min_share, min_len):
    rides = load(d)
    edges = {}
    shares = []
    stats = {"rides": 0}
    for name, r in rides.items():
        if not r["pieces"]:
            continue
        stats["rides"] += 1
        end = r.get("end")
        day = datetime.datetime.fromtimestamp(end / 1000, datetime.UTC).date().isoformat() if end else None
        for e, (share, ln, dr) in coverage(r, 0.0).items():
            shares.append((share, ln))
            if share < min_share and share * ln < min_len:
                continue
            x = edges.setdefault(e, {"count": 0, "lastRidden": None, "fwd": 0, "bwd": 0, "len": ln})
            x["count"] += 1
            if dr[0] >= 0.5 * share:
                x["fwd"] += 1
            if dr[1] >= 0.5 * share:
                x["bwd"] += 1
            if day and (x["lastRidden"] is None or day > x["lastRidden"]):
                x["lastRidden"] = day
    km = sum(x["len"] for x in edges.values()) / 1e3
    print(f"explored: {len(edges)} edges, {km:.0f} km (min share {min_share}, or {min_len} m covered)")
    counts = [x["count"] for x in edges.values()]
    for lo, hi in ((1, 2), (2, 3), (3, 5), (5, 10), (10, 20), (20, 10**9)):
        sel = [x for x in edges.values() if lo <= x["count"] < hi]
        print(f"  ridden {lo}..{hi - 1}: {len(sel)} edges, {sum(x['len'] for x in sel) / 1e3:.0f} km")
    both = [x for x in edges.values() if x["fwd"] and x["bwd"]]
    only_f = [x for x in edges.values() if x["fwd"] and not x["bwd"]]
    only_b = [x for x in edges.values() if x["bwd"] and not x["fwd"]]
    L = lambda s: sum(x["len"] for x in s) / 1e3
    print(f"  directions: both {len(both)} ({L(both):.0f} km), only along {len(only_f)} ({L(only_f):.0f} km), "
          f"only against {len(only_b)} ({L(only_b):.0f} km)")
    print(f"  median count {statistics.median(counts)}, max {max(counts)}")
    # partial coverage of (ride, edge) pairs
    bins = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1.01]
    for lo, hi in zip(bins, bins[1:]):
        sel = [s for s in shares if lo <= s[0] < hi]
        print(f"  (ride, edge) pairs covered {lo:.2f}..{hi:.2f}: {len(sel)}, edge length median "
              f"{statistics.median([s[1] for s in sel]) if sel else 0:.0f} m")
    if out:
        doc = {"graphBuild": build_id,
               "edges": {str(e): {"count": x["count"], "lastRidden": x["lastRidden"]}
                         for e, x in sorted(edges.items())}}
        with open(out, "w") as f:
            json.dump(doc, f, separators=(",", ":"))
        print(f"wrote {len(edges)} edges")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("dirs", nargs="+")
    ap.add_argument("--reversed", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--build-id", default="")
    ap.add_argument("--min-share", type=float, default=0.5)
    ap.add_argument("--min-len", type=float, default=1e9)
    a = ap.parse_args()
    if a.cmd == "summary":
        summary(a.dirs[0])
    elif a.cmd == "compare":
        compare(a.dirs[0], a.dirs[1], a.reversed, a.min_share)
    elif a.cmd == "explored":
        explored(a.dirs[0], a.out, a.build_id, a.min_share, a.min_len)


def metrics(d, rev=None):
    """One line per run: matched share, path ratio, breaks and reversals per 100 km, agreement."""
    rides = {k: r for k, r in load(d).items() if classify(r) != "out"}
    reg = sum(r["track_m"] * r["region_share"] for r in rides.values())
    mat = sum(r["matched_m"] for r in rides.values())
    path = sum(r["path_m"] for r in rides.values())
    brk = sum(r["chains"] - 1 for r in rides.values() if r["chains"])
    rev_n = rev_m = 0
    for r in rides.values():
        p = r["pieces"]
        for a, b in zip(p, p[1:]):
            if a[0] == b[0] and a[1] != b[1]:
                rev_n += 1
                rev_m += min(abs(a[3] - a[2]), abs(b[3] - b[2])) * a[4]
    ms = sum(r["ms"] for r in load(d).values())
    line = (f"matched {mat / reg * 100:.2f} %  path/track {path / mat:.4f}  breaks/100km {brk / reg * 1e5:.2f}  "
            f"reversals/100km {rev_n / path * 1e5:.1f} ({rev_m / rev_n if rev_n else 0:.0f} m)  "
            f"contra {sum(r['contra_oneway_m'] for r in rides.values()) / path * 100:.2f} %  {ms / 1e3:.2f} s")
    if rev:
        rb = load(rev)
        js = []
        for name, r in rides.items():
            if name not in rb:
                continue
            ca, cb = coverage(r), coverage(rb[name])
            sa = {(e, d_) for e, x in ca.items() for d_ in (0, 1) if x[2][d_] >= 0.5}
            sb = {(e, 1 - d_) for e, x in cb.items() for d_ in (0, 1) if x[2][d_] >= 0.5}
            ln = {**cb, **ca}
            u = sum(ln[e][1] for e, _ in sa | sb)
            if u:
                js.append(sum(ln[e][1] for e, _ in sa & sb) / u)
        line += f"  fwd/rev arcs {statistics.mean(js):.4f} (p10 {sorted(js)[len(js) // 10]:.3f})"
    print(line)


if __name__ == "__main__" and os.environ.get("KOMPASS_SPIKE_METRICS"):
    import sys

    metrics(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    sys.exit(0)


if __name__ == "__main__":
    main()
