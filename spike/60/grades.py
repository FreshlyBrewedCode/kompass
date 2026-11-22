"""Spike #60, question 1: what the grade data carries per edge, and what a grade histogram would add.

Read-only: edges.parquet and the GLO-30 tiles; the warped DEM and the per-edge arrays go to --work
(a temporary directory). Prints aggregates only.

usage: python grades.py --build <dir> --region <json> --dem <glo30 dir> --work <tmp dir>
"""

from __future__ import annotations

import argparse
import gzip
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import rasterio
from scipy import ndimage

from kompass_pipeline import samples
from kompass_pipeline.config import Region
from kompass_pipeline.dem_glo30 import MARGIN_M, WARP_RES, tile_name, tiles_for
from kompass_pipeline.elevation import GRADE_BASE, SMOOTH, STEP, segmented_moving_average

# the analysis histogram: 1 % bins of signed grade along the geometry, −30..30, tails in the end bins
H_LO, H_HI = -30, 30
NB = H_HI - H_LO + 1


def dem_fn(region: Region, dem_dir: Path, work: Path):
    tiles = [dem_dir / f"{tile_name(lat, lon)}.tif" for lat, lon in tiles_for(region)]
    missing = [t for t in tiles if not t.exists()]
    if missing:
        sys.exit(f"{len(missing)} DEM tiles missing (no downloads in the spike)")
    vrt, tif = work / "dem.vrt", work / "dem_metric.tif"
    r = region.radius_km * 1000 + MARGIN_M
    if not tif.exists():
        subprocess.run(["gdalbuildvrt", "-q", str(vrt), *map(str, tiles)], check=True)
        subprocess.run(
            ["gdalwarp", "-q", "-overwrite", "-t_srs", region.crs, "-tr", str(WARP_RES), str(WARP_RES),
             "-te", str(-r), str(-r), str(r), str(r), "-r", "bilinear", "-co", "COMPRESS=DEFLATE",
             "-co", "TILED=YES", "-co", "PREDICTOR=3", "-wm", "512", str(vrt), str(tif)],
            check=True,
        )
    with rasterio.open(tif) as ds:
        dem = ds.read(1).astype(np.float32)
        inv = ~ds.transform

    def elevation(x, y):
        col, row = inv * (x, y)
        return ndimage.map_coordinates(dem, [row - 0.5, col - 0.5], order=1, mode="nearest")

    return elevation


def edge_stats(geom, crs, elevation):
    """Per edge: smoothed profile → ascent fwd/bwd, steepest 50 m fwd/bwd (as the pipeline), and the
    histogram of the 10 m step grades of the smoothed profile (metres per 1 % bin, signed along)."""
    n = len(geom)
    x, y, part = samples.vertices(geom, crs)
    sx, sy, sedge, sd, _, length = samples.sample(x, y, part, n, step=STEP)
    del x, y, part
    z = np.asarray(elevation(sx, sy), dtype=np.float64)
    del sx, sy
    is_first = np.r_[True, sedge[1:] != sedge[:-1]]
    is_last = np.r_[sedge[1:] != sedge[:-1], True]
    zs = segmented_moving_average(z, sedge, SMOOTH)
    zs[is_first | is_last] = z[is_first | is_last]
    dz = np.diff(zs)
    dd = np.diff(sd)
    same = sedge[1:] == sedge[:-1]
    e1 = sedge[1:]
    asc_f = np.bincount(e1, weights=np.where(same & (dz > 0), dz, 0.0), minlength=n)
    asc_b = np.bincount(e1, weights=np.where(same & (dz < 0), -dz, 0.0), minlength=n)
    # step grades
    ok = same & (dd > 0)
    gr = np.where(ok, dz / np.maximum(dd, 1e-6) * 100, 0.0)
    b = np.clip(np.rint(gr), H_LO, H_HI).astype(np.int64) - H_LO
    hist = np.zeros((n, NB), dtype=np.float32)
    np.add.at(hist, (e1[ok], b[ok]), dd[ok])
    hist = hist.astype(np.float16)
    # 50 m window grades (the pipeline's steepest 50 m), and their per-edge spread
    first = np.flatnonzero(is_first)
    last = np.flatnonzero(is_last)
    j = np.arange(z.size)
    tgt = np.minimum(j + GRADE_BASE, last[sedge])
    okw = (tgt > j) & ((tgt - j == GRADE_BASE) | (j == first[sedge]))
    dw = sd[tgt] - sd[j]
    g = np.where(okw & (dw > 0), (zs[tgt] - zs[j]) / np.maximum(dw, 1e-6) * 100, np.nan)
    import pandas as pd

    gs = pd.Series(g)
    grp = gs.groupby(sedge)
    max_f = grp.max().reindex(range(n)).to_numpy(copy=True)
    max_b = (-gs).groupby(sedge).max().reindex(range(n)).to_numpy(copy=True)
    std = grp.std().reindex(range(n)).to_numpy()
    net = (zs[last] - zs[first]) / np.maximum(length, 1e-6) * 100
    short = length < 20
    max_f[short] = np.maximum(net[short], 0)
    max_b[short] = np.maximum(-net[short], 0)
    # raw-vs-smoothed: high-frequency roughness of the raw samples (m), per edge
    rough = np.bincount(sedge, weights=np.abs(z - zs), minlength=n) / np.maximum(np.bincount(sedge, minlength=n), 1)
    return dict(
        length=length, asc_f=asc_f, asc_b=asc_b, max_f=np.nan_to_num(max_f), max_b=np.nan_to_num(max_b),
        std=np.nan_to_num(std), net=net, hist=hist, rough=rough,
    )


