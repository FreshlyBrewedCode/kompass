//! A profile compiled into a cost per arc, for the whole graph, once per profile change.
//!
//! `cost(arc) = length × clamp(quality × gated bonus, min_factor, max_factor) + additive`
//!
//! - Every preference has a *membership* per arc in −1..=1 (how much the way is what the
//!   preference names; negative: its opposite), quantised to fifteenths like the graph's shares.
//!   With the weight `w` (−1..=1) the preference's factor is `exp(−ln(1 / max_bonus) · w·m)` when
//!   `w·m > 0` and `exp(ln(max_penalty) · |w·m|)` when `w·m < 0`, so +100 on a full match costs
//!   `max_bonus`, −100 costs `max_penalty`, and 0 or no match costs 1. Per profile each active
//!   preference becomes a 31-entry table, so the per-edge work is lookups and multiplications.
//! - *Quality* preferences (surface, way type, traffic, trail, access, ramps) multiply into
//!   `quality`. The *gated* ones (landscape, signed routes, seeking climbs, history) put their
//!   penalties into `quality` too, but their bonuses only count where the way is acceptable: in full
//!   while `quality ≤ GATE_OK`, fading out linearly to nothing at `GATE_BAD` (the vision's caveat:
//!   novelty and nice views are a bonus within acceptable quality, never a reason to ride
//!   something bad).
//! - Additive terms, all ≥ 0: avoiding climbs (metres of cost per metre of ascent beyond a
//!   deadband), barriers, steps, walking a `dismount` way, ferries.
//! - Limits (and `bicycle=no`, and one-way) make an arc infinite.
//!
//! The clamp keeps every allowed way between `min_factor` and `max_factor` per metre; the smallest
//! factor the compile actually produced (≥ `min_factor`) is the A* bound.

use std::collections::BTreeMap;

use crate::attrs::SurfaceClass;
use crate::catalogue::pref_meta;
use crate::graph::{EdgeColumns, EdgeId, Graph, arc_edge, arc_is_reverse};
use crate::personal::PersonalLayer;
use crate::profile::{LimitId, PrefId, Profile, ProfileError};

/// Below this quality factor the gated bonuses count in full.
pub const GATE_OK: f32 = 1.3;
/// From this quality factor on the gated bonuses no longer count.
pub const GATE_BAD: f32 = 2.2;
/// Additive cost of a barrier (gate, bollard, …), metres.
pub const BARRIER_M: f32 = 15.0;
/// Steps: extra metres per metre (carrying) and per flight.
pub const STEPS_PER_M: f32 = 5.0;
pub const STEPS_EACH_M: f32 = 20.0;
/// `bicycle=dismount`: extra metres per metre (walking).
pub const DISMOUNT_PER_M: f32 = 2.0;
/// A ferry: the wait, in metres.
pub const FERRY_M: f32 = 1000.0;
/// The climbing deadband, metres of ascent per metre ignored: in the open, and on top in forest
/// (the surface model's canopy noise; spike #3 measured ~3.5 vs ~13 m/km of spurious ascent).
pub const CLIMB_DEADBAND_OPEN: f32 = 0.004;
pub const CLIMB_DEADBAND_FOREST: f32 = 0.010;
/// Average grade (after the deadband) at which seeking climbs reaches its full bonus.
pub const CLIMB_FULL_GRADE: f32 = 0.05;

/// Membership levels: fifteenths, −15..=15.
const LEVELS: usize = 31;
type Table = [f32; LEVELS];

/// One edge, decoded from the packed columns.
#[derive(Debug, Clone, Copy)]
pub(crate) struct View {
    pub hw: u8,
    pub surf: u8,
    pub tt: u8,
    pub smooth: u8,
    pub vis: u8,
    pub informal: bool,
    pub bike: u8,
    pub motor: u8,
    pub mtb_route: bool,
    pub cyc: u8,
    pub route: u8,
    /// km/h, 0 unknown.
    pub kmh: u8,
    pub lanes: u8,
    pub mtb: u8,
    pub sac: u8,
    pub barriers: u8,
    /// Shares in fifteenths.
    pub forest: u8,
    pub forest_edge: u8,
    pub water: u8,
    pub built: u8,
    pub road_near: u8,
    pub length: f32,
}

/// How sure the effective surface is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Confidence {
    Tagged,
    /// Untagged but a safe guess (a street, a graded track).
    Strong,
    /// Untagged, a guess.
    Weak,
}

mod hw {
    pub const TRUNK: u8 = 1;
    pub const SECONDARY_LINK: u8 = 6;
    pub const TERTIARY: u8 = 7;
    pub const TERTIARY_LINK: u8 = 8;
    pub const UNCLASSIFIED: u8 = 9;
    pub const RESIDENTIAL: u8 = 10;
    pub const LIVING_STREET: u8 = 11;
    pub const SERVICE: u8 = 12;
    pub const ROAD: u8 = 13;
    pub const TRACK: u8 = 14;
    pub const PATH: u8 = 15;
    pub const CYCLEWAY: u8 = 16;
    pub const FOOTWAY: u8 = 17;
    pub const BRIDLEWAY: u8 = 18;
    pub const STEPS: u8 = 19;
    pub const PEDESTRIAN: u8 = 20;
    pub const FERRY: u8 = 21;
}

mod sc {
    pub const UNKNOWN: u8 = 0;
    pub const PAVED: u8 = 1;
    pub const ROUGH: u8 = 2;
    pub const COMPACTED: u8 = 3;
    pub const GRAVEL: u8 = 4;
    pub const SOFT: u8 = 5;
    pub const OTHER: u8 = 6;
}

mod ba {
    pub const DESTINATION: u8 = 4;
    pub const USE_SIDEPATH: u8 = 5;
    pub const DISMOUNT: u8 = 6;
    pub const FOOT_ONLY: u8 = 7;
    pub const AGRI: u8 = 8;
    pub const PRIVATE: u8 = 9;
    pub const NO: u8 = 10;
}

/// Half of fifteen: shares above it are "mostly".
const HALF: u8 = 7;

#[inline]
fn share(v: u8) -> f32 {
    f32::from(v) * (1.0 / 15.0)
}

/// −1..=1 → −15..=15.
#[inline]
#[allow(clippy::cast_possible_truncation, reason = "clamped to ±15")]
fn lv(x: f32) -> i8 {
    // rounding by truncating a positive value: no libm call on targets without SSE4.1
    (((x.clamp(-1.0, 1.0) * 15.0) + 15.5) as i32 - 15) as i8
}

