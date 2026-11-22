//! The routing profile: what the rider wants, as data. Soft preferences are signed weights keyed by
//! the catalogue's preference ids ([`PrefId`]), hard limits are switches or numbers keyed by
//! [`LimitId`], and the factor clamp ([`Bounds`]) keeps every profile routable and the A* bound
//! valid. The meaning of every id is in [`crate::catalogue`]; how a profile becomes a cost is
//! [`crate::cost`]. Semantics for the UI: `docs/profile.md`.
//!
//! The structured parts ([`Boards`], [`Hills`], `detours`; #66, a prototype behind a switch) are
//! optional: a profile with any of them uses the structured model ([`crate::structured`]), one
//! without routes exactly as before.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

#[cfg(feature = "schema")]
use ts_rs::TS;

/// Declares a catalogue id enum: `snake_case` ids on the wire, `ALL` in catalogue order.
macro_rules! id_enum {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident = $id:literal,)+ }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
        pub enum $name {
            $($(#[$vmeta])* #[serde(rename = $id)] $variant,)+
        }

        impl $name {
            /// Every id, in catalogue order.
            pub const ALL: &'static [$name] = &[$($name::$variant,)+];

            /// The id on the wire.
            #[must_use]
            pub fn id(self) -> &'static str {
                match self {
                    $(Self::$variant => $id,)+
                }
            }

            /// The value of a wire id.
            #[must_use]
            pub fn from_id(id: &str) -> Option<Self> {
                match id {
                    $($id => Some(Self::$variant),)+
                    _ => None,
                }
            }

            /// Dense index (catalogue order), for per-id arrays.
            #[must_use]
            pub fn index(self) -> usize {
                self as usize
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.id())
            }
        }
    };
}

id_enum! {
    /// A soft preference of the catalogue (`catalogue().preferences`).
    PrefId {
        Unpaved = "unpaved",
        PavedSmooth = "paved_smooth",
        PavedRough = "paved_rough",
        FineGravel = "fine_gravel",
        SoftGround = "soft_ground",
        UnknownSurface = "unknown_surface",
        Tracktype = "tracktype",
        Smoothness = "smoothness",
        Track = "track",
        Path = "path",
        CyclewaySep = "cycleway_sep",
        CyclewayRoad = "cycleway_road",
        Residential = "residential",
        Service = "service",
        Minor = "minor",
        Main = "main",
        Quiet = "quiet",
        Speed = "speed",
        Lanes = "lanes",
        NearRoad = "near_road",
        Forest = "forest",
        ForestEdge = "forest_edge",
        Water = "water",
        Open = "open",
        Built = "built",
        Climb = "climb",
        Steep = "steep",
        RampsOver6 = "ramps_over_6",
        RampsOver8 = "ramps_over_8",
        RampsOver10 = "ramps_over_10",
        RampsOver12 = "ramps_over_12",
        RampsOver15 = "ramps_over_15",
        BikeRoutes = "bike_routes",
        MtbRoutes = "mtb_routes",
        Access = "access",
        Sketchy = "sketchy",
        Mtb = "mtb",
        Visibility = "visibility",
        Novel = "novel",
        Stale = "stale",
        Familiar = "familiar",
    }
}

id_enum! {
    /// A hard limit of the catalogue (`catalogue().limits`).
    LimitId {
        NoMainRoads = "no_main_roads",
        PavedOnly = "paved_only",
        NoUnknownSurface = "no_unknown_surface",
        MaxGrade = "max_grade",
        MaxMtbScale = "max_mtb_scale",
        NoStairs = "no_stairs",
        LegalOnly = "legal_only",
        NoFerries = "no_ferries",
    }
}

id_enum! {
    /// A tier of a board: how much the rider likes the ways of a row, best first in [`Tier::BEST_FIRST`].
    Tier {
        Avoid = "avoid",
        Dislike = "dislike",
        Fine = "fine",
        Like = "like",
        Love = "love",
    }
}

