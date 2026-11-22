//! Plain A* over compiled arc costs (spike #4: fast enough, no landmarks, no corridor, no
//! contraction). One [`Search`] is allocated per graph and reused: a generation counter resets it
//! in O(1), so a query allocates nothing but its heap's growth.
//!
//! A label is an arc, having arrived at its head by it, because the turn cost ([`crate::turns`])
//! depends on the way a node was reached. Beside the labels each node keeps its cheapest one so
//! far; a label dearer than that by more than any turn can cost (a U-turn) is dominated and
//! dropped. So with turns free the search is the plain node search (every node settles once), and
//! with a turn cost a node settles once per way in that is worth keeping.
//!
//! Sources and targets are points on edges, not nodes: a search starts with labels on the source
//! edge's end nodes (the partial arcs from the point) and ends on the target edge's end nodes plus
//! the partial arc to the point (and the turn onto it). The bound is `factor × straight-line
//! distance` to the target point on a plane that never overestimates (longitudes scaled by the
//! cosine of the region's highest latitude, minus 1 % for the lengths' projection), so it is
//! consistent.
//!
//! Per-request costs ride on top of the compiled ones without touching them (the compiled profile
//! stays cached): an [`Overlay`] adds metres to edges (today the reuse penalty on the edges earlier
//! legs rode, in either direction), a [`UTurn`] to leaving a via back the way it was reached, the
//! turns to every move at a junction. All only add, so the bound stays valid. The plan's edge
//! overrides ([`crate::overrides`]) replace the cost of their arcs; the caller lowers the bound to
//! the cheapest of them.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

use crate::graph::{ArcId, EdgeId, Graph, NodeId, arc_edge};
use crate::overrides::{Overrides, arc_cost};
use crate::turns::Headings;

/// No parent: a source label (the low 31 bits of a parent).
const NONE: u32 = u32::MAX >> 1;

/// Planar metres per 1e-7 degree that never overestimate distances inside a graph.
#[derive(Debug, Clone, Copy)]
pub struct Plane {
    kx: f32,
    ky: f32,
}

impl Plane {
    #[must_use]
    #[allow(clippy::cast_possible_truncation, reason = "a scale factor")]
    pub fn for_graph(g: &Graph) -> Plane {
        let [_, s, _, n] = g.info().bbox;
        let max_abs_lat = s.unsigned_abs().max(n.unsigned_abs());
        let cos = (f64::from(max_abs_lat) * 1e-7).to_radians().cos() as f32;
        let m = crate::M_PER_E7 as f32;
        Plane {
            kx: m * cos * 0.99,
            ky: m * 0.99,
        }
    }

    #[inline]
    #[must_use]
    #[allow(clippy::cast_precision_loss, reason = "coordinate deltas")]
    pub fn dist(&self, a: (i32, i32), b: (i32, i32)) -> f32 {
        let dx = (a.0 - b.0) as f32 * self.kx;
        let dy = (a.1 - b.1) as f32 * self.ky;
        (dx * dx + dy * dy).sqrt()
    }
}

/// Costs on top of the compiled profile for one request, by edge and in either direction: the
/// reuse penalty, `per_m` extra metres per metre of an edge ridden again (only the part ridden
/// before counts: a leg that starts or ends mid-edge marks only that part).
///
/// A bit per edge says whether it has an entry, so an edge without one costs one bit test (the
/// map is looked at only for the few marked edges). The plan's edge overrides have the same shape
/// ([`crate::overrides::Overrides`]).
#[derive(Debug, Clone)]
pub struct Overlay {
    mask: Vec<u64>,
    /// Per marked edge: the ridden part `[lo, hi]`, fractions along its geometry (a hull when
    /// several pieces of one edge were ridden).
    ridden: HashMap<EdgeId, (f32, f32)>,
    /// Extra metres per metre ridden again.
    pub per_m: f32,
}

