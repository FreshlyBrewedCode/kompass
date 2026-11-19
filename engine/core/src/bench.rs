//! The route benchmark shared by the native CLI and the browser: seeded random node pairs by
//! straight-line distance (generated at run time, never stored), timed with a caller clock.
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

use crate::graph::Graph;
use crate::profile::Profile;
use crate::search::{Alt, Bidirectional, Landmarks, Plane, Search, StraightLine};

/// splitmix64.
#[derive(Debug, Clone)]
pub struct Rng(pub u64);

impl Rng {
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
}

/// Nodes from which every other candidate is reachable under every given cost vector (the
/// strongly connected part around a seed). Retries seeds until one reaches most of the graph.
#[must_use]
pub fn candidates(g: &Graph, costs: &[&[f32]], rng: &mut Rng) -> Vec<u32> {
    let n = g.node_count();
    let mut search = Search::new(n);
    loop {
        let seed = rng.below(n) as u32;
        let mut ok = vec![true; n];
        for c in costs {
            let reversed: Vec<f32> = (0..c.len()).map(|a| c[a ^ 1]).collect();
            for cs in [*c, reversed.as_slice()] {
                search.dijkstra_all(g, cs, seed);
                for (v, o) in ok.iter_mut().enumerate() {
                    *o &= search.dist(v as u32).is_finite();
                }
            }
        }
        let out: Vec<u32> = (0..n as u32).filter(|&v| ok[v as usize]).collect();
        if out.len() > n / 2 {
            return out;
        }
    }
}