impl View {
    #[inline]
    pub(crate) fn decode(c: &EdgeColumns, e: usize) -> View {
        let (surf, smooth, access, road, speed, diff, ctx, ctx2) = (
            c.surf[e],
            c.smooth[e],
            c.access[e],
            c.road[e],
            c.speed[e],
            c.diff[e],
            c.ctx[e],
            c.ctx2[e],
        );
        #[allow(clippy::cast_possible_truncation, reason = "4-bit nibbles")]
        let nib = |s: u32| ((ctx >> s) & 15) as u8;
        View {
            hw: c.highway[e],
            surf: surf & 7,
            tt: (surf >> 3) & 7,
            smooth: smooth & 15,
            vis: (smooth >> 4) & 7,
            informal: smooth >> 7 != 0,
            bike: access & 15,
            motor: (access >> 4) & 7,
            mtb_route: access >> 7 != 0,
            cyc: road & 7,
            route: (road >> 3) & 7,
            kmh: (speed & 31) * 5,
            lanes: speed >> 5,
            mtb: diff & 7,
            sac: (diff >> 3) & 7,
            barriers: diff >> 6,
            forest: nib(0),
            forest_edge: nib(4),
            water: nib(8),
            built: nib(12),
            road_near: ctx2 & 15,
            length: f32::from(c.length_dm[e]) * 0.1,
        }
    }

    #[inline]
    fn is_main(&self) -> bool {
        (hw::TRUNK..=hw::SECONDARY_LINK).contains(&self.hw)
    }

    #[inline]
    fn is_motor_road(&self) -> bool {
        (hw::TRUNK..=hw::ROAD).contains(&self.hw)
    }

    /// A cycle path of its own (not tagged on a road).
    #[inline]
    fn is_bike_path(&self) -> bool {
        self.hw == hw::CYCLEWAY || (self.cyc == 4 && !self.is_motor_road())
    }

    #[inline]
    fn is_narrow_path(&self) -> bool {
        matches!(self.hw, hw::PATH | hw::FOOTWAY | hw::BRIDLEWAY) && !self.is_bike_path()
    }

    /// The surface class the cost uses: the tag, else a guess from the way type.
    #[inline]
    pub(crate) fn surface(&self) -> (u8, Confidence) {
        if self.surf != sc::UNKNOWN {
            return (self.surf, Confidence::Tagged);
        }
        let built = self.built > HALF;
        let by_grade = |tt: u8| match tt {
            1 => Some(sc::PAVED),
            2 => Some(sc::COMPACTED),
            3 => Some(sc::GRAVEL),
            4 | 5 => Some(sc::SOFT),
            _ => None,
        };
        match self.hw {
            hw::TRACK => match by_grade(self.tt) {
                Some(s) => (s, Confidence::Strong),
                None => (sc::GRAVEL, Confidence::Weak),
            },
            hw::UNCLASSIFIED => match by_grade(self.tt) {
                Some(s) => (s, Confidence::Strong),
                None => (sc::PAVED, Confidence::Strong),
            },
            hw::CYCLEWAY | hw::PEDESTRIAN | hw::SERVICE => (
                sc::PAVED,
                if built {
                    Confidence::Strong
                } else {
                    Confidence::Weak
                },
            ),
            hw::PATH | hw::BRIDLEWAY => match by_grade(self.tt) {
                Some(s) => (s, Confidence::Strong),
                None if built => (sc::PAVED, Confidence::Weak),
                None => (sc::SOFT, Confidence::Weak),
            },
            hw::FOOTWAY => {
                if built {
                    (sc::PAVED, Confidence::Strong)
                } else {
                    (sc::GRAVEL, Confidence::Weak)
                }
            }
            hw::STEPS => (sc::PAVED, Confidence::Weak),
            hw::FERRY | 0 => (sc::OTHER, Confidence::Weak),
            _ => (sc::PAVED, Confidence::Strong),
        }
    }

    /// The speed limit, or a guess by class and built-up context (km/h).
    #[inline]
    fn kmh(&self) -> f32 {
        if self.kmh != 0 {
            return f32::from(self.kmh);
        }
        let built = self.built > HALF;
        match self.hw {
            hw::TRUNK..=hw::TERTIARY_LINK => {
                if built {
                    50.0
                } else {
                    100.0
                }
            }
            hw::UNCLASSIFIED | hw::ROAD => {
                if built {
                    50.0
                } else {
                    70.0
                }
            }
            hw::RESIDENTIAL => 40.0,
            hw::LIVING_STREET => 10.0,
            hw::SERVICE => 25.0,
            hw::TRACK => 30.0,
            _ => 0.0,
        }
    }

    /// 0..=1: how much motor traffic the way likely carries.
    #[inline]
    pub(crate) fn traffic(&self) -> f32 {
        let class = match self.hw {
            1 | 2 => 1.0,
            3 | 4 => 0.9,
            5 | 6 => 0.7,
            7 | 8 => 0.45,
            hw::UNCLASSIFIED => 0.25,
            hw::ROAD => 0.2,
            hw::RESIDENTIAL => 0.12,
            hw::SERVICE => 0.05,
            hw::LIVING_STREET => 0.03,
            hw::TRACK => 0.02,
            _ => return 0.0,
        };
        let speed = 0.4 + 0.6 * ((self.kmh() - 30.0) / 70.0).clamp(0.0, 1.0);
        let lanes = match self.lanes {
            0..=2 => 1.0,
            3 => 1.15,
            _ => 1.3,
        };
        let motor = match self.motor {
            1 | 2 => 0.1,
            3 | 4 => 0.4,
            _ => 1.0,
        };
        let separated = match self.cyc {
            1 => 0.9,
            2 => 0.75,
            3 => 0.35,
            5 => 0.4,
            _ => 1.0,
        };
        (class * speed * lanes * motor * separated).min(1.0)
    }

    /// The difficulty on the MTB scale (0 = S0), from `mtb:scale` or else `sac_scale`; `None`
    /// unknown.
    #[inline]
    fn difficulty(&self) -> Option<u8> {
        if self.mtb != 0 {
            Some(self.mtb - 1)
        } else if self.sac != 0 {
            Some(self.sac - 1)
        } else {
            None
        }
    }
}

/// The steepest grade along an arc after taming: capped by what its average climb allows (canopy
/// spikes inside an otherwise flat edge) and discounted in forest, whole percent.
#[inline]
fn tamed_grade(max_grade: u8, ascent_dm: u16, len: f32, forest: u8) -> f32 {
    let avg = f32::from(ascent_dm) * 10.0 / len.max(1.0);
    (f32::from(max_grade).min(2.5 * avg + 5.0) - 5.0 * share(forest)).max(0.0)
}

/// Ascent that counts, metres: the part beyond the deadband.
#[inline]
fn effective_ascent(ascent_dm: u16, len: f32, forest: u8) -> f32 {
    let band = (CLIMB_DEADBAND_OPEN + CLIMB_DEADBAND_FOREST * share(forest)) * len;
    (f32::from(ascent_dm) * 0.1 - band).max(0.0)
}

