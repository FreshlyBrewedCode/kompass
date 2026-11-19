"""Overlay features and tiles."""

import json
import shutil
import subprocess

import numpy as np
import pyarrow.parquet as pq
import pytest
from test_finalize import build_village_file

from kompass_pipeline import schema, tiles, tools


def test_minzoom_by_class_and_route():
    codes = schema.codes("highway")
    hw = np.array([codes[k] for k in ("primary", "secondary", "track", "path", "steps", "residential")])
    assert tiles.minzooms(hw, np.zeros(6, int)).tolist() == [8, 9, 11, 12, 13, 11]
    assert tiles.minzooms(hw, np.array([0, 0, 2, 2, 0, 0])).tolist() == [8, 9, 10, 10, 13, 11]


def test_feature_lines_carry_integer_id_and_overlay_attributes(village, tmp_path):
    out, _ = build_village_file(village, tmp_path)
    seq = tmp_path / "o.geojsonseq"
    assert tiles.export_geojsonseq(out, seq) == len(village) - 1
    feats = [json.loads(line) for line in seq.read_text().splitlines()]
    assert [f["id"] for f in feats] == list(range(len(feats)))
    track = next(f for f in feats if f["properties"]["highway"] == schema.codes("highway")["track"])
    props = track["properties"]
    assert set(props) <= {a.key for a in schema.OVERLAY}
    assert {"highway", "surface_class", "forest_share", "grade_max"} <= set(props)
    assert all(isinstance(v, int | float) for v in props.values())
    assert track["tippecanoe"]["minzoom"] == 11
    assert track["geometry"]["type"] == "LineString"


def test_grade_max_is_the_larger_direction(village, tmp_path):
    out, _ = build_village_file(village, tmp_path)
    frame = pq.read_table(out).to_pandas()
    batch = {name: col.to_numpy() for name, col in frame.items()}
    props = [json.loads(line)["properties"] for line in tiles.feature_lines(batch)]
    expected = np.maximum(frame.max_grade_fwd_pct, frame.max_grade_bwd_pct).round(1)
    assert np.allclose([p["grade_max"] for p in props], expected, atol=0.05)


@pytest.mark.skipif(not tools.have("tippecanoe"), reason="tippecanoe not installed")
def test_tippecanoe_keeps_the_edge_ids(village, tmp_path):
    out, _ = build_village_file(village, tmp_path)
    pm = tmp_path / "overlay.pmtiles"
    tiles.overlay(out, tmp_path, pm)
    assert pm.exists() and pm.stat().st_size > 0
    if shutil.which("tippecanoe-decode"):
        res = subprocess.run(["tippecanoe-decode", "-c", str(pm)], capture_output=True, text=True)
        if res.returncode == 0:
            feats = [
                json.loads(line) for line in res.stdout.splitlines() if line.startswith('{ "type": "Feature"')
            ]
            ids = {f["id"] for f in feats if "id" in f}
            assert ids and max(ids) < len(village)
