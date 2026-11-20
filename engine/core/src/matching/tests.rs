//! Matcher tests on synthetic graphs and seeded noisy tracks (no real data).

#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::similar_names,
    clippy::too_many_lines,
    clippy::items_after_statements,
    clippy::assert_is_empty,
    reason = "tests: small counts, short names, long scenarios"
)]

use super::*;
use crate::attrs::{EdgeAttrs, Oneway};
use crate::graph::GraphLoader;
use crate::testing::{Built, GRID_CENTER, GraphBuilder, grid};

const DEG_PER_M: f64 = 1.0 / (M_PER_E7 * 1e7);

/// A seeded generator (splitmix64) with Gaussian noise: the tests need no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    #[allow(clippy::cast_precision_loss, reason = "53 bits of a u64")]
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    fn below(&mut self, n: usize) -> usize {
        usize::try_from(self.next() % n as u64).unwrap_or(0)
    }

    fn gauss(&mut self) -> f64 {
        let (u, v) = (self.unit().max(1e-12), self.unit());
        (-2.0 * u.ln()).sqrt() * (std::f64::consts::TAU * v).cos()
    }
}

/// Points every `step_m` along a polyline (degrees), each moved by Gaussian noise of `sigma_m`
/// metres in both axes; the vertices and the end are sampled too.
fn walk(path: &[(f64, f64)], step_m: f64, sigma_m: f64, rng: &mut Rng) -> Vec<LngLat> {
    let mut out = Vec::new();
    let noisy = |x: f64, y: f64, rng: &mut Rng| LngLat {
        lng: x + rng.gauss() * sigma_m * DEG_PER_M,
        lat: y + rng.gauss() * sigma_m * DEG_PER_M,
    };
    for w in path.windows(2) {
        let (a, b) = (w[0], w[1]);
        let d = (b.0 - a.0).hypot(b.1 - a.1) / DEG_PER_M;
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "a count")]
        let n = (d / step_m).ceil().max(1.0) as usize;
        for i in 0..n {
            #[allow(clippy::cast_precision_loss, reason = "small counts")]
            let t = i as f64 / n as f64;
            out.push(noisy(a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t, rng));
        }
    }
    if let Some(&(x, y)) = path.last() {
        out.push(noisy(x, y, rng));
    }
    out
}

/// Node (i, j) of a grid with `step` metres between nodes, centred like `testing::grid`.
fn node_at(nx: usize, ny: usize, step: f64, i: f64, j: f64) -> (f64, f64) {
    #[allow(clippy::cast_precision_loss, reason = "tiny grids")]
    let (cx, cy) = ((nx as f64 - 1.0) / 2.0, (ny as f64 - 1.0) / 2.0);
    (
        GRID_CENTER.0 + (i - cx) * step * DEG_PER_M,
        GRID_CENTER.1 + (j - cy) * step * DEG_PER_M,
    )
}

fn at(i: f64, j: f64) -> (f64, f64) {
    node_at(5, 5, 100.0, i, j)
}

fn run(built: &Built, pts: &[LngLat]) -> Match {
    run_with(built, pts, MatchParams::default())
}

fn run_with(built: &Built, pts: &[LngLat], params: MatchParams) -> Match {
    let g = &built.graph;
    let mut grids = TileGrids::new(g);
    Matcher::new(params).match_track(g, &mut grids, pts)
}

/// (arc, coverage) of the pieces covering at least half of their edge.
fn main_arcs(m: &Match) -> Vec<ArcId> {
    m.pieces
        .iter()
        .filter(|p| p.share() >= 0.5)
        .map(Piece::arc)
        .collect()
}

/// East edge of a 5 × 5 grid from node (i, j), north edge from node (i, j).
fn east(b: &Built, i: usize, j: usize) -> EdgeId {
    b.edge(j * 4 + i)
}

fn north(b: &Built, i: usize, j: usize) -> EdgeId {
    b.edge(20 + i * 4 + j)
}