/// The membership of an edge in a direction-independent preference, −15..=15.
#[inline]
#[allow(clippy::too_many_lines, reason = "one arm per preference")]
pub(crate) fn membership(
    id: PrefId,
    v: &View,
    (s, conf): (u8, Confidence),
    personal: Option<(&PersonalLayer, EdgeId)>,
) -> i8 {
    let weak = if conf == Confidence::Weak { 0.7 } else { 1.0 };
    match id {
        PrefId::Unpaved => lv(match s {
            sc::COMPACTED | sc::GRAVEL => weak,
            sc::SOFT => 0.8 * weak,
            sc::OTHER => 0.5 * weak,
            _ => 0.0,
        }),
        PrefId::PavedSmooth => lv(match s {
            sc::PAVED if v.smooth >= 4 => 0.3,
            sc::PAVED => weak,
            _ => 0.0,
        }),
        PrefId::PavedRough => lv(match s {
            sc::ROUGH => 1.0,
            sc::PAVED if v.smooth >= 4 => 0.6,
            _ => 0.0,
        }),
        PrefId::FineGravel => lv(match s {
            sc::COMPACTED => weak,
            sc::GRAVEL if (1..=2).contains(&v.tt) => 0.6,
            _ => 0.0,
        }),
        PrefId::SoftGround => {
            let by_surface = match s {
                sc::SOFT => weak,
                sc::OTHER => 0.3,
                _ => 0.0,
            };
            let by_grade = match v.tt {
                5 if s != sc::PAVED => 1.0,
                4 if s != sc::PAVED => 0.7,
                _ => 0.0,
            };
            lv(f32::max(by_surface, by_grade))
        }
        PrefId::UnknownSurface => lv(match conf {
            Confidence::Tagged => 0.0,
            Confidence::Strong => 0.3,
            Confidence::Weak => 1.0,
        }),
        PrefId::Tracktype => lv(match v.tt {
            1 | 2 => 1.0,
            3 => 0.2,
            4 => -0.6,
            5 => -1.0,
            _ => 0.0,
        }),
        PrefId::Smoothness => lv(match v.smooth {
            1 => 1.0,
            2 => 0.8,
            3 => 0.2,
            4 => -0.5,
            5 => -0.8,
            6.. => -1.0,
            _ => 0.0,
        }),
        PrefId::Track => lv(f32::from(u8::from(v.hw == hw::TRACK))),
        PrefId::Path => lv(if v.is_narrow_path() {
            1.0
        } else if v.hw == hw::PEDESTRIAN {
            0.5
        } else {
            0.0
        }),
        PrefId::CyclewaySep => lv(if v.is_bike_path() {
            ((0.8 - share(v.road_near)) / 0.6).clamp(0.0, 1.0)
        } else {
            0.0
        }),
        PrefId::CyclewayRoad => lv(if v.is_bike_path() {
            ((share(v.road_near) - 0.2) / 0.6).clamp(0.0, 1.0)
        } else if v.is_motor_road() && v.cyc == 3 {
            1.0
        } else {
            0.0
        }),
        PrefId::Residential => lv(f32::from(u8::from(matches!(
            v.hw,
            hw::RESIDENTIAL | hw::LIVING_STREET
        )))),
        PrefId::Service => lv(f32::from(u8::from(v.hw == hw::SERVICE))),
        PrefId::Minor => lv(match v.hw {
            hw::TERTIARY | hw::TERTIARY_LINK | hw::UNCLASSIFIED => 1.0,
            hw::ROAD => 0.5,
            _ => 0.0,
        }),
        PrefId::Main => lv(f32::from(u8::from(v.is_main()))),
        // seeking quiet is avoiding traffic: the membership is the traffic, negated
        PrefId::Quiet => lv(-v.traffic()),
        PrefId::Speed => lv(if v.is_motor_road() {
            ((v.kmh() - 50.0) / 30.0).clamp(0.0, 1.0)
        } else {
            0.0
        }),
        PrefId::Lanes => lv(match v.lanes {
            0 if matches!(v.hw, 1 | 2) => 0.6,
            3 => 0.6,
            4.. => 1.0,
            _ => 0.0,
        }),
        PrefId::NearRoad => lv(share(v.road_near)),
        PrefId::Forest => lv(share(v.forest)),
        PrefId::ForestEdge => lv(share(v.forest_edge)),
        PrefId::Water => lv(share(v.water)),
        PrefId::Open => lv((1.0 - share(v.forest) - share(v.built)).clamp(0.0, 1.0)),
        PrefId::Built => lv(share(v.built)),
        PrefId::BikeRoutes => lv(match v.route {
            1 => 0.7,
            2 => 0.85,
            3 | 4 => 1.0,
            _ => 0.0,
        }),
        PrefId::MtbRoutes => lv(f32::from(u8::from(v.mtb_route))),
        PrefId::Access => lv(match v.bike {
            ba::DESTINATION => 0.3,
            ba::DISMOUNT => 0.6,
            ba::AGRI => 0.7,
            ba::USE_SIDEPATH | ba::FOOT_ONLY | ba::PRIVATE | ba::NO => 1.0,
            _ => 0.0,
        }),
        PrefId::Sketchy => {
            let tech: f32 = match v.difficulty() {
                Some(0) | None => 0.0,
                Some(1) => 0.4,
                Some(2) => 0.75,
                Some(_) => 1.0,
            };
            let faint = match v.vis {
                3 => 0.3,
                4 => 0.6,
                5 | 6 => 1.0,
                _ => 0.0,
            };
            let grade = match v.tt {
                5 => 1.0,
                4 => 0.5,
                _ => 0.0,
            };
            let informal = if v.informal { 0.8 } else { 0.0 };
            lv(tech.max(faint).max(grade).max(informal))
        }
        PrefId::Mtb => lv(match v.difficulty() {
            Some(0) | None => 0.0,
            Some(1) => 0.35,
            Some(2) => 0.7,
            Some(_) => 1.0,
        }),
        PrefId::Visibility => lv(match v.vis {
            3 => 0.35,
            4 => 0.65,
            5 => 0.85,
            6 => 1.0,
            _ => 0.0,
        }),
        PrefId::Novel | PrefId::Stale | PrefId::Familiar => {
            let Some((layer, e)) = personal else { return 0 };
            let rides = layer.rides(e);
            lv(match id {
                PrefId::Novel => f32::from(u8::from(rides == 0)),
                PrefId::Stale => layer.days_since(e).map_or(0.0, |d| {
                    #[allow(clippy::cast_precision_loss, reason = "days")]
                    let d = d as f32;
                    ((d - 180.0) / 550.0).clamp(0.0, 1.0)
                }),
                _ => match rides {
                    0 => 0.0,
                    1 => 0.25,
                    2 => 0.45,
                    3 | 4 => 0.7,
                    _ => 1.0,
                },
            })
        }
        // directional: see the arc terms
        PrefId::Climb | PrefId::Steep => 0,
    }
}

