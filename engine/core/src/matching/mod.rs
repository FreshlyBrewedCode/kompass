//! Map-matching: a recorded track → the arcs it rode, for the personal history (`docs/matching.md`).
//!
//! A hidden Markov model after Newson & Krumm (2009): per track point the candidate positions on
//! the nearest edges, an emission score by the GPS distance, a transition score by how much the
//! network distance between two candidates differs from the great-circle distance between the two
//! points, and Viterbi for the best sequence. One-way restrictions are followed with a light
//! penalty only (riders do ride against them) and access is ignored. The parameters and the
//! algorithm are those spike #5 measured on a real history; do not tune them without re-measuring
//! (`kompass match` over a directory of tracks prints the aggregates).
//!
//! - **Preprocessing**: a point is kept once it is `min_step_m` from the last kept one (drops
//!   stationary jitter and thins dense recordings); the last point is always kept.
//! - **Breaks**: a point without candidates, or whose candidates cannot be reached from the last
//!   matched point within the detour bound, is skipped; once more than `max_skip_m` of track is
//!   skipped (or two points are more than `max_gap_m` apart) the chain ends and a new one starts.
//!   The track between two chains is an [`Unmatched`] stretch.
//! - **Spurs**: a turn-back on one edge shorter than `spur_m` is GPS noise and is removed.
//! - **Output**: the ridden path as [`Piece`]s in riding order ([`Match`]), or as plain arrays
//!   ([`MatchResult`]: arcs, coverage, first point per arc, unmatched stretches, lengths).
//! - **Lazy geometry**: matching needs the edge geometry, which loads per tile. [`needed_tiles`]
//!   names the tiles a track touches; [`TileGrids`] builds a snap grid per tile on demand. A tile
//!   without geometry is matched on the straight segments between its nodes.
//! - [`explored`]: folding matches and ride dates into per-edge, per-direction counts.

mod explored;
mod search;
mod spurs;
mod tiles;

use crate::graph::{ArcId, EdgeId, Graph, NodeId, arc, arc_edge, arc_is_reverse};
use crate::spatial::Snap;
use crate::{LngLat, M_PER_E7};
use search::{NO_ARC, Search};
use spurs::{push, remove_spurs};

pub use explored::{ArcStat, Explored, ExploredEdge, MIN_COVERAGE, RideMatchRef, ridden_arcs};
pub use tiles::{TileGrids, missing_geometry, needed_tiles, needed_tiles_of};

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

    /// The covered share as a byte: `share × 255`, rounded.
    #[must_use]
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "clamped to 0..=255"
    )]
    pub fn coverage(&self) -> u8 {
        (self.share() * 255.0).round().clamp(0.0, 255.0) as u8
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
    /// Matched track length across skipped points (bridged by the network path).
    pub bridged_m: f64,
}

/// A matched track, as pieces.
#[derive(Debug, Clone, Default)]
pub struct Match {
    pub pieces: Vec<Piece>,
    pub chains: Vec<Chain>,
    pub unmatched: Vec<Unmatched>,
    pub stats: MatchStats,
}

/// A matched track as plain arrays, the seam to the browser (no serde needed): what is stored per
/// ride and what [`explored`] folds.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MatchResult {
    /// The arcs ridden in riding order (`edge << 1 | reverse`), spurs removed, consecutive
    /// pieces on the same arc merged. An arc can appear more than once (a loop).
    pub arcs: Vec<u32>,
    /// Per arc: the covered share of the edge × 255 (255 almost everywhere; less at a ride's ends).
    pub coverage: Vec<u8>,
    /// Per arc: the first track point (index into the input) that covered it.
    pub first_point: Vec<u32>,
    pub unmatched: Vec<Unmatched>,
    /// Length of the whole track (m).
    pub track_m: f64,
    /// Track length inside matched chains.
    pub matched_m: f64,
    /// Length of the matched path on the graph.
    pub path_m: f64,
    /// Chain breaks (unmatched stretches between two matched chains).
    pub breaks: u32,
}