def tamed(max_g, asc, length, forest):
    avg = asc / np.maximum(length, 1) * 100
    return np.maximum(np.minimum(max_g, 2.5 * avg + 5) - 5 * forest, 0)


def curve(g):
    """A sample hills curve (cost factor against signed grade, %): flat up to 3 %, 1.3× at 6 %, 2× at
    10 %, 4× at 15 % and steeper; descents count at half the grade (the ramps' convention)."""
    x = np.where(g >= 0, g, -0.5 * g)
    return np.exp(np.interp(x, [0, 3, 6, 10, 15], np.log([1, 1, 1.3, 2.0, 4.0])))


def curve_section(E, L, LL, asc, mx, tm, fo, H, gv):
    print("\n## A hills curve from what an arc carries (sample curve: 1 at 3 %, 1.3 at 6, 2 at 10, 4 at 15; down half)")
    Hf = H.astype(np.float32)
    cv = curve(gv.astype(np.float64)).astype(np.float32)
    cvb = curve(-gv.astype(np.float64)).astype(np.float32)
    hl = np.maximum(Hf.sum(axis=1), 1e-6)
    truth = np.concatenate([(Hf @ cv) / hl, (Hf @ cvb) / hl])
    net = np.concatenate([E["my_net"], -E["my_net"]])
    desc = np.concatenate([E["ascent_bwd_m"], E["ascent_fwd_m"]]).astype(np.float64)
    mxd = np.concatenate([E["max_grade_bwd_pct"], E["max_grade_fwd_pct"]]).astype(np.float64)
    # A: the net (signed) average grade
    a_net = curve(net)
    # B: the steepest 50 m, whole arc
    b_max = np.maximum(curve(mx), curve(-mxd))
    # C: two-point: 50 m at the steepest, the rest at the remaining average climb (up), same for down
    w = np.minimum(50.0 / np.maximum(LL, 1), 1.0)
    rest_up = np.maximum((asc - w * LL * mx / 100) / np.maximum(LL * (1 - w), 1) * 100, 0)
    rest_dn = np.maximum((desc - w * LL * mxd / 100) / np.maximum(LL * (1 - w), 1) * 100, 0)
    up_share = asc / np.maximum(asc + desc, 1e-6)
    c_two = w * np.maximum(curve(mx), curve(-mxd)) + (1 - w) * (up_share * curve(rest_up) + (1 - up_share) * curve(-rest_dn))
    # D: ascent and descent rates as two parts of the arc (no steepest)
    up_rate = asc / np.maximum(LL, 1) * 100
    dn_rate = desc / np.maximum(LL, 1) * 100
    d_split = up_share * curve(up_rate / np.maximum(up_share, 1e-6)) + (1 - up_share) * curve(-dn_rate / np.maximum(1 - up_share, 1e-6))
    d_split = np.where(asc + desc < 1e-3, 1.0, d_split)
    # E: tamed steepest (what the ramps see today)
    tmd = tamed(mxd, desc, LL, fo)
    e_tamed = np.maximum(curve(tm), curve(-tmd))
    print("| evaluated from | mean |log error| vs histogram | arc length off by > 15 pct | off by > 50 pct | mean factor (histogram: %.3f) |" % (np.sum(truth * LL) / LL.sum()))
    print("|---|---:|---:|---:|---:|")
    for nm, v in [("net average grade", a_net), ("steepest 50 m (raw)", b_max), ("steepest 50 m (tamed)", e_tamed),
                  ("ascent and descent rates, split", d_split), ("two-point: steepest 50 m + rest", c_two)]:
        err = np.abs(np.log(v / truth))
        print(f"| {nm} | {np.sum(err * LL) / LL.sum():.3f} | {pct(err > np.log(1.15), LL)} | {pct(err > np.log(1.5), LL)} | {np.sum(v * LL) / LL.sum():.3f} |")
    for lo, hi in [(0, 100), (100, 300), (300, 1e9)]:
        m = (LL >= lo) & (LL < hi)
        err = np.abs(np.log(d_split[m] / truth[m]))
        err2 = np.abs(np.log(c_two[m] / truth[m]))
        print(f"  arcs {lo:.0f}–{hi:.0f} m ({LL[m].sum() / LL.sum() * 100:.0f} % of length): split off > 15 % on {pct(err > np.log(1.15), LL[m])}, two-point {pct(err2 > np.log(1.15), LL[m])}")