/// The table of a preference at a weight: factor per membership level.
fn table(id: PrefId, w: f32) -> Table {
    let m = pref_meta(id);
    let (kb, kp) = ((1.0 / m.max_bonus).ln(), m.max_penalty.ln());
    let mut t = [1.0; LEVELS];
    for (i, f) in t.iter_mut().enumerate() {
        #[allow(clippy::cast_precision_loss, reason = "a level")]
        let x = w * (i as f32 - 15.0) / 15.0;
        *f = if x >= 0.0 {
            (-kb * x).exp()
        } else {
            (-kp * x).exp()
        };
    }
    t
}

/// Why an arc cannot be ridden.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exclusion {
    /// A limit of the profile.
    Limit(LimitId),
    /// `bicycle=no` (also motor roads): never.
    NoBikes,
    /// One-way against the direction.
    Oneway,
}

impl Exclusion {
    /// For error messages.
    #[must_use]
    pub fn describe(self) -> String {
        match self {
            Exclusion::Limit(id) => format!("the limit \"{}\"", crate::catalogue::limit_meta(id).label),
            Exclusion::NoBikes => "a bicycle ban (bicycle=no or a motor road)".into(),
            Exclusion::Oneway => "one-way".into(),
        }
    }
}

/// The active limits.
#[derive(Debug, Clone, Copy, Default)]
struct Limits {
    no_main: bool,
    paved_only: bool,
    no_unknown: bool,
    max_grade: Option<f32>,
    max_mtb: Option<u8>,
    no_stairs: bool,
    legal_only: bool,
    no_ferries: bool,
}

/// A profile prepared for compiling: its active preferences as tables, limits and bounds.
#[derive(Debug, Clone)]
pub struct CostModel {
    /// Direction-independent quality preferences.
    quality: Vec<(PrefId, Table)>,
    /// Direction-independent gated preferences.
    gated: Vec<(PrefId, Table)>,
    steep: Option<Table>,
    /// Seeking climbs (gated, directional).
    climb_bonus: Option<Table>,
    /// Avoiding climbs: metres per metre of effective ascent.
    climb_cost: f32,
    limits: Limits,
    pub min_factor: f32,
    pub max_factor: f32,
}

/// Per-arc explanation of the cost (for "why this way").
#[derive(Debug, Clone, PartialEq)]
pub struct ArcCost {
    /// Every active preference's factor on this arc (1 where it does not apply), catalogue order.
    pub factors: Vec<(PrefId, f32)>,
    /// How much of the gated bonuses counted, 0..=1.
    pub gate: f32,
    /// The clamped factor.
    pub factor: f32,
    /// Additive metres: climbing, and barriers/steps/dismount/ferry.
    pub climb_m: f32,
    pub penalty_m: f32,
    /// The arc's cost (infinite when excluded).
    pub cost: f32,
    pub excluded: Option<Exclusion>,
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a table index"
)]
#[inline]
fn at(t: &Table, m: i8) -> f32 {
    t[(m + 15) as usize]
}

