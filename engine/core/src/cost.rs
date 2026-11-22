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

use serde::{Deserialize, Serialize};

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
/// The time model's climbing: metres of ascent per hour on top of the flat riding time.
pub const CLIMB_M_PER_H: f32 = 900.0;
/// Average grade (after the deadband) at which seeking climbs reaches its full bonus.
pub const CLIMB_FULL_GRADE: f32 = 0.05;

/// Membership levels: fifteenths, −15..=15.
const LEVELS: usize = 31;
type Table = [f32; LEVELS];

/// Spike #60: the cost model variant, from `KOMPASS_SPIKE_MODEL` (never merged).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Today: the product of every factor, hard clamp.
    Today,
    /// Within a catalogue group, one factor: the strongest bonus × the strongest penalty (tiers).
    Groups,
    /// Today's product, a soft floor: full up to half the floor (in log space), then tanh to it.
    Soft,
    /// Groups and the soft floor.
    GroupsSoft,
    /// Today's product raised to γ so the smallest product in the graph lands on the floor.
    Norm,
}

impl Mode {
    fn from_env() -> Mode {
        match std::env::var("KOMPASS_SPIKE_MODEL").as_deref() {
            Ok("groups") => Mode::Groups,
            Ok("soft") => Mode::Soft,
            Ok("groups_soft") => Mode::GroupsSoft,
            Ok("norm") => Mode::Norm,
            _ => Mode::Today,
        }
    }
    fn groups(self) -> bool {
        matches!(self, Mode::Groups | Mode::GroupsSoft)
    }
}

/// Spike #60: a hills curve (`KOMPASS_SPIKE_HILLS="pts=-15:2,0:1,6:1.3,10:2;loose=20"`): cost per
/// metre relative to flat against signed grade (%), linear in grade and in log factor between the
/// handles, flat beyond the ends; `loose`: on gravel, soft and other loose ground grades count that
/// many percent steeper. Replaces `climb`, `steep` and the ramps; an additive term per arc.
#[derive(Debug, Clone, PartialEq)]
pub struct Hills {
    pub pts: Vec<(f32, f32)>,
    pub loose: f32,
    /// The curve every 0.1 % from −40 to +40 %.
    table: Vec<f32>,
}

impl Hills {
    fn from_env() -> Option<Hills> {
        let spec = std::env::var("KOMPASS_SPIKE_HILLS").ok()?;
        let mut h = Hills {
            pts: Vec::new(),
            loose: 0.0,
            table: Vec::new(),
        };
        for part in spec.split(';') {
            if let Some(p) = part.strip_prefix("pts=") {
                for kv in p.split(',') {
                    let (g, c) = kv.split_once(':')?;
                    h.pts.push((g.parse().ok()?, c.parse().ok()?));
                }
            } else if let Some(l) = part.strip_prefix("loose=") {
                h.loose = l.parse().ok()?;
            }
        }
        h.pts.sort_by(|a, b| a.0.total_cmp(&b.0));
        if h.pts.is_empty() {
            return None;
        }
        #[allow(clippy::cast_precision_loss, reason = "801 steps")]
        let table = (0..=800).map(|i| h.exact(i as f32 * 0.1 - 40.0)).collect();
        h.table = table;
        Some(h)
    }

    /// The curve at a signed grade (%), from the table.
    #[must_use]
    #[inline]
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a table index"
    )]
    pub fn at(&self, g: f32) -> f32 {
        let x = ((g.clamp(-40.0, 40.0) + 40.0) * 10.0) as usize;
        self.table[x.min(800)]
    }

    /// The curve at a signed grade (%), exactly.
    fn exact(&self, g: f32) -> f32 {
        let p = &self.pts;
        if g <= p[0].0 {
            return p[0].1;
        }
        for w in p.windows(2) {
            let ((g0, c0), (g1, c1)) = (w[0], w[1]);
            if g <= g1 {
                let t = (g - g0) / (g1 - g0).max(1e-6);
                return (c0.ln() + t * (c1.ln() - c0.ln())).exp();
            }
        }
        p[p.len() - 1].1
    }

    /// The arc's hills factor: 50 m at the steeper of its tamed steepest grades (up or down), the
    /// rest split into climbing and descending by the effective ascent and descent (spike #60's
    /// "split + steepest 50 m").
    #[allow(clippy::too_many_arguments, reason = "an arc's grade data")]
    fn arc(&self, len: f32, up_max: f32, down_max: f32, asc_m: f32, desc_m: f32, loose: bool) -> f32 {
        let k = if loose { 1.0 + self.loose / 100.0 } else { 1.0 };
        let len = len.max(1.0);
        let w = (50.0 / len).min(1.0);
        let (cu, cd) = (self.at(up_max * k), self.at(-down_max * k));
        let up_wall = cu >= cd;
        let wall = if up_wall { cu } else { cd };
        let a2 = (asc_m - if up_wall { w * len * up_max / 100.0 } else { 0.0 }).max(0.0);
        let d2 = (desc_m - if up_wall { 0.0 } else { w * len * down_max / 100.0 }).max(0.0);
        let tot = a2 + d2;
        let rest = if tot < 1e-3 || w >= 1.0 {
            self.at(0.0)
        } else {
            let us = a2 / tot;
            let g = tot / (len * (1.0 - w)) * 100.0 * k;
            us * self.at(g) + (1.0 - us) * self.at(-g)
        };
        w * wall + (1.0 - w) * rest
    }
}