impl Tier {
    /// Love first, avoid last (the order of a board on screen).
    pub const BEST_FIRST: [Tier; 5] = [Tier::Love, Tier::Like, Tier::Fine, Tier::Dislike, Tier::Avoid];

    /// The factor of a metre in this tier, relative to `love`; `None` for `avoid` (closed: a limit).
    #[must_use]
    pub fn factor(self) -> Option<f32> {
        match self {
            Tier::Love => Some(1.0),
            Tier::Like => Some(1.15),
            Tier::Fine => Some(TIER_FINE),
            Tier::Dislike => Some(2.0),
            Tier::Avoid => None,
        }
    }
}

/// The factor of `fine`: the neutral tier (what a way counts with no opinion), the gate's 1.
pub const TIER_FINE: f32 = 1.35;

id_enum! {
    /// A board of the structured model.
    BoardId {
        Surface = "surface",
        Way = "way",
    }
}

id_enum! {
    /// A row of a board: every way is in exactly one row of each board ([`BoardRow::board`]).
    BoardRow {
        Paved = "paved",
        RoughPaved = "rough_paved",
        Compacted = "compacted",
        Gravel = "gravel",
        Soft = "soft",
        Unknown = "unknown",
        Main = "main",
        CountryRoad = "country_road",
        Residential = "residential",
        Service = "service",
        Track = "track",
        Path = "path",
        CyclePath = "cycle_path",
        CyclePathRoadside = "cycle_path_roadside",
    }
}

impl BoardRow {
    pub const SURFACE: [BoardRow; 6] = [
        BoardRow::Paved,
        BoardRow::RoughPaved,
        BoardRow::Compacted,
        BoardRow::Gravel,
        BoardRow::Soft,
        BoardRow::Unknown,
    ];
    pub const WAY: [BoardRow; 8] = [
        BoardRow::Main,
        BoardRow::CountryRoad,
        BoardRow::Residential,
        BoardRow::Service,
        BoardRow::Track,
        BoardRow::Path,
        BoardRow::CyclePath,
        BoardRow::CyclePathRoadside,
    ];

    /// The board the row is on.
    #[must_use]
    pub fn board(self) -> BoardId {
        if self.index() < BoardRow::SURFACE.len() {
            BoardId::Surface
        } else {
            BoardId::Way
        }
    }
}

/// The surface board: a tier per surface class of the way (the tag, else a safe guess; weak
/// guesses and unusual surfaces are `unknown`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct SurfaceBoard {
    pub paved: Tier,
    pub rough_paved: Tier,
    pub compacted: Tier,
    pub gravel: Tier,
    pub soft: Tier,
    pub unknown: Tier,
}

/// The way board: a tier per kind of way (the route's way types; steps count as paths).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct WayBoard {
    pub main: Tier,
    pub country_road: Tier,
    pub residential: Tier,
    pub service: Tier,
    pub track: Tier,
    pub path: Tier,
    pub cycle_path: Tier,
    pub cycle_path_roadside: Tier,
}

/// The tier boards (structured model): each board present replaces its slider preferences.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct Boards {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<SurfaceBoard>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub way: Option<WayBoard>,
}

impl Boards {
    /// The tier of a row, `None` when its board is absent.
    #[must_use]
    pub fn tier(&self, row: BoardRow) -> Option<Tier> {
        use BoardRow as R;
        if row.board() == BoardId::Surface {
            let s = self.surface.as_ref()?;
            Some(match row {
                R::Paved => s.paved,
                R::RoughPaved => s.rough_paved,
                R::Compacted => s.compacted,
                R::Gravel => s.gravel,
                R::Soft => s.soft,
                _ => s.unknown,
            })
        } else {
            let w = self.way.as_ref()?;
            Some(match row {
                R::Main => w.main,
                R::CountryRoad => w.country_road,
                R::Residential => w.residential,
                R::Service => w.service,
                R::Track => w.track,
                R::Path => w.path,
                R::CyclePath => w.cycle_path,
                _ => w.cycle_path_roadside,
            })
        }
    }