#[test]
fn matches_a_straight_noisy_ride() {
    let built = grid(5, 5, 100.0).build();
    let mut rng = Rng(1);
    let pts = walk(&[at(0.0, 2.0), at(4.0, 2.0)], 5.0, 4.0, &mut rng);
    let m = run(&built, &pts);
    let want: Vec<ArcId> = (0..4).map(|i| arc(east(&built, i, 2), false)).collect();
    assert_eq!(main_arcs(&m), want);
    assert_eq!(m.chains.len(), 1);
    assert!((m.stats.path_m - 400.0).abs() < 8.0, "{}", m.stats.path_m);
    assert!(m.stats.matched_m > 0.97 * m.stats.track_m, "{:?}", m.stats);
    let r = m.to_result();
    assert_eq!(r.breaks, 0);
    assert!(
        r.coverage.iter().skip(1).take(3).all(|&c| c >= 250),
        "{:?}",
        r.coverage
    );
    assert_eq!(r.arcs.len(), r.first_point.len());
    assert!(r.first_point.windows(2).all(|w| w[0] <= w[1]));
}

#[test]
fn matches_an_l_shaped_ride_with_turns() {
    let built = grid(5, 5, 100.0).build();
    let mut rng = Rng(2);
    let pts = walk(&[at(0.0, 0.0), at(3.0, 0.0), at(3.0, 4.0)], 5.0, 4.0, &mut rng);
    let m = run(&built, &pts);
    let mut want: Vec<ArcId> = (0..3).map(|i| arc(east(&built, i, 0), false)).collect();
    want.extend((0..4).map(|j| arc(north(&built, 3, j), false)));
    assert_eq!(main_arcs(&m), want);
    assert!((m.stats.path_m - 700.0).abs() < 10.0, "{}", m.stats.path_m);
    assert!(m.unmatched.iter().all(|u| u.length_m < 1.0), "{:?}", m.unmatched);
}

#[test]
fn a_reversed_ride_gives_reversed_arcs() {
    let built = grid(5, 5, 100.0).build();
    let mut rng = Rng(3);
    let pts = walk(&[at(4.0, 1.0), at(0.0, 1.0)], 10.0, 3.0, &mut rng);
    let m = run(&built, &pts);
    assert_eq!(m.pieces.len(), 4, "{:#?}", m.pieces);
    assert!(m.pieces.iter().all(|p| p.reverse && p.share() > 0.95));
}

/// Random walks on an 8 × 8 grid (never straight back), noisy: the matched arcs are the walk's.
#[test]
fn random_noisy_walks_match_their_route() {
    let built = grid(8, 8, 100.0).build();
    let nx = 8usize;
    let node = |i: usize, j: usize| {
        #[allow(clippy::cast_precision_loss, reason = "tiny grids")]
        node_at(8, 8, 100.0, i as f64, j as f64)
    };
    // the edge between two neighbouring nodes and whether walking a → b is along it
    let edge_between = |a: (usize, usize), b: (usize, usize)| -> ArcId {
        if a.1 == b.1 {
            let i = a.0.min(b.0);
            arc(built.edge(a.1 * (nx - 1) + i), b.0 < a.0)
        } else {
            let j = a.1.min(b.1);
            arc(built.edge(nx * (nx - 1) + a.0 * (nx - 1) + j), b.1 < a.1)
        }
    };
    for seed in 1..=8u64 {
        let mut rng = Rng(seed);
        let mut cur = (rng.below(nx), rng.below(nx));
        let mut prev = (usize::MAX, usize::MAX);
        let (mut route, mut want) = (vec![node(cur.0, cur.1)], Vec::new());
        while want.len() < 16 {
            let mut options = Vec::new();
            if cur.0 > 0 {
                options.push((cur.0 - 1, cur.1));
            }
            if cur.0 + 1 < nx {
                options.push((cur.0 + 1, cur.1));
            }
            if cur.1 > 0 {
                options.push((cur.0, cur.1 - 1));
            }
            if cur.1 + 1 < nx {
                options.push((cur.0, cur.1 + 1));
            }
            options.retain(|&o| o != prev);
            let next = options[rng.below(options.len())];
            want.push(edge_between(cur, next));
            route.push(node(next.0, next.1));
            (prev, cur) = (cur, next);
        }
        let pts = walk(&route, 6.0, 4.0, &mut rng);
        let m = run(&built, &pts);
        assert_eq!(main_arcs(&m), want, "seed {seed}");
        assert_eq!(m.chains.len(), 1, "seed {seed}");
        let ratio = m.stats.path_m / 1600.0;
        assert!((0.97..1.03).contains(&ratio), "seed {seed}: {ratio}");
        // folding a match of the route counts every edge once
        let r = m.to_result();
        let x = Explored::fold([RideMatchRef {
            arcs: &r.arcs,
            coverage: &r.coverage,
            day: 5,
        }]);
        assert!(
            x.edges.iter().all(|e| e.count == 1 && e.last_day == 5),
            "seed {seed}"
        );
        let mut edges: Vec<EdgeId> = want.iter().map(|&a| arc_edge(a)).collect();
        edges.sort_unstable();
        edges.dedup();
        let explored: Vec<EdgeId> = x.edges.iter().map(|e| e.edge).collect();
        assert_eq!(explored, edges, "seed {seed}");
    }
}

