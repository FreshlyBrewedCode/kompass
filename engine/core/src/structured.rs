//! The structured controls (#66, a prototype behind a switch; `docs/profile.md`, "The structured
//! model"): tier boards for surfaces and way types, a hills curve with a loose-ground modifier, and
//! `detours` as the spread of the relative factors. Spike #60's recommendation, built:
//!
//! ```text
//! cost(arc) = length × min(relative^detours, max_factor) + length × (hills(arc) − 1) + fixed costs
//! relative  = Π boards tier(row) × Π groups (strongest bonus × strongest penalty) / best
//! ```
//!
//! Every way is in exactly one row of each board and gets one factor per board (love 1, like 1.15,
//! fine 1.35, dislike 2; avoid closes it like a limit). The slider preferences that remain combine
//! within their catalogue group, so overlapping ones do not stack. Everything is relative to the
//! profile's best (`best`: the boards at love, every group at its strongest bonus), so there is no
//! floor: the best a way can be is 1. The gated bonuses read the gate on the absolute quality
//! (boards as `tier / fine`, fine being neutral), with today's thresholds.
//!
//! The hills curve is evaluated per arc as "split + steepest 50 m" from the four grade numbers an
//! arc carries (spike #60: within 15 % of a 10 m histogram on 95 % of the length): 50 m at the
//! steeper of the tamed steepest grades up and down, the rest split into a climbing and a
//! descending part by the ascent and descent beyond the deadband. Its metres are outside the factor
//! product, so they never saturate; below 1 (seeking climbs) they count through the gate.
//!
//! Here: the curve, the API parts of an explanation, the catalogue's description of the controls,
//! the named curves, and [`to_structured`], the pure conversion of a slider profile.

use serde::{Deserialize, Serialize};

#[cfg(feature = "schema")]
use ts_rs::TS;

use crate::catalogue::{BoundRange, Group};
use crate::cost::{self, Confidence, View, ZERO_VIEW, hw, sc};
use crate::profile::{
    BoardId, BoardRow, Boards, DETOURS_DEFAULT, DETOURS_RANGE, DownHandles, Hills, LimitId, PrefId, Profile,
    REPLACED_BY_HILLS, TIER_FINE, Tier, UpHandles, limits_replaced_by_board, replaced_by_board,
};
use crate::route::Reason;

/// The curve's grades beyond which it stays flat (the DEM's grades beyond are mostly canopy).
pub const FLAT_BEYOND_PCT: f32 = 15.0;
/// The table's range and resolution.
const TABLE_PCT: f32 = 20.0;
const TABLE_STEP: f32 = 0.1;
/// The wall: the steepest 50 m of an arc.
const WALL_M: f32 = 50.0;

/// A hills curve prepared for the compile: the cost of a metre against its signed grade, linear in
/// grade and in log value between the handles (−15, −8, 0 pinned at 1, 3, 6, 10, 15 %), flat beyond
/// ±15 %, tabulated every 0.1 %.
#[derive(Debug, Clone, PartialEq)]
pub struct Curve {
    table: Vec<f32>,
}

/// The descending handles of a curve: given, or a descent counting like a climb of half its grade
/// (at least 1).
#[must_use]
pub fn down_handles(h: &Hills) -> DownHandles {
    h.down.unwrap_or_else(|| {
        let up = up_points(h);
        DownHandles {
            at8: interpolate(&up, 4.0).max(1.0),
            at15: interpolate(&up, 7.5).max(1.0),
        }
    })
}

fn up_points(h: &Hills) -> Vec<(f32, f32)> {
    let mut p = vec![(0.0, 1.0)];
    p.extend(Hills::UP_GRADES.iter().copied().zip(h.up_values()));
    p
}

/// Linear in grade and in log value between the points (sorted by grade), flat beyond the ends.
fn interpolate(p: &[(f32, f32)], g: f32) -> f32 {
    let (first, last) = (p[0], p[p.len() - 1]);
    if g <= first.0 {
        return first.1;
    }
    for w in p.windows(2) {
        let ((g0, c0), (g1, c1)) = (w[0], w[1]);
        if g <= g1 {
            let t = (g - g0) / (g1 - g0).max(1e-6);
            return (c0.ln() + t * (c1.ln() - c0.ln())).exp();
        }
    }
    last.1
}

