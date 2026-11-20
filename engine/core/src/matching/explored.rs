//! The explored fold: matches of many rides and their dates → per edge and direction, how many
//! rides rode it and when last.
//!
//! **The rule** (spike #5): a ride rode an arc (an edge in one direction) when its pieces on that
//! arc cover at least half of the edge (`coverage ≥ 128` of 255, the pieces of one arc summed:
//! passing an edge twice in a ride counts once). An edge is ridden by a ride when either of its
//! arcs is. The half drops the stub at a ride's start and end (the first metres of a driveway)
//! and, on real rides, hardly changes the explored length: 99.4 % of (ride, edge) pairs are
//! covered 99 % or more.
//!
//! Days are whole days since 1970-01-01 (UTC); 0 means "no date" (an untimed ride).

use std::collections::HashMap;

use crate::graph::{ArcId, EdgeId, arc_edge, arc_is_reverse};

/// The coverage byte (share × 255) from which an arc counts as ridden: 50 %.
pub const MIN_COVERAGE: u8 = 128;

/// One ride's match, borrowed (what the browser stores per ride) with the ride's day.
#[derive(Debug, Clone, Copy)]
pub struct RideMatchRef<'a> {
    pub arcs: &'a [ArcId],
    pub coverage: &'a [u8],
    /// Days since the epoch of the ride's end, 0 if it has no time.
    pub day: u32,
}

/// The arcs a ride rode under the 50 % rule, sorted and unique.
#[must_use]
pub fn ridden_arcs(arcs: &[ArcId], coverage: &[u8]) -> Vec<ArcId> {
    let mut sum: Vec<(ArcId, u32)> = arcs
        .iter()
        .copied()
        .zip(coverage.iter().map(|&c| u32::from(c)))
        .collect();
    sum.sort_unstable_by_key(|&(a, _)| a);
    let mut out: Vec<ArcId> = Vec::new();
    let mut i = 0;
    while i < sum.len() {
        let a = sum[i].0;
        let mut c = 0;
        while i < sum.len() && sum[i].0 == a {
            c += sum[i].1;
            i += 1;
        }
        if c >= u32::from(MIN_COVERAGE) {
            out.push(a);
        }
    }
    out
}

/// Rides and the last day for one arc.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ArcStat {
    pub count: u32,
    pub last_day: u32,
}

impl ArcStat {
    fn add(&mut self, day: u32) {
        self.count += 1;
        self.last_day = self.last_day.max(day);
    }
}

/// One explored edge: the rides that rode it in either direction, and per direction.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ExploredEdge {
    pub edge: EdgeId,
    /// Rides that rode the edge in either direction (a ride in both counts once).
    pub count: u32,
    pub last_day: u32,
    /// Along the edge's direction (`from` → `to`).
    pub along: ArcStat,
    /// Against it.
    pub against: ArcStat,
}

/// The fold: the explored edges, sorted by edge id (sparse: a history touches about 1 % of a region).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Explored {
    pub edges: Vec<ExploredEdge>,
}