#[test]
fn an_out_and_back_on_one_edge_keeps_both_directions() {
    let built = grid(5, 5, 100.0).build();
    // 80 m out along the first edge of row 2, and back
    let a = at(0.0, 2.0);
    let b = (a.0 + 80.0 * DEG_PER_M, a.1);
    let mut rng = Rng(4);
    let m = run(&built, &walk(&[a, b, a], 5.0, 2.0, &mut rng));
    let e = east(&built, 0, 2);
    assert_eq!(
        main_arcs(&m),
        vec![arc(e, false), arc(e, true)],
        "{:#?}",
        m.pieces
    );
    let r = m.to_result();
    assert!(
        r.coverage.iter().all(|&c| (190..=215).contains(&c)),
        "{:?}",
        r.coverage
    );
    // each direction covers 80 % of the edge: both count as ridden
    let x = Explored::fold([RideMatchRef {
        arcs: &r.arcs,
        coverage: &r.coverage,
        day: 1,
    }]);
    let ex = x.get(e).expect("explored");
    assert_eq!((ex.count, ex.along.count, ex.against.count), (1, 1, 1));
}

#[test]
fn a_loop_through_a_junction_twice_keeps_every_pass() {
    let built = grid(5, 5, 100.0).build();
    // a square (1,1) → (2,1) → (2,2) → (1,2) → (1,1), ridden twice
    let lap = [at(1.0, 1.0), at(2.0, 1.0), at(2.0, 2.0), at(1.0, 2.0)];
    let mut route = Vec::new();
    for _ in 0..2 {
        route.extend_from_slice(&lap);
    }
    route.push(lap[0]);
    let mut rng = Rng(5);
    let m = run(&built, &walk(&route, 6.0, 3.0, &mut rng));
    let square = [
        arc(east(&built, 1, 1), false),
        arc(north(&built, 2, 1), false),
        arc(east(&built, 1, 2), true),
        arc(north(&built, 1, 1), true),
    ];
    let want: Vec<ArcId> = square.iter().chain(&square).copied().collect();
    assert_eq!(main_arcs(&m), want, "{:#?}", m.pieces);
    // eight passes, four edges: the fold counts each edge once for the ride
    let r = m.to_result();
    let x = Explored::fold([RideMatchRef {
        arcs: &r.arcs,
        coverage: &r.coverage,
        day: 2,
    }]);
    assert_eq!(x.len(), 4);
    assert!(x.edges.iter().all(|e| e.count == 1));
}