impl Match {
    /// The flat arrays.
    #[must_use]
    pub fn to_result(&self) -> MatchResult {
        MatchResult {
            arcs: self.pieces.iter().map(Piece::arc).collect(),
            coverage: self.pieces.iter().map(Piece::coverage).collect(),
            first_point: self.pieces.iter().map(|p| p.first_point).collect(),
            unmatched: self.unmatched.clone(),
            track_m: self.stats.track_m,
            matched_m: self.stats.matched_m,
            path_m: self.stats.path_m,
            breaks: u32::try_from(self.chains.len().saturating_sub(1)).unwrap_or(u32::MAX),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Cand {
    edge: EdgeId,
    frac: f32,
    len: f32,
    score: f64,
    back: u16,
}

/// One HMM step: a kept point and its candidates (a range of `Matcher::cands`).
#[derive(Debug, Clone, Copy)]
struct Step {
    point: u32,
    first: u32,
    end: u32,
    /// Points were skipped (no reachable candidate) between the previous step and this one.
    bridged: bool,
}

/// The matcher: parameters and reusable scratch (a few kilobytes: the searches are sparse).
#[derive(Debug, Clone)]
pub struct Matcher {
    pub params: MatchParams,
    search: Search,
    snaps: Vec<Snap>,
    cands: Vec<Cand>,
    steps: Vec<Step>,
    targets: Vec<NodeId>,
    trans: Vec<f64>,
    back: Vec<u16>,
}

impl Default for Matcher {
    fn default() -> Self {
        Matcher::new(MatchParams::default())
    }
}

impl Matcher {
    #[must_use]
    pub fn new(params: MatchParams) -> Matcher {
        Matcher {
            params,
            search: Search::new(),
            snaps: Vec::new(),
            cands: Vec::new(),
            steps: Vec::new(),
            targets: Vec::new(),
            trans: Vec::new(),
            back: Vec::new(),
        }
    }

    /// Bytes of scratch held (the search table and heap).
    #[must_use]
    pub fn heap_bytes(&self) -> usize {
        self.search.heap_bytes()
    }

    /// The tiles a track touches (within the candidate radius): load their graph and geometry
    /// files first (see [`needed_tiles`]). The tile indices are those of `GraphInfo::tiles`.
    #[must_use]
    pub fn tiles_needed<T: Copy + Into<f64>>(&self, g: &Graph, lat: &[T], lon: &[T]) -> Vec<usize> {
        needed_tiles(g, self.params.radius_m, lat, lon)
    }

    /// Matches a track given as latitude and longitude arrays (degrees, recording order; f32 or
    /// f64) and returns plain arrays. A pair that is not finite is skipped.
    pub fn match_arrays<T: Copy + Into<f64>>(
        &mut self,
        g: &Graph,
        grids: &mut TileGrids,
        lat: &[T],
        lon: &[T],
    ) -> MatchResult {
        let points: Vec<LngLat> = lat
            .iter()
            .zip(lon)
            .map(|(&la, &lo)| LngLat {
                lng: lo.into(),
                lat: la.into(),
            })
            .collect();
        self.match_track(g, grids, &points).to_result()
    }

    /// The cost to leave candidate `c` towards its two end nodes.
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

    #[inline]
    #[allow(clippy::cast_possible_truncation, reason = "a small factor")]
    fn penalty(&self) -> f32 {
        self.params.oneway_penalty as f32
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

    /// Matches one track (points in recording order), building the grids of the tiles it touches
    /// first. Tiles without geometry are matched on straight segments: load the geometry of
    /// [`Matcher::tiles_needed`] beforehand for the real thing. A point that is not finite is
    /// skipped.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::too_many_lines,
        reason = "point and candidate indices fit u32/u16; the Viterbi loop reads best in one piece"
    )]
    pub fn match_track(&mut self, g: &Graph, grids: &mut TileGrids, points: &[LngLat]) -> Match {
        let p = self.params;
        let mut out = Match::default();
        let settled0 = self.search.settled;
        grids.ensure(
            g,
            &needed_tiles_of(
                g,
                p.radius_m,
                points
                    .iter()
                    .copied()
                    .filter(|q| q.lat.is_finite() && q.lng.is_finite()),
            ),
        );
        // prefix track length per point (a point that is not finite adds nothing)
        let valid = |q: LngLat| q.lat.is_finite() && q.lng.is_finite();
        let mut along = Vec::with_capacity(points.len());
        let mut total = 0.0;
        let mut prev_valid: Option<LngLat> = None;
        for &q in points {
            if valid(q) {
                if let Some(a) = prev_valid {
                    total += dist_m(a, q);
                }
                prev_valid = Some(q);
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
        let last_valid = points.iter().rposition(|&q| valid(q));
        for i in 0..points.len() {
            let q = points[i];
            if !valid(q) {
                continue;
            }
            // the last point is always kept, so the track's end is matched
            if let Some(k) = last_kept
                && Some(i) != last_valid
                && dist_m(points[k], q) < p.min_step_m
            {
                continue;
            }
            last_kept = Some(i);
            out.stats.kept += 1;
            grids.snap_into(g, q, p.radius_m, p.max_candidates, &mut self.snaps);
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
            self.back.clear();
            self.back.resize(nb, u16::MAX);
            let pen = self.penalty();
            for ai in prev.first..prev.end {
                let a = self.cands[ai as usize];
                let src = self.sources(g, &a);
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
                        self.back[bi] = (ai - prev.first) as u16;
                    }
                }
            }
            if self.back.iter().all(|&b| b == u16::MAX) {
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
                c.back = self.back[bi];
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
                if self.steps[s0 + k + 1].bridged {
                    out.stats.bridged_m += along[pb as usize] - along[pa as usize];
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
                len: g.length_m(s.edge),
                score: -0.5 * (s.distance_m / self.params.sigma_m).powi(2),
                back: u16::MAX,
            });
        }
        (first, self.cands.len() as u32)
    }

    /// Appends the pieces from candidate `a` (point `pa`) to `b` (point `pb`).
    fn path(&mut self, g: &Graph, a: &Cand, b: &Cand, pa: u32, pb: u32, pieces: &mut Vec<Piece>) {
        let targets = [g.from(b.edge), g.to(b.edge)];
        let src = self.sources(g, a);
        let pen = self.penalty();
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
            let a = self.search.parent(v);
            if a == NO_ARC {
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
mod tests;
