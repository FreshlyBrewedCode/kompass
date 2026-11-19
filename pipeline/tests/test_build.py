"""Stage list, resumability, missing tools, Geofabrik selection."""

import os
import time

import pytest
from shapely import box

from kompass_pipeline import build, cli, geofabrik, tools


def touch(path, age_s=0.0):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x")
    t = time.time() - age_s
    os.utime(path, (t, t))
    return path


def test_up_to_date_compares_modification_times(tmp_path):
    inp = touch(tmp_path / "in", age_s=10)
    out = touch(tmp_path / "out", age_s=0)
    assert build.up_to_date([inp], [out])
    touch(inp, age_s=0)
    os.utime(out, (time.time() - 5, time.time() - 5))
    assert not build.up_to_date([inp], [out])
    assert not build.up_to_date([inp], [tmp_path / "missing"])


def test_stage_runs_once_then_skips_until_forced_or_stale(tmp_path):
    calls = []
    inp = touch(tmp_path / "in", age_s=10)
    out = tmp_path / "work" / "out"

    def run(b):
        calls.append(1)
        touch(out)

    stage = build.Stage("fake", "a fake stage", lambda b: [inp], lambda b: [out], run)
    b = build.Build(region=None, config_path=inp, out=tmp_path, data_dir=tmp_path)
    assert build.run_stage(b, stage) and len(calls) == 1
    assert not build.run_stage(b, stage) and len(calls) == 1  # up to date
    b.force = True
    assert build.run_stage(b, stage) and len(calls) == 2  # --force
    b.force = False
    touch(inp, age_s=-5)  # newer input
    assert build.run_stage(b, stage) and len(calls) == 3


def test_stages_are_ordered_and_chained():
    names = [s.name for s in build.STAGES]
    assert names == [
        "clip",
        "edges",
        "context",
        "elevation",
        "graph",
        "finalize",
        "overlay",
        "basemap",
        "manifest",
    ]
    produced = set()
    b = build.Build(region=None, config_path=build.Path("cfg"), out=build.Path("o"), data_dir=build.Path("d"))
    for s in build.STAGES:
        # every input is the config or the output of an earlier stage
        assert all(p in produced or p == b.config_path for p in s.inputs(b)), s.name
        produced.update(s.outputs(b))


def test_missing_tool_is_a_clear_error(monkeypatch):
    monkeypatch.setenv("PATH", "")
    with pytest.raises(tools.MissingTool, match="nix develop"):
        tools.require("osmium")


def test_cli_reports_a_missing_tool(tmp_path, monkeypatch, capsys):
    cfg = tmp_path / "region.json"
    cfg.write_text('{"center": {"lat": 0, "lon": 0}, "radiusKm": 5}')
    monkeypatch.setenv("PATH", "")
    assert cli.main(["clip", "--region", str(cfg), "--out", str(tmp_path / "o"), "--force"]) == 2
    assert "not found on PATH" in capsys.readouterr().err


def square(x0, y0, x1, y1):
    return box(x0, y0, x1, y1).__geo_interface__


def feature(id_, parent, geom):
    return {
        "type": "Feature",
        "properties": {"id": id_, "parent": parent, "urls": {"pbf": f"https://example.invalid/{id_}.pbf"}},
        "geometry": geom,
    }


INDEX = {
    "features": [
        feature("world", None, square(-50, -50, 50, 50)),
        feature("west", "world", square(-50, -50, 0, 50)),
        feature("east", "world", square(0, -50, 50, 50)),
        feature("far", "world", square(20, 20, 50, 50)),
    ]
}


def test_pick_extracts_takes_the_smallest_covering_set():
    both = geofabrik.pick_extracts(box(-5, 0, 5, 3), INDEX)
    assert sorted(i for i, _ in both) == ["east", "west"]
    one = geofabrik.pick_extracts(box(-20, 0, -10, 3), INDEX)
    assert [i for i, _ in one] == ["west"]
    assert one[0][1] == "https://example.invalid/west.pbf"