impl Overlay {
    #[must_use]
    pub fn new(edges: usize, per_m: f32) -> Overlay {
        Overlay {
            mask: vec![0; edges.div_ceil(64)],
            ridden: HashMap::new(),
            per_m,
        }
    }

    /// Whether nothing is marked.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.ridden.is_empty()
    }

    /// Marks the part `t0..t1` (either order) of edge `e` as ridden.
    pub fn mark(&mut self, e: EdgeId, t0: f32, t1: f32) {
        let (lo, hi) = (t0.min(t1), t0.max(t1));
        self.mask[e as usize >> 6] |= 1 << (e & 63);
        self.ridden
            .entry(e)
            .and_modify(|r| *r = (r.0.min(lo), r.1.max(hi)))
            .or_insert((lo, hi));
    }

    #[inline]
    #[must_use]
    pub fn marked(&self, e: EdgeId) -> bool {
        self.mask[e as usize >> 6] & (1 << (e & 63)) != 0
    }

    /// Metres of riding `t0..t1` of edge `e` that were ridden before.
    #[must_use]
    pub fn reused_m(&self, g: &Graph, e: EdgeId, t0: f32, t1: f32) -> f32 {
        if !self.marked(e) {
            return 0.0;
        }
        let Some(&(lo, hi)) = self.ridden.get(&e) else {
            return 0.0;
        };
        let overlap = t0.max(t1).min(hi) - t0.min(t1).max(lo);
        if overlap <= 0.0 {
            0.0
        } else {
            overlap * g.length_m(e)
        }
    }

    /// The extra cost of riding `t0..t1` of edge `e`.
    #[inline]
    #[must_use]
    pub fn extra(&self, g: &Graph, e: EdgeId, t0: f32, t1: f32) -> f32 {
        self.reused_m(g, e, t0, t1) * self.per_m
    }
}

/// Leaving a via back along the arc it was reached by costs extra: `arc` (the reverse of the
/// arrival) taken first from `node`, a source of the search, as a full arc or as the partial arc
/// of target `target` (the index into [`Query::targets`] whose tail rides `arc`, if any): riding
/// on to the next node and back is a U-turn too.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UTurn {
    pub node: NodeId,
    pub arc: ArcId,
    pub target: Option<usize>,
    pub cost: f32,
}

/// Where a search may start: at `node`, having arrived by `arc` (the partial arc from the point,
/// the search's state for it) at `cost`; the first turn there counts from `turn_from`'s arrival
/// heading (`None`: no turn is charged, the route starts at the node).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Source {
    pub node: NodeId,
    pub arc: ArcId,
    pub cost: f32,
    pub turn_from: Option<ArcId>,
}

/// Where a search may end: at `node`, then `cost` to the point along `arc` (the partial arc from
/// the node, the turn onto it charged; `None`: the point is at the node, no turn).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Target {
    pub node: NodeId,
    pub arc: Option<ArcId>,
    pub cost: f32,
}

/// The turn cost of one search (`turns::shares_at`): `turn_m` per right-angle turn.
#[derive(Debug, Clone, Copy)]
pub struct Turns<'a> {
    pub headings: &'a Headings,
    pub turn_m: f32,
}

/// What one search found.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub cost: f32,
    /// The source the path starts from (index into [`Query::sources`]).
    pub source: usize,
    /// The target it ends at (index into [`Query::targets`]).
    pub target: usize,
    /// Full arcs from the source's node to the target's (empty when they are the same node).
    pub arcs: Vec<ArcId>,
}