/// The handles of a curve as (signed grade, value) points, grade order, 0 % included.
#[must_use]
pub fn curve_points(h: &Hills) -> Vec<(f32, f32)> {
    let d = down_handles(h);
    let mut p = vec![(-15.0, d.at15), (-8.0, d.at8)];
    p.extend(up_points(h));
    p
}

/// What the curve read on one arc (signed grades in percent as read, loose ground steeper).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HillsSplit {
    /// The arc's mean value: what a metre of it counts relative to flat.
    pub value: f32,
    /// The wall: the steepest 50 m (the whole arc when shorter), up or down, whichever the curve
    /// values furthest from flat.
    pub wall_pct: f32,
    pub wall_m: f32,
    /// The rest's climbing part and descending part (`descent_pct` ≤ 0).
    pub climb_pct: f32,
    pub climb_m: f32,
    pub descent_pct: f32,
    pub descent_m: f32,
}

impl Curve {
    /// Tabulates a validated curve.
    #[must_use]
    pub fn new(h: &Hills) -> Curve {
        let p = curve_points(h);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss,
            reason = "a table of 401 steps"
        )]
        let table = (0..=(2.0 * TABLE_PCT / TABLE_STEP).round() as usize)
            .map(|i| {
                let g = (i as f32 * TABLE_STEP - TABLE_PCT).clamp(-FLAT_BEYOND_PCT, FLAT_BEYOND_PCT);
                interpolate(&p, g)
            })
            .collect();
        Curve { table }
    }

    /// The curve at a signed grade (percent), from the table (nearest 0.1 %).
    #[inline]
    #[must_use]
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a table index"
    )]
    pub fn at(&self, g: f32) -> f32 {
        let x = ((g.clamp(-TABLE_PCT, TABLE_PCT) + TABLE_PCT) / TABLE_STEP + 0.5) as usize;
        self.table[x.min(self.table.len() - 1)]
    }

    /// An arc read as "split + steepest 50 m": `len` metres, its tamed steepest grades along and
    /// against its direction (percent), its ascent and descent beyond the deadband (metres); grades
    /// read `k` times steeper (loose ground).
    #[inline]
    #[must_use]
    pub fn split(&self, len: f32, up_max: f32, down_max: f32, asc_m: f32, desc_m: f32, k: f32) -> HillsSplit {
        let l = len.max(1.0);
        let w = (WALL_M / l).min(1.0);
        let (cu, cd) = (self.at(up_max * k), self.at(-down_max * k));
        // the wall the curve cares most about: the dearer one, or for a curve that seeks climbs the
        // one furthest from flat
        let up_wall = (cu - 1.0).abs() >= (cd - 1.0).abs();
        let (wall, wall_pct) = if up_wall {
            (cu, up_max * k)
        } else {
            (cd, -down_max * k)
        };
        let a2 = (asc_m - if up_wall { w * l * up_max / 100.0 } else { 0.0 }).max(0.0);
        let d2 = (desc_m - if up_wall { 0.0 } else { w * l * down_max / 100.0 }).max(0.0);
        let tot = a2 + d2;
        let rest_m = len * (1.0 - w);
        let (rest, climb_pct, climb_m, descent_pct, descent_m) = if tot < 1e-3 || w >= 1.0 {
            (1.0, 0.0, rest_m, 0.0, 0.0)
        } else {
            let us = a2 / tot;
            let g = tot / (l * (1.0 - w)) * 100.0 * k;
            (
                us * self.at(g) + (1.0 - us) * self.at(-g),
                g,
                rest_m * us,
                -g,
                rest_m * (1.0 - us),
            )
        };
        HillsSplit {
            value: w * wall + (1.0 - w) * rest,
            wall_pct,
            wall_m: len * w,
            climb_pct,
            climb_m,
            descent_pct,
            descent_m,
        }
    }
}

// ---------------------------------------------------------------- the API parts of an explanation

/// A board's part in an arc's cost: the way's row and its tier.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct BoardPart {
    pub board: BoardId,
    pub row: BoardRow,
    pub tier: Tier,
    /// The tier's factor relative to `love` (`avoid`: `dislike`'s, what it counts where this plan
    /// allows it).
    pub factor: f32,
    /// The same relative to `fine` (the neutral tier).
    pub vs_fine: f32,
}

impl BoardPart {
    pub(crate) fn new(row: BoardRow, tier: Tier, factor: f32) -> BoardPart {
        BoardPart {
            board: row.board(),
            row,
            tier,
            factor,
            vs_fine: factor / TIER_FINE,
        }
    }
}