/// The catalogue group of a preference, as an index.
#[inline]
fn group_ix(id: PrefId) -> usize {
    pref_meta(id).group as usize
}

/// The products of an edge's factors, per [`Mode`]: today straight products; in the group modes
/// one factor per catalogue group (its strongest bonus × its strongest penalty).
#[derive(Debug, Clone, Copy)]
struct Acc {
    groups: bool,
    q: f32,
    bonus: f32,
    gb: [f32; 8],
    gp: [f32; 8],
    ggb: [f32; 8],
}

impl Acc {
    fn new(groups: bool) -> Acc {
        Acc {
            groups,
            q: 1.0,
            bonus: 1.0,
            gb: [1.0; 8],
            gp: [1.0; 8],
            ggb: [1.0; 8],
        }
    }
    #[inline]
    fn quality(&mut self, id: PrefId, f: f32) {
        if !self.groups {
            self.q *= f;
            return;
        }
        let g = group_ix(id);
        if f < 1.0 {
            self.gb[g] = self.gb[g].min(f);
        } else {
            self.gp[g] = self.gp[g].max(f);
        }
    }
    #[inline]
    fn gated(&mut self, id: PrefId, f: f32) {
        if f < 1.0 {
            if self.groups {
                let g = group_ix(id);
                self.ggb[g] = self.ggb[g].min(f);
            } else {
                self.bonus *= f;
            }
        } else {
            self.quality(id, f);
        }
    }
    fn finish(&self) -> (f32, f32) {
        if !self.groups {
            return (self.q, self.bonus);
        }
        let mut q = self.q;
        let mut b = self.bonus;
        for i in 0..8 {
            q *= self.gb[i] * self.gp[i];
            b *= self.ggb[i];
        }
        (q, b)
    }
}

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
    /// The traffic level of the roads within 20 m, fifteenths.
    pub near_traffic: u8,
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
        let (surf, smooth, access, road, speed, diff, ctx, ctx2, ctx3) = (
            c.surf[e],
            c.smooth[e],
            c.access[e],
            c.road[e],
            c.speed[e],
            c.diff[e],
            c.ctx[e],
            c.ctx2[e],
            c.ctx3[e],
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
            near_traffic: ctx3 & 15,
            length: crate::attrs::length_m_of(c.length_dm[e]),
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
        let (open, town) = crate::traffic::guess_kmh(self.hw);
        if self.built > HALF { town } else { open }
    }

    /// 0..=1: how much motor traffic riding the way itself means ([`crate::traffic::own_level`]).
    #[inline]
    pub(crate) fn traffic(&self) -> f32 {
        crate::traffic::own_level(
            self.hw,
            self.kmh,
            self.lanes,
            self.motor,
            self.built > HALF,
            self.cyc,
        )
    }

    /// 0..=1: the traffic the way gets from the roads within 20 m ([`crate::traffic::alongside`]).
    #[inline]
    pub(crate) fn alongside(&self) -> f32 {
        crate::traffic::alongside(share(self.near_traffic), share(self.road_near))
    }

    /// 0..=1: what `quiet` penalises, the louder of the way's own traffic and the traffic beside it.
    #[inline]
    pub(crate) fn exposure(&self) -> f32 {
        self.traffic().max(self.alongside())
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

/// The tamed steepest grade of an arc up and down (percent): what the grade preferences and
/// `max_grade` see.
#[must_use]
pub fn arc_grade_pct(g: &Graph, a: crate::ArcId) -> (f32, f32) {
    let c = g.edge_columns();
    let e = arc_edge(a) as usize;
    let v = View::decode(c, e);
    let fwd = tamed_grade(c.grade_fwd[e], c.ascent_fwd_dm[e], v.length, v.forest);
    let bwd = tamed_grade(c.grade_bwd[e], c.ascent_bwd_dm[e], v.length, v.forest);
    if arc_is_reverse(a) { (bwd, fwd) } else { (fwd, bwd) }
}

/// Which of `ids` apply to an arc at all (membership ≠ 0, whatever their weight), handed to `hit`:
/// what a route's `breakdown.touched` adds up. The membership is the cost's, per kind as in
/// [`CostModel::breakdown`]: the grade ramps on the tamed grades, `climb` on the ascent beyond the
/// deadband in the arc's direction, the rest through [`membership`].
pub fn touches(
    g: &Graph,
    personal: Option<&PersonalLayer>,
    a: crate::ArcId,
    ids: &[PrefId],
    mut hit: impl FnMut(PrefId),
) {
    let c = g.edge_columns();
    let e = arc_edge(a) as usize;
    let dir = usize::from(arc_is_reverse(a));
    let v = View::decode(c, e);
    let surface = v.surface();
    #[allow(clippy::cast_possible_truncation, reason = "edge ids fit u32")]
    let pe = personal
        .filter(|p| p.fits(g.edge_count()))
        .map(|p| (p, e as EdgeId));
    let asc = [c.ascent_fwd_dm[e], c.ascent_bwd_dm[e]];
    let grade = [
        tamed_grade(c.grade_fwd[e], asc[0], v.length, v.forest),
        tamed_grade(c.grade_bwd[e], asc[1], v.length, v.forest),
    ];
    for &id in ids {
        let m = if let Some(r) = grade_ramp(id) {
            r.level(grade[dir], grade[1 - dir])
        } else if id == PrefId::Climb {
            lv(effective_ascent(asc[dir], v.length, v.forest) / v.length.max(1.0) / CLIMB_FULL_GRADE)
        } else {
            membership(id, &v, surface, pe)
        };
        if m != 0 {
            hit(id);
        }
    }
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
        // seeking quiet is avoiding traffic: the membership is the traffic, negated (the class
        // compile takes the two parts apart: `lv(−max(a, b)) = min(lv(−a), lv(−b))`)
        PrefId::Quiet => lv(-v.exposure()),
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
        PrefId::Climb
        | PrefId::Steep
        | PrefId::RampsOver6
        | PrefId::RampsOver8
        | PrefId::RampsOver10
        | PrefId::RampsOver12
        | PrefId::RampsOver15 => 0,
    }
}

