//! Per-plan edge overrides (`docs/routing.md`, "This plan's exceptions"): a plan's few exceptions to
//! its profile, by edge, applied per request on top of the compiled profile (which stays compiled and
//! cached, like the reuse overlay of [`crate::search::Overlay`]).
//!
//! - **avoid**: the edge costs [`AVOID_M`] metres more per full arc, in either direction (finite: a
//!   route that has no other way, or a stop on the edge, still works; a part of it costs that part of
//!   the penalty, so a stop on it leaves by the nearer end).
//! - **prefer**: the edge counts as cheap as the profile's bounds allow, `min_factor × length` plus its
//!   additive terms, and the limits do not close it.
//! - **allow**: the limits do not close the edge; it is costed as if they were off. A bicycle ban and
//!   one-way still hold (for prefer too).
//!
//! The A* bound takes the smallest cost per metre an override produces ([`Overrides::bound`]), so it
//! stays valid when an override is cheaper than anything the compile produced.
//!
//! Plus [`Planner::edge_run`]: the run of edges a rider means by "this segment", the pressed edge
//! extended through nodes where nothing branches off, up to the next real junctions.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[cfg(feature = "schema")]
use ts_rs::TS;

use crate::cost::{CostModel, Exclusion};
use crate::graph::{ArcId, EdgeId, Graph, NodeId, arc_edge, arc_is_reverse};
use crate::personal::PersonalLayer;
use crate::route::{Planner, RouteError, invalid_request};

/// What an override does to its edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub enum OverrideKind {
    /// Not ridden unless there is no other way ([`AVOID_M`] per full arc on top).
    Avoid,
    /// Counts at the profile's `min_factor` (plus its additive terms); the limits do not close it.
    Prefer,
    /// The limits do not close it (a bicycle ban and one-way still do); costed as if they were off.
    Allow,
}

/// One edge's exception in a plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct EdgeOverride {
    pub edge: EdgeId,
    pub kind: OverrideKind,
}

/// The overrides a route rode, by edge: what the route used (prefer, allow) or could not get around
/// (avoid).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct OverrideUse {
    pub edge: EdgeId,
    pub kind: OverrideKind,
    /// Metres of the route on it.
    pub length_m: f32,
}

/// An avoided edge costs this many metres more per full arc: the route takes any other way that
/// costs less than 100 km more.
pub const AVOID_M: f32 = 100_000.0;

/// Overrides per request: at most this many (a plan's exceptions are a handful of runs).
pub const MAX_OVERRIDES: usize = 4096;

/// [`Planner::edge_run`] stops after this many edges.
pub const RUN_MAX_EDGES: usize = 256;

#[derive(Debug, Clone, Copy)]
struct Entry {
    kind: OverrideKind,
    /// What the search pays per full arc, along and against the geometry (infinite: closed).
    cost: [f32; 2],
    /// The profile's cost of the arc without the override, a lifted limit counted as lifted
    /// (infinite where it stays closed).
    base: [f32; 2],
    /// Whether the override opens an arc a limit closes.
    lifted: [bool; 2],
}

/// The overrides of one request under one compiled profile: a bit per edge says whether it has one
/// (an edge without costs one bit test), a map holds the few that do.
#[derive(Debug, Clone)]
pub struct Overrides {
    mask: Vec<u64>,
    entries: HashMap<EdgeId, Entry>,
    /// The smallest cost per metre an override produces (infinite: none lowers anything).
    min_per_m: f32,
}

/// Checks a request's overrides: edges in the graph, each edge once.
pub fn check(list: &[EdgeOverride], edges: usize) -> Result<(), RouteError> {
    if list.len() > MAX_OVERRIDES {
        return Err(invalid_request(format!(
            "{} overrides, at most {MAX_OVERRIDES}",
            list.len()
        )));
    }
    let mut seen = std::collections::HashSet::with_capacity(list.len());
    for o in list {
        if o.edge as usize >= edges {
            return Err(invalid_request(format!(
                "override: edge {} is not in the graph",
                o.edge
            )));
        }
        if !seen.insert(o.edge) {
            return Err(invalid_request(format!(
                "override: edge {} is listed twice",
                o.edge
            )));
        }
    }
    Ok(())
}