/// A catalogue group's part in an arc's cost (structured model): of its active slider
/// preferences only the strongest bonus and the strongest penalty count (and the strongest gated
/// bonus, through the gate).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct GroupPart {
    pub group: Group,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bonus: Option<Reason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub penalty: Option<Reason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gated_bonus: Option<Reason>,
    /// The best this group can do anywhere (its part of the profile's `best`).
    pub best: f32,
}

/// The hills curve's part in an arc's cost.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct HillsPart {
    /// `length × (value − 1)`, through the gate where < 0 (seeking climbs).
    pub metres: f32,
    /// What a metre of the arc counts relative to flat.
    pub value: f32,
    /// The grades the curve read (percent, signed: < 0 downhill; loose ground steeper) and the
    /// metres at each: the steepest 50 m, the rest's climbing and descending part.
    pub wall_pct: f32,
    pub wall_m: f32,
    pub climb_pct: f32,
    pub climb_m: f32,
    pub descent_pct: f32,
    pub descent_m: f32,
    /// Loose ground (gravel, soft, unusual): its grades read `loose_pct` steeper.
    pub loose: bool,
    pub gate: f32,
}

impl HillsPart {
    pub(crate) fn new(sp: HillsSplit, metres: f32, loose: bool, gate: f32) -> HillsPart {
        HillsPart {
            metres,
            value: sp.value,
            wall_pct: sp.wall_pct,
            wall_m: sp.wall_m,
            climb_pct: sp.climb_pct,
            climb_m: sp.climb_m,
            descent_pct: sp.descent_pct,
            descent_m: sp.descent_m,
            loose,
            gate,
        }
    }
}

/// An arc's cost under the structured model, its parts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct StructuredParts {
    /// The way's row and tier on each board present.
    pub boards: Vec<BoardPart>,
    /// The boards' factors multiplied (relative to `love`).
    pub board_factor: f32,
    /// Per catalogue group with active sliders: what counts.
    pub groups: Vec<GroupPart>,
    /// The profile's best absolute factor (boards at love, every group at its strongest bonus):
    /// `relative = raw_factor / best`.
    pub best: f32,
    /// The factor relative to the best, before the spread: ≥ 1.
    pub relative: f32,
    /// The spread exponent: `factor = min(relative ^ detours, max_factor)`.
    pub detours: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hills: Option<HillsPart>,
}

// ---------------------------------------------------------------- the catalogue's part

/// A row of a board, for the UI.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct RowInfo {
    pub id: BoardRow,
    pub label: &'static str,
    pub hint: &'static str,
    /// Which ways fall in it.
    pub ways: &'static str,
}

/// A board, for the UI.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct BoardInfo {
    pub id: BoardId,
    pub label: &'static str,
    pub hint: &'static str,
    pub rows: Vec<RowInfo>,
    /// The slider preferences and limits it replaces (rejected in a profile that has it).
    pub replaces: Vec<PrefId>,
    pub replaces_limits: Vec<LimitId>,
}

/// A tier, for the UI.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct TierInfo {
    pub id: Tier,
    pub label: &'static str,
    pub hint: &'static str,
    /// A metre's factor relative to `love`; absent for `avoid` (closed: a limit).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub factor: Option<f32>,
}

/// A handle of the hills curve: its grade and the range of its value.
#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct HandleInfo {
    /// Percent, signed (< 0 downhill).
    pub grade_pct: f32,
    pub min: f32,
    pub max: f32,
    pub step: f32,
}

/// A named curve.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct CurvePreset {
    pub id: &'static str,
    pub label: &'static str,
    pub blurb: &'static str,
    pub hills: Hills,
}

/// The hills curve, for the UI.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct HillsInfo {
    pub label: &'static str,
    pub hint: &'static str,
    /// The handles in grade order: `down` (−15, −8), then `up` (3, 6, 10, 15); 0 % is pinned at 1.
    pub handles: Vec<HandleInfo>,
    /// The curve is flat beyond ±this many percent.
    pub flat_beyond_pct: f32,
    pub loose_pct: BoundRange,
    pub loose_label: &'static str,
    pub curves: Vec<CurvePreset>,
    pub replaces: Vec<PrefId>,
}