    /// Sets the tier of a row (creating its board, every other row `fine`).
    pub fn set(&mut self, row: BoardRow, t: Tier) {
        use BoardRow as R;
        if row.board() == BoardId::Surface {
            let s = self.surface.get_or_insert(SurfaceBoard {
                paved: Tier::Fine,
                rough_paved: Tier::Fine,
                compacted: Tier::Fine,
                gravel: Tier::Fine,
                soft: Tier::Fine,
                unknown: Tier::Fine,
            });
            *match row {
                R::Paved => &mut s.paved,
                R::RoughPaved => &mut s.rough_paved,
                R::Compacted => &mut s.compacted,
                R::Gravel => &mut s.gravel,
                R::Soft => &mut s.soft,
                _ => &mut s.unknown,
            } = t;
        } else {
            let w = self.way.get_or_insert(WayBoard {
                main: Tier::Fine,
                country_road: Tier::Fine,
                residential: Tier::Fine,
                service: Tier::Fine,
                track: Tier::Fine,
                path: Tier::Fine,
                cycle_path: Tier::Fine,
                cycle_path_roadside: Tier::Fine,
            });
            *match row {
                R::Main => &mut w.main,
                R::CountryRoad => &mut w.country_road,
                R::Residential => &mut w.residential,
                R::Service => &mut w.service,
                R::Track => &mut w.track,
                R::Path => &mut w.path,
                R::CyclePath => &mut w.cycle_path,
                _ => &mut w.cycle_path_roadside,
            } = t;
        }
    }

    /// The rows of the boards present, board order.
    #[must_use]
    pub fn rows(&self) -> Vec<BoardRow> {
        let mut out = Vec::new();
        if self.surface.is_some() {
            out.extend(BoardRow::SURFACE);
        }
        if self.way.is_some() {
            out.extend(BoardRow::WAY);
        }
        out
    }
}

/// The hills curve's climbing handles: the cost of a metre at that grade (percent, uphill) relative
/// to a flat metre (0 % is pinned at 1). Below 1 seeks climbs (counts through the gate).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct UpHandles {
    #[serde(rename = "3")]
    pub at3: f32,
    #[serde(rename = "6")]
    pub at6: f32,
    #[serde(rename = "10")]
    pub at10: f32,
    #[serde(rename = "15")]
    pub at15: f32,
}

/// The hills curve's descending handles (percent downhill), 1 or more.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct DownHandles {
    #[serde(rename = "8")]
    pub at8: f32,
    #[serde(rename = "15")]
    pub at15: f32,
}

/// The hills curve (structured model): what a metre costs against its grade, an additive term in
/// metres (`length × (curve − 1)`). Replaces `climb`, `steep` and `ramps_over_*`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct Hills {
    pub up: UpHandles,
    /// Absent: a descent counts like a climb of half its grade (at least 1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub down: Option<DownHandles>,
    /// On loose ground (gravel, soft, unusual surfaces) grades count this many percent steeper,
    /// 0..=50 (default 0).
    #[serde(default)]
    pub loose_pct: f32,
}

impl Hills {
    pub const UP_GRADES: [f32; 4] = [3.0, 6.0, 10.0, 15.0];
    pub const DOWN_GRADES: [f32; 2] = [8.0, 15.0];
    pub const UP_RANGE: (f32, f32) = (0.5, 10.0);
    pub const DOWN_RANGE: (f32, f32) = (1.0, 10.0);
    pub const LOOSE_RANGE: (f32, f32) = (0.0, 50.0);

    /// The climbing handles in grade order.
    #[must_use]
    pub fn up_values(&self) -> [f32; 4] {
        [self.up.at3, self.up.at6, self.up.at10, self.up.at15]
    }

    /// The flat curve (every handle 1): no cost for hills.
    #[must_use]
    pub fn flat() -> Hills {
        Hills {
            up: UpHandles {
                at3: 1.0,
                at6: 1.0,
                at10: 1.0,
                at15: 1.0,
            },
            down: None,
            loose_pct: 0.0,
        }
    }
}

