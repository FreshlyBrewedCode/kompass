"""Shared fixtures: the invented village (`data/village.opl`), a fake DEM and synthetic landuse."""

from pathlib import Path

import numpy as np
import pytest
import shapely

from kompass_pipeline import ways
from kompass_pipeline.config import Region

DATA = Path(__file__).parent / "data"

#: an invented region around a point on the equator and the prime meridian
REGION = Region(lat=0.0, lon=0.0, radius_km=5.0)


@pytest.fixture(scope="session")
def village_table():
    """The village as the `edges` stage produces it (raw tags, geometry, ...)."""
    return ways.build_table(str(DATA / "village.opl"), REGION.crs, log=lambda *_: None)


@pytest.fixture(scope="session")
def village(village_table):
    return village_table.to_pandas()


def plane(x, y):
    """A fake DEM: a plane rising 10 % to the east, 100 m at x = 0."""
    return 100.0 + 0.1 * np.asarray(x)


def box(minx, miny, maxx, maxy):
    return shapely.box(minx, miny, maxx, maxy)
