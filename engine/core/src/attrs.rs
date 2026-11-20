//! Edge attributes: the enums of `edges.parquet` (codes and labels exactly as in
//! `pipeline/src/kompass_pipeline/schema.py`; a test checks them against `docs/edges-parquet.md`,
//! which the pipeline generates from the schema, and the compiler checks them against the
//! `kompass:enums` metadata of every file it reads), the decoded [`EdgeAttrs`], and how they are
//! quantised into the packed columns of the graph ([`Packed`], bit layouts in `docs/graph-format.md`).

/// Declares a `u8`-coded attribute enum with its parquet column name, codes and labels.
macro_rules! code_enum {
    ($(#[$meta:meta])* $name:ident = $column:literal {
        $($(#[$vmeta:meta])* $variant:ident = $code:literal => $label:literal,)+
    }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
        #[repr(u8)]
        pub enum $name {
            #[default]
            $($(#[$vmeta])* $variant = $code,)+
        }

        impl $name {
            /// The `edges.parquet` column.
            pub const COLUMN: &'static str = $column;
            /// Every value, in code order.
            pub const ALL: &'static [$name] = &[$($name::$variant,)+];

            /// The value of a code, `None` if the code is unknown.
            #[must_use]
            pub fn from_code(code: u8) -> Option<Self> {
                match code {
                    $($code => Some(Self::$variant),)+
                    _ => None,
                }
            }

            #[must_use]
            pub fn code(self) -> u8 {
                self as u8
            }

            /// The label in `edges.parquet`'s code table.
            #[must_use]
            pub fn label(self) -> &'static str {
                match self {
                    $(Self::$variant => $label,)+
                }
            }
        }
    };
}

// `#[default]` lands on the first variant (code 0, "unknown" / "none" / "other" everywhere).
code_enum! {
    /// Road class (`highway`).
    Highway = "highway" {
        Other = 0 => "other",
        Trunk = 1 => "trunk",
        TrunkLink = 2 => "trunk_link",
        Primary = 3 => "primary",
        PrimaryLink = 4 => "primary_link",
        Secondary = 5 => "secondary",
        SecondaryLink = 6 => "secondary_link",
        Tertiary = 7 => "tertiary",
        TertiaryLink = 8 => "tertiary_link",
        Unclassified = 9 => "unclassified",
        Residential = 10 => "residential",
        LivingStreet = 11 => "living_street",
        Service = 12 => "service",
        Road = 13 => "road",
        Track = 14 => "track",
        Path = 15 => "path",
        Cycleway = 16 => "cycleway",
        Footway = 17 => "footway",
        Bridleway = 18 => "bridleway",
        Steps = 19 => "steps",
        Pedestrian = 20 => "pedestrian",
        Ferry = 21 => "ferry",
    }
}

code_enum! {
    /// `surface` classified.
    SurfaceClass = "surface_class" {
        Unknown = 0 => "unknown",
        PavedSmooth = 1 => "paved_smooth",
        PavedRough = 2 => "paved_rough",
        Compacted = 3 => "compacted",
        Gravel = 4 => "gravel",
        Soft = 5 => "soft",
        Other = 6 => "other",
    }
}

code_enum! {
    /// `tracktype` grade.
    Tracktype = "tracktype" {
        Unknown = 0 => "unknown",
        Grade1 = 1 => "grade1",
        Grade2 = 2 => "grade2",
        Grade3 = 3 => "grade3",
        Grade4 = 4 => "grade4",
        Grade5 = 5 => "grade5",
    }
}

code_enum! {
    /// `smoothness`, best to worst.
    Smoothness = "smoothness" {
        Unknown = 0 => "unknown",
        Excellent = 1 => "excellent",
        Good = 2 => "good",
        Intermediate = 3 => "intermediate",
        Bad = 4 => "bad",
        VeryBad = 5 => "very_bad",
        Horrible = 6 => "horrible",
        VeryHorrible = 7 => "very_horrible",
        Impassable = 8 => "impassable",
    }
}

code_enum! {
    /// Legal bicycle access. From `UseSidepath` on it is legally doubtful: the profile decides.
    BikeAccess = "bike_access" {
        Implicit = 0 => "implicit",
        Yes = 1 => "yes",
        Designated = 2 => "designated",
        Permissive = 3 => "permissive",
        Destination = 4 => "destination",
        UseSidepath = 5 => "use_sidepath",
        Dismount = 6 => "dismount",
        FootOnly = 7 => "foot_only",
        AgriForestry = 8 => "agri_forestry",
        Private = 9 => "private",
        No = 10 => "no",
    }
}

code_enum! {
    /// Motor vehicle access (a quiet-track signal).
    MotorAccess = "motor_access" {
        Unknown = 0 => "unknown",
        No = 1 => "no",
        AgriForestry = 2 => "agri_forestry",
        Destination = 3 => "destination",
        Private = 4 => "private",
        Permissive = 5 => "permissive",
        Yes = 6 => "yes",
    }
}

code_enum! {
    /// Cycling infrastructure.
    CyclewayKind = "cycleway_kind" {
        None = 0 => "none",
        SharedLane = 1 => "shared_lane",
        Lane = 2 => "lane",
        Track = 3 => "track",
        SeparatePath = 4 => "separate_path",
        BicycleRoad = 5 => "bicycle_road",
    }
}

code_enum! {
    /// Best bicycle route relation the way belongs to.
    RouteLevel = "route_level" {
        None = 0 => "none",
        Lcn = 1 => "lcn",
        Rcn = 2 => "rcn",
        Ncn = 3 => "ncn",
        Icn = 4 => "icn",
    }
}

code_enum! {
    /// `trail_visibility`.
    TrailVisibility = "trail_visibility" {
        Unknown = 0 => "unknown",
        Excellent = 1 => "excellent",
        Good = 2 => "good",
        Intermediate = 3 => "intermediate",
        Bad = 4 => "bad",
        Horrible = 5 => "horrible",
        No = 6 => "no",
    }
}

code_enum! {
    /// `mtb:scale`: code k + 1 is S<k>.
    MtbScale = "mtb_scale" {
        Unknown = 0 => "unknown",
        S0 = 1 => "S0",
        S1 = 2 => "S1",
        S2 = 3 => "S2",
        S3 = 4 => "S3",
        S4 = 5 => "S4",
        S5 = 6 => "S5",
        S6 = 7 => "S6",
    }
}

code_enum! {
    /// `sac_scale`.
    SacScale = "sac_scale" {
        Unknown = 0 => "unknown",
        Hiking = 1 => "hiking",
        MountainHiking = 2 => "mountain_hiking",
        DemandingMountainHiking = 3 => "demanding_mountain_hiking",
        AlpineHiking = 4 => "alpine_hiking",
        DemandingAlpineHiking = 5 => "demanding_alpine_hiking",
        DifficultAlpineHiking = 6 => "difficult_alpine_hiking",
    }
}

/// One-way for bicycles, relative to the geometry's direction (`oneway_bike`, an `int8`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Oneway {
    #[default]
    Both,
    /// Ridable only along the geometry (from → to).
    Along,
    /// Ridable only against the geometry (to → from).
    Against,
}

impl Oneway {
    pub const COLUMN: &'static str = "oneway_bike";
    pub const ALL: &'static [Oneway] = &[Oneway::Against, Oneway::Both, Oneway::Along];

    #[must_use]
    pub fn from_code(code: i8) -> Option<Self> {
        match code {
            -1 => Some(Oneway::Against),
            0 => Some(Oneway::Both),
            1 => Some(Oneway::Along),
            _ => None,
        }
    }

    #[must_use]
    pub fn code(self) -> i8 {
        match self {
            Oneway::Against => -1,
            Oneway::Both => 0,
            Oneway::Along => 1,
        }
    }

    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Oneway::Against => "against",
            Oneway::Both => "both",
            Oneway::Along => "along",
        }
    }

    /// Whether riding along (`reverse = false`) or against (`true`) the geometry is allowed.
    #[must_use]
    pub fn allows(self, reverse: bool) -> bool {
        match self {
            Oneway::Both => true,
            Oneway::Along => !reverse,
            Oneway::Against => reverse,
        }
    }
}

