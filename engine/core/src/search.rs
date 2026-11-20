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

/// The reusable state.
#[derive(Debug, Clone)]
pub struct Search {
    dist: Vec<f32>,
    parent: Vec<u32>,
    /// `generation << 1 | closed`.
    stamp: Vec<u32>,
    generation: u32,
    heap: BinaryHeap<Reverse<u64>>,
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
            settled: 0,
        }
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

    /// A* from labelled source nodes to labelled target nodes (`(node, cost to the target point)`),
    /// over `costs` per arc; `bound` is the factor of the straight-line bound towards `target`
    /// (1e-7 degrees). `best` is a cost already known (a direct way along one edge): the search only
    /// returns something cheaper. `None` if nothing cheaper is reachable.
    #[allow(clippy::too_many_arguments, reason = "a search's inputs")]
    pub fn run(
        &mut self,
        g: &Graph,
        costs: &[f32],
        plane: Plane,
        bound: f32,
        sources: &[(NodeId, f32)],
        targets: &[(NodeId, f32)],
        target: (i32, i32),
        best: f32,
    ) -> Option<Found> {
        self.reset(g.node_count());
        let h = |v: NodeId| plane.dist(g.node_e7(v), target) * bound;
        for &(s, d) in sources {
            if d.is_finite() && d < self.dist(s) {
                self.label(s, d, NONE);
                self.heap.push(key(d + h(s), s));
            }
        }
        let mut best = best;
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
            for &(t, tail) in targets {
                if t == v && dv + tail < best {
                    best = dv + tail;
                    best_end = Some(v);
                }
            }
            for a in g.out_arcs(v) {
                let c = costs[a as usize];
                if !c.is_finite() {
                    continue;
                }
                let w = g.head(a);
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

    /// Plain Dijkstra between the same labels (no bound): the reference for tests.
    #[allow(clippy::too_many_arguments, reason = "a search's inputs")]
    pub fn dijkstra(
        &mut self,
        g: &Graph,
        costs: &[f32],
        sources: &[(NodeId, f32)],
        targets: &[(NodeId, f32)],
        best: f32,
    ) -> Option<f32> {
        let plane = Plane { kx: 0.0, ky: 0.0 };
        self.run(g, costs, plane, 0.0, sources, targets, (0, 0), best)
            .map(|f| f.cost)
    }
}