/// Two ways between the same nodes, 15 m apart: noise of 3 m must not make the match switch.
#[test]
fn parallel_ways_15_m_apart_are_told_apart() {
    let mut b = GraphBuilder::new();
    let (x0, y) = GRID_CENTER;
    let m = |d: f64| d * DEG_PER_M;
    let n0 = b.node(x0, y);
    let n1 = b.node(x0 + m(300.0), y);
    let south = b.edge(n0, n1, EdgeAttrs::default());
    let north = b.edge_via(
        n0,
        n1,
        &[
            (x0 + m(1.0), y + m(15.0)),
            (x0 + m(150.0), y + m(15.0)),
            (x0 + m(299.0), y + m(15.0)),
        ],
        EdgeAttrs::default(),
    );
    let built = b.build();
    for (ride_y, want, other) in [(y, south, north), (y + m(15.0), north, south)] {
        for seed in 1..=4u64 {
            let mut rng = Rng(seed);
            let pts = walk(&[(x0, ride_y), (x0 + m(300.0), ride_y)], 5.0, 3.0, &mut rng);
            let r = run(&built, &pts);
            let on = |e: usize| {
                r.pieces
                    .iter()
                    .filter(|p| p.edge == built.edge(e))
                    .map(Piece::share)
                    .sum::<f32>()
            };
            assert!(on(want) > 0.9, "seed {seed}: {:#?}", r.pieces);
            assert!(on(other) < 0.1, "seed {seed}: {:#?}", r.pieces);
        }
    }
}

#[test]
fn an_off_graph_stretch_breaks_the_chain() {
    let built = grid(5, 5, 100.0).build();
    // along row 0, then 600 m off the grid to the south and back onto the grid
    let mut rng = Rng(6);
    let route = [
        at(0.0, 0.0),
        at(2.0, 0.0),
        at(2.0, -6.0),
        at(4.0, -6.0),
        at(4.0, 0.0),
        at(4.0, 2.0),
    ];
    let pts = walk(&route, 10.0, 2.0, &mut rng);
    let m = run(&built, &pts);
    assert_eq!(m.chains.len(), 2, "{:?}", m.chains);
    let off: f64 = m.unmatched.iter().map(|u| u.length_m).sum();
    assert!(off > 1100.0 && off < 1500.0, "{off}");
    let r = m.to_result();
    assert_eq!(r.breaks, 1);
    assert_eq!(r.unmatched.len(), m.unmatched.len());
    // the matched length plus the unmatched stretches is the track
    assert!((r.matched_m + off - r.track_m).abs() < 30.0, "{r:?}");
    // the arcs on both sides of the gap are the right ones
    assert!(r.arcs.contains(&arc(east(&built, 0, 0), false)));
    assert!(r.arcs.contains(&arc(north(&built, 4, 0), false)));
    assert!(r.arcs.contains(&arc(north(&built, 4, 1), false)));
}

#[test]
fn a_recording_gap_breaks_the_chain_too() {
    let built = grid(5, 5, 100.0).build();
    let mut rng = Rng(7);
    // two stretches of one road, with a 2.5 km jump (a train) between them
    let mut pts = walk(&[at(0.0, 2.0), at(1.0, 2.0)], 5.0, 2.0, &mut rng);
    let far = at(2.0, 2.0);
    pts.extend(walk(
        &[
            (far.0 + 2500.0 * DEG_PER_M, far.1),
            (far.0 + 2600.0 * DEG_PER_M, far.1),
        ],
        5.0,
        2.0,
        &mut rng,
    ));
    pts.extend(walk(&[at(3.0, 2.0), at(4.0, 2.0)], 5.0, 2.0, &mut rng));
    let m = run(&built, &pts);
    assert_eq!(m.chains.len(), 2, "{:?}", m.chains);
    assert!(m.unmatched.iter().map(|u| u.length_m).sum::<f64>() > 2000.0);
}

