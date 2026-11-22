//! The turn cost (`docs/routing.md#turns`): metres-equivalent per turn at a junction, by angle, so a
//! route does not leave a road for a few hundred metres of a slightly cheaper way and rejoin it at
//! once. A fixed cost like barriers: the profile's `turn_m` is what a right-angle turn costs,
//! whatever the profile's factors.
//!
//! - A node with fewer than three edges is not a junction: a bend there costs nothing.
//! - At a junction the heading change `θ` to the way taken counts from 30° (straight on is free) and
//!   reaches `turn_m` at 90° and twice it from 150°: `ramp(θ) = clamp((θ − 30°) / 60°, 0, 2)`.
//! - Leaving the straightest way on (the through road) costs at least half a turn, phased in over
//!   the first 30° by which the way taken is less straight: a road and a track leaving it at 20°
//!   are not a fork of equals. Following the straightest way costs only its bend.
//! - A U-turn (back along the arc just ridden, at a junction, a dead end, a bend or mid-edge at a
//!   via) costs the most a turn can: `2 × turn_m`. So a U-turn never buys a cheaper turn later.
//!
//! The headings come from the edge geometry ~15 m from the node (stepping over tiny kinks), a byte
//! per adjacency slot (4.7 MB for 2.3 M edges) computed once when the planner is built (from
//! straight segments where the geometry is not loaded: the web app's lazy mode).

use crate::graph::{ArcId, Graph, NodeId, arc};

/// Headings are bytes: 256 steps of this many degrees, 0 north, clockwise.
const STEP_DEG: f32 = 360.0 / 256.0;

/// The last points of an edge kept for its heading at the end.
const RING: usize = 16;

/// How far from the node a heading looks (metres).
const LOOK_M: f32 = 15.0;

/// The heading change from which a turn costs anything (degrees).
pub const FREE_DEG: f32 = 30.0;

/// The extra degrees over [`FREE_DEG`] that make a full turn (`turn_m`).
const FULL_DEG: f32 = 60.0;

/// The most a turn costs, in turns (a U-turn).
pub const MAX_SHARE: f32 = 2.0;

/// Leaving the through road costs at least this share of a turn ...
const LEAVE_SHARE: f32 = 0.5;

/// ... once the way taken is this many degrees less straight than the through road.
const LEAVE_DEG: f32 = 30.0;

/// The departure heading of every adjacency slot (the slot's arc at its tail), in slot order: a
/// node's headings are contiguous, like its arcs. And per node the most a turn there can cost
/// (U-turns aside), in hundredths of a turn rounded up: the search's dominance slack.
#[derive(Debug, Clone, Default)]
pub struct Headings {
    dep: Vec<u8>,
    max_share: Vec<u8>,
    /// [`share`] by heading change in steps (0..=128): following the straightest way, and the
    /// least for leaving it by so many steps more.
    ramp: Vec<f32>,
    leave: Vec<f32>,
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a heading in 256 steps"
)]
fn heading_byte(dx: f32, dy: f32) -> u8 {
    let deg = dx.atan2(dy).to_degrees().rem_euclid(360.0);
    ((deg / STEP_DEG).round() as u32 % 256) as u8
}

