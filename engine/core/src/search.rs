//! Plain A* over compiled arc costs (spike #4: fast enough, no landmarks, no corridor, no
//! contraction). One [`Search`] is allocated per graph and reused: a generation counter resets it
//! in O(1), so a query allocates nothing but its heap's growth.
//!
//! Sources and targets are points on edges, not nodes: a search starts with labels on the source
//! edge's end nodes (the partial arcs from the point) and ends on the target edge's end nodes plus
//! the partial arc to the point. The bound is `factor × straight-line distance` to the target point
//! on a plane that never overestimates (longitudes scaled by the cosine of the region's highest
//! latitude, minus 1 % for the lengths' projection), so it is consistent and every node settles
//! once.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use crate::graph::{ArcId, Graph, NodeId};

const NONE: u32 = u32::MAX;

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

/// What one search found.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub cost: f32,
    /// The source node the path starts from (an end of the source edge).
    pub start: NodeId,
    /// The target node it ends at (an end of the target edge).
    pub end: NodeId,
    /// Full arcs from `start` to `end` (empty when they are the same node).
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
    /// `(node, cost from the source point)`.
    pub sources: &'a [(NodeId, f32)],
    /// `(node, cost to the target point)`.
    pub targets: &'a [(NodeId, f32)],
    /// The target point, 1e-7 degrees.
    pub target: (i32, i32),
    /// A cost already known (the direct way along one edge): only something cheaper is returned.
    pub best: f32,
    /// Excluded ways usable near some points.
    pub exempt: Option<Exempt<'a>>,
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

/// The reusable state.
#[derive(Debug, Clone)]
pub struct Search {
    dist: Vec<f32>,
    parent: Vec<u32>,
    /// `generation << 1 | closed`.
    stamp: Vec<u32>,
    generation: u32,
    heap: BinaryHeap<Reverse<u64>>,
    queue: Vec<NodeId>,
    /// Nodes settled by the last search.
    pub settled: usize,
}

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
    #[must_use]
    pub fn new(nodes: usize) -> Search {
        Search {
            dist: vec![f32::INFINITY; nodes],
            parent: vec![NONE; nodes],
            stamp: vec![0; nodes],
            generation: 0,
            heap: BinaryHeap::new(),
            queue: Vec::new(),
            settled: 0,
        }
    }

    /// Whether `starts` sit in a small pocket the profile cuts off: fewer than `limit` nodes can
    /// be reached from them over allowed arcs (`forward`; backward: reach them), none of them in
    /// `others`.
    pub fn cut_off(
        &mut self,
        g: &Graph,
        costs: &[f32],
        starts: &[NodeId],
        others: &[NodeId],
        limit: usize,
        forward: bool,
    ) -> bool {
        self.reset(g.node_count());
        self.queue.clear();
        let mut seen = 0usize;
        for &s in starts {
            if self.stamp[s as usize] >> 1 != self.generation {
                self.label(s, 0.0, NONE);
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
                if !ok || !costs[arc as usize].is_finite() {
                    continue;
                }
                let w = if forward { g.head(arc) } else { g.tail(arc) };
                if self.stamp[w as usize] >> 1 != self.generation {
                    self.label(w, 0.0, NONE);
                    self.queue.push(w);
                    seen += 1;
                }
            }
        }
        seen < limit
            && others
                .iter()
                .all(|&o| self.stamp[o as usize] >> 1 != self.generation)
    }

    /// Heap bytes held.
    #[must_use]
    pub fn heap_bytes(&self) -> usize {
        self.dist.capacity() * 12 + self.heap.capacity() * 8
    }

    fn reset(&mut self, nodes: usize) {
        if self.dist.len() != nodes {
            *self = Search::new(nodes);
        }
        self.generation += 1;
        if self.generation >= u32::MAX >> 1 {
            self.stamp.fill(0);
            self.generation = 1;
        }
        self.heap.clear();
        self.settled = 0;
    }

    #[inline]
    fn dist(&self, v: u32) -> f32 {
        if self.stamp[v as usize] >> 1 == self.generation {
            self.dist[v as usize]
        } else {
            f32::INFINITY
        }
    }

    #[inline]
    fn closed(&self, v: u32) -> bool {
        self.stamp[v as usize] == (self.generation << 1) | 1
    }

    #[inline]
    fn label(&mut self, v: u32, d: f32, parent: u32) {
        self.dist[v as usize] = d;
        self.parent[v as usize] = parent;
        self.stamp[v as usize] = self.generation << 1;
    }

    /// A* from labelled source nodes to labelled target nodes. `None` if nothing cheaper than
    /// `q.best` is reachable.
    pub fn run(&mut self, g: &Graph, q: &Query<'_>) -> Option<Found> {
        self.reset(g.node_count());
        let (plane, bound, target) = (q.plane, q.bound, q.target);
        let h = |v: NodeId| plane.dist(g.node_e7(v), target) * bound;
        for &(s, d) in q.sources {
            if d.is_finite() && d < self.dist(s) {
                self.label(s, d, NONE);
                self.heap.push(key(d + h(s), s));
            }
        }
        let mut best = q.best;
        let mut best_end = None;
        while let Some(Reverse(k)) = self.heap.pop() {
            let (f, v) = unkey(k);
            if f >= best {
                break;
            }
            if self.closed(v) {
                continue;
            }
            self.stamp[v as usize] |= 1;
            self.settled += 1;
            let dv = self.dist[v as usize];
            for &(t, tail) in q.targets {
                if t == v && dv + tail < best {
                    best = dv + tail;
                    best_end = Some(v);
                }
            }
            for a in g.out_arcs(v) {
                let mut c = q.costs[a as usize];
                let w = g.head(a);
                if !c.is_finite() {
                    match &q.exempt {
                        Some(x) => match x.cost(g, a, w) {
                            Some(cx) => c = cx,
                            None => continue,
                        },
                        None => continue,
                    }
                }
                let d = dv + c;
                if d < self.dist(w) && !self.closed(w) {
                    self.label(w, d, a);
                    self.heap.push(key(d + h(w), w));
                }
            }
        }
        let end = best_end?;
        let mut arcs = Vec::new();
        let mut v = end;
        while self.parent[v as usize] != NONE {
            let a = self.parent[v as usize];
            arcs.push(a);
            v = g.tail(a);
        }
        arcs.reverse();
        Some(Found {
            cost: best,
            start: v,
            end,
            arcs,
        })
    }
}
