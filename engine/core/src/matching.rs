//! Map-matching: a recorded track → the arcs it rode, for the personal history (spike #5).
//!
//! A hidden Markov model after Newson & Krumm (2009): per track point the candidate positions on
//! the nearest edges ([`Grid::snap_into`]), an emission score by the GPS distance, a transition
//! score by how much the network distance between two candidates differs from the great-circle
//! distance between the two points, and Viterbi for the best sequence. One-way restrictions are
//! followed with a light penalty only (riders do ride against them) and access is ignored.
//!
//! - **Preprocessing**: a point is kept once it is `min_step_m` from the last kept one (drops
//!   stationary jitter and thins dense recordings).
//! - **Breaks**: a point without candidates, or whose candidates cannot be reached from the last
//!   matched point within the detour bound, is skipped; once more than `max_skip_m` of track is
//!   skipped (or two points are more than `max_gap_m` apart) the chain ends and a new one starts.
//!   The track between two chains is an [`Unmatched`] stretch.
//! - **Output**: the ridden path as [`Piece`]s (an edge in one direction, the part of it that was
//!   ridden, and the track points that covered it), in riding order.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use crate::graph::{ArcId, EdgeId, Graph, NodeId, arc, arc_edge, arc_is_reverse, flags};
use crate::spatial::{Grid, Snap};
use crate::{LngLat, M_PER_E7};

/// The matcher's parameters (defaults: the values spike #5 chose on real rides).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MatchParams {
    /// Candidate search radius around a point.
    pub radius_m: f64,
    /// At most this many candidates (nearest edges) per point.
    pub max_candidates: usize,
    /// GPS noise: emission is a Gaussian of the distance to the edge with this deviation.
    pub sigma_m: f64,
    /// Transition: exponential in |network distance − great-circle distance| with this scale.
    pub beta_m: f64,
    /// Keep a point once it is this far from the last kept one.
    pub min_step_m: f64,
    /// Skip up to this much track (points without a reachable candidate) before breaking.
    pub max_skip_m: f64,
    /// Two kept points further apart than this break the chain (a recording gap, a train).
    pub max_gap_m: f64,
    /// A transition is feasible if the network distance is at most `gc × factor + slack`.
    pub detour_factor: f64,
    pub detour_slack_m: f64,
    /// Cost factor for riding an arc against its one-way.
    pub oneway_penalty: f64,
    /// Turning back on an edge for less than this is taken as GPS noise and removed (0: keep all).
    pub spur_m: f64,
}

impl Default for MatchParams {
    fn default() -> Self {
        MatchParams {
            radius_m: 40.0,
            max_candidates: 8,
            sigma_m: 8.0,
            beta_m: 8.0,
            min_step_m: 15.0,
            max_skip_m: 200.0,
            max_gap_m: 2000.0,
            detour_factor: 2.0,
            detour_slack_m: 150.0,
            oneway_penalty: 1.3,
            spur_m: 30.0,
        }
    }
}

/// A stretch of one edge ridden in one direction: from fraction `start` to `end` along the
/// geometry (`start > end` when `reverse`), covered by the track points `first_point..=last_point`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Piece {
    pub edge: EdgeId,
    pub reverse: bool,
    pub start: f32,
    pub end: f32,
    pub first_point: u32,
    pub last_point: u32,
}

impl Piece {
    #[must_use]
    pub fn arc(&self) -> ArcId {
        arc(self.edge, self.reverse)
    }

    /// The covered share of the edge, 0..=1.
    #[must_use]
    pub fn share(&self) -> f32 {
        (self.end - self.start).abs()
    }
}

/// A chain: a run of the track matched without a break, `pieces[first_piece..end_piece]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chain {
    pub first_point: u32,
    pub last_point: u32,
    pub first_piece: u32,
    pub end_piece: u32,
}

/// A stretch of track not matched: before the first chain, between two, or after the last.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Unmatched {
    pub first_point: u32,
    pub last_point: u32,
    pub length_m: f64,
}