impl Headings {
    /// Every slot's heading from the graph's geometry (straight segments where none is loaded).
    #[must_use]
    #[allow(clippy::cast_possible_truncation, reason = "a scale factor")]
    pub fn build(g: &Graph) -> Headings {
        let m = crate::M_PER_E7 as f32;
        // per arc first, then in slot order
        let mut by_arc = vec![0u8; g.arc_count()];
        // the last points of an edge, for the heading back from its end
        let mut ring = [(0i32, 0i32); RING];
        #[allow(clippy::cast_possible_truncation, reason = "edge ids fit u32")]
        for e in 0..g.edge_count() as u32 {
            let mut it = g.edge_points(e);
            let Some(p0) = it.next() else { continue };
            #[allow(clippy::cast_precision_loss, reason = "coordinates")]
            let kx = ((p0.1 as f32) * 1e-7).to_radians().cos() * m;
            #[allow(clippy::cast_precision_loss, reason = "coordinate deltas")]
            let d = |p: (i32, i32), q: (i32, i32)| ((q.0 - p.0) as f32 * kx, (q.1 - p.1) as f32 * m);
            let far = |p: (i32, i32), q: (i32, i32)| {
                let (dx, dy) = d(p, q);
                dx * dx + dy * dy >= LOOK_M * LOOK_M
            };
            let heading = |p: (i32, i32), q: (i32, i32)| {
                let (dx, dy) = d(p, q);
                (dx != 0.0 || dy != 0.0).then(|| heading_byte(dx, dy))
            };
            // from the start along: the first point 15 m away (or the end)
            let (mut ahead, mut last, mut n) = (None, p0, 1usize);
            ring[0] = p0;
            for c in it {
                if ahead.is_none() && far(p0, c) {
                    ahead = Some(c);
                }
                ring[n % RING] = c;
                n += 1;
                last = c;
            }
            if let Some(h) = heading(p0, ahead.unwrap_or(last)) {
                by_arc[arc(e, false) as usize] = h;
            }
            // from the end back: the last point 15 m before it (within the last few)
            let mut back = last;
            for k in (n.saturating_sub(RING)..n.saturating_sub(1)).rev() {
                back = ring[k % RING];
                if far(last, back) {
                    break;
                }
            }
            if let Some(h) = heading(last, back) {
                by_arc[arc(e, true) as usize] = h;
            }
        }
        let dep = (0..g.slot_count())
            .map(|s| by_arc[g.slot_arc(s) as usize])
            .collect();
        let deg = |k: u8| f32::from(k) * STEP_DEG;
        let mut h = Headings {
            dep,
            max_share: Vec::new(),
            ramp: (0..=128u8).map(|k| share(deg(k), Some(deg(k)))).collect(),
            leave: (0..=128u8)
                .map(|k| LEAVE_SHARE * (deg(k) / LEAVE_DEG).min(1.0))
                .collect(),
        };
        // per junction a bound of its shares: the sharpest turn between two of its ways, at least
        // the share of leaving the through road
        #[allow(clippy::cast_possible_truncation, reason = "node ids fit u32")]
        let max_share = (0..g.node_count() as NodeId)
            .map(|v| {
                let r = g.slot_range(v);
                if r.len() < 3 {
                    return 0; // no junction: free, and a label may not turn back
                }
                let mut most = LEAVE_SHARE;
                for i in r.clone() {
                    let arr = h.dep[i].wrapping_add(128);
                    for j in r.clone() {
                        if j != i {
                            most = most.max(h.ramp[change_steps(arr, h.dep[j]) as usize]);
                        }
                    }
                }
                #[allow(clippy::cast_sign_loss, reason = "a share in 0..=2")]
                let q = (most * 100.0).ceil().min(255.0) as u8;
                q
            })
            .collect();
        h.max_share = max_share;
        h
    }

    /// The most a turn at `v` can cost, in hundredths of a turn rounded up (U-turns aside).
    #[inline]
    #[must_use]
    pub fn max_share_byte(&self, v: NodeId) -> u8 {
        self.max_share.get(v as usize).copied().unwrap_or(u8::MAX)
    }

    /// Heap bytes held.
    #[must_use]
    pub fn heap_bytes(&self) -> usize {
        self.dep.capacity() + self.max_share.capacity()
    }

    /// The departure heading of slot `s`.
    #[inline]
    #[must_use]
    pub fn slot(&self, s: usize) -> u8 {
        self.dep[s]
    }

    /// The heading arc `a` leaves its tail with (0 if it is in no slot).
    #[must_use]
    pub fn departure(&self, g: &Graph, a: ArcId) -> u8 {
        let v = g.tail(a);
        g.slot_range(v)
            .find(|&s| g.slot_arc(s) == a)
            .map_or(0, |s| self.dep[s])
    }

    /// The heading arc `a` arrives at its head with.
    #[must_use]
    pub fn arrival(&self, g: &Graph, a: ArcId) -> u8 {
        self.departure(g, a ^ 1).wrapping_add(128)
    }
}

