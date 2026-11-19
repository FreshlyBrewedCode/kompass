//! Shortest paths over compiled arc costs: A* (unidirectional and bidirectional) with a pluggable
//! lower bound, plus Dijkstra on length for landmark preprocessing (ALT).
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_lossless,
    clippy::many_single_char_names,
    clippy::missing_errors_doc,
    clippy::missing_panics_doc,
    clippy::chunks_exact_to_as_chunks,
    clippy::too_many_lines,
    reason = "spike #4: graph ids and counts fit in u32 by construction (≤ 2^32 nodes / arcs); quantisation casts are deliberate"
)]

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use crate::graph::Graph;

/// Metres per 1e-7 degree of latitude on the engine's sphere.
const M_PER_E7: f32 = (crate::EARTH_RADIUS_M * std::f64::consts::PI / 180.0 * 1e-7) as f32;

/// Planar metres from 1e-7 degrees that never overestimate a distance inside the graph's
/// latitude range (longitudes are scaled by the cosine of the highest latitude) and shrink by
/// 1 % for the metric length's projection error.
#[derive(Debug, Clone, Copy)]
pub struct Plane {
    kx: f32,
    ky: f32,
}

impl Plane {
    #[must_use]
    pub fn for_graph(g: &Graph) -> Plane {
        let max_abs_lat = g.lat.iter().map(|l| l.unsigned_abs()).max().unwrap_or(0);
        let cos = (f64::from(max_abs_lat) * 1e-7).to_radians().cos() as f32;
        Plane {
            kx: M_PER_E7 * cos * 0.99,
            ky: M_PER_E7 * 0.99,
        }
    }

    #[inline]
    #[must_use]
    pub fn dist(&self, g: &Graph, a: u32, b: u32) -> f32 {
        let (a, b) = (a as usize, b as usize);
        let dx = (g.lon[a] - g.lon[b]) as f32 * self.kx;
        let dy = (g.lat[a] - g.lat[b]) as f32 * self.ky;
        (dx * dx + dy * dy).sqrt()
    }
}

/// A lower bound on the cost from a node to a fixed target.
pub trait Bound {
    fn to_target(&self, g: &Graph, v: u32) -> f32;
}

/// Straight-line distance × the profile's smallest factor.
#[derive(Debug, Clone, Copy)]
pub struct StraightLine {
    pub plane: Plane,
    pub target: u32,
    pub min_factor: f32,
}

impl Bound for StraightLine {
    #[inline]
    fn to_target(&self, g: &Graph, v: u32) -> f32 {
        self.plane.dist(g, v, self.target) * self.min_factor
    }
}

/// Landmark distances on length (undirected, profile-independent), node-major, in units of
/// [`Landmarks::UNIT_M`] rounded down.
#[derive(Debug, Clone, Default)]
pub struct Landmarks {
    pub count: usize,
    pub nodes: Vec<u32>,
    pub dist: Vec<u16>,
}

impl Landmarks {
    pub const UNIT_M: f32 = 8.0;

    /// Picks `count` landmarks spread around the graph's rim (the farthest node from the centre
    /// in each of `count` sectors) and computes their length distances.
    #[must_use]
    pub fn build(g: &Graph, count: usize, seed_node: u32) -> Landmarks {
        let mut dij = Search::new(g.node_count());
        let lengths: Vec<f32> = (0..g.edge_count() * 2).map(|a| g.length_m(a >> 1)).collect();
        // only nodes reachable from the seed (the main component) can be landmarks
        dij.dijkstra_all(g, &lengths, seed_node);
        let n = g.node_count();
        let reach: Vec<bool> = (0..n as u32).map(|v| dij.dist(v).is_finite()).collect();
        let (mut cx, mut cy, mut k) = (0f64, 0f64, 0f64);
        for v in (0..n).filter(|&v| reach[v]) {
            cx += f64::from(g.lon[v]);
            cy += f64::from(g.lat[v]);
            k += 1.0;
        }
        let (cx, cy) = (cx / k, cy / k);
        let cos = (cy * 1e-7).to_radians().cos();
        let mut best = vec![(0f64, u32::MAX); count];
        for v in (0..n).filter(|&v| reach[v]) {
            let dx = (f64::from(g.lon[v]) - cx) * cos;
            let dy = f64::from(g.lat[v]) - cy;
            let angle = dy.atan2(dx) + std::f64::consts::PI;
            let sector = ((angle / std::f64::consts::TAU * count as f64) as usize).min(count - 1);
            let r = dx * dx + dy * dy;
            if r > best[sector].0 {
                best[sector] = (r, v as u32);
            }
        }
        let nodes: Vec<u32> = best.iter().map(|b| b.1).filter(|&v| v != u32::MAX).collect();
        let count = nodes.len();
        let mut dist = vec![u16::MAX; n * count];
        for (l, &node) in nodes.iter().enumerate() {
            dij.dijkstra_all(g, &lengths, node);
            for v in 0..n {
                let d = dij.dist(v as u32);
                if d.is_finite() {
                    dist[v * count + l] = (d / Self::UNIT_M).min(f32::from(u16::MAX - 1)) as u16;
                }
            }
        }
        Landmarks { count, nodes, dist }
    }