impl CostModel {
    /// Prepares a profile (validated here).
    pub fn new(p: &Profile) -> Result<CostModel, ProfileError> {
        p.validate()?;
        let mut m = CostModel {
            quality: Vec::new(),
            gated: Vec::new(),
            steep: None,
            climb_bonus: None,
            climb_cost: 0.0,
            limits: Limits::default(),
            min_factor: p.bounds().min_factor,
            max_factor: p.bounds().max_factor,
        };
        for (&id, w) in &p.weights {
            let w = w.unit();
            if w == 0.0 {
                continue;
            }
            match id {
                PrefId::Steep => m.steep = Some(table(id, w)),
                PrefId::Climb if w > 0.0 => m.climb_bonus = Some(table(id, w)),
                PrefId::Climb => m.climb_cost = -w * pref_meta(id).max_penalty,
                _ if pref_meta(id).gated => m.gated.push((id, table(id, w))),
                _ => m.quality.push((id, table(id, w))),
            }
        }
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "0..=5")]
        let lim = Limits {
            no_main: p.limit(LimitId::NoMainRoads).is_some(),
            paved_only: p.limit(LimitId::PavedOnly).is_some(),
            no_unknown: p.limit(LimitId::NoUnknownSurface).is_some(),
            max_grade: p.limit(LimitId::MaxGrade).flatten().map(|n| n as f32),
            max_mtb: p.limit(LimitId::MaxMtbScale).flatten().map(|n| n.round() as u8),
            no_stairs: p.limit(LimitId::NoStairs).is_some(),
            legal_only: p.limit(LimitId::LegalOnly).is_some(),
            no_ferries: p.limit(LimitId::NoFerries).is_some(),
        };
        m.limits = lim;
        Ok(m)
    }

    /// Whether the model reads the personal layer.
    #[must_use]
    pub fn uses_personal(&self) -> bool {
        self.gated
            .iter()
            .any(|(id, _)| matches!(id, PrefId::Novel | PrefId::Stale | PrefId::Familiar))
    }

    /// The limit (or rule) that excludes an edge in both directions, if any.
    #[inline]
    fn excluded(
        &self,
        v: &View,
        (s, conf): (u8, Confidence),
        grade_up: f32,
        grade_down: f32,
    ) -> Option<Exclusion> {
        let l = &self.limits;
        if v.bike == ba::NO {
            return Some(Exclusion::NoBikes);
        }
        if l.no_main && v.is_main() && v.cyc != 3 {
            return Some(Exclusion::Limit(LimitId::NoMainRoads));
        }
        if l.paved_only || l.no_unknown {
            if l.paved_only && (!matches!(s, sc::PAVED | sc::ROUGH) || conf == Confidence::Weak) {
                return Some(Exclusion::Limit(LimitId::PavedOnly));
            }
            if l.no_unknown && conf == Confidence::Weak {
                return Some(Exclusion::Limit(LimitId::NoUnknownSurface));
            }
        }
        if let Some(max) = l.max_grade
            && grade_up.max(grade_down) > max
        {
            return Some(Exclusion::Limit(LimitId::MaxGrade));
        }
        if let Some(max) = l.max_mtb
            && v.difficulty().is_some_and(|d| d > max)
        {
            return Some(Exclusion::Limit(LimitId::MaxMtbScale));
        }
        if l.no_stairs && (v.hw == hw::STEPS || v.sac >= 3 || v.mtb >= 5) {
            return Some(Exclusion::Limit(LimitId::NoStairs));
        }
        if l.legal_only && matches!(v.bike, ba::USE_SIDEPATH | ba::FOOT_ONLY | ba::AGRI | ba::PRIVATE) {
            return Some(Exclusion::Limit(LimitId::LegalOnly));
        }
        if l.no_ferries && v.hw == hw::FERRY {
            return Some(Exclusion::Limit(LimitId::NoFerries));
        }
        None
    }

    /// Fixed additive metres of an edge (barriers, steps, dismount, ferry).
    #[inline]
    fn penalty_m(v: &View) -> f32 {
        let mut add = f32::from(v.barriers) * BARRIER_M;
        if v.hw == hw::STEPS {
            add += v.length * STEPS_PER_M + STEPS_EACH_M;
        }
        if v.bike == ba::DISMOUNT {
            add += v.length * DISMOUNT_PER_M;
        }
        if v.hw == hw::FERRY {
            add += FERRY_M;
        }
        add
    }

    /// The gate: how much of the gated bonuses count at a quality factor.
    #[inline]
    fn gate(q: f32) -> f32 {
        ((GATE_BAD - q) / (GATE_BAD - GATE_OK)).clamp(0.0, 1.0)
    }

    /// Compiles every arc's cost into `out` (resized; no other allocation). Returns the smallest
    /// factor produced (the A* bound per metre).
    #[allow(clippy::cast_possible_truncation, reason = "edge ids fit u32")]
    pub fn compile_into(&self, g: &Graph, personal: Option<&PersonalLayer>, out: &mut Vec<f32>) -> f32 {
        let c = g.edge_columns();
        let m = g.edge_count();
        out.clear();
        out.resize(m * 2, f32::INFINITY);
        let personal = personal.filter(|p| p.fits(m));
        let need_grade = self.steep.is_some() || self.limits.max_grade.is_some();
        let mut min_seen = f32::INFINITY;
        for e in 0..m {
            let v = View::decode(c, e);
            let surface = v.surface();
            let asc = [c.ascent_fwd_dm[e], c.ascent_bwd_dm[e]];
            let grade = if need_grade {
                [
                    tamed_grade(c.grade_fwd[e], asc[0], v.length, v.forest),
                    tamed_grade(c.grade_bwd[e], asc[1], v.length, v.forest),
                ]
            } else {
                [0.0; 2]
            };
            if self.excluded(&v, surface, grade[0], grade[1]).is_some() {
                continue;
            }
            let pe = personal.map(|p| (p, e as EdgeId));
            let mut q = 1.0f32;
            for (id, t) in &self.quality {
                q *= at(t, membership(*id, &v, surface, pe));
            }
            let mut bonus = 1.0f32;
            for (id, t) in &self.gated {
                let f = at(t, membership(*id, &v, surface, pe));
                if f < 1.0 {
                    bonus *= f;
                } else {
                    q *= f;
                }
            }
            let penalty = Self::penalty_m(&v);
            let oneway = crate::attrs::oneway_of(c.surf[e]);
            for dir in 0..2 {
                if !oneway.allows(dir == 1) {
                    continue;
                }
                let f = self.arc_factor(v.length, v.forest, q, bonus, grade[dir], grade[1 - dir], asc[dir]);
                min_seen = min_seen.min(f);
                let climb = if self.climb_cost > 0.0 {
                    self.climb_cost * effective_ascent(asc[dir], v.length, v.forest)
                } else {
                    0.0
                };
                out[e * 2 + dir] = v.length * f + penalty + climb;
            }
        }
        if min_seen.is_finite() {
            min_seen
        } else {
            self.min_factor
        }
    }

    /// The clamped factor of an arc from its edge's products.
    #[inline]
    #[allow(clippy::too_many_arguments, reason = "an arc's inputs")]
    fn arc_factor(
        &self,
        len: f32,
        forest: u8,
        q: f32,
        bonus: f32,
        grade_up: f32,
        grade_down: f32,
        ascent_dm: u16,
    ) -> f32 {
        let mut q = q;
        let mut bonus = bonus;
        if let Some(t) = &self.steep {
            let up = (grade_up - 8.0) / 8.0;
            let down = 0.5 * (grade_down - 8.0) / 8.0;
            q *= at(t, lv(up.max(down).clamp(0.0, 1.0)));
        }
        if let Some(t) = &self.climb_bonus {
            let rate = effective_ascent(ascent_dm, len, forest) / len.max(1.0);
            bonus *= at(t, lv(rate / CLIMB_FULL_GRADE));
        }
        let f = q * (1.0 + (bonus - 1.0) * Self::gate(q));
        f.clamp(self.min_factor, self.max_factor)
    }

    /// The cost of one arc, explained.
    #[must_use]
    pub fn explain(&self, g: &Graph, personal: Option<&PersonalLayer>, a: crate::ArcId) -> ArcCost {
        let c = g.edge_columns();
        let e = arc_edge(a) as usize;
        let dir = usize::from(arc_is_reverse(a));
        let v = View::decode(c, e);
        let surface = v.surface();
        let personal = personal.filter(|p| p.fits(g.edge_count()));
        #[allow(clippy::cast_possible_truncation, reason = "edge ids fit u32")]
        let pe = personal.map(|p| (p, e as EdgeId));
        let asc = [c.ascent_fwd_dm[e], c.ascent_bwd_dm[e]];
        let grd = [c.grade_fwd[e], c.grade_bwd[e]];
        let grade = [
            tamed_grade(grd[0], asc[0], v.length, v.forest),
            tamed_grade(grd[1], asc[1], v.length, v.forest),
        ];
        let mut factors = Vec::new();
        let mut q = 1.0f32;
        let mut bonus = 1.0f32;
        for (id, t) in &self.quality {
            let f = at(t, membership(*id, &v, surface, pe));
            q *= f;
            factors.push((*id, f));
        }
        for (id, t) in &self.gated {
            let f = at(t, membership(*id, &v, surface, pe));
            if f < 1.0 {
                bonus *= f;
            } else {
                q *= f;
            }
            factors.push((*id, f));
        }
        if let Some(t) = &self.steep {
            let up = (grade[dir] - 8.0) / 8.0;
            let down = 0.5 * (grade[1 - dir] - 8.0) / 8.0;
            factors.push((PrefId::Steep, at(t, lv(up.max(down).clamp(0.0, 1.0)))));
        }
        if let Some(t) = &self.climb_bonus {
            let rate = effective_ascent(asc[dir], v.length, v.forest) / v.length.max(1.0);
            factors.push((PrefId::Climb, at(t, lv(rate / CLIMB_FULL_GRADE))));
        }
        factors.sort_by_key(|(id, _)| id.index());
        let steep = factors
            .iter()
            .find(|(id, _)| *id == PrefId::Steep)
            .map_or(1.0, |f| f.1);
        let gate = Self::gate(q * steep);
        let factor = self.arc_factor(v.length, v.forest, q, bonus, grade[dir], grade[1 - dir], asc[dir]);
        let climb_m = self.climb_cost * effective_ascent(asc[dir], v.length, v.forest);
        let penalty_m = Self::penalty_m(&v);
        let excluded = self
            .excluded(&v, surface, grade[0], grade[1])
            .or_else(|| (!crate::attrs::oneway_of(c.surf[e]).allows(dir == 1)).then_some(Exclusion::Oneway));
        ArcCost {
            factors,
            gate,
            factor,
            climb_m,
            penalty_m,
            cost: if excluded.is_some() {
                f32::INFINITY
            } else {
                v.length * factor + penalty_m + climb_m
            },
            excluded,
        }
    }

    /// What excludes an edge in both directions (`None`: at least one direction may be ridden
    /// unless one-way forbids it).
    #[must_use]
    pub fn edge_exclusion(&self, g: &Graph, e: EdgeId) -> Option<Exclusion> {
        let c = g.edge_columns();
        let i = e as usize;
        let v = View::decode(c, i);
        let g0 = tamed_grade(c.grade_fwd[i], c.ascent_fwd_dm[i], v.length, v.forest);
        let g1 = tamed_grade(c.grade_bwd[i], c.ascent_bwd_dm[i], v.length, v.forest);
        self.excluded(&v, v.surface(), g0, g1)
    }
}