/// `count` pairs whose straight-line distance lies in `[min_m, max_m]`.
#[must_use]
pub fn pairs(
    g: &Graph,
    nodes: &[u32],
    rng: &mut Rng,
    min_m: f32,
    max_m: f32,
    count: usize,
) -> Vec<(u32, u32)> {
    let plane = Plane::for_graph(g);
    let mut out = Vec::with_capacity(count);
    let mut tries = 0usize;
    while out.len() < count && tries < count * 100_000 {
        tries += 1;
        let s = nodes[rng.below(nodes.len())];
        let t = nodes[rng.below(nodes.len())];
        // the plane shrinks distances by up to ~1-3 %; good enough to bucket
        let d = plane.dist(g, s, t);
        if (min_m..=max_m).contains(&d) {
            out.push((s, t));
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Algo {
    /// A*, compiled costs, straight-line bound.
    AStar,
    /// A*, costs computed during the search.
    AStarLazy,
    /// Bidirectional A*, straight-line bound.
    Bidi,
    /// A* with landmarks (and the straight line).
    Alt,
    /// Bidirectional A* with landmarks.
    AltBidi,
    /// Dijkstra (no bound), to show what the bound buys.
    Dijkstra,
}

impl Algo {
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Algo::AStar => "astar",
            Algo::AStarLazy => "astar-lazy",
            Algo::Bidi => "bidi",
            Algo::Alt => "alt",
            Algo::AltBidi => "alt-bidi",
            Algo::Dijkstra => "dijkstra",
        }
    }

    #[must_use]
    pub fn parse(s: &str) -> Option<Algo> {
        [
            Algo::AStar,
            Algo::AStarLazy,
            Algo::Bidi,
            Algo::Alt,
            Algo::AltBidi,
            Algo::Dijkstra,
        ]
        .into_iter()
        .find(|a| a.name() == s)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Sample {
    pub ms: f64,
    pub settled: usize,
    pub cost: f32,
    pub length_m: f32,
    pub found: bool,
}

/// Searches with reusable state for one graph.
pub struct Runner {
    pub plane: Plane,
    pub one: Search,
    pub two: Bidirectional,
}

impl Runner {
    #[must_use]
    pub fn new(g: &Graph) -> Runner {
        Runner {
            plane: Plane::for_graph(g),
            one: Search::new(g.node_count()),
            two: Bidirectional::new(g.node_count()),
        }
    }

    /// Runs one query and returns the sample and the route's arcs.
    #[allow(clippy::too_many_arguments)]
    pub fn run(
        &mut self,
        g: &Graph,
        costs: &[f32],
        profile: &Profile,
        landmarks: Option<&Landmarks>,
        algo: Algo,
        (s, t): (u32, u32),
        now: &dyn Fn() -> f64,
    ) -> (Sample, Vec<u32>) {
        let plane = self.plane;
        let line = |target| StraightLine {
            plane,
            target,
            min_factor: profile.min_factor,
        };
        let start = now();
        let (route, settled) = match algo {
            Algo::AStar => (self.one.astar(g, costs, s, t, &line(t)), self.one.settled),
            Algo::AStarLazy => (self.one.astar_lazy(g, profile, s, t, &line(t)), self.one.settled),
            Algo::Dijkstra => {
                let zero = StraightLine {
                    plane,
                    target: t,
                    min_factor: 0.0,
                };
                (self.one.astar(g, costs, s, t, &zero), self.one.settled)
            }
            Algo::Bidi => {
                let r = self.two.route(g, costs, s, t, &line(t), &line(s));
                (r, self.two.settled())
            }
            Algo::Alt => {
                let lm = landmarks.expect("landmarks");
                let b = Alt {
                    landmarks: lm,
                    line: line(t),
                };
                (self.one.astar(g, costs, s, t, &b), self.one.settled)
            }
            Algo::AltBidi => {
                let lm = landmarks.expect("landmarks");
                let to_t = Alt {
                    landmarks: lm,
                    line: line(t),
                };
                let to_s = Alt {
                    landmarks: lm,
                    line: line(s),
                };
                (self.two.route(g, costs, s, t, &to_t, &to_s), self.two.settled())
            }
        };
        let ms = now() - start;
        match route {
            Some(r) => (
                Sample {
                    ms,
                    settled,
                    cost: r.cost,
                    length_m: r.length_m(g),
                    found: true,
                },
                r.arcs,
            ),
            None => (
                Sample {
                    ms,
                    settled,
                    ..Sample::default()
                },
                Vec::new(),
            ),
        }
    }
}

/// Median, p95 and max of a sample set.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Stats {
    pub n: usize,
    pub found: usize,
    pub ms_p50: f64,
    pub ms_p95: f64,
    pub ms_max: f64,
    pub settled_p50: f64,
    pub settled_p95: f64,
    pub settled_max: f64,
    pub km_p50: f64,
}

fn quantile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let i = ((sorted.len() - 1) as f64 * q).round() as usize;
    sorted[i]
}

#[must_use]
pub fn stats(samples: &[Sample]) -> Stats {
    let mut ms: Vec<f64> = samples.iter().map(|s| s.ms).collect();
    let mut settled: Vec<f64> = samples.iter().map(|s| s.settled as f64).collect();
    let mut km: Vec<f64> = samples
        .iter()
        .filter(|s| s.found)
        .map(|s| f64::from(s.length_m) / 1000.0)
        .collect();
    ms.sort_by(f64::total_cmp);
    settled.sort_by(f64::total_cmp);
    km.sort_by(f64::total_cmp);
    Stats {
        n: samples.len(),
        found: samples.iter().filter(|s| s.found).count(),
        ms_p50: quantile(&ms, 0.5),
        ms_p95: quantile(&ms, 0.95),
        ms_max: ms.last().copied().unwrap_or(f64::NAN),
        settled_p50: quantile(&settled, 0.5),
        settled_p95: quantile(&settled, 0.95),
        settled_max: settled.last().copied().unwrap_or(f64::NAN),
        km_p50: quantile(&km, 0.5),
    }
}

impl Stats {
    /// One JSON object (no serde in the engine yet).
    #[must_use]
    pub fn json(&self) -> String {
        format!(
            "{{\"n\":{},\"found\":{},\"ms_p50\":{:.3},\"ms_p95\":{:.3},\"ms_max\":{:.3},\"settled_p50\":{},\"settled_p95\":{},\"settled_max\":{},\"km_p50\":{:.2}}}",
            self.n,
            self.found,
            self.ms_p50,
            self.ms_p95,
            self.ms_max,
            self.settled_p50,
            self.settled_p95,
            self.settled_max,
            self.km_p50
        )
    }
}

/// The three distance buckets: (label, straight-line min m, max m). Routes come out ~1.2-1.3×
/// longer than the straight line, so these are ~10 / 50 / 100 km routes.
pub const BUCKETS: [(&str, f32, f32); 3] = [
    ("10km", 7_000.0, 9_000.0),
    ("50km", 37_000.0, 43_000.0),
    ("100km", 75_000.0, 85_000.0),
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::tests::grid;

    #[test]
    fn rng_is_seeded() {
        let (mut a, mut b) = (Rng(7), Rng(7));
        assert_eq!(a.next_u64(), b.next_u64());
        assert!(a.below(10) < 10);
    }

    #[test]
    fn runs_every_algorithm_to_the_same_cost() {
        let g = grid();
        let p = Profile::gravel_explorer();
        let costs = p.compile(&g);
        let lm = Landmarks::build(&g, 4, 0);
        let mut rng = Rng(1);
        let nodes = candidates(&g, &[&costs], &mut rng);
        assert_eq!(nodes.len(), 9);
        let ps = pairs(&g, &nodes, &mut rng, 150.0, 400.0, 5);
        assert_eq!(ps.len(), 5);
        let mut runner = Runner::new(&g);
        let now = || 0.0;
        for &pair in &ps {
            let want = runner
                .run(&g, &costs, &p, None, Algo::Dijkstra, pair, &now)
                .0
                .cost;
            for algo in [Algo::AStar, Algo::AStarLazy, Algo::Bidi, Algo::Alt, Algo::AltBidi] {
                let got = runner.run(&g, &costs, &p, Some(&lm), algo, pair, &now).0;
                assert!(got.found && (got.cost - want).abs() < 1e-3, "{}", algo.name());
            }
        }
        let st = stats(&[Sample {
            ms: 2.0,
            settled: 3,
            cost: 1.0,
            length_m: 1000.0,
            found: true,
        }]);
        assert!((st.km_p50 - 1.0).abs() < 1e-9);
    }
}
