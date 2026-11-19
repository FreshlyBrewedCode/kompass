"""Download the Copernicus GLO-30 DEM tiles (public AWS bucket, no login) covering the region.

Usage: python dem_fetch.py <region.local.json> <out_dir>
"""
import math
import subprocess
import sys
from pathlib import Path

import region

BUCKET = "https://copernicus-dem-30m.s3.amazonaws.com"


def tile_name(lat, lon):
    ns, ew = ("N" if lat >= 0 else "S"), ("E" if lon >= 0 else "W")
    return f"Copernicus_DSM_COG_10_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM"


def main(cfg, out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    minx, miny, maxx, maxy = region.circle(cfg, buffer_km=1).bounds
    for lat in range(math.floor(miny), math.floor(maxy) + 1):
        for lon in range(math.floor(minx), math.floor(maxx) + 1):
            n = tile_name(lat, lon)
            dst = out / f"{n}.tif"
            if not dst.exists():
                subprocess.run(["curl", "-sSfL", "-o", str(dst), f"{BUCKET}/{n}/{n}.tif"], check=True)
            print(dst.name, dst.stat().st_size)


if __name__ == "__main__":
    main(*sys.argv[1:3])