/// The structured controls (`catalogue().structured`): boards, tiers, the hills curve, detours.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct StructuredInfo {
    pub boards: Vec<BoardInfo>,
    /// Best first.
    pub tiers: Vec<TierInfo>,
    pub hills: HillsInfo,
    pub detours: BoundRange,
    pub detours_hint: &'static str,
}

/// A row's label.
#[must_use]
pub fn row_label(row: BoardRow) -> &'static str {
    row_info(row).label
}

fn row_info(id: BoardRow) -> RowInfo {
    let r = |label, hint, ways| RowInfo {
        id,
        label,
        hint,
        ways,
    };
    match id {
        BoardRow::Paved => r(
            "Smooth paved",
            "Asphalt, concrete, paving stones.",
            "Tagged paved, or untagged streets (a safe guess).",
        ),
        BoardRow::RoughPaved => r(
            "Rough paved",
            "Sett, cobbles, concrete plates.",
            "Tagged sett, cobblestone, plates and the like.",
        ),
        BoardRow::Compacted => r(
            "Compacted",
            "Hard-packed fine gravel: rolls almost like tarmac.",
            "Tagged compacted or fine gravel, and grade 2 tracks.",
        ),
        BoardRow::Gravel => r(
            "Gravel",
            "Loose gravel and forest tracks.",
            "Tagged gravel, and grade 3 tracks.",
        ),
        BoardRow::Soft => r(
            "Soft ground",
            "Dirt, grass, sand: slow when dry, a mess when wet.",
            "Tagged dirt, grass, sand, and grade 4–5 tracks.",
        ),
        BoardRow::Unknown => r(
            "Unknown",
            "No surface tag and no good guess. Unknown is not bad, only unknown.",
            "Untagged ways guessed weakly (tracks without a grade, paths), and unusual surfaces.",
        ),
        BoardRow::Main => r(
            "Main roads",
            "Secondary, primary and trunk roads.",
            "Trunk, primary, secondary and their links, without a cycle track.",
        ),
        BoardRow::CountryRoad => r(
            "Country roads",
            "Small roads between villages.",
            "Tertiary and unclassified roads.",
        ),
        BoardRow::Residential => r(
            "Residential",
            "Slow streets through villages and estates.",
            "Residential and living streets, pedestrian areas.",
        ),
        BoardRow::Service => r(
            "Service roads",
            "Driveways, farm access, parking aisles.",
            "Service roads, and ways of no known kind.",
        ),
        BoardRow::Track => r(
            "Tracks",
            "Two-lane tracks for tractors and forestry.",
            "Farm and forest tracks.",
        ),
        BoardRow::Path => r(
            "Paths",
            "Footpaths, bridleways and singletrack.",
            "Paths, footways, bridleways and steps (not cycle paths).",
        ),
        BoardRow::CyclePath => r(
            "Cycle paths",
            "Their own line through the land, no cars in sight.",
            "Separate cycle paths, mostly away from motor roads.",
        ),
        BoardRow::CyclePathRoadside => r(
            "Roadside cycle paths",
            "Separate, but beside the traffic.",
            "Cycle paths within 20 m of a motor road, and cycle tracks on the road.",
        ),
    }
}

fn tier_info(id: Tier) -> TierInfo {
    let (label, hint) = match id {
        Tier::Love => (
            "Love",
            "The ways worth a detour: everything else counts relative to these.",
        ),
        Tier::Like => ("Like", "Good ways, a little behind the ones you love."),
        Tier::Fine => ("Fine", "No opinion."),
        Tier::Dislike => ("Dislike", "Only where it saves real distance."),
        Tier::Avoid => ("Avoid", "Never, however short (a limit)."),
    };
    TierInfo {
        id,
        label,
        hint,
        factor: id.factor(),
    }
}

