//! The structured cost model (tier boards, the hills curve, `docs/profile.md`, "The structured
//! model"): the legacy model routes exactly as before (pinned), the structured one is consistent
//! (`length × factor + extra` is the compiled cost, the class compile equals the direct one, the A*
//! bound holds), and the conversion and the twins of the presets are sane.
#![allow(
    clippy::many_single_char_names,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::too_many_lines,
    clippy::unreadable_literal,
    reason = "tiny test graphs, test data and checksums"
)]

use kompass_core::attrs::{
    BikeAccess, CyclewayKind, EdgeAttrs, Highway, MotorAccess, MtbScale, Oneway, RouteLevel, SacScale,
    Smoothness, SurfaceClass, Tracktype, TrailVisibility,
};
use std::cmp::Reverse;
use std::collections::BinaryHeap;

use kompass_core::cost::{Clamp, CostModel, EdgeClasses, Role};
use kompass_core::explain::{ClosedBy, ExplainEdgeRequest};
use kompass_core::graph::arc_edge;
use kompass_core::profile::{BoardRow, DownHandles, Hills, Tier, UpHandles};
use kompass_core::route::{ErrorCode, RouteOptions, Waypoint};
use kompass_core::structured::to_structured;
use kompass_core::testing::{Built, GraphBuilder};
use kompass_core::{
    ArcId, Graph, LimitId, LimitValue, NodeId, PersonalLayer, Planner, PrefId, Profile, RouteRequest,
};

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
        self.below(1001) as f32 / 1000.0
    }
}

#[allow(clippy::cast_possible_truncation, reason = "test data in range")]
fn random_attrs(rng: &mut Rng) -> EdgeAttrs {
    let pick = |rng: &mut Rng, n: usize| rng.below(n as u64) as usize;
    EdgeAttrs {
        length_m: 0.0,
        highway: Highway::ALL[pick(rng, Highway::ALL.len())],
        surface: SurfaceClass::ALL[pick(rng, SurfaceClass::ALL.len())],
        tracktype: Tracktype::ALL[pick(rng, Tracktype::ALL.len())],
        smoothness: Smoothness::ALL[pick(rng, Smoothness::ALL.len())],
        oneway: if rng.below(6) == 0 {
            Oneway::ALL[pick(rng, 3)]
        } else {
            Oneway::Both
        },
        trail_visibility: TrailVisibility::ALL[pick(rng, TrailVisibility::ALL.len())],
        informal: rng.below(5) == 0,
        bike_access: if rng.below(4) == 0 {
            BikeAccess::ALL[pick(rng, BikeAccess::ALL.len())]
        } else {
            BikeAccess::Implicit
        },
        motor_access: MotorAccess::ALL[pick(rng, MotorAccess::ALL.len())],
        mtb_route: rng.below(5) == 0,
        cycleway: CyclewayKind::ALL[pick(rng, CyclewayKind::ALL.len())],
        route_level: RouteLevel::ALL[pick(rng, RouteLevel::ALL.len())],
        bridge: false,
        tunnel: false,
        maxspeed_kmh: (rng.below(3) > 0).then(|| (rng.below(26) * 5 + 5) as u8),
        lanes: (rng.below(2) > 0).then(|| rng.below(7) as u8 + 1),
        mtb_scale: MtbScale::ALL[pick(rng, MtbScale::ALL.len())],
        sac_scale: SacScale::ALL[pick(rng, SacScale::ALL.len())],
        barriers: rng.below(4) as u8 / 3,
        forest: rng.unit(),
        forest_edge: rng.unit(),
        water: rng.unit(),
        builtup: rng.unit(),
        road_near: rng.unit(),
        road_near_traffic: rng.unit(),
        width_m: None,
        ascent_fwd_m: rng.unit() * 15.0,
        ascent_bwd_m: rng.unit() * 15.0,
        max_grade_fwd_pct: rng.unit() * 25.0,
        max_grade_bwd_pct: rng.unit() * 25.0,
    }
}

