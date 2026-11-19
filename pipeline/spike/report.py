"""Spike report: coverage tables and sanity statistics for edges.parquet, as Markdown.

Usage: python report.py <build_dir>   (statistics only; nothing location-specific is printed)
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

import tags

ROADS = ["trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "service"]


def pct(x):
    return f"{100 * x:.0f}%"


def table(df, cols):
    out = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    out += ["| " + " | ".join(str(r[c]) for c in cols) + " |" for _, r in df.iterrows()]
    return "\n".join(out)


def main(build):
    e = pd.read_parquet(Path(build) / "edges.parquet").drop(columns=["geometry"])
    km = e.length_m / 1000
    hw = pd.Series(np.array(tags.HIGHWAY)[e.highway], index=e.index).str.replace("_link", "")
    nodes = len(np.unique(np.concatenate([e.node_from, e.node_to])))
    print(f"edges {len(e):,}, nodes {nodes:,}, total {km.sum():,.0f} km, "
          f"median edge {e.length_m.median():.0f} m, mean {e.length_m.mean():.0f} m\n")

    print("## Surface coverage by highway class (share of edge-km with the tag)\n")
    rows = []
    for h, g in e.groupby(hw):
        k = km[g.index]
        rows.append({"highway": h, "km": f"{k.sum():,.0f}", "km share": pct(k.sum() / km.sum()),
                     "surface": pct(k[g.surface.notna()].sum() / k.sum()),
                     "tracktype": pct(k[g.tracktype > 0].sum() / k.sum()),
                     "smoothness": pct(k[g.smoothness > 0].sum() / k.sum()),
                     "surface or tracktype": pct(k[g.surface.notna() | (g.tracktype > 0)].sum() / k.sum()),
                     "none of the three": pct(k[g.surface.isna() & (g.tracktype == 0) & (g.smoothness == 0)].sum() / k.sum())})
    rows = pd.DataFrame(rows).sort_values("km", key=lambda s: -s.str.replace(",", "").astype(float))
    print(table(rows, list(rows.columns)))
    k_all = km.sum()
    print(f"\nall: surface {pct(km[e.surface.notna()].sum() / k_all)}, tracktype {pct(km[e.tracktype > 0].sum() / k_all)}, "
          f"smoothness {pct(km[e.smoothness > 0].sum() / k_all)}, surface-or-tracktype "
          f"{pct(km[e.surface.notna() | (e.tracktype > 0)].sum() / k_all)}\n")

    print("## Traffic proxies on roads (share of edge-km)\n")
    rows = []
    for h in ROADS:
        g = e[hw == h]
        k = km[g.index]
        rows.append({"highway": h, "km": f"{k.sum():,.0f}",
                     "maxspeed explicit": pct(k[g.maxspeed_src.isin([1, 2])].sum() / k.sum()),
                     "maxspeed implicit": pct(k[g.maxspeed_src.isin([3, 4])].sum() / k.sum()),
                     "maxspeed unknown": pct(k[g.maxspeed_src == 0].sum() / k.sum()),
                     "lanes": pct(k[g.lanes.notna()].sum() / k.sum())})
    print(table(pd.DataFrame(rows), list(rows[0].keys())))

    print("\n## Legal access for bicycles (share of edge-km)\n")
    names = ["implicit", "yes", "designated", "permissive", "destination", "use_sidepath", "dismount",
             "foot_only", "agri_forestry", "private", "no"]
    s = km.groupby(e.bike_access).sum() / k_all
    print(" · ".join(f"{names[i]} {100 * v:.1f}%" for i, v in s.items()))

    print("\n## Cycleways\n")
    cw = ["none", "shared", "lane", "track (on road)", "separate path", "bicycle road"]
    s = km.groupby(e.cycleway_kind).sum()
    print(" · ".join(f"{cw[i]} {v:,.0f} km" for i, v in s.items()))
    sep = e.cycleway_kind == 4
    away = sep & (e.road_near_share < 50)
    print(f"\nseparate paths: {km[sep].sum():,.0f} km, of which away from a motor road (<50% within 20 m) "
          f"{km[away].sum():,.0f} km ({pct(km[away].sum() / km[sep].sum())}); tagged as sidepath: "
          f"{pct(km[sep & e.is_sidepath_tag].sum() / km[sep].sum())}")
    print(f"route relations: {km[e.route_level > 0].sum():,.0f} km on a bicycle route, "
          f"{km[e.mtb_route].sum():,.0f} km on an mtb route")
    for c in ["width_m", "trail_visibility", "mtb_scale", "sac_scale"]:
        known = e[c].notna() & (e[c] > 0)
        sel = hw.isin(["path", "track", "footway", "bridleway"])
        print(f"{c}: known on {pct(km[known & sel].sum() / km[sel].sum())} of path/track/footway/bridleway km")
    print(f"tracktype grade4/5 share of track km: {pct(km[(hw == 'track') & (e.tracktype >= 4)].sum() / km[hw == 'track'].sum())}")

    print("\n## Context (length-weighted mean share)\n")
    for c in ["forest_share", "forest_edge_share", "water_share", "builtup_share", "road_near_share"]:
        print(f"- {c}: {(e[c] / 100 * km).sum() / k_all:.1%}")

    print("\n## Elevation sanity\n")
    asc = e.ascent_fwd_m + e.ascent_bwd_m
    net = (e.ele_to_m - e.ele_from_m).abs()
    long = e.length_m >= 200
    fs = e.forest_share
    for name, m in [("open (forest 0%)", long & (fs == 0)), ("mixed (1-99%)", long & (fs > 0) & (fs < 100)),
                    ("forest (100%)", long & (fs == 100))]:
        print(f"- {name}: {m.sum():,} edges >= 200 m; climb (up+down) per km {asc[m].sum() / km[m].sum():.1f} m; "
              f"wiggle (up+down - |net|) per km {(asc[m] - net[m]).sum() / km[m].sum():.1f} m; "
              f"max grade p50/p95/p99 {np.nanpercentile(e.max_grade_fwd_pct[m], 50):.1f}/"
              f"{np.nanpercentile(e.max_grade_fwd_pct[m], 95):.1f}/{np.nanpercentile(e.max_grade_fwd_pct[m], 99):.1f}%")
    print(f"- share of edge-km with max grade (either way) > 20%: "
          f"{pct(km[(e.max_grade_fwd_pct > 20) | (e.max_grade_bwd_pct > 20)].sum() / k_all)}")

    print("\n## Graph\n")
    br = e.bridge
    print(f"bridges (cut edges): {br.sum():,} = {br.mean():.1%} of edges, {pct(km[br].sum() / k_all)} of km; "
          f"pockets (km beyond the bridge): 0 km (stub) {pct((e.pocket_km[br] == 0).mean())}, "
          f"< 0.5 km {pct((e.pocket_km[br] < 0.5).mean())}, >= 2 km {pct((e.pocket_km[br] >= 2).mean())}")
    deg = pd.Series(np.concatenate([e.node_from, e.node_to])).value_counts()
    print(f"node degree: 1 {pct((deg == 1).mean())}, 2 {pct((deg == 2).mean())}, 3 {pct((deg == 3).mean())}, 4+ {pct((deg >= 4).mean())}")


if __name__ == "__main__":
    main(sys.argv[1])
