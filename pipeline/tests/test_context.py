"""Context shares against small synthetic polygons in the metric CRS."""

import numpy as np
import pandas as pd
from conftest import box

from kompass_pipeline import context, samples, schema
from kompass_pipeline.context import ContextFeatures

EMPTY = np.array([], dtype=object)
BOUNDS = (-100.0, -100.0, 900.0, 400.0)


def edges(*lines):
    x, y, part = [], [], []
    for i, pts in enumerate(lines):
        for px, py in pts:
            x.append(px)
            y.append(py)
            part.append(i)
    return np.array(x, float), np.array(y, float), np.array(part)


def shares(lines, features, roads=None):
    """`roads`: a `Roads`, or which lines are primary roads of unknown speed limit."""
    x, y, part = edges(*lines)
    if not isinstance(roads, context.Roads):
        roads = context.Roads.plain(np.array(roads if roads is not None else [False] * len(lines)))
    return context.shares(x, y, part, len(lines), roads, features, BOUNDS, log=lambda *_: None)


def features(forest=(), builtup=(), water=(), water_line=()):
    a = lambda g: np.array(list(g), dtype=object)  # noqa: E731
    return ContextFeatures(a(forest), a(builtup), a(water), a(water_line))


def test_forest_share_is_the_length_inside_the_polygon():
    forest = [box(100, 0, 300, 200)]
    out = shares(
        [[(0, 100), (400, 100)], [(500, 100), (800, 100)], [(150, 50), (250, 50)]], features(forest=forest)
    )
    # edge 0: 200 of 400 m inside; edge 1: none; edge 2: all inside
    assert abs(int(out.forest_share[0]) - 50) <= 3
    assert out.forest_share[1] == 0
    assert out.forest_share[2] == 100


def test_forest_edge_covers_a_band_around_the_boundary():
    forest = [box(100, 0, 300, 200)]
    out = shares([[(0, 100), (400, 100)]], features(forest=forest))
    # within 30 m outside or 10 m inside the boundary on both sides: ~80 of 400 m
    assert 15 <= out.forest_edge_share[0] <= 25


def test_water_is_near_water_not_in_it():
    lake = [box(100, 0, 300, 100) for _ in range(1)]  # 200 x 100 m = 2 ha
    out = shares([[(0, 50), (500, 50)]], features(water=lake))
    # within 100 m of the lake: from x = 0 to x = 400 out of 500 m
    assert 70 <= out.water_share[0] <= 90


def test_small_ponds_are_ignored_by_classify():
    pond, lake = box(0, 0, 50, 50), box(0, 0, 100, 100)  # 0.25 ha, 1 ha
    geoms = np.array([pond, lake, box(0, 0, 10, 10)], dtype=object)
    f = context.classify(geoms, {"natural": np.array(["water", "water", "wood"], dtype=object)})
    assert list(f.water_area) == [lake]
    assert len(f.forest) == 1


def test_rivers_count_as_lines():
    from shapely import LineString

    f = context.classify(
        np.array([LineString([(0, 0), (1, 1)]), LineString([(0, 0), (1, 1)])], dtype=object),
        {"waterway": np.array(["river", "stream"], dtype=object)},
    )
    assert len(f.water_line) == 1


def test_builtup_and_road_near():
    out = shares(
        [[(0, 0), (400, 0)], [(0, 15), (400, 15)], [(0, 300), (400, 300)]],
        features(builtup=[box(0, -50, 200, 50)]),
        roads=[True, False, False],
    )
    assert out.road_near_share[0] == 100  # a road is on the road
    assert out.road_near_share[1] >= 95  # 15 m from it, within 20 m
    assert out.road_near_share[2] == 0
    assert abs(int(out.builtup_share[0]) - 50) <= 3
    assert out.builtup_share[2] == 0


