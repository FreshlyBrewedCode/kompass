"""Stage 8a: edges.parquet -> GeoJSONSeq for tippecanoe (feature id = edge_id, per-class minzoom).

Usage: python tiles_export.py <build_dir> <full|idonly>
  full    edge id + the main attributes (debug map can colour by style expressions alone)
  idonly  edge id + highway only (the debug map would colour via feature-state from the engine)
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import shapely

import tags

# minzoom per highway class; lower zooms show only the network skeleton
MINZOOM = {h: 13 for h in tags.HIGHWAY}
MINZOOM.update({h: 8 for h in ["trunk", "trunk_link", "primary", "primary_link", "secondary",
                                "secondary_link", "ferry"]})
MINZOOM.update({h: 10 for h in ["tertiary", "tertiary_link", "cycleway"]})
MINZOOM.update({h: 11 for h in ["unclassified", "residential", "track"]})
MINZOOM.update({h: 12 for h in ["path", "footway", "bridleway", "living_street"]})

FULL = ["highway", "surface_class", "tracktype", "smoothness", "bike_access", "cycleway_kind",
        "maxspeed_kmh", "route_level", "oneway_bike", "forest_share", "forest_edge_share",
        "water_share", "mtb_scale", "bridge"]


def main(build, mode):
    build = Path(build)
    cols = FULL if mode == "full" else ["highway"]
    e = pd.read_parquet(build / "edges.parquet", columns=["edge_id", "geometry", *set(cols + ["highway", "route_level"])])
    geo = shapely.to_geojson(shapely.set_precision(shapely.from_wkb(e["geometry"].values), 1e-6))
    mz = np.array([MINZOOM[h] for h in tags.HIGHWAY])[e["highway"].values]
    if mode == "full":
        mz = np.where(e["route_level"].values > 0, np.minimum(mz, 10), mz)  # routes show early
    recs = e[cols].astype(object).where(e[cols].notna(), None).to_dict("records")
    with open(build / f"overlay_{mode}.geojsonseq", "w") as f:
        for i, g, z, p in zip(e["edge_id"].values, geo, mz, recs):
            p = {k: (int(v) if isinstance(v, (bool, np.bool_, np.integer)) else v) for k, v in p.items() if v is not None}
            f.write(f'{{"type":"Feature","id":{int(i)},"tippecanoe":{{"minzoom":{int(z)}}},'
                    f'"properties":{json.dumps(p, separators=(",", ":"))},"geometry":{g}}}\n')


if __name__ == "__main__":
    main(*sys.argv[1:3])
