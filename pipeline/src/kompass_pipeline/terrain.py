"""Stage `terrain`: the relief the map draws, from the same DEM as the elevation profiles.

Two archives:
- `terrain.pmtiles`: raster-DEM tiles (Terrarium encoding, lossless PNG, 256 px, z6..12) for
  MapLibre's `hillshade` layer. z12 is the DEM's own resolution (a 30 m model, 25 m pixels at 48
  degrees north); MapLibre overzooms past it.
- `contours.pmtiles`: contour lines as vector tiles (layer `contours`, attribute `ele` in metres):
  every 100 m from z10, every 20 m from z13, every 10 m at z14. Precomputed rather than traced in
  the browser: no work on the phone, and the DEM can be smoothed first (it is a surface model, so
  tree canopy makes raw 10 m lines ragged).

The DEM is an `ElevationFn` like in `elevation.py`, so a bare-ground model replaces GLO-30 here too.
The function is sampled on the web-mercator pixel grid of the deepest zoom, in strips.
"""

from __future__ import annotations

import json
import math
import sqlite3
import time
import warnings
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.errors import NotGeoreferencedWarning
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from scipy import ndimage

from . import tools
from .config import Region
from .elevation import ElevationFn

TILE = 256
DEM_MINZOOM = 6
DEM_MAXZOOM = 12
#: elevations are rounded to this step (m): the blue channel then holds two values and PNG compresses well
QUANTUM = 0.5

CONTOUR_LAYER = "contours"
CONTOUR_MINZOOM = 10
CONTOUR_MAXZOOM = 14
CONTOUR_INTERVAL = 10  # m, the finest lines
#: (first zoom, interval in m): each interval is a multiple of the next, so zooming in only adds lines
CONTOUR_STEPS = ((10, 100), (13, 20), (14, 10))
#: Gaussian blur before contouring, in pixels of the deepest zoom
CONTOUR_SMOOTH = 1.5
#: closed lines shorter than this are canopy noise (m, web-mercator: about 2/3 of that on the ground)
CONTOUR_MIN_LENGTH = 400

#: shown by the map; another DEM passes its own credit
ATTRIBUTION = "Copernicus DEM GLO-30"

EARTH = 20037508.342789244  # half the web-mercator world, m
STRIP = 256  # grid rows sampled per call of the elevation function


def tile_range(bounds: tuple[float, float, float, float], zoom: int) -> tuple[int, int, int, int]:
    """(x0, y0, x1, y1), inclusive: the tiles of `zoom` touching (west, south, east, north)."""
    west, south, east, north = bounds
    n = 2**zoom

    def tx(lon: float) -> int:
        return min(n - 1, max(0, math.floor((lon + 180) / 360 * n)))

    def ty(lat: float) -> int:
        y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2
        return min(n - 1, max(0, math.floor(y * n)))

    return tx(west), ty(north), tx(east), ty(south)


def sample_grid(region: Region, elevation: ElevationFn, zoom: int) -> tuple[np.ndarray, int, int]:
    """The DEM on the pixel grid of the `zoom` tiles covering the region: (heights, first tile x, y)."""
    x0, y0, x1, y1 = tile_range(region.bounds(), zoom)
    width, height = (x1 - x0 + 1) * TILE, (y1 - y0 + 1) * TILE
    res = 2 * EARTH / (TILE * 2**zoom)
    to_metric = Transformer.from_crs("EPSG:3857", region.crs, always_xy=True)
    mx = -EARTH + (x0 * TILE + np.arange(width) + 0.5) * res
    out = np.empty((height, width), np.float32)
    for row in range(0, height, STRIP):
        rows = np.arange(row, min(row + STRIP, height))
        my = EARTH - (y0 * TILE + rows + 0.5) * res
        gx, gy = np.meshgrid(mx, my)
        px, py = to_metric.transform(gx.ravel(), gy.ravel())
        out[rows[0] : rows[-1] + 1] = np.asarray(elevation(px, py), np.float32).reshape(gx.shape)
    return np.nan_to_num(out), x0, y0


