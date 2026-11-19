"""Stage 3: raw OSM tags -> typed per-edge attributes (pure functions over a pandas frame).

Enums are small integers; the code tables below are the proposed contract with the engine
(the real pipeline should emit them as parquet metadata / a generated Rust+TS enum).
"""
import re

import numpy as np
import pandas as pd

HIGHWAY = [  # code = index; 0 = other
    "other", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link",
    "tertiary", "tertiary_link", "unclassified", "residential", "living_street", "service",
    "road", "track", "path", "cycleway", "footway", "bridleway", "steps", "pedestrian", "ferry",
]

# surface class: 0 unknown, 1 paved smooth (asphalt, concrete, paving stones),
# 2 paved rough (sett, cobblestone, concrete plates/lanes, unhewn), 3 compacted / fine gravel,
# 4 gravel / pebbles / unpaved generic, 5 soft (ground, dirt, earth, grass, sand, mud, woodchips),
# 6 other (wood, metal, rock, grass_paver, ...)
SURFACE_CLASS = {
    "asphalt": 1, "concrete": 1, "paved": 1, "paving_stones": 1, "chipseal": 1,
    "paving_stones:lanes": 1, "concrete:plates": 2, "concrete:lanes": 2, "sett": 2,
    "cobblestone": 2, "unhewn_cobblestone": 2, "cobblestone:flattened": 2, "bricks": 2,
    "compacted": 3, "fine_gravel": 3,
    "gravel": 4, "pebblestone": 4, "unpaved": 4, "rock": 4, "shells": 4,
    "ground": 5, "dirt": 5, "earth": 5, "grass": 5, "sand": 5, "mud": 5, "woodchips": 5, "soil": 5,
    "wood": 6, "metal": 6, "grass_paver": 6, "stepping_stones": 6, "artificial_turf": 6,
    "tartan": 6, "clay": 5,
}
SMOOTHNESS = {"excellent": 1, "good": 2, "intermediate": 3, "bad": 4, "very_bad": 5,
              "horrible": 6, "very_horrible": 7, "impassable": 8}
TRAIL_VIS = {"excellent": 1, "good": 2, "intermediate": 3, "bad": 4, "horrible": 5, "no": 6}
SAC = {"hiking": 1, "mountain_hiking": 2, "demanding_mountain_hiking": 3,
       "alpine_hiking": 4, "demanding_alpine_hiking": 5, "difficult_alpine_hiking": 6}

# bike_access: 0 unknown/implicit yes, 1 yes, 2 designated, 3 permissive, 4 destination,
# 5 use_sidepath (blue sign: must use the separate path), 6 dismount, 7 foot_only (footway /
# pedestrian / bridleway without bicycle=yes: not legal to ride in DE by default),
# 8 agri_forestry (access=agricultural/forestry without bicycle=yes), 9 private, 10 no.
# >= 5 is "legally doubtful"; the profile decides.
ACCESS_LEVEL = {"yes": 1, "designated": 2, "permissive": 3, "destination": 4,
                "use_sidepath": 5, "dismount": 6, "private": 9, "customers": 9, "delivery": 9,
                "agricultural": 8, "forestry": 8, "agricultural;forestry": 8, "no": 10,
                "discouraged": 3, "official": 2}

# cycleway_kind: 0 none, 1 shared lane / bus lane, 2 painted lane, 3 track along the road
# (tagged on the road), 4 separate path mapped as its own way (cycleway / designated path),
# 5 bicycle road (Fahrradstrasse). "Along the road vs. away" for kind 4 comes from geometry
# (context.py `road_near_share`), because sidepath tags are sparse.
CW_SIDE = {"lane": 2, "opposite_lane": 2, "track": 3, "opposite_track": 3,
           "shared_lane": 1, "share_busway": 1, "opposite_share_busway": 1, "opposite": 0}

MOTOR = {"no": 1, "agricultural": 2, "forestry": 2, "agricultural;forestry": 2,
         "forestry;agricultural": 2, "destination": 3, "private": 4, "permissive": 5, "yes": 6,
         "designated": 6}  # 0 unknown


def _num(s, pat=r"^\s*([0-9]+(?:[.,][0-9]+)?)"):
    x = s.str.extract(pat, expand=False).str.replace(",", ".")
    return pd.to_numeric(x, errors="coerce")


def maxspeed(df):
    """(kmh, source): source 0 unknown, 1 explicit number, 2 explicit zone/type value,
    3 implicit from maxspeed:type / source:maxspeed / zone:traffic, 4 from forward/backward."""
    ms = df["tag_maxspeed"].fillna("")
    kmh = _num(ms)
    mph = ms.str.contains("mph")
    kmh = kmh.where(~mph, kmh * 1.609)
    src = np.where(kmh.notna(), 1, 0)

    def zone(v):
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
    kmh[take], src[take] = z[take], 2
    for k in ("tag_maxspeed_type", "tag_source_maxspeed", "tag_zone_traffic"):
        z = zone(df[k])
        take = kmh.isna() & z.notna()
        kmh[take], src[take] = z[take], 3
    fb = pd.concat([_num(df["tag_maxspeed_forward"].fillna("")),
                    _num(df["tag_maxspeed_backward"].fillna(""))], axis=1).max(axis=1)
    take = kmh.isna() & fb.notna()
    kmh[take], src[take] = fb[take], 4
    return kmh.round().clip(0, 250).astype("UInt8"), src.astype(np.uint8)