/// Every enum column with its `(code, label)` table, for the drift checks.
#[must_use]
pub fn code_tables() -> Vec<(&'static str, Vec<(i32, &'static str)>)> {
    fn table<T: Copy>(
        all: &[T],
        code: impl Fn(T) -> i32,
        label: impl Fn(T) -> &'static str,
    ) -> Vec<(i32, &'static str)> {
        all.iter().map(|&v| (code(v), label(v))).collect()
    }
    vec![
        (
            Highway::COLUMN,
            table(Highway::ALL, |v| i32::from(v.code()), Highway::label),
        ),
        (
            SurfaceClass::COLUMN,
            table(SurfaceClass::ALL, |v| i32::from(v.code()), SurfaceClass::label),
        ),
        (
            Tracktype::COLUMN,
            table(Tracktype::ALL, |v| i32::from(v.code()), Tracktype::label),
        ),
        (
            Smoothness::COLUMN,
            table(Smoothness::ALL, |v| i32::from(v.code()), Smoothness::label),
        ),
        (
            BikeAccess::COLUMN,
            table(BikeAccess::ALL, |v| i32::from(v.code()), BikeAccess::label),
        ),
        (
            MotorAccess::COLUMN,
            table(MotorAccess::ALL, |v| i32::from(v.code()), MotorAccess::label),
        ),
        (
            CyclewayKind::COLUMN,
            table(CyclewayKind::ALL, |v| i32::from(v.code()), CyclewayKind::label),
        ),
        (
            RouteLevel::COLUMN,
            table(RouteLevel::ALL, |v| i32::from(v.code()), RouteLevel::label),
        ),
        (
            Oneway::COLUMN,
            table(Oneway::ALL, |v| i32::from(v.code()), Oneway::label),
        ),
        (
            TrailVisibility::COLUMN,
            table(
                TrailVisibility::ALL,
                |v| i32::from(v.code()),
                TrailVisibility::label,
            ),
        ),
        (
            MtbScale::COLUMN,
            table(MtbScale::ALL, |v| i32::from(v.code()), MtbScale::label),
        ),
        (
            SacScale::COLUMN,
            table(SacScale::ALL, |v| i32::from(v.code()), SacScale::label),
        ),
    ]
}