/// Counters for quality checks and timing.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct MatchStats {
    pub points: u32,
    pub kept: u32,
    pub no_candidates: u32,
    /// Points with candidates none of which was reachable (bridged or broken on).
    pub unreachable: u32,
    pub candidates: u64,
    pub searches: u64,
    pub settled: u64,
    /// Length of the track (all points).
    pub track_m: f64,
    /// Track length between matched points of the same chain.
    pub matched_m: f64,
    /// Length of the matched path on the graph.
    pub path_m: f64,
    /// Of it, against a one-way.
    pub contra_oneway_m: f64,
    /// Pieces removed as spurs (turning back for less than `spur_m`).
    pub spurs: u32,
    /// Matched track length by the distance of its matched point to the edge: under 5, 10, 20,
    /// 30 m and beyond ([`DIST_BUCKETS_M`]).
    pub dist_hist_m: [f64; 5],
    /// Matched track length across skipped points (bridged by the network path).
    pub bridged_m: f64,
    /// Matched track length on edges at least half in forest, and of it 20 m or more off the edge.
    pub forest_m: f64,
    pub far_forest_m: f64,
}

/// The bucket bounds of [`MatchStats::dist_hist_m`].
pub const DIST_BUCKETS_M: [f64; 4] = [5.0, 10.0, 20.0, 30.0];

#[derive(Debug, Clone, Default)]
pub struct Match {
    pub pieces: Vec<Piece>,
    pub chains: Vec<Chain>,
    pub unmatched: Vec<Unmatched>,
    pub stats: MatchStats,
}

#[derive(Debug, Clone, Copy)]
struct Cand {
    edge: EdgeId,
    frac: f32,
    dist: f32,
    len: f32,
    score: f64,
    back: u16,
}

/// One HMM step: a kept point and its candidates (a range of `Viterbi::cands`).
#[derive(Debug, Clone, Copy)]
struct Step {
    point: u32,
    first: u32,
    end: u32,
    /// Points were skipped (no reachable candidate) between the previous step and this one.
    bridged: bool,
}

const NO_ARC: ArcId = u32::MAX;

/// A bounded Dijkstra over every arc (one-way only as a cost factor), reused between searches:
/// dense per-node arrays reset by a round stamp, so a search allocates nothing.
#[derive(Debug, Clone)]
struct Search {
    dist: Vec<f32>,
    parent: Vec<ArcId>,
    stamp: Vec<u32>,
    round: u32,
    heap: BinaryHeap<Reverse<(u32, NodeId)>>,
    settled: u64,
}

impl Search {
    fn new(nodes: usize) -> Search {
        Search {
            dist: vec![0.0; nodes],
            parent: vec![NO_ARC; nodes],
            stamp: vec![0; nodes],
            round: 0,
            heap: BinaryHeap::new(),
            settled: 0,
        }
    }

    fn heap_bytes(&self) -> usize {
        self.dist.capacity() * 12 + self.heap.capacity() * 8
    }

    #[inline]
    fn get(&self, v: NodeId) -> f32 {
        if self.stamp[v as usize] == self.round {
            self.dist[v as usize]
        } else {
            f32::INFINITY
        }
    }

    #[inline]
    fn relax(&mut self, v: NodeId, d: f32, via: ArcId) {
        let i = v as usize;
        if self.stamp[i] != self.round || d < self.dist[i] {
            self.stamp[i] = self.round;
            self.dist[i] = d;
            self.parent[i] = via;
            self.heap.push(Reverse((d.to_bits(), v)));
        }
    }

    /// From `sources` (node, initial cost) until every target is settled or the bound is passed.
    fn run(&mut self, g: &Graph, sources: &[(NodeId, f32)], targets: &[NodeId], bound: f32, penalty: f32) {
        self.round = self.round.wrapping_add(1);
        if self.round == 0 {
            self.stamp.fill(0);
            self.round = 1;
        }
        self.heap.clear();
        for &(v, d) in sources {
            self.relax(v, d, NO_ARC);
        }
        let mut left = targets.len();
        while let Some(Reverse((bits, v))) = self.heap.pop() {
            let d = f32::from_bits(bits);
            if d > self.dist[v as usize] {
                continue;
            }
            if d > bound {
                break;
            }
            self.settled += 1;
            if targets.contains(&v) {
                left -= 1;
                if left == 0 {
                    break;
                }
            }
            let (arcs, fl) = g.arcs_at(v);
            for (&a, &f) in arcs.iter().zip(fl) {
                let len = g.length_m(arc_edge(a));
                let w = if f & flags::OUT != 0 { len } else { len * penalty };
                self.relax(g.head(a), d + w, a);
            }
        }
    }
}

