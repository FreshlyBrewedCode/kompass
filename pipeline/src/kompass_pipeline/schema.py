"""The `edges.parquet` contract: the one place that defines every column, its dtype, its meaning and
the labels of its enum codes.

Everything that has to agree with this is generated from or checked against it:
- the parquet writer (`arrow_schema`, `file_metadata`) and the tag mapping (`tags.py` maps raw OSM
  values to enum *labels*, `codes()` turns them into the integer codes),
- the overlay tiles and the manifest's attribute list (`OVERLAY`),
- `docs/edges-parquet.md` (`render_columns_markdown`, checked by a test),
- later the Rust engine and the TypeScript types.

Dtypes stay simple on purpose: uint8/16/32, int8, float32, int64 ids, bool, string, WKB.
Bump `SCHEMA_VERSION` for every change a reader has to know about.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import pyarrow as pa

SCHEMA_VERSION = 1

#: Parquet key-value metadata keys.
META_SCHEMA_VERSION = "kompass:schema_version"
META_ENUMS = "kompass:enums"
META_BUILD_ID = "kompass:build_id"


@dataclass(frozen=True)
class Column:
    name: str
    dtype: pa.DataType
    doc: str
    nullable: bool = False
    #: enum code -> label, for integer columns that carry a code table
    enum: tuple[tuple[int, str], ...] | None = None
    #: stored dictionary-encoded on disk (low-cardinality strings)
    dictionary: bool = False


def _enum(*labels: str, start: int = 0) -> tuple[tuple[int, str], ...]:
    return tuple((start + i, label) for i, label in enumerate(labels))


def _c(name, dtype, doc, **kw) -> Column:
    return Column(name, dtype, doc, **kw)


u8, u16, u32, i8, i64, f32 = pa.uint8(), pa.uint16(), pa.uint32(), pa.int8(), pa.int64(), pa.float32()

HIGHWAY = _enum(
    "other",
    "trunk",
    "trunk_link",
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "unclassified",
    "residential",
    "living_street",
    "service",
    "road",
    "track",
    "path",
    "cycleway",
    "footway",
    "bridleway",
    "steps",
    "pedestrian",
    "ferry",
)

COLUMNS: tuple[Column, ...] = (
    _c(
        "edge_id",
        u32,
        "Row number after sorting. **Not stable across builds**: the overlay tiles, the "
        "graph tiles and any history matched against the edges must come from the same build.",
    ),
    _c(
        "hilbert_z16",
        u32,
        "Hilbert index of the edge midpoint's web-mercator z16 tile; the rows are "
        "sorted by it, so every tile at zoom <= 16 is a contiguous run of rows.",
    ),
    _c("way_id", i64, "OSM way id (for corrections: way id + positions)."),
    _c("way_pos_from", u16, "Position of the edge's first node within the OSM way."),
    _c("way_pos_to", u16, "Position of the edge's last node within the OSM way."),
    _c("node_from", i64, "OSM node id of the first end junction (the graph's node identity)."),
    _c("node_to", i64, "OSM node id of the last end junction."),
    _c("length_m", f32, "Length in metres (azimuthal equidistant projection around the region centre)."),
    _c("highway", u8, "Road class.", enum=HIGHWAY),
    _c(
        "service",
        pa.string(),
        "Raw `service` value (driveway, parking_aisle, ...), null if absent.",
        nullable=True,
        dictionary=True,
    ),
    _c("surface", pa.string(), "Raw `surface` value, null = unknown.", nullable=True, dictionary=True),
    _c(
        "surface_class",
        u8,
        "`surface` classified. `paved_rough` is sett, cobblestone, concrete plates; "
        "`compacted` is compacted and fine gravel; `soft` is ground, grass, sand, mud.",
        enum=_enum("unknown", "paved_smooth", "paved_rough", "compacted", "gravel", "soft", "other"),
    ),
    _c(
        "tracktype",
        u8,
        "`tracktype` grade.",
        enum=_enum("unknown", "grade1", "grade2", "grade3", "grade4", "grade5"),
    ),
    _c(
        "smoothness",
        u8,
        "`smoothness`, best to worst.",
        enum=_enum(
            "unknown",
            "excellent",
            "good",
            "intermediate",
            "bad",
            "very_bad",
            "horrible",
            "very_horrible",
            "impassable",
        ),
    ),
    _c(
        "maxspeed_kmh",
        u8,
        "Parsed `maxspeed` in km/h (zone values become numbers, `none` is 130).",
        nullable=True,
    ),
    _c(
        "maxspeed_src",
        u8,
        "Where `maxspeed_kmh` came from.",
        enum=_enum("unknown", "explicit_number", "explicit_zone", "implicit_tag", "forward_backward"),
    ),
    _c("lanes", u8, "`lanes`.", nullable=True),
    _c(
        "bike_access",
        u8,
        "Legal bicycle access. Everything from `use_sidepath` on is legally doubtful "
        "and left to the profile; nothing is dropped for it. `foot_only` is the German default on "
        "footway, pedestrian and bridleway without `bicycle=yes`.",
        enum=_enum(
            "implicit",
            "yes",
            "designated",
            "permissive",
            "destination",
            "use_sidepath",
            "dismount",
            "foot_only",
            "agri_forestry",
            "private",
            "no",
        ),
    ),
    _c(
        "motor_access",
        u8,
        "Motor vehicle access (a quiet-track signal).",
        enum=_enum("unknown", "no", "agri_forestry", "destination", "private", "permissive", "yes"),
    ),
    _c("foot_access_no", pa.bool_(), "`foot=no` or `foot=use_sidepath`."),
    _c(
        "cycleway_kind",
        u8,
        "Cycling infrastructure. `track` and `lane` are tagged on the road, "
        "`separate_path` is a way of its own (use `road_near_share` to tell along-the-road from away).",
        enum=_enum("none", "shared_lane", "lane", "track", "separate_path", "bicycle_road"),
    ),
    _c(
        "segregated",
        u8,
        "`segregated` (foot and bike share a path or not).",
        enum=_enum("unknown", "yes", "no"),
    ),
    _c(
        "is_sidepath_tag",
        pa.bool_(),
        "Tagged as running along a road (`is_sidepath`, sidewalk, ...). Sparse: prefer `road_near_share`.",
    ),
    _c(
        "route_level",
        u8,
        "Best bicycle route relation the way belongs to.",
        enum=_enum("none", "lcn", "rcn", "ncn", "icn"),
    ),
    _c("mtb_route", pa.bool_(), "Member of a `route=mtb` relation."),
    _c(
        "oneway_bike",
        i8,
        "One-way for bicycles, relative to the geometry's direction.",
        enum=((-1, "against"), (0, "both"), (1, "along")),
    ),
    _c("width_m", f32, "`width` or `est_width` in metres.", nullable=True),
    _c(
        "trail_visibility",
        u8,
        "`trail_visibility`.",
        enum=_enum("unknown", "excellent", "good", "intermediate", "bad", "horrible", "no"),
    ),
    _c(
        "mtb_scale",
        u8,
        "`mtb:scale`: code k+1 is S<k>.",
        enum=_enum("unknown", "S0", "S1", "S2", "S3", "S4", "S5", "S6"),
    ),
    _c(
        "sac_scale",
        u8,
        "`sac_scale`.",
        enum=_enum(
            "unknown",
            "hiking",
            "mountain_hiking",
            "demanding_mountain_hiking",
            "alpine_hiking",
            "demanding_alpine_hiking",
            "difficult_alpine_hiking",
        ),
    ),
    _c("informal", pa.bool_(), "`informal=yes` (a desire path)."),
    _c("on_bridge", pa.bool_(), "On a bridge."),
    _c("in_tunnel", pa.bool_(), "In a tunnel."),
    _c("lit", u8, "Street lighting.", enum=_enum("unknown", "yes", "no")),
    _c("n_barriers", u8, "Gates, bollards, stiles, ... on the edge's nodes."),
    _c("name", pa.string(), "`name`, for display.", nullable=True, dictionary=True),
    _c("ref", pa.string(), "`ref`, for display.", nullable=True, dictionary=True),
    _c("forest_share", u8, "Percent of the length inside forest."),
    _c("forest_edge_share", u8, "Percent within 30 m outside or 10 m inside a forest boundary."),
    _c("water_share", u8, "Percent within 100 m of a lake or river area, or a river or canal."),
    _c("builtup_share", u8, "Percent inside built-up landuse."),
    _c("road_near_share", u8, "Percent within 20 m of a motor road (100 on roads themselves)."),
    _c(
        "ele_from_m",
        f32,
        "Elevation at the first end node (smoothing keeps the ends raw, so all edges at a node agree).",
    ),
    _c("ele_to_m", f32, "Elevation at the last end node."),
    _c("ascent_fwd_m", f32, "Climbing along the geometry's direction (smoothed profile)."),
    _c("ascent_bwd_m", f32, "Climbing against the geometry's direction."),
    _c(
        "max_grade_fwd_pct",
        f32,
        "Steepest 50 m stretch along the direction (whole edge if shorter), percent, clipped to 0..100.",
    ),
    _c("max_grade_bwd_pct", f32, "Steepest 50 m stretch against the direction."),
    _c("geometry", pa.binary(), "WKB LineString, EPSG:4326 (lon/lat, float64)."),
)

BY_NAME = {c.name: c for c in COLUMNS}


def arrow_schema() -> pa.Schema:
    return pa.schema([pa.field(c.name, c.dtype, nullable=c.nullable) for c in COLUMNS])


def enum_table(name: str) -> dict[int, str]:
    enum = BY_NAME[name].enum
    if enum is None:
        raise KeyError(f"{name} has no enum")
    return dict(enum)


def codes(name: str) -> dict[str, int]:
    """Label -> integer code for an enum column."""
    return {label: code for code, label in BY_NAME[name].enum or ()}


def file_metadata(build_id: str | None = None) -> dict[str, str]:
    """The parquet key-value metadata (besides the GeoParquet `geo` key): schema version, the enum
    code tables, and the build id that ties the file to its overlay tiles."""
    enums = {c.name: {str(k): v for k, v in c.enum} for c in COLUMNS if c.enum}
    meta = {META_SCHEMA_VERSION: str(SCHEMA_VERSION), META_ENUMS: json.dumps(enums, separators=(",", ":"))}
    if build_id:
        meta[META_BUILD_ID] = build_id
    return meta


# --- the overlay tiles' attributes (what the debug map can colour by) -----------------------------


@dataclass(frozen=True)
class OverlayAttr:
    key: str
    label: str
    #: "enum" (integer codes with labels), "share" (0..`max`) or "number" (with unit and range)
    kind: str
    #: parquet column(s) it comes from; several are reduced by `max` (e.g. grade)
    source: tuple[str, ...] = field(default=())
    unit: str | None = None
    min: float | None = None
    max: float | None = None

    @property
    def column(self) -> str:
        return self.source[0] if self.source else self.key


def _enum_attr(key: str, label: str) -> OverlayAttr:
    return OverlayAttr(key, label, "enum", (key,))


def _share(key: str, label: str) -> OverlayAttr:
    return OverlayAttr(key, label, "share", (key,), min=0, max=100)


OVERLAY: tuple[OverlayAttr, ...] = (
    _enum_attr("highway", "Road class"),
    _enum_attr("surface_class", "Surface"),
    _enum_attr("tracktype", "Track type"),
    _enum_attr("smoothness", "Smoothness"),
    _enum_attr("bike_access", "Bicycle access"),
    _enum_attr("motor_access", "Motor access"),
    _enum_attr("cycleway_kind", "Cycle infrastructure"),
    _enum_attr("route_level", "Bicycle route"),
    _enum_attr("oneway_bike", "Bicycle one-way"),
    _enum_attr("mtb_scale", "MTB scale"),
    _enum_attr("trail_visibility", "Trail visibility"),
    OverlayAttr("maxspeed_kmh", "Max speed", "number", ("maxspeed_kmh",), unit="km/h", min=0, max=130),
    _share("forest_share", "In forest"),
    _share("forest_edge_share", "Forest edge"),
    _share("water_share", "Near water"),
    _share("builtup_share", "Built-up"),
    _share("road_near_share", "Near a motor road"),
    OverlayAttr(
        "grade_max",
        "Max grade",
        "number",
        ("max_grade_fwd_pct", "max_grade_bwd_pct"),
        unit="%",
        min=0,
        max=25,
    ),
)


def overlay_manifest() -> list[dict]:
    """The `overlay.attributes` list of the manifest, derived from `OVERLAY` and the enum tables."""
    out = []
    for a in OVERLAY:
        item: dict = {"key": a.key, "label": a.label, "kind": a.kind}
        if a.kind == "enum":
            item["values"] = [{"value": v, "label": lab} for v, lab in BY_NAME[a.column].enum or ()]
        else:
            if a.unit:
                item["unit"] = a.unit
            item["min"], item["max"] = a.min, a.max
        out.append(item)
    return out


# --- documentation -----------------------------------------------------------------------------

_DTYPE_NAMES = {
    "uint8": "uint8",
    "uint16": "uint16",
    "uint32": "uint32",
    "int8": "int8",
    "int64": "int64",
    "float": "float32",
    "bool": "bool",
    "string": "string",
    "binary": "binary (WKB)",
}


def render_columns_markdown() -> str:
    """The column and enum tables of `docs/edges-parquet.md`; a test keeps the page in sync."""
    rows = ["| column | type | meaning |", "|---|---|---|"]
    for c in COLUMNS:
        t = _DTYPE_NAMES[str(c.dtype)]
        if c.nullable:
            t += ", nullable"
        if c.dictionary:
            t += ", dictionary-encoded"
        rows.append(f"| `{c.name}` | {t} | {c.doc} |")
    out = ["\n".join(rows), "", "### Enum codes", ""]
    for c in COLUMNS:
        if c.enum:
            codes_text = ", ".join(f"{code} {label}" for code, label in c.enum)
            out.append(f"- `{c.name}`: {codes_text}")
    return "\n".join(out)