/// The enum columns of `edges.parquet` the graph does not carry (checked for nothing).
pub const UNUSED_ENUM_COLUMNS: &[&str] = &["maxspeed_src", "segregated", "lit"];

/// Every attribute of an edge the engine keeps, in physical units, as decoded from the graph
/// (so quantised: see [`Packed`]). Per-direction values are along (`fwd`) and against (`bwd`) the
/// geometry; the graph accessors take an arc and pick the right one.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct EdgeAttrs {
    /// Metres (0.1 m steps).
    pub length_m: f32,
    pub highway: Highway,
    pub surface: SurfaceClass,
    pub tracktype: Tracktype,
    pub smoothness: Smoothness,
    pub oneway: Oneway,
    pub trail_visibility: TrailVisibility,
    /// `informal=yes` (a desire path).
    pub informal: bool,
    pub bike_access: BikeAccess,
    pub motor_access: MotorAccess,
    /// Member of a `route=mtb` relation.
    pub mtb_route: bool,
    pub cycleway: CyclewayKind,
    pub route_level: RouteLevel,
    pub bridge: bool,
    pub tunnel: bool,
    /// km/h in 5 km/h steps (saturates at 155); `None` unknown.
    pub maxspeed_kmh: Option<u8>,
    /// 1..=7 (7 means 7 or more); `None` unknown.
    pub lanes: Option<u8>,
    pub mtb_scale: MtbScale,
    pub sac_scale: SacScale,
    /// Barriers on the edge's nodes (saturates at 3).
    pub barriers: u8,
    /// Shares of the length, 0..=1 in fifteenths.
    pub forest: f32,
    pub forest_edge: f32,
    pub water: f32,
    pub builtup: f32,
    pub road_near: f32,
    /// Metres in 0.5 m steps (saturates at 7.5); `None` unknown.
    pub width_m: Option<f32>,
    /// Metres (0.1 m steps).
    pub ascent_fwd_m: f32,
    pub ascent_bwd_m: f32,
    /// Steepest 50 m in whole percent.
    pub max_grade_fwd_pct: f32,
    pub max_grade_bwd_pct: f32,
}