/// Where a preference's membership comes from: what [`EdgeClasses`] groups edges by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    /// The tags (class, surface, access, speed, difficulty, …) and whether the edge is built-up.
    Tag,
    /// The context shares and whether it is a bike path (or a road with a cycle track).
    Ctx,
    /// The personal layer.
    Edge,
}

fn side(id: PrefId) -> Side {
    match id {
        PrefId::NearRoad
        | PrefId::Forest
        | PrefId::ForestEdge
        | PrefId::Water
        | PrefId::Open
        | PrefId::Built
        | PrefId::CyclewaySep
        | PrefId::CyclewayRoad => Side::Ctx,
        PrefId::Novel | PrefId::Stale | PrefId::Familiar => Side::Edge,
        _ => Side::Tag,
    }
}

/// A fast hasher for the class keys (multiplicative, like `FxHash`).
#[derive(Default)]
struct KeyHasher(u64);

impl std::hash::Hasher for KeyHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.write_u64(u64::from(b));
        }
    }
    fn write_u64(&mut self, v: u64) {
        self.0 = (self.0.rotate_left(5) ^ v).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
}

type KeyMap = std::collections::HashMap<u64, u16, std::hash::BuildHasherDefault<KeyHasher>>;

/// Edges grouped by the tags the direction-independent cost reads (class, surface, access, speed,
/// difficulty, built-up or not), built once per graph: a profile is evaluated once per group
/// (~30 k for a 100 km region) instead of once per edge, and the per-edge pass is a table lookup
/// plus tiny tables for the context shares. One u16 per edge.
#[derive(Debug, Clone, Default)]
pub struct EdgeClasses {
    tag: Vec<u16>,
    /// A representative edge per class.
    rep: Vec<u32>,
}

impl EdgeClasses {
    /// Groups the edges; `None` with more than 65 536 groups (the compile then evaluates every
    /// edge).
    #[must_use]
    #[allow(clippy::cast_possible_truncation, reason = "edge ids fit u32")]
    pub fn build(g: &Graph) -> Option<EdgeClasses> {
        let c = g.edge_columns();
        let m = g.edge_count();
        let mut out = EdgeClasses {
            tag: Vec::with_capacity(m),
            rep: Vec::new(),
        };
        let mut map = KeyMap::default();
        for e in 0..m {
            let n = map.len();
            let id = *map.entry(Self::key(c, e)).or_insert(u16::try_from(n).ok()?);
            if usize::from(id) == n {
                out.rep.push(e as u32);
            }
            out.tag.push(id);
        }
        Some(out)
    }

    /// Everything the tag side reads.
    #[inline]
    fn key(c: &EdgeColumns, e: usize) -> u64 {
        let built = u64::from((c.ctx[e] >> 12) & 15 > u16::from(HALF));
        u64::from(c.highway[e])
            | u64::from(c.surf[e] & 63) << 8
            | u64::from(c.smooth[e]) << 16
            | u64::from(c.access[e]) << 24
            | u64::from(c.road[e] & 63) << 32
            | u64::from(c.speed[e]) << 40
            | u64::from(c.diff[e] & 63) << 48
            | built << 56
    }

    /// Whether the classes were built for a graph of `edges` edges.
    #[must_use]
    pub fn fits(&self, edges: usize) -> bool {
        self.tag.len() == edges
    }

    /// Distinct classes.
    #[must_use]
    pub fn count(&self) -> usize {
        self.rep.len()
    }

    #[must_use]
    pub fn heap_bytes(&self) -> usize {
        self.tag.capacity() * 2 + self.rep.capacity() * 4
    }
}

/// Context tables of a profile: (quality, bonus) by the context nibbles.
struct CtxTables {
    /// By forest | built-up << 4 (forest, built, open).
    forest_built: [(f32, f32); 256],
    forest_edge: [(f32, f32); 16],
    water: [(f32, f32); 16],
    /// By road-near | bike path << 4 | road with a cycle track << 5.
    road: [(f32, f32); 64],
}

/// An edge with nothing set (for the context tables).
const ZERO_VIEW: View = View {
    hw: 0,
    surf: 0,
    tt: 0,
    smooth: 0,
    vis: 0,
    informal: false,
    bike: 0,
    motor: 0,
    mtb_route: false,
    cyc: 0,
    route: 0,
    kmh: 0,
    lanes: 0,
    mtb: 0,
    sac: 0,
    barriers: 0,
    forest: 0,
    forest_edge: 0,
    water: 0,
    built: 0,
    road_near: 0,
    length: 1.0,
};

impl CostModel {
    /// The products of the preferences of one side over an edge.
    #[inline]
    #[allow(clippy::too_many_arguments, reason = "the edge and the two products")]
    fn products(
        list: &[(PrefId, Table)],
        gated: bool,
        want: Side,
        v: &View,
        surface: (u8, Confidence),
        personal: Option<(&PersonalLayer, EdgeId)>,
        q: &mut f32,
        bonus: &mut f32,
    ) {
        for (id, t) in list {
            if side(*id) != want {
                continue;
            }
            let f = at(t, membership(*id, v, surface, personal));
            if gated && f < 1.0 {
                *bonus *= f;
            } else {
                *q *= f;
            }
        }
    }

    /// The (quality, bonus) of some context-side preferences on a synthetic edge.
    fn ctx_products(&self, only: &[PrefId], v: &View) -> (f32, f32) {
        let (mut q, mut bonus) = (1.0, 1.0);
        let none = (0, Confidence::Tagged);
        for (list, gated) in [(&self.quality, false), (&self.gated, true)] {
            for (id, t) in list.iter().filter(|(id, _)| only.contains(id)) {
                let f = at(t, membership(*id, v, none, None));
                if gated && f < 1.0 {
                    bonus *= f;
                } else {
                    q *= f;
                }
            }
        }
        (q, bonus)
    }

