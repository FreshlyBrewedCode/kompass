import json
import re
from datetime import UTC, datetime

from conftest import REGION

from kompass_pipeline import manifest, schema, tiles


def test_manifest_matches_the_contract():
    m = manifest.build(REGION, "abc123", datetime(2030, 1, 2, 3, 4, 5, tzinfo=UTC))
    assert m["schemaVersion"] == 1
    assert m["builtAt"] == "2030-01-02T03:04:05Z"
    w, s, e, n = m["bounds"]
    assert w < REGION.lon < e and s < REGION.lat < n
    assert m["center"] == [REGION.lon, REGION.lat]
    assert m["basemap"] == {"file": "basemap.pmtiles", "maxzoom": 15}
    o = m["overlay"]
    assert (o["file"], o["layer"], o["minzoom"], o["maxzoom"]) == ("overlay.pmtiles", "edges", 8, 14)
    assert tiles.OVERLAY_MINZOOM == 8 and tiles.OVERLAY_MAXZOOM == 14
    json.dumps(m)  # serialisable


def test_overlay_attributes_come_from_the_schema():
    attrs = {a["key"]: a for a in manifest.build(REGION, None)["overlay"]["attributes"]}
    assert list(attrs) == [a.key for a in schema.OVERLAY]
    surface = attrs["surface_class"]
    assert surface["kind"] == "enum" and surface["label"] == "Surface"
    assert surface["values"][0] == {"value": 0, "label": "unknown"}
    assert [v["label"] for v in surface["values"]] == list(schema.codes("surface_class"))
    assert {"value": -1, "label": "against"} in attrs["oneway_bike"]["values"]
    assert attrs["forest_share"] == {
        "key": "forest_share",
        "label": "In forest",
        "kind": "share",
        "min": 0,
        "max": 100,
    }
    grade = attrs["grade_max"]
    assert (grade["kind"], grade["unit"], grade["min"], grade["max"]) == ("number", "%", 0, 25)
    for a in attrs.values():
        assert a["kind"] in ("enum", "share", "number")
        assert re.fullmatch(r"[a-z_]+", a["key"])