impl Explored {
    /// Folds rides. A full refold is cheap (a million arcs take ~100 ms), so import, delete and
    /// rematch all just refold.
    #[must_use]
    pub fn fold<'a>(rides: impl IntoIterator<Item = RideMatchRef<'a>>) -> Explored {
        let mut map: HashMap<EdgeId, ExploredEdge> = HashMap::new();
        for ride in rides {
            let arcs = ridden_arcs(ride.arcs, ride.coverage);
            let mut i = 0;
            while i < arcs.len() {
                let edge = arc_edge(arcs[i]);
                let x = map.entry(edge).or_insert(ExploredEdge {
                    edge,
                    ..ExploredEdge::default()
                });
                // the arcs are sorted: an edge's along arc, then its against arc
                let mut any = false;
                while i < arcs.len() && arc_edge(arcs[i]) == edge {
                    if arc_is_reverse(arcs[i]) {
                        x.against.add(ride.day);
                    } else {
                        x.along.add(ride.day);
                    }
                    any = true;
                    i += 1;
                }
                if any {
                    x.count += 1;
                    x.last_day = x.last_day.max(ride.day);
                }
            }
        }
        let mut edges: Vec<ExploredEdge> = map.into_values().collect();
        edges.sort_unstable_by_key(|e| e.edge);
        Explored { edges }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.edges.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.edges.is_empty()
    }

    #[must_use]
    pub fn get(&self, edge: EdgeId) -> Option<&ExploredEdge> {
        self.edges
            .binary_search_by_key(&edge, |e| e.edge)
            .ok()
            .map(|i| &self.edges[i])
    }

    /// The stats of one arc (`None` if the edge is not explored).
    #[must_use]
    pub fn arc(&self, a: ArcId) -> Option<ArcStat> {
        self.get(arc_edge(a))
            .map(|e| if arc_is_reverse(a) { e.against } else { e.along })
    }

    /// Flat arrays indexed by edge id, for a query's personal layer: `(count, last_day)`, 0 where
    /// an edge is not explored. About 8 bytes per edge: build them only when a query wants them.
    #[must_use]
    pub fn to_flat(&self, edge_count: usize) -> (Vec<u32>, Vec<u32>) {
        let (mut count, mut last) = (vec![0; edge_count], vec![0; edge_count]);
        for e in self.edges.iter().filter(|e| (e.edge as usize) < edge_count) {
            count[e.edge as usize] = e.count;
            last[e.edge as usize] = e.last_day;
        }
        (count, last)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::assert_is_empty, reason = "reads best")]
    use super::*;
    use crate::graph::arc;

    fn ride<'a>(arcs: &'a [ArcId], coverage: &'a [u8], day: u32) -> RideMatchRef<'a> {
        RideMatchRef { arcs, coverage, day }
    }

    #[test]
    fn half_an_edge_makes_it_ridden() {
        assert_eq!(ridden_arcs(&[2, 4, 6], &[255, 127, 128]), vec![2, 6]);
        // the pieces of one arc add up: two quarters (a ride that passes an edge twice, or a
        // stop in the middle) make half
        assert_eq!(ridden_arcs(&[8, 3, 8], &[64, 255, 64]), vec![3, 8]);
        assert!(ridden_arcs(&[], &[]).is_empty());
    }

    #[test]
    fn the_fold_counts_rides_per_edge_and_direction() {
        let (a0, a1) = (arc(10, false), arc(10, true));
        let b0 = arc(11, false);
        let (arcs1, arcs2) = ([a0, b0], [a1]);
        let r1 = ride(&arcs1, &[255, 255], 100);
        let r2 = ride(&arcs2, &[255], 200);
        // a loop: edge 10 along twice in one ride counts once; edge 11 only 30 %
        let arcs3 = [a0, arc(12, false), a0, b0];
        let r3 = ride(&arcs3, &[255, 255, 255, 76], 150);
        let x = Explored::fold([r1, r2, r3]);
        assert_eq!(x.len(), 3);
        let e = x.get(10).expect("explored");
        assert_eq!(e.count, 3);
        assert_eq!(e.last_day, 200);
        assert_eq!(
            e.along,
            ArcStat {
                count: 2,
                last_day: 150
            }
        );
        assert_eq!(
            e.against,
            ArcStat {
                count: 1,
                last_day: 200
            }
        );
        let e = x.get(11).expect("explored");
        assert_eq!((e.count, e.last_day), (1, 100));
        assert_eq!(e.against, ArcStat::default());
        assert_eq!(x.get(12).map(|e| e.count), Some(1));
        assert!(x.get(13).is_none());
        assert_eq!(x.arc(a1).map(|s| s.count), Some(1));
        assert_eq!(x.arc(arc(11, true)).map(|s| s.count), Some(0));
        assert!(x.arc(arc(13, false)).is_none());
    }

    #[test]
    fn both_directions_in_one_ride_count_the_edge_once() {
        let arcs = [arc(5, false), arc(5, true)];
        let x = Explored::fold([ride(&arcs, &[255, 255], 9)]);
        let e = x.get(5).expect("explored");
        assert_eq!((e.count, e.along.count, e.against.count), (1, 1, 1));
    }

    #[test]
    fn untimed_rides_count_without_a_day() {
        let x = Explored::fold([
            ride(&[4], &[255], 0),
            ride(&[4], &[255], 77),
            ride(&[4], &[255], 0),
        ]);
        let e = x.get(2).expect("explored");
        assert_eq!((e.count, e.last_day), (3, 77));
        let x = Explored::fold([ride(&[4], &[255], 0)]);
        assert_eq!(x.get(2).map(|e| (e.count, e.last_day)), Some((1, 0)));
    }

    #[test]
    fn flat_arrays_are_indexed_by_edge() {
        let arcs = [arc(1, false), arc(3, true)];
        let x = Explored::fold([ride(&arcs, &[255, 255], 5)]);
        let (count, last) = x.to_flat(4);
        assert_eq!(count, vec![0, 1, 0, 1]);
        assert_eq!(last, vec![0, 5, 0, 5]);
        // edges beyond the length are ignored
        assert_eq!(x.to_flat(2).0, vec![0, 1]);
    }

    #[test]
    fn nothing_folds_to_nothing() {
        assert!(Explored::fold([]).is_empty());
        assert!(Explored::fold([ride(&[], &[], 3)]).is_empty());
    }
}
