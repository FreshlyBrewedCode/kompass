"""The `edges.parquet` contract (placeholder schema until the pipeline spike settles it)."""

import pyarrow as pa
from shapely import LineString, to_wkb

#: One row per directed-agnostic edge: an id, its length and its geometry as WKB.
EDGE_SCHEMA = pa.schema(
    [
        pa.field("edge_id", pa.uint32(), nullable=False),
        pa.field("length_m", pa.float32(), nullable=False),
        pa.field("geometry", pa.binary(), nullable=False),
    ]
)


def edges_table(lines: list[LineString]) -> pa.Table:
    """Builds an edges table from projected (metric) line strings, ids in input order."""
    return pa.table(
        {
            "edge_id": pa.array(range(len(lines)), pa.uint32()),
            "length_m": pa.array([line.length for line in lines], pa.float32()),
            "geometry": pa.array([to_wkb(line) for line in lines], pa.binary()),
        },
        schema=EDGE_SCHEMA,
    )
