"""The pipeline's traffic level is the engine's: checked against the examples the engine wrote."""

import numpy as np

from kompass_pipeline import schema, traffic


def test_matches_the_engine_examples():
    ex = traffic.table()["examples"]
    hw, mo = schema.codes("highway"), schema.codes("motor_access")
    nan = float("nan")
    got = traffic.road_level(
        [hw[e["highway"]] for e in ex],
        [nan if e["maxspeed_kmh"] is None else e["maxspeed_kmh"] for e in ex],
        [nan if e["lanes"] is None else e["lanes"] for e in ex],
        [mo[e["motor_access"]] for e in ex],
        [100 if e["built_up"] else 0 for e in ex],
    )
    want = np.array([e["level"] for e in ex])
    assert len(ex) > 100
    assert np.abs(got - want).max() < 1e-5


def test_ways_without_motor_traffic_are_zero():
    hw = schema.codes("highway")
    level = traffic.road_level([hw["path"], hw["cycleway"]], [100.0, 100.0], [4.0, 4.0], [0, 0], [0, 0])
    assert (level == 0).all()
