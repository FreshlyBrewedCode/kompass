//! The cost debug queries (`docs/routing.md`, "Explaining the cost"): what a profile makes of the
//! ways, for a map layer and a tap panel, and why a route did not take another way.
//!
//! - [`Planner::edge_costs`]: the factor and cost per metre of many edges at once (both
//!   directions) and what closes the closed ones, as flat arrays for a map layer.
//! - [`Planner::explain_edge`]: one edge, every step of its cost in both directions.
//! - [`Planner::compare`]: two routes stretch by stretch under one profile (the route and the one
//!   forced through a via: "why not this way?").
//!
//! All three read the compiled profile the router uses ([`crate::cost::CostModel`]); the
//! breakdown runs the same functions the compile does ([`crate::cost::CostModel::breakdown`]).

use serde::{Deserialize, Serialize};

#[cfg(feature = "schema")]
use ts_rs::TS;

use crate::cost::{self, ArcBreakdown, Clamp, Confidence, CostModel, Exclusion, Role, WayKind};
use crate::graph::{ArcId, EdgeId, Graph, arc, arc_edge};
use crate::overrides::{self, EdgeOverride, OverrideKind, Overrides};
use crate::personal::PersonalLayer;
use crate::profile::{BoardId, BoardRow, Bounds, LimitId, PrefId, Profile};
use crate::route::{Part, Planner, Reason, RouteError, Span, SurfaceKind, diff, invalid_request};
use crate::turns::{Headings, line_turns};
use crate::structured::StructuredParts;

/// What closes an arc: a limit of the profile (the catalogue's limit ids) or a rule that holds
/// whatever the profile. In typed arrays as [`ClosedBy::code`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub enum ClosedBy {
    NoMainRoads,
    PavedOnly,
    NoUnknownSurface,
    MaxGrade,
    MaxMtbScale,
    NoStairs,
    LegalOnly,
    NoFerries,
    /// `bicycle=no` (the pipeline maps motor roads to it): never, whatever the profile.
    NoBikes,
    /// Against a one-way: never.
    Oneway,
    /// A surface row on `avoid` (structured model: the surface board's limit).
    AvoidedSurface,
    /// A way row on `avoid` (structured model: the way board's limit).
    AvoidedWay,
}

impl ClosedBy {
    /// Every value, in code order (`ALL[code - 1]`).
    pub const ALL: &'static [ClosedBy] = &[
        ClosedBy::NoMainRoads,
        ClosedBy::PavedOnly,
        ClosedBy::NoUnknownSurface,
        ClosedBy::MaxGrade,
        ClosedBy::MaxMtbScale,
        ClosedBy::NoStairs,
        ClosedBy::LegalOnly,
        ClosedBy::NoFerries,
        ClosedBy::NoBikes,
        ClosedBy::Oneway,
        ClosedBy::AvoidedSurface,
        ClosedBy::AvoidedWay,
    ];

    /// The code in [`EdgeCosts::closed`]: 1.. in the order of [`ClosedBy::ALL`] (0 is open).
    #[must_use]
    pub fn code(self) -> u8 {
        self as u8 + 1
    }

    /// The wire id (a limit's id, `no_bikes` or `oneway`).
    #[must_use]
    pub fn id(self) -> &'static str {
        match self {
            ClosedBy::NoBikes => "no_bikes",
            ClosedBy::Oneway => "oneway",
            ClosedBy::AvoidedSurface => "avoided_surface",
            ClosedBy::AvoidedWay => "avoided_way",
            _ => self.limit().map_or("", LimitId::id),
        }
    }

    /// The limit, if it is one.
    #[must_use]
    pub fn limit(self) -> Option<LimitId> {
        Some(match self {
            ClosedBy::NoMainRoads => LimitId::NoMainRoads,
            ClosedBy::PavedOnly => LimitId::PavedOnly,
            ClosedBy::NoUnknownSurface => LimitId::NoUnknownSurface,
            ClosedBy::MaxGrade => LimitId::MaxGrade,
            ClosedBy::MaxMtbScale => LimitId::MaxMtbScale,
            ClosedBy::NoStairs => LimitId::NoStairs,
            ClosedBy::LegalOnly => LimitId::LegalOnly,
            ClosedBy::NoFerries => LimitId::NoFerries,
            ClosedBy::NoBikes | ClosedBy::Oneway | ClosedBy::AvoidedSurface | ClosedBy::AvoidedWay => {
                return None;
            }
        })
    }
}

