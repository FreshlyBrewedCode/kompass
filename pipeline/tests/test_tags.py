"""Tag -> attribute mapping: surface classes, track types, cycleways, access, one-way for bikes."""

import pandas as pd

from kompass_pipeline import schema, tags
from kompass_pipeline.ways import TAG_KEYS


def frame(*rows: dict) -> pd.DataFrame:
    """Raw-tag rows ({'highway': 'track', 'surface': 'gravel', ...}) as the `tag_*` frame."""
    cols = {"tag_" + k.replace(":", "_"): [r.get(k) for r in rows] for k in TAG_KEYS}
    return pd.DataFrame(cols, dtype="object")


def label(column: str, value: int) -> str:
    return schema.enum_table(column)[int(value)]


def derived(**tags_):
    return tags.derive(frame(tags_)).iloc[0]


def test_surface_classes():
    cases = {
        "asphalt": "paved_smooth", "paving_stones": "paved_smooth", "sett": "paved_rough",
        "compacted": "compacted", "fine_gravel": "compacted", "gravel": "gravel", "unpaved": "gravel",
        "ground": "soft", "grass": "soft", "wood": "other", "something_new": "other",
    }  # fmt: skip
    for surface, expected in cases.items():
        assert label("surface_class", derived(highway="track", surface=surface).surface_class) == expected
    row = derived(highway="track")
    assert label("surface_class", row.surface_class) == "unknown"
    assert pd.isna(row.surface)
    assert derived(highway="track", surface="gravel").surface == "gravel"  # the raw value stays


def test_tracktype_and_smoothness():
    row = derived(highway="track", tracktype="grade4", smoothness="very_bad")
    assert row.tracktype == 4
    assert label("smoothness", row.smoothness) == "very_bad"
    assert derived(highway="track").tracktype == 0
    assert derived(highway="track", tracktype="bogus").tracktype == 0


def test_highway_codes():
    assert label("highway", derived(highway="residential").highway) == "residential"
    assert label("highway", derived(highway="residential_link").highway) == "other"
    assert label("highway", tags.derive(frame({"route": "ferry"})).highway.iloc[0]) == "ferry"


def test_cycleway_kinds():
    kind = lambda **t: label("cycleway_kind", derived(**t).cycleway_kind)  # noqa: E731
    assert kind(highway="residential") == "none"
    assert kind(highway="residential", cycleway="lane") == "lane"
    assert kind(highway="secondary", **{"cycleway:right": "track"}) == "track"
    assert kind(highway="residential", cycleway="shared_lane") == "shared_lane"
    assert kind(highway="cycleway") == "separate_path"
    assert kind(highway="path", bicycle="designated") == "separate_path"
    assert kind(highway="residential", bicycle_road="yes") == "bicycle_road"


def test_bike_access():
    access = lambda **t: label("bike_access", derived(**t).bike_access)  # noqa: E731
    assert access(highway="residential") == "implicit"
    assert access(highway="footway") == "foot_only"
    assert access(highway="footway", bicycle="yes") == "yes"
    assert access(highway="steps") == "dismount"
    assert access(highway="service", access="private") == "private"
    assert access(highway="service", access="private", bicycle="yes") == "yes"  # the specific tag wins
    assert access(highway="track", access="forestry") == "agri_forestry"
    assert access(highway="cycleway") == "designated"
    assert access(highway="primary", motorroad="yes") == "no"
    assert access(highway="path", bicycle="use_sidepath") == "use_sidepath"


def test_motor_access():
    assert (
        label("motor_access", derived(highway="track", motor_vehicle="agricultural").motor_access)
        == "agri_forestry"
    )
    assert label("motor_access", derived(highway="track").motor_access) == "unknown"


def test_oneway_for_bicycles():
    ow = lambda **t: int(derived(**t).oneway_bike)  # noqa: E731
    assert ow(highway="residential") == 0
    assert ow(highway="residential", oneway="yes") == 1
    assert ow(highway="residential", oneway="-1") == -1
    assert ow(highway="residential", junction="roundabout") == 1
    assert ow(highway="residential", oneway="yes", **{"oneway:bicycle": "no"}) == 0
    assert ow(highway="residential", oneway="yes", cycleway="opposite_lane") == 0
    assert ow(highway="residential", **{"oneway:bicycle": "yes"}) == 1


def test_maxspeed():
    row = lambda **t: derived(highway="residential", **t)  # noqa: E731
    r = row(maxspeed="30")
    assert (r.maxspeed_kmh, label("maxspeed_src", r.maxspeed_src)) == (30, "explicit_number")
    r = row(maxspeed="DE:urban")
    assert (r.maxspeed_kmh, label("maxspeed_src", r.maxspeed_src)) == (50, "explicit_zone")
    r = row(maxspeed="30 mph")
    assert r.maxspeed_kmh == 48
    r = row(**{"source:maxspeed": "DE:zone:30"})
    assert (r.maxspeed_kmh, label("maxspeed_src", r.maxspeed_src)) == (30, "implicit_tag")
    r = row(**{"maxspeed:forward": "60", "maxspeed:backward": "50"})
    assert (r.maxspeed_kmh, label("maxspeed_src", r.maxspeed_src)) == (60, "forward_backward")
    r = row()
    assert pd.isna(r.maxspeed_kmh) and label("maxspeed_src", r.maxspeed_src) == "unknown"
    assert row(maxspeed="none").maxspeed_kmh == 130


def test_trail_and_misc_attributes():
    r = derived(
        highway="path", **{"mtb:scale": "2", "trail_visibility": "bad", "sac_scale": "hiking"},
        width="0.8", informal="yes", bridge="viaduct", tunnel="no", lit="yes", lanes="2",
    )  # fmt: skip
    assert label("mtb_scale", r.mtb_scale) == "S2"
    assert label("trail_visibility", r.trail_visibility) == "bad"
    assert label("sac_scale", r.sac_scale) == "hiking"
    assert abs(r.width_m - 0.8) < 1e-6
    assert r.informal and r.on_bridge and not r.in_tunnel
    assert label("lit", r.lit) == "yes"
    assert r.lanes == 2
    assert derived(highway="path").mtb_scale == 0


def test_every_code_is_in_its_enum_table(village):
    derived_frame = tags.derive(village)
    for column in schema.BY_NAME:
        if column in derived_frame and schema.BY_NAME[column].enum:
            allowed = set(schema.enum_table(column))
            assert set(derived_frame[column].astype(int)) <= allowed, column