impl Overrides {
    /// The overrides under a compiled profile (`costs` its compiled cost per arc). `list` must have
    /// passed [`check`].
    #[must_use]
    pub fn build(
        g: &Graph,
        model: &CostModel,
        personal: Option<&PersonalLayer>,
        costs: &[f32],
        list: &[EdgeOverride],
    ) -> Overrides {
        let mut out = Overrides {
            mask: vec![0; g.edge_count().div_ceil(64)],
            entries: HashMap::with_capacity(list.len()),
            min_per_m: f32::INFINITY,
        };
        for o in list {
            let e = o.edge;
            let len = g.length_m(e);
            let mut entry = Entry {
                kind: o.kind,
                cost: [f32::INFINITY; 2],
                base: [f32::INFINITY; 2],
                lifted: [false; 2],
            };
            for dir in 0..2 {
                let a = crate::graph::arc(e, dir == 1);
                let compiled = costs[a as usize];
                // the cost with the limits off: only a bicycle ban or one-way still closes it
                let lifted = if compiled.is_finite() || o.kind == OverrideKind::Avoid {
                    compiled
                } else {
                    let b = model.breakdown(g, personal, a);
                    let hard = b
                        .exclusions
                        .iter()
                        .any(|x| matches!(x, Exclusion::NoBikes | Exclusion::Oneway));
                    if hard {
                        f32::INFINITY
                    } else {
                        len * b.factor + b.extra_m()
                    }
                };
                let (cost, base) = match o.kind {
                    OverrideKind::Avoid => (compiled + AVOID_M, compiled),
                    OverrideKind::Allow => (lifted, lifted),
                    OverrideKind::Prefer => {
                        let floor = if lifted.is_finite() {
                            let extra = model.breakdown(g, personal, a).extra_m();
                            (len * model.min_factor + extra).min(lifted)
                        } else {
                            f32::INFINITY
                        };
                        (floor, lifted)
                    }
                };
                entry.cost[dir] = cost;
                entry.base[dir] = base;
                entry.lifted[dir] = !compiled.is_finite() && cost.is_finite();
                if cost.is_finite() && len > 0.0 {
                    out.min_per_m = out.min_per_m.min(cost / len);
                }
            }
            out.mask[e as usize >> 6] |= 1 << (e & 63);
            out.entries.insert(e, entry);
        }
        out
    }

    /// Whether nothing is overridden.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    #[inline]
    #[must_use]
    pub fn marked(&self, e: EdgeId) -> bool {
        self.mask[e as usize >> 6] & (1 << (e & 63)) != 0
    }

    #[must_use]
    pub fn kind(&self, e: EdgeId) -> Option<OverrideKind> {
        if !self.marked(e) {
            return None;
        }
        self.entries.get(&e).map(|x| x.kind)
    }

    fn entry(&self, a: ArcId) -> Option<(&Entry, usize)> {
        let e = arc_edge(a);
        if !self.marked(e) {
            return None;
        }
        self.entries.get(&e).map(|x| (x, usize::from(arc_is_reverse(a))))
    }

    /// What the search pays for the full arc `a`: the override's cost, else the compiled one.
    #[inline]
    #[must_use]
    pub fn cost(&self, costs: &[f32], a: ArcId) -> f32 {
        match self.entry(a) {
            Some((x, d)) => x.cost[d],
            None => costs[a as usize],
        }
    }

    /// The profile's cost of the full arc `a` without the override (a lifted limit counted as
    /// lifted): `cost − base` is what the override added (< 0 for prefer).
    #[must_use]
    pub fn base(&self, costs: &[f32], a: ArcId) -> f32 {
        match self.entry(a) {
            Some((x, d)) => x.base[d],
            None => costs[a as usize],
        }
    }

    /// Whether the override opens arc `a`, which a limit closes.
    #[must_use]
    pub fn lifted(&self, a: ArcId) -> bool {
        self.entry(a).is_some_and(|(x, d)| x.lifted[d])
    }

