//! The graph through its files: round trip, one-way adjacency, tiles in any order and partial
//! loading, broken files.
#![allow(
    clippy::many_single_char_names,
    reason = "nodes and edges of tiny test graphs"
)]

use kompass_core::attrs::{EdgeAttrs, Highway, Oneway, SurfaceClass};
use kompass_core::geometry::WayRef;
use kompass_core::graph::{GraphLoader, arc, arc_edge, flags};
use kompass_core::testing::{GraphBuilder, grid};
use kompass_core::{Graph, LngLat};

/// A deterministic xorshift for test data.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    fn unit(&mut self) -> f32 {
        #[allow(clippy::cast_precision_loss, reason = "test data")]
        let v = self.below(1001) as f32 / 1000.0;
        v
    }
}

#[allow(clippy::cast_possible_truncation, reason = "test data in range")]
fn random_attrs(rng: &mut Rng) -> EdgeAttrs {
    use kompass_core::attrs::*;
    let pick = |rng: &mut Rng, n: usize| rng.below(n as u64) as usize;
    EdgeAttrs {
        length_m: 0.0,
        highway: Highway::ALL[pick(rng, Highway::ALL.len())],
        surface: SurfaceClass::ALL[pick(rng, SurfaceClass::ALL.len())],
        tracktype: Tracktype::ALL[pick(rng, Tracktype::ALL.len())],
        smoothness: Smoothness::ALL[pick(rng, Smoothness::ALL.len())],
        oneway: Oneway::ALL[pick(rng, 3)],
        trail_visibility: TrailVisibility::ALL[pick(rng, TrailVisibility::ALL.len())],
        informal: rng.below(2) == 1,
        bike_access: BikeAccess::ALL[pick(rng, BikeAccess::ALL.len())],
        motor_access: MotorAccess::ALL[pick(rng, MotorAccess::ALL.len())],
        mtb_route: rng.below(2) == 1,
        cycleway: CyclewayKind::ALL[pick(rng, CyclewayKind::ALL.len())],
        route_level: RouteLevel::ALL[pick(rng, RouteLevel::ALL.len())],
        bridge: rng.below(2) == 1,
        tunnel: rng.below(2) == 1,
        maxspeed_kmh: (rng.below(3) > 0).then(|| (rng.below(26) * 5 + 5) as u8),
        lanes: (rng.below(2) > 0).then(|| rng.below(7) as u8 + 1),
        mtb_scale: MtbScale::ALL[pick(rng, MtbScale::ALL.len())],
        sac_scale: SacScale::ALL[pick(rng, SacScale::ALL.len())],
        barriers: rng.below(4) as u8,
        forest: rng.unit(),
        forest_edge: rng.unit(),
        water: rng.unit(),
        builtup: rng.unit(),
        road_near: rng.unit(),
        road_near_traffic: rng.unit(),
        width_m: (rng.below(2) > 0).then(|| rng.unit() * 7.0 + 0.5),
        ascent_fwd_m: rng.unit() * 40.0,
        ascent_bwd_m: rng.unit() * 40.0,
        max_grade_fwd_pct: rng.unit() * 30.0,
        max_grade_bwd_pct: rng.unit() * 30.0,
    }
}

/// A 6 × 6 grid of 300 m, random attributes and bent geometry; tile zoom 15 (~1.2 km tiles), so it
/// spans several tiles (0° is a tile border at every zoom, so `GRID_CENTER` is moved onto it).
fn tiled() -> GraphBuilder {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut b = GraphBuilder::new().zoom(15).build_id("tiled");
    let step = 300.0 / 111_195.08;
    let n = 6usize;
    let mut at = Vec::new();
    for j in 0..n {
        for i in 0..n {
            #[allow(clippy::cast_precision_loss, reason = "tiny grid")]
            let p = ((i as f64 - 2.5) * step, (j as f64 - 2.5) * step);
            b.node(p.0, p.1);
            at.push(p);
        }
    }
    let mut add = |b: &mut GraphBuilder, a: usize, c: usize| {
        let attrs = random_attrs(&mut rng);
        if rng.below(3) == 0 {
            b.edge(a, c, attrs);
        } else {
            // bent: the middle pushed sideways by up to ~40 m
            #[allow(clippy::cast_precision_loss, reason = "test data")]
            let off = (rng.below(81) as f64 - 40.0) / 111_195.08;
            let mid = (
                f64::midpoint(at[a].0, at[c].0) + off,
                f64::midpoint(at[a].1, at[c].1) - off,
            );
            b.edge_via(a, c, &[mid], attrs);
        }
    };
    for j in 0..n {
        for i in 0..n - 1 {
            add(&mut b, j * n + i, j * n + i + 1);
        }
    }
    for i in 0..n {
        for j in 0..n - 1 {
            add(&mut b, j * n + i, (j + 1) * n + i);
        }
    }
    b
}