/// An `n` × `n` grid of ~200 m with jittered nodes, random attributes and a few diagonals.
fn random_grid(rng: &mut Rng, n: usize) -> Built {
    let mut b = GraphBuilder::new();
    let step = 200.0 / 111_195.0;
    for j in 0..n {
        for i in 0..n {
            let jx = (f64::from(rng.unit()) - 0.5) * step * 0.4;
            let jy = (f64::from(rng.unit()) - 0.5) * step * 0.4;
            let h = b.node(0.07 + i as f64 * step + jx, 0.07 + j as f64 * step + jy);
            b.set_elevation(h, Some(100.0 + rng.unit() * 50.0));
        }
    }
    for j in 0..n {
        for i in 0..n {
            let v = j * n + i;
            if i + 1 < n {
                b.edge(v, v + 1, random_attrs(rng));
            }
            if j + 1 < n {
                b.edge(v, v + n, random_attrs(rng));
            }
            if i + 1 < n && j + 1 < n && rng.below(4) == 0 {
                b.edge(v, v + n + 1, random_attrs(rng));
            }
        }
    }
    b.build()
}

fn random_profile(rng: &mut Rng) -> Profile {
    let mut p = Profile::default();
    for &id in PrefId::ALL {
        if rng.below(3) == 0 {
            p.set_weight(id, Some((rng.below(201) as i16 - 100) as i8));
        }
    }
    for &id in LimitId::ALL {
        if rng.below(6) == 0 {
            let v = match id {
                LimitId::MaxGrade => LimitValue::Number(8.0 + rng.below(12) as f64),
                LimitId::MaxMtbScale => LimitValue::Number(rng.below(4) as f64),
                _ => LimitValue::Flag(true),
            };
            p.limits.insert(id, v);
        }
    }
    let mut b = p.bounds();
    b.min_factor = 0.3 + rng.unit() * 0.7;
    b.max_factor = 2.0 + rng.unit() * 30.0;
    p.bounds = Some(b);
    p
}

fn random_personal(rng: &mut Rng, edges: usize) -> PersonalLayer {
    let mut l = PersonalLayer::empty(edges, 20_000);
    for e in 0..edges {
        if rng.below(3) == 0 {
            l.rides[e] = rng.below(8) as u16 + 1;
            l.last_ridden[e] = 20_000 - rng.below(1500) as u32;
        }
    }
    l
}

/// FNV-1a over the compiled costs, rounded to millimetres (closed arcs as one value).
fn checksum(costs: &[f32], bound: f32) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |v: i64| {
        for b in v.to_le_bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    };
    for &c in costs {
        eat(if c.is_finite() {
            (f64::from(c) * 1000.0).round() as i64
        } else {
            -1
        });
    }
    eat((f64::from(bound) * 1e5).round() as i64);
    h
}

#[test]
fn the_legacy_model_routes_as_before() {
    // the shipped presets and random slider profiles on random graphs, compiled both ways: the
    // checksums were recorded before the structured model existed (a profile without `boards`,
    // `hills` and `detours` must cost exactly as before)
    let mut rng = Rng(0x0066_7165_7273_0001);
    let mut sums = Vec::new();
    for round in 0..3 {
        let built = random_grid(&mut rng, 9);
        let g = &built.graph;
        let classes = EdgeClasses::build(g).unwrap();
        let personal = (round % 2 == 0).then(|| random_personal(&mut rng, g.edge_count()));
        let mut profiles: Vec<Profile> = kompass_core::presets().into_iter().map(|p| p.profile).collect();
        profiles.extend((0..3).map(|_| random_profile(&mut rng)));
        for p in &profiles {
            let m = CostModel::new(p).unwrap();
            let mut out = Vec::new();
            let b = m.compile_classes(g, &classes, personal.as_ref(), &mut out);
            sums.push(checksum(&out, b));
        }
    }
    assert_eq!(sums, GOLDEN);
}

/// Recorded on main before #66 (aaa9d98).
const GOLDEN: &[u64] = &[
    6005744025771660927,
    1698107026168260778,
    6497312882843113547,
    292362815466316973,
    1360090585786265696,
    2421877416043995635,
    9155504980119182680,
    10350993489673576277,
    15043465692792201412,
    2548603689041723111,
    5538113485968415835,
    14587667502215584464,
    17742415862010291042,
    6365308038910606608,
    1362049096146705390,
    3112171874737544706,
    10309783097741137903,
    8479454253089873525,
    5245142621151585257,
    742439833925404190,
    11385101460867689564,
];