/// One search's inputs.
#[derive(Debug, Clone)]
pub struct Query<'a> {
    /// Compiled cost per arc (infinite: not allowed).
    pub costs: &'a [f32],
    pub plane: Plane,
    /// The factor of the straight-line bound (the smallest factor the profile produced).
    pub bound: f32,
    pub sources: &'a [Source],
    pub targets: &'a [Target],
    /// The target point, 1e-7 degrees.
    pub target: (i32, i32),
    /// A cost already known (the direct way along one edge): only something cheaper is returned.
    pub best: f32,
    /// Excluded ways usable near some points.
    pub exempt: Option<Exempt<'a>>,
    /// Costs on top of the compiled ones (`None`: nothing marked).
    pub overlay: Option<&'a Overlay>,
    /// The U-turn at the via this leg starts from.
    pub uturn: Option<UTurn>,
    /// The plan's edge overrides (their arcs cost what they say instead of `costs`).
    pub overrides: Option<&'a Overrides>,
    /// The turn cost (`None`: turns are free).
    pub turns: Option<Turns<'a>>,
}

/// Near a waypoint whose way a limit excludes, excluded arcs may be ridden at `max_factor` per
/// metre (never against one-way or where bikes are banned), so a route can get away from it.
#[derive(Debug, Clone)]
pub struct Exempt<'a> {
    pub plane: Plane,
    pub points: &'a [(i32, i32)],
    pub radius_m: f32,
    pub max_factor: f32,
}

impl Exempt<'_> {
    /// The cost of an excluded arc `a` (leading to `w`) if the exemption covers it.
    #[inline]
    fn cost(&self, g: &Graph, a: ArcId, w: NodeId) -> Option<f32> {
        let e = crate::graph::arc_edge(a);
        if !g.arc_allowed(a) || g.bike_access(e) == crate::attrs::BikeAccess::No {
            return None;
        }
        let at = g.node_e7(w);
        self.points
            .iter()
            .any(|&p| self.plane.dist(at, p) <= self.radius_m)
            .then(|| g.length_m(e) * self.max_factor)
    }
}

/// The parent's top bit: the label is settled.
const CLOSED: u32 = 1 << 31;

/// The reusable state. A label is an arc, having arrived at its head by it, because the turn cost
/// depends on it. Per node the cheapest label so far is kept beside, and a label dearer than it by more than any turn can cost is dominated and dropped:
/// whatever it could do next, the cheaper label does for less (it may not turn back where it came
/// from, but then the path that does is beaten where it parts from the cheaper label's own path).
/// With free turns that is the plain node search: every node settles once.
#[derive(Debug, Clone)]
pub struct Search {
    /// Per node: the stamp (`generation << 8`, its labels valid when the generation is this
    /// search's) with the most a turn there costs in the low byte (hundredths of a turn,
    /// [`Headings::max_share`]; kept across searches), and the cheapest label at it so far.
    nodes: Vec<NodeLabel>,
    /// Per arc: the cost of arriving by it, and the label it was reached from ([`NONE`]: a
    /// source; [`CLOSED`] when settled).
    arcs: Vec<ArcLabel>,
    generation: u32,
    heap: BinaryHeap<Reverse<u64>>,
    queue: Vec<NodeId>,
    shares: Vec<f32>,
    /// Labels settled by the last search.
    pub settled: usize,
}

#[derive(Debug, Clone, Copy)]
struct NodeLabel {
    stamp: u32,
    min: f32,
}

#[derive(Debug, Clone, Copy)]
struct ArcLabel {
    dist: f32,
    parent: u32,
}

/// The generation lives above the stamp's low byte.
const GEN_SHIFT: u32 = 8;

#[inline]
fn key(k: f32, v: u32) -> Reverse<u64> {
    // non-negative floats order like their bits
    Reverse((u64::from(k.to_bits()) << 32) | u64::from(v))
}

#[inline]
#[allow(clippy::cast_possible_truncation, reason = "unpacking the key")]
fn unkey(k: u64) -> (f32, u32) {
    (f32::from_bits((k >> 32) as u32), k as u32)
}