/// The heading change between an arrival and a departure heading, 0..=180 degrees.
#[inline]
#[must_use]
#[allow(clippy::cast_possible_wrap, reason = "a signed difference of headings")]
pub fn change_deg(arrival: u8, departure: u8) -> f32 {
    let d = departure.wrapping_sub(arrival) as i8;
    f32::from(d.unsigned_abs()) * STEP_DEG
}

/// The share of a turn (a multiple of `turn_m`) for a heading change `theta` to the way taken, when
/// the straightest other way on (not back) changes heading by `straightest` (`None`: there is none,
/// the node is no junction).
#[inline]
#[must_use]
pub fn share(theta: f32, straightest: Option<f32>) -> f32 {
    let Some(s) = straightest else {
        return 0.0;
    };
    let ramp = ((theta - FREE_DEG) / FULL_DEG).clamp(0.0, MAX_SHARE);
    if theta <= s {
        ramp
    } else {
        ramp.max(LEAVE_SHARE * ((theta - s) / LEAVE_DEG).min(1.0))
    }
}

/// The heading change between an arrival and a departure heading in steps, 0..=128.
#[inline]
#[allow(clippy::cast_possible_wrap, reason = "a signed difference of headings")]
fn change_steps(arrival: u8, departure: u8) -> u8 {
    (departure.wrapping_sub(arrival) as i8).unsigned_abs()
}

/// The shares of a turn for every way out of `v = head(a_in)` after arriving by `a_in`, one per
/// adjacency slot of `v` (the order of [`Graph::arcs_at`]) into `out` ([`share`] by table).
pub fn shares_at(g: &Graph, h: &Headings, a_in: ArcId, out: &mut Vec<f32>) {
    let v: NodeId = g.head(a_in);
    let slots = g.slot_range(v);
    out.clear();
    let back = a_in ^ 1;
    let Some(back_slot) = slots.clone().find(|&s| g.slot_arc(s) == back) else {
        out.resize(slots.len(), 0.0);
        return;
    };
    if slots.len() < 3 {
        // no junction: free, but back
        out.extend(slots.map(|s| if s == back_slot { MAX_SHARE } else { 0.0 }));
        return;
    }
    let arr = h.dep[back_slot].wrapping_add(128);
    // the two smallest heading changes among the ways on (not back)
    let (mut m1, mut i1, mut m2) = (u8::MAX, usize::MAX, u8::MAX);
    for s in slots.clone() {
        if s == back_slot {
            continue;
        }
        let t = change_steps(arr, h.dep[s]);
        if t < m1 {
            (m2, m1, i1) = (m1, t, s);
        } else if t < m2 {
            m2 = t;
        }
    }
    out.extend(slots.map(|s| {
        if s == back_slot {
            return MAX_SHARE;
        }
        let t = change_steps(arr, h.dep[s]);
        let other = if s == i1 { m2 } else { m1 };
        let ramp = h.ramp[t as usize];
        if t <= other {
            ramp
        } else {
            ramp.max(h.leave[(t - other) as usize])
        }
    }));
}

/// The share of a turn from arc `a` onto arc `b` (`tail(b) = head(a)`); 0 when they do not meet.
/// Riding on along the same arc (a via mid-edge) is no turn, back along it a U-turn.
#[must_use]
pub fn share_between(g: &Graph, h: &Headings, a: ArcId, b: ArcId, scratch: &mut Vec<f32>) -> f32 {
    if a == b {
        return 0.0;
    }
    if a == b ^ 1 {
        return MAX_SHARE;
    }
    let v = g.head(a);
    if g.tail(b) != v {
        return 0.0;
    }
    shares_at(g, h, a, scratch);
    g.slot_range(v)
        .position(|s| g.slot_arc(s) == b)
        .and_then(|i| scratch.get(i).copied())
        .unwrap_or(0.0)
}

