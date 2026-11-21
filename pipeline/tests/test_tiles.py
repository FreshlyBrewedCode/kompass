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
    assert tiles.minzooms(hw, np.zeros(6, int)).tolist() == [8, 9, 12, 13, 13, 12]
    assert tiles.minzooms(hw, np.array([0, 0, 2, 3, 0, 1])).tolist() == [8, 9, 11, 10, 13, 12]


def test_good_tracks_come_one_zoom_earlier():
    hw = np.full(7, schema.codes("highway")["track"])
    grade = np.array([0, 1, 2, 3, 4, 5, 0])
    assert tiles.minzooms(hw, np.zeros(7, int), grade).tolist() == [12, 11, 11, 11, 12, 12, 12]
    path = np.full(2, schema.codes("highway")["path"])
    assert tiles.minzooms(path, np.zeros(2, int), np.array([1, 0])).tolist() == [13, 13]


def test_feature_lines_carry_integer_id_and_overlay_attributes(village, tmp_path):
    out, _ = build_village_file(village, tmp_path)
    seq = tmp_path / "o.geojsonseq"
    assert tiles.export_geojsonseq(out, seq) == len(village) - 1
    feats = [json.loads(line) for line in seq.read_text().splitlines()]
    assert [f["id"] for f in feats] == list(range(len(feats)))
    track = next(f for f in feats if f["properties"]["highway"] == schema.codes("highway")["track"])
    props = track["properties"]
    assert set(props) <= {a.key for a in schema.OVERLAY} | set(schema.OVERLAY_DRAWING)
    assert {"highway", "surface_class", "forest_share", "grade_max"} <= set(props)
    assert all(isinstance(v, int | float) for v in props.values())
    assert track["tippecanoe"]["minzoom"] in (tiles.GOOD_TRACK_MINZOOM, tiles.TRACK_MINZOOM)
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


def _batch(village, tmp_path):
    out, _ = build_village_file(village, tmp_path)
    frame = pq.read_table(out).to_pandas()
    return {name: col.to_numpy() for name, col in frame.items()}


def test_drawing_properties_are_written_only_when_not_default(village, tmp_path):
    batch = _batch(village, tmp_path)
    n = len(batch["edge_id"])
    batch["on_bridge"] = batch["on_bridge"].copy()
    batch["on_bridge"][:] = False
    batch["in_tunnel"] = batch["in_tunnel"].copy()
    batch["in_tunnel"][:] = False
    batch["layer"] = np.zeros(n, dtype=np.int8)
    batch["on_bridge"][0], batch["in_tunnel"][1], batch["layer"][0], batch["layer"][1] = True, True, 1, -1
    props = [json.loads(line)["properties"] for line in tiles.feature_lines(batch)]
    assert (props[0]["bridge"], props[0]["layer"]) == (1, 1) and "tunnel" not in props[0]
    assert (props[1]["tunnel"], props[1]["layer"]) == (1, -1) and "bridge" not in props[1]
    assert all(not {"bridge", "tunnel", "layer"} & set(p) for p in props[2:])


def test_service_kind_tells_car_parks_from_service_roads():
    hw = schema.codes("highway")
    service = np.array(["parking_aisle", "driveway", "alley", None, "driveway"], dtype=object)
    highway = np.array([hw["service"]] * 4 + [hw["residential"]])
    assert tiles.service_kinds(service, highway).tolist() == [1, 2, 0, 0, 0]


def test_ferries_stay_distinguishable_by_road_class(village, tmp_path):
    batch = _batch(village, tmp_path)
    batch["highway"] = batch["highway"].copy()
    batch["highway"][0] = schema.codes("highway")["ferry"]
    props = [json.loads(line) for line in tiles.feature_lines(batch)]
    assert props[0]["properties"]["highway"] == 21 and props[0]["tippecanoe"]["minzoom"] == 8
    assert all(p["properties"]["highway"] != 21 for p in props[1:])


def test_old_style_attributes_keep_working_without_drawing_keys_in_attributes():
    assert not {a.key for a in schema.OVERLAY} & set(schema.OVERLAY_DRAWING)


@pytest.mark.skipif(not tools.have("tippecanoe"), reason="tippecanoe not installed")
def test_tilestats_reads_the_overlay(village, tmp_path):
    from kompass_pipeline import tilestats

    out, _ = build_village_file(village, tmp_path)
    pm = tmp_path / "overlay.pmtiles"
    tiles.overlay(out, tmp_path, pm)
    sizes = tilestats.tile_sizes(pm)
    assert max(sizes) == tiles.OVERLAY_MAXZOOM and min(sizes) >= tiles.OVERLAY_MINZOOM
    assert all(s > 0 for z in sizes.values() for s in z)
    assert "max KB" in tilestats.report(pm)
