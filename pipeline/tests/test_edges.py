"""Proves the native wheels (pyarrow, shapely) load, also inside the NixOS dev shell."""

import pyarrow.parquet as pq
from shapely import LineString, from_wkb

from kompass_pipeline.edges import EDGE_SCHEMA, edges_table


def test_edges_round_trip_through_parquet(tmp_path):
    # a synthetic grid in metres, no real place
    lines = [LineString([(0, 0), (300, 400)]), LineString([(300, 400), (300, 1400)])]
    path = tmp_path / "edges.parquet"
    pq.write_table(edges_table(lines), path)

    table = pq.read_table(path)
    assert table.schema.equals(EDGE_SCHEMA)
    assert table.column("edge_id").to_pylist() == [0, 1]
    assert table.column("length_m").to_pylist() == [500.0, 1000.0]
    assert from_wkb(table.column("geometry")[1].as_py()).equals(lines[1])