impl Search {
    /// The state for a graph, with the most a turn costs per node (`None`: assumed the most there
    /// is, which keeps the search exact but prunes less).
    #[must_use]
    pub fn new(nodes: usize, arcs: usize, headings: Option<&Headings>) -> Search {
        Search {
            nodes: (0..nodes)
                .map(|v| NodeLabel {
                    #[allow(clippy::cast_possible_truncation, reason = "node ids fit u32")]
                    stamp: u32::from(headings.map_or(u8::MAX, |h| h.max_share_byte(v as NodeId))),
                    min: f32::INFINITY,
                })
                .collect(),
            arcs: vec![
                ArcLabel {
                    dist: f32::INFINITY,
                    parent: NONE,
                };
                arcs
            ],
            generation: 0,
            heap: BinaryHeap::new(),
            queue: Vec::new(),
            shares: Vec::new(),
            settled: 0,
        }
    }

    /// Whether `starts` sit in a small pocket the profile cuts off: fewer than `limit` nodes can
    /// be reached from them over allowed arcs (`forward`; backward: reach them), none of them in
    /// `others`.
    #[allow(clippy::too_many_arguments, reason = "the walk's inputs")]
    pub fn cut_off(
        &mut self,
        g: &Graph,
        costs: &[f32],
        overrides: Option<&Overrides>,
        starts: &[NodeId],
        others: &[NodeId],
        limit: usize,
        forward: bool,
    ) -> bool {
        self.reset(g);
        self.queue.clear();
        let mut seen = 0usize;
        for &s in starts {
            if !self.seen(s) {
                self.mark(s);
                self.queue.push(s);
                seen += 1;
            }
        }
        let mut i = 0;
        while i < self.queue.len() {
            if seen >= limit {
                return false;
            }
            let v = self.queue[i];
            i += 1;
            let (arcs, flags) = g.arcs_at(v);
            for (&a, &f) in arcs.iter().zip(flags) {
                // forward: the slot's arc leaves v; backward: its opposite arrives at v
                let (ok, arc) = if forward {
                    (f & crate::graph::flags::OUT != 0, a)
                } else {
                    (f & crate::graph::flags::IN != 0, a ^ 1)
                };
                if !ok || !arc_cost(overrides, costs, arc).is_finite() {
                    continue;
                }
                let w = if forward { g.head(arc) } else { g.tail(arc) };
                if !self.seen(w) {
                    self.mark(w);
                    self.queue.push(w);
                    seen += 1;
                }
            }
        }
        seen < limit && others.iter().all(|&o| !self.seen(o))
    }

    /// Heap bytes held.
    #[must_use]
    pub fn heap_bytes(&self) -> usize {
        self.nodes.capacity() * 8 + self.arcs.capacity() * 8 + self.heap.capacity() * 8
    }

    fn reset(&mut self, g: &Graph) {
        if self.nodes.len() != g.node_count() || self.arcs.len() != g.arc_count() {
            *self = Search::new(g.node_count(), g.arc_count(), None);
        }
        self.generation += 1;
        if self.generation >= u32::MAX >> GEN_SHIFT {
            for n in &mut self.nodes {
                n.stamp &= 0xff;
            }
            self.generation = 1;
        }
        self.heap.clear();
        self.settled = 0;
    }

    #[inline]
    fn seen(&self, v: NodeId) -> bool {
        self.nodes[v as usize].stamp >> GEN_SHIFT == self.generation
    }

    #[inline]
    fn mark(&mut self, v: NodeId) {
        let n = &mut self.nodes[v as usize];
        n.stamp = (self.generation << GEN_SHIFT) | (n.stamp & 0xff);
    }

    /// The most a turn at `v` costs, in turns.
    #[inline]
    fn max_share(&self, v: NodeId) -> f32 {
        f32::from((self.nodes[v as usize].stamp & 0xff) as u8) * 0.01
    }

    /// Makes `v`'s labels valid for this search (every arc into it unreached).
    #[inline]
    fn touch(&mut self, g: &Graph, v: NodeId) {
        if self.seen(v) {
            return;
        }
        self.mark(v);
        self.nodes[v as usize].min = f32::INFINITY;
        for &a in g.arcs_at(v).0 {
            self.arcs[(a ^ 1) as usize] = ArcLabel {
                dist: f32::INFINITY,
                parent: NONE,
            };
        }
    }

