"""Hilbert sort, assembling and writing edges.parquet from the village, end to end without binaries."""

import json

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import shapely
from conftest import REGION, plane

from kompass_pipeline import context, elevation, finalize, graph, samples, schema


def test_hilbert_order_1_visits_cells_in_u_shape():
    # the classic 2x2 curve: (0,0) -> (0,1) -> (1,1) -> (1,0)
    d = finalize.hilbert_d(np.array([0, 0, 1, 1]), np.array([0, 1, 1, 0]), order=1)
    assert d.tolist() == [0, 1, 2, 3]


def test_hilbert_is_a_bijection_and_neighbours_stay_close():
    n = 8
    xs, ys = np.meshgrid(np.arange(n), np.arange(n))
    d = finalize.hilbert_d(xs.ravel(), ys.ravel(), order=3)
    assert sorted(d.tolist()) == list(range(n * n))
    grid = {int(k): (int(x), int(y)) for k, x, y in zip(d, xs.ravel(), ys.ravel(), strict=True)}
    for k in range(n * n - 1):  # consecutive indices are adjacent cells
        (ax, ay), (bx, by) = grid[k], grid[k + 1]
        assert abs(ax - bx) + abs(ay - by) == 1


def test_z16_tile_of_known_points():
    x, y = finalize.z16_tile(np.array([0.0, -180.0, 179.999]), np.array([0.0, 0.0, 0.0]))
    assert x.tolist() == [32768, 0, 65535]
    assert y.tolist() == [32768, 32768, 32768]  # the equator is the middle row


def test_hilbert_order_sorts_by_key_then_way(village):
    geoms = shapely.from_wkb(village.geometry.to_numpy())
    order, key = finalize.hilbert_order(geoms, village.way_id.to_numpy(), village.way_pos_from.to_numpy())
    assert (np.diff(key.astype(np.int64)) >= 0).all()
    assert sorted(order.tolist()) == list(range(len(village)))


def build_village_file(village, tmp_path):
    """Context, elevation (fake DEM), graph and finalize on the village, like the real stages."""
    n = len(village)
    x, y, part = samples.vertices(village.geometry.to_numpy(), REGION.crs)
    roads = context.road_attrs(village)
    forest = context.ContextFeatures(
        np.array([shapely.box(300, 0, 700, 800)], dtype=object), *(np.array([], dtype=object),) * 3
    )
    ctx = context.shares(x, y, part, n, roads, forest, (-1000, -1000, 4000, 1500), log=lambda *_: None)
    ele = elevation.profiles(x, y, part, n, plane)
    comp, km = graph.components(
        village.node_from.to_numpy(), village.node_to.to_numpy(), village.length_m.to_numpy().astype(float)
    )
    keep = km[comp] >= 1.0
    df, geom = finalize.assemble(village, ctx, ele, keep)
    out = tmp_path / "edges.parquet"
    finalize.write(df, geom, out, "build123")
    return out, df


def test_edges_parquet_round_trip(village, tmp_path):
    out, _ = build_village_file(village, tmp_path)
    table = pq.read_table(out)
    assert table.schema.equals(schema.arrow_schema())
    assert table.num_rows == len(village) - 1  # the isolated stub is pruned
    assert table.column("edge_id").to_pylist() == list(range(table.num_rows))
    key = table.column("hilbert_z16").to_numpy().astype(np.int64)
    assert (np.diff(key) >= 0).all()

    meta = {k.decode(): v.decode() for k, v in pq.read_schema(out).metadata.items()}
    assert meta[schema.META_SCHEMA_VERSION] == "1"
    assert meta[schema.META_BUILD_ID] == "build123"
    geo = json.loads(meta["geo"])
    assert geo["version"] == "1.1.0" and geo["columns"]["geometry"]["encoding"] == "WKB"
    assert json.loads(meta[schema.META_ENUMS])["highway"]["14"] == "track"

    back = table.to_pandas()
    street = back[back.way_id == 1]
    assert set(street.surface_class) == {schema.codes("surface_class")["paved_smooth"]}
    assert (street.route_level == 2).all()
    track = back[(back.way_id == 2)].iloc[0]
    assert track.tracktype == 3 and track.n_barriers == 1
    assert track.forest_share > 80  # inside the synthetic forest box
    assert back[back.way_id == 7].bike_access.iloc[0] == schema.codes("bike_access")["foot_only"]
    assert not (back.ascent_fwd_m < 0).any()
    # the plane rises 10 % to the east: the street's first edge climbs ~44 m eastwards
    first = street.sort_values("way_pos_from").iloc[0]
    assert abs(first.ele_to_m - first.ele_from_m - 44.5) < 0.5
    assert pa.types.is_string(table.schema.field("surface").type)
    assert shapely.from_wkb(back.geometry.iloc[0]).geom_type == "LineString"


def test_dropped_columns_stay_dropped():
    names = {c.name for c in schema.COLUMNS}
    assert names.isdisjoint({"bridge", "pocket_km", "pocket_dir", "component", "keep"})
    assert pd.Series(list(names)).is_unique
