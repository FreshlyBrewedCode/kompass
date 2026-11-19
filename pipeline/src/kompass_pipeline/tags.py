"""Raw OSM tags -> typed per-edge attributes (pure functions over a pandas frame of `tag_*` columns).

Values map to enum *labels*; `schema.codes()` turns them into the integer codes, so the code tables
exist only in `schema.py`.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import schema

# raw surface value -> surface_class label (a surface that is tagged but unlisted is `other`)
SURFACE_CLASS = {
    **dict.fromkeys(
        ["asphalt", "concrete", "paved", "paving_stones", "chipseal", "paving_stones:lanes"], "paved_smooth"
    ),
    **dict.fromkeys(
        [
            "concrete:plates",
            "concrete:lanes",
            "sett",
            "cobblestone",
            "unhewn_cobblestone",
            "cobblestone:flattened",
            "bricks",
        ],
        "paved_rough",
    ),
    **dict.fromkeys(["compacted", "fine_gravel"], "compacted"),
    **dict.fromkeys(["gravel", "pebblestone", "unpaved", "rock", "shells"], "gravel"),
    **dict.fromkeys(["ground", "dirt", "earth", "grass", "sand", "mud", "woodchips", "soil", "clay"], "soft"),
}

# raw access value -> bike_access label (generic access / vehicle / bicycle, the most specific wins)
ACCESS_LEVEL = {
    "yes": "yes",
    "designated": "designated",
    "official": "designated",
    "permissive": "permissive",
    "discouraged": "permissive",
    "destination": "destination",
    "use_sidepath": "use_sidepath",
    "dismount": "dismount",
    "private": "private",
    "customers": "private",
    "delivery": "private",
    "agricultural": "agri_forestry",
    "forestry": "agri_forestry",
    "agricultural;forestry": "agri_forestry",
    "no": "no",
}

CW_SIDE = {
    "lane": "lane",
    "opposite_lane": "lane",
    "track": "track",
    "opposite_track": "track",
    "shared_lane": "shared_lane",
    "share_busway": "shared_lane",
    "opposite_share_busway": "shared_lane",
}

MOTOR = {
    "no": "no",
    "agricultural": "agri_forestry",
    "forestry": "agri_forestry",
    "agricultural;forestry": "agri_forestry",
    "forestry;agricultural": "agri_forestry",
    "destination": "destination",
    "private": "private",
    "permissive": "permissive",
    "yes": "yes",
    "designated": "yes",
}

SMOOTHNESS = {v: v for v in schema.codes("smoothness") if v != "unknown"}
TRAIL_VIS = {v: v for v in schema.codes("trail_visibility") if v != "unknown"}
SAC = {v: v for v in schema.codes("sac_scale") if v != "unknown"}


def code(series: pd.Series, mapping: dict[str, str], column: str, default: str = "unknown") -> pd.Series:
    """Maps raw values through `mapping` to labels, then to the integer codes of enum `column`."""
    table = schema.codes(column)
    return series.map(mapping).map(table).fillna(table[default]).astype(np.int16)


def _num(s: pd.Series, pat: str = r"^\s*([0-9]+(?:[.,][0-9]+)?)") -> pd.Series:
    x = s.str.extract(pat, expand=False).str.replace(",", ".")
    return pd.to_numeric(x, errors="coerce")


def maxspeed(df: pd.DataFrame) -> tuple[pd.Series, np.ndarray]:
    """(kmh, source code): `maxspeed_src` 1 explicit number, 2 explicit zone/type value, 3 implicit
    from maxspeed:type / source:maxspeed / zone:traffic, 4 from forward/backward."""
    src_codes = schema.codes("maxspeed_src")
    ms = df["tag_maxspeed"].fillna("")
    kmh = _num(ms)
    kmh = kmh.where(~ms.str.contains("mph"), kmh * 1.609)
    src = np.where(kmh.notna(), src_codes["explicit_number"], src_codes["unknown"])

    def zone(v: pd.Series) -> pd.Series:
        v = v.fillna("").str.lower()
        z = _num(v.str.extract(r"zone:?(\d+)", expand=False).fillna(""))
        out = pd.Series(np.nan, index=v.index)
        out[v.str.endswith(":urban")] = 50
        out[v.str.endswith(":rural")] = 100
        out[v.str.contains("living_street") | (v == "walk")] = 7
        out[v.str.contains("bicycle_road")] = 30
        out = out.fillna(z)
        out[v.str.endswith(":motorway") | (v == "none")] = 130  # no limit: treat as fast
        return out

    z = zone(ms)
    take = kmh.isna() & z.notna()
    kmh[take], src[take] = z[take], src_codes["explicit_zone"]
    for k in ("tag_maxspeed_type", "tag_source_maxspeed", "tag_zone_traffic"):
        z = zone(df[k])
        take = kmh.isna() & z.notna()
        kmh[take], src[take] = z[take], src_codes["implicit_tag"]
    fb = pd.concat(
        [_num(df["tag_maxspeed_forward"].fillna("")), _num(df["tag_maxspeed_backward"].fillna(""))], axis=1
    ).max(axis=1)
    take = kmh.isna() & fb.notna()
    kmh[take], src[take] = fb[take], src_codes["forward_backward"]
    return kmh.round().clip(0, 250).astype("UInt8"), src.astype(np.uint8)


def bike_access(df: pd.DataFrame, hw: pd.Series) -> pd.Series:
    c = schema.codes("bike_access")
    acc = df["tag_access"].map(ACCESS_LEVEL).map(c)
    veh = df["tag_vehicle"].map(ACCESS_LEVEL).map(c)
    bic = df["tag_bicycle"].map(ACCESS_LEVEL).map(c)
    out = pd.Series(c["implicit"], index=df.index, dtype="int16")
    # general access first, then vehicle, then bicycle overrides (more specific wins)
    for s in (acc, veh):
        out = s.fillna(out).astype("int16")
    foot_only = hw.isin(["footway", "pedestrian", "bridleway"]) & bic.isna()
    out[foot_only & (out <= c["destination"])] = c["foot_only"]
    out[(hw == "steps") & bic.isna()] = c["dismount"]
    out[df["tag_motorroad"] == "yes"] = c["no"]
    out = bic.fillna(out).astype("int16")
    out[(hw == "cycleway") & bic.isna() & (out <= c["yes"])] = c["designated"]
    return out.astype(np.uint8)


def cycleway_kind(df: pd.DataFrame, hw: pd.Series) -> pd.Series:
    c = schema.codes("cycleway_kind")
    kind = pd.Series(0, index=df.index, dtype="int16")
    for k in ("tag_cycleway", "tag_cycleway_both", "tag_cycleway_left", "tag_cycleway_right"):
        kind = np.maximum(kind, df[k].map(CW_SIDE).map(c).fillna(0).astype("int16"))
    designated = hw.isin(["path", "footway", "bridleway", "track"]) & (df["tag_bicycle"] == "designated")
    kind[(hw == "cycleway") | designated] = c["separate_path"]
    kind[(df["tag_bicycle_road"] == "yes") | (df["tag_cyclestreet"] == "yes")] = c["bicycle_road"]
    return kind.astype(np.uint8)


def oneway_bike(df: pd.DataFrame) -> pd.Series:
    """+1 only along the geometry, -1 only against it, 0 both ways (for bicycles)."""
    ow = df["tag_oneway"].fillna("")
    v = pd.Series(0, index=df.index, dtype="int8")
    v[ow.isin(["yes", "true", "1"])] = 1
    v[ow == "-1"] = -1
    v[df["tag_junction"].isin(["roundabout", "circular"]) & (ow == "")] = 1
    exempt = (
        (df["tag_oneway_bicycle"] == "no")
        | df["tag_cycleway"].fillna("").str.startswith("opposite")
        | df["tag_cycleway_left"].fillna("").str.startswith("opposite")
    )
    v[exempt] = 0
    v[df["tag_oneway_bicycle"] == "yes"] = 1
    v[df["tag_oneway_bicycle"] == "-1"] = -1
    return v


def derive(df: pd.DataFrame) -> pd.DataFrame:
    """The tag-derived columns of the schema, for a frame of raw `tag_*` columns (key `a:b` -> `tag_a_b`)."""
    hw_codes = schema.codes("highway")
    hw_raw = df["tag_highway"].where(df["tag_highway"].notna(), "ferry")
    hw = hw_raw.where(hw_raw.isin(hw_codes), "other")
    out = pd.DataFrame(index=df.index)
    out["highway"] = hw.map(hw_codes).astype(np.uint8)
    out["service"] = df["tag_service"]
    out["surface"] = df["tag_surface"]
    sc = schema.codes("surface_class")
    out["surface_class"] = (
        df["tag_surface"]
        .map(SURFACE_CLASS)
        .map(sc)
        .fillna(sc["other"])
        .where(df["tag_surface"].notna(), 0)
        .astype(np.uint8)
    )
    out["tracktype"] = _num(df["tag_tracktype"].fillna(""), r"grade([1-5])").fillna(0).astype(np.uint8)
    out["smoothness"] = code(df["tag_smoothness"], SMOOTHNESS, "smoothness").astype(np.uint8)
    out["maxspeed_kmh"], out["maxspeed_src"] = maxspeed(df)
    out["lanes"] = _num(df["tag_lanes"].fillna(""), r"^\s*(\d+)").clip(0, 20).astype("UInt8")
    out["bike_access"] = bike_access(df, hw)
    out["motor_access"] = code(
        df["tag_motor_vehicle"].fillna(df["tag_motorcar"]), MOTOR, "motor_access"
    ).astype(np.uint8)
    out["foot_access_no"] = df["tag_foot"].isin(["no", "use_sidepath"])
    out["cycleway_kind"] = cycleway_kind(df, hw)
    out["segregated"] = code(df["tag_segregated"], {"yes": "yes", "no": "no"}, "segregated").astype(np.uint8)
    out["is_sidepath_tag"] = (
        (df["tag_is_sidepath"] == "yes")
        | (df["tag_footway"] == "sidewalk")
        | (df["tag_path"] == "sidewalk")
        | (df["tag_cycleway"] == "sidepath")
    )
    out["oneway_bike"] = oneway_bike(df)
    out["width_m"] = (
        _num(df["tag_width"].fillna(df["tag_est_width"]).fillna("")).clip(0, 50).astype("float32")
    )
    out["trail_visibility"] = code(df["tag_trail_visibility"], TRAIL_VIS, "trail_visibility").astype(np.uint8)
    mtb = _num(df["tag_mtb_scale"].fillna(""), r"^\s*(\d)")
    out["mtb_scale"] = (mtb + 1).fillna(0).clip(0, 7).astype(np.uint8)  # 0 unknown, k+1 = S<k>
    out["sac_scale"] = code(df["tag_sac_scale"], SAC, "sac_scale").astype(np.uint8)
    out["informal"] = df["tag_informal"] == "yes"
    out["on_bridge"] = df["tag_bridge"].notna() & (df["tag_bridge"] != "no")
    out["in_tunnel"] = df["tag_tunnel"].notna() & (df["tag_tunnel"] != "no")
    lit = {"yes": "yes", "24/7": "yes", "automatic": "yes", "no": "no"}
    out["lit"] = code(df["tag_lit"], lit, "lit").astype(np.uint8)
    out["name"] = df["tag_name"]
    out["ref"] = df["tag_ref"]
    return out