    /// Lower bound on the length between `v` and `t` (metres).
    #[inline]
    #[must_use]
    pub fn length_bound(&self, v: u32, t: u32) -> f32 {
        let k = self.count;
        let a = &self.dist[v as usize * k..v as usize * k + k];
        let b = &self.dist[t as usize * k..t as usize * k + k];
        let mut best = 0u16;
        for (&x, &y) in a.iter().zip(b) {
            if x != u16::MAX && y != u16::MAX {
                best = best.max(x.abs_diff(y));
            }
        }
        (f32::from(best) - 1.0).max(0.0) * Self::UNIT_M
    }
}

/// ALT: the larger of the landmark and straight-line bounds.
pub struct Alt<'a> {
    pub landmarks: &'a Landmarks,
    pub line: StraightLine,
}

impl Bound for Alt<'_> {
    #[inline]
    fn to_target(&self, g: &Graph, v: u32) -> f32 {
        let alt = self.landmarks.length_bound(v, self.line.target) * self.line.min_factor;
        alt.max(self.line.to_target(g, v))
    }
}

/// A found route.
#[derive(Debug, Clone, PartialEq)]
pub struct Route {
    pub cost: f32,
    /// Arcs from source to target.
    pub arcs: Vec<u32>,
}

impl Route {
    #[must_use]
    pub fn length_m(&self, g: &Graph) -> f32 {
        self.arcs.iter().map(|&a| g.length_m((a >> 1) as usize)).sum()
    }
}

/// Reusable search state (allocate once per graph; each search is O(touched nodes) to reset).
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

const NONE: u32 = u32::MAX;

#[inline]
fn key(k: f32, v: u32) -> Reverse<u64> {
    // non-negative floats order like their bits
    Reverse((u64::from(k.to_bits()) << 32) | u64::from(v))
}