impl From<Exclusion> for ClosedBy {
    fn from(x: Exclusion) -> ClosedBy {
        match x {
            Exclusion::NoBikes => ClosedBy::NoBikes,
            Exclusion::Oneway => ClosedBy::Oneway,
            Exclusion::Avoided(row) => match row.board() {
                BoardId::Surface => ClosedBy::AvoidedSurface,
                BoardId::Way => ClosedBy::AvoidedWay,
            },
            Exclusion::Limit(l) => match l {
                LimitId::NoMainRoads => ClosedBy::NoMainRoads,
                LimitId::PavedOnly => ClosedBy::PavedOnly,
                LimitId::NoUnknownSurface => ClosedBy::NoUnknownSurface,
                LimitId::MaxGrade => ClosedBy::MaxGrade,
                LimitId::MaxMtbScale => ClosedBy::MaxMtbScale,
                LimitId::NoStairs => ClosedBy::NoStairs,
                LimitId::LegalOnly => ClosedBy::LegalOnly,
                LimitId::NoFerries => ClosedBy::NoFerries,
            },
        }
    }
}

/// Which edges [`Planner::edge_costs`] answers for.
#[derive(Debug, Clone, PartialEq)]
pub enum EdgeSelection {
    /// Every edge of the graph (`edges` is then `0..edge_count`).
    All,
    /// These edges, in this order (ids from the overlay tiles' feature ids).
    List(Vec<EdgeId>),
    /// The edges in a box, degrees `[west, south, east, north]` (ascending ids, a few just outside).
    Bbox([f64; 4]),
}

/// [`Planner::edge_costs`]: flat arrays, one or two entries per edge (typed arrays in the browser).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct EdgeCosts {
    /// The edges answered for, in answer order.
    pub edges: Vec<EdgeId>,
    /// Two per edge, along then against the geometry (`[2i]`, `[2i + 1]`): the factor after the
    /// clamp, `bounds.min_factor..=bounds.max_factor`; 0 where that direction may not be ridden.
    pub factor: Vec<f32>,
    /// Two per edge: the cost per metre the router uses, additive terms included (climbing,
    /// barriers, steps, dismount, ferry: `cost / length`); 0 where that direction may not be ridden.
    pub cost_per_m: Vec<f32>,
    /// One per edge: 0 when at least one direction may be ridden (a one-way shows as a 0 factor
    /// the other way), else the [`ClosedBy::code`] of the first thing that closes it.
    pub closed: Vec<u8>,
    pub min_factor: f32,
    pub max_factor: f32,
    /// The smallest factor the compile produced (the A* bound).
    pub bound: f32,
}

/// `explainEdge`: one edge under a profile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
#[cfg_attr(feature = "schema", ts(optional_fields))]
pub struct ExplainEdgeRequest {
    pub profile: Profile,
    pub edge: EdgeId,
    /// The plan's edge overrides (only the one on `edge` matters): the explanation says what the
    /// router counts with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overrides: Option<Vec<EdgeOverride>>,
}

/// An attribute's value: an enum's label, a number, a flag; `null` unknown.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub enum AttrValue {
    Text(String),
    Number(f64),
    Flag(bool),
}

/// One attribute of the edge, named by its `edges.parquet` column (the names the catalogue's
/// `coverage.attribute` uses), as the graph keeps it (quantised).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct Attribute {
    pub attribute: String,
    pub value: Option<AttrValue>,
}

/// How sure the surface the cost uses is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub enum SurfaceSource {
    /// From the `surface` tag.
    Tagged,
    /// Untagged, a safe guess from the way (counts like a tag).
    StrongGuess,
    /// Untagged, a guess: counts 0.7 for the surface preferences, closed by `paved_only` and
    /// `no_unknown_surface`.
    WeakGuess,
}

/// Where the traffic level of an edge comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub enum TrafficFrom {
    /// The way's own traffic (road class, speed, lanes, access, a cycle track on it); 0 on paths.
    Way,
    /// The motor roads within 20 m: their level (`road_near_traffic`) × the share of the way near
    /// them (`road_near_share`) × 0.3, louder than the way's own.
    Alongside,
}

/// One active preference's part in an arc's cost.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct PrefPart {
    pub id: PrefId,
    /// The profile's weight, −100..=100.
    pub weight: i32,
    /// How much the way is what the preference names, −1..=1, quantised to fifteenths as the cost
    /// uses it. `climb`: the average grade beyond the deadband over 5 %.
    pub membership: f32,
    /// Its factor here (1: no effect; < 1 cheaper, > 1 dearer). A `gated_bonus` counts only
    /// through the gate; an `additive` one (avoiding climbs) has none, its metres are in `additive`.
    pub factor: f32,
    pub role: Role,
    /// Structured model: whether it counts (only the strongest bonus and penalty of its group do;
    /// one with factor 1 here counts for nothing either way). Absent in the slider model, where every
    /// preference counts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "schema", ts(optional))]
    pub counted: Option<bool>,
}