#[test]
fn the_tiled_fixture_spans_several_tiles_with_cross_tile_edges() {
    let built = tiled().build();
    let g = &built.graph;
    let info = g.info();
    assert!(info.tiles.len() >= 4, "{} tiles", info.tiles.len());
    assert_eq!(info.edge_count, 60);
    assert_eq!(info.node_count, 36);
    let cross = (0..60)
        .filter(|&e| info.tile_of_node(g.from(e)) != info.tile_of_node(g.to(e)))
        .count();
    assert!(cross > 0);
    // every edge and node is in exactly the tile the index says
    for (t, tile) in info.tiles.iter().enumerate() {
        for e in tile.edges.clone() {
            assert_eq!(info.tile_of_edge(e), Some(t));
        }
        for v in tile.nodes.clone() {
            assert_eq!(info.tile_of_node(v), Some(t));
        }
    }
    let [w, s, e, n] = info.bounds();
    assert!(w < 0.0 && e > 0.0 && s < 0.0 && n > 0.0);
}

#[test]
fn accessors_agree_with_the_decoded_attributes() {
    let built = tiled().build();
    let g = &built.graph;
    for e in 0..60 {
        let a = g.attrs(e);
        assert!((g.length_m(e) - a.length_m).abs() < 1e-6);
        assert_eq!(g.highway(e), a.highway);
        assert_eq!(g.surface(e), a.surface);
        assert_eq!(g.tracktype(e), a.tracktype);
        assert_eq!(g.smoothness(e), a.smoothness);
        assert_eq!(g.oneway(e), a.oneway);
        assert_eq!(g.trail_visibility(e), a.trail_visibility);
        assert_eq!(g.informal(e), a.informal);
        assert_eq!(g.bike_access(e), a.bike_access);
        assert_eq!(g.motor_access(e), a.motor_access);
        assert_eq!(g.mtb_route(e), a.mtb_route);
        assert_eq!(g.cycleway(e), a.cycleway);
        assert_eq!(g.route_level(e), a.route_level);
        assert_eq!(g.bridge(e), a.bridge);
        assert_eq!(g.tunnel(e), a.tunnel);
        assert_eq!(g.maxspeed_kmh(e), a.maxspeed_kmh);
        assert_eq!(g.lanes(e), a.lanes);
        assert_eq!(g.mtb_scale(e), a.mtb_scale);
        assert_eq!(g.sac_scale(e), a.sac_scale);
        assert_eq!(g.barriers(e), a.barriers);
        assert!((g.forest_share(e) - a.forest).abs() < 1e-6);
        assert!((g.forest_edge_share(e) - a.forest_edge).abs() < 1e-6);
        assert!((g.water_share(e) - a.water).abs() < 1e-6);
        assert!((g.builtup_share(e) - a.builtup).abs() < 1e-6);
        assert!((g.road_near_share(e) - a.road_near).abs() < 1e-6);
        assert!((g.road_near_traffic(e) - a.road_near_traffic).abs() < 1e-6);
        assert_eq!(g.width_m(e), a.width_m);
        let (fwd, bwd) = (arc(e, false), arc(e, true));
        assert!((g.ascent_m(fwd) - a.ascent_fwd_m).abs() < 1e-6);
        assert!((g.ascent_m(bwd) - a.ascent_bwd_m).abs() < 1e-6);
        assert!((g.descent_m(fwd) - a.ascent_bwd_m).abs() < 1e-6);
        assert!((g.max_grade_pct(fwd) - a.max_grade_fwd_pct).abs() < 1e-6);
        assert!((g.max_grade_pct(bwd) - a.max_grade_bwd_pct).abs() < 1e-6);
        assert_eq!(g.tail(fwd), g.from(e));
        assert_eq!(g.head(fwd), g.to(e));
        assert_eq!(g.tail(bwd), g.to(e));
        assert_eq!(g.head(bwd), g.from(e));
    }
}