/// The matcher: parameters and reusable search state (about 12 bytes per graph node).
#[derive(Debug, Clone)]
pub struct Matcher {
    pub params: MatchParams,
    search: Search,
    snaps: Vec<Snap>,
    cands: Vec<Cand>,
    steps: Vec<Step>,
    targets: Vec<NodeId>,
    trans: Vec<f64>,
}

impl Matcher {
    #[must_use]
    pub fn new(g: &Graph, params: MatchParams) -> Matcher {
        Matcher {
            params,
            search: Search::new(g.node_count()),
            snaps: Vec::new(),
            cands: Vec::new(),
            steps: Vec::new(),
            targets: Vec::new(),
            trans: Vec::new(),
        }
    }

    #[must_use]
    pub fn heap_bytes(&self) -> usize {
        self.search.heap_bytes()
    }

    #[inline]
    fn pen(&self, g: &Graph, a: ArcId) -> f32 {
        if g.arc_allowed(a) {
            1.0
        } else {
            #[allow(clippy::cast_possible_truncation, reason = "a small factor")]
            let p = self.params.oneway_penalty as f32;
            p
        }
    }

    /// Search sources for leaving candidate `c`: its two end nodes with the cost to reach them.
    fn sources(&self, g: &Graph, c: &Cand) -> [(NodeId, f32); 2] {
        let to_from = c.frac * c.len * self.pen(g, arc(c.edge, true));
        let to_to = (1.0 - c.frac) * c.len * self.pen(g, arc(c.edge, false));
        [(g.from(c.edge), to_from), (g.to(c.edge), to_to)]
    }

    /// The network cost from `a` to `b` after a search from `a` (∞ if not reached), and whether
    /// it is the direct move along their shared edge.
    fn cost_to(&self, g: &Graph, a: &Cand, b: &Cand) -> (f32, bool) {
        let s = &self.search;
        let via_from = s.get(g.from(b.edge)) + b.frac * b.len * self.pen(g, arc(b.edge, false));
        let via_to = s.get(g.to(b.edge)) + (1.0 - b.frac) * b.len * self.pen(g, arc(b.edge, true));
        let mut best = via_from.min(via_to);
        let mut direct = false;
        if a.edge == b.edge {
            let fwd = b.frac >= a.frac;
            let d = (b.frac - a.frac).abs() * a.len * self.pen(g, arc(a.edge, !fwd));
            if d <= best {
                best = d;
                direct = true;
            }
        }
        (best, direct)
    }