#[test]
fn riding_against_a_one_way_is_matched_and_counted() {
    let mut b = GraphBuilder::new();
    let (x0, y) = GRID_CENTER;
    let n: Vec<_> = (0..4)
        .map(|i| b.node(x0 + f64::from(i) * 100.0 * DEG_PER_M, y))
        .collect();
    let ow = EdgeAttrs {
        oneway: Oneway::Along,
        ..EdgeAttrs::default()
    };
    // the edges point west; the ride goes east
    for w in n.windows(2) {
        b.edge(w[1], w[0], ow);
    }
    let built = b.build();
    let mut rng = Rng(8);
    let pts = walk(&[(x0, y), (x0 + 300.0 * DEG_PER_M, y)], 8.0, 2.0, &mut rng);
    let m = run(&built, &pts);
    assert_eq!(m.chains.len(), 1);
    assert!((m.stats.contra_oneway_m - 300.0).abs() < 4.0, "{:?}", m.stats);
    // the same ride westwards is not against the one-way
    let pts: Vec<LngLat> = pts.into_iter().rev().collect();
    let m = run(&built, &pts);
    assert!(m.stats.contra_oneway_m < 4.0, "{:?}", m.stats);
    assert_eq!(m.pieces.len(), 3);
    assert!(m.pieces.iter().all(|p| !p.reverse));
}

#[test]
fn a_ride_that_starts_and_ends_mid_edge_has_partial_coverage() {
    let built = grid(5, 5, 100.0).build();
    // from 30 m into the first edge to 40 m before the end of the fourth
    let a = at(0.0, 3.0);
    let (from, to) = ((a.0 + 30.0 * DEG_PER_M, a.1), (a.0 + 360.0 * DEG_PER_M, a.1));
    let mut rng = Rng(9);
    let m = run(&built, &walk(&[from, to], 5.0, 1.5, &mut rng));
    let r = m.to_result();
    assert_eq!(r.arcs.len(), 4, "{:#?}", m.pieces);
    let want = [0.7, 1.0, 1.0, 0.6];
    for (c, w) in r.coverage.iter().zip(want) {
        assert!((f64::from(*c) / 255.0 - w).abs() < 0.07, "{:?}", r.coverage);
    }
    // under the 50 % rule all four count, and a ride that only clips an edge does not
    let x = Explored::fold([RideMatchRef {
        arcs: &r.arcs,
        coverage: &r.coverage,
        day: 3,
    }]);
    assert_eq!(x.len(), 4);
    let clip: Vec<LngLat> = walk(
        &[(a.0 + 60.0 * DEG_PER_M, a.1), (a.0 + 130.0 * DEG_PER_M, a.1)],
        5.0,
        1.0,
        &mut Rng(10),
    );
    let r = run(&built, &clip).to_result();
    assert!(
        Explored::fold([RideMatchRef {
            arcs: &r.arcs,
            coverage: &r.coverage,
            day: 3
        }])
        .edges
        .iter()
        .all(|e| e.edge == east(&built, 0, 3) || e.edge == east(&built, 1, 3))
    );
}