#[test]
fn values_survive_the_files() {
    let mut b = GraphBuilder::new();
    let (p, q, r) = (b.node(0.01, 0.01), b.node(0.011, 0.01), b.node(0.011, 0.011));
    let attrs = EdgeAttrs {
        highway: Highway::Track,
        surface: SurfaceClass::Gravel,
        maxspeed_kmh: Some(30),
        forest: 0.4,
        ascent_fwd_m: 3.5,
        ..EdgeAttrs::default()
    };
    let e0 = b.edge_via(p, q, &[(0.0105, 0.0102)], attrs);
    let e1 = b.edge(q, r, EdgeAttrs::default());
    b.way(
        e0,
        WayRef {
            way_id: 987_654_321,
            pos_from: 4,
            pos_to: 9,
        },
    );
    let built = b.build();
    let g = &built.graph;
    let (e0, e1) = (built.edge(e0), built.edge(e1));
    assert_eq!((e0, e1), (0, 1), "one tile: ids are the handles");
    assert_eq!(g.highway(e0), Highway::Track);
    assert_eq!(g.maxspeed_kmh(e0), Some(30));
    assert!((g.forest_share(e0) - 0.4).abs() < 1.0 / 30.0);
    assert!((g.ascent_m(arc(e0, false)) - 3.5).abs() < 0.051);
    // length from the points (two legs of ~60 m), stored in decimetres
    let len = g.length_m(e0);
    assert!((len - 119.8).abs() < 0.1, "{len}");
    assert_eq!(
        g.way(e0),
        Some(WayRef {
            way_id: 987_654_321,
            pos_from: 4,
            pos_to: 9
        })
    );
    let pts: Vec<_> = g.edge_points(e0).collect();
    assert_eq!(
        pts,
        vec![(100_000, 100_000), (105_000, 102_000), (110_000, 100_000)]
    );
    assert_eq!(g.edge_points(e1).count(), 2);
    let LngLat { lng, lat } = g.node(g.to(e1));
    assert!((lng - 0.011).abs() < 1e-9 && (lat - 0.011).abs() < 1e-9);
    assert_eq!(g.info().build_id, "test");
    assert_eq!(g.info().tiles.len(), 1);
}

#[test]
fn one_way_edges_leave_only_their_way() {
    let mut b = GraphBuilder::new();
    let (p, q, r) = (b.node(0.01, 0.01), b.node(0.012, 0.01), b.node(0.014, 0.01));
    let along = b.edge(
        p,
        q,
        EdgeAttrs {
            oneway: Oneway::Along,
            ..EdgeAttrs::default()
        },
    );
    let against = b.edge(
        q,
        r,
        EdgeAttrs {
            oneway: Oneway::Against,
            ..EdgeAttrs::default()
        },
    );
    let built = b.build();
    let g = &built.graph;
    let (p, q, r) = (built.node(p), built.node(q), built.node(r));
    let (along, against) = (built.edge(along), built.edge(against));
    let out = |v| g.out_arcs(v).collect::<Vec<_>>();
    let inn = |v| g.in_arcs(v).collect::<Vec<_>>();
    // p → q only; r → q only (against the geometry of q → r)
    assert_eq!(out(p), vec![arc(along, false)]);
    assert_eq!(out(q), Vec::<u32>::new());
    assert_eq!(out(r), vec![arc(against, true)]);
    assert_eq!(inn(q), vec![arc(along, false), arc(against, true)]);
    assert_eq!(inn(p), Vec::<u32>::new());
    assert_eq!(inn(r), Vec::<u32>::new());
    for a in inn(q) {
        assert_eq!(g.head(a), q);
        assert!(g.arc_allowed(a));
    }
    assert!(!g.arc_allowed(arc(along, true)));
    // every incident edge is still there for map-matching, flagged
    let (arcs, fl) = g.arcs_at(q);
    assert_eq!(arcs, &[arc(along, true), arc(against, false)]);
    assert_eq!(fl, &[flags::IN, flags::IN]);
}