#[inline]
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

    /// Heap bytes of the per-node arrays.
    #[must_use]
    pub fn heap_bytes(&self) -> usize {
        self.dist.len() * 12 + self.heap.capacity() * 8
    }

    fn reset(&mut self) {
        self.generation += 1;
        if self.generation >= u32::MAX >> 1 {
            self.stamp.fill(0);
            self.generation = 1;
        }
        self.heap.clear();
        self.settled = 0;
    }

    #[inline]
    #[must_use]
    pub fn dist(&self, v: u32) -> f32 {
        if self.stamp[v as usize] >> 1 == self.generation {
            self.dist[v as usize]
        } else {
            f32::INFINITY
        }
    }

    /// Whether the last search settled `v`.
    #[inline]
    #[must_use]
    pub fn closed(&self, v: u32) -> bool {
        self.stamp[v as usize] == (self.generation << 1) | 1
    }

    #[inline]
    fn close(&mut self, v: u32) {
        self.stamp[v as usize] = (self.generation << 1) | 1;
    }

    #[inline]
    fn set(&mut self, v: u32, d: f32, parent: u32) {
        let i = v as usize;
        self.dist[i] = d;
        self.parent[i] = parent;
        self.stamp[i] = self.generation << 1;
    }

    /// Pops the next open node (skipping stale entries).
    #[inline]
    fn pop(&mut self) -> Option<(f32, u32)> {
        while let Some(Reverse(k)) = self.heap.pop() {
            let (k, v) = unkey(k);
            if !self.closed(v) {
                return Some((k, v));
            }
        }
        None
    }

    #[inline]
    fn peek(&mut self) -> f32 {
        while let Some(&Reverse(k)) = self.heap.peek() {
            let (k, v) = unkey(k);
            if self.closed(v) {
                self.heap.pop();
            } else {
                return k;
            }
        }
        f32::INFINITY
    }

    /// Dijkstra from `s` over the whole graph (`costs` by arc).
    pub fn dijkstra_all(&mut self, g: &Graph, costs: &[f32], s: u32) {
        self.reset();
        self.set(s, 0.0, NONE);
        self.heap.push(key(0.0, s));
        while let Some((d, v)) = self.pop() {
            self.close(v);
            self.settled += 1;
            for &a in g.out_arcs(v) {
                let c = costs[a as usize];
                let w = g.head(a);
                let nd = d + c;
                if nd < self.dist(w) {
                    self.set(w, nd, a);
                    self.heap.push(key(nd, w));
                }
            }
        }
    }

    /// A* from `s` to `t` with a consistent lower bound.
    pub fn astar<B: Bound>(&mut self, g: &Graph, costs: &[f32], s: u32, t: u32, bound: &B) -> Option<Route> {
        self.reset();
        self.set(s, 0.0, NONE);
        self.heap.push(key(bound.to_target(g, s), s));
        while let Some((_, v)) = self.pop() {
            self.close(v);
            self.settled += 1;
            if v == t {
                return Some(Route {
                    cost: self.dist(t),
                    arcs: self.path_to(g, t),
                });
            }
            let d = self.dist[v as usize];
            for &a in g.out_arcs(v) {
                let c = costs[a as usize];
                if !c.is_finite() {
                    continue;
                }
                let w = g.head(a);
                let nd = d + c;
                if nd < self.dist(w) && !self.closed(w) {
                    self.set(w, nd, a);
                    self.heap.push(key(nd + bound.to_target(g, w), w));
                }
            }
        }
        None
    }

    /// A* with the cost computed lazily from the profile (no compiled costs).
    pub fn astar_lazy<B: Bound>(
        &mut self,
        g: &Graph,
        profile: &crate::profile::Profile,
        s: u32,
        t: u32,
        bound: &B,
    ) -> Option<Route> {
        self.reset();
        self.set(s, 0.0, NONE);
        self.heap.push(key(bound.to_target(g, s), s));
        while let Some((_, v)) = self.pop() {
            self.close(v);
            self.settled += 1;
            if v == t {
                return Some(Route {
                    cost: self.dist(t),
                    arcs: self.path_to(g, t),
                });
            }
            let d = self.dist[v as usize];
            for &a in g.out_arcs(v) {
                let w = g.head(a);
                if self.closed(w) {
                    continue;
                }
                let c = profile.arc_cost(g, (a >> 1) as usize, a & 1);
                if !c.is_finite() {
                    continue;
                }
                let nd = d + c;
                if nd < self.dist(w) {
                    self.set(w, nd, a);
                    self.heap.push(key(nd + bound.to_target(g, w), w));
                }
            }
        }
        None
    }

    /// The arcs from the search's source to `v` (following parents).
    fn path_to(&self, g: &Graph, mut v: u32) -> Vec<u32> {
        let mut arcs = Vec::new();
        while self.parent[v as usize] != NONE {
            let a = self.parent[v as usize];
            arcs.push(a);
            v = g.head(a ^ 1);
        }
        arcs.reverse();
        arcs
    }

    /// For a backward search: the arcs from `v` to the search's source (the target), in riding
    /// direction.
    fn path_from(&self, g: &Graph, mut v: u32) -> Vec<u32> {
        let mut arcs = Vec::new();
        while self.parent[v as usize] != NONE {
            let a = self.parent[v as usize];
            arcs.push(a);
            v = g.head(a);
        }
        arcs
    }
}

/// Bidirectional A* with the average potential `(to_t(v) - to_s(v)) / 2` (Ikeda et al.), which is
/// consistent in both directions, so the plain bidirectional Dijkstra stop rule applies.
pub struct Bidirectional {
    pub fwd: Search,
    pub bwd: Search,
}

impl Bidirectional {
    #[must_use]
    pub fn new(nodes: usize) -> Bidirectional {
        Bidirectional {
            fwd: Search::new(nodes),
            bwd: Search::new(nodes),
        }
    }

    #[must_use]
    pub fn settled(&self) -> usize {
        self.fwd.settled + self.bwd.settled
    }