/// The named curves of the UI.
#[must_use]
pub fn curve_presets() -> Vec<CurvePreset> {
    let h = |a: [f32; 4], d: [f32; 2], loose: f32| Hills {
        up: UpHandles {
            at3: a[0],
            at6: a[1],
            at10: a[2],
            at15: a[3],
        },
        down: Some(DownHandles {
            at8: d[0],
            at15: d[1],
        }),
        loose_pct: loose,
    };
    vec![
        CurvePreset {
            id: "flat_please",
            label: "Flat please",
            blurb: "Every climb costs; steep ones a lot.",
            hills: h([1.3, 1.9, 3.0, 5.0], [1.1, 1.6], 20.0),
        },
        CurvePreset {
            id: "dont_mind",
            label: "Don't mind",
            blurb: "Hills are part of it; only walls cost extra.",
            hills: h([1.0, 1.1, 1.4, 2.0], [1.0, 1.2], 0.0),
        },
        CurvePreset {
            id: "climber",
            label: "Climber",
            blurb: "Seeks steady climbs, still not walls.",
            hills: h([0.9, 0.8, 0.85, 1.5], [1.0, 1.3], 0.0),
        },
        CurvePreset {
            id: "no_walls",
            label: "No walls",
            blurb: "Rolling is fine, beyond 10 % it gets expensive fast.",
            hills: h([1.0, 1.15, 2.5, 6.0], [1.1, 2.0], 20.0),
        },
    ]
}

/// The catalogue's part for the structured controls.
#[must_use]
pub fn info() -> StructuredInfo {
    let board = |id: BoardId, label, hint, rows: &[BoardRow]| BoardInfo {
        id,
        label,
        hint,
        rows: rows.iter().map(|&r| row_info(r)).collect(),
        replaces: replaced_by_board(id).to_vec(),
        replaces_limits: limits_replaced_by_board(id).to_vec(),
    };
    let handle = |grade_pct, (min, max): (f32, f32)| HandleInfo {
        grade_pct,
        min,
        max,
        step: 0.05,
    };
    let mut handles: Vec<HandleInfo> = Hills::DOWN_GRADES
        .iter()
        .rev()
        .map(|&g| handle(-g, Hills::DOWN_RANGE))
        .collect();
    handles.extend(Hills::UP_GRADES.iter().map(|&g| handle(g, Hills::UP_RANGE)));
    StructuredInfo {
        boards: vec![
            board(
                BoardId::Surface,
                "Surface",
                "What you roll on, ranked.",
                &BoardRow::SURFACE,
            ),
            board(
                BoardId::Way,
                "Way type",
                "Roads, tracks and paths, ranked.",
                &BoardRow::WAY,
            ),
        ],
        tiers: Tier::BEST_FIRST.iter().map(|&t| tier_info(t)).collect(),
        hills: HillsInfo {
            label: "Hills",
            hint: "What a metre costs against its grade, relative to flat: 2.5 at 10 % means a metre there counts as 2.5.",
            handles,
            flat_beyond_pct: FLAT_BEYOND_PCT,
            loose_pct: BoundRange {
                min: Hills::LOOSE_RANGE.0,
                max: Hills::LOOSE_RANGE.1,
                default: 20.0,
            },
            loose_label: "On loose ground, grades count this much steeper",
            curves: curve_presets(),
            replaces: REPLACED_BY_HILLS.to_vec(),
        },
        detours: BoundRange {
            min: DETOURS_RANGE.0,
            max: DETOURS_RANGE.1,
            default: DETOURS_DEFAULT,
        },
        detours_hint: "How far the ranking pulls: at 1 a way you love is worth a 1.35× longer ride than a fine one, at 2 a 1.82× longer one.",
    }
}

// ---------------------------------------------------------------- the conversion

/// A representative way of a row: what its legacy weights are read on.
fn row_view(row: BoardRow) -> (View, (u8, Confidence)) {
    let tagged = |s: u8| (s, Confidence::Tagged);
    let on = |hw: u8| View { hw, ..ZERO_VIEW };
    match row {
        BoardRow::Paved | BoardRow::Residential => (on(hw::RESIDENTIAL), tagged(sc::PAVED)),
        BoardRow::RoughPaved => (on(hw::RESIDENTIAL), tagged(sc::ROUGH)),
        BoardRow::Compacted => (on(hw::TRACK), tagged(sc::COMPACTED)),
        BoardRow::Gravel | BoardRow::Track => (on(hw::TRACK), tagged(sc::GRAVEL)),
        BoardRow::Soft => (on(hw::TRACK), tagged(sc::SOFT)),
        // an untagged track: a weak guess
        BoardRow::Unknown => (on(hw::TRACK), (sc::GRAVEL, Confidence::Weak)),
        BoardRow::Main => (on(3), tagged(sc::PAVED)),
        BoardRow::CountryRoad => (on(hw::UNCLASSIFIED), tagged(sc::PAVED)),
        BoardRow::Service => (on(hw::SERVICE), tagged(sc::PAVED)),
        BoardRow::Path => (on(hw::PATH), tagged(sc::GRAVEL)),
        BoardRow::CyclePath => (on(hw::CYCLEWAY), tagged(sc::PAVED)),
        BoardRow::CyclePathRoadside => (
            View {
                road_near: 15,
                ..on(hw::CYCLEWAY)
            },
            tagged(sc::PAVED),
        ),
    }
}