#[test]
fn a_grid_has_both_directions_everywhere() {
    let built = grid(3, 3, 100.0).build();
    let g = &built.graph;
    assert_eq!(g.edge_count(), 12);
    assert_eq!(built.edges, (0..12).collect::<Vec<_>>());
    assert_eq!(built.nodes, (0..9).collect::<Vec<_>>());
    let mut heads: Vec<u32> = g.out_arcs(4).map(|a| g.head(a)).collect();
    heads.sort_unstable();
    assert_eq!(heads, vec![1, 3, 5, 7]);
    let mut tails: Vec<u32> = g.in_arcs(4).map(|a| g.tail(a)).collect();
    tails.sort_unstable();
    assert_eq!(tails, vec![1, 3, 5, 7]);
    assert!((g.length_m(0) - 100.0).abs() < 0.1);
    assert!((g.node_distance_m(0, 8) - 200.0 * 2f64.sqrt()).abs() < 0.1);
}

#[test]
fn tiles_load_in_any_order_and_partially() {
    let built = tiled().build();
    let files = &built.files;
    let full = &built.graph;
    let n = files.tiles.len();
    // reversed and interleaved order
    let order: Vec<usize> = (0..n).rev().collect();
    let g = Graph::load(
        &files.index,
        order.iter().map(|&i| files.tiles[i].graph.as_slice()),
        order.iter().map(|&i| files.tiles[i].geometry.as_slice()),
    )
    .unwrap();
    assert_eq!(&g, full);

    // all but one tile: the loader says which is missing, and the search never reaches it
    let skip = n / 2;
    let mut loader = GraphLoader::new(&files.index).unwrap();
    for (i, t) in files.tiles.iter().enumerate() {
        if i != skip {
            loader.add_tile(&t.graph).unwrap();
        }
    }
    assert_eq!(loader.missing_tiles(), vec![skip]);
    let partial = loader.finish();
    assert!(!partial.is_complete());
    let missing = &partial.info().tiles[skip];
    for v in 0..partial.node_count() {
        #[allow(clippy::cast_possible_truncation, reason = "tiny graph")]
        let v = v as u32;
        for a in partial.out_arcs(v).chain(partial.in_arcs(v)) {
            let e = arc_edge(a);
            assert!(partial.edge_usable(e));
            assert!(!missing.edges.contains(&e));
            assert!(!missing.nodes.contains(&partial.from(e)) && !missing.nodes.contains(&partial.to(e)));
        }
    }
    // the rest later: the same graph (geometry added on the graph itself)
    let mut loader = partial.into_loader();
    loader.add_tile(&files.tiles[skip].graph).unwrap();
    let mut g = loader.finish();
    for t in &files.tiles {
        g.add_geometry(&t.geometry).unwrap();
    }
    assert_eq!(&g, full);
}

#[test]
fn broken_or_foreign_files_are_rejected() {
    let built = tiled().build();
    let other = tiled().build_id("other").build();
    let files = &built.files;
    let mut loader = GraphLoader::new(&files.index).unwrap();
    let tile = &files.tiles[0];
    let err = loader.add_tile(&other.files.tiles[0].graph).unwrap_err();
    assert!(err.0.contains("build other"), "{err}");
    loader.add_tile(&tile.graph).unwrap();
    assert!(loader.add_tile(&tile.graph).unwrap_err().0.contains("twice"));
    assert!(
        loader
            .add_tile(&tile.geometry)
            .unwrap_err()
            .0
            .contains("expected a Graph")
    );
    assert!(loader.add_geometry(&tile.graph).is_err());
    assert!(GraphLoader::new(&tile.graph).is_err());
    let mut cut = files.tiles[1].graph.clone();
    cut.truncate(cut.len() / 2);
    assert!(loader.add_tile(&cut).is_err());
    // a tile of a different graph with the same build id: not in this index
    let small = grid(2, 2, 100.0).build_id("tiled").build();
    assert!(loader.add_tile(&small.files.tiles[0].graph).is_err());
    assert_eq!(kompass_core::graph::build_id_of(&tile.geometry).unwrap(), "tiled");
}

#[test]
fn heap_bytes_are_about_the_columns() {
    let built = tiled().build();
    let g = &built.graph;
    // 32 bytes per edge of columns (incl. nodes), adjacency 9 per edge plus 4 per node
    assert!(g.heap_bytes() > 60 * 30);
    assert_eq!(g.adjacency_bytes(), (37 + 120) * 4 + 120);
}
