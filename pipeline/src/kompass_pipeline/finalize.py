"""Stage `finalize`: join raw edges, tags, context, elevation and graph into `edges.parquet`.

- drops the pruned components' edges;
- sorts by a Hilbert key of the edge midpoint on the global web-mercator z16 tile grid, so every
  z <= 16 tile (and every engine tile on that grid) is a contiguous run of rows and the row groups
  have tight bounds; `edge_id` is the row number after sorting;
- writes GeoParquet 1.1 (WKB geometry in EPSG:4326) with the schema version, the enum code tables
  and the build id in the key-value metadata.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import shapely

from . import schema, tags

ROW_GROUP = 131072
Z16 = 16


def hilbert_d(x: np.ndarray, y: np.ndarray, order: int = Z16) -> np.ndarray:
    """Hilbert index of integer grid cells (vectorised, classic xy2d)."""
    x = x.astype(np.uint64).copy()
    y = y.astype(np.uint64).copy()
    d = np.zeros_like(x)
    s = np.uint64(1 << (order - 1))
    n = np.uint64((1 << order) - 1)
    while s > 0:
        rx = ((x & s) > 0).astype(np.uint64)
        ry = ((y & s) > 0).astype(np.uint64)
        d += s * s * ((np.uint64(3) * rx) ^ ry)
        swap = ry == 0
        flip = swap & (rx == 1)
        x = np.where(flip, n - x, x)
        y = np.where(flip, n - y, y)
        x, y = np.where(swap, y, x), np.where(swap, x, y)
        s >>= np.uint64(1)
    return d


def z16_tile(lon: np.ndarray, lat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Web-mercator z16 tile indices of lon/lat points."""
    n = 1 << Z16
    x = np.floor((lon + 180) / 360 * n)
    lr = np.radians(lat)
    y = np.floor((1 - np.log(np.tan(lr) + 1 / np.cos(lr)) / np.pi) / 2 * n)
    return np.clip(x, 0, n - 1), np.clip(y, 0, n - 1)


def hilbert_order(
    geoms: np.ndarray, way_id: np.ndarray, way_pos: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """(sort order, hilbert key) for line strings; ties break by way id and position."""
    mid = shapely.line_interpolate_point(geoms, 0.5, normalized=True)
    tx, ty = z16_tile(shapely.get_x(mid), shapely.get_y(mid))
    key = hilbert_d(tx, ty)
    order = np.lexsort((way_pos, way_id, key))
    return order, key[order]


def new_build_id() -> str:
    return uuid.uuid4().hex[:12]


def geo_metadata(geoms: np.ndarray) -> str:
    """The GeoParquet 1.1 `geo` key."""
    w, s, e, n = shapely.total_bounds(geoms).tolist()
    return json.dumps(
        {
            "version": "1.1.0",
            "primary_column": "geometry",
            "columns": {
                "geometry": {"encoding": "WKB", "geometry_types": ["LineString"], "bbox": [w, s, e, n]}
            },
        }
    )


def assemble(
    raw: pd.DataFrame, ctx: pd.DataFrame, ele: pd.DataFrame, keep: np.ndarray
) -> tuple[pd.DataFrame, np.ndarray]:
    """The final frame (schema columns, sorted, ids assigned) and its geometries (shapely)."""
    a = tags.derive(raw)
    base = raw[
        [
            "way_id",
            "way_pos_from",
            "way_pos_to",
            "node_from",
            "node_to",
            "length_m",
            "route_level",
            "mtb_route",
            "n_barriers",
        ]
    ]
    df = pd.concat([base, a, ctx, ele.round(1)], axis=1)
    geom = shapely.from_wkb(raw["geometry"].to_numpy())
    df, geom = df[keep].reset_index(drop=True), geom[keep]
    order, key = hilbert_order(geom, df["way_id"].to_numpy(), df["way_pos_from"].to_numpy())
    df, geom = df.iloc[order].reset_index(drop=True), geom[order]
    df.insert(0, "edge_id", np.arange(len(df), dtype=np.uint32))
    df.insert(1, "hilbert_z16", key.astype(np.uint32))
    df["geometry"] = shapely.to_wkb(geom)
    return df, geom


def write(df: pd.DataFrame, geom: np.ndarray, out: Path, build_id: str) -> None:
    sch = schema.arrow_schema()
    names = [c.name for c in schema.COLUMNS]
    table = pa.Table.from_pandas(df[names], schema=sch, preserve_index=False)
    meta = {**schema.file_metadata(build_id), "geo": geo_metadata(geom)}
    table = table.replace_schema_metadata(meta)
    dict_cols = [c.name for c in schema.COLUMNS if c.dictionary]
    # No bbox covering column (it cost +24 %), delta encoding on the ids and byte-stream-split on the
    # length: -25 % (spike #3). Dictionary encoding only on the low-cardinality strings.
    pq.write_table(
        table,
        out,
        compression="zstd",
        compression_level=9,
        row_group_size=ROW_GROUP,
        use_dictionary=dict_cols,
        column_encoding={
            "edge_id": "DELTA_BINARY_PACKED",
            "hilbert_z16": "DELTA_BINARY_PACKED",
            "length_m": "BYTE_STREAM_SPLIT",
        },
    )


def run(raw: Path, ctx: Path, ele: Path, graph: Path, out: Path, log=print) -> None:
    t0 = time.time()
    keep = pd.read_parquet(graph)["keep"].to_numpy()
    df, geom = assemble(pd.read_parquet(raw), pd.read_parquet(ctx), pd.read_parquet(ele), keep)
    log(f"  joined and sorted {len(df)} edges: {time.time() - t0:.0f}s")
    tmp = out.with_name(out.name + ".part")
    write(df, geom, tmp, new_build_id())
    tmp.replace(out)
    log(f"  {out.name}: {out.stat().st_size / 1e6:.1f} MB")