/// What an additive term is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub enum AdditiveKind {
    /// Avoiding climbs: metres per metre of ascent beyond the deadband.
    Climb,
    /// Gates, bollards, … on the edge's nodes.
    Barriers,
    /// Carrying.
    Steps,
    /// `bicycle=dismount`: walking.
    Dismount,
    /// The wait.
    Ferry,
    /// The hills curve (structured model): `length × (curve − 1)`, < 0 where it seeks climbs.
    Hills,
}

/// An additive term: metres of cost on top of `length × factor`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct Additive {
    pub kind: AdditiveKind,
    pub metres: f32,
}

/// Something that closes an arc, with the attribute that triggers it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct Closure {
    pub by: ClosedBy,
    /// The `edges.parquet` column (or `tamed_grade_pct`, `surface_guess`) and its value here.
    pub attribute: String,
    pub value: AttrValue,
}

/// One direction of an edge, explained.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct ArcCostExplanation {
    /// `edge << 1 | reverse`.
    pub arc: ArcId,
    /// Every active preference (weight ≠ 0), catalogue order, also where its factor is 1.
    pub preferences: Vec<PrefPart>,
    /// The product of the quality factors, the gated penalties and the ramps.
    pub quality: f32,
    /// The product of the gated bonuses (before the gate).
    pub bonus: f32,
    /// How much of the bonus counts, 0..=1: 1 up to quality 1.3, 0 from 2.2.
    pub gate: f32,
    /// `quality × (1 + (bonus − 1) × gate)`: the factor before the clamp.
    pub raw_factor: f32,
    /// After the clamp to the profile's bounds.
    pub factor: f32,
    /// Set when the clamp changed the factor: which bound.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clamp: Option<Clamp>,
    /// Ascent beyond the deadband, metres; the tamed steepest grade up and down, percent.
    pub ascent_m: f32,
    pub grade_up_pct: f32,
    pub grade_down_pct: f32,
    /// The additive terms that are not 0.
    pub additive: Vec<Additive>,
    /// Their sum, metres.
    pub extra_m: f32,
    /// The arc's cost the router uses (metres-equivalent): `length × factor + extra_m`, or what this
    /// plan's override makes of it. Absent when closed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_per_m: Option<f32>,
    /// With an override that changes the cost (avoid, prefer): the profile's cost without it (absent
    /// where the profile closes the arc).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_cost: Option<f32>,
    /// Everything that closes this direction (empty: open), in the order the engine checks.
    pub closed_by: Vec<Closure>,
    /// The limits this plan's override (allow, prefer) lifts here: they would close it.
    #[serde(default)]
    pub lifted: Vec<Closure>,
    /// Structured model: the boards' rows and tiers, what counts per group, the relative factor,
    /// the hills curve's reading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured: Option<StructuredParts>,
}

/// `explainEdge`'s answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct EdgeExplanation {
    pub edge: EdgeId,
    pub length_m: f32,
    pub way: WayKind,
    /// The surface a route reports (the tag or a safe guess, else unknown).
    pub surface: SurfaceKind,
    /// The surface class the cost uses, and where it comes from.
    pub cost_surface: String,
    pub surface_source: SurfaceSource,
    /// The traffic level, 0..=1, that `quiet` penalises: the louder of the way's own and the
    /// traffic it gets from the roads beside it.
    pub traffic: f32,
    /// Where `traffic` comes from.
    pub traffic_from: TrafficFrom,
    /// Every attribute the graph keeps for the edge.
    pub attributes: Vec<Attribute>,
    pub bounds: Bounds,
    /// This plan's override on the edge, if any ("avoided in this plan").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_override: Option<OverrideKind>,
    /// Along the geometry (`from → to`) and against it.
    pub along: ArcCostExplanation,
    pub against: ArcCostExplanation,
}

/// `compare`: two routes' arcs (`RouteResult::arcs`) under one profile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct CompareRequest {
    pub profile: Profile,
    pub a: Vec<ArcId>,
    pub b: Vec<ArcId>,
    /// The plan's edge overrides: the sides are costed as the router counts them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overrides: Option<Vec<EdgeOverride>>,
}

/// Length on overridden edges (avoided, preferred, allowed in this plan).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct OverridePart {
    pub kind: OverrideKind,
    pub length_m: f32,
}

/// Length on arcs the profile closes (a route through a waypoint on an excluded way, or one made
/// with another profile).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct ClosedPart {
    pub by: ClosedBy,
    pub length_m: f32,
}

