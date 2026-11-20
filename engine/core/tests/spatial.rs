//! Snapping: the grid agrees with brute force, with and without geometry, across tiles.
#![allow(
    clippy::many_single_char_names,
    reason = "nodes and edges of tiny test graphs"
)]

use kompass_core::attrs::EdgeAttrs;
use kompass_core::graph::GraphLoader;
use kompass_core::spatial::{DEFAULT_CELL_M, Grid, snap_brute_force};
use kompass_core::testing::{GRID_CENTER, GraphBuilder, grid};
use kompass_core::{LngLat, haversine_m};

const DEG_PER_M: f64 = 1.0 / 111_195.08;

fn at(east_m: f64, north_m: f64) -> LngLat {
    LngLat {
        lng: GRID_CENTER.0 + east_m * DEG_PER_M,
        lat: GRID_CENTER.1 + north_m * DEG_PER_M,
    }
}

#[test]
fn snaps_to_the_nearest_edge_with_projection() {
    // 3 × 3 nodes 100 m apart: edge 0 runs west → east along the bottom row
    let built = grid(3, 3, 100.0).build();
    let g = &built.graph;
    let grid = Grid::build(g, 30.0);
    // 10 m north of the middle of edge 0 (bottom row, x from -100 to 0)
    let hits = grid.snap(g, at(-50.0, -90.0), 200.0, 3);
    let s = hits[0];
    assert_eq!(s.edge, 0);
    assert!((s.distance_m - 10.0).abs() < 0.05, "{}", s.distance_m);
    assert!((s.fraction - 0.5).abs() < 1e-3);
    let foot = at(-50.0, -100.0);
    assert!(haversine_m(s.point, foot) < 0.05);
    // the next ones are farther, in order
    assert_eq!(hits.len(), 3);
    assert!(hits.windows(2).all(|w| w[0].distance_m <= w[1].distance_m));
    // a radius keeps far edges out
    assert_eq!(grid.snap(g, at(-50.0, -90.0), 5.0, 3).len(), 0);
    assert_eq!(grid.snap(g, at(-50.0, -90.0), 12.0, 3).len(), 1);
    // nothing asked, nothing found
    assert_eq!(grid.snap(g, at(0.0, 0.0), 100.0, 0).len(), 0);
}

/// A deterministic xorshift for query points.
struct Rng(u64);

impl Rng {
    fn unit(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        #[allow(clippy::cast_precision_loss, reason = "test data")]
        let v = (self.0 % 1_000_001) as f64 / 1e6;
        v
    }
}

fn bent_grid() -> GraphBuilder {
    // 7 × 7 nodes 250 m apart, every other edge bent by 60 m (so geometry matters), tile zoom 15
    let mut b = GraphBuilder::new().zoom(15);
    let step = 250.0 * DEG_PER_M;
    let n = 7;
    let mut pts = Vec::new();
    for j in 0..n {
        for i in 0..n {
            let p = (f64::from(i - 3) * step, f64::from(j - 3) * step);
            b.node(p.0, p.1);
            pts.push(p);
        }
    }
    let idx = |i: i32, j: i32| usize::try_from(j * n + i).unwrap();
    let mut k = 0;
    let mut edge = |b: &mut GraphBuilder, a: usize, c: usize, north: bool| {
        k += 1;
        let mid = (
            f64::midpoint(pts[a].0, pts[c].0),
            f64::midpoint(pts[a].1, pts[c].1),
        );
        let off = 60.0 * DEG_PER_M;
        if k % 2 == 0 {
            let bend = if north {
                (mid.0 + off, mid.1)
            } else {
                (mid.0, mid.1 + off)
            };
            b.edge_via(a, c, &[bend], EdgeAttrs::default());
        } else {
            b.edge(a, c, EdgeAttrs::default());
        }
    };
    for j in 0..n {
        for i in 0..n - 1 {
            edge(&mut b, idx(i, j), idx(i + 1, j), false);
        }
    }
    for i in 0..n {
        for j in 0..n - 1 {
            edge(&mut b, idx(i, j), idx(i, j + 1), true);
        }
    }
    b
}

#[test]
fn agrees_with_brute_force_with_and_without_geometry() {
    let built = bent_grid().build();
    assert!(built.graph.info().tiles.len() > 1);
    // the same graph without its geometry
    let files = &built.files;
    let bare = GraphLoader::new(&files.index).map(|mut l| {
        for t in &files.tiles {
            l.add_tile(&t.graph).unwrap();
        }
        l.finish()
    });
    let bare = bare.unwrap();
    let mut rng = Rng(42);
    let mut out = Vec::new();
    for (g, use_geometry) in [(&built.graph, true), (&bare, false)] {
        for cell in [DEFAULT_CELL_M, 75.0] {
            let grid = Grid::build(g, cell);
            assert_eq!(grid.uses_geometry(), use_geometry);
            for _ in 0..400 {
                // inside the grid and up to 400 m beyond it
                let p = LngLat {
                    lng: (rng.unit() - 0.5) * 2300.0 * DEG_PER_M,
                    lat: (rng.unit() - 0.5) * 2300.0 * DEG_PER_M,
                };
                let radius = 20.0 + rng.unit() * 400.0;
                grid.snap_into(g, p, radius, 4, &mut out);
                let want = snap_brute_force(g, p, radius, 4, use_geometry);
                let ids = |v: &[kompass_core::spatial::Snap]| v.iter().map(|s| s.edge).collect::<Vec<_>>();
                assert_eq!(
                    ids(&out),
                    ids(&want),
                    "{p:?} r={radius} cell={cell} geometry={use_geometry}"
                );
                for (a, b) in out.iter().zip(&want) {
                    assert!((a.distance_m - b.distance_m).abs() < 1e-9);
                    assert!((a.fraction - b.fraction).abs() < 1e-9);
                    // the projected point is where the distance says
                    assert!((haversine_m(p, a.point) - a.distance_m).abs() < 0.01 + a.distance_m * 1e-3);
                }
            }
        }
    }
    // the geometry changes the answer: a point on a bend is far from the straight segment
    let bent = (0..built.graph.edge_count())
        .map(|e| u32::try_from(e).unwrap())
        .find(|&e| built.graph.edge_points(e).count() == 3)
        .unwrap();
    let mid = built.graph.edge_points(bent).nth(1).unwrap();
    let p = LngLat::from_e7(mid.0, mid.1);
    let with = Grid::build(&built.graph, DEFAULT_CELL_M).snap(&built.graph, p, 100.0, 1);
    assert_eq!(with[0].edge, bent);
    assert!(with[0].distance_m < 0.2);
    let without = Grid::build(&bare, DEFAULT_CELL_M).snap(&bare, p, 100.0, 5);
    assert!(without.iter().all(|s| s.edge != bent || s.distance_m > 50.0));
}

#[test]
fn snap_into_does_not_allocate_once_warm() {
    let built = grid(10, 10, 100.0).build();
    let g = &built.graph;
    let grid = Grid::build(g, DEFAULT_CELL_M);
    let mut out = Vec::with_capacity(8);
    let cap = out.capacity();
    let ptr = out.as_ptr();
    for i in 0..100 {
        grid.snap_into(
            g,
            at(f64::from(i) * 7.0 - 350.0, f64::from(i) * 3.0 - 150.0),
            300.0,
            8,
            &mut out,
        );
        assert_ne!(out.len(), 0);
    }
    assert_eq!((out.capacity(), out.as_ptr()), (cap, ptr));
    assert!(grid.cells() > 0 && grid.entries() >= g.edge_count() && grid.heap_bytes() > 0);
}
