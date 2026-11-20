"""The local region config (`data/region.local.json`, gitignored) and the geometry derived from it.

The centre and radius are only ever read from the file named on the command line; nothing about a
real place lives in code, tests or docs.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from shapely import Point


@dataclass(frozen=True)
class Region:
    lat: float
    lon: float
    radius_km: float

    @classmethod
    def load(cls, path: Path | str) -> Region:
        cfg = json.loads(Path(path).read_text())
        return cls(cfg["center"]["lat"], cfg["center"]["lon"], float(cfg["radiusKm"]))

    @property
    def crs(self) -> str:
        """The metric CRS of the whole pipeline: azimuthal equidistant around the centre, so lengths
        are true to ~0.005 % within the region, wherever on Earth it is."""
        return f"+proj=aeqd +lat_0={self.lat} +lon_0={self.lon} +x_0=0 +y_0=0 +units=m +datum=WGS84"

    def circle(self, extra_km: float = 0.0):
        """The region disk as a WGS84 polygon (a true metric radius)."""
        to_wgs = Transformer.from_crs(self.crs, "EPSG:4326", always_xy=True)
        disk = Point(0, 0).buffer((self.radius_km + extra_km) * 1000, 256)
        return shapely.transform(disk, lambda c: np.column_stack(to_wgs.transform(c[:, 0], c[:, 1])))

    def bounds(self) -> tuple[float, float, float, float]:
        """(west, south, east, north) of the disk."""
        return self.circle().bounds