/// A stretch of one route (or a whole route), costed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct StretchCost {
    /// `[first, end)` into that route's arcs, start and length (edges counted in full).
    pub span: Span,
    /// Under the request's profile and overrides (closed arcs at `max_factor` per metre, as near a
    /// waypoint), its turns included (`turn_cost`).
    pub cost: f32,
    /// The mean factor per metre (`Σ length × factor / Σ length`), additive terms not included.
    pub factor: f32,
    pub extra_m: f32,
    /// Length where the clamp raised the factor to `min_factor` (the bonuses wanted it lower: more
    /// seeking changes nothing there) and where it lowered it to `max_factor`.
    pub clamped_min_m: f32,
    pub clamped_max_m: f32,
    /// The strongest preferences here (length-weighted geometric mean factor), at most 5,
    /// strongest first.
    pub why: Vec<Reason>,
    /// Length per way type, longest first.
    pub ways: Vec<Part<WayKind>>,
    /// Length on closed arcs, by what closes them.
    pub closed: Vec<ClosedPart>,
    /// Length on edges with an override of the plan, by kind.
    #[serde(default)]
    pub overrides: Vec<OverridePart>,
    /// Turns that cost something, the moves onto the stretch and off it included (where a detour
    /// leaves the other route and rejoins it), and what they cost (metres-equivalent, in `cost`).
    pub turns: u32,
    pub turn_cost: f32,
    /// Structured model: length per row of the boards present, board order (0 m included).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "schema", ts(optional))]
    pub rows: Option<Vec<Part<BoardRow>>>,
    /// Structured model with a hills curve: its metres here (in `extra_m`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "schema", ts(optional))]
    pub hills_m: Option<f32>,
}

/// One stretch where the routes part, both sides costed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct StretchComparison {
    pub a: StretchCost,
    pub b: StretchCost,
    /// `b.cost − a.cost` (> 0: `b` is dearer here, the reason the router took `a`).
    pub cost_delta: f32,
    /// `b.length − a.length`, metres.
    pub length_delta_m: f32,
}

/// `compare`'s answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct RouteComparison {
    /// Whole routes (edges in full).
    pub a: StretchCost,
    pub b: StretchCost,
    /// Where they part, in the order of `a` (as `diff`).
    pub stretches: Vec<StretchComparison>,
    pub shared_m: f32,
}

/// The `why` list of a stretch.
const WHY_MAX: usize = 5;

impl Planner {
    /// The factor and cost per metre of many edges at once under a profile (compiled once and
    /// cached like a route's), with what closes the closed ones: the colouring of a map layer.
    /// Native: ~2 ms per 100 k edges.
    pub fn edge_costs(&mut self, p: &Profile, which: &EdgeSelection) -> Result<EdgeCosts, RouteError> {
        let v = self.cost_view(p)?;
        let g = v.graph;
        let m = g.edge_count();
        let edges: Vec<EdgeId> = match which {
            #[allow(clippy::cast_possible_truncation, reason = "edge ids fit u32")]
            EdgeSelection::All => (0..m as EdgeId).collect(),
            EdgeSelection::List(list) => {
                if let Some(e) = list.iter().find(|&&e| e as usize >= m) {
                    return Err(invalid_request(format!("edge {e} is not in the graph")));
                }
                list.clone()
            }
            EdgeSelection::Bbox([w, s, e, n]) => {
                if ![w, s, e, n].iter().all(|x| x.is_finite()) {
                    return Err(invalid_request("bbox must be four numbers".into()));
                }
                #[allow(clippy::cast_possible_truncation, reason = "degrees × 1e7 fit i32")]
                let e7 = |x: f64| (x * 1e7).round() as i32;
                v.grid.edges_in([e7(*w), e7(*s), e7(*e), e7(*n)])
            }
        };
        let mut out = EdgeCosts {
            factor: Vec::with_capacity(edges.len() * 2),
            cost_per_m: Vec::with_capacity(edges.len() * 2),
            closed: Vec::with_capacity(edges.len()),
            min_factor: v.model.min_factor,
            max_factor: v.model.max_factor,
            bound: v.bound,
            edges: Vec::new(),
        };
        for &e in &edges {
            let len = g.length_m(e).max(0.1);
            let mut open = false;
            for dir in 0..2u32 {
                let a = arc(e, dir == 1);
                let c = v.costs[a as usize];
                if c.is_finite() {
                    open = true;
                    out.factor.push((c - v.model.extra_m(g, v.personal, a)) / len);
                    out.cost_per_m.push(c / len);
                } else {
                    out.factor.push(0.0);
                    out.cost_per_m.push(0.0);
                }
            }
            out.closed.push(if open {
                0
            } else {
                v.model
                    .edge_exclusion(g, e)
                    .map_or(ClosedBy::Oneway, ClosedBy::from)
                    .code()
            });
        }
        out.edges = edges;
        Ok(out)
    }