    /// Matches one track (points in recording order).
    #[allow(
        clippy::cast_possible_truncation,
        clippy::too_many_lines,
        reason = "point and candidate indices fit u32/u16; the Viterbi loop reads best in one piece"
    )]
    pub fn match_track(&mut self, g: &Graph, grid: &Grid, points: &[LngLat]) -> Match {
        let p = self.params;
        let mut out = Match::default();
        let settled0 = self.search.settled;
        // prefix track length per point
        let mut along = Vec::with_capacity(points.len());
        let mut total = 0.0;
        for (i, &q) in points.iter().enumerate() {
            if i > 0 {
                total += dist_m(points[i - 1], q);
            }
            along.push(total);
        }
        out.stats.points = points.len() as u32;
        out.stats.track_m = total;

        self.steps.clear();
        self.cands.clear();
        let mut chain_start = 0usize; // first step of the current chain
        let mut last_kept: Option<usize> = None;
        let mut chains: Vec<(usize, usize)> = Vec::new(); // step ranges
        let mut skipping = false;
        for i in 0..points.len() {
            let q = points[i];
            // the last point is always kept, so the track's end is matched
            if let Some(k) = last_kept
                && i + 1 < points.len()
                && dist_m(points[k], q) < p.min_step_m
            {
                continue;
            }
            last_kept = Some(i);
            out.stats.kept += 1;
            grid.snap_into(g, q, p.radius_m, p.max_candidates, &mut self.snaps);
            out.stats.candidates += self.snaps.len() as u64;
            let prev = (self.steps.len() > chain_start).then(|| self.steps[self.steps.len() - 1]);
            // a recording gap ends the chain outright
            let gap = prev.is_some_and(|s| dist_m(points[s.point as usize], q) > p.max_gap_m);
            if gap {
                chains.push((chain_start, self.steps.len()));
                chain_start = self.steps.len();
                skipping = false;
            }
            if self.snaps.is_empty() {
                out.stats.no_candidates += 1;
                skipping =
                    !self.skip(&mut chains, &mut chain_start, i, &along) && self.steps.len() > chain_start;
                continue;
            }
            let (first, end) = self.push_cands(g);
            let step = Step {
                point: i as u32,
                first,
                end,
                bridged: skipping,
            };
            let Some(prev) = (self.steps.len() > chain_start).then(|| self.steps[self.steps.len() - 1])
            else {
                // a chain starts here
                self.steps.push(Step {
                    bridged: false,
                    ..step
                });
                skipping = false;
                continue;
            };
            let gc = dist_m(points[prev.point as usize], q);
            #[allow(clippy::cast_possible_truncation, reason = "metres")]
            let bound = (gc * p.detour_factor + p.detour_slack_m) as f32;
            self.targets.clear();
            for c in &self.cands[first as usize..end as usize] {
                for v in [g.from(c.edge), g.to(c.edge)] {
                    if !self.targets.contains(&v) {
                        self.targets.push(v);
                    }
                }
            }
            let nb = (end - first) as usize;
            self.trans.clear();
            self.trans.resize(nb, f64::NEG_INFINITY);
            let mut back = vec![u16::MAX; nb];
            for ai in prev.first..prev.end {
                let a = self.cands[ai as usize];
                let src = self.sources(g, &a);
                #[allow(clippy::cast_possible_truncation, reason = "a small factor")]
                let pen = p.oneway_penalty as f32;
                let targets = std::mem::take(&mut self.targets);
                self.search.run(g, &src, &targets, bound, pen);
                self.targets = targets;
                out.stats.searches += 1;
                for bi in 0..nb {
                    let b = self.cands[first as usize + bi];
                    let (cost, _) = self.cost_to(g, &a, &b);
                    if cost > bound {
                        continue;
                    }
                    let t = a.score - (f64::from(cost) - gc).abs() / p.beta_m;
                    if t > self.trans[bi] {
                        self.trans[bi] = t;
                        back[bi] = (ai - prev.first) as u16;
                    }
                }
            }
            if back.iter().all(|&b| b == u16::MAX) {
                // nothing reachable: drop the candidates and skip the point
                self.cands.truncate(first as usize);
                out.stats.unreachable += 1;
                if self.skip(&mut chains, &mut chain_start, i, &along) {
                    // the new chain starts at this point
                    let (first, end) = self.push_cands(g);
                    self.steps.push(Step {
                        point: i as u32,
                        first,
                        end,
                        bridged: false,
                    });
                    skipping = false;
                } else {
                    skipping = true;
                }
                continue;
            }
            for bi in 0..nb {
                let c = &mut self.cands[first as usize + bi];
                c.score += self.trans[bi];
                c.back = back[bi];
            }
            // keep the scores near zero (they only compare within a step)
            let top = self.cands[first as usize..end as usize]
                .iter()
                .map(|c| c.score)
                .fold(f64::NEG_INFINITY, f64::max);
            for c in &mut self.cands[first as usize..end as usize] {
                c.score -= top;
            }
            self.steps.push(step);
            skipping = false;
        }
        chains.push((chain_start, self.steps.len()));

        // backtrack each chain and build its path
        let mut covered_to = 0u32; // last point of the previous chain
        let mut have_prev = false;
        let mut seq: Vec<usize> = Vec::new();
        for &(s0, s1) in &chains {
            if s1 < s0 + 2 {
                continue;
            }
            seq.clear();
            let last = self.steps[s1 - 1];
            let mut ci = (last.first..last.end)
                .max_by(|&x, &y| {
                    self.cands[x as usize]
                        .score
                        .total_cmp(&self.cands[y as usize].score)
                })
                .unwrap_or(last.first) as usize;
            for s in (s0..s1).rev() {
                seq.push(ci);
                let back = self.cands[ci].back;
                if s > s0 {
                    ci = self.steps[s - 1].first as usize + back as usize;
                }
            }
            seq.reverse();
            let (p0, p1) = (self.steps[s0].point, last.point);
            let gap_from = if have_prev { covered_to } else { 0 };
            if p0 > gap_from {
                out.unmatched.push(Unmatched {
                    first_point: gap_from,
                    last_point: p0,
                    length_m: along[p0 as usize] - along[gap_from as usize],
                });
            }
            let first_piece = out.pieces.len() as u32;
            for k in 0..seq.len() - 1 {
                let (a, b) = (self.cands[seq[k]], self.cands[seq[k + 1]]);
                let (pa, pb) = (self.steps[s0 + k].point, self.steps[s0 + k + 1].point);
                self.path(g, &a, &b, pa, pb, &mut out.pieces);
                let d = along[pb as usize] - along[pa as usize];
                let bucket = DIST_BUCKETS_M
                    .iter()
                    .take_while(|&&x| f64::from(b.dist) >= x)
                    .count();
                out.stats.dist_hist_m[bucket] += d;
                if self.steps[s0 + k + 1].bridged {
                    out.stats.bridged_m += d;
                }
                if g.forest_share(b.edge) >= 0.5 {
                    out.stats.forest_m += d;
                    if b.dist >= 20.0 {
                        out.stats.far_forest_m += d;
                    }
                }
            }
            out.stats.matched_m += along[p1 as usize] - along[p0 as usize];
            out.chains.push(Chain {
                first_point: p0,
                last_point: p1,
                first_piece,
                end_piece: out.pieces.len() as u32,
            });
            covered_to = p1;
            have_prev = true;
        }
        let n = points.len() as u32;
        if n > 0 {
            let from = if have_prev { covered_to } else { 0 };
            if from < n - 1 {
                out.unmatched.push(Unmatched {
                    first_point: from,
                    last_point: n - 1,
                    length_m: along[n as usize - 1] - along[from as usize],
                });
            }
        }
        if p.spur_m > 0.0 {
            let mut shift = 0u32;
            for c in &mut out.chains {
                c.first_piece -= shift;
                c.end_piece -= shift;
                let range = c.first_piece as usize..c.end_piece as usize;
                let removed = remove_spurs(g, &mut out.pieces, range, p.spur_m) as u32;
                c.end_piece -= removed;
                shift += removed;
                out.stats.spurs += removed;
            }
        }
        for pc in &out.pieces {
            let m = f64::from(pc.share() * g.length_m(pc.edge));
            out.stats.path_m += m;
            if !g.arc_allowed(pc.arc()) {
                out.stats.contra_oneway_m += m;
            }
        }
        out.stats.settled = self.search.settled - settled0;
        out
    }

    /// Records a skipped point; breaks the chain once too much track was skipped (true if broken).
    fn skip(
        &mut self,
        chains: &mut Vec<(usize, usize)>,
        chain_start: &mut usize,
        i: usize,
        along: &[f64],
    ) -> bool {
        // measured from the last matched point
        let Some(last) = (self.steps.len() > *chain_start).then(|| self.steps[self.steps.len() - 1].point)
        else {
            return false;
        };
        if along[i] - along[last as usize] > self.params.max_skip_m {
            chains.push((*chain_start, self.steps.len()));
            *chain_start = self.steps.len();
            return true;
        }
        false
    }

    /// Turns the current snaps into candidates with their emission score; returns their range.
    #[allow(
        clippy::cast_possible_truncation,
        reason = "candidate counts fit u32; a fraction"
    )]
    fn push_cands(&mut self, g: &Graph) -> (u32, u32) {
        let first = self.cands.len() as u32;
        for s in &self.snaps {
            self.cands.push(Cand {
                edge: s.edge,
                frac: s.fraction as f32,
                dist: s.distance_m as f32,
                len: g.length_m(s.edge),
                score: -0.5 * (s.distance_m / self.params.sigma_m).powi(2),
                back: u16::MAX,
            });
        }
        (first, self.cands.len() as u32)
    }

    /// Appends the pieces from candidate `a` (point `pa`) to `b` (point `pb`).
    fn path(&mut self, g: &Graph, a: &Cand, b: &Cand, pa: u32, pb: u32, pieces: &mut Vec<Piece>) {
        let p = self.params;
        let targets = [g.from(b.edge), g.to(b.edge)];
        let src = self.sources(g, a);
        #[allow(clippy::cast_possible_truncation, reason = "a small factor")]
        let pen = p.oneway_penalty as f32;
        self.search.run(g, &src, &targets, f32::INFINITY, pen);
        let (_, direct) = self.cost_to(g, a, b);
        if direct {
            push(pieces, a.edge, a.frac, b.frac, pa, pb);
            return;
        }
        let via_from = self.search.get(targets[0]) + b.frac * b.len * self.pen(g, arc(b.edge, false));
        let via_to = self.search.get(targets[1]) + (1.0 - b.frac) * b.len * self.pen(g, arc(b.edge, true));
        let (entry, entry_frac) = if via_from <= via_to {
            (targets[0], 0.0)
        } else {
            (targets[1], 1.0)
        };
        // walk back to the source node
        let mut arcs = Vec::new();
        let mut v = entry;
        loop {
            let a = self.search.parent[v as usize];
            if a == NO_ARC || self.search.stamp[v as usize] != self.search.round {
                break;
            }
            arcs.push(a);
            v = g.tail(a);
        }
        arcs.reverse();
        let exit_frac = if v == g.from(a.edge) { 0.0 } else { 1.0 };
        push(pieces, a.edge, a.frac, exit_frac, pa, pb);
        for &x in &arcs {
            let e = arc_edge(x);
            let (s, t) = if arc_is_reverse(x) { (1.0, 0.0) } else { (0.0, 1.0) };
            push(pieces, e, s, t, pa, pb);
        }
        push(pieces, b.edge, entry_frac, b.frac, pa, pb);
    }
}

