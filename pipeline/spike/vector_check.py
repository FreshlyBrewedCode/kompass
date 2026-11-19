"""Spike check: forest share by exact vector intersection (geopandas/STRtree) on a random sample
of edges, to compare speed and agreement with the raster approach in context.py.
Usage: python vector_check.py <build_dir> [n_sample]"""
import sys
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

build = Path(sys.argv[1])
n = int(sys.argv[2]) if len(sys.argv) > 2 else 100_000
t0 = time.time()
lu = gpd.read_file(build / "context.geojsonseq", engine="pyogrio", columns=["landuse", "natural"])
forest = lu[lu.geom_type.isin(["Polygon", "MultiPolygon"])
            & (lu["landuse"].isin(["forest", "wood"]) | lu["natural"].isin(["forest", "wood"]))]
forest = forest.to_crs("EPSG:25832").geometry.values
shapely.prepare(forest)
edges = pd.read_parquet(build / "edges_raw.parquet", columns=["geometry"])
ctx = pd.read_parquet(build / "context.parquet", columns=["forest_share"])
rng = np.random.default_rng(1)
idx = np.sort(rng.choice(len(edges), n, replace=False))
lines = gpd.GeoSeries(shapely.from_wkb(edges["geometry"].values[idx]), crs=4326).to_crs("EPSG:25832").values
t1 = time.time()
tree = shapely.STRtree(forest)
li, pi = tree.query(lines, predicate="intersects")
inter = shapely.length(shapely.intersection(lines[li], forest[pi]))
share = np.bincount(li, weights=inter, minlength=n) / np.maximum(shapely.length(lines), 1e-9)
t2 = time.time()
raster = ctx["forest_share"].values[idx] / 100
L = shapely.length(lines)
print(f"vector forest share on {n} edges: {t2 - t1:.1f}s (+{t1 - t0:.1f}s load) "
      f"-> ~{(t2 - t1) * 2.35e6 / n / 60:.1f} min for all edges")
print(f"length-weighted forest share: vector {np.sum(share * L) / L.sum():.4f} raster {np.sum(raster * L) / L.sum():.4f}")
print(f"mean abs diff per edge {np.mean(np.abs(share.clip(0, 1) - raster)):.4f}; "
      f"edges with |diff|>0.2: {np.mean(np.abs(share.clip(0, 1) - raster) > 0.2):.4f}")
