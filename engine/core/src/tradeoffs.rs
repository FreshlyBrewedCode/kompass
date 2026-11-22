//! Hard limits as trade-offs (`docs/routing.md`, "Limits as trade-offs"): a limit (paved only, no
//! main roads, legal access, a board row on `avoid`) can send a route on a long detour around a
//! tiny link. [`Planner::tradeoffs`] routes the request again with every limit softened (excluded
//! ways anywhere at `max_factor` per metre, as near a stranded waypoint; never against one-way or a
//! bicycle ban), compares it with the strict route (the [`diff`] stretches) and returns the
//! stretches where the softened route breaks a limit only on a short bit and saves real distance:
//! the limits it breaks, the edges, their length, where, and the distance saved.
//!
//! The same compiled profile serves both (no compile): the softening is the search's exemption
//! layer, everywhere instead of near a waypoint. The plan's overrides hold for both, so an allowed
//! bit is no longer closed and no longer offered.

use serde::{Deserialize, Serialize};

#[cfg(feature = "schema")]
use ts_rs::TS;

use crate::cost::{Exclusion, WayKind, way_kind};
use crate::explain::ClosedBy;
use crate::graph::{ArcId, EdgeId, arc_edge};
use crate::overrides::{self, Overrides};
use crate::route::{Coord, Planner, RouteError, RouteRequest, Span, diff};

/// Which stretches count as trade-offs (against marker spam).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Thresholds {
    /// The limits are broken on at most this many metres (edges counted in full)…
    pub max_broken_m: f32,
    /// …saving at least this many metres of length against the strict route…
    pub min_saved_m: f32,
    /// …and at least this many times the length that breaks them.
    pub min_ratio: f32,
    /// At most this many per route, the most distance saved first.
    pub max: usize,
}

impl Thresholds {
    /// The planner's (`docs/routing.md`, "Limits as trade-offs", for how they were chosen).
    pub const DEFAULT: Thresholds = Thresholds {
        max_broken_m: 300.0,
        min_saved_m: 1000.0,
        min_ratio: 5.0,
        max: 3,
    };

    /// Every stretch that breaks a limit (for tools choosing thresholds).
    pub const ALL: Thresholds = Thresholds {
        max_broken_m: f32::INFINITY,
        min_saved_m: f32::NEG_INFINITY,
        min_ratio: 0.0,
        max: usize::MAX,
    };

    /// Whether a stretch breaking the limits on `broken_m` and saving `saved_m` counts.
    #[must_use]
    pub fn keep(&self, broken_m: f32, saved_m: f32) -> bool {
        broken_m <= self.max_broken_m && saved_m >= self.min_saved_m && saved_m >= self.min_ratio * broken_m
    }
}

/// The `tradeoffs` request: the route request as routed, and optionally the strict route's arcs
/// (`RouteResult::arcs`; absent: routed here too).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct TradeoffRequest {
    pub route: RouteRequest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strict: Option<Vec<ArcId>>,
}

/// A run of consecutive edges of the softened route that break a limit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct TradeoffRun {
    /// In route order.
    pub edges: Vec<EdgeId>,
    /// Metres (edges in full).
    pub length_m: f32,
    /// The way type of its longest edge.
    pub way: WayKind,
    /// Its line as the softened route rides it, `[lon, lat]` (1e-6 degrees).
    pub coordinates: Vec<[f64; 2]>,
}

/// One stretch where breaking a limit on a short bit saves real distance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct Tradeoff {
    /// What the bit breaks: the limits (and avoided board rows), each once, in check order.
    pub limits: Vec<ClosedBy>,
    /// The edges that break them, in route order, as runs of consecutive edges: what an "allow"
    /// of the plan opens.
    pub runs: Vec<TradeoffRun>,
    /// Metres on them (edges in full).
    pub broken_m: f32,
    /// Metres shorter than the strict route's stretch.
    pub saved_m: f32,
    /// The middle of the longest run (the marker).
    pub at: Coord,
    /// The softened stretch's line, `[lon, lat]` (1e-6 degrees): the preview.
    pub coordinates: Vec<[f64; 2]>,
    /// The stretch on the strict route (into its arcs) and on the softened one.
    pub strict: Span,
    pub soft: Span,
}

/// The `tradeoffs` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct Tradeoffs {
    /// The best first, at most [`Thresholds::max`].
    pub tradeoffs: Vec<Tradeoff>,
    /// Stretches where the softened route breaks a limit, before the thresholds.
    pub candidates: u32,
    /// Whether the softened route was searched (not when nothing in the profile closes ways).
    pub searched: bool,
    /// Nodes the softened search settled.
    pub settled: u32,
}

impl Planner {
    /// The trade-offs of a request's limits under [`Thresholds::DEFAULT`].
    pub fn tradeoffs(&mut self, req: &TradeoffRequest) -> Result<Tradeoffs, RouteError> {
        self.tradeoffs_with(req, &Thresholds::DEFAULT)
    }