/// A random structured profile: a random slider profile converted, then every row, handle and
/// the spread at random.
fn random_structured(rng: &mut Rng) -> Profile {
    let mut p = to_structured(&random_profile(rng));
    let mut boards = p.boards.unwrap();
    for &row in BoardRow::ALL {
        let t = Tier::ALL[rng.below(5) as usize];
        // avoid rarely, or the random grid falls apart
        boards.set(
            row,
            if t == Tier::Avoid && rng.below(3) > 0 {
                Tier::Fine
            } else {
                t
            },
        );
    }
    match rng.below(4) {
        0 => boards.surface = None,
        1 => boards.way = None,
        _ => {}
    }
    p.boards = Some(boards);
    let h = |rng: &mut Rng, lo: f32, hi: f32| lo + rng.unit() * (hi - lo);
    p.hills = (rng.below(4) > 0).then(|| Hills {
        up: UpHandles {
            at3: h(rng, 0.5, 2.0),
            at6: h(rng, 0.5, 4.0),
            at10: h(rng, 0.6, 6.0),
            at15: h(rng, 0.8, 10.0),
        },
        down: (rng.below(2) == 0).then(|| DownHandles {
            at8: h(rng, 1.0, 3.0),
            at15: h(rng, 1.0, 6.0),
        }),
        loose_pct: (rng.below(5) * 10) as f32,
    });
    if p.hills.is_none() {
        // the slider hills come back (they are only rejected next to a curve)
        for id in [PrefId::Climb, PrefId::Steep, PrefId::RampsOver10] {
            if rng.below(2) == 0 {
                p.set_weight(id, Some((rng.below(201) as i16 - 100) as i8));
            }
        }
    }
    p.detours = Some(0.5 + rng.unit() * 1.5);
    p.validate().unwrap();
    p
}

#[test]
fn the_structured_cost_is_consistent() {
    // the class compile (which falls back) equals the direct one; `length × factor + extra` is the
    // compiled cost on every arc; no floor (factors ≥ 1, never at `min`), the cap holds, and the
    // bound is the smallest cost per metre
    let mut rng = Rng(0x0066_7374_7275_0002);
    for round in 0..10 {
        let built = random_grid(&mut rng, 9);
        let g = &built.graph;
        let classes = EdgeClasses::build(g).unwrap();
        let personal = (round % 2 == 0).then(|| random_personal(&mut rng, g.edge_count()));
        for _ in 0..6 {
            let p = random_structured(&mut rng);
            let m = CostModel::new(&p).unwrap();
            assert!(m.is_structured());
            let (mut direct, mut fast) = (Vec::new(), Vec::new());
            let b0 = m.compile_into(g, personal.as_ref(), &mut direct);
            let b1 = m.compile_classes(g, &classes, personal.as_ref(), &mut fast);
            assert!((b0 - b1).abs() < 1e-5, "bounds {b0} {b1}");
            let max = p.bounds().max_factor;
            for a in 0..g.arc_count() {
                let (x, y) = (direct[a], fast[a]);
                assert_eq!(x.is_finite(), y.is_finite(), "arc {a}");
                if x.is_finite() {
                    assert!((x - y).abs() <= 1e-5 * x.max(1.0), "arc {a}: {x} vs {y}");
                }
                let b = m.breakdown(g, personal.as_ref(), a as ArcId);
                assert_eq!(
                    x.is_finite(),
                    b.exclusions.is_empty(),
                    "arc {a}: {x} {:?}",
                    b.exclusions
                );
                if !x.is_finite() {
                    continue;
                }
                let len = g.length_m(arc_edge(a as ArcId));
                let again = len * b.factor + b.extra_m();
                assert!(
                    (again - x).abs() <= 1e-4 * x.max(1.0),
                    "arc {a}: {again} vs {x} under {p:?}"
                );
                assert!(
                    b.factor >= 1.0 - 1e-4 && b.factor <= max + 1e-4,
                    "arc {a}: {}",
                    b.factor
                );
                assert_ne!(b.clamp, Some(Clamp::Min));
                let st = b.structured.as_ref().unwrap();
                assert!(st.relative >= 1.0 - 1e-4, "arc {a}: relative {}", st.relative);
                assert!((st.relative * st.best - b.raw).abs() <= 1e-4 * b.raw);
                assert!(x > 0.0 && x >= len * b0 * 0.9999, "arc {a} below the bound");
                let ex = m.explain(g, personal.as_ref(), a as ArcId);
                assert!((ex.cost - x).abs() <= 1e-4 * x.max(1.0));
                // per group: only the strongest bonus and penalty count, and their product is the
                // quality (with the boards)
                let boards = p.boards.unwrap();
                let n = i32::from(boards.surface.is_some()) + i32::from(boards.way.is_some());
                let mut q = st.board_factor / Tier::Fine.factor().unwrap().powi(n);
                for gp in &st.groups {
                    for r in [gp.bonus, gp.penalty].into_iter().flatten() {
                        let t = b.terms.iter().find(|t| t.id == r.id).unwrap();
                        assert!(t.counted && t.factor.to_bits() == r.factor.to_bits());
                        q *= r.factor;
                    }
                }
                assert!(
                    (q - b.quality).abs() <= 1e-4 * b.quality,
                    "arc {a}: {q} vs {}",
                    b.quality
                );
                let counted = b
                    .terms
                    .iter()
                    .filter(|t| t.counted && t.role != Role::Additive)
                    .count();
                assert!(counted <= 3 * st.groups.len());
            }
        }
    }
}

