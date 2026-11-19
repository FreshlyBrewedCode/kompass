"""Elevation profiles with a fake DEM (a plane rising 10 % to the east)."""

import numpy as np
from conftest import plane

from kompass_pipeline import elevation


def straight(points_xy_by_edge):
    x, y, part = [], [], []
    for i, pts in enumerate(points_xy_by_edge):
        for px, py in pts:
            x.append(px)
            y.append(py)
            part.append(i)
    return np.array(x, float), np.array(y, float), np.array(part)


def test_plane_gives_the_expected_ends_ascent_and_grade():
    # edge 0 runs 200 m east, edge 1 runs 200 m west (back down), edge 2 runs north (flat)
    x, y, part = straight([[(0, 0), (200, 0)], [(200, 50), (0, 50)], [(0, 100), (0, 300)]])
    p = elevation.profiles(x, y, part, 3, plane)
    assert np.allclose(p.ele_from_m, [100, 120, 100], atol=0.01)
    assert np.allclose(p.ele_to_m, [120, 100, 100], atol=0.01)
    assert np.allclose(p.ascent_fwd_m, [20, 0, 0], atol=0.05)
    assert np.allclose(p.ascent_bwd_m, [0, 20, 0], atol=0.05)
    assert np.allclose(p.max_grade_fwd_pct, [10, 0, 0], atol=0.05)
    assert np.allclose(p.max_grade_bwd_pct, [0, 10, 0], atol=0.05)


def test_short_edges_report_the_end_to_end_grade():
    x, y, part = straight([[(0, 0), (10, 0)]])
    p = elevation.profiles(x, y, part, 1, plane)
    assert abs(p.max_grade_fwd_pct[0] - 10) < 0.01 and p.max_grade_bwd_pct[0] == 0


def test_smoothing_removes_noise_but_keeps_the_ends():
    rng = np.random.default_rng(0)
    noise = {}

    def noisy(x, y):
        key = (round(float(x[0]), 3), len(x))
        noise.setdefault(key, rng.normal(0, 3, len(x)))
        return 100.0 + noise[key]

    x, y, part = straight([[(0, 0), (500, 0)]])
    p = elevation.profiles(x, y, part, 1, noisy)
    raw_ascent = np.maximum(np.diff(noise[(0.0, 51)]), 0).sum()
    assert p.ascent_fwd_m[0] < raw_ascent / 2  # the 50 m moving average flattens the wiggle
    assert p.ele_from_m[0] == np.float32(100.0 + noise[(0.0, 51)][0])  # the end keeps its raw value


def test_any_function_is_a_dem():
    """The interface is a plain function of metric coordinates; a constant model is flat."""
    x, y, part = straight([[(0, 0), (100, 0), (100, 100)]])
    p = elevation.profiles(x, y, part, 1, lambda x, y: np.full(len(x), 42.0))
    assert p.ele_from_m[0] == 42 and p.ascent_fwd_m[0] == 0 and p.max_grade_fwd_pct[0] == 0
