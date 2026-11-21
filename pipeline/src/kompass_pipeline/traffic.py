"""The traffic level of a motor road, 0..1: the engine's model, for the roads beside every way.

The model is defined once, in the engine (`engine/core/src/traffic.rs`, `docs/profile.md` "Traffic");
`traffic.json` next to this file is generated from it (`bun run gen:engine`, a cargo test fails when
it is stale) with worked examples, and the tests check this function against them. Here only what a
road carries for the ways beside it: class x speed x lanes x motor access, capped at 1 (a cycle track
on the road is the rider's on the road, not the neighbour's).

Inputs are as the graph keeps them: speed limits in 5 km/h steps, "built-up" when the edge's
`builtup_share` is at least 50 % (the engine's `built > 7/15`), so the guess for an unknown limit
is the same on both sides.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path

import numpy as np

from . import schema

TABLE_PATH = Path(__file__).with_name("traffic.json")


@cache
def table() -> dict:
    return json.loads(TABLE_PATH.read_text())


@cache
def _by_code() -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    t = table()
    hw, mo = schema.codes("highway"), schema.codes("motor_access")
    n_hw, n_mo = max(hw.values()) + 1, max(mo.values()) + 1
    cls, open_, town = np.zeros(n_hw), np.zeros(n_hw), np.zeros(n_hw)
    for label, v in t["class"].items():
        cls[hw[label]] = v
    for label, g in t["guess_kmh"].items():
        open_[hw[label]], town[hw[label]] = g["outside"], g["built_up"]
    motor = np.ones(n_mo)
    for label, v in t["motor"].items():
        motor[mo[label]] = v
    return cls, open_, town, motor


def road_level(highway, maxspeed_kmh, lanes, motor_access, builtup_pct) -> np.ndarray:
    """Traffic level 0..1 per road. `highway`, `motor_access`: integer codes; `maxspeed_kmh`,
    `lanes`: numbers with NaN for unknown; `builtup_pct`: the edge's `builtup_share` (0..100)."""
    t = table()
    cls, open_, town, motor = _by_code()
    hw = np.asarray(highway, dtype=np.int64)
    built = np.asarray(builtup_pct, dtype=np.float64) >= 50
    kmh = np.asarray(maxspeed_kmh, dtype=np.float64)
    step = t["speed"]["step_kmh"]
    known = ~np.isnan(kmh)
    graph_kmh = np.clip(np.round(np.where(known, kmh, 0) / step), 1, 31) * step
    kmh = np.where(known, graph_kmh, np.where(built, town[hw], open_[hw]))
    s = t["speed"]
    speed = s["floor"] + (1 - s["floor"]) * np.clip(
        (kmh - s["from_kmh"]) / (s["to_kmh"] - s["from_kmh"]), 0, 1
    )
    ln = np.nan_to_num(np.asarray(lanes, dtype=np.float64), nan=0.0)
    lanes_f = np.where(ln >= 4, t["lanes_4"], np.where(ln == 3, t["lanes_3"], 1.0))
    mo = motor[np.asarray(motor_access, dtype=np.int64)]
    return np.minimum(1.0, cls[hw] * speed * lanes_f * mo)
