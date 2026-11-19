"""Filter and split on the invented village."""

import pandas as pd

from kompass_pipeline import ways


def edges_of(village, way_id):
    return village[village.way_id == way_id].sort_values("way_pos_from")


def test_keeps_routable_ways_and_drops_the_rest(village):
    kept = set(village.way_id)
    assert kept == {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 23}  # no motorway, construction, area


def test_splits_ways_at_junctions(village):
    street = edges_of(village, 1)
    # n3, n4, n5 and n6 are shared with other ways: five edges from n1 to n7
    assert list(zip(street.way_pos_from, street.way_pos_to, strict=True)) == [
        (0, 2),
        (2, 3),
        (3, 4),
        (4, 5),
        (5, 6),
    ]
    assert street.node_from.tolist() == [1, 3, 4, 5, 6]
    assert street.node_to.tolist() == [3, 4, 5, 6, 7]


def test_a_junction_node_joins_the_edges_of_different_ways(village):
    ends_at_n3 = village[(village.node_from == 3) | (village.node_to == 3)]
    assert set(ends_at_n3.way_id) == {1, 2}


def test_closed_ways_are_split_so_no_edge_is_a_loop(village):
    assert (village.node_from != village.node_to).all()
    loop = edges_of(village, 3)  # a closed track
    assert len(loop) == 2
    assert loop.node_from.iloc[0] == loop.node_to.iloc[1] == 12


def test_length_is_metric(village):
    street = edges_of(village, 1)
    # the first edge spans 0.004 degrees on the equator (111.32 m per 0.001 degrees)
    assert abs(street.length_m.iloc[0] - 0.004 * 111_320) < 1.0
    assert abs(street.length_m.sum() - 0.012 * 111_320) < 5


def test_barriers_are_counted_on_the_edges_they_sit_on(village):
    assert edges_of(village, 2).n_barriers.tolist() == [1]
    assert village.n_barriers.sum() == 1


def test_route_relations(village):
    assert set(village[village.route_level == 2].way_id) == {1}  # rcn
    assert set(village[village.mtb_route].way_id) == {6}


def test_raw_tags_keep_their_keys(village):
    street = edges_of(village, 1).iloc[0]
    assert street.tag_surface == "asphalt"
    assert street.tag_name == "Example Street"
    assert pd.isna(street.tag_tracktype)
    assert edges_of(village, 6).iloc[0].tag_mtb_scale == "2"


def test_geometry_is_wgs84_wkb(village):
    import shapely

    g = shapely.from_wkb(village.geometry.iloc[0])
    assert g.geom_type == "LineString"
    assert g.coords[0] == (0.0, 0.0)


def test_keep_way_rules():
    class T(dict):
        pass

    assert ways.keep_way(T(highway="track"), set(), 1)
    assert not ways.keep_way(T(highway="motorway"), set(), 1)
    assert not ways.keep_way(T(highway="pedestrian", area="yes"), set(), 1)
    assert ways.keep_way(T(route="ferry"), set(), 1)
    assert not ways.keep_way(T(route="ferry", bicycle="no"), set(), 1)
    assert ways.keep_way(T(), {7}, 7)  # a way that is a member of a ferry relation
