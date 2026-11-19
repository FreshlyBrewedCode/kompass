"""Stage 7: join raw edges + tags + context + elevation + graph -> edges.parquet (GeoParquet 1.1).

Usage: python finalize.py <build_dir>
- drops edges in components smaller than graph.py's threshold;
- sorts by a Hilbert key of the edge midpoint on the global web-mercator z16 tile grid, so
  every z<=16 tile (and every engine tile on that grid) is a contiguous run of rows, and row
  groups have tight bbox statistics; edge_id = row number after sorting;
- WKB geometry (EPSG:4326, float64), the most interoperable GeoParquet encoding (DuckDB, GDAL).
"""
import sys
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

import tags

ROW_GROUP = 131072


def hilbert_d(x, y, order=16):
    """Hilbert index of integer grid cells (vectorised, classic xy2d)."""
    x = x.astype(np.uint64).copy()
    y = y.astype(np.uint64).copy()
    d = np.zeros_like(x)
    s = np.uint64(1 << (order - 1))
    while s > 0:
        rx = ((x & s) > 0).astype(np.uint64)
        ry = ((y & s) > 0).astype(np.uint64)
        d += s * s * ((np.uint64(3) * rx) ^ ry)
        n = np.uint64(1 << order) - np.uint64(1)
        swap = ry == 0
        flip = swap & (rx == 1)
        x = np.where(flip, n - x, x)
        y = np.where(flip, n - y, y)
        x, y = np.where(swap, y, x), np.where(swap, x, y)
        s >>= np.uint64(1)
    return d


def z16_tile(lon, lat):
    n = 1 << 16
    x = np.floor((lon + 180) / 360 * n)
    lr = np.radians(lat)
    y = np.floor((1 - np.log(np.tan(lr) + 1 / np.cos(lr)) / np.pi) / 2 * n)
    return np.clip(x, 0, n - 1), np.clip(y, 0, n - 1)


def main(build):
    build = Path(build)
    t0 = time.time()
    raw = pd.read_parquet(build / "edges_raw.parquet")
    a = tags.derive(raw)
    ctx = pd.read_parquet(build / "context.parquet")
    ele = pd.read_parquet(build / "elevation.parquet").drop(columns=["ascent_fwd_raw_m"])
    g = pd.read_parquet(build / "graph.parquet")
    t1 = time.time()
    print(f"read+derive: {t1 - t0:.1f}s", flush=True)

    base = raw[["way_id", "way_pos_from", "way_pos_to", "node_from", "node_to", "length_m",
                "route_level", "mtb_route", "n_barriers"]]
    df = pd.concat([base, a, ctx, ele.round(1), g[["bridge", "pocket_km", "pocket_dir"]]], axis=1)
    df["pocket_km"] = df["pocket_km"].round(3)
    geom = shapely.from_wkb(raw["geometry"].values)
    keep = g["keep"].values
    df, geom = df[keep].reset_index(drop=True), geom[keep]

    mid = shapely.line_interpolate_point(geom, 0.5, normalized=True)
    tx, ty = z16_tile(shapely.get_x(mid), shapely.get_y(mid))
    key = hilbert_d(tx, ty)
    order = np.lexsort((df["way_pos_from"].values, df["way_id"].values, key))
    df, geom, key = df.iloc[order].reset_index(drop=True), geom[order], key[order]
    df.insert(0, "edge_id", np.arange(len(df), dtype=np.uint32))
    df.insert(1, "hilbert_z16", key.astype(np.uint32))
    t2 = time.time()
    print(f"join+sort: {t2 - t1:.1f}s", flush=True)

    gdf = gpd.GeoDataFrame(df, geometry=gpd.GeoSeries(geom, crs="EPSG:4326"))
    for c in ("service", "surface", "name", "ref"):
        gdf[c] = gdf[c].astype("category")  # dictionary-encoded strings
    # No bbox covering column: it cost +58 MB (24 %) and the consumers read the whole file or
    # filter on hilbert_z16. Delta / byte-stream-split on the id and float columns: -25 %.
    gdf.to_parquet(build / "edges.parquet", compression="zstd", compression_level=9,
                   row_group_size=ROW_GROUP, schema_version="1.1.0",
                   use_dictionary=["service", "surface", "name", "ref"],
                   column_encoding={"edge_id": "DELTA_BINARY_PACKED", "hilbert_z16": "DELTA_BINARY_PACKED",
                                    "length_m": "BYTE_STREAM_SPLIT"})
    t3 = time.time()
    size = (build / "edges.parquet").stat().st_size
    print(f"write: {t3 - t2:.1f}s; {len(df)} edges, {size / 1e6:.1f} MB; total {t3 - t0:.1f}s", flush=True)


if __name__ == "__main__":
    main(sys.argv[1])