def pct(a, w=None):
    return f"{100 * (np.sum(w[a]) / np.sum(w) if w is not None else a.mean()):.1f} %"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", required=True)
    ap.add_argument("--region", required=True)
    ap.add_argument("--dem", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--chunk", type=int, default=300_000)
    a = ap.parse_args()
    work = Path(a.work)
    work.mkdir(parents=True, exist_ok=True)
    region = Region.load(a.region)
    t0 = time.time()
    elevation = dem_fn(region, Path(a.dem), work)
    print(f"DEM ready {time.time() - t0:.0f} s", file=sys.stderr)
    pf = pq.ParquetFile(Path(a.build) / "edges.parquet")
    cols = ["length_m", "highway", "surface_class", "tracktype", "forest_share", "ascent_fwd_m",
            "ascent_bwd_m", "max_grade_fwd_pct", "max_grade_bwd_pct", "geometry"]
    parts = {}
    t1 = time.time()
    for batch in pf.iter_batches(batch_size=a.chunk, columns=cols):
        d = batch.to_pydict() if False else {c: batch.column(c).to_numpy(zero_copy_only=False) for c in cols}
        s = edge_stats(d["geometry"], region.crs, elevation)
        for k in cols[:-1]:
            parts.setdefault(k, []).append(np.asarray(d[k]))
        for k, v in s.items():
            parts.setdefault("my_" + k, []).append(v)
        print(f"  {sum(len(p) for p in parts['length_m'])} edges {time.time() - t1:.0f} s", file=sys.stderr)
    E = {k: np.concatenate(v) for k, v in parts.items()}
    np.savez(work / "edges.npz", **E)
    report(E)


def report(E):
    L = E["length_m"].astype(np.float64)
    tot = L.sum()
    forest = E["forest_share"] / 100.0
    hw = E["highway"]
    sc = E["surface_class"]
    print(f"edges {len(L)}, length {tot / 1e3:.0f} km, forest share of length {np.sum(L * forest) / tot * 100:.0f} %")
    # check: our re-derived profile matches the parquet
    d_asc = np.abs(E["my_asc_f"] - E["ascent_fwd_m"])
    d_max = np.abs(np.clip(E["my_max_f"], 0, 100) - E["max_grade_fwd_pct"])
    print(f"reproduction: ascent |Δ| p50 {np.median(d_asc):.3f} m, p99 {np.percentile(d_asc, 99):.2f} m; "
          f"steepest 50 m |Δ| p50 {np.median(d_max):.3f} p99 {np.percentile(d_max, 99):.2f} pts")

    print("\n## Arc lengths")
    bins = [0, 50, 100, 200, 500, 1000, 2000, 1e9]
    names = ["< 50 m", "50–100", "100–200", "200–500", "0.5–1 km", "1–2 km", "> 2 km"]
    print("| length | edges | share of length | grade spread within (50 m windows, sd, pts) p50 / p90 |")
    print("|---|---:|---:|---:|")
    for lo, hi, nm in zip(bins[:-1], bins[1:], names):
        m = (L >= lo) & (L < hi)
        sd = E["my_std"][m]
        w = L[m]
        if m.sum() == 0:
            continue
        o = np.argsort(sd)
        cw = np.cumsum(w[o]) / w.sum()
        p50 = sd[o][np.searchsorted(cw, 0.5)]
        p90 = sd[o][np.searchsorted(cw, 0.9)]
        print(f"| {nm} | {m.sum() / len(L) * 100:.0f} % | {w.sum() / tot * 100:.0f} % | {p50:.1f} / {p90:.1f} |")
    wl = np.sort(L)
    cw = np.cumsum(wl) / tot
    print(f"length-weighted median edge {wl[np.searchsorted(cw, 0.5)]:.0f} m, edge median {np.median(L):.0f} m")

    # per arc (both directions): average climbing rate vs steepest 50 m (raw and tamed)
    print("\n## Average vs steepest 50 m (per arc, both directions, share of arc length)")
    LL = np.concatenate([L, L])
    asc = np.concatenate([E["ascent_fwd_m"], E["ascent_bwd_m"]]).astype(np.float64)
    mx = np.concatenate([E["max_grade_fwd_pct"], E["max_grade_bwd_pct"]]).astype(np.float64)
    fo = np.concatenate([forest, forest])
    avg = asc / np.maximum(LL, 1) * 100
    tm = tamed(mx, asc, LL, fo)
    for nm, g in [("raw", mx), ("tamed", tm)]:
        gap = g - avg
        print(f"{nm}: steepest − average > 3 pts {pct(gap > 3, LL)}, > 5 pts {pct(gap > 5, LL)}, > 8 pts {pct(gap > 8, LL)}; "
              f"of arcs with steepest > 8 %: {pct(gap[g > 8] > 4, LL[g > 8])} have average 4+ pts lower")
    # histogram view: how much of an arc's length is above X when its steepest 50 m says above X
    H = E["my_hist"]
    gv = np.arange(H_LO, H_HI + 1)
    print("\n| threshold | arc length with steepest 50 m (raw) ≥ X | of it, metres actually ≥ X (histogram) | arc length with average ≥ X | metres ≥ X in the network |")
    print("|---|---:|---:|---:|---:|")
    for X in [6, 8, 10, 12, 15]:
        sel = mx >= X
        above = np.concatenate([H[:, gv >= X].sum(axis=1), H[:, gv <= -X].sum(axis=1)]).astype(np.float64)
        print(f"| {X} % | {LL[sel].sum() / LL.sum() * 100:.1f} % | {above[sel].sum() / LL[sel].sum() * 100:.0f} % | "
              f"{LL[avg >= X].sum() / LL.sum() * 100:.1f} % | {above.sum() / LL.sum() * 100:.1f} % |")

    curve_section(E, L, LL, asc, mx, tm, fo, H, gv)

    # noise: canopy. paved roads (engineered) in forest vs open
    print("\n## Noise: the surface model under trees")
    wig = (E["ascent_fwd_m"] + E["ascent_bwd_m"] - np.abs(E["my_net"] * L / 100)) / np.maximum(L, 1) * 1000 / 2
    up_steps = H[:, gv >= 12].astype(np.float32).sum(axis=1) + H[:, gv <= -12].astype(np.float32).sum(axis=1)
    roads = np.isin(hw, [1, 2, 3, 4, 5, 6, 7, 8]) & (sc == 1)
    minor = np.isin(hw, [9, 10]) & (sc == 1)
    tracks = hw == 14
    print("| ways | in | length km | spurious up-and-down (m per km, each way) | metres steeper than ±12 % | raw−smoothed |Δz| m |")
    print("|---|---|---:|---:|---:|---:|")
    for nm, sel in [("main/tertiary roads, paved", roads), ("minor roads, paved", minor), ("tracks", tracks)]:
        for wh, fm in [("open (forest < 10 %)", forest < 0.1), ("forest (> 90 %)", forest > 0.9)]:
            m = sel & fm & (L >= 100)
            if m.sum() == 0:
                continue
            w = L[m]
            print(f"| {nm} | {wh} | {w.sum() / 1e3:.0f} | {np.sum(wig[m] * w) / w.sum():.1f} | "
                  f"{up_steps[m].sum() / w.sum() * 100:.2f} % | {np.sum(E['my_rough'][m] * w) / w.sum():.2f} |")

    # data model costs: an 8-nibble signed histogram per edge
    print("\n## A histogram per edge: size")
    edges8 = [-np.inf, -12, -8, -5, -2, 2, 5, 8, 12, np.inf]  # 9 bins, signed along
    centers = np.r_[gv]
    H9 = np.zeros((len(L), 9), dtype=np.float32)
    for i in range(9):
        H9[:, i] = H[:, (centers >= edges8[i]) & (centers < edges8[i + 1])].sum(axis=1)
    share = H9 / np.maximum(H9.sum(axis=1, keepdims=True), 1e-6)
    q = np.rint(share * 15).astype(np.uint8)
    # 8 nibbles (the 9th implied)
    packed = np.zeros(len(L), dtype=np.uint32)
    for i in range(8):
        packed |= (q[:, i].astype(np.uint32) & 15) << (4 * i)
    raw = packed.tobytes()
    gz = gzip.compress(raw, 6)
    print(f"9 signed bins, 4 bits each, 8 stored: raw {len(raw) / 1e6:.1f} MB, gzip {len(gz) / 1e6:.1f} MB "
          f"({len(gz) / len(L):.2f} B/edge)")
    # a smaller variant: 5 bins (|grade| < 3, 3–6, 6–10, 10–15, > 15) per direction, up only: down mirrors
    np.save(Path("/tmp/spike60") / f"hist9_{len(L)}.npy", share.astype(np.float32))


if __name__ == "__main__":
    main()