    /// One edge under a profile, both directions, every step of the cost: for the tap panel.
    pub fn explain_edge(&mut self, req: &ExplainEdgeRequest) -> Result<EdgeExplanation, RouteError> {
        let v = self.cost_view(&req.profile)?;
        let g = v.graph;
        let e = req.edge;
        if e as usize >= g.edge_count() {
            return Err(invalid_request(format!("edge {e} is not in the graph")));
        }
        let list = req.overrides.as_deref().unwrap_or(&[]);
        overrides::check(list, g.edge_count())?;
        let mine: Vec<EdgeOverride> = list.iter().filter(|o| o.edge == e).copied().collect();
        let ov = (!mine.is_empty()).then(|| Overrides::build(g, v.model, v.personal, v.costs, &mine));
        let (class, conf) = cost::cost_surface(g, e);
        let (traffic, alongside) = cost::traffic_level(g, e);
        let side = |reverse: bool| {
            let a = arc(e, reverse);
            let b = v.model.breakdown(g, v.personal, a);
            let compiled = v.costs[a as usize];
            let mut x = arc_explanation(
                g,
                &req.profile,
                a,
                &b,
                overrides::arc_cost(ov.as_ref(), v.costs, a),
            );
            if let Some(o) = &ov {
                if o.lifted(a) {
                    // the limits no longer close it; what still would is said as lifted
                    let (lifted, kept) = x.closed_by.drain(..).partition(|c| c.by.limit().is_some());
                    x.lifted = lifted;
                    x.closed_by = kept;
                }
                if compiled.is_finite() && x.cost.is_some_and(|c| (c - compiled).abs() > 1e-3) {
                    x.base_cost = Some(compiled);
                }
            }
            x
        };
        Ok(EdgeExplanation {
            edge: e,
            length_m: g.length_m(e),
            way: cost::way_kind(g, e),
            surface: SurfaceKind::of(cost::reported_surface(g, e)),
            cost_surface: class.label().to_owned(),
            surface_source: match conf {
                Confidence::Tagged => SurfaceSource::Tagged,
                Confidence::Strong => SurfaceSource::StrongGuess,
                Confidence::Weak => SurfaceSource::WeakGuess,
            },
            traffic,
            traffic_from: if alongside {
                TrafficFrom::Alongside
            } else {
                TrafficFrom::Way
            },
            attributes: attributes(g, v.personal, e),
            bounds: req.profile.bounds(),
            plan_override: mine.first().map(|o| o.kind),
            along: side(false),
            against: side(true),
        })
    }

    /// Two routes under one profile, stretch by stretch where they part (`diff`), each side with
    /// its cost, mean factor, strongest preferences, way types and closed length.
    pub fn compare(&mut self, req: &CompareRequest) -> Result<RouteComparison, RouteError> {
        let v = self.cost_view(&req.profile)?;
        let g = v.graph;
        if let Some(a) = req
            .a
            .iter()
            .chain(&req.b)
            .find(|&&a| arc_edge(a) as usize >= g.edge_count())
        {
            return Err(invalid_request(format!("arc {a} is not in the graph")));
        }
        let list = req.overrides.as_deref().unwrap_or(&[]);
        overrides::check(list, g.edge_count())?;
        let ov = (!list.is_empty()).then(|| Overrides::build(g, v.model, v.personal, v.costs, list));
        let d = diff(g, &req.a, &req.b);
        let whole = |r: &[ArcId]| Span {
            arcs: [0, u32::try_from(r.len()).unwrap_or(u32::MAX)],
            start_m: 0.0,
            length_m: r.iter().map(|&a| g.length_m(arc_edge(a))).sum(),
        };
        let turn_m = req.profile.turn_m();
        let cost_of = |r: &[ArcId], s: Span| {
            let mut c = stretch_cost(g, v.model, v.personal, v.costs, ov.as_ref(), r, s, WHY_MAX);
            add_turns(&mut c, g, v.headings, turn_m, r);
            c
        };
        Ok(RouteComparison {
            a: cost_of(&req.a, whole(&req.a)),
            b: cost_of(&req.b, whole(&req.b)),
            stretches: d
                .stretches
                .iter()
                .map(|s| {
                    let (a, b) = (cost_of(&req.a, s.a), cost_of(&req.b, s.b));
                    StretchComparison {
                        cost_delta: b.cost - a.cost,
                        length_delta_m: b.span.length_m - a.span.length_m,
                        a,
                        b,
                    }
                })
                .collect(),
            shared_m: d.shared_m,
        })
    }