    #[allow(clippy::cast_possible_truncation, reason = "nibbles")]
    fn ctx_tables(&self) -> CtxTables {
        let mut t = CtxTables {
            forest_built: [(1.0, 1.0); 256],
            forest_edge: [(1.0, 1.0); 16],
            water: [(1.0, 1.0); 16],
            road: [(1.0, 1.0); 64],
        };
        for i in 0..256usize {
            let lo = (i & 15) as u8;
            t.forest_built[i] = self.ctx_products(
                &[PrefId::Forest, PrefId::Built, PrefId::Open],
                &View {
                    forest: lo,
                    built: (i >> 4) as u8,
                    ..ZERO_VIEW
                },
            );
            if i < 16 {
                t.forest_edge[i] = self.ctx_products(
                    &[PrefId::ForestEdge],
                    &View {
                        forest_edge: lo,
                        ..ZERO_VIEW
                    },
                );
                t.water[i] = self.ctx_products(
                    &[PrefId::Water],
                    &View {
                        water: lo,
                        ..ZERO_VIEW
                    },
                );
            }
            let (bike_path, roadside) = (i & 16 != 0, i & 32 != 0);
            if i < 64 && !(bike_path && roadside) {
                let v = View {
                    road_near: lo,
                    hw: if bike_path {
                        hw::CYCLEWAY
                    } else if roadside {
                        3
                    } else {
                        0
                    },
                    cyc: if roadside { 3 } else { 0 },
                    ..ZERO_VIEW
                };
                t.road[i] =
                    self.ctx_products(&[PrefId::NearRoad, PrefId::CyclewaySep, PrefId::CyclewayRoad], &v);
            }
        }
        t
    }

    /// [`CostModel::compile_into`] through edge classes: the same costs, much faster.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::too_many_lines,
        reason = "edge ids fit u32; one pass"
    )]
    pub fn compile_classes(
        &self,
        g: &Graph,
        classes: &EdgeClasses,
        personal: Option<&PersonalLayer>,
        out: &mut Vec<f32>,
    ) -> f32 {
        let c = g.edge_columns();
        let m = g.edge_count();
        if !classes.fits(m) {
            return self.compile_into(g, personal, out);
        }
        let personal = personal.filter(|p| p.fits(m));
        // per tag class: (quality, bonus); quality infinite when a limit excludes it
        let tags: Vec<(f32, f32)> = classes
            .rep
            .iter()
            .map(|&r| {
                let v = View::decode(c, r as usize);
                let surface = v.surface();
                if self.excluded(&v, surface, 0.0, 0.0).is_some() {
                    return (f32::INFINITY, 1.0);
                }
                let (mut q, mut bonus) = (1.0, 1.0);
                Self::products(
                    &self.quality,
                    false,
                    Side::Tag,
                    &v,
                    surface,
                    None,
                    &mut q,
                    &mut bonus,
                );
                Self::products(
                    &self.gated,
                    true,
                    Side::Tag,
                    &v,
                    surface,
                    None,
                    &mut q,
                    &mut bonus,
                );
                (q, bonus)
            })
            .collect();
        let ct = self.ctx_tables();
        let history: Vec<(PrefId, Table)> = if personal.is_some() {
            self.gated
                .iter()
                .filter(|(id, _)| side(*id) == Side::Edge)
                .copied()
                .collect()
        } else {
            Vec::new()
        };
        let need_grade = self.steep.is_some() || self.limits.max_grade.is_some();
        let per_arc = need_grade || self.climb_bonus.is_some() || self.climb_cost > 0.0;
        out.clear();
        out.resize(m * 2, f32::INFINITY);
        let mut min_seen = f32::INFINITY;
        for (e, pair) in out.as_chunks_mut::<2>().0.iter_mut().enumerate() {
            let (tq, tb) = tags[usize::from(classes.tag[e])];
            if !tq.is_finite() {
                continue;
            }
            let ctx = c.ctx[e];
            let nib = |s: u16| usize::from((ctx >> s) & 15);
            let forest = nib(0);
            let road_near = usize::from(c.ctx2[e] & 15);
            let hwy = c.highway[e];
            let cyc = c.road[e] & 7;
            let motor_road = (hw::TRUNK..=hw::ROAD).contains(&hwy);
            let bike_path = hwy == hw::CYCLEWAY || (cyc == 4 && !motor_road);
            let roadside = motor_road && cyc == 3 && !bike_path;
            let road_key = road_near | usize::from(bike_path) << 4 | usize::from(roadside) << 5;
            let parts = [
                ct.forest_built[forest | nib(12) << 4],
                ct.forest_edge[nib(4)],
                ct.water[nib(8)],
                ct.road[road_key],
            ];
            let mut q = tq;
            let mut bonus = tb;
            for (pq, pb) in parts {
                q *= pq;
                bonus *= pb;
            }
            let len = f32::from(c.length_dm[e]) * 0.1;
            let mut penalty = f32::from(c.diff[e] >> 6) * BARRIER_M;
            if hwy == hw::STEPS {
                penalty += len * STEPS_PER_M + STEPS_EACH_M;
            } else if hwy == hw::FERRY {
                penalty += FERRY_M;
            }
            if c.access[e] & 15 == ba::DISMOUNT {
                penalty += len * DISMOUNT_PER_M;
            }
            let oneway = crate::attrs::oneway_of(c.surf[e]);
            if let Some(p) = personal
                && !history.is_empty()
            {
                let v = View::decode(c, e);
                for (id, t) in &history {
                    let f = at(
                        t,
                        membership(*id, &v, (0, Confidence::Tagged), Some((p, e as EdgeId))),
                    );
                    if f < 1.0 {
                        bonus *= f;
                    } else {
                        q *= f;
                    }
                }
            }
            if !per_arc {
                let f = (q * (1.0 + (bonus - 1.0) * Self::gate(q))).clamp(self.min_factor, self.max_factor);
                min_seen = min_seen.min(f);
                let cost = len * f + penalty;
                if oneway.allows(false) {
                    pair[0] = cost;
                }
                if oneway.allows(true) {
                    pair[1] = cost;
                }
                continue;
            }
            let forest = forest as u8;
            let asc = [c.ascent_fwd_dm[e], c.ascent_bwd_dm[e]];
            let grade = if need_grade {
                [
                    tamed_grade(c.grade_fwd[e], asc[0], len, forest),
                    tamed_grade(c.grade_bwd[e], asc[1], len, forest),
                ]
            } else {
                [0.0; 2]
            };
            if let Some(max) = self.limits.max_grade
                && grade[0].max(grade[1]) > max
            {
                continue;
            }
            for dir in 0..2 {
                if !oneway.allows(dir == 1) {
                    continue;
                }
                let f = self.arc_factor(len, forest, q, bonus, grade[dir], grade[1 - dir], asc[dir]);
                min_seen = min_seen.min(f);
                let climb = if self.climb_cost > 0.0 {
                    self.climb_cost * effective_ascent(asc[dir], len, forest)
                } else {
                    0.0
                };
                pair[dir] = len * f + penalty + climb;
            }
        }
        if min_seen.is_finite() {
            min_seen
        } else {
            self.min_factor
        }
    }
}

