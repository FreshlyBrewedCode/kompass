//! The matcher's bounded Dijkstra. A search settles about 20 nodes, so its state is a small open
//! addressing hash table keyed by node (reset by a round stamp, grown when a search is larger),
//! not arrays sized to the whole graph (12 bytes per node, 22 MB for the real region).

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use crate::graph::{ArcId, Graph, NodeId, arc_edge, flags};

pub(super) const NO_ARC: ArcId = u32::MAX;

/// Slots a table starts with, and keeps after a search that needed more than [`KEEP_SLOTS`].
const START_SLOTS: usize = 256;
const KEEP_SLOTS: usize = 8192;

#[derive(Debug, Clone, Copy)]
struct Slot {
    key: NodeId,
    /// The round the slot was written in: older slots are empty.
    stamp: u32,
    dist: f32,
    parent: ArcId,
}

const EMPTY: Slot = Slot {
    key: 0,
    stamp: 0,
    dist: 0.0,
    parent: NO_ARC,
};

/// A node → (distance, parent arc) map that "clears" in O(1).
#[derive(Debug, Clone)]
struct NodeTable {
    slots: Vec<Slot>,
    shift: u32,
    round: u32,
    live: usize,
}

impl NodeTable {
    fn new() -> NodeTable {
        NodeTable {
            slots: vec![EMPTY; START_SLOTS],
            shift: 32 - START_SLOTS.trailing_zeros(),
            // slots start at stamp 0, empty from round 1 on
            round: 1,
            live: 0,
        }
    }

    /// Forgets every entry.
    fn clear(&mut self) {
        if self.slots.len() > KEEP_SLOTS {
            *self = NodeTable::new();
        }
        self.round = self.round.wrapping_add(1);
        if self.round == 0 {
            self.slots.fill(EMPTY);
            self.round = 1;
        }
        self.live = 0;
    }

    #[inline]
    fn home(&self, key: NodeId) -> usize {
        // Fibonacci hashing: the top bits of key × 2^32/φ
        (key.wrapping_mul(0x9E37_79B9) >> self.shift) as usize
    }

    /// The slot of `key`, or the empty slot it would take.
    #[inline]
    fn find(&self, key: NodeId) -> usize {
        let mask = self.slots.len() - 1;
        let mut i = self.home(key);
        while self.slots[i].stamp == self.round && self.slots[i].key != key {
            i = (i + 1) & mask;
        }
        i
    }

    #[inline]
    fn get(&self, key: NodeId) -> Option<&Slot> {
        let s = &self.slots[self.find(key)];
        (s.stamp == self.round).then_some(s)
    }

    /// Sets the entry of `key` if it is new or `dist` is shorter; true when it changed.
    #[inline]
    fn relax(&mut self, key: NodeId, dist: f32, parent: ArcId) -> bool {
        let mut i = self.find(key);
        if self.slots[i].stamp == self.round {
            if dist >= self.slots[i].dist {
                return false;
            }
        } else {
            if (self.live + 1) * 2 > self.slots.len() {
                self.grow();
                i = self.find(key);
            }
            self.live += 1;
        }
        self.slots[i] = Slot {
            key,
            stamp: self.round,
            dist,
            parent,
        };
        true
    }

    fn grow(&mut self) {
        let bigger = vec![EMPTY; self.slots.len() * 2];
        let old = std::mem::replace(&mut self.slots, bigger);
        self.shift -= 1;
        for s in old.into_iter().filter(|s| s.stamp == self.round) {
            let i = self.find(s.key);
            self.slots[i] = s;
        }
    }
}

/// A bounded Dijkstra over every arc (one-way only as a cost factor), reused between searches.
#[derive(Debug, Clone)]
pub(super) struct Search {
    table: NodeTable,
    heap: BinaryHeap<Reverse<(u32, NodeId)>>,
    pub settled: u64,
}

impl Search {
    pub fn new() -> Search {
        Search {
            table: NodeTable::new(),
            heap: BinaryHeap::new(),
            settled: 0,
        }
    }