    /// Stretches of one route (`[first, end)` arcs each) costed like `compare`'s sides, with up to
    /// `why_max` reasons each (the CLI's `route --explain`).
    pub fn stretch_costs(
        &mut self,
        p: &Profile,
        route: &[ArcId],
        spans: &[[u32; 2]],
        why_max: usize,
    ) -> Result<Vec<StretchCost>, RouteError> {
        let v = self.cost_view(p)?;
        let g = v.graph;
        if let Some(a) = route.iter().find(|&&a| arc_edge(a) as usize >= g.edge_count()) {
            return Err(invalid_request(format!("arc {a} is not in the graph")));
        }
        let n = u32::try_from(route.len()).unwrap_or(u32::MAX);
        if spans.iter().any(|&[s, e]| s > e || e > n) {
            return Err(invalid_request("a span is outside the route".into()));
        }
        let start: Vec<f32> = std::iter::once(0.0)
            .chain(route.iter().scan(0.0f32, |acc, &a| {
                *acc += g.length_m(arc_edge(a));
                Some(*acc)
            }))
            .collect();
        Ok(spans
            .iter()
            .map(|&[s, e]| {
                let span = Span {
                    arcs: [s, e],
                    start_m: start[s as usize],
                    length_m: start[e as usize] - start[s as usize],
                };
                let mut c = stretch_cost(g, v.model, v.personal, v.costs, None, route, span, why_max);
                add_turns(&mut c, g, v.headings, p.turn_m(), route);
                c
            })
            .collect())
    }
}

/// Adds the turns of a stretch to its cost: every move from one arc onto the next of `route` that
/// enters, crosses or leaves the stretch.
fn add_turns(c: &mut StretchCost, g: &Graph, h: &Headings, turn_m: f32, route: &[ArcId]) {
    let [first, end] = c.span.arcs;
    let lo = (first as usize).max(1) - 1;
    let hi = (end as usize + 1).min(route.len());
    if lo < hi {
        let (n, cost) = line_turns(g, h, turn_m, &route[lo..hi]);
        c.turns = n;
        c.turn_cost = cost;
        c.cost += cost;
    }
}

/// A stretch of a route costed under a compiled profile (and the plan's overrides), its `why` cut to
/// `why_max`.
#[allow(clippy::too_many_arguments, reason = "the stretch and what costs it")]
fn stretch_cost(
    g: &Graph,
    model: &CostModel,
    personal: Option<&PersonalLayer>,
    costs: &[f32],
    ov: Option<&Overrides>,
    route: &[ArcId],
    span: Span,
    why_max: usize,
) -> StretchCost {
    let [first, end] = span.arcs;
    let (mut len_sum, mut cost, mut fsum, mut extra) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    let (mut at_min, mut at_max) = (0.0f32, 0.0f32);
    let mut logs: Vec<(PrefId, f32)> = Vec::new();
    let mut ways: Vec<(WayKind, f32)> = Vec::new();
    let mut closed: Vec<(ClosedBy, f32)> = Vec::new();
    let mut overridden: Vec<(OverrideKind, f32)> = Vec::new();
    let mut rows: Vec<(BoardRow, f32)> = model.rows().into_iter().map(|r| (r, 0.0)).collect();
    let mut hills = 0.0f32;
    for &a in &route[first as usize..end as usize] {
        let e = arc_edge(a);
        let len = g.length_m(e);
        let b = model.breakdown(g, personal, a);
        let c = overrides::arc_cost(ov, costs, a);
        if let Some(k) = ov.and_then(|o| o.kind(e)) {
            add_len(&mut overridden, k, len);
        }
        let x = b.extra_m();
        let factor = if c.is_finite() {
            cost += c;
            b.factor
        } else {
            cost += len * model.max_factor + x;
            if let Some(&by) = b.exclusions.first() {
                add_len(&mut closed, ClosedBy::from(by), len);
            }
            model.max_factor
        };
        match b.clamp {
            Some(Clamp::Min) if c.is_finite() => at_min += len,
            Some(Clamp::Max) if c.is_finite() => at_max += len,
            _ => {}
        }
        len_sum += len;
        fsum += len * factor;
        extra += x;
        add_len(&mut ways, cost::way_kind(g, e), len);
        if let Some(st) = &b.structured {
            for bp in &st.boards {
                add_len(&mut rows, bp.row, len);
            }
            hills += b.hills_m;
        }
        for t in b.terms.iter().filter(|t| t.role != Role::Additive && t.counted) {
            let l = len * t.factor.ln();
            if let Some(x) = logs.iter_mut().find(|x| x.0 == t.id) {
                x.1 += l;
            } else {
                logs.push((t.id, l));
            }
        }
    }
    let n = len_sum.max(1e-6);
    let mut why: Vec<Reason> = logs
        .iter()
        .map(|&(id, l)| Reason {
            id,
            factor: (l / n).exp(),
        })
        .filter(|r| r.factor.ln().abs() > 0.01)
        .collect();
    why.sort_by(|a, b| b.factor.ln().abs().total_cmp(&a.factor.ln().abs()));
    why.truncate(why_max);
    ways.sort_by(|a, b| b.1.total_cmp(&a.1));
    closed.sort_by(|a, b| b.1.total_cmp(&a.1));
    StretchCost {
        span,
        cost,
        factor: if len_sum > 0.0 { fsum / len_sum } else { 0.0 },
        extra_m: extra,
        clamped_min_m: at_min,
        clamped_max_m: at_max,
        why,
        ways: ways
            .into_iter()
            .map(|(key, length_m)| Part {
                key,
                length_m,
                share: length_m / n,
            })
            .collect(),
        closed: closed
            .into_iter()
            .map(|(by, length_m)| ClosedPart { by, length_m })
            .collect(),
        overrides: overridden
            .into_iter()
            .map(|(kind, length_m)| OverridePart { kind, length_m })
            .collect(),
        turns: 0,
        turn_cost: 0.0,
        rows: model.is_structured().then(|| {
            rows.into_iter()
                .map(|(key, length_m)| Part {
                    key,
                    length_m,
                    share: length_m / n,
                })
                .collect()
        }),
        hills_m: model.has_hills().then_some(hills),
    }
}

