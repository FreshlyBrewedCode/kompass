"""Stage 5: elevation per edge from Copernicus GLO-30 (a DSM: includes tree canopy and buildings).

Usage: python elevation.py <build_dir> <dem_dir>
Mosaics the GLO-30 tiles into one VRT, warps it to the metric CRS (25 m, bilinear), samples
every 10 m along each edge (bilinear), smooths each edge profile with a 50 m moving average
(ends kept so a node has one elevation for all its edges), and derives:
  ele_from_m, ele_to_m, ascent_fwd_m, ascent_bwd_m, max_grade_fwd/bwd (percent over >= 50 m,
  or the whole edge if shorter; edges < 20 m report the end-to-end grade only).
Output: elevation.parquet (same order as edges_raw.parquet).
"""
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import rasterio
from scipy import ndimage

import samples
import os

STEP = 10.0
SMOOTH = 5  # samples (50 m); override: KOMPASS_SMOOTH=<samples>
GRADE_BASE = 5  # samples (50 m)


def build_dem(build, dem_dir, region):
    vrt, tif = build / "dem.vrt", build / "dem_utm.tif"
    if not tif.exists():
        subprocess.run(["gdalbuildvrt", "-q", str(vrt), *map(str, sorted(Path(dem_dir).glob("*.tif")))], check=True)
        subprocess.run(["gdalwarp", "-q", "-overwrite", "-t_srs", samples.CRS, "-tr", "25", "25",
                        "-r", "bilinear", "-cutline", str(region), "-crop_to_cutline",
                        "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES", "-co", "PREDICTOR=3",
                        "-wm", "1024", "-multi", str(vrt), str(tif)], check=True)
    return tif


def segmented_moving_average(v, sedge, k):
    """Centered moving average of width k within each edge (window truncated at edge ends)."""
    c = np.concatenate([[0.0], np.cumsum(v, dtype=np.float64)])  # float64: float32 cumsum drifts
    i = np.arange(v.size)
    first = np.searchsorted(sedge, sedge, side="left")
    last = np.searchsorted(sedge, sedge, side="right") - 1
    lo = np.maximum(i - k // 2, first)
    hi = np.minimum(i + k // 2, last)
    return (c[hi + 1] - c[lo]) / (hi - lo + 1)


def main(build, dem_dir):
    build = Path(build)
    t0 = time.time()
    tif = build_dem(build, dem_dir, build / "region.geojson")
    t1 = time.time()
    print(f"dem mosaic+warp: {t1 - t0:.1f}s", flush=True)
    with rasterio.open(tif) as ds:
        dem = ds.read(1).astype(np.float32)
        inv = ~ds.transform
    edges = pq.read_table(build / "edges_raw.parquet", columns=["geometry"]).to_pandas()
    n = len(edges)
    x, y, part = samples.vertices(edges["geometry"].values)
    sx, sy, sedge, sd, _, length = samples.sample(x, y, part, n, step=STEP)
    del x, y, part, edges
    col, row = inv * (sx, sy)
    z = ndimage.map_coordinates(dem, [row - 0.5, col - 0.5], order=1, mode="nearest").astype(np.float64)
    del sx, sy, dem
    t2 = time.time()
    print(f"sample {z.size / 1e6:.1f} M points: {t2 - t1:.1f}s", flush=True)

    is_first = np.r_[True, sedge[1:] != sedge[:-1]]
    is_last = np.r_[sedge[1:] != sedge[:-1], True]
    zs = segmented_moving_average(z, sedge, int(os.environ.get("KOMPASS_SMOOTH", SMOOTH)))
    zs[is_first | is_last] = z[is_first | is_last]  # node elevation identical for all its edges
    dz = np.diff(zs)
    same = sedge[1:] == sedge[:-1]
    up = np.where(same & (dz > 0), dz, 0.0)
    down = np.where(same & (dz < 0), -dz, 0.0)
    asc_f = np.bincount(sedge[1:], weights=up, minlength=n)
    asc_b = np.bincount(sedge[1:], weights=down, minlength=n)
    # unsmoothed ascent, for the smoothing effect report
    dz_raw = np.diff(z)
    raw_up = np.bincount(sedge[1:], weights=np.where(same & (dz_raw > 0), dz_raw, 0.0), minlength=n)

    # max grade over a GRADE_BASE window (or whole edge when shorter)
    first = np.flatnonzero(is_first)
    last = np.flatnonzero(is_last)
    j = np.arange(z.size)
    tgt = np.minimum(j + GRADE_BASE, last[sedge])
    ok = (tgt > j) & ((tgt - j == GRADE_BASE) | (j == first[sedge]))
    dd = sd[tgt] - sd[j]
    g = np.where(ok & (dd > 0), (zs[tgt] - zs[j]) / np.maximum(dd, 1e-6) * 100, np.nan)
    gs = pd.Series(g)
    max_f = gs.groupby(sedge).max().reindex(range(n)).to_numpy(copy=True)
    max_b = (-gs).groupby(sedge).max().reindex(range(n)).to_numpy(copy=True)
    short = length < 20
    end_grade = (zs[last] - zs[first]) / np.maximum(length, 1e-6) * 100
    max_f[short] = np.maximum(end_grade[short], 0)
    max_b[short] = np.maximum(-end_grade[short], 0)

    out = pd.DataFrame({
        "ele_from_m": zs[first].astype(np.float32),
        "ele_to_m": zs[last].astype(np.float32),
        "ascent_fwd_m": asc_f.astype(np.float32),
        "ascent_bwd_m": asc_b.astype(np.float32),
        "max_grade_fwd_pct": np.clip(max_f, 0, 100).astype(np.float32),
        "max_grade_bwd_pct": np.clip(max_b, 0, 100).astype(np.float32),
        "ascent_fwd_raw_m": raw_up.astype(np.float32),  # spike diagnostics only
    })
    out.to_parquet(build / "elevation.parquet", compression="zstd")
    t3 = time.time()
    print(f"profiles+write: {t3 - t2:.1f}s; total {t3 - t0:.1f}s", flush=True)
    print(f"total ascent fwd: smoothed {asc_f.sum() / 1000:.0f} km, raw {raw_up.sum() / 1000:.0f} km")


if __name__ == "__main__":
    main(*sys.argv[1:3])