/// A detour of 15 m into a 20 m side edge and back is GPS noise, not a ride on the side edge.
#[test]
fn a_short_spur_is_cleaned_up() {
    let mut b = GraphBuilder::new();
    let (x0, y) = GRID_CENTER;
    let m = |d: f64| d * DEG_PER_M;
    let a = b.node(x0, y);
    let bb = b.node(x0 + m(200.0), y);
    let c = b.node(x0 + m(400.0), y);
    let d = b.node(x0 + m(200.0), y - m(20.0));
    let e_ab = b.edge(a, bb, EdgeAttrs::default());
    let e_bc = b.edge(bb, c, EdgeAttrs::default());
    let e_bd = b.edge(bb, d, EdgeAttrs::default());
    let built = b.build();
    let route = [
        (x0, y),
        (x0 + m(200.0), y),
        (x0 + m(200.0), y - m(18.0)),
        (x0 + m(200.0), y),
        (x0 + m(400.0), y),
    ];
    let pts = walk(&route, 4.0, 0.0, &mut Rng(11));
    let clean = run(&built, &pts);
    assert_eq!(
        main_arcs(&clean),
        vec![arc(built.edge(e_ab), false), arc(built.edge(e_bc), false)],
        "{:#?}",
        clean.pieces
    );
    assert!(
        clean.pieces.iter().all(|p| p.edge != built.edge(e_bd)),
        "{:#?}",
        clean.pieces
    );
    assert!(clean.stats.spurs >= 2, "{:?}", clean.stats);
    // with the clean-up off the side edge shows, both ways
    let raw = run_with(
        &built,
        &pts,
        MatchParams {
            spur_m: 0.0,
            ..MatchParams::default()
        },
    );
    let side: Vec<bool> = raw
        .pieces
        .iter()
        .filter(|p| p.edge == built.edge(e_bd))
        .map(|p| p.reverse)
        .collect();
    assert_eq!(side, vec![false, true], "{:#?}", raw.pieces);
    // a real out-and-back into a 150 m dead end stays
    let route = [(x0 + m(400.0), y), (x0 + m(200.0), y), (x0, y)];
    let m2 = run(&built, &walk(&route, 5.0, 0.0, &mut Rng(12)));
    assert_eq!(m2.stats.spurs, 0);
}

/// Matching needs the geometry; with a tile's missing the match falls back to straight segments
/// (poor on a curved edge, but no failure), and a loaded geometry tile is picked up by the next
/// match.
#[test]
fn geometry_loads_lazily_per_tile() {
    let mut b = GraphBuilder::new().zoom(16);
    let (x0, y0) = GRID_CENTER;
    let m = |d: f64| d * DEG_PER_M;
    // two arches, 1 km apart (a z16 tile is ~600 m): the way up 90 m, over 120 m and down again
    let arch = |b: &mut GraphBuilder, dx: f64| {
        let (n0, n1) = (b.node(x0 + m(dx), y0), b.node(x0 + m(dx + 300.0), y0));
        let via = [(100.0, 90.0), (150.0, 120.0), (200.0, 90.0)].map(|(x, h)| (x0 + m(dx + x), y0 + m(h)));
        let e = b.edge_via(n0, n1, &via, EdgeAttrs::default());
        let mut path = vec![(x0 + m(dx), y0)];
        path.extend(via);
        path.push((x0 + m(dx + 300.0), y0));
        (e, path)
    };
    let (e1, path1) = arch(&mut b, 0.0);
    let (e2, path2) = arch(&mut b, 1000.0);
    let built = b.build();
    let g0 = &built.graph;
    let (t1, t2) = (
        g0.info().tile_of_edge(built.edge(e1)).expect("tile"),
        g0.info().tile_of_edge(built.edge(e2)).expect("tile"),
    );
    assert_ne!(t1, t2);
    // the same graph with every graph tile but no geometry
    let mut loader = GraphLoader::new(&built.files.index).expect("index");
    for t in &built.files.tiles {
        loader.add_tile(&t.graph).expect("tile");
    }
    let mut g = loader.finish();
    assert!(!g.geometry_loaded(t1) && !g.geometry_loaded(t2));

    let pts = walk(&path1, 6.0, 1.0, &mut Rng(13));
    let (lat, lon): (Vec<f64>, Vec<f64>) = pts.iter().map(|p| (p.lat, p.lng)).unzip();
    let mut matcher = Matcher::default();
    // the tiles to fetch, from the points alone
    assert_eq!(matcher.tiles_needed(&g, &lat, &lon), vec![t1]);
    assert_eq!(missing_geometry(&g, &[t1, t2]), vec![t1, t2]);

    let mut grids = TileGrids::new(&g);
    let poor = matcher.match_arrays(&g, &mut grids, &lat, &lon);
    assert!(grids.has(t1) && !grids.has(t2), "grids only where the track is");
    assert!(
        poor.matched_m < 0.5 * poor.track_m,
        "straight segments miss the arch: {poor:?}"
    );

    // geometry arrives for the tile: the stale grid is rebuilt by the next match
    g.add_geometry(&built.files.tiles[t1].geometry).expect("geometry");
    assert_eq!(missing_geometry(&g, &[t1, t2]), vec![t2]);
    let good = matcher.match_arrays(&g, &mut grids, &lat, &lon);
    assert_eq!(good.arcs, vec![arc(built.edge(e1), false)]);
    assert!(good.coverage[0] >= 250 && good.unmatched.is_empty(), "{good:?}");
    assert!((good.path_m - f64::from(g.length_m(built.edge(e1)))).abs() < 1.0);

    // a ride on the other tile still falls back, and builds that tile's grid
    let pts2 = walk(&path2, 6.0, 1.0, &mut Rng(14));
    let r2 = matcher.match_track(&g, &mut grids, &pts2).to_result();
    assert!(grids.has(t2));
    assert!(r2.matched_m < 0.5 * r2.track_m);
    g.add_geometry(&built.files.tiles[t2].geometry).expect("geometry");
    let r2 = matcher.match_track(&g, &mut grids, &pts2).to_result();
    assert_eq!(r2.arcs, vec![arc(built.edge(e2), false)]);
}