/// The packed, quantised form of [`EdgeAttrs`]: one value per graph column (bit layouts in
/// `docs/graph-format.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Packed {
    pub length_dm: u16,
    pub highway: u8,
    pub surf: u8,
    pub smooth: u8,
    pub access: u8,
    pub road: u8,
    pub speed: u8,
    pub diff: u8,
    pub ctx: u16,
    pub ctx2: u8,
    pub ascent_fwd_dm: u16,
    pub ascent_bwd_dm: u16,
    pub grade_fwd: u8,
    pub grade_bwd: u8,
}

/// Bit layouts of the packed bytes.
pub mod bits {
    pub const ONEWAY_ALONG: u8 = 1 << 6;
    pub const ONEWAY_AGAINST: u8 = 2 << 6;
    pub const ONEWAY_MASK: u8 = 3 << 6;
}

/// Longest edge the format holds (u16 decimetres).
pub const MAX_LENGTH_M: f32 = 6553.5;

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "values are clamped to the target range before the cast"
)]
fn q(v: f32, scale: f32, max: f32) -> u32 {
    if v.is_nan() {
        0
    } else {
        (v * scale).round().clamp(0.0, max) as u32
    }
}

/// A share 0..=1 as fifteenths (0..=15).
fn share(v: f32) -> u16 {
    #[allow(clippy::cast_possible_truncation, reason = "q clamps to 15")]
    let s = q(v, 15.0, 15.0) as u16;
    s
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "every field is clamped to its bit width"
)]
impl EdgeAttrs {
    /// Quantises into the packed columns. Out-of-range values saturate.
    #[must_use]
    pub fn pack(&self) -> Packed {
        let b = |v: bool| u8::from(v);
        let oneway = match self.oneway {
            Oneway::Both => 0,
            Oneway::Along => bits::ONEWAY_ALONG,
            Oneway::Against => bits::ONEWAY_AGAINST,
        };
        let speed = self
            .maxspeed_kmh
            .map_or(0, |v| q(f32::from(v), 0.2, 31.0).max(1) as u8);
        let lanes = self.lanes.map_or(0, |v| v.clamp(1, 7));
        let width = self.width_m.map_or(0, |w| q(w, 2.0, 15.0).max(1) as u8);
        Packed {
            length_dm: q(self.length_m, 10.0, 65535.0).max(1) as u16,
            highway: self.highway.code(),
            surf: self.surface.code() | (self.tracktype.code() << 3) | oneway,
            smooth: self.smoothness.code() | (self.trail_visibility.code() << 4) | (b(self.informal) << 7),
            access: self.bike_access.code() | (self.motor_access.code() << 4) | (b(self.mtb_route) << 7),
            road: self.cycleway.code()
                | (self.route_level.code() << 3)
                | (b(self.bridge) << 6)
                | (b(self.tunnel) << 7),
            speed: speed | (lanes << 5),
            diff: self.mtb_scale.code() | (self.sac_scale.code() << 3) | (self.barriers.min(3) << 6),
            ctx: share(self.forest)
                | (share(self.forest_edge) << 4)
                | (share(self.water) << 8)
                | (share(self.builtup) << 12),
            ctx2: share(self.road_near) as u8 | (width << 4),
            ascent_fwd_dm: q(self.ascent_fwd_m, 10.0, 65535.0) as u16,
            ascent_bwd_dm: q(self.ascent_bwd_m, 10.0, 65535.0) as u16,
            grade_fwd: q(self.max_grade_fwd_pct, 1.0, 255.0) as u8,
            grade_bwd: q(self.max_grade_bwd_pct, 1.0, 255.0) as u8,
        }
    }
}