/// The range of `detours` (structured model), and its default.
pub const DETOURS_RANGE: (f32, f32) = (0.5, 2.0);
pub const DETOURS_DEFAULT: f32 = 1.0;

/// The slider preferences a board replaces (rejected in a profile that has the board).
#[must_use]
pub fn replaced_by_board(b: BoardId) -> &'static [PrefId] {
    match b {
        BoardId::Surface => &[
            PrefId::Unpaved,
            PrefId::PavedSmooth,
            PrefId::PavedRough,
            PrefId::FineGravel,
            PrefId::SoftGround,
            PrefId::UnknownSurface,
        ],
        BoardId::Way => &[
            PrefId::Track,
            PrefId::Path,
            PrefId::CyclewaySep,
            PrefId::CyclewayRoad,
            PrefId::Residential,
            PrefId::Service,
            PrefId::Minor,
            PrefId::Main,
        ],
    }
}

/// The limits a board replaces (its `avoid` tier).
#[must_use]
pub fn limits_replaced_by_board(b: BoardId) -> &'static [LimitId] {
    match b {
        BoardId::Surface => &[LimitId::PavedOnly, LimitId::NoUnknownSurface],
        BoardId::Way => &[LimitId::NoMainRoads],
    }
}

/// The slider preferences the hills curve replaces.
pub const REPLACED_BY_HILLS: &[PrefId] = &[
    PrefId::Climb,
    PrefId::Steep,
    PrefId::RampsOver6,
    PrefId::RampsOver8,
    PrefId::RampsOver10,
    PrefId::RampsOver12,
    PrefId::RampsOver15,
];

/// Number of preferences (per-preference arrays).
pub const PREF_COUNT: usize = PrefId::ALL.len();

/// A soft preference's strength: −100 (avoid) … 0 (neutral) … +100 (seek).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize)]
#[serde(try_from = "i64", into = "i64")]
#[cfg_attr(feature = "schema", derive(TS), ts(type = "number"))]
pub struct Weight(i8);

impl Weight {
    pub const MIN: i8 = -100;
    pub const MAX: i8 = 100;

    /// A weight, `None` outside −100..=100.
    #[must_use]
    pub fn new(v: i64) -> Option<Weight> {
        i8::try_from(v)
            .ok()
            .filter(|w| (Self::MIN..=Self::MAX).contains(w))
            .map(Weight)
    }

    #[must_use]
    pub fn get(self) -> i8 {
        self.0
    }

    /// As a fraction, −1..=1.
    #[must_use]
    pub fn unit(self) -> f32 {
        f32::from(self.0) / 100.0
    }
}

impl TryFrom<i64> for Weight {
    type Error = String;
    fn try_from(v: i64) -> Result<Weight, String> {
        Weight::new(v).ok_or_else(|| format!("weight {v} is outside -100..100"))
    }
}

impl From<Weight> for i64 {
    fn from(w: Weight) -> i64 {
        i64::from(w.0)
    }
}

#[cfg(feature = "schema")]
impl schemars::JsonSchema for Weight {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Weight".into()
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "description": "A soft preference's strength: -100 avoid, 0 neutral, +100 seek.",
            "type": "integer",
            "minimum": -100,
            "maximum": 100,
        })
    }
}

/// A limit's setting: a switch (`true` on, `false` off, as if absent), or a number for limits that
/// take one (`true` there means the catalogue's default number).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub enum LimitValue {
    Flag(bool),
    Number(f64),
}

/// The clamp of the factor product (`docs/profile.md`): every arc costs between `min_factor` and
/// `max_factor` times its length (plus additive terms). `min_factor` is the A* bound.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct Bounds {
    /// 0.3..=1.0, default 0.5. Lower lets bonuses stack further (and searches slow down a little).
    pub min_factor: f32,
    /// 2..=100, default 20. The most an allowed way can cost per metre.
    pub max_factor: f32,
}

impl Bounds {
    pub const MIN_FACTOR_RANGE: (f32, f32) = (0.3, 1.0);
    pub const MAX_FACTOR_RANGE: (f32, f32) = (2.0, 100.0);
}

