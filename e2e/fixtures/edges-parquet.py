"""The e2e fixture's edges.parquet, written with the pipeline's own schema and writer from the edges
GeoJSON that build-region.ts generates (ids are the row numbers, already in the pipeline's order).

    uv run --project pipeline python e2e/fixtures/edges-parquet.py <edges.geojson> <edges.parquet> <build id>

Called by build-region.ts. Columns the GeoJSON does not carry get the schema's neutral value.
"""

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import shapely
from pyproj import CRS, Transformer

from kompass_pipeline import finalize, schema


def main(src: Path, out: Path, build_id: str) -> None:
    features = json.loads(src.read_text())["features"]
    if [f["id"] for f in features] != list(range(len(features))):
        raise SystemExit("edge ids must be 0..n-1 in order")
    geom = np.array([shapely.LineString(f["geometry"]["coordinates"]) for f in features], dtype=object)
    props = [f["properties"] for f in features]

    # the pipeline's metric lengths: an azimuthal equidistant projection around the fixture's centre
    aeqd = CRS.from_proj4("+proj=aeqd +lat_0=0 +lon_0=0 +datum=WGS84 +units=m")
    to_m = Transformer.from_crs("EPSG:4326", aeqd, always_xy=True)
    length = shapely.length(shapely.transform(geom, lambda xy: np.column_stack(to_m.transform(*xy.T))))

    # node ids from the end coordinates (shared by the edges meeting there)
    node_of: dict[tuple[float, float], int] = {}

    def node(p) -> int:
        return node_of.setdefault((round(p[0], 9), round(p[1], 9)), len(node_of) + 1)

    coords = [f["geometry"]["coordinates"] for f in features]
    rows = {c.name: [] for c in schema.COLUMNS}
    for i, (p, c) in enumerate(zip(props, coords, strict=True)):
        grade = p.get("grade_max")
        values = {
            "edge_id": i,
            "way_id": p["way_id"],
            "way_pos_from": 0,
            "way_pos_to": len(c) - 1,
            "node_from": node(c[0]),
            "node_to": node(c[-1]),
            "length_m": length[i],
            "highway": p["highway"],
            "surface_class": p["surface_class"],
            "oneway_bike": p["oneway_bike"],
            "forest_share": round(p["forest"] * 100),
            "max_grade_fwd_pct": grade or 0.0,
            "max_grade_bwd_pct": grade or 0.0,
            # half of it uphill each way
            "ascent_fwd_m": round(length[i] * (grade or 0) / 200, 1),
            "ascent_bwd_m": round(length[i] * (grade or 0) / 200, 1),
            "geometry": shapely.to_wkb(geom[i]),
        }
        for col in schema.COLUMNS:
            if col.name in values:
                v = values[col.name]
            elif col.nullable:
                v = None
            elif pa.types.is_boolean(col.dtype):
                v = False
            elif pa.types.is_floating(col.dtype):
                v = 0.0
            else:
                v = 0
            rows[col.name].append(v)

    order, key = finalize.hilbert_order(geom, np.array(rows["way_id"]), np.array(rows["way_pos_from"]))
    if order.tolist() != list(range(len(features))):
        raise SystemExit("the edges are not in the pipeline's Hilbert order (build-region.ts drifted)")
    rows["hilbert_z16"] = key.astype(np.uint32).tolist()
    df = pd.DataFrame(rows)
    finalize.write(df, geom, out, build_id)
    print(f"edges.parquet: {len(df)} edges, build {build_id}")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