#[test]
fn needed_tiles_follow_the_points() {
    let mut b = GraphBuilder::new().zoom(16);
    let (x0, y0) = GRID_CENTER;
    let m = |d: f64| d * DEG_PER_M;
    let mut ids = Vec::new();
    for dx in [0.0, 1000.0] {
        let (n0, n1) = (b.node(x0 + m(dx), y0), b.node(x0 + m(dx + 200.0), y0));
        ids.push(b.edge(n0, n1, EdgeAttrs::default()));
    }
    let built = b.build();
    let g = &built.graph;
    let tile = |h: usize| g.info().tile_of_edge(built.edge(ids[h])).expect("tile");
    let p = |dx: f64, dy: f64| (y0 + m(dy), x0 + m(dx));
    let needed = |pts: &[(f64, f64)], radius: f64| {
        let (lat, lon): (Vec<f64>, Vec<f64>) = pts.iter().copied().unzip();
        needed_tiles(g, radius, &lat, &lon)
    };
    assert_eq!(needed(&[p(100.0, 0.0)], 40.0), vec![tile(0)]);
    assert_eq!(needed(&[p(1100.0, 0.0), p(100.0, 3.0)], 40.0), {
        let mut v = vec![tile(0), tile(1)];
        v.sort_unstable();
        v
    });
    // within the radius of a tile's edges, but not on them
    assert_eq!(needed(&[p(100.0, 30.0)], 40.0), vec![tile(0)]);
    assert!(needed(&[p(100.0, 200.0)], 40.0).is_empty());
    assert!(needed(&[p(600.0, 0.0)], 40.0).is_empty());
    assert!(needed(&[(f64::NAN, 0.0), (0.0, f64::INFINITY)], 40.0).is_empty());
    assert!(needed(&[], 40.0).is_empty());
    // f32 input works too
    let (lat, lon) = ([p(100.0, 0.0).0 as f32], [p(100.0, 0.0).1 as f32]);
    assert_eq!(needed_tiles(g, 40.0, &lat, &lon), vec![tile(0)]);
}

#[test]
fn f32_arrays_and_bad_points_are_handled() {
    let built = grid(5, 5, 100.0).build();
    let g = &built.graph;
    let mut rng = Rng(15);
    let pts = walk(&[at(0.0, 2.0), at(4.0, 2.0)], 5.0, 3.0, &mut rng);
    let (mut lat, mut lon): (Vec<f64>, Vec<f64>) = pts.iter().map(|p| (p.lat, p.lng)).unzip();
    let mut matcher = Matcher::default();
    let mut grids = TileGrids::new(g);
    let want = matcher.match_arrays(g, &mut grids, &lat, &lon);
    assert_eq!(want.arcs.len(), 4);
    let (lat32, lon32): (Vec<f32>, Vec<f32>) = (
        lat.iter().map(|&x| x as f32).collect(),
        lon.iter().map(|&x| x as f32).collect(),
    );
    let r32 = matcher.match_arrays(g, &mut grids, &lat32, &lon32);
    assert_eq!(r32.arcs, want.arcs);
    // points that are not finite are skipped, not matched at the origin
    lat[10] = f64::NAN;
    lon[11] = f64::INFINITY;
    let r = matcher.match_arrays(g, &mut grids, &lat, &lon);
    assert_eq!(r.arcs, want.arcs);
    assert!((r.track_m - want.track_m).abs() < 15.0);
    // empty and tiny inputs
    for n in 0..2 {
        let r = matcher.match_arrays(g, &mut grids, &lat[..n], &lon[..n]);
        assert!(r.arcs.is_empty() && r.matched_m == 0.0);
    }
}