def test_road_near_traffic_is_the_level_of_the_road_alongside():
    # a primary road (unknown limit, outside towns: 100 km/h, level 0.9), a path 10 m beside it
    # and one 100 m away, and a quiet residential street with a path beside it
    out = shares(
        [
            [(0, 0), (600, 0)],
            [(100, 10), (500, 10)],
            [(100, 100), (500, 100)],
            [(0, 250), (600, 250)],
            [(100, 262), (500, 262)],
        ],
        features(),
        roads=context.Roads(
            np.array([True, False, False, True, False]),
            np.array([3, 15, 15, 10, 15]),  # primary, path, path, residential, path
            np.full(5, np.nan),
            np.full(5, np.nan),
            np.zeros(5, np.int64),
        ),
    )
    assert out.road_near_traffic[1] == 90  # beside the primary
    assert out.road_near_share[1] == 100
    assert out.road_near_traffic[2] == 0 and out.road_near_share[2] == 0  # 100 m away: quiet
    # the residential street: 0.12 * (0.4 + 0.6 * 10/70) at 40 km/h ≈ 0.06
    assert out.road_near_traffic[4] == 6
    assert out.road_near_traffic[0] == 90  # on a road the band holds the road itself


def test_the_louder_road_wins_where_two_are_near():
    # a path between a primary (5 m) and a residential street (12 m): the primary's level counts
    out = shares(
        [[(0, 0), (400, 0)], [(0, 17), (400, 17)], [(50, 5), (350, 5)]],
        features(),
        roads=context.Roads(
            np.array([True, True, False]),
            np.array([3, 10, 15]),
            np.array([70.0, 30.0, np.nan]),
            np.full(3, np.nan),
            np.zeros(3, np.int64),
        ),
    )
    # the primary at 70 km/h: 0.9 * (0.4 + 0.6 * 40/70) ≈ 0.67
    assert out.road_near_traffic[2] == 67


def test_road_attrs_parse_the_tags_like_finalize():
    raw = pd.DataFrame(
        {
            "tag_highway": ["primary", "path", "residential", "motorway"],
            "tag_maxspeed": ["70", None, "DE:urban", None],
            "tag_lanes": ["4", None, None, "2"],
            "tag_motor_vehicle": [None, None, "destination", None],
            **{
                k: [None] * 4
                for k in context.ROAD_TAGS
                if k not in ("tag_maxspeed", "tag_lanes", "tag_motor_vehicle")
            },
        }
    )
    r = context.road_attrs(raw)
    assert r.is_road.tolist() == [True, False, True, False]
    assert r.maxspeed_kmh[0] == 70 and r.maxspeed_kmh[2] == 50 and np.isnan(r.maxspeed_kmh[1])
    assert r.lanes[0] == 4 and np.isnan(r.lanes[2])
    assert r.motor_access[2] == schema.codes("motor_access")["destination"]


def test_shares_are_uint8_percent():
    out = shares([[(0, 0), (100, 0)]], features())
    assert all(dt == np.uint8 for dt in out.dtypes)
    assert (out.drop(columns="road_near_share") == 0).all().all()


def test_samples_are_length_weighted():
    x, y, part = edges([(0, 0), (100, 0), (100, 100)])
    sx, sy, _, sd, w, length = samples.sample(x, y, part, 1, step=10)
    assert length[0] == 200
    assert sd.max() == 200 and abs(w.sum() - 20) < 1e-9  # 20 intervals; endpoints count half
    assert sx[-1] == 100 and sy[-1] == 100


def test_read_features_from_osmium_export(tmp_path):
    """A hand-written GeoJSON sequence in the shape `osmium export` writes."""
    seq = tmp_path / "c.geojsonseq"
    seq.write_text(
        '{"type":"Feature","properties":{"natural":"wood","@type":"way","@id":1},"geometry":'
        '{"type":"Polygon","coordinates":[[[0,0],[0.01,0],[0.01,0.01],[0,0.01],[0,0]]]}}\n'
        '{"type":"Feature","properties":{"waterway":"river","@type":"way","@id":2},"geometry":'
        '{"type":"LineString","coordinates":[[0,0],[0.01,0.01]]}}\n'
    )
    f = context.read_features(seq, "+proj=aeqd +lat_0=0 +lon_0=0 +units=m +datum=WGS84")
    assert len(f.forest) == 1 and len(f.water_line) == 1
    assert abs(f.forest[0].area - (0.01 * 111_320) ** 2) < 0.01 * (0.01 * 111_320) ** 2  # ~1.24 km2, metric