/// Removes short turn-backs from `pieces[range]` (in place, the rest shifts down): two consecutive
/// pieces on the same edge in opposite directions that meet, where the shorter covers less than
/// `max_m`, become one piece from the first's start to the second's end (or nothing), merged with
/// its neighbours. Catches GPS jitter while standing and detours into a short side edge and back.
/// Returns how many pieces were removed.
fn remove_spurs(g: &Graph, pieces: &mut Vec<Piece>, range: std::ops::Range<usize>, max_m: f64) -> usize {
    let mut out: Vec<Piece> = Vec::with_capacity(range.len());
    for &pc in &pieces[range.clone()] {
        let mut cur = Some(pc);
        while let Some(b) = cur.take() {
            let Some(a) = out.last().copied() else {
                out.push(b);
                break;
            };
            if a.edge == b.edge && (a.end - b.start).abs() < 1e-4 {
                let len = f64::from(g.length_m(a.edge));
                if a.reverse != b.reverse && f64::from(a.share().min(b.share())) * len < max_m {
                    out.pop();
                    if (b.end - a.start).abs() > 1e-6 {
                        cur = Some(Piece {
                            edge: a.edge,
                            reverse: b.end < a.start,
                            start: a.start,
                            end: b.end,
                            first_point: a.first_point,
                            last_point: b.last_point,
                        });
                    }
                    continue;
                }
                if a.reverse == b.reverse {
                    let last = out.last_mut().expect("a is there");
                    last.end = b.end;
                    last.last_point = b.last_point;
                    break;
                }
            }
            out.push(b);
        }
    }
    let removed = range.len() - out.len();
    pieces.splice(range, out);
    removed
}

