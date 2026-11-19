"""Copernicus GLO-30 (30 m, public AWS bucket, no login) as an `ElevationFn`.

GLO-30 is a surface model: it includes tree canopy and buildings. That is fine for coarse climbs in
open land and on roads, but too noisy for gradients on forest tracks; a bare-ground model replaces
it later through the same interface (see `elevation.py`).
"""

from __future__ import annotations

import math
import urllib.error
from pathlib import Path

import numpy as np
import rasterio
from scipy import ndimage

from . import tools
from .config import Region
from .elevation import ElevationFn
from .net import download

BUCKET = "https://copernicus-dem-30m.s3.amazonaws.com"
WARP_RES = 25  # m, the DEM is resampled to this metric grid
MARGIN_M = 3000  # beyond the region disk, for edges the clip keeps whole


def tile_name(lat: int, lon: int) -> str:
    ns, ew = ("N" if lat >= 0 else "S"), ("E" if lon >= 0 else "W")
    return f"Copernicus_DSM_COG_10_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM"


def tiles_for(region: Region) -> list[tuple[int, int]]:
    minx, miny, maxx, maxy = region.circle(extra_km=1).bounds
    return [
        (lat, lon)
        for lat in range(math.floor(miny), math.floor(maxy) + 1)
        for lon in range(math.floor(minx), math.floor(maxx) + 1)
    ]


def fetch_tiles(region: Region, dem_dir: Path) -> list[Path]:
    """Downloads the 1x1 degree tiles covering the region into `dem_dir` (cached). Tiles over open
    sea do not exist in the bucket and are skipped."""
    paths = []
    for lat, lon in tiles_for(region):
        name = tile_name(lat, lon)
        try:
            paths.append(download(f"{BUCKET}/{name}/{name}.tif", dem_dir / f"{name}.tif"))
        except urllib.error.HTTPError as e:
            if e.code not in (403, 404):
                raise
    if not paths:
        raise RuntimeError("no GLO-30 tiles cover the region")
    return paths


def open_glo30(region: Region, dem_dir: Path, work: Path) -> ElevationFn:
    """Mosaics the tiles, warps them to the region's metric CRS (25 m, bilinear, the region square plus
    a margin) into `work/dem_metric.tif`, and returns a bilinear sampler on it."""
    tiles = fetch_tiles(region, dem_dir)
    tif = work / "dem_metric.tif"
    tools.require("gdalwarp")
    vrt, part = work / "dem.vrt", work / "dem_metric.part.tif"
    r = region.radius_km * 1000 + MARGIN_M  # the metric CRS is centred on the region
    tools.run(["gdalbuildvrt", "-q", vrt, *tiles])
    tools.run(
        [
            "gdalwarp",
            "-q",
            "-overwrite",
            "-t_srs",
            region.crs,
            "-tr",
            str(WARP_RES),
            str(WARP_RES),
            "-te",
            str(-r),
            str(-r),
            str(r),
            str(r),
            "-r",
            "bilinear",
            "-co",
            "COMPRESS=DEFLATE",
            "-co",
            "TILED=YES",
            "-co",
            "PREDICTOR=3",
            "-wm",
            "1024",
            "-multi",
            vrt,
            part,
        ]
    )
    part.replace(tif)
    vrt.unlink(missing_ok=True)
    with rasterio.open(tif) as ds:
        dem = ds.read(1).astype(np.float32)
        inv = ~ds.transform
    tif.unlink()

    def elevation(x: np.ndarray, y: np.ndarray) -> np.ndarray:
        col, row = inv * (x, y)
        return ndimage.map_coordinates(dem, [row - 0.5, col - 0.5], order=1, mode="nearest")

    return elevation
