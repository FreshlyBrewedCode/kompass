"""Stage `context`: forest / water / built-up / motor-road shares per edge.

Landuse is rasterised to a 10 m grid in the metric CRS and each edge is sampled every 10 m (see
`samples.py`), so every share is an array lookup. The raster wins over vector overlays on the
distance-based shares (rim, near water, near road), where buffers of large polygons get expensive;
for the inside shares it agrees with an exact vector overlay (checked in the spike: 27.7 % vs
28.0 % forest, length-weighted).

Definitions (cell = 10 m):
  forest_share       sample inside landuse=forest / natural=wood
  forest_edge_share  sample within 30 m outside a forest, or within 10 m inside its boundary
  water_share        sample within 100 m of a water area >= 0.5 ha (lake, river area) or a river / canal
  builtup_share      sample inside residential / commercial / industrial / ... landuse
  road_near_share    sample within 20 m of a motor road (100 on the roads themselves)
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import rasterio.features
import shapely
from pyogrio import raw as ogr
from pyogrio import read_info
from pyproj import Transformer
from rasterio.transform import from_origin
from scipy import ndimage

from . import samples, schema, tools

RES = 10.0
FOREST = {"forest", "wood"}
BUILTUP = {
    "residential",
    "commercial",
    "industrial",
    "retail",
    "construction",
    "garages",
    "railway",
    "farmyard",
    "cemetery",
    "allotments",
}
ROAD_LABELS = (
    "trunk",
    "trunk_link",
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "unclassified",
    "residential",
    "living_street",
)
MIN_WATER_AREA_M2 = 5000.0  # ponds below 0.5 ha do not count

#: osmium tags-filter expression and the attributes read back from its export
FILTER = [
    "a/landuse=forest,residential,commercial,industrial,retail,construction,garages,railway,farmyard,cemetery,allotments",
    "a/natural=wood,water",
    "a/waterway=riverbank",
    "w/waterway=river,canal",
]
FIELDS = ["landuse", "natural", "waterway"]


@dataclass
class ContextFeatures:
    """Landuse geometries in the metric CRS."""

    forest: np.ndarray
    builtup: np.ndarray
    water_area: np.ndarray
    water_line: np.ndarray


def prepare(region_pbf: Path, work: Path) -> Path:
    """osmium: keep the landuse / water features and export them as GeoJSON sequence."""
    filtered, export = work / "context.osm.pbf", work / "context.geojsonseq"
    tools.run(["osmium", "tags-filter", "--overwrite", region_pbf, *FILTER, "-o", filtered])
    tools.run(
        ["osmium", "export", "--overwrite", filtered, "-f", "geojsonseq", "-a", "type,id", "-o", export]
    )
    return export


def classify(geoms: np.ndarray, attrs: dict[str, np.ndarray]) -> ContextFeatures:
    """Sorts WGS84-or-metric geometries into the four feature groups by their tags."""

    def col(name: str) -> np.ndarray:
        return attrs.get(name, np.full(len(geoms), None, dtype=object))

    landuse, natural, waterway = col("landuse"), col("natural"), col("waterway")
    poly = np.isin(shapely.get_type_id(geoms), [3, 6])  # Polygon, MultiPolygon
    forest = poly & (np.isin(landuse, list(FOREST)) | np.isin(natural, list(FOREST)))
    built = poly & np.isin(landuse, list(BUILTUP))
    water = poly & ((natural == "water") | (waterway == "riverbank"))
    water &= shapely.area(geoms) >= MIN_WATER_AREA_M2
    line = ~poly & np.isin(waterway, ["river", "canal"])
    return ContextFeatures(geoms[forest], geoms[built], geoms[water], geoms[line])


def read_features(path: Path, crs: str) -> ContextFeatures:
    """Reads the osmium export (WGS84) and projects it to the metric `crs`."""
    present = {f for f in read_info(path)["fields"]}
    meta, _, wkb, data = ogr.read(path, columns=[f for f in FIELDS if f in present])
    attrs = dict(zip(meta["fields"], data, strict=True))
    geoms = shapely.from_wkb(wkb)
    tr = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    geoms = shapely.transform(geoms, lambda c: np.column_stack(tr.transform(c[:, 0], c[:, 1])))
    return classify(geoms, attrs)


def _octagon(r: int) -> np.ndarray:
    """Disk-like structuring element of radius r cells."""
    yy, xx = np.mgrid[-r : r + 1, -r : r + 1]
    return (xx * xx + yy * yy) <= r * r + 0.5


def _dilate(a: np.ndarray, r: int) -> np.ndarray:
    return ndimage.binary_dilation(a, structure=_octagon(r))


def shares(
    x, y, part, n_edges: int, is_road, features: ContextFeatures, bounds, *, res: float = RES, log=print
) -> pd.DataFrame:
    """Context shares (uint8 percent) per edge. `x, y, part` are the edges' metric vertices, `bounds`
    (minx, miny, maxx, maxy) the raster extent (samples outside it clamp to the border)."""
    t0 = time.time()
    minx, miny, maxx, maxy = bounds
    w, h = int(np.ceil((maxx - minx) / res)), int(np.ceil((maxy - miny) / res))
    tf = from_origin(minx, maxy, res, res)
    log(f"  grid {w} x {h} = {w * h / 1e6:.0f} M cells")

    def rast(geoms, all_touched=False) -> np.ndarray:
        if len(geoms) == 0:
            return np.zeros((h, w), bool)
        return rasterio.features.rasterize(
            ((g, 1) for g in geoms),
            out_shape=(h, w),
            transform=tf,
            fill=0,
            dtype="uint8",
            all_touched=all_touched,
        ).astype(bool)

    forest = rast(features.forest)
    rim = _dilate(forest, 3) & ~ndimage.binary_erosion(forest, structure=_octagon(1))
    built = rast(features.builtup)
    water = _dilate(rast(features.water_area) | rast(features.water_line, all_touched=True), 10)
    on_road = is_road[part]
    road_lines = []
    if on_road.any():
        _, line_idx = np.unique(part[on_road], return_inverse=True)  # consecutive, as shapely needs
        road_lines = shapely.linestrings(np.column_stack([x[on_road], y[on_road]]), indices=line_idx)
    road = _dilate(rast(road_lines, all_touched=True), 2)
    log(f"  rasters: {time.time() - t0:.0f}s")

    sx, sy, sedge, _, wgt, _ = samples.sample(x, y, part, n_edges, step=res)
    col = np.clip(((sx - minx) / res).astype(np.int64), 0, w - 1)
    row = np.clip(((maxy - sy) / res).astype(np.int64), 0, h - 1)
    log(f"  sampling: {sx.size / 1e6:.1f} M samples")
    out = pd.DataFrame(
        {
            "forest_share": samples.weighted_share(forest[row, col], sedge, wgt, n_edges),
            "forest_edge_share": samples.weighted_share(rim[row, col], sedge, wgt, n_edges),
            "water_share": samples.weighted_share(water[row, col], sedge, wgt, n_edges),
            "builtup_share": samples.weighted_share(built[row, col], sedge, wgt, n_edges),
            "road_near_share": samples.weighted_share(road[row, col], sedge, wgt, n_edges),
        }
    )
    out.loc[is_road, "road_near_share"] = 1.0  # a road is on the road
    return (out * 100).round().astype(np.uint8)


def run(raw: Path, features_path: Path, crs: str, bounds: tuple, out: Path) -> None:
    edges = pq.read_table(raw, columns=["geometry", "tag_highway"]).to_pandas()
    n = len(edges)
    x, y, part = samples.vertices(edges["geometry"].values, crs)
    hw = edges["tag_highway"].where(edges["tag_highway"].isin(schema.codes("highway")), "other")
    is_road = hw.isin(ROAD_LABELS).to_numpy()
    del edges
    features = read_features(features_path, crs)
    shares(x, y, part, n, is_road, features, bounds).to_parquet(out, compression="zstd")