/// Appends a piece, merging it into the last one when it continues it.
fn push(pieces: &mut Vec<Piece>, edge: EdgeId, start: f32, end: f32, pa: u32, pb: u32) {
    if (end - start).abs() < 1e-6 {
        return;
    }
    let reverse = end < start;
    if let Some(last) = pieces.last_mut()
        && last.edge == edge
        && last.reverse == reverse
        && (last.end - start).abs() < 1e-4
    {
        last.end = end;
        last.last_point = pb;
        return;
    }
    pieces.push(Piece {
        edge,
        reverse,
        start,
        end,
        first_point: pa,
        last_point: pb,
    });
}

/// Equirectangular distance in metres (consecutive track points are close).
#[inline]
#[must_use]
pub fn dist_m(a: LngLat, b: LngLat) -> f64 {
    let kx = f64::midpoint(a.lat, b.lat).to_radians().cos();
    let dx = (b.lng - a.lng) * kx;
    let dy = b.lat - a.lat;
    dx.hypot(dy) * 1e7 * M_PER_E7
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attrs::{EdgeAttrs, Oneway};
    use crate::spatial::DEFAULT_CELL_M;
    use crate::testing::{GRID_CENTER, grid};

    const DEG_PER_M: f64 = 1.0 / (M_PER_E7 * 1e7);

    fn line(from: (f64, f64), to: (f64, f64), step_m: f64) -> Vec<LngLat> {
        let d = (to.0 - from.0).hypot(to.1 - from.1) / DEG_PER_M;
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "a count")]
        let n = (d / step_m).ceil() as usize;
        #[allow(clippy::cast_precision_loss, reason = "small counts")]
        (0..=n)
            .map(|i| {
                let t = i as f64 / n as f64;
                LngLat {
                    lng: from.0 + (to.0 - from.0) * t,
                    lat: from.1 + (to.1 - from.1) * t,
                }
            })
            .collect()
    }

    /// Node (i, j) of `grid(5, 5, 100.0)`.
    fn at(i: f64, j: f64) -> (f64, f64) {
        let s = 100.0 * DEG_PER_M;
        (GRID_CENTER.0 + (i - 2.0) * s, GRID_CENTER.1 + (j - 2.0) * s)
    }

    #[test]
    fn matches_an_l_shaped_ride_with_noise() {
        let built = grid(5, 5, 100.0).build();
        let g = &built.graph;
        let gr = Grid::build(g, DEFAULT_CELL_M);
        let mut pts = line(at(0.0, 0.0), at(3.0, 0.0), 5.0);
        pts.extend(line(at(3.0, 0.0), at(3.0, 4.0), 5.0).into_iter().skip(1));
        // a few metres of noise, alternating sides
        for (k, q) in pts.iter_mut().enumerate() {
            q.lat += if k % 2 == 0 { 4.0 } else { -4.0 } * DEG_PER_M;
        }
        let mut m = Matcher::new(g, MatchParams::default());
        let r = m.match_track(g, &gr, &pts);
        assert_eq!(r.chains.len(), 1, "{r:?}");
        // 3 east edges + 4 north edges, all along their geometry
        // (the start point's noise may add a few metres on the edge north of the corner)
        let arcs: Vec<_> = r
            .pieces
            .iter()
            .filter(|p| p.share() > 0.2)
            .map(|p| (p.edge, p.reverse))
            .collect();
        let east: Vec<_> = (0..3).map(|i| (built.edge(i), false)).collect();
        // north edges of column 3: handle 20 + 3 * 4 + j
        let north: Vec<_> = (0..4).map(|j| (built.edge(20 + 3 * 4 + j), false)).collect();
        assert_eq!(arcs, [east, north].concat());
        assert!((r.stats.path_m - 700.0).abs() < 10.0, "{}", r.stats.path_m);
        assert!(r.unmatched.is_empty() || r.unmatched.iter().all(|u| u.length_m < 1.0));
    }

    #[test]
    fn reversed_ride_gives_reversed_arcs() {
        let built = grid(5, 5, 100.0).build();
        let g = &built.graph;
        let gr = Grid::build(g, DEFAULT_CELL_M);
        let pts = line(at(4.0, 1.0), at(0.0, 1.0), 10.0);
        let mut m = Matcher::new(g, MatchParams::default());
        let r = m.match_track(g, &gr, &pts);
        assert_eq!(r.pieces.len(), 4, "{:#?}", r.pieces);
        assert!(r.pieces.iter().all(|p| p.reverse && p.share() > 0.99));
    }

    #[test]
    fn an_off_graph_stretch_breaks_the_chain() {
        let built = grid(5, 5, 100.0).build();
        let g = &built.graph;
        let gr = Grid::build(g, DEFAULT_CELL_M);
        // along row 0, then 600 m off the grid to the south and back onto row 0
        let mut pts = line(at(0.0, 0.0), at(2.0, 0.0), 10.0);
        pts.extend(line(at(2.0, 0.0), at(2.0, -6.0), 10.0));
        pts.extend(line(at(2.0, -6.0), at(4.0, -6.0), 10.0));
        pts.extend(line(at(4.0, -6.0), at(4.0, 0.0), 10.0));
        pts.extend(line(at(4.0, 0.0), at(4.0, 2.0), 10.0));
        let mut m = Matcher::new(g, MatchParams::default());
        let r = m.match_track(g, &gr, &pts);
        assert_eq!(r.chains.len(), 2, "{:?}", r.chains);
        let off: f64 = r.unmatched.iter().map(|u| u.length_m).sum();
        assert!(off > 1100.0 && off < 1500.0, "{off}");
    }

    #[test]
    fn rides_against_a_one_way() {
        let mut b = crate::testing::GraphBuilder::new();
        let (x0, y) = GRID_CENTER;
        let n: Vec<_> = (0..4)
            .map(|i| b.node(x0 + f64::from(i) * 100.0 * DEG_PER_M, y))
            .collect();
        let ow = EdgeAttrs {
            oneway: Oneway::Along,
            ..EdgeAttrs::default()
        };
        for w in n.windows(2) {
            b.edge(w[1], w[0], ow);
        }
        let built = b.build();
        let g = &built.graph;
        let gr = Grid::build(g, DEFAULT_CELL_M);
        let pts = line((x0, y), (x0 + 300.0 * DEG_PER_M, y), 10.0);
        let mut m = Matcher::new(g, MatchParams::default());
        let r = m.match_track(g, &gr, &pts);
        assert_eq!(r.chains.len(), 1);
        assert!((r.stats.contra_oneway_m - 300.0).abs() < 2.0, "{:?}", r.stats);
    }

    #[test]
    fn spurs_and_jitter_are_removed() {
        let built = grid(5, 5, 100.0).build();
        let g = &built.graph;
        let (e0, e1, side) = (built.edge(0), built.edge(1), built.edge(20 + 4));
        let pc = |edge, start: f32, end: f32| Piece {
            edge,
            reverse: end < start,
            start,
            end,
            first_point: 0,
            last_point: 1,
        };
        // along e0, 10 m into a side edge and back, back 5 m on e0 and on again, then e1
        let mut pieces = vec![
            pc(e0, 0.0, 1.0),
            pc(side, 0.0, 0.1),
            pc(side, 0.1, 0.0),
            pc(e1, 0.0, 0.5),
            pc(e1, 0.5, 0.45),
            pc(e1, 0.45, 1.0),
        ];
        let removed = remove_spurs(g, &mut pieces, 0..6, 30.0);
        assert_eq!(removed, 4);
        assert_eq!(
            pieces,
            vec![
                pc(e0, 0.0, 1.0),
                Piece {
                    last_point: 1,
                    ..pc(e1, 0.0, 1.0)
                }
            ]
        );
        // a real turn-back (60 m) stays
        let mut pieces = vec![pc(e0, 0.0, 0.6), pc(e0, 0.6, 0.0)];
        assert_eq!(remove_spurs(g, &mut pieces, 0..2, 30.0), 0);
    }
}