impl Packed {
    /// Decodes the packed columns (unknown codes become the enum's code-0 value).
    #[must_use]
    pub fn unpack(&self) -> EdgeAttrs {
        let s = |v: u16| f32::from(v & 15) / 15.0;
        let speed = self.speed & 31;
        let lanes = self.speed >> 5;
        let width = self.ctx2 >> 4;
        EdgeAttrs {
            length_m: f32::from(self.length_dm) * 0.1,
            highway: Highway::from_code(self.highway).unwrap_or_default(),
            surface: SurfaceClass::from_code(self.surf & 7).unwrap_or_default(),
            tracktype: Tracktype::from_code((self.surf >> 3) & 7).unwrap_or_default(),
            smoothness: Smoothness::from_code(self.smooth & 15).unwrap_or_default(),
            oneway: oneway_of(self.surf),
            trail_visibility: TrailVisibility::from_code((self.smooth >> 4) & 7).unwrap_or_default(),
            informal: self.smooth >> 7 != 0,
            bike_access: BikeAccess::from_code(self.access & 15).unwrap_or_default(),
            motor_access: MotorAccess::from_code((self.access >> 4) & 7).unwrap_or_default(),
            mtb_route: self.access >> 7 != 0,
            cycleway: CyclewayKind::from_code(self.road & 7).unwrap_or_default(),
            route_level: RouteLevel::from_code((self.road >> 3) & 7).unwrap_or_default(),
            bridge: (self.road >> 6) & 1 != 0,
            tunnel: self.road >> 7 != 0,
            maxspeed_kmh: (speed != 0).then_some(speed * 5),
            lanes: (lanes != 0).then_some(lanes),
            mtb_scale: MtbScale::from_code(self.diff & 7).unwrap_or_default(),
            sac_scale: SacScale::from_code((self.diff >> 3) & 7).unwrap_or_default(),
            barriers: self.diff >> 6,
            forest: s(self.ctx),
            forest_edge: s(self.ctx >> 4),
            water: s(self.ctx >> 8),
            builtup: s(self.ctx >> 12),
            road_near: s(u16::from(self.ctx2)),
            width_m: (width != 0).then_some(f32::from(width) * 0.5),
            ascent_fwd_m: f32::from(self.ascent_fwd_dm) * 0.1,
            ascent_bwd_m: f32::from(self.ascent_bwd_dm) * 0.1,
            max_grade_fwd_pct: f32::from(self.grade_fwd),
            max_grade_bwd_pct: f32::from(self.grade_bwd),
        }
    }
}