    /// The A* bound per metre with the overrides: the smaller of the compiled one and the cheapest
    /// override.
    #[must_use]
    pub fn bound(&self, compiled: f32) -> f32 {
        compiled.min(self.min_per_m)
    }
}

/// The cost of the full arc `a` with the overrides, if any.
#[inline]
#[must_use]
pub fn arc_cost(o: Option<&Overrides>, costs: &[f32], a: ArcId) -> f32 {
    match o {
        Some(o) => o.cost(costs, a),
        None => costs[a as usize],
    }
}

/// [`Planner::edge_run`]: the run of edges between two real junctions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct EdgeRun {
    /// The edges in order along the run (the asked-for one among them).
    pub edges: Vec<EdgeId>,
    /// The asked-for edge's index in `edges`.
    pub index: u32,
    pub length_m: f32,
    /// The run's line, `[lon, lat]` (1e-6 degrees), in the order of `edges`.
    pub coordinates: Vec<[f64; 2]>,
}

impl Planner {
    /// "This segment" for a rider: edge `e` extended along the way through every node where only
    /// one other edge meets it (nothing branches off), up to the next real junctions or dead ends
    /// (at most [`RUN_MAX_EDGES`]). Avoiding one edge of such a chain avoids all of it for a route
    /// through it anyway; preferring or allowing needs all of it.
    pub fn edge_run(&self, e: EdgeId) -> Result<EdgeRun, RouteError> {
        let g = self.graph();
        if e as usize >= g.edge_count() {
            return Err(invalid_request(format!("edge {e} is not in the graph")));
        }
        // (edge, reversed relative to the run's direction)
        let ahead = walk(g, e, g.to(e), RUN_MAX_EDGES);
        let behind = walk(g, e, g.from(e), RUN_MAX_EDGES.saturating_sub(ahead.len()));
        let mut run: Vec<(EdgeId, bool)> = behind
            .iter()
            .rev()
            .filter(|(x, _)| !ahead.iter().any(|(y, _)| y == x))
            // walked away from the run's start: ridden towards it, so the other way round
            .map(|&(x, rev)| (x, !rev))
            .collect();
        let index = u32::try_from(run.len()).unwrap_or(u32::MAX);
        run.push((e, false));
        run.extend(ahead);
        let mut coordinates: Vec<[f64; 2]> = Vec::new();
        for &(x, rev) in &run {
            let mut pts: Vec<(i32, i32)> = g.edge_points(x).collect();
            if rev {
                pts.reverse();
            }
            for (i, p) in pts.into_iter().enumerate() {
                if i == 0 && !coordinates.is_empty() {
                    continue; // the join is the previous edge's last point
                }
                coordinates.push([round6(f64::from(p.0) * 1e-7), round6(f64::from(p.1) * 1e-7)]);
            }
        }
        Ok(EdgeRun {
            length_m: run.iter().map(|&(x, _)| g.length_m(x)).sum(),
            edges: run.into_iter().map(|(x, _)| x).collect(),
            index,
            coordinates,
        })
    }
}

/// From `start` at node `v` onwards while exactly two edges meet: the edges and whether each is
/// walked against its geometry.
fn walk(g: &Graph, start: EdgeId, v: NodeId, max: usize) -> Vec<(EdgeId, bool)> {
    let mut out: Vec<(EdgeId, bool)> = Vec::new();
    let (mut e, mut v) = (start, v);
    while out.len() < max {
        let (arcs, _) = g.arcs_at(v);
        if arcs.len() != 2 {
            break; // a junction, or a dead end
        }
        let Some(next) = arcs.iter().map(|&a| arc_edge(a)).find(|&x| x != e) else {
            break; // a loop edge
        };
        if next == start || out.iter().any(|&(x, _)| x == next) {
            break; // round a closed ring
        }
        let rev = g.from(next) != v;
        v = if rev { g.from(next) } else { g.to(next) };
        out.push((next, rev));
        e = next;
    }
    out
}

fn round6(v: f64) -> f64 {
    (v * 1e6).round() / 1e6
}