    /// `to_t` bounds the cost to `t`; `to_s` bounds the cost from `s` (the graph is searched
    /// backwards with it).
    pub fn route<T: Bound, S: Bound>(
        &mut self,
        g: &Graph,
        costs: &[f32],
        s: u32,
        t: u32,
        to_t: &T,
        to_s: &S,
    ) -> Option<Route> {
        let pf = |v: u32| 0.5 * (to_t.to_target(g, v) - to_s.to_target(g, v));
        let (fwd, bwd) = (&mut self.fwd, &mut self.bwd);
        fwd.reset();
        bwd.reset();
        fwd.set(s, 0.0, NONE);
        fwd.heap.push(key(fwd_key(0.0, pf(s)), s));
        bwd.set(t, 0.0, NONE);
        bwd.heap.push(key(fwd_key(0.0, -pf(t)), t));
        let mut mu = if s == t { 0.0 } else { f32::INFINITY };
        let mut meet = s;
        loop {
            let (kf, kb) = (unshift(fwd.peek()), unshift(bwd.peek()));
            if kf.is_infinite() && kb.is_infinite() || kf + kb >= mu {
                break;
            }
            let forward = kf <= kb;
            let (this, other) = if forward {
                (&mut *fwd, &*bwd)
            } else {
                (&mut *bwd, &*fwd)
            };
            let Some((_, v)) = this.pop() else { break };
            this.close(v);
            this.settled += 1;
            let d = this.dist[v as usize];
            for &a in g.out_arcs(v) {
                // forward: v → w along a; backward: w → v along a ^ 1
                let c = costs[(if forward { a } else { a ^ 1 }) as usize];
                if !c.is_finite() {
                    continue;
                }
                let w = g.head(a);
                let nd = d + c;
                if nd < this.dist(w) && !this.closed(w) {
                    this.set(w, nd, if forward { a } else { a ^ 1 });
                    let p = if forward { pf(w) } else { -pf(w) };
                    this.heap.push(key(fwd_key(nd, p), w));
                }
                let through = nd + other.dist(w);
                if through < mu {
                    mu = through;
                    meet = w;
                }
            }
        }
        if mu.is_infinite() {
            return None;
        }
        let mut arcs = fwd.path_to(g, meet);
        arcs.extend(bwd.path_from(g, meet));
        Some(Route { cost: mu, arcs })
    }
}

/// Bidirectional keys can be negative (the potential is a difference); heap keys must not be, so
/// they are shifted by a constant larger than any potential.
const SHIFT: f32 = 1.0e7;

#[inline]
fn fwd_key(d: f32, p: f32) -> f32 {
    d + p + SHIFT
}

#[inline]
fn unshift(k: f32) -> f32 {
    k - SHIFT
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::tests::grid;
    use crate::profile::Profile;

    fn bounds(g: &Graph, s: u32, t: u32, min_factor: f32) -> (StraightLine, StraightLine) {
        let plane = Plane::for_graph(g);
        (
            StraightLine {
                plane,
                target: t,
                min_factor,
            },
            StraightLine {
                plane,
                target: s,
                min_factor,
            },
        )
    }

    #[test]
    fn all_searches_agree_with_dijkstra() {
        let g = grid();
        let p = Profile::gravel_explorer();
        let costs = p.compile(&g);
        let lm = Landmarks::build(&g, 4, 0);
        let mut one = Search::new(g.node_count());
        let mut dij = Search::new(g.node_count());
        let mut two = Bidirectional::new(g.node_count());
        for s in 0..9 {
            dij.dijkstra_all(&g, &costs, s);
            for t in 0..9 {
                let (to_t, to_s) = bounds(&g, s, t, p.min_factor);
                let want = dij.dist(t);
                let a = one.astar(&g, &costs, s, t, &to_t).unwrap();
                assert!((a.cost - want).abs() < 1e-3, "{s}→{t}");
                let sum: f32 = a.arcs.iter().map(|&x| costs[x as usize]).sum();
                assert!((sum - want).abs() < 1e-3);
                let lazy = one.astar_lazy(&g, &p, s, t, &to_t).unwrap();
                assert!((lazy.cost - want).abs() < 1e-3);
                let b = two.route(&g, &costs, s, t, &to_t, &to_s).unwrap();
                assert!((b.cost - want).abs() < 1e-3, "bidi {s}→{t}: {} vs {want}", b.cost);
                let sum: f32 = b.arcs.iter().map(|&x| costs[x as usize]).sum();
                assert!((sum - want).abs() < 1e-3);
                let alt_t = Alt {
                    landmarks: &lm,
                    line: to_t,
                };
                let alt = one.astar(&g, &costs, s, t, &alt_t).unwrap();
                assert!((alt.cost - want).abs() < 1e-3);
            }
        }
    }

    #[test]
    fn one_way_is_respected() {
        let g = grid();
        let costs = Profile::gravel_explorer().compile(&g);
        let (to_t, _) = bounds(&g, 8, 6, 0.5);
        let mut one = Search::new(g.node_count());
        // 8 → 6 along the top row would be 200 m, but it is one-way eastwards
        let r = one.astar(&g, &costs, 8, 6, &to_t).unwrap();
        assert_eq!(r.arcs.len(), 4);
    }

    #[test]
    fn landmark_bounds_are_lower_bounds() {
        let g = grid();
        let lm = Landmarks::build(&g, 4, 0);
        let lengths: Vec<f32> = (0..g.edge_count() * 2).map(|a| g.length_m(a >> 1)).collect();
        let mut dij = Search::new(g.node_count());
        for s in 0..9 {
            dij.dijkstra_all(&g, &lengths, s);
            for t in 0..9 {
                assert!(lm.length_bound(s, t) <= dij.dist(t) + 1e-3);
            }
        }
    }
}