/// Dijkstra over compiled costs from node to node (the reference).
fn dijkstra(g: &Graph, costs: &[f32], s: NodeId, t: NodeId) -> f32 {
    let mut dist = vec![f32::INFINITY; g.node_count()];
    let mut heap = BinaryHeap::new();
    dist[s as usize] = 0.0;
    heap.push(Reverse((0u32, s)));
    while let Some(Reverse((d, v))) = heap.pop() {
        let d = f32::from_bits(d);
        if d > dist[v as usize] {
            continue;
        }
        if v == t {
            return d;
        }
        for a in g.out_arcs(v) {
            let c = costs[a as usize];
            let w = g.head(a);
            if c.is_finite() && d + c < dist[w as usize] {
                dist[w as usize] = d + c;
                heap.push(Reverse(((d + c).to_bits(), w)));
            }
        }
    }
    f32::INFINITY
}

fn request(waypoints: Vec<Waypoint>, profile: &Profile) -> RouteRequest {
    RouteRequest {
        overrides: None,
        waypoints,
        profile: profile.clone(),
        leg_profiles: None,
        options: RouteOptions::default(),
        via_zones: None,
        avoid_zones: None,
        sketch: None,
    }
}

fn wp(lon: f64, lat: f64) -> Waypoint {
    Waypoint { lon, lat, name: None }
}

#[test]
fn a_star_finds_what_dijkstra_finds_under_the_structured_model() {
    // the bound (the smallest cost per metre, hills below 1 included) keeps A* exact
    let mut rng = Rng(0x0066_6173_7461_0003);
    let mut compared = 0;
    for _ in 0..6 {
        let built = random_grid(&mut rng, 12);
        let g = built.graph.clone();
        let mut planner = Planner::new(g.clone());
        for _ in 0..5 {
            // (turns free: the reference is a node Dijkstra; the turn search has its own tests)
            let p = Profile {
                turn_m: Some(0.0),
                ..random_structured(&mut rng)
            };
            let costs = planner.arc_costs(&p).unwrap().0.to_vec();
            for _ in 0..8 {
                let s = rng.below(g.node_count() as u64) as NodeId;
                let t = rng.below(g.node_count() as u64) as NodeId;
                let (a, b) = (g.node(s), g.node(t));
                let want = dijkstra(&g, &costs, s, t);
                match planner.route(&request(vec![wp(a.lng, a.lat), wp(b.lng, b.lat)], &p)) {
                    Ok(r)
                        if r.notes.is_empty()
                            && r.waypoints
                                .iter()
                                .all(|w| w.excluded_by.is_none() && w.distance_m < 0.01) =>
                    {
                        assert!(
                            (r.summary.cost - want).abs() <= 1e-3 * want.max(1.0),
                            "A* {} vs Dijkstra {want}",
                            r.summary.cost
                        );
                        // the breakdowns cover the route
                        let rows = r.breakdown.rows.as_ref().unwrap();
                        let boards = p.boards.unwrap();
                        let per_board =
                            usize::from(boards.surface.is_some()) + usize::from(boards.way.is_some());
                        let sum: f32 = rows.iter().map(|x| x.length_m).sum();
                        let ferry = r
                            .breakdown
                            .way
                            .iter()
                            .filter(|w| w.key == kompass_core::cost::WayKind::Ferry)
                            .map(|w| w.length_m)
                            .sum::<f32>();
                        let want_sum = r.summary.distance_m * per_board as f32
                            - if boards.way.is_some() { ferry } else { 0.0 };
                        assert!(
                            (sum - want_sum).abs() <= 0.5 + 1e-3 * want_sum,
                            "{sum} vs {want_sum}"
                        );
                        if let Some(h) = &r.breakdown.grades {
                            let hs: f32 = h.metres.iter().sum();
                            assert!((hs - r.summary.distance_m).abs() <= 0.5 + 1e-3 * hs, "{hs}");
                        }
                        assert!(
                            r.segments
                                .iter()
                                .all(|s| s.tiers.as_ref().is_some_and(|t| t.len() <= 2))
                        );
                        compared += 1;
                    }
                    Ok(_) => {}
                    Err(e) => {
                        if e.code == ErrorCode::NoRoute {
                            assert!(!want.is_finite() || s == t, "A* found nothing, Dijkstra {want}");
                        }
                    }
                }
            }
        }
    }
    assert!(compared > 50, "{compared}");
}