/// The one-way value of a packed `surf` byte.
#[inline]
#[must_use]
pub fn oneway_of(surf: u8) -> Oneway {
    match surf & bits::ONEWAY_MASK {
        bits::ONEWAY_ALONG => Oneway::Along,
        bits::ONEWAY_AGAINST => Oneway::Against,
        _ => Oneway::Both,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `### Enum codes` list of `docs/edges-parquet.md` (generated from the pipeline's schema and
    /// checked there): every column the engine knows must match it code by code, label by label.
    #[test]
    fn enums_match_the_pipeline_schema() {
        let doc = include_str!("../../../docs/edges-parquet.md");
        let section = doc.split("### Enum codes").nth(1).expect("enum section");
        let mut documented = std::collections::BTreeMap::new();
        for line in section.lines().filter_map(|l| l.strip_prefix("- `")) {
            let (column, rest) = line.split_once("`: ").expect("column");
            let codes: Vec<(i32, String)> = rest
                .split(", ")
                .map(|item| {
                    let (code, label) = item.split_once(' ').expect("code label");
                    (code.parse().expect("code"), label.to_owned())
                })
                .collect();
            documented.insert(column.to_owned(), codes);
        }
        for (column, table) in code_tables() {
            let want = documented
                .remove(column)
                .unwrap_or_else(|| panic!("{column} not documented"));
            let got: Vec<(i32, String)> = table.into_iter().map(|(c, l)| (c, l.to_owned())).collect();
            assert_eq!(got, want, "{column}");
        }
        for column in UNUSED_ENUM_COLUMNS {
            documented.remove(*column);
        }
        assert!(
            documented.is_empty(),
            "enum columns the engine ignores: {documented:?}"
        );
    }

    #[test]
    fn packing_roundtrips_within_the_quantisation() {
        let a = EdgeAttrs {
            length_m: 123.4,
            highway: Highway::Track,
            surface: SurfaceClass::Gravel,
            tracktype: Tracktype::Grade3,
            smoothness: Smoothness::Impassable,
            oneway: Oneway::Against,
            trail_visibility: TrailVisibility::No,
            informal: true,
            bike_access: BikeAccess::No,
            motor_access: MotorAccess::Yes,
            mtb_route: true,
            cycleway: CyclewayKind::BicycleRoad,
            route_level: RouteLevel::Icn,
            bridge: true,
            tunnel: true,
            maxspeed_kmh: Some(50),
            lanes: Some(2),
            mtb_scale: MtbScale::S6,
            sac_scale: SacScale::DifficultAlpineHiking,
            barriers: 2,
            forest: 1.0,
            forest_edge: 0.2,
            water: 0.0,
            builtup: 0.6,
            road_near: 1.0,
            width_m: Some(2.5),
            ascent_fwd_m: 12.3,
            ascent_bwd_m: 0.4,
            max_grade_fwd_pct: 12.0,
            max_grade_bwd_pct: 3.0,
        };
        let b = a.pack().unpack();
        assert!((b.forest_edge - 0.2).abs() <= 1.0 / 30.0 + 1e-6);
        assert!((b.length_m - a.length_m).abs() < 0.051);
        assert!((b.ascent_fwd_m - a.ascent_fwd_m).abs() < 0.051);
        let fix = |mut x: EdgeAttrs| {
            x.forest_edge = 0.0;
            x.length_m = 0.0;
            x.ascent_fwd_m = 0.0;
            x.ascent_bwd_m = 0.0;
            x
        };
        assert_eq!(fix(b), fix(a));
    }

    #[test]
    fn packing_saturates_and_keeps_unknowns() {
        let a = EdgeAttrs {
            length_m: 9000.0,
            maxspeed_kmh: Some(250),
            lanes: Some(12),
            barriers: 9,
            width_m: Some(30.0),
            forest: 1.7,
            max_grade_fwd_pct: f32::NAN,
            ..EdgeAttrs::default()
        };
        let b = a.pack().unpack();
        assert!((b.length_m - MAX_LENGTH_M).abs() < 1e-3);
        assert_eq!(b.maxspeed_kmh, Some(155));
        assert_eq!(b.lanes, Some(7));
        assert_eq!(b.barriers, 3);
        assert_eq!(b.width_m, Some(7.5));
        assert!((b.forest - 1.0).abs() < 1e-6);
        assert!(b.max_grade_fwd_pct.abs() < 1e-6);
        let unknown = EdgeAttrs::default().pack().unpack();
        assert_eq!(unknown.maxspeed_kmh, None);
        assert_eq!(unknown.lanes, None);
        assert_eq!(unknown.width_m, None);
        // tiny but known values stay known
        let small = EdgeAttrs {
            maxspeed_kmh: Some(2),
            width_m: Some(0.1),
            ..EdgeAttrs::default()
        }
        .pack()
        .unpack();
        assert_eq!(small.maxspeed_kmh, Some(5));
        assert_eq!(small.width_m, Some(0.5));
    }

    #[test]
    fn oneway_allows() {
        assert!(Oneway::Both.allows(false) && Oneway::Both.allows(true));
        assert!(Oneway::Along.allows(false) && !Oneway::Along.allows(true));
        assert!(!Oneway::Against.allows(false) && Oneway::Against.allows(true));
        for &o in Oneway::ALL {
            assert_eq!(Oneway::from_code(o.code()), Some(o));
        }
        assert_eq!(Highway::from_code(22), None);
        assert_eq!(Highway::from_code(14), Some(Highway::Track));
    }
}