impl Default for Bounds {
    fn default() -> Bounds {
        Bounds {
            min_factor: 0.5,
            max_factor: 20.0,
        }
    }
}

/// A routing profile.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct Profile {
    /// Display name (presets have one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The preset this profile was made from (the UI's diff against it; routing ignores it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// Soft preferences. An absent id has no opinion (factor 1); an explicit 0 is the same for
    /// routing, but stays on screen.
    #[serde(default)]
    pub weights: BTreeMap<PrefId, Weight>,
    /// Hard limits.
    #[serde(default)]
    pub limits: BTreeMap<LimitId, LimitValue>,
    /// The factor clamp; defaults apply when absent. In the structured model only `max_factor`
    /// counts (`min_factor` must stay at its default: `detours` takes its place).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds>,
    /// What a right-angle turn at a junction costs, metres-equivalent (0..=500; absent:
    /// [`TURN_M`]; 0: turns are free). Straight on costs nothing, a U-turn twice this; leaving the
    /// through road at least half of it (`docs/routing.md#turns`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_m: Option<f32>,
    /// Structured model: the tier boards.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boards: Option<Boards>,
    /// Structured model: the hills curve.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hills: Option<Hills>,
    /// Structured model: the spread of the relative factors, an exponent 0.5..=2 (default 1; more
    /// is "Detours: more", a loved way is worth a longer ride).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detours: Option<f32>,
}

/// The default of [`Profile::turn_m`].
pub const TURN_M: f32 = 20.0;

/// The range of [`Profile::turn_m`].
pub const TURN_M_RANGE: (f32, f32) = (0.0, 500.0);

/// Why a profile is not valid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileError(pub String);

impl fmt::Display for ProfileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ProfileError {}

impl Profile {
    /// Parses a profile from JSON and validates it.
    pub fn from_json(json: &str) -> Result<Profile, ProfileError> {
        let p: Profile = serde_json::from_str(json).map_err(|e| ProfileError(format!("profile: {e}")))?;
        p.validate()?;
        Ok(p)
    }

    /// The weight of a preference, `None` without an opinion.
    #[must_use]
    pub fn weight(&self, id: PrefId) -> Option<i8> {
        self.weights.get(&id).map(|w| w.get())
    }

    /// Sets (or with `None` removes) a weight; panics outside −100..=100.
    pub fn set_weight(&mut self, id: PrefId, w: Option<i8>) {
        match w {
            Some(w) => {
                self.weights
                    .insert(id, Weight::new(i64::from(w)).expect("weight in -100..100"));
            }
            None => {
                self.weights.remove(&id);
            }
        }
    }

    #[must_use]
    pub fn bounds(&self) -> Bounds {
        self.bounds.unwrap_or_default()
    }

    /// The cost of a right-angle turn in force ([`TURN_M`] when absent).
    #[must_use]
    pub fn turn_m(&self) -> f32 {
        self.turn_m.unwrap_or(TURN_M)
    }

    /// Whether the profile uses the structured model (it has `boards`, `hills` or `detours`).
    #[must_use]
    pub fn structured(&self) -> bool {
        self.boards.is_some() || self.hills.is_some() || self.detours.is_some()
    }

    /// The spread exponent of the structured model.
    #[must_use]
    pub fn detours(&self) -> f32 {
        self.detours.unwrap_or(DETOURS_DEFAULT)
    }

    /// The effective setting of a limit: `None` off, `Some(None)` on (a switch), `Some(Some(n))` on
    /// with its number (the default if given as `true`).
    #[must_use]
    pub fn limit(&self, id: LimitId) -> Option<Option<f64>> {
        let def = crate::catalogue::limit_meta(id);
        match self.limits.get(&id)? {
            LimitValue::Flag(false) => None,
            LimitValue::Flag(true) => Some(def.number.map(|n| n.default)),
            LimitValue::Number(n) => Some(Some(*n)),
        }
    }