    /// Bytes held (the table and the heap).
    pub fn heap_bytes(&self) -> usize {
        self.table.slots.capacity() * size_of::<Slot>() + self.heap.capacity() * size_of::<(u32, NodeId)>()
    }

    /// The cost to `v` found by the last [`Search::run`] (∞ if not reached).
    #[inline]
    pub fn get(&self, v: NodeId) -> f32 {
        self.table.get(v).map_or(f32::INFINITY, |s| s.dist)
    }

    /// The arc that reached `v` in the last run ([`NO_ARC`] for a source or a node not reached).
    #[inline]
    pub fn parent(&self, v: NodeId) -> ArcId {
        self.table.get(v).map_or(NO_ARC, |s| s.parent)
    }

    #[inline]
    fn relax(&mut self, v: NodeId, d: f32, via: ArcId) {
        if self.table.relax(v, d, via) {
            self.heap.push(Reverse((d.to_bits(), v)));
        }
    }

    /// From `sources` (node, initial cost) until every target is settled or the bound is passed.
    /// An arc against its one-way costs `penalty` times its length.
    pub fn run(
        &mut self,
        g: &Graph,
        sources: &[(NodeId, f32)],
        targets: &[NodeId],
        bound: f32,
        penalty: f32,
    ) {
        self.table.clear();
        self.heap.clear();
        for &(v, d) in sources {
            self.relax(v, d, NO_ARC);
        }
        let mut left = targets.len();
        while let Some(Reverse((bits, v))) = self.heap.pop() {
            let d = f32::from_bits(bits);
            if d > self.get(v) {
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

#[cfg(test)]
mod tests {
    #![allow(clippy::cast_precision_loss, reason = "small test counts")]
    use super::*;

    #[test]
    fn the_table_keeps_the_shortest_and_clears_between_rounds() {
        let mut t = NodeTable::new();
        t.clear();
        assert!(t.relax(7, 5.0, 1));
        assert!(!t.relax(7, 6.0, 2));
        assert!(t.relax(7, 4.0, 3));
        let s = t.get(7).expect("set");
        assert!((s.dist - 4.0).abs() < 1e-6 && s.parent == 3);
        assert!(t.get(8).is_none());
        t.clear();
        assert!(t.get(7).is_none());
        assert!(t.relax(7, 9.0, 4));
    }

    #[test]
    fn the_table_grows_and_keeps_every_entry() {
        let mut t = NodeTable::new();
        t.clear();
        // more than START_SLOTS / 2 keys, some colliding on purpose (multiples of a big power of two)
        let keys: Vec<NodeId> = (0..3000).map(|i| i * 4096 + (i % 7)).collect();
        for (i, &k) in keys.iter().enumerate() {
            assert!(t.relax(k, i as f32, k));
        }
        assert!(t.slots.len() >= 6000);
        for (i, &k) in keys.iter().enumerate() {
            let s = t.get(k).expect("kept");
            assert!((s.dist - i as f32).abs() < 1e-6 && s.parent == k);
        }
        assert!(t.get(1).is_none());
        // after a big search the next one starts small again
        t.clear();
        assert!(t.slots.len() <= KEEP_SLOTS.max(START_SLOTS) * 2);
    }

    #[test]
    fn a_search_reaches_targets_along_a_grid() {
        let built = crate::testing::grid(4, 1, 100.0).build();
        let g = &built.graph;
        let mut s = Search::new();
        let (a, d) = (built.node(0), built.node(3));
        s.run(g, &[(a, 0.0)], &[d], f32::INFINITY, 1.3);
        assert!((s.get(d) - 300.0).abs() < 1.0, "{}", s.get(d));
        assert_eq!(s.parent(a), NO_ARC);
        assert_ne!(s.parent(d), NO_ARC);
        // a bound stops it short
        s.run(g, &[(a, 0.0)], &[d], 150.0, 1.3);
        assert!(s.get(d).is_infinite() || s.get(d) > 150.0);
    }
}