/// The turns of a line of arcs: how many cost something and their cost (`turn_m` per turn), between
/// consecutive arcs, in riding order.
#[must_use]
pub fn line_turns(g: &Graph, h: &Headings, turn_m: f32, arcs: &[ArcId]) -> (u32, f32) {
    let mut scratch = Vec::new();
    let (mut n, mut cost) = (0u32, 0.0f32);
    if turn_m <= 0.0 {
        return (0, 0.0);
    }
    for w in arcs.windows(2) {
        let s = share_between(g, h, w[0], w[1], &mut scratch);
        if s > 0.0 {
            n += 1;
            cost += s * turn_m;
        }
    }
    (n, cost)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attrs::EdgeAttrs;
    use crate::testing::GraphBuilder;

    #[test]
    fn the_share_ramps_with_the_angle_and_leaving_the_through_road() {
        // no junction: free
        assert_eq!(share(90.0, None), 0.0);
        // straight on and small bends are free, 90° is a turn, 150° and more two
        assert_eq!(share(0.0, Some(90.0)), 0.0);
        assert_eq!(share(30.0, Some(90.0)), 0.0);
        assert!((share(90.0, Some(90.0)) - 1.0).abs() < 1e-6);
        assert!((share(180.0, Some(180.0)) - MAX_SHARE).abs() < 1e-6);
        // leaving a straight road at 20° costs half a turn, following it nothing
        assert!((share(30.0, Some(0.0)) - 0.5).abs() < 1e-6);
        assert_eq!(share(0.0, Some(30.0)), 0.0);
        // a fork of near equals costs almost nothing either way: continuous at the tie
        assert!(share(22.0, Some(20.0)) < 0.05);
        // leaving at a right angle: a full turn
        assert!((share(90.0, Some(0.0)) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn headings_and_turns_at_a_crossing() {
        // a crossing at c, arms 100 m long to the west, east, north and south, plus a bend b
        // (degree 2) north of n
        let mut b = GraphBuilder::new();
        let m = 1.0 / 111_195.0;
        let (x, y) = (0.07, 0.08);
        let c = b.node(x, y);
        let w = b.node(x - 100.0 * m, y);
        let e = b.node(x + 100.0 * m, y);
        let n = b.node(x, y + 100.0 * m);
        let s = b.node(x, y - 100.0 * m);
        let nb = b.node(x + 100.0 * m, y + 200.0 * m);
        let ew = b.edge(w, c, EdgeAttrs::default());
        let ee = b.edge(c, e, EdgeAttrs::default());
        let en = b.edge(c, n, EdgeAttrs::default());
        let es = b.edge(s, c, EdgeAttrs::default());
        let enb = b.edge(n, nb, EdgeAttrs::default());
        let built = b.build();
        let g = &built.graph;
        let h = Headings::build(g);
        let (ew, ee, en, es, enb) = (
            built.edge(ew),
            built.edge(ee),
            built.edge(en),
            built.edge(es),
            built.edge(enb),
        );
        // east along w → c: heading 90° (64 steps)
        assert_eq!(h.departure(g, arc(ew, false)), 64);
        assert_eq!(h.arrival(g, arc(ew, false)), 64);
        assert_eq!(h.departure(g, arc(en, false)), 0);
        assert_eq!(h.departure(g, arc(es, true)), 128);
        let mut sc = Vec::new();
        let east_in = arc(ew, false);
        assert_eq!(share_between(g, &h, east_in, arc(ee, false), &mut sc), 0.0);
        assert!((share_between(g, &h, east_in, arc(en, false), &mut sc) - 1.0).abs() < 0.02);
        assert!((share_between(g, &h, east_in, arc(es, true), &mut sc) - 1.0).abs() < 0.02);
        assert_eq!(share_between(g, &h, east_in, arc(ew, true), &mut sc), MAX_SHARE);
        // the bend at n (degree 2) is free, a U-turn there is not
        assert_eq!(
            share_between(g, &h, arc(en, false), arc(enb, false), &mut sc),
            0.0
        );
        assert_eq!(
            share_between(g, &h, arc(en, false), arc(en, true), &mut sc),
            MAX_SHARE
        );
        // a line: west → crossing → north → bend: one turn
        let (n_turns, cost) = line_turns(g, &h, 60.0, &[east_in, arc(en, false), arc(enb, false)]);
        assert_eq!(n_turns, 1);
        assert!((cost - 60.0).abs() < 1.5);
        assert_eq!(line_turns(g, &h, 0.0, &[east_in, arc(en, false)]), (0, 0.0));
    }
}
