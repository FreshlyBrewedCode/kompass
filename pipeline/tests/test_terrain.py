"""The terrain stage on a fake DEM (a plane rising 10 % to the east)."""

import json
import subprocess

import numpy as np
import pytest
from conftest import REGION, plane
from rasterio.io import MemoryFile

from kompass_pipeline import terrain, tools

pytestmark = pytest.mark.filterwarnings("ignore::rasterio.errors.NotGeoreferencedWarning")


def test_terrarium_round_trips_to_the_quantum():
    heights = np.array([[-12.3, 0.0, 0.26], [455.74, 1493.0, 8848.9]], np.float32)
    back = terrain.decode_terrarium(terrain.encode_terrarium(heights))
    assert np.abs(back - heights).max() <= terrain.QUANTUM / 2 + 1e-3
    with MemoryFile(terrain.png(terrain.encode_terrarium(heights))) as mem, mem.open() as ds:
        assert np.array_equal(terrain.decode_terrarium(ds.read()), back)  # lossless


def test_tile_range_and_grid_follow_the_region():
    x0, y0, x1, y1 = terrain.tile_range(REGION.bounds(), 12)
    assert (x0, y0, x1, y1) == (2047, 2047, 2048, 2048)  # the four tiles around 0 N 0 E
    grid, gx, gy = terrain.sample_grid(REGION, plane, 12)
    assert (gx, gy) == (x0, y0) and grid.shape == (512, 512)
    # the plane: 100 m at x = 0 (the seam between the two tile columns), rising to the east only
    res = 2 * terrain.EARTH / (256 * 2**12)
    assert abs(grid[:, 256].mean() - (100 + 0.1 * res / 2)) < 0.1
    assert np.ptp(grid, axis=0).max() < 0.05 and grid[0, -1] > grid[0, 0]


def test_pyramid_halves_up_to_the_minzoom():
    grid = np.arange(512 * 512, dtype=np.float32).reshape(512, 512)
    tiles = list(terrain.pyramid(grid, 2047, 2047, 12, 10))
    assert [(z, x, y) for z, x, y, _ in tiles] == [
        *((12, 2047 + i, 2047 + j) for j in range(2) for i in range(2)),
        *((11, 1023 + i, 1023 + j) for j in range(2) for i in range(2)),
        *((10, 511 + i, 511 + j) for j in range(2) for i in range(2)),
    ]
    assert all(t.shape == (256, 256) for *_, t in tiles)
    # the z11 tile south-east of the origin holds the 2x2 means of the z12 tile there
    z11 = next(t for z, x, y, t in tiles if (z, x, y) == (11, 1024, 1024))
    assert z11[0, 0] == grid[256:258, 256:258].mean()


def test_contour_filter_thins_by_zoom():
    assert terrain.contour_filter() == [
        "any",
        ["all", [">=", "$zoom", 10], ["==", "m100", 1]],
        ["all", [">=", "$zoom", 13], ["==", "m20", 1]],
        [">=", "$zoom", 14],
    ]


NEEDED = ("pmtiles", "gdal_contour", "ogr2ogr", "tippecanoe", "tippecanoe-decode")


@pytest.mark.skipif(not all(tools.have(t) for t in NEEDED), reason="map tools not installed")
def test_stage_writes_dem_tiles_and_contours(tmp_path):
    dem, lines = tmp_path / "terrain.pmtiles", tmp_path / "contours.pmtiles"
    terrain.run(REGION, plane, tmp_path, dem, lines)

    tile = subprocess.run(["pmtiles", "tile", dem, "12", "2048", "2047"], capture_output=True, check=True)
    with MemoryFile(tile.stdout) as mem, mem.open() as ds:
        heights = terrain.decode_terrarium(ds.read())
    assert heights.shape == (256, 256) and abs(heights[0, 0] - 100) < 3 and heights[0, -1] > heights[0, 0]
    low = subprocess.run(["pmtiles", "tile", dem, "6", "32", "31"], capture_output=True, check=True)
    assert low.stdout[:4] == b"\x89PNG"

    def eles(zoom):
        res = subprocess.run(
            ["tippecanoe-decode", "-c", lines, str(zoom), str(2**zoom // 2), str(2**zoom // 2 - 1)],
            capture_output=True,
            text=True,
            check=True,
        )
        feats = [json.loads(x.rstrip(",")) for x in res.stdout.splitlines() if '"Feature"' in x]
        return {f["properties"]["ele"] for f in feats if "ele" in f["properties"]}

    # the plane east of 0 E climbs from 100 m: every 100 m at z10, every 20 m at z13, every 10 m at z14
    assert eles(10) and all(e % 100 == 0 for e in eles(10))
    assert any(e % 100 for e in eles(13)) and all(e % 20 == 0 for e in eles(13))
    assert any(e % 20 for e in eles(14))
    assert not list(tmp_path.glob("*.mbtiles")) and not list(tmp_path.glob("contour*.tif"))
