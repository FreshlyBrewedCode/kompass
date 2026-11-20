"""The e2e fixture's relief: invented hills around 0 N 0 E through the pipeline's terrain stage.

    nix develop -c uv run --project pipeline python e2e/fixtures/build-terrain.py

Writes `region/terrain.pmtiles` and `region/contours.pmtiles` (deterministic; committed).
"""

import tempfile
from pathlib import Path

import numpy as np

from kompass_pipeline import terrain
from kompass_pipeline.config import Region

OUT = Path(__file__).parent / "region"


def hills(x, y):
    """Rounded hills and a valley around the centre, fading into a plain 3 km out (metric coordinates):
    the tiles reach much further than the fixture's streets, and a plain costs no bytes."""
    x, y = np.asarray(x), np.asarray(y)
    relief = 140 * np.sin(x / 900) * np.cos(y / 1100) + 60 * np.sin((x + y) / 500)
    return 320 + relief * np.exp(-(x**2 + y**2) / (2 * 1600.0**2))


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as work:
        region = Region(lat=0.0, lon=0.0, radius_km=3.0)
        terrain.run(
            region, hills, Path(work), OUT / "terrain.pmtiles", OUT / "contours.pmtiles", "Synthetic fixture"
        )
