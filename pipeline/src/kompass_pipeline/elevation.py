"""Stage `elevation`: elevation profiles per edge from any DEM, behind a one-function interface.

A DEM is an `ElevationFn`: metric coordinates (x, y in the pipeline's CRS, `Region.crs`) in,
elevations in metres out. `dem_glo30.py` is the Copernicus implementation; a bare-ground model
(DGM1, FABDEM) replaces it by providing another function; nothing here changes.

Every edge is sampled every 10 m, the profile is smoothed with a 50 m moving average (the ends keep
their raw value, so every edge at a node agrees on its elevation), and from it come the elevation at
both ends, the ascent per direction and the steepest 50 m stretch per direction.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from . import samples

ElevationFn = Callable[[np.ndarray, np.ndarray], np.ndarray]

STEP = 10.0  # m between samples
SMOOTH = 5  # samples (50 m)
GRADE_BASE = 5  # samples (50 m)


def segmented_moving_average(v: np.ndarray, sedge: np.ndarray, k: int) -> np.ndarray:
    """Centered moving average of width k within each edge (window truncated at the edge ends)."""
    c = np.concatenate([[0.0], np.cumsum(v, dtype=np.float64)])  # float64: float32 cumsum drifts
    i = np.arange(v.size)
    first = np.searchsorted(sedge, sedge, side="left")
    last = np.searchsorted(sedge, sedge, side="right") - 1
    lo = np.maximum(i - k // 2, first)
    hi = np.minimum(i + k // 2, last)
    return (c[hi + 1] - c[lo]) / (hi - lo + 1)


def profiles(x, y, part, n: int, elevation: ElevationFn, *, smooth: int = SMOOTH) -> pd.DataFrame:
    """The elevation columns of the schema for edges given as metric vertices."""
    sx, sy, sedge, sd, _, length = samples.sample(x, y, part, n, step=STEP)
    z = np.asarray(elevation(sx, sy), dtype=np.float64)
    del sx, sy

    is_first = np.r_[True, sedge[1:] != sedge[:-1]]
    is_last = np.r_[sedge[1:] != sedge[:-1], True]
    zs = segmented_moving_average(z, sedge, smooth)
    zs[is_first | is_last] = z[is_first | is_last]
    dz = np.diff(zs)
    same = sedge[1:] == sedge[:-1]
    asc_f = np.bincount(sedge[1:], weights=np.where(same & (dz > 0), dz, 0.0), minlength=n)
    asc_b = np.bincount(sedge[1:], weights=np.where(same & (dz < 0), -dz, 0.0), minlength=n)

    # max grade over a GRADE_BASE window (the whole edge when shorter)
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
    # very short edges: the end-to-end grade
    short = length < 20
    end_grade = (zs[last] - zs[first]) / np.maximum(length, 1e-6) * 100
    max_f[short] = np.maximum(end_grade[short], 0)
    max_b[short] = np.maximum(-end_grade[short], 0)

    return pd.DataFrame(
        {
            "ele_from_m": zs[first].astype(np.float32),
            "ele_to_m": zs[last].astype(np.float32),
            "ascent_fwd_m": asc_f.astype(np.float32),
            "ascent_bwd_m": asc_b.astype(np.float32),
            "max_grade_fwd_pct": np.clip(np.nan_to_num(max_f), 0, 100).astype(np.float32),
            "max_grade_bwd_pct": np.clip(np.nan_to_num(max_b), 0, 100).astype(np.float32),
        }
    )


def run(raw: Path, crs: str, elevation: ElevationFn, out: Path) -> None:
    t0 = time.time()
    geometry = pq.read_table(raw, columns=["geometry"]).column("geometry").to_numpy()
    n = len(geometry)
    x, y, part = samples.vertices(geometry, crs)
    del geometry
    profiles(x, y, part, n, elevation).to_parquet(out, compression="zstd")
    print(f"  profiles: {time.time() - t0:.0f}s")