fn add_len<K: PartialEq + Copy>(v: &mut Vec<(K, f32)>, k: K, len: f32) {
    if let Some(x) = v.iter_mut().find(|x| x.0 == k) {
        x.1 += len;
    } else {
        v.push((k, len));
    }
}

/// The API form of an arc's breakdown; `compiled` is the router's cost of the arc.
fn arc_explanation(g: &Graph, p: &Profile, a: ArcId, b: &ArcBreakdown, compiled: f32) -> ArcCostExplanation {
    let e = arc_edge(a);
    let len = g.length_m(e);
    let [barriers, steps, dismount, ferry] = b.penalties_m;
    let additive = [
        (AdditiveKind::Climb, b.climb_m),
        (AdditiveKind::Barriers, barriers),
        (AdditiveKind::Steps, steps),
        (AdditiveKind::Dismount, dismount),
        (AdditiveKind::Ferry, ferry),
        (AdditiveKind::Hills, b.hills_m),
    ]
    .into_iter()
    .filter(|(_, m)| *m != 0.0)
    .map(|(kind, metres)| Additive { kind, metres })
    .collect();
    let open = compiled.is_finite();
    ArcCostExplanation {
        arc: a,
        preferences: b
            .terms
            .iter()
            .map(|t| PrefPart {
                id: t.id,
                weight: p.weight(t.id).map_or(0, i32::from),
                membership: t.membership,
                factor: t.factor,
                role: t.role,
                counted: b.structured.is_some().then_some(t.counted),
            })
            .collect(),
        quality: b.quality,
        bonus: b.bonus,
        gate: b.gate,
        raw_factor: b.raw,
        factor: b.factor,
        clamp: b.clamp,
        ascent_m: b.ascent_m,
        grade_up_pct: b.grade_up_pct,
        grade_down_pct: b.grade_down_pct,
        additive,
        extra_m: b.extra_m(),
        cost: open.then_some(compiled),
        cost_per_m: open.then(|| compiled / len.max(0.1)),
        base_cost: None,
        closed_by: b
            .exclusions
            .iter()
            .map(|&x| match x {
                cost::Exclusion::Avoided(row) => Closure {
                    by: ClosedBy::from(x),
                    attribute: "board_row".to_owned(),
                    value: text(row.id()),
                },
                _ => closure(g, a, b, ClosedBy::from(x)),
            })
            .collect(),
        lifted: Vec::new(),
        structured: b.structured.clone(),
    }
}

fn text(s: &str) -> AttrValue {
    AttrValue::Text(s.to_owned())
}

