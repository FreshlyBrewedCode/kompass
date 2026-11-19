"""Stage 4: context shares per edge by rasterising landuse to a 10 m grid and sampling edges.

Usage: python context.py <build_dir>
Inputs: edges_raw.parquet, context.geojsonseq (osmium export of forest / water / built-up),
region.geojson (grid extent). Output: context.parquet (one row per edge, same order).

Definitions (cell = 10 m):
  forest_share       sample inside landuse=forest / natural=wood
  forest_edge_share  sample within 30 m outside a forest, or within 10 m inside its boundary
  water_share        sample within 100 m of a water area (lake, river area) or river/canal line
  builtup_share      sample inside residential / commercial / industrial / retail / ... landuse
  road_near_share    sample within 20 m of a motor road (trunk..residential, not the edge itself
                     unless it is one) -> "separate cycle path along the road vs. away from it"
"""
import sys
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import rasterio.features
import shapely
from rasterio.transform import from_origin
from scipy import ndimage

import samples

RES = 10.0
FOREST = {"forest", "wood"}
BUILTUP = {"residential", "commercial", "industrial", "retail", "construction", "garages",
           "railway", "farmyard", "cemetery", "allotments"}
ROAD_CODES = set(range(1, 12))  # trunk .. living_street in tags.HIGHWAY


def octagon(r):
    """Disk-like structuring element of radius r cells."""
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    return (xx * xx + yy * yy) <= r * r + 0.5


def dilate(a, r):
    return ndimage.binary_dilation(a, structure=octagon(r))


def main(build):
    build = Path(build)
    t0 = time.time()
    lu = gpd.read_file(build / "context.geojsonseq", engine="pyogrio",
                       columns=["landuse", "natural", "waterway", "water"])
    lu = lu.to_crs(samples.CRS)
    t1 = time.time()
    print(f"read+project {len(lu)} context features: {t1 - t0:.1f}s", flush=True)

    region = gpd.read_file(build / "region.geojson").to_crs(samples.CRS).buffer(500)
    minx, miny, maxx, maxy = region.total_bounds
    w, h = int(np.ceil((maxx - minx) / RES)), int(np.ceil((maxy - miny) / RES))
    tf = from_origin(minx, maxy, RES, RES)
    print(f"grid {w} x {h} = {w * h / 1e6:.0f} M cells", flush=True)

    poly = lu.geom_type.isin(["Polygon", "MultiPolygon"])
    forest_g = lu[poly & (lu["landuse"].isin(FOREST) | lu["natural"].isin(FOREST))].geometry
    built_g = lu[poly & lu["landuse"].isin(BUILTUP)].geometry
    water_area = lu[poly & ((lu["natural"] == "water") | (lu["waterway"] == "riverbank"))].geometry
    water_area = water_area[water_area.area >= 5000]  # drop ponds below 0.5 ha
    water_line = lu[~poly & lu["waterway"].isin(["river", "canal"])].geometry

    def rast(geoms, all_touched=False):
        return rasterio.features.rasterize(((g, 1) for g in geoms), out_shape=(h, w), transform=tf,
                                           fill=0, dtype="uint8", all_touched=all_touched).astype(bool)

    forest = rast(forest_g)
    t2 = time.time()
    print(f"rasterise forest ({len(forest_g)}): {t2 - t1:.1f}s", flush=True)
    rim = dilate(forest, 3) & ~ndimage.binary_erosion(forest, structure=octagon(1))
    t3 = time.time()
    print(f"forest rim morphology: {t3 - t2:.1f}s", flush=True)
    built = rast(built_g)
    water = rast(water_area) | rast(water_line, all_touched=True)
    water = dilate(water, 10)
    t4 = time.time()
    print(f"built-up + water (dilate 100 m): {t4 - t3:.1f}s", flush=True)

    edges = pq.read_table(build / "edges_raw.parquet", columns=["geometry", "tag_highway"]).to_pandas()
    n = len(edges)
    x, y, part = samples.vertices(edges["geometry"].values)
    import tags  # highway code mapping
    hw = pd.Categorical(edges["tag_highway"].where(edges["tag_highway"].isin(tags.HIGHWAY), "other"),
                        categories=tags.HIGHWAY).codes
    is_road = np.isin(hw, list(ROAD_CODES))
    road_idx = np.flatnonzero(is_road)
    road_lines = shapely.from_wkb(edges["geometry"].values[road_idx])
    road_lines = gpd.GeoSeries(road_lines, crs=4326).to_crs(samples.CRS)
    road = dilate(rast(road_lines, all_touched=True), 2)
    t5 = time.time()
    print(f"road raster ({len(road_idx)} road edges): {t5 - t4:.1f}s", flush=True)

    sx, sy, sedge, sd, wgt, length = samples.sample(x, y, part, n, step=RES)
    del x, y, part
    col = np.clip(((sx - minx) / RES).astype(np.int64), 0, w - 1)
    row = np.clip(((maxy - sy) / RES).astype(np.int64), 0, h - 1)
    t6 = time.time()
    print(f"sampling: {sx.size / 1e6:.1f} M samples, {t6 - t5:.1f}s", flush=True)

    out = pd.DataFrame({
        "forest_share": samples.weighted_share(forest[row, col], sedge, wgt, n),
        "forest_edge_share": samples.weighted_share(rim[row, col], sedge, wgt, n),
        "water_share": samples.weighted_share(water[row, col], sedge, wgt, n),
        "builtup_share": samples.weighted_share(built[row, col], sedge, wgt, n),
        "road_near_share": samples.weighted_share(road[row, col], sedge, wgt, n),
    })
    out.loc[is_road, "road_near_share"] = 1.0  # a road is on the road
    out = (out * 100).round().astype(np.uint8)  # quantised: percent of edge length
    out.to_parquet(build / "context.parquet", compression="zstd")
    t7 = time.time()
    print(f"lookup+write: {t7 - t6:.1f}s; total {t7 - t0:.1f}s", flush=True)


if __name__ == "__main__":
    main(sys.argv[1])