/// Two ways between S and T: the top (`p`, `p_len` metres per half) and the bottom.
fn diamond(p: EdgeAttrs, p_len: f32, n: EdgeAttrs, n_len: f32) -> (Built, (f64, f64), (f64, f64)) {
    let mut b = GraphBuilder::new();
    let (s, t) = ((0.075, 0.08), (0.085, 0.08));
    let sn = b.node(s.0, s.1);
    let top = b.node(0.08, 0.0802);
    let tn = b.node(t.0, t.1);
    let bot = b.node(0.08, 0.0798);
    let with = |a: EdgeAttrs, len: f32| EdgeAttrs { length_m: len, ..a };
    b.edge(sn, top, with(p, p_len));
    b.edge(top, tn, with(p, p_len));
    b.edge(sn, bot, with(n, n_len));
    b.edge(bot, tn, with(n, n_len));
    (b.build(), s, t)
}

fn takes_top(d: &(Built, (f64, f64), (f64, f64)), p: &Profile) -> bool {
    let mut planner = Planner::new(d.0.graph.clone());
    let r = planner
        .route(&request(vec![wp(d.1.0, d.1.1), wp(d.2.0, d.2.1)], p))
        .unwrap();
    r.arcs.iter().any(|&a| arc_edge(a) == d.0.edge(0))
}

fn track(surface: SurfaceClass) -> EdgeAttrs {
    EdgeAttrs {
        highway: Highway::Track,
        surface,
        ..EdgeAttrs::default()
    }
}

#[test]
fn the_boards_rank_ways_by_exchange_rates() {
    // gravel on love, paved on fine: a gravel track is worth a ride up to 1.35× longer
    let mut p = to_structured(&Profile::default());
    let mut b = p.boards.unwrap();
    b.set(BoardRow::Gravel, Tier::Love);
    p.boards = Some(b);
    let paved = track(SurfaceClass::PavedSmooth);
    let gravel = track(SurfaceClass::Gravel);
    assert!(takes_top(&diamond(gravel, 640.0, paved, 500.0), &p));
    assert!(!takes_top(&diamond(gravel, 700.0, paved, 500.0), &p));
    // detours 2: love against fine is 1.35² = 1.82
    p.detours = Some(2.0);
    assert!(takes_top(&diamond(gravel, 880.0, paved, 500.0), &p));
    assert!(!takes_top(&diamond(gravel, 940.0, paved, 500.0), &p));
    // avoid closes the row like a limit
    let mut b = p.boards.unwrap();
    b.set(BoardRow::Gravel, Tier::Avoid);
    p.boards = Some(b);
    p.detours = None;
    assert!(!takes_top(&diamond(gravel, 100.0, paved, 500.0), &p));
    let mut planner = Planner::new(diamond(gravel, 100.0, paved, 500.0).0.graph);
    let x = planner
        .explain_edge(&ExplainEdgeRequest {
            profile: p.clone(),
            edge: 0,
            overrides: None,
        })
        .unwrap();
    assert_eq!(x.along.closed_by[0].by, ClosedBy::AvoidedSurface);
    let st = x.along.structured.as_ref().unwrap();
    assert_eq!(st.boards[0].row, BoardRow::Gravel);
    assert_eq!(st.boards[0].tier, Tier::Avoid);
}