def encode_terrarium(heights: np.ndarray) -> np.ndarray:
    """Heights (m) as Terrarium RGB, uint8 (3, h, w): height = R * 256 + G + B / 256 - 32768."""
    v = np.round(heights.astype(np.float64) / QUANTUM) * QUANTUM + 32768.0
    whole = np.floor(v)
    return np.stack([whole // 256, whole % 256, (v - whole) * 256]).astype(np.uint8)


def decode_terrarium(rgb: np.ndarray) -> np.ndarray:
    r, g, b = (rgb[i].astype(np.float64) for i in range(3))
    return r * 256 + g + b / 256 - 32768


def png(rgb: np.ndarray) -> bytes:
    with warnings.catch_warnings(), MemoryFile() as mem:
        warnings.simplefilter("ignore", NotGeoreferencedWarning)  # a tile image carries no geotransform
        with mem.open(driver="PNG", width=rgb.shape[2], height=rgb.shape[1], count=3, dtype="uint8") as ds:
            ds.write(rgb)
        return mem.read()


def halve(grid: np.ndarray, x0: int, y0: int) -> tuple[np.ndarray, int, int]:
    """The grid one zoom up (2x2 means). Padded to whole parent tiles first, by mirroring: a tile that
    reaches past the DEM continues the terrain instead of ending in a cliff or in streaks."""
    tiles_y, tiles_x = grid.shape[0] // TILE, grid.shape[1] // TILE
    pad_y = (y0 % 2, (y0 + tiles_y) % 2)
    pad_x = (x0 % 2, (x0 + tiles_x) % 2)
    g = np.pad(
        grid, ((pad_y[0] * TILE, pad_y[1] * TILE), (pad_x[0] * TILE, pad_x[1] * TILE)), mode="symmetric"
    )
    g = g.reshape(g.shape[0] // 2, 2, g.shape[1] // 2, 2).mean(axis=(1, 3), dtype=np.float32)
    return g, x0 // 2, y0 // 2


def pyramid(grid: np.ndarray, x0: int, y0: int, zoom: int, minzoom: int):
    """Yields (z, x, y, heights of one tile), from `zoom` up to `minzoom`."""
    for z in range(zoom, minzoom - 1, -1):
        for ty in range(grid.shape[0] // TILE):
            for tx in range(grid.shape[1] // TILE):
                yield z, x0 + tx, y0 + ty, grid[ty * TILE : (ty + 1) * TILE, tx * TILE : (tx + 1) * TILE]
        if z > minzoom:
            grid, x0, y0 = halve(grid, x0, y0)


def write_mbtiles(path: Path, tiles, bounds: tuple[float, float, float, float], attribution: str) -> int:
    path.unlink(missing_ok=True)
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE metadata (name TEXT, value TEXT)")
    db.execute(
        "CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)"
    )
    db.execute("CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row)")
    n = 0
    for z, x, y, heights in tiles:
        # MBTiles rows count from the south
        db.execute(
            "INSERT INTO tiles VALUES (?, ?, ?, ?)", (z, x, 2**z - 1 - y, png(encode_terrarium(heights)))
        )
        n += 1
    meta = {
        "name": "kompass-terrain",
        "format": "png",
        "type": "baselayer",
        "minzoom": DEM_MINZOOM,
        "maxzoom": DEM_MAXZOOM,
        "bounds": ",".join(f"{v:.5f}" for v in bounds),
        "encoding": "terrarium",
        "attribution": attribution,
    }
    db.executemany("INSERT INTO metadata VALUES (?, ?)", [(k, str(v)) for k, v in meta.items()])
    db.commit()
    db.close()
    return n


def dem_tiles(grid: np.ndarray, x0: int, y0: int, bounds, work: Path, out: Path, attribution: str) -> None:
    tools.require("pmtiles")
    mb, tmp = work / "terrain.mbtiles", out.with_name("terrain.part.pmtiles")
    n = write_mbtiles(mb, pyramid(grid, x0, y0, DEM_MAXZOOM, DEM_MINZOOM), bounds, attribution)
    tmp.unlink(missing_ok=True)
    tools.run(["pmtiles", "convert", mb, tmp], capture_output=True)
    tmp.replace(out)
    mb.unlink()
    print(f"  terrain.pmtiles: {n} tiles, {out.stat().st_size / 1e6:.1f} MB", flush=True)


def contour_filter() -> list:
    """The tippecanoe feature filter that thins the lines by zoom (`CONTOUR_STEPS`)."""
    arms: list = []
    for zoom, interval in CONTOUR_STEPS:
        keep = [">=", "$zoom", zoom]
        arms.append(keep if interval == CONTOUR_INTERVAL else ["all", keep, ["==", f"m{interval}", 1]])
    return ["any", *arms]


def contours(grid: np.ndarray, x0: int, y0: int, work: Path, out: Path, attribution: str) -> None:
    for tool in ("gdal_contour", "ogr2ogr", "tippecanoe"):
        tools.require(tool)
    res = 2 * EARTH / (TILE * 2**DEM_MAXZOOM)
    smooth = ndimage.gaussian_filter(grid, CONTOUR_SMOOTH, mode="nearest")
    tif, raw, seq = work / "contour_dem.tif", work / "contours_raw.gpkg", work / "contours.geojsonseq"
    profile = {
        "driver": "GTiff",
        "width": smooth.shape[1],
        "height": smooth.shape[0],
        "count": 1,
        "dtype": "float32",
        "crs": "EPSG:3857",
        "transform": from_origin(-EARTH + x0 * TILE * res, EARTH - y0 * TILE * res, res, res),
        "compress": "deflate",
    }
    with rasterio.open(tif, "w", **profile) as ds:
        ds.write(smooth, 1)
    del smooth
    for f in (raw, seq):
        f.unlink(missing_ok=True)
    tools.run(["gdal_contour", "-q", "-a", "ele", "-i", CONTOUR_INTERVAL, "-nln", "contour", tif, raw])
    coarser = [interval for _, interval in CONTOUR_STEPS if interval != CONTOUR_INTERVAL]
    flags = ", ".join(f"(CAST(ele AS INTEGER) % {i} = 0) AS m{i}" for i in coarser)
    sql = (
        f"SELECT geom, CAST(ele AS INTEGER) AS ele, {flags} FROM contour "
        f"WHERE ST_Length(geom) >= {CONTOUR_MIN_LENGTH} OR NOT ST_IsClosed(geom)"
    )
    tools.run(
        [
            *("ogr2ogr", "-q", "-f", "GeoJSONSeq", "-t_srs", "EPSG:4326", "-lco", "COORDINATE_PRECISION=6"),
            *("-dialect", "SQLite", "-sql", sql, seq, raw),
        ]
    )
    tmp = out.with_name("contours.part.pmtiles")
    tools.run(
        [
            *("tippecanoe", "-q", "-f", "-o", tmp, "-l", CONTOUR_LAYER),
            *(f"-Z{CONTOUR_MINZOOM}", f"-z{CONTOUR_MAXZOOM}"),
            *("--no-feature-limit", "--no-tile-size-limit", "--simplification=4"),
            *("-j", json.dumps({CONTOUR_LAYER: contour_filter()})),
            *("-n", "kompass-contours", "-A", attribution, seq),
        ]
    )
    tmp.replace(out)
    for f in (tif, raw, seq):
        f.unlink(missing_ok=True)
    print(f"  contours.pmtiles: {out.stat().st_size / 1e6:.1f} MB", flush=True)


def run(
    region: Region,
    elevation: ElevationFn,
    work: Path,
    out_dem: Path,
    out_contours: Path,
    attribution: str = ATTRIBUTION,
) -> None:
    t0 = time.time()
    grid, x0, y0 = sample_grid(region, elevation, DEM_MAXZOOM)
    print(f"  grid {grid.shape[1]} x {grid.shape[0]} px: {time.time() - t0:.0f}s", flush=True)
    dem_tiles(grid, x0, y0, region.bounds(), work, out_dem, attribution)
    contours(grid, x0, y0, work, out_contours, attribution)