/// The surface class a route reports for an edge: the tag or a safe guess, else unknown.
#[must_use]
pub fn reported_surface(g: &Graph, e: EdgeId) -> SurfaceClass {
    let v = View::decode(g.edge_columns(), e as usize);
    match v.surface() {
        (_, Confidence::Weak) => SurfaceClass::Unknown,
        (s, _) => SurfaceClass::from_code(s).unwrap_or_default(),
    }
}

/// Riding speed on an arc, km/h, and the climbing time: a rough model by surface and grade.
#[must_use]
pub fn arc_seconds(g: &Graph, a: crate::ArcId, fraction: f32) -> f32 {
    let c = g.edge_columns();
    let e = arc_edge(a) as usize;
    let v = View::decode(c, e);
    let (s, _) = v.surface();
    let mut kmh = match s {
        sc::PAVED => 21.0,
        sc::ROUGH => 15.0,
        sc::COMPACTED => 18.0,
        sc::GRAVEL => 16.0,
        sc::SOFT => 11.0,
        _ => 13.0,
    };
    if v.is_narrow_path() {
        kmh *= 0.9;
    }
    if v.bike == ba::DISMOUNT {
        kmh = 5.0;
    }
    if v.hw == hw::STEPS {
        kmh = 2.0;
    }
    let len = v.length * fraction;
    let rev = arc_is_reverse(a);
    let (up, down) = if rev {
        (c.ascent_bwd_dm[e], c.ascent_fwd_dm[e])
    } else {
        (c.ascent_fwd_dm[e], c.ascent_bwd_dm[e])
    };
    let climb = effective_ascent(up, v.length, v.forest) * fraction;
    let fall_rate = effective_ascent(down, v.length, v.forest) / v.length.max(1.0);
    if v.hw != hw::STEPS && fall_rate > 0.02 {
        kmh *= 1.0 + 0.4 * ((fall_rate - 0.02) / 0.04).min(1.0);
    }
    let mut secs = len / (kmh / 3.6) + climb * 3600.0 / 700.0;
    if v.hw == hw::FERRY {
        secs = len / (10.0 / 3.6) + 600.0;
    }
    secs
}

/// Climbing on an arc that counts (beyond the deadband), metres, for the totals.
#[must_use]
pub fn arc_ascent_m(g: &Graph, a: crate::ArcId) -> f32 {
    let c = g.edge_columns();
    let e = arc_edge(a) as usize;
    let v = View::decode(c, e);
    let dm = if arc_is_reverse(a) {
        c.ascent_bwd_dm[e]
    } else {
        c.ascent_fwd_dm[e]
    };
    effective_ascent(dm, v.length, v.forest)
}

/// The way kind a route reports.
#[must_use]
pub fn way_kind(g: &Graph, e: EdgeId) -> WayKind {
    let v = View::decode(g.edge_columns(), e as usize);
    if v.is_bike_path() {
        return if v.road_near > HALF {
            WayKind::BikePathRoadside
        } else {
            WayKind::BikePath
        };
    }
    match v.hw {
        // riding the road's own cycle track
        1..=13 if v.cyc == 3 => WayKind::BikePathRoadside,
        1..=6 => WayKind::MainRoad,
        hw::TERTIARY | hw::TERTIARY_LINK | hw::UNCLASSIFIED | hw::ROAD => WayKind::CountryRoad,
        hw::RESIDENTIAL | hw::LIVING_STREET | hw::PEDESTRIAN => WayKind::Residential,
        hw::SERVICE => WayKind::Service,
        hw::TRACK => WayKind::Track,
        hw::PATH | hw::FOOTWAY | hw::BRIDLEWAY => WayKind::Path,
        hw::STEPS => WayKind::Steps,
        hw::FERRY => WayKind::Ferry,
        _ => WayKind::Other,
    }
}

/// The way types of the route breakdown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, ts_rs::TS))]
pub enum WayKind {
    /// Trunk, primary, secondary.
    MainRoad,
    /// Tertiary, unclassified.
    CountryRoad,
    Residential,
    Service,
    Track,
    Path,
    /// A separate cycle path away from motor roads.
    BikePath,
    /// A separate cycle path beside a motor road.
    BikePathRoadside,
    Steps,
    Ferry,
    Other,
}

/// Share of the region's length with each catalogue attribute mapped (`Coverage::attribute`).
#[must_use]
pub fn coverage(g: &Graph, personal: Option<&PersonalLayer>) -> BTreeMap<&'static str, f32> {
    let c = g.edge_columns();
    // (mapped length, relevant length) per attribute
    let mut acc: BTreeMap<&'static str, (f64, f64)> = BTreeMap::new();
    let mut add = |k: &'static str, mapped: bool, relevant: bool, len: f64| {
        let a = acc.entry(k).or_default();
        if relevant {
            a.1 += len;
            if mapped {
                a.0 += len;
            }
        }
    };
    for e in 0..g.edge_count() {
        let v = View::decode(c, e);
        let len = f64::from(v.length);
        let trail = matches!(v.hw, hw::TRACK | hw::PATH | hw::FOOTWAY | hw::BRIDLEWAY);
        add("surface_class", v.surf != 0, true, len);
        add("tracktype", v.tt != 0, v.hw == hw::TRACK, len);
        add("smoothness", v.smooth != 0, true, len);
        add("maxspeed_kmh", v.kmh != 0, v.is_motor_road(), len);
        add("lanes", v.lanes != 0, v.is_motor_road(), len);
        add("mtb_scale", v.mtb != 0 || v.sac != 0, trail, len);
        add("trail_visibility", v.vis != 0, trail, len);
        add("bike_access", true, true, len);
        add("road_near_share", true, v.is_bike_path(), len);
        let ele = g.node_elevation_m(c.from[e]).is_some() && g.node_elevation_m(c.to[e]).is_some();
        add("ascent_fwd_m", ele, true, len);
        add("max_grade_fwd_pct", ele, true, len);
        add(
            "personal",
            personal.is_some_and(|p| p.fits(g.edge_count())),
            true,
            len,
        );
    }
    #[allow(clippy::cast_possible_truncation, reason = "a share")]
    acc.into_iter()
        .map(|(k, (m, r))| (k, if r > 0.0 { (m / r) as f32 } else { 0.0 }))
        .collect()
}