#[test]
fn overlapping_sliders_do_not_stack() {
    // forest and forest edge are both Landscape: on a way that is both only the stronger counts
    let mut p = to_structured(&Profile::default());
    p.set_weight(PrefId::Forest, Some(100));
    p.set_weight(PrefId::ForestEdge, Some(100));
    let mut b = GraphBuilder::new();
    let (x, y) = (b.node(0.08, 0.08), b.node(0.081, 0.08));
    b.edge(
        x,
        y,
        EdgeAttrs {
            forest: 1.0,
            forest_edge: 1.0,
            ..track(SurfaceClass::Gravel)
        },
    );
    let built = b.build();
    let m = CostModel::new(&p).unwrap();
    let bd = m.breakdown(&built.graph, None, 0);
    let counted: Vec<PrefId> = bd.terms.iter().filter(|t| t.counted).map(|t| t.id).collect();
    assert_eq!(
        counted,
        [PrefId::ForestEdge],
        "the stronger bonus (0.75 against 0.8)"
    );
    // and the way at the best of the sliders costs what its rows say (fine on both boards)
    assert!((bd.factor - 1.35 * 1.35).abs() < 1e-4, "{}", bd.factor);
}

#[test]
fn the_hills_curve_prices_the_steep_way_in_metres() {
    // both ways climb 36 m: the top in 300 m (a 13 % wall, 11 % after it), the bottom in 400 m
    // (10 %, then 8 %), each followed by a flat stretch as long. Without a curve the shorter top
    // wins (600 against 800 m); "No walls" prices the top's climb at about 690 m and the bottom's
    // at about 370 m, so the bottom wins
    let mut b = GraphBuilder::new();
    let s = b.node_at(0.075, 0.08, 100.0);
    let top = b.node_at(0.08, 0.0802, 136.0);
    let t = b.node_at(0.085, 0.08, 136.0);
    let bot = b.node_at(0.08, 0.0798, 136.0);
    let road = EdgeAttrs {
        highway: Highway::Residential,
        surface: SurfaceClass::PavedSmooth,
        ..EdgeAttrs::default()
    };
    let climb = |len: f32, grade: f32| EdgeAttrs {
        length_m: len,
        ascent_fwd_m: 36.0,
        max_grade_fwd_pct: grade,
        ..road
    };
    b.edge(s, top, climb(300.0, 13.0));
    b.edge(
        top,
        t,
        EdgeAttrs {
            length_m: 300.0,
            ..road
        },
    );
    b.edge(s, bot, climb(400.0, 10.0));
    b.edge(
        bot,
        t,
        EdgeAttrs {
            length_m: 400.0,
            ..road
        },
    );
    let built = b.build();
    let route = |p: &Profile| {
        let mut planner = Planner::new(built.graph.clone());
        let r = planner
            .route(&request(vec![wp(0.075, 0.08), wp(0.085, 0.08)], p))
            .unwrap();
        (r.arcs.iter().any(|&a| arc_edge(a) == 0), r)
    };
    let mut p = Profile {
        hills: Some(Hills::flat()),
        ..Profile::default()
    };
    assert!(route(&p).0);
    p.hills = kompass_core::structured::curve_presets()
        .into_iter()
        .find(|c| c.id == "no_walls")
        .map(|c| c.hills);
    let (top_taken, r) = route(&p);
    assert!(!top_taken);
    let h = r.breakdown.grades.as_ref().unwrap();
    assert!((h.metres.iter().sum::<f32>() - 800.0).abs() < 1.0);
    // 50 m at the wall (10 %, in the 10–11 % band), 350 m at 8.4 %, 400 m flat
    assert!((h.metres[30] - 50.0).abs() < 1.0, "{:?}", h.metres);
    assert!((h.metres[28] - 350.0).abs() < 1.0, "{:?}", h.metres);
    assert!((h.metres[20] - 400.0).abs() < 1.0, "{:?}", h.metres);
    let climbing = &r.segments[0];
    assert!(
        climbing.hills_m.is_some_and(|m| (300.0..450.0).contains(&m)),
        "{climbing:?}"
    );
}