    /// Checks the limits' values and the bounds (the weights are checked when parsed).
    pub fn validate(&self) -> Result<(), ProfileError> {
        for (&id, v) in &self.limits {
            let meta = crate::catalogue::limit_meta(id);
            match (v, meta.number) {
                (LimitValue::Number(_), None) => {
                    return Err(ProfileError(format!(
                        "limit `{id}` is a switch: give true or false, not a number"
                    )));
                }
                (LimitValue::Number(n), Some(range)) if !(range.min..=range.max).contains(n) => {
                    return Err(ProfileError(format!(
                        "limit `{id}`: {n} is outside {}..{}",
                        range.min, range.max
                    )));
                }
                _ => {}
            }
        }
        let b = self.bounds();
        let (lo, hi) = Bounds::MIN_FACTOR_RANGE;
        if !(lo..=hi).contains(&b.min_factor) {
            return Err(ProfileError(format!(
                "bounds.min_factor {} is outside {lo}..{hi}",
                b.min_factor
            )));
        }
        let (lo, hi) = Bounds::MAX_FACTOR_RANGE;
        if !(lo..=hi).contains(&b.max_factor) {
            return Err(ProfileError(format!(
                "bounds.max_factor {} is outside {lo}..{hi}",
                b.max_factor
            )));
        }
        let (lo, hi) = TURN_M_RANGE;
        let t = self.turn_m();
        if !(lo..=hi).contains(&t) {
            return Err(ProfileError(format!("turn_m {t} is outside {lo}..{hi}")));
        }
        if self.structured() {
            self.validate_structured()?;
        }
        Ok(())
    }

    /// The structured parts: ranges, and no slider or limit a board or the curve replaces.
    fn validate_structured(&self) -> Result<(), ProfileError> {
        let range = |what: &str, v: f32, (lo, hi): (f32, f32)| {
            if (lo..=hi).contains(&v) {
                Ok(())
            } else {
                Err(ProfileError(format!("{what} {v} is outside {lo}..{hi}")))
            }
        };
        if (self.bounds().min_factor - Bounds::default().min_factor).abs() > 1e-6 {
            return Err(ProfileError(
                "bounds.min_factor has no meaning in the structured model (there is no floor): set `detours`"
                    .into(),
            ));
        }
        range("detours", self.detours(), DETOURS_RANGE)?;
        let boards = self.boards.unwrap_or_default();
        for (board, present) in [
            (BoardId::Surface, boards.surface.is_some()),
            (BoardId::Way, boards.way.is_some()),
        ] {
            if !present {
                continue;
            }
            if let Some(id) = replaced_by_board(board)
                .iter()
                .find(|id| self.weights.contains_key(id))
            {
                return Err(ProfileError(format!(
                    "preference `{id}` is the {board} board's job: rank its rows on `boards.{board}` instead"
                )));
            }
            if let Some(id) = limits_replaced_by_board(board)
                .iter()
                .find(|&&id| self.limit(id).is_some())
            {
                return Err(ProfileError(format!(
                    "limit `{id}` is the {board} board's job: put the rows it closes on `avoid`"
                )));
            }
        }
        if let Some(h) = &self.hills {
            if let Some(id) = REPLACED_BY_HILLS.iter().find(|id| self.weights.contains_key(id)) {
                return Err(ProfileError(format!(
                    "preference `{id}` is the hills curve's job: set its handles instead"
                )));
            }
            for (g, v) in Hills::UP_GRADES.iter().zip(h.up_values()) {
                range(&format!("hills.up.{g}"), v, Hills::UP_RANGE)?;
            }
            if let Some(d) = &h.down {
                for (g, v) in Hills::DOWN_GRADES.iter().zip([d.at8, d.at15]) {
                    range(&format!("hills.down.{g}"), v, Hills::DOWN_RANGE)?;
                }
            }
            range("hills.loose_pct", h.loose_pct, Hills::LOOSE_RANGE)?;
        }
        Ok(())
    }

