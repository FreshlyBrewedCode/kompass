//! The personal layer: what the rider's own history says about each edge, as arrays indexed by edge
//! id. The caller derives it (map-matching the imported rides, re-done on every build because edge
//! ids change) and passes it in; the base graph never changes for it. It is plain arrays, not part of
//! the JSON API: in the browser it crosses the worker boundary as typed arrays.

use crate::graph::EdgeId;

/// Days since 1970-01-01 (UTC); 0 means never.
pub type Day = u32;

/// Ride history per edge (both directions together).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PersonalLayer {
    /// Rides that used the edge (saturating).
    pub rides: Vec<u16>,
    /// The day of the last ride on it, 0 for never.
    pub last_ridden: Vec<Day>,
    /// Today, for "not ridden for a long time".
    pub today: Day,
}

impl PersonalLayer {
    /// An empty layer for a graph of `edges` edges: nothing ridden yet.
    #[must_use]
    pub fn empty(edges: usize, today: Day) -> PersonalLayer {
        PersonalLayer {
            rides: vec![0; edges],
            last_ridden: vec![0; edges],
            today,
        }
    }

    /// Whether the arrays fit a graph of `edges` edges.
    #[must_use]
    pub fn fits(&self, edges: usize) -> bool {
        self.rides.len() == edges && self.last_ridden.len() == edges
    }

    /// Records a ride over edge `e` on `day`.
    pub fn record(&mut self, e: EdgeId, day: Day) {
        let e = e as usize;
        self.rides[e] = self.rides[e].saturating_add(1);
        self.last_ridden[e] = self.last_ridden[e].max(day);
    }

    #[inline]
    #[must_use]
    pub fn rides(&self, e: EdgeId) -> u16 {
        self.rides[e as usize]
    }

    /// Days since the last ride on `e`, `None` if never ridden.
    #[inline]
    #[must_use]
    pub fn days_since(&self, e: EdgeId) -> Option<u32> {
        let d = self.last_ridden[e as usize];
        (self.rides[e as usize] > 0 && d > 0).then(|| self.today.saturating_sub(d))
    }
}