#[test]
fn structured_profiles_validate_strictly() {
    let base = r#""boards":{"surface":{"paved":"fine","rough_paved":"fine","compacted":"love","gravel":"like","soft":"dislike","unknown":"fine"}}"#;
    let ok = Profile::from_json(&format!("{{{base}}}")).unwrap();
    assert!(ok.structured());
    for (json, want) in [
        (
            format!(r#"{{{base},"weights":{{"unpaved":50}}}}"#),
            "surface board's job",
        ),
        (
            format!(r#"{{{base},"limits":{{"paved_only":true}}}}"#),
            "surface board's job",
        ),
        (
            format!(r#"{{{base},"bounds":{{"min_factor":0.4}}}}"#),
            "min_factor",
        ),
        (format!(r#"{{{base},"detours":3}}"#), "detours"),
        (
            r#"{"hills":{"up":{"3":1,"6":1,"10":1,"15":1}},"weights":{"steep":-50}}"#.to_owned(),
            "hills curve's job",
        ),
        (
            r#"{"hills":{"up":{"3":0.2,"6":1,"10":1,"15":1}}}"#.to_owned(),
            "hills.up.3",
        ),
        (
            r#"{"hills":{"up":{"3":1,"6":1,"10":1,"15":1},"down":{"8":0.9,"15":1}}}"#.to_owned(),
            "hills.down.8",
        ),
        (
            r#"{"hills":{"up":{"3":1,"6":1,"10":1}}}"#.to_owned(),
            "missing field",
        ),
        (
            r#"{"boards":{"surface":{"paved":"meh"}}}"#.to_owned(),
            "unknown variant",
        ),
        (r#"{"boards":{"ways":{}}}"#.to_owned(), "unknown field"),
    ] {
        let e = Profile::from_json(&json).unwrap_err();
        assert!(e.0.contains(want), "{json}: {e}");
    }
    // `false` limits are as if absent; the way board's sliders are fine next to the surface board
    Profile::from_json(&format!(
        r#"{{{base},"limits":{{"paved_only":false}},"weights":{{"track":40}}}}"#
    ))
    .unwrap();
    // the cost key tells structured profiles apart
    let mut other = ok.clone();
    other.detours = Some(1.5);
    assert_ne!(ok.cost_key(), other.cost_key());
}

#[test]
fn every_shipped_preset_has_a_structured_twin() {
    let twins = kompass_core::presets::structured_presets();
    let shipped = kompass_core::presets();
    assert_eq!(twins.len(), shipped.len());
    for (t, s) in twins.iter().zip(&shipped) {
        assert_eq!(t.id, format!("{}_structured", s.id));
        assert_eq!(t.profile.name, s.profile.name);
        assert!(t.profile.structured());
        assert!(
            t.profile
                .boards
                .is_some_and(|b| b.surface.is_some() && b.way.is_some())
        );
        assert!(t.profile.hills.is_some());
        assert_eq!(kompass_core::preset(&t.id).map(|p| p.id), Some(t.id.clone()));
        // generated by the conversion; what was tuned after (replay, the PR of #66) is listed
        let mut want = to_structured(&s.profile);
        for (row, tier) in tuned(&t.id) {
            let mut b = want.boards.unwrap();
            b.set(row, tier);
            want.boards = Some(b);
        }
        if let Some(h) = tuned_hills(&t.id) {
            want.hills = Some(h);
        }
        assert_eq!(t.profile, want, "{}", t.id);
    }
}

/// The rows of a twin tuned after the conversion.
fn tuned(_id: &str) -> Vec<(BoardRow, Tier)> {
    Vec::new()
}

/// The hills of a twin tuned after the conversion: River valley's climbing handles × 1.6 (the
/// curve charges only the steepest 50 m where `steep` charged the whole arc; replay on the
/// rider's rides: ascent 1281 → 1144 m per 100 km, today 1124, reproduced within a point).
fn tuned_hills(id: &str) -> Option<Hills> {
    (id == "river_valley_structured").then_some(Hills {
        up: UpHandles {
            at3: 2.22,
            at6: 2.94,
            at10: 4.27,
            at15: 6.62,
        },
        down: Some(DownHandles { at8: 1.0, at15: 1.43 }),
        loose_pct: 0.0,
    })
}