    /// Labels arc `a` (into `v`) with `d` from `parent` unless it is dominated; true if labelled.
    #[inline]
    fn label(&mut self, v: NodeId, a: ArcId, d: f32, parent: u32, slack: f32) -> bool {
        let l = self.arcs[a as usize];
        let n = &mut self.nodes[v as usize];
        if d >= l.dist || l.parent & CLOSED != 0 || d > n.min + slack {
            return false;
        }
        if d < n.min {
            n.min = d;
        }
        self.arcs[a as usize] = ArcLabel { dist: d, parent };
        true
    }

    /// A* from the sources' labels to the targets. `None` if nothing cheaper than `q.best` is
    /// reachable.
    #[allow(clippy::too_many_lines, reason = "one search loop")]
    pub fn run(&mut self, g: &Graph, q: &Query<'_>) -> Option<Found> {
        self.reset(g);
        let (plane, bound, target) = (q.plane, q.bound, q.target);
        let h = |v: NodeId| plane.dist(g.node_e7(v), target) * bound;
        let turn_m = q.turns.map_or(0.0, |t| t.turn_m);
        // the most a turn at a node can cost: a label dearer than the cheapest there by more is
        // dominated (U-turns aside: only a source may take one, at a turn's most and, at the via,
        // the U-turn's cost on top)
        let uturn_m = turn_m * crate::turns::MAX_SHARE;
        let source_nodes = [0, 1].map(|i| q.sources.get(i).map_or(NONE, |s| s.node));
        let slack_at = |me: &Search, v: NodeId| {
            let mut x = turn_m * me.max_share(v);
            if source_nodes.contains(&v) {
                x += uturn_m + q.uturn.filter(|u| u.node == v).map_or(0.0, |u| u.cost);
            }
            x
        };
        for s in q.sources {
            if s.cost.is_finite() {
                self.touch(g, s.node);
                let slack = slack_at(self, s.node);
                if self.label(s.node, s.arc, s.cost, NONE, slack) {
                    self.heap.push(key(s.cost + h(s.node), s.arc));
                }
            }
        }
        let mut best = q.best;
        let mut best_end: Option<(u32, usize)> = None;
        let mut shares = std::mem::take(&mut self.shares);
        let mut scratch = Vec::new();
        while let Some(Reverse(k)) = self.heap.pop() {
            let (f, a) = unkey(k);
            if f >= best {
                break;
            }
            let li = a as usize;
            let l = self.arcs[li];
            if l.parent & CLOSED != 0 {
                continue;
            }
            let v = g.head(a);
            let dv = l.dist;
            if dv > self.nodes[v as usize].min + slack_at(self, v) {
                continue;
            }
            let is_source = l.parent == NONE;
            self.arcs[li].parent |= CLOSED;
            self.settled += 1;
            // the arrival the turns count from
            let from = if is_source {
                q.sources.iter().find(|s| s.arc == a).and_then(|s| s.turn_from)
            } else {
                Some(a)
            }
            .filter(|&x| g.head(x) == v);
            let turns = q.turns.filter(|_| turn_m > 0.0).zip(from);
            match turns {
                // (no junction: free, and only a source may turn back)
                Some((t, x)) if is_source || g.arcs_at(v).0.len() >= 3 => {
                    crate::turns::shares_at(g, t.headings, x, &mut shares);
                }
                _ => shares.clear(),
            }
            // the via's node, still as the source labelled it
            let uturn = q.uturn.filter(|u| u.node == v && is_source);
            for (i, t) in q.targets.iter().enumerate() {
                // (on along the target edge past the point and back: the other target is cheaper)
                if t.node != v || (!is_source && t.arc == Some(a ^ 1)) {
                    continue;
                }
                let mut d = dv + t.cost;
                if let (Some(b), Some((tt, x))) = (t.arc, turns) {
                    d += tt.turn_m * crate::turns::share_between(g, tt.headings, x, b, &mut scratch);
                }
                if let Some(u) = uturn
                    && u.target == Some(i)
                {
                    d += u.cost;
                }
                if d < best {
                    best = d;
                    best_end = Some((a, i));
                }
            }
            let (arcs, flags) = g.arcs_at(v);
            for (k, (&b, &fl)) in arcs.iter().zip(flags).enumerate() {
                // no U-turns on the way (as the node search): only from the via, where the U-turn
                // cost applies; so a dominated label is never needed to turn back where the
                // cheaper one came from
                if fl & crate::graph::flags::OUT == 0 || (b == a ^ 1 && !is_source) {
                    continue;
                }
                let mut c = arc_cost(q.overrides, q.costs, b);
                let w = g.head(b);
                if !c.is_finite() {
                    match &q.exempt {
                        Some(x) => match x.cost(g, b, w) {
                            Some(cx) => c = cx,
                            None => continue,
                        },
                        None => continue,
                    }
                }
                if let Some(o) = q.overlay {
                    let e = arc_edge(b);
                    if o.marked(e) {
                        c += o.extra(g, e, 0.0, 1.0);
                    }
                }
                if let Some(u) = uturn
                    && u.arc == b
                {
                    c += u.cost;
                }
                if let Some(&s) = shares.get(k) {
                    c += s * turn_m;
                }
                let d = dv + c;
                self.touch(g, w);
                let slack = slack_at(self, w);
                if self.label(w, b, d, a, slack) {
                    self.heap.push(key(d + h(w), b));
                }
            }
        }
        self.shares = shares;
        let (end, target) = best_end?;
        let mut arcs = Vec::new();
        let mut l = end;
        loop {
            let p = self.arcs[l as usize].parent & !CLOSED;
            if p == NONE {
                break;
            }
            arcs.push(l);
            l = p;
        }
        arcs.reverse();
        let source = q.sources.iter().position(|s| s.arc == l)?;
        Some(Found {
            cost: best,
            source,
            target,
            arcs,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::Overlay;
    use crate::attrs::EdgeAttrs;
    use crate::testing::GraphBuilder;

    #[test]
    fn the_overlay_counts_only_the_part_ridden_before() {
        let mut b = GraphBuilder::new();
        let m = 1.0 / 111_195.0;
        let (x, y, z) = (
            b.node(0.07, 0.08),
            b.node(0.07 + 100.0 * m, 0.08),
            b.node(0.07, 0.081),
        );
        let e = b.edge(x, y, EdgeAttrs::default());
        let other = b.edge(x, z, EdgeAttrs::default());
        let built = b.build();
        let (g, e, other) = (&built.graph, built.edge(e), built.edge(other));
        let mut o = Overlay::new(g.edge_count(), 2.0);
        assert!(o.is_empty());
        o.mark(e, 0.6, 0.2);
        assert!(o.marked(e) && !o.marked(other));
        let len = g.length_m(e);
        // either direction, only the overlap
        assert!((o.reused_m(g, e, 0.0, 1.0) - 0.4 * len).abs() < 1e-3);
        assert!((o.reused_m(g, e, 1.0, 0.5) - 0.1 * len).abs() < 1e-3);
        assert_eq!(o.reused_m(g, e, 0.7, 1.0), 0.0);
        assert_eq!(o.reused_m(g, other, 0.0, 1.0), 0.0);
        assert!((o.extra(g, e, 0.0, 1.0) - 0.8 * len).abs() < 1e-3);
        // a second piece widens it to the hull
        o.mark(e, 0.9, 1.0);
        assert!((o.reused_m(g, e, 0.0, 1.0) - 0.8 * len).abs() < 1e-3);
    }
}