/// The tier nearest to an absolute factor (1 neutral), in log space; `avoid` is never chosen (it is
/// a limit, not a strength).
#[must_use]
pub fn nearest_tier(absolute: f32) -> Tier {
    let x = absolute.max(1e-3).ln();
    let mut best = (Tier::Fine, f32::INFINITY);
    for t in Tier::BEST_FIRST {
        if let Some(f) = t.factor() {
            let d = (x - (f / TIER_FINE).ln()).abs();
            if d < best.1 - 1e-6 {
                best = (t, d);
            }
        }
    }
    best.0
}

/// The legacy factor of the hills ids at a signed grade (percent, < 0 downhill), on a way of
/// factor 1: the grade ramps times seeking climbs, plus avoiding climbs per metre.
fn legacy_hills(p: &Profile, g: f32) -> f32 {
    let (up, down) = if g >= 0.0 { (g, 0.0) } else { (0.0, -g) };
    let mut factor = 1.0;
    let mut add = 0.0;
    for &id in REPLACED_BY_HILLS {
        let Some(w) = p.weight(id).filter(|&w| w != 0) else {
            continue;
        };
        let w = f32::from(w) / 100.0;
        if let Some(r) = cost::grade_ramp(id) {
            factor *= cost::at(&cost::table(id, w), r.level(up, down));
        } else if up > 0.0 {
            // climb: the average grade beyond the open deadband
            let rate = (up / 100.0 - cost::CLIMB_DEADBAND_OPEN).max(0.0);
            if w > 0.0 {
                factor *= cost::at(&cost::table(id, w), cost::lv(rate / cost::CLIMB_FULL_GRADE));
            } else {
                add += -w * crate::catalogue::pref_meta(id).max_penalty * rate;
            }
        }
    }
    factor + add
}

fn round2(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
}