/// How a grade preference matches an arc: 0 up to `from_pct` of tamed grade uphill, rising linearly
/// to 1 at `full_pct`; a descent counts at `downhill` times that rate (so it reaches 1 later). The
/// arc's membership is the larger of the two.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GradeRamp {
    pub from_pct: f32,
    pub full_pct: f32,
    pub downhill: f32,
}

impl GradeRamp {
    /// The membership level at a tamed grade up and down.
    #[inline]
    fn level(self, up: f32, down: f32) -> i8 {
        let span = self.full_pct - self.from_pct;
        let up = (up - self.from_pct) / span;
        let down = self.downhill * (down - self.from_pct) / span;
        lv(up.max(down).clamp(0.0, 1.0))
    }
}

/// The ramp of a grade preference (`steep` and the "steeper than X %" family), `None` for the
/// others. `steep` is the gentle one (8 → 16 %); the family's ramps are 3 points wide, so a
/// threshold has no cliff but still means what it says.
#[must_use]
pub fn grade_ramp(id: PrefId) -> Option<GradeRamp> {
    let r = |from_pct: f32, full_pct: f32| {
        Some(GradeRamp {
            from_pct,
            full_pct,
            downhill: 0.5,
        })
    };
    match id {
        PrefId::Steep => r(8.0, 16.0),
        PrefId::RampsOver6 => r(6.0, 9.0),
        PrefId::RampsOver8 => r(8.0, 11.0),
        PrefId::RampsOver10 => r(10.0, 13.0),
        PrefId::RampsOver12 => r(12.0, 15.0),
        PrefId::RampsOver15 => r(15.0, 18.0),
        _ => None,
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
    /// `quiet` (quality), apart: its membership reads the tags (the way's own traffic) and the
    /// context (the roads beside it), which the class compile looks up separately.
    quiet: Option<Table>,
    /// The grade preferences (quality, directional): `steep` and the "steeper than X %" family.
    grades: Vec<(PrefId, GradeRamp, Table)>,
    /// Seeking climbs (gated, directional).
    climb_bonus: Option<Table>,
    /// Avoiding climbs: metres per metre of effective ascent.
    climb_cost: f32,
    limits: Limits,
    pub min_factor: f32,
    pub max_factor: f32,
    /// Spike #60.
    pub mode: Mode,
    pub hills: Option<Hills>,
    /// `Mode::Norm`'s exponent, set by the compile.
    pub gamma: std::cell::Cell<f32>,
}

/// One arc's factor and what the gate and the leverage need.
#[derive(Debug, Clone, Copy)]
struct ArcF {
    f: f32,
    raw: f32,
    q: f32,
    bonus: f32,
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

/// How a preference enters an arc's factor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, ts_rs::TS))]
pub enum Role {
    /// Multiplies into the quality product.
    Quality,
    /// A gated preference whose factor here is a penalty (> 1): it counts like quality.
    GatedPenalty,
    /// A gated preference whose factor here is a bonus (≤ 1): it counts through the gate.
    GatedBonus,
    /// Avoiding climbs: no factor, metres of cost per metre of ascent (the `climb` additive term).
    Additive,
}

/// One preference's part in an arc's cost.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Term {
    pub id: PrefId,
    /// How much the way is what the preference names, −1..=1, as the cost quantises it
    /// (fifteenths). Climbing: the average grade beyond the deadband over its full grade.
    pub membership: f32,
    /// The preference's factor at the profile's weight (1: no effect).
    pub factor: f32,
    pub role: Role,
}

/// Which bound the clamp applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, ts_rs::TS))]
pub enum Clamp {
    /// Raised to `bounds.min_factor` (the detour budget).
    Min,
    /// Lowered to `bounds.max_factor`.
    Max,
}

/// An arc's cost, every step of it: what [`CostModel::compile_into`] computes, kept apart. The
/// explanations of the API ([`crate::explain`]) are built from it.
#[derive(Debug, Clone, PartialEq)]
pub struct ArcBreakdown {
    /// Every active preference (weight ≠ 0), catalogue order.
    pub terms: Vec<Term>,
    /// The product of the quality factors, the gated penalties and the ramps.
    pub quality: f32,
    /// The product of the gated bonuses.
    pub bonus: f32,
    /// How much of the bonus counts, 0..=1 (1 up to quality `GATE_OK`, 0 from `GATE_BAD`).
    pub gate: f32,
    /// `quality × (1 + (bonus − 1) × gate)`, before the clamp.
    pub raw: f32,
    /// After the clamp.
    pub factor: f32,
    pub clamp: Option<Clamp>,
    /// Ascent beyond the deadband (metres) and the tamed steepest grade up and down (percent).
    pub ascent_m: f32,
    pub grade_up_pct: f32,
    pub grade_down_pct: f32,
    /// Additive metres: avoiding climbs, then barriers, steps, dismount, ferry.
    pub climb_m: f32,
    pub penalties_m: [f32; 4],
    /// Everything that closes the arc: the limits and rules of the edge in order, then one-way.
    pub exclusions: Vec<Exclusion>,
}

impl ArcBreakdown {
    /// The additive metres in all.
    #[must_use]
    pub fn extra_m(&self) -> f32 {
        let [b, s, d, f] = self.penalties_m;
        b + s + d + f + self.climb_m
    }
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
            quiet: None,
            grades: Vec::new(),
            climb_bonus: None,
            climb_cost: 0.0,
            limits: Limits::default(),
            min_factor: std::env::var("KOMPASS_SPIKE_MIN")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(p.bounds().min_factor),
            max_factor: p.bounds().max_factor,
            mode: Mode::from_env(),
            hills: Hills::from_env(),
            gamma: std::cell::Cell::new(1.0),
        };
        for (&id, w) in &p.weights {
            let w = w.unit();
            if w == 0.0 {
                continue;
            }
            if m.hills.is_some() && (id == PrefId::Climb || grade_ramp(id).is_some()) {
                continue;
            }
            if let Some(r) = grade_ramp(id) {
                m.grades.push((id, r, table(id, w)));
                continue;
            }
            match id {
                PrefId::Quiet => m.quiet = Some(table(id, w)),
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

    /// The limit (or rule) that excludes an edge in both directions, if any: the first of
    /// [`CostModel::exclusions`].
    #[inline]
    fn excluded(
        &self,
        v: &View,
        surface: (u8, Confidence),
        grade_up: f32,
        grade_down: f32,
    ) -> Option<Exclusion> {
        let mut first = None;
        self.exclusions(v, surface, grade_up, grade_down, |x| {
            first = Some(x);
            true
        });
        first
    }

    /// Every limit (or rule) that excludes an edge in both directions, in a fixed order, handed to
    /// `hit` until it returns `true` (stop). The one place the limits are decided.
    #[inline]
    fn exclusions(
        &self,
        v: &View,
        (s, conf): (u8, Confidence),
        grade_up: f32,
        grade_down: f32,
        mut hit: impl FnMut(Exclusion) -> bool,
    ) {
        let l = &self.limits;
        if v.bike == ba::NO && hit(Exclusion::NoBikes) {
            return;
        }
        if l.no_main && v.is_main() && v.cyc != 3 && hit(Exclusion::Limit(LimitId::NoMainRoads)) {
            return;
        }
        if l.paved_only
            && (!matches!(s, sc::PAVED | sc::ROUGH) || conf == Confidence::Weak)
            && hit(Exclusion::Limit(LimitId::PavedOnly))
        {
            return;
        }
        if l.no_unknown && conf == Confidence::Weak && hit(Exclusion::Limit(LimitId::NoUnknownSurface)) {
            return;
        }
        if let Some(max) = l.max_grade
            && grade_up.max(grade_down) > max
            && hit(Exclusion::Limit(LimitId::MaxGrade))
        {
            return;
        }
        if let Some(max) = l.max_mtb
            && v.difficulty().is_some_and(|d| d > max)
            && hit(Exclusion::Limit(LimitId::MaxMtbScale))
        {
            return;
        }
        if l.no_stairs
            && (v.hw == hw::STEPS || v.sac >= 3 || v.mtb >= 5)
            && hit(Exclusion::Limit(LimitId::NoStairs))
        {
            return;
        }
        if l.legal_only
            && matches!(v.bike, ba::USE_SIDEPATH | ba::FOOT_ONLY | ba::AGRI | ba::PRIVATE)
            && hit(Exclusion::Limit(LimitId::LegalOnly))
        {
            return;
        }
        if l.no_ferries && v.hw == hw::FERRY {
            hit(Exclusion::Limit(LimitId::NoFerries));
        }
    }

    /// Fixed additive metres of an edge (barriers, steps, dismount, ferry).
    #[inline]
    fn penalty_m(v: &View) -> f32 {
        let [barriers, steps, dismount, ferry] = Self::penalty_parts(v);
        // in the order `compile_into` adds them
        let mut add = barriers;
        if v.hw == hw::STEPS {
            add += steps;
        }
        if v.bike == ba::DISMOUNT {
            add += dismount;
        }
        if v.hw == hw::FERRY {
            add += ferry;
        }
        add
    }

    /// The fixed additive metres one by one: barriers, steps, dismount, ferry.
    #[inline]
    fn penalty_parts(v: &View) -> [f32; 4] {
        [
            f32::from(v.barriers) * BARRIER_M,
            if v.hw == hw::STEPS {
                v.length * STEPS_PER_M + STEPS_EACH_M
            } else {
                0.0
            },
            if v.bike == ba::DISMOUNT {
                v.length * DISMOUNT_PER_M
            } else {
                0.0
            },
            if v.hw == hw::FERRY { FERRY_M } else { 0.0 },
        ]
    }

    /// The gate: how much of the gated bonuses count at a quality factor.
    #[inline]
    fn gate(q: f32) -> f32 {
        ((GATE_BAD - q) / (GATE_BAD - GATE_OK)).clamp(0.0, 1.0)
    }

    /// Compiles every arc's cost into `out` (resized; no other allocation). Returns the smallest
    /// factor produced (the A* bound per metre).
    pub fn compile_into(&self, g: &Graph, personal: Option<&PersonalLayer>, out: &mut Vec<f32>) -> f32 {
        if self.mode == Mode::Norm {
            self.gamma.set(1.0);
            let (_, min_raw) = self.compile_pass(g, personal, out, true);
            let gamma = if min_raw < self.min_factor && min_raw > 0.0 {
                self.min_factor.ln() / min_raw.ln()
            } else {
                1.0
            };
            self.gamma.set(gamma);
        }
        self.compile_pass(g, personal, out, false).0
    }

    /// The products (quality, bonus) of an edge's direction-independent preferences.
    #[inline]
    fn edge_products(
        &self,
        v: &View,
        surface: (u8, Confidence),
        pe: Option<(&PersonalLayer, EdgeId)>,
    ) -> Acc {
        let mut acc = Acc::new(self.mode.groups());
        for (id, t) in &self.quality {
            acc.quality(*id, at(t, membership(*id, v, surface, pe)));
        }
        if let Some(t) = &self.quiet {
            acc.quality(PrefId::Quiet, at(t, membership(PrefId::Quiet, v, surface, pe)));
        }
        for (id, t) in &self.gated {
            acc.gated(*id, at(t, membership(*id, v, surface, pe)));
        }
        acc
    }

    /// Whether the surface counts as loose ground (the hills curve's modifier).
    fn loose(surface: (u8, Confidence)) -> bool {
        matches!(surface.0, sc::GRAVEL | sc::SOFT | sc::OTHER)
    }

    /// The hills curve's additive metres on an arc (negative where it seeks, through the gate).
    #[allow(clippy::too_many_arguments, reason = "an arc's grade data")]
    fn hills_m(
        &self,
        len: f32,
        forest: u8,
        grade: [f32; 2],
        asc: [u16; 2],
        dir: usize,
        surface: (u8, Confidence),
        q: f32,
    ) -> f32 {
        let Some(h) = &self.hills else { return 0.0 };
        let a = effective_ascent(asc[dir], len, forest);
        let d = effective_ascent(asc[1 - dir], len, forest);
        let c = h.arc(len, grade[dir], grade[1 - dir], a, d, Self::loose(surface));
        let x = len * (c - 1.0);
        if x < 0.0 { x * Self::gate(q) } else { x }
    }

    #[allow(clippy::cast_possible_truncation, reason = "edge ids fit u32")]
    fn compile_pass(
        &self,
        g: &Graph,
        personal: Option<&PersonalLayer>,
        out: &mut Vec<f32>,
        raw_only: bool,
    ) -> (f32, f32) {
        let c = g.edge_columns();
        let m = g.edge_count();
        out.clear();
        out.resize(m * 2, f32::INFINITY);
        let personal = personal.filter(|p| p.fits(m));
        let need_grade = !self.grades.is_empty() || self.limits.max_grade.is_some() || self.hills.is_some();
        let mut min_seen = f32::INFINITY;
        let mut min_raw = f32::INFINITY;
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
            let acc = self.edge_products(&v, surface, pe);
            let penalty = Self::penalty_m(&v);
            let oneway = crate::attrs::oneway_of(c.surf[e]);
            for dir in 0..2 {
                if !oneway.allows(dir == 1) {
                    continue;
                }
                let af = self.arc_factor(v.length, v.forest, acc, grade[dir], grade[1 - dir], asc[dir]);
                min_raw = min_raw.min(af.raw);
                if raw_only {
                    continue;
                }
                let climb = if self.climb_cost > 0.0 {
                    self.climb_cost * effective_ascent(asc[dir], v.length, v.forest)
                } else {
                    0.0
                };
                let hills = self.hills_m(v.length, v.forest, grade, asc, dir, surface, af.q);
                min_seen = min_seen.min(af.f + hills.min(0.0) / v.length.max(1.0));
                out[e * 2 + dir] = (v.length * af.f + penalty + climb + hills).max(0.01 * v.length);
            }
        }
        (
            if min_seen.is_finite() {
                min_seen.max(0.01)
            } else {
                self.min_factor
            },
            min_raw,
        )
    }

    /// The factor after the floor: per [`Mode`].
    #[inline]
    fn finish(&self, raw: f32) -> f32 {
        match self.mode {
            Mode::Soft | Mode::GroupsSoft if raw < 1.0 => {
                let l = -self.min_factor.ln();
                let k = l * 0.5;
                let x = -raw.ln();
                if x <= k {
                    raw
                } else {
                    (-(k + (l - k) * ((x - k) / (l - k)).tanh())).exp()
                }
            }
            Mode::Norm if raw < 1.0 => raw.powf(self.gamma.get()).clamp(self.min_factor, self.max_factor),
            _ => raw.clamp(self.min_factor, self.max_factor),
        }
    }

    /// How much of a change in the product reaches the factor at `raw` (1 unclamped, 0 on a hard
    /// clamp): d ln f / d ln raw, by a small step.
    #[must_use]
    pub fn leverage(&self, raw: f32) -> f32 {
        let a = self.finish(raw);
        let b = self.finish(raw * 0.995);
        (a.ln() - b.ln()) / -(0.995f32.ln())
    }

    /// The factor of an arc from its edge's products.
    #[inline]
    fn arc_factor(
        &self,
        len: f32,
        forest: u8,
        acc: Acc,
        grade_up: f32,
        grade_down: f32,
        ascent_dm: u16,
    ) -> ArcF {
        let (mut q, mut bonus) = acc.finish();
        if self.mode.groups() {
            let (mut b, mut p) = (1.0f32, 1.0f32);
            for (_, r, t) in &self.grades {
                let f = at(t, r.level(grade_up, grade_down));
                if f < 1.0 {
                    b = b.min(f);
                } else {
                    p = p.max(f);
                }
            }
            q *= b * p;
        } else {
            for (_, r, t) in &self.grades {
                q *= at(t, r.level(grade_up, grade_down));
            }
        }
        if let Some(t) = &self.climb_bonus {
            let rate = effective_ascent(ascent_dm, len, forest) / len.max(1.0);
            bonus *= at(t, lv(rate / CLIMB_FULL_GRADE));
        }
        let raw = q * (1.0 + (bonus - 1.0) * Self::gate(q));
        ArcF {
            f: self.finish(raw),
            raw,
            q,
            bonus,
        }
    }

    /// The cost of one arc, explained (the flat form of [`CostModel::breakdown`]).
    #[must_use]
    pub fn explain(&self, g: &Graph, personal: Option<&PersonalLayer>, a: crate::ArcId) -> ArcCost {
        let b = self.breakdown(g, personal, a);
        let v = View::decode(g.edge_columns(), arc_edge(a) as usize);
        let penalty_m = Self::penalty_m(&v);
        let excluded = b.exclusions.first().copied();
        ArcCost {
            factors: b
                .terms
                .iter()
                .filter(|t| t.role != Role::Additive)
                .map(|t| (t.id, t.factor))
                .collect(),
            gate: b.gate,
            factor: b.factor,
            climb_m: b.climb_m,
            penalty_m,
            cost: if excluded.is_some() {
                f32::INFINITY
            } else {
                v.length * b.factor + penalty_m + b.climb_m
            },
            excluded,
        }
    }

    /// The cost of one arc, every step of it, through the same functions the compile uses
    /// (membership, tables, gate, clamp, additive terms, limits). `length × factor + extra_m()` is
    /// the compiled cost up to float rounding (the compile multiplies in another order); a test
    /// checks that on every arc of the test graphs.
    #[must_use]
    #[allow(clippy::too_many_lines, reason = "the cost's steps, one after the other")]
    pub fn breakdown(&self, g: &Graph, personal: Option<&PersonalLayer>, a: crate::ArcId) -> ArcBreakdown {
        let c = g.edge_columns();
        let e = arc_edge(a) as usize;
        let dir = usize::from(arc_is_reverse(a));
        let v = View::decode(c, e);
        let surface = v.surface();
        let personal = personal.filter(|p| p.fits(g.edge_count()));
        #[allow(clippy::cast_possible_truncation, reason = "edge ids fit u32")]
        let pe = personal.map(|p| (p, e as EdgeId));
        let asc = [c.ascent_fwd_dm[e], c.ascent_bwd_dm[e]];
        let grade = [
            tamed_grade(c.grade_fwd[e], asc[0], v.length, v.forest),
            tamed_grade(c.grade_bwd[e], asc[1], v.length, v.forest),
        ];
        let level = |m: i8| f32::from(m) / 15.0;
        let mut terms = Vec::new();
        let mut q = 1.0f32;
        let mut bonus = 1.0f32;
        let acc = self.edge_products(&v, surface, pe);
        for (id, t) in &self.quality {
            let m = membership(*id, &v, surface, pe);
            let f = at(t, m);
            q *= f;
            terms.push(Term {
                id: *id,
                membership: level(m),
                factor: f,
                role: Role::Quality,
            });
        }
        if let Some(t) = &self.quiet {
            let m = membership(PrefId::Quiet, &v, surface, pe);
            let f = at(t, m);
            q *= f;
            terms.push(Term {
                id: PrefId::Quiet,
                membership: level(m),
                factor: f,
                role: Role::Quality,
            });
        }
        for (id, t) in &self.gated {
            let m = membership(*id, &v, surface, pe);
            let f = at(t, m);
            // as the compile: a bonus (< 1) through the gate, else into quality (1 is either)
            if f < 1.0 {
                bonus *= f;
            } else {
                q *= f;
            }
            let role = if f > 1.0 {
                Role::GatedPenalty
            } else {
                Role::GatedBonus
            };
            terms.push(Term {
                id: *id,
                membership: level(m),
                factor: f,
                role,
            });
        }
        // the directional ones, as in `arc_factor`
        for (id, r, t) in &self.grades {
            let m = r.level(grade[dir], grade[1 - dir]);
            let f = at(t, m);
            q *= f;
            terms.push(Term {
                id: *id,
                membership: level(m),
                factor: f,
                role: Role::Quality,
            });
        }
        let ascent_m = effective_ascent(asc[dir], v.length, v.forest);
        let rate = ascent_m / v.length.max(1.0);
        if let Some(t) = &self.climb_bonus {
            let m = lv(rate / CLIMB_FULL_GRADE);
            let f = at(t, m);
            bonus *= f;
            terms.push(Term {
                id: PrefId::Climb,
                membership: level(m),
                factor: f,
                role: Role::GatedBonus,
            });
        } else if self.climb_cost > 0.0 {
            terms.push(Term {
                id: PrefId::Climb,
                membership: level(lv(rate / CLIMB_FULL_GRADE)),
                factor: 1.0,
                role: Role::Additive,
            });
        }
        terms.sort_by_key(|t| t.id.index());
        // spike #60: the model's own products (the terms above stay per preference)
        let af = self.arc_factor(v.length, v.forest, acc, grade[dir], grade[1 - dir], asc[dir]);
        let _ = (q, bonus);
        let (q, bonus) = (af.q, af.bonus);
        let gate = Self::gate(q);
        let raw = af.raw;
        let factor = af.f;
        let clamp = if raw > self.max_factor {
            Some(Clamp::Max)
        } else if match self.mode {
            Mode::Today | Mode::Groups => raw < self.min_factor,
            _ => raw < 1.0 && self.leverage(raw) < 0.5,
        } {
            Some(Clamp::Min)
        } else {
            None
        };
        let mut exclusions = Vec::new();
        self.exclusions(&v, surface, grade[0], grade[1], |x| {
            exclusions.push(x);
            false
        });
        if !crate::attrs::oneway_of(c.surf[e]).allows(dir == 1) {
            exclusions.push(Exclusion::Oneway);
        }
        ArcBreakdown {
            terms,
            quality: q,
            bonus,
            gate,
            raw,
            factor,
            clamp,
            ascent_m,
            grade_up_pct: grade[dir],
            grade_down_pct: grade[1 - dir],
            climb_m: if self.climb_cost > 0.0 {
                self.climb_cost * ascent_m
            } else {
                0.0
            } + self.hills_m(v.length, v.forest, grade, asc, dir, surface, af.q),
            penalties_m: Self::penalty_parts(&v),
            exclusions,
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
    /// `quiet`'s membership level of the traffic beside a way, by road-near | near traffic << 4.
    alongside: [i8; 256],
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
    near_traffic: 0,
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
            alongside: [0; 256],
        };
        for i in 0..256usize {
            let lo = (i & 15) as u8;
            t.alongside[i] = membership(
                PrefId::Quiet,
                &View {
                    road_near: lo,
                    near_traffic: (i >> 4) as u8,
                    ..ZERO_VIEW
                },
                (0, Confidence::Tagged),
                None,
            );
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
        if !classes.fits(m) || self.mode != Mode::Today || self.hills.is_some() {
            return self.compile_into(g, personal, out);
        }
        let personal = personal.filter(|p| p.fits(m));
        // per tag class: (quality, bonus, `quiet`'s level of the way's own traffic); quality infinite
        // when a limit excludes it
        let tags: Vec<(f32, f32, i8)> = classes
            .rep
            .iter()
            .map(|&r| {
                let v = View::decode(c, r as usize);
                let surface = v.surface();
                if self.excluded(&v, surface, 0.0, 0.0).is_some() {
                    return (f32::INFINITY, 1.0, 0);
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
                // the own part only: a context-free view of the class (the tags it is keyed by)
                let own = View {
                    road_near: 0,
                    near_traffic: 0,
                    ..v
                };
                (q, bonus, membership(PrefId::Quiet, &own, surface, None))
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
        let need_grade = !self.grades.is_empty() || self.limits.max_grade.is_some();
        let per_arc = need_grade || self.climb_bonus.is_some() || self.climb_cost > 0.0;
        out.clear();
        out.resize(m * 2, f32::INFINITY);
        let mut min_seen = f32::INFINITY;
        for (e, pair) in out.as_chunks_mut::<2>().0.iter_mut().enumerate() {
            let (tq, tb, quiet_own) = tags[usize::from(classes.tag[e])];
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
            if let Some(t) = &self.quiet {
                let along = ct.alongside[road_near | usize::from(c.ctx3[e] & 15) << 4];
                q *= at(t, quiet_own.min(along));
            }
            let len = crate::attrs::length_m_of(c.length_dm[e]);
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
                let mut acc = Acc::new(false);
                acc.q = q;
                acc.bonus = bonus;
                let f = self
                    .arc_factor(len, forest, acc, grade[dir], grade[1 - dir], asc[dir])
                    .f;
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

/// The surface class the cost uses for an edge and how sure it is.
#[must_use]
pub(crate) fn cost_surface(g: &Graph, e: EdgeId) -> (SurfaceClass, Confidence) {
    let (s, conf) = View::decode(g.edge_columns(), e as usize).surface();
    (SurfaceClass::from_code(s).unwrap_or_default(), conf)
}

/// The traffic level `quiet` penalises on an edge, 0..=1, and whether it is the traffic of the
/// roads beside it (louder than the way's own).
#[must_use]
pub(crate) fn traffic_level(g: &Graph, e: EdgeId) -> (f32, bool) {
    let v = View::decode(g.edge_columns(), e as usize);
    let (own, along) = (v.traffic(), v.alongside());
    (own.max(along), along > own)
}

impl CostModel {
    /// The additive metres of an arc (climbing, barriers, steps, dismount, ferry), as the compile
    /// adds them.
    #[must_use]
    pub(crate) fn extra_m(&self, g: &Graph, a: crate::ArcId) -> f32 {
        let c = g.edge_columns();
        let e = arc_edge(a) as usize;
        let v = View::decode(c, e);
        let climb = if self.climb_cost > 0.0 {
            let dm = if arc_is_reverse(a) {
                c.ascent_bwd_dm[e]
            } else {
                c.ascent_fwd_dm[e]
            };
            self.climb_cost * effective_ascent(dm, v.length, v.forest)
        } else {
            0.0
        };
        let hills = if self.hills.is_some() {
            let b = self.breakdown(g, None, a);
            b.climb_m
                - if self.climb_cost > 0.0 {
                    self.climb_cost * b.ascent_m
                } else {
                    0.0
                }
        } else {
            0.0
        };
        Self::penalty_m(&v) + climb + hills
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

/// Seconds to ride a fraction of an arc: a rough model, a speed by surface (slower on narrow
/// paths, walking on `dismount`, carrying on steps, faster downhill) plus time per metre climbed.
#[must_use]
pub fn arc_seconds(g: &Graph, a: crate::ArcId, fraction: f32) -> f32 {
    let c = g.edge_columns();
    let e = arc_edge(a) as usize;
    let v = View::decode(c, e);
    let (s, _) = v.surface();
    let mut kmh = match s {
        sc::PAVED => 22.0,
        sc::ROUGH => 16.0,
        sc::COMPACTED => 19.0,
        sc::GRAVEL => 17.0,
        sc::SOFT => 12.0,
        _ => 14.0,
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
    let mut secs = len / (kmh / 3.6) + climb * 3600.0 / CLIMB_M_PER_H;
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

/// Spike #60: the arc's ascent before the deadband, metres.
#[must_use]
pub fn arc_raw_ascent_m(g: &Graph, a: crate::ArcId) -> f32 {
    let c = g.edge_columns();
    let e = arc_edge(a) as usize;
    let dm = if arc_is_reverse(a) {
        c.ascent_bwd_dm[e]
    } else {
        c.ascent_fwd_dm[e]
    };
    f32::from(dm) * 0.1
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
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