#[test]
fn a_track_off_the_graph_is_all_unmatched() {
    let built = grid(5, 5, 100.0).build();
    let far = (GRID_CENTER.0 + 5000.0 * DEG_PER_M, GRID_CENTER.1);
    let pts = walk(
        &[far, (far.0 + 500.0 * DEG_PER_M, far.1)],
        10.0,
        2.0,
        &mut Rng(16),
    );
    let m = run(&built, &pts);
    assert!(m.pieces.is_empty() && m.chains.is_empty());
    assert_eq!(m.unmatched.len(), 1);
    assert!((m.unmatched[0].length_m - m.stats.track_m).abs() < 1e-6);
    assert_eq!(m.to_result().breaks, 0);
}

#[test]
fn the_matcher_keeps_little_scratch_memory() {
    let built = grid(8, 8, 100.0).build();
    let mut rng = Rng(17);
    let route: Vec<(f64, f64)> = [(0, 0), (7, 0), (7, 7), (0, 7), (0, 1)]
        .iter()
        .map(|&(i, j)| node_at(8, 8, 100.0, f64::from(i), f64::from(j)))
        .collect();
    let pts = walk(&route, 4.0, 3.0, &mut rng);
    let mut matcher = Matcher::default();
    let mut grids = TileGrids::new(&built.graph);
    let r = matcher.match_track(&built.graph, &mut grids, &pts).to_result();
    assert!(r.matched_m > 0.97 * r.track_m);
    assert!(matcher.heap_bytes() < 64 * 1024, "{}", matcher.heap_bytes());
}

/// The grids of several tiles find what one grid over the whole graph finds, also across tile borders.
#[test]
fn tile_grids_agree_with_the_whole_grid() {
    let built = grid(12, 12, 100.0).zoom(16).build();
    let g = &built.graph;
    assert!(g.info().tiles.len() >= 4, "{} tiles", g.info().tiles.len());
    let whole = crate::spatial::Grid::build(g, crate::spatial::DEFAULT_CELL_M);
    let mut grids = TileGrids::new(g);
    grids.ensure(g, &(0..g.info().tiles.len()).collect::<Vec<_>>());
    assert_eq!(grids.built(), g.info().tiles.len());
    let mut rng = Rng(21);
    let (mut a, mut b) = (Vec::new(), Vec::new());
    for _ in 0..400 {
        let (i, j) = (rng.unit() * 11.0, rng.unit() * 11.0);
        let (x, y) = node_at(12, 12, 100.0, i, j);
        let q = LngLat { lng: x, lat: y };
        whole.snap_into(g, q, 40.0, 8, &mut a);
        grids.snap_into(g, q, 40.0, 8, &mut b);
        let key = |v: &[crate::spatial::Snap]| {
            v.iter()
                .map(|s| (s.edge, (s.distance_m * 1e3).round() as i64))
                .collect::<Vec<_>>()
        };
        assert_eq!(key(&a), key(&b), "at ({i}, {j})");
    }
    // a grid per tile only holds that tile's edges
    let one = crate::spatial::Grid::build_tile(g, 200.0, 0);
    assert!(one.entries() > 0 && one.entries() < whole.entries());
}