    /// The trade-offs of a request's limits: route softened, compare with the strict route, keep the
    /// stretches that break a limit within the thresholds. The main profile judges what is closed
    /// (leg profiles are API only).
    #[allow(
        clippy::cast_possible_truncation,
        clippy::too_many_lines,
        reason = "counts fit u32; one pass over the stretches"
    )]
    pub fn tradeoffs_with(
        &mut self,
        req: &TradeoffRequest,
        th: &Thresholds,
    ) -> Result<Tradeoffs, RouteError> {
        let r = &req.route;
        let mut closes = self.cost_view(&r.profile)?.model.closes_ways();
        for p in r.leg_profiles.iter().flatten().flatten() {
            closes |= self.cost_view(p)?.model.closes_ways();
        }
        if !closes {
            return Ok(Tradeoffs::default());
        }
        let strict = match &req.strict {
            Some(a) => a.clone(),
            None => self.route(r)?.arcs,
        };
        if strict
            .iter()
            .any(|&a| arc_edge(a) as usize >= self.graph().edge_count())
        {
            return Err(crate::route::invalid_request(
                "strict: an arc is not in the graph".into(),
            ));
        }
        let mut soft_req = r.clone();
        soft_req.options.geometry = true;
        let soft = self.route_softened(&soft_req)?;
        let settled = soft.legs.iter().map(|l| l.settled).sum();
        let d = diff(self.graph(), &strict, &soft.arcs);
        let view = self.cost_view(&r.profile)?;
        let (g, costs) = (view.graph, view.costs);
        let list = r.overrides.as_deref().unwrap_or(&[]);
        let ov = (!list.is_empty()).then(|| Overrides::build(g, view.model, view.personal, costs, list));
        let Some(geo) = soft.geometry.as_ref() else {
            return Err(crate::route::invalid_request("no geometry".into()));
        };
        let last_vertex = geo.coordinates.len().saturating_sub(1);
        let vertex = |i: usize| soft.arc_vertex.get(i).map_or(last_vertex, |&v| v as usize);
        let mut out = Tradeoffs {
            searched: true,
            settled,
            ..Tradeoffs::default()
        };
        for st in &d.stretches {
            let [s0, s1] = st.b.arcs.map(|x| x as usize);
            // per run its edges, its arcs `[first, end)` in the softened route, its length and its
            // longest edge
            let mut runs: Vec<Vec<EdgeId>> = Vec::new();
            let mut spans: Vec<(usize, usize, f32, (EdgeId, f32))> = Vec::new();
            let mut limits: Vec<ClosedBy> = Vec::new();
            let mut broken = 0.0f32;
            for (i, &a) in soft.arcs.iter().enumerate().take(s1).skip(s0) {
                if overrides::arc_cost(ov.as_ref(), costs, a).is_finite() {
                    continue;
                }
                let e = arc_edge(a);
                let len = g.length_m(e);
                broken += len;
                for x in view.model.breakdown(g, view.personal, a).exclusions {
                    if !matches!(x, Exclusion::NoBikes | Exclusion::Oneway) {
                        let c = ClosedBy::from(x);
                        if !limits.contains(&c) {
                            limits.push(c);
                        }
                    }
                }
                match spans.last_mut() {
                    Some(sp) if sp.1 == i => {
                        sp.1 = i + 1;
                        sp.2 += len;
                        if len > sp.3.1 {
                            sp.3 = (e, len);
                        }
                        if let Some(run) = runs.last_mut()
                            && run.last() != Some(&e)
                        {
                            run.push(e);
                        }
                    }
                    _ => {
                        spans.push((i, i + 1, len, (e, len)));
                        runs.push(vec![e]);
                    }
                }
            }
            if broken <= 0.0 || limits.is_empty() {
                continue;
            }
            out.candidates += 1;
            let saved = st.a.length_m - st.b.length_m;
            if !th.keep(broken, saved) {
                continue;
            }
            limits.sort_by_key(|c| c.code());
            // the marker: halfway along the longest run, by distance
            let Some(&(r0, r1, ..)) = spans.iter().max_by(|x, y| x.2.total_cmp(&y.2)) else {
                continue;
            };
            let range = |r0: usize, r1: usize| vertex(r0)..=vertex(r1).max(vertex(r0));
            let at = midpoint(&geo.coordinates[range(r0, r1)], &geo.distance_m[range(r0, r1)]);
            let runs = runs
                .into_iter()
                .zip(&spans)
                .map(|(edges, &(r0, r1, length_m, (longest, _)))| TradeoffRun {
                    edges,
                    length_m,
                    way: way_kind(g, longest),
                    coordinates: geo.coordinates[range(r0, r1)].to_vec(),
                })
                .collect();
            out.tradeoffs.push(Tradeoff {
                limits,
                runs,
                broken_m: broken,
                saved_m: saved,
                at,
                coordinates: geo.coordinates[vertex(s0)..=vertex(s1).max(vertex(s0))].to_vec(),
                strict: st.a,
                soft: st.b,
            });
        }
        out.tradeoffs.sort_by(|x, y| y.saved_m.total_cmp(&x.saved_m));
        out.tradeoffs.truncate(th.max);
        Ok(out)
    }
}

/// The point halfway along a line by its distances.
fn midpoint(coords: &[[f64; 2]], dist: &[f32]) -> Coord {
    let (Some(first), Some(&d0), Some(&d1)) = (coords.first(), dist.first(), dist.last()) else {
        return Coord { lon: 0.0, lat: 0.0 };
    };
    let mid = f32::midpoint(d0, d1);
    for k in 1..coords.len() {
        if dist[k] >= mid {
            let span = dist[k] - dist[k - 1];
            let t = if span > 0.0 {
                f64::from((mid - dist[k - 1]) / span)
            } else {
                0.0
            };
            let (p, q) = (coords[k - 1], coords[k]);
            return Coord {
                lon: round6(p[0] + (q[0] - p[0]) * t),
                lat: round6(p[1] + (q[1] - p[1]) * t),
            };
        }
    }
    Coord {
        lon: first[0],
        lat: first[1],
    }
}

fn round6(v: f64) -> f64 {
    (v * 1e6).round() / 1e6
}