def bike_access(df, hw):
    acc = df["tag_access"].map(ACCESS_LEVEL)
    veh = df["tag_vehicle"].map(ACCESS_LEVEL)
    bic = df["tag_bicycle"].map(ACCESS_LEVEL)
    out = pd.Series(0, index=df.index, dtype="int16")
    # general access first, then vehicle, then bicycle overrides (more specific wins)
    for s in (acc, veh):
        out = s.fillna(out).astype("int16")
    foot_only = hw.isin(["footway", "pedestrian", "bridleway"]) & bic.isna()
    out[foot_only & (out <= 4)] = 7
    out[(hw == "steps") & bic.isna()] = 6
    out[df["tag_motorroad"] == "yes"] = 10
    out = bic.fillna(out).astype("int16")
    out[(hw == "cycleway") & bic.isna() & (out <= 1)] = 2
    return out.astype(np.uint8)


def cycleway_kind(df, hw):
    kind = pd.Series(0, index=df.index, dtype="int16")
    for k in ("tag_cycleway", "tag_cycleway_both", "tag_cycleway_left", "tag_cycleway_right"):
        kind = np.maximum(kind, df[k].map(CW_SIDE).fillna(0).astype("int16"))
    sep = (hw == "cycleway") | (hw.isin(["path", "footway", "bridleway", "track"])
                                & (df["tag_bicycle"] == "designated"))
    kind[sep] = 4
    road = (df["tag_bicycle_road"] == "yes") | (df["tag_cyclestreet"] == "yes")
    kind[road] = 5
    return kind.astype(np.uint8)


def oneway_bike(df, hw):
    """+1 only along geometry, -1 only against, 0 both ways (for bicycles)."""
    ow = df["tag_oneway"].fillna("")
    v = pd.Series(0, index=df.index, dtype="int8")
    v[ow.isin(["yes", "true", "1"])] = 1
    v[ow == "-1"] = -1
    v[(df["tag_junction"].isin(["roundabout", "circular"])) & (ow == "")] = 1
    exempt = (df["tag_oneway_bicycle"] == "no") | df["tag_cycleway"].fillna("").str.startswith("opposite") \
        | df["tag_cycleway_left"].fillna("").str.startswith("opposite")
    v[exempt] = 0
    v[df["tag_oneway_bicycle"] == "yes"] = 1
    v[df["tag_oneway_bicycle"] == "-1"] = -1
    return v


def derive(df):
    hw_raw = df["tag_highway"].where(df["tag_highway"].notna(), "ferry")
    hw = hw_raw.where(hw_raw.isin(HIGHWAY), "other")
    out = pd.DataFrame(index=df.index)
    out["highway"] = pd.Categorical(hw, categories=HIGHWAY).codes.astype(np.uint8)
    out["service"] = df["tag_service"]  # raw, dictionary-encoded (driveway, parking_aisle, ...)
    out["surface"] = df["tag_surface"]  # raw, dictionary-encoded, null = unknown
    out["surface_class"] = df["tag_surface"].map(SURFACE_CLASS).fillna(0).astype(np.uint8)
    out.loc[df["tag_surface"].notna() & (out["surface_class"] == 0), "surface_class"] = 6
    out["tracktype"] = _num(df["tag_tracktype"].fillna(""), r"grade([1-5])").fillna(0).astype(np.uint8)
    out["smoothness"] = df["tag_smoothness"].map(SMOOTHNESS).fillna(0).astype(np.uint8)
    out["maxspeed_kmh"], out["maxspeed_src"] = maxspeed(df)
    out["lanes"] = _num(df["tag_lanes"].fillna(""), r"^\s*(\d+)").clip(0, 20).astype("UInt8")
    out["bike_access"] = bike_access(df, hw)
    out["motor_access"] = df["tag_motor_vehicle"].fillna(df["tag_motorcar"]).map(MOTOR).fillna(0).astype(np.uint8)
    out["foot_access_no"] = df["tag_foot"].isin(["no", "use_sidepath"])
    out["cycleway_kind"] = cycleway_kind(df, hw)
    out["segregated"] = df["tag_segregated"].map({"yes": 1, "no": 2}).fillna(0).astype(np.uint8)
    out["oneway_bike"] = oneway_bike(df, hw)
    out["width_m"] = _num(df["tag_width"].fillna(df["tag_est_width"]).fillna("")).clip(0, 50).astype("float32")
    out["trail_visibility"] = df["tag_trail_visibility"].map(TRAIL_VIS).fillna(0).astype(np.uint8)
    mtb = _num(df["tag_mtb_scale"].fillna(""), r"^\s*(\d)")
    out["mtb_scale"] = (mtb + 1).fillna(0).clip(0, 7).astype(np.uint8)  # 0 unknown, k+1 = S<k>
    out["sac_scale"] = df["tag_sac_scale"].map(SAC).fillna(0).astype(np.uint8)
    out["informal"] = df["tag_informal"] == "yes"
    out["on_bridge"] = df["tag_bridge"].notna() & (df["tag_bridge"] != "no")
    out["in_tunnel"] = df["tag_tunnel"].notna() & (df["tag_tunnel"] != "no")
    out["lit"] = df["tag_lit"].map({"yes": 1, "no": 2, "24/7": 1, "automatic": 1}).fillna(0).astype(np.uint8)
    out["is_sidepath_tag"] = (df["tag_is_sidepath"] == "yes") | df["tag_footway"].isin(["sidewalk"]) \
        | df["tag_path"].isin(["sidewalk"]) | (df["tag_cycleway"] == "sidepath")
    out["name"] = df["tag_name"]
    out["ref"] = df["tag_ref"]
    return out