/// A slider profile in the structured form (a pure function, the prototype's switch): every row
/// of both boards at the tier nearest to its factor today (the board's slider weights on a
/// representative way of the row; limits as `avoid`), the hills curve's handles from `climb`,
/// `steep` and `ramps_over_*` at the handles' grades, `detours` from `bounds.min_factor`, the turn
/// cost doubled (the factors' scale); the other weights and limits are kept. A structured profile
/// comes back unchanged.
#[must_use]
pub fn to_structured(p: &Profile) -> Profile {
    if p.structured() {
        return p.clone();
    }
    let mut out = p.clone();
    let mut boards = Boards::default();
    for board in [BoardId::Surface, BoardId::Way] {
        let rows: &[BoardRow] = if board == BoardId::Surface {
            &BoardRow::SURFACE
        } else {
            &BoardRow::WAY
        };
        for &row in rows {
            let (v, surface) = row_view(row);
            let mut f = 1.0;
            for &id in replaced_by_board(board) {
                if let Some(w) = p.weight(id).filter(|&w| w != 0) {
                    let t = cost::table(id, f32::from(w) / 100.0);
                    f *= cost::at(&t, cost::membership(id, &v, surface, None));
                }
            }
            boards.set(row, nearest_tier(f));
        }
    }
    // the limits a board replaces: their rows on avoid
    if p.limit(LimitId::PavedOnly).is_some() {
        for row in [
            BoardRow::Compacted,
            BoardRow::Gravel,
            BoardRow::Soft,
            BoardRow::Unknown,
        ] {
            boards.set(row, Tier::Avoid);
        }
    }
    if p.limit(LimitId::NoUnknownSurface).is_some() {
        boards.set(BoardRow::Unknown, Tier::Avoid);
    }
    if p.limit(LimitId::NoMainRoads).is_some() {
        boards.set(BoardRow::Main, Tier::Avoid);
    }
    let up = |g: f32| round2(legacy_hills(p, g).clamp(Hills::UP_RANGE.0, Hills::UP_RANGE.1));
    let down = |g: f32| round2(legacy_hills(p, -g).clamp(Hills::DOWN_RANGE.0, Hills::DOWN_RANGE.1));
    out.hills = Some(Hills {
        up: UpHandles {
            at3: up(3.0),
            at6: up(6.0),
            at10: up(10.0),
            at15: up(15.0),
        },
        down: Some(DownHandles {
            at8: down(8.0),
            at15: down(15.0),
        }),
        loose_pct: 0.0,
    });
    out.boards = Some(boards);
    for board in [BoardId::Surface, BoardId::Way] {
        for id in replaced_by_board(board) {
            out.weights.remove(id);
        }
        for id in limits_replaced_by_board(board) {
            out.limits.remove(id);
        }
    }
    for id in REPLACED_BY_HILLS {
        out.weights.remove(id);
    }
    // `min_factor` 0.5 is detours 1; a lower floor let a way you like pull further
    let mf = p.bounds().min_factor;
    out.detours = Some(round2(
        (mf.ln() / 0.5f32.ln()).clamp(DETOURS_RANGE.0, DETOURS_RANGE.1),
    ));
    // a turn keeps its worth against the ways: the relative factors are about twice the slider
    // model's (a fine way on both boards costs 1.82 per metre where a neutral one cost 1), and
    // replay on the rider's rides matches today's turns per km at twice the metres
    out.turn_m = Some((2.0 * p.turn_m()).min(crate::profile::TURN_M_RANGE.1));
    out.bounds = p.bounds.map(|b| crate::profile::Bounds {
        min_factor: crate::profile::Bounds::default().min_factor,
        ..b
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hills(up: [f32; 4], down: Option<[f32; 2]>, loose: f32) -> Hills {
        Hills {
            up: UpHandles {
                at3: up[0],
                at6: up[1],
                at10: up[2],
                at15: up[3],
            },
            down: down.map(|d| DownHandles {
                at8: d[0],
                at15: d[1],
            }),
            loose_pct: loose,
        }
    }

    #[test]
    fn the_curve_passes_its_handles_and_is_flat_beyond() {
        let h = hills([1.1, 1.4, 2.5, 5.0], Some([1.1, 1.6]), 20.0);
        let c = Curve::new(&h);
        for (g, v) in curve_points(&h) {
            assert!((c.at(g) - v).abs() < 1e-4, "{g}: {} vs {v}", c.at(g));
        }
        assert!((c.at(0.0) - 1.0).abs() < 1e-6);
        assert!((c.at(19.0) - 5.0).abs() < 1e-4);
        assert!((c.at(-30.0) - 1.6).abs() < 1e-4);
        // log-linear between handles: the geometric mean halfway
        assert!((c.at(8.0) - (1.4f32 * 2.5).sqrt()).abs() < 2e-3);
        // descents default to half the grade of a climb
        let d = down_handles(&hills([1.1, 1.4, 2.5, 5.0], None, 0.0));
        let up = Curve::new(&hills([1.1, 1.4, 2.5, 5.0], Some([1.0, 1.0]), 0.0));
        assert!((d.at8 - up.at(4.0)).abs() < 2e-3);
        assert!((d.at15 - up.at(7.5)).abs() < 2e-3);
    }

    #[test]
    fn the_split_reads_the_wall_and_the_rest() {
        let c = Curve::new(&hills([1.1, 1.4, 2.5, 5.0], Some([1.1, 1.6]), 0.0));
        // flat
        let s = c.split(400.0, 0.0, 0.0, 0.0, 0.0, 1.0);
        assert!((s.value - 1.0).abs() < 1e-6);
        // 400 m climbing 24 m with a 50 m wall at 12 %: the wall counts at the curve's 12 %, the
        // rest at what is left of the climb (18 m over 350 m)
        let s = c.split(400.0, 12.0, 0.0, 24.0, 0.0, 1.0);
        assert!((s.wall_m - 50.0).abs() < 1e-3 && (s.wall_pct - 12.0).abs() < 1e-4);
        assert!((s.climb_pct - 18.0 / 350.0 * 100.0).abs() < 1e-3);
        assert!((s.climb_m - 350.0).abs() < 1e-3 && s.descent_m.abs() < 1e-3);
        let want = (50.0 * c.at(12.0) + 350.0 * c.at(s.climb_pct)) / 400.0;
        assert!((s.value - want).abs() < 1e-4);
        assert!((s.wall_m + s.climb_m + s.descent_m - 400.0).abs() < 1e-3);
        // loose ground reads steeper
        let l = c.split(400.0, 12.0, 0.0, 24.0, 0.0, 1.2);
        assert!(l.value > s.value && (l.wall_pct - 14.4).abs() < 1e-4);
        // a short arc is its wall
        let w = c.split(30.0, 0.0, 9.0, 0.0, 2.7, 1.0);
        assert!((w.value - c.at(-9.0)).abs() < 1e-5 && w.wall_pct < 0.0);
    }

    #[test]
    fn tiers_snap_in_log_space() {
        assert_eq!(nearest_tier(1.0), Tier::Fine);
        assert_eq!(nearest_tier(0.74), Tier::Love);
        assert_eq!(nearest_tier(0.3), Tier::Love);
        assert_eq!(nearest_tier(0.86), Tier::Like);
        assert_eq!(nearest_tier(1.5), Tier::Dislike);
        assert_eq!(nearest_tier(9.0), Tier::Dislike);
    }

    #[test]
    fn the_conversion_maps_weights_limits_and_hills() {
        let p = Profile::from_json(
            r#"{"name":"x","weights":{"unpaved":50,"fine_gravel":20,"soft_ground":-40,"track":40,"main":-80,
                "quiet":70,"climb":-60,"steep":-70,"novel":60},
                "limits":{"paved_only":false,"no_main_roads":true,"no_stairs":true},"bounds":{"min_factor":0.3}}"#,
        )
        .unwrap();
        let s = to_structured(&p);
        s.validate().unwrap();
        assert!(s.structured());
        let b = s.boards.unwrap();
        assert_eq!(b.tier(BoardRow::Compacted), Some(Tier::Love));
        assert_eq!(b.tier(BoardRow::Paved), Some(Tier::Fine));
        assert_eq!(b.tier(BoardRow::Soft), Some(Tier::Dislike));
        assert_eq!(b.tier(BoardRow::Track), Some(Tier::Like));
        assert_eq!(b.tier(BoardRow::Main), Some(Tier::Avoid));
        assert_eq!(b.tier(BoardRow::Residential), Some(Tier::Fine));
        // the replaced ids are gone, the rest kept
        assert_eq!(s.weight(PrefId::Unpaved), None);
        assert_eq!(s.weight(PrefId::Climb), None);
        assert_eq!(s.weight(PrefId::Quiet), Some(70));
        assert_eq!(s.weight(PrefId::Novel), Some(60));
        assert_eq!(s.limit(LimitId::NoMainRoads), None);
        assert!(s.limit(LimitId::NoStairs).is_some());
        // climb −60: 1 + 0.15 (g − 0.4) uphill; steep −70 from 8 %
        let h = s.hills.unwrap();
        assert!((h.up.at3 - (1.0 + 0.15 * 2.6)).abs() < 0.011, "{h:?}");
        assert!(h.up.at10 > 1.0 + 0.15 * 9.6, "steep adds from 8 %: {h:?}");
        assert!(h.down.unwrap().at15 > 1.0);
        assert!((s.detours.unwrap() - 1.74).abs() < 0.01);
        assert!((s.bounds().min_factor - 0.5).abs() < 1e-6);
        // idempotent
        assert_eq!(to_structured(&s), s);
        // a blank profile: every row fine, a flat curve
        let blank = to_structured(&Profile::default());
        assert!(
            blank
                .boards
                .unwrap()
                .rows()
                .iter()
                .all(|&r| blank.boards.unwrap().tier(r) == Some(Tier::Fine))
        );
        assert_eq!(blank.hills.unwrap().up_values(), [1.0; 4]);
        assert_eq!(blank.detours, Some(1.0));
        assert_eq!(blank.turn_m, Some(2.0 * crate::profile::TURN_M));
    }

    #[test]
    fn the_catalogue_part_is_complete() {
        let i = info();
        assert_eq!(i.boards[0].rows.len(), BoardRow::SURFACE.len());
        assert_eq!(i.boards[1].rows.len(), BoardRow::WAY.len());
        assert_eq!(i.tiers.len(), 5);
        assert_eq!(i.hills.handles.len(), 6);
        for c in &i.hills.curves {
            let p = Profile {
                hills: Some(c.hills),
                ..Profile::default()
            };
            p.validate().unwrap();
        }
        let json = serde_json::to_value(&i).unwrap();
        assert_eq!(json["tiers"][0]["id"], "love");
        assert!(json["tiers"][4].get("factor").is_none());
    }
}