    /// What decides the compiled arc costs: the weights (0 dropped), the active limits and the
    /// bounds. Two profiles with the same key compile the same (the name and base do not matter,
    /// nor `turn_m`, which the search adds per turn).
    #[must_use]
    pub fn cost_key(&self) -> String {
        use std::fmt::Write;
        let mut s = String::new();
        for (id, w) in &self.weights {
            if w.get() != 0 {
                let _ = write!(s, "{id}={};", w.get());
            }
        }
        for &id in LimitId::ALL {
            if let Some(n) = self.limit(id) {
                let _ = write!(s, "!{id}={n:?};");
            }
        }
        let b = self.bounds();
        let _ = write!(s, "[{},{}]", b.min_factor, b.max_factor);
        if self.structured() {
            let _ = write!(
                s,
                "|boards={};hills={};detours={}",
                serde_json::to_string(&self.boards).unwrap_or_default(),
                serde_json::to_string(&self.hills).unwrap_or_default(),
                self.detours()
            );
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_roundtrip() {
        for &p in PrefId::ALL {
            assert_eq!(PrefId::from_id(p.id()), Some(p));
            let json = serde_json::to_string(&p).unwrap();
            assert_eq!(json, format!("\"{}\"", p.id()));
            assert_eq!(PrefId::ALL[p.index()], p);
        }
        for &l in LimitId::ALL {
            assert_eq!(LimitId::from_id(l.id()), Some(l));
        }
    }

    #[test]
    fn parses_and_validates() {
        let p = Profile::from_json(
            r#"{"name":"x","weights":{"unpaved":70,"quiet":-100},"limits":{"max_grade":12,"no_stairs":true,"paved_only":false},"bounds":{"min_factor":0.4}}"#,
        )
        .unwrap();
        assert_eq!(p.weight(PrefId::Unpaved), Some(70));
        assert_eq!(p.weight(PrefId::Forest), None);
        assert_eq!(p.limit(LimitId::MaxGrade), Some(Some(12.0)));
        assert_eq!(p.limit(LimitId::NoStairs), Some(None));
        assert_eq!(p.limit(LimitId::PavedOnly), None);
        assert!((p.bounds().max_factor - 20.0).abs() < 1e-6);
        // `true` on a number limit means its default
        let q = Profile::from_json(r#"{"limits":{"max_grade":true}}"#).unwrap();
        assert_eq!(q.limit(LimitId::MaxGrade), Some(Some(12.0)));
    }

    #[test]
    fn rejects_bad_profiles() {
        for (json, want) in [
            (r#"{"weights":{"unpaved":101}}"#, "outside -100..100"),
            (r#"{"weights":{"gravelz":10}}"#, "unknown variant `gravelz`"),
            (r#"{"limits":{"no_stairs":3}}"#, "is a switch"),
            (r#"{"limits":{"max_grade":40}}"#, "outside"),
            (r#"{"bounds":{"min_factor":0.1}}"#, "min_factor"),
            (r#"{"bounds":{"max_factor":1.5}}"#, "max_factor"),
            (r#"{"weigths":{}}"#, "unknown field"),
            (r#"{"turn_m":-1}"#, "turn_m"),
            (r#"{"turn_m":501}"#, "turn_m"),
        ] {
            let e = Profile::from_json(json).unwrap_err();
            assert!(e.0.contains(want), "{json}: {e}");
        }
    }

    #[test]
    fn cost_key_ignores_names_and_zero_weights() {
        let mut a = Profile::default();
        a.set_weight(PrefId::Unpaved, Some(50));
        let mut b = a.clone();
        b.name = Some("other".into());
        b.set_weight(PrefId::Forest, Some(0));
        assert_eq!(a.cost_key(), b.cost_key());
        // the turn cost is the search's, not the compile's
        b.turn_m = Some(0.0);
        assert_eq!(a.cost_key(), b.cost_key());
        assert_eq!(b.turn_m(), 0.0);
        assert!((a.turn_m() - TURN_M).abs() < 1e-6);
        b.set_weight(PrefId::Forest, Some(1));
        assert_ne!(a.cost_key(), b.cost_key());
    }
}