/// What triggers a closure on an arc: the attribute and its value.
fn closure(g: &Graph, a: ArcId, b: &ArcBreakdown, by: ClosedBy) -> Closure {
    let e = arc_edge(a);
    let (attribute, value) = match by {
        ClosedBy::NoBikes | ClosedBy::LegalOnly => ("bike_access", text(g.bike_access(e).label())),
        ClosedBy::NoMainRoads | ClosedBy::NoFerries => ("highway", text(g.highway(e).label())),
        ClosedBy::PavedOnly | ClosedBy::NoUnknownSurface => {
            let (class, conf) = cost::cost_surface(g, e);
            if conf == Confidence::Tagged {
                ("surface_class", text(class.label()))
            } else {
                let how = if conf == Confidence::Weak {
                    "weak"
                } else {
                    "strong"
                };
                ("surface_guess", text(&format!("{} ({how} guess)", class.label())))
            }
        }
        ClosedBy::MaxGrade => (
            "tamed_grade_pct",
            AttrValue::Number(f64::from(b.grade_up_pct.max(b.grade_down_pct))),
        ),
        ClosedBy::MaxMtbScale => {
            if g.mtb_scale(e).code() != 0 {
                ("mtb_scale", text(g.mtb_scale(e).label()))
            } else {
                ("sac_scale", text(g.sac_scale(e).label()))
            }
        }
        ClosedBy::NoStairs => {
            if g.highway(e) == crate::attrs::Highway::Steps {
                ("highway", text("steps"))
            } else if g.sac_scale(e).code() >= 3 {
                ("sac_scale", text(g.sac_scale(e).label()))
            } else {
                ("mtb_scale", text(g.mtb_scale(e).label()))
            }
        }
        ClosedBy::Oneway => ("oneway_bike", text(g.oneway(e).label())),
        // (named by `arc_explanation`, which knows the row)
        ClosedBy::AvoidedSurface | ClosedBy::AvoidedWay => ("board_row", text("")),
    };
    Closure {
        by,
        attribute: attribute.to_owned(),
        value,
    }
}

/// Every attribute the graph keeps for an edge, by its `edges.parquet` column.
fn attributes(g: &Graph, personal: Option<&PersonalLayer>, e: EdgeId) -> Vec<Attribute> {
    let x = g.attrs(e);
    let t = |k: &str, v: &str| (k.to_owned(), Some(text(v)));
    let num = |k: &str, v: Option<f64>| (k.to_owned(), v.map(AttrValue::Number));
    let flag = |k: &str, v: bool| (k.to_owned(), Some(AttrValue::Flag(v)));
    let pct = |k: &str, v: f32| num(k, Some((f64::from(v) * 100.0).round()));
    let dm = |v: f32| f64::from((v * 10.0).round()) / 10.0;
    let mut out = vec![
        num("length_m", Some(dm(x.length_m))),
        t("highway", x.highway.label()),
        t("surface_class", x.surface.label()),
        t("tracktype", x.tracktype.label()),
        t("smoothness", x.smoothness.label()),
        t("oneway_bike", x.oneway.label()),
        t("bike_access", x.bike_access.label()),
        t("motor_access", x.motor_access.label()),
        t("cycleway_kind", x.cycleway.label()),
        t("route_level", x.route_level.label()),
        flag("mtb_route", x.mtb_route),
        num("maxspeed_kmh", x.maxspeed_kmh.map(f64::from)),
        num("lanes", x.lanes.map(f64::from)),
        num("width_m", x.width_m.map(f64::from)),
        t("trail_visibility", x.trail_visibility.label()),
        t("mtb_scale", x.mtb_scale.label()),
        t("sac_scale", x.sac_scale.label()),
        flag("informal", x.informal),
        flag("on_bridge", x.bridge),
        flag("in_tunnel", x.tunnel),
        num("n_barriers", Some(f64::from(x.barriers))),
        pct("forest_share", x.forest),
        pct("forest_edge_share", x.forest_edge),
        pct("water_share", x.water),
        pct("builtup_share", x.builtup),
        pct("road_near_share", x.road_near),
        pct("road_near_traffic", x.road_near_traffic),
        num("ascent_fwd_m", Some(dm(x.ascent_fwd_m))),
        num("ascent_bwd_m", Some(dm(x.ascent_bwd_m))),
        num("max_grade_fwd_pct", Some(f64::from(x.max_grade_fwd_pct))),
        num("max_grade_bwd_pct", Some(f64::from(x.max_grade_bwd_pct))),
    ];
    if let Some(p) = personal.filter(|p| p.fits(g.edge_count())) {
        out.push(num("personal", Some(f64::from(p.rides(e)))));
        out.push(num("personal_days_since", p.days_since(e).map(f64::from)));
    }
    out.into_iter()
        .map(|(attribute, value)| Attribute { attribute, value })
        .collect()
}

/// For the CLI and tests: a closure's words.
#[must_use]
pub fn describe_closure(c: &Closure) -> String {
    let v = match &c.value {
        AttrValue::Text(s) => s.clone(),
        AttrValue::Number(n) => format!("{n}"),
        AttrValue::Flag(b) => b.to_string(),
    };
    format!("{} ({} = {v})", c.by.id(), c.attribute)
}
