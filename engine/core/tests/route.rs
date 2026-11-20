//! The profile, the cost and the route query on synthetic graphs: every preference and every limit
//! changes the chosen route in its direction, the class compile equals the direct one, A* equals
//! Dijkstra under random profiles, legs, snapping onto allowed ways, one-way, the diff, the
//! personal layer.
#![allow(
    clippy::many_single_char_names,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    reason = "tiny test graphs and test data"
)]

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use kompass_core::attrs::{
    BikeAccess, CyclewayKind, EdgeAttrs, Highway, MotorAccess, MtbScale, Oneway, RouteLevel, SacScale,
    Smoothness, SurfaceClass, Tracktype, TrailVisibility,
};
use kompass_core::cost::{CostModel, EdgeClasses};
use kompass_core::graph::arc_edge;
use kompass_core::route::{DiffRequest, ErrorCode, RouteOptions, Waypoint, Zone};
use kompass_core::testing::{Built, GraphBuilder};
use kompass_core::{
    ArcId, EdgeId, Graph, LimitId, LimitValue, NodeId, PersonalLayer, Planner, PrefId, Profile, RouteRequest,
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

fn wp(lon: f64, lat: f64) -> Waypoint {
    Waypoint { lon, lat, name: None }
}

fn request(waypoints: Vec<Waypoint>, profile: &Profile) -> RouteRequest {
    RouteRequest {
        waypoints,
        profile: profile.clone(),
        leg_profiles: None,
        options: RouteOptions::default(),
        via_zones: None,
        avoid_zones: None,
        sketch: None,
    }
}

fn weights(w: &[(PrefId, i8)]) -> Profile {
    let mut p = Profile::default();
    for &(id, v) in w {
        p.set_weight(id, Some(v));
    }
    p
}

fn residential() -> EdgeAttrs {
    EdgeAttrs {
        highway: Highway::Residential,
        surface: SurfaceClass::PavedSmooth,
        ..EdgeAttrs::default()
    }
}

/// Two ways from S to T: the top one with `p` attributes (`p_len` per half), the bottom one with
/// `n` (`n_len` per half). Lengths are at least the straight line (the A* bound stays valid).
struct Diamond {
    built: Built,
    s: (f64, f64),
    t: (f64, f64),
    top: [usize; 2],
    bottom: [usize; 2],
}

const HALF_M: f32 = 650.0;

fn diamond(p: EdgeAttrs, p_len: f32, n: EdgeAttrs, n_len: f32, elevations: Option<[f32; 4]>) -> Diamond {
    let mut b = GraphBuilder::new();
    let (s, t) = ((0.075, 0.08), (0.085, 0.08));
    let sn = b.node(s.0, s.1);
    let top = b.node(0.08, 0.0802);
    let tn = b.node(t.0, t.1);
    let bot = b.node(0.08, 0.0798);
    if let Some(e) = elevations {
        for (h, z) in [sn, top, tn, bot].into_iter().zip(e) {
            b.set_elevation(h, Some(z));
        }
    }
    let with = |a: EdgeAttrs, len: f32| EdgeAttrs { length_m: len, ..a };
    let t0 = b.edge(sn, top, with(p, p_len));
    let t1 = b.edge(top, tn, with(p, p_len));
    let b0 = b.edge(sn, bot, with(n, n_len));
    let b1 = b.edge(bot, tn, with(n, n_len));
    Diamond {
        built: b.build(),
        s,
        t,
        top: [t0, t1],
        bottom: [b0, b1],
    }
}

/// Which way the route takes: true for the top.
fn takes_top(d: &Diamond, profile: &Profile, personal: Option<PersonalLayer>) -> bool {
    let mut planner = Planner::new(d.built.graph.clone());
    planner.set_personal(personal).unwrap();
    let r = planner
        .route(&request(vec![wp(d.s.0, d.s.1), wp(d.t.0, d.t.1)], profile))
        .unwrap();
    let edges: Vec<EdgeId> = r.arcs.iter().map(|&a| arc_edge(a)).collect();
    let top = d.top.iter().any(|&h| edges.contains(&d.built.edge(h)));
    let bottom = d.bottom.iter().any(|&h| edges.contains(&d.built.edge(h)));
    assert!(top != bottom, "the route takes exactly one way: {edges:?}");
    top
}

/// One preference case: the top way's attributes (where the preference applies with `sign`) and a
/// bottom way where it does not.
struct Case {
    pref: PrefId,
    top: EdgeAttrs,
    bottom: EdgeAttrs,
    /// +1: the top way is what the preference names; −1: its opposite.
    sign: i8,
    elevations: Option<[f32; 4]>,
    /// Ride history (top edges, bottom edges): (rides, days ago).
    history: Option<((u16, u32), (u16, u32))>,
}

fn case(pref: PrefId, top: EdgeAttrs, bottom: EdgeAttrs) -> Case {
    Case {
        pref,
        top,
        bottom,
        sign: 1,
        elevations: None,
        history: None,
    }
}

fn cases() -> Vec<Case> {
    let track = |s: SurfaceClass| EdgeAttrs {
        highway: Highway::Track,
        surface: s,
        ..EdgeAttrs::default()
    };
    let res = residential();
    let path = EdgeAttrs {
        highway: Highway::Path,
        surface: SurfaceClass::Compacted,
        ..EdgeAttrs::default()
    };
    let cycleway = |road_near: f32| EdgeAttrs {
        highway: Highway::Cycleway,
        surface: SurfaceClass::PavedSmooth,
        road_near,
        ..EdgeAttrs::default()
    };
    let primary = EdgeAttrs {
        highway: Highway::Primary,
        surface: SurfaceClass::PavedSmooth,
        maxspeed_kmh: Some(100),
        lanes: Some(4),
        ..EdgeAttrs::default()
    };
    let climbing = EdgeAttrs {
        ascent_fwd_m: 30.0,
        ascent_bwd_m: 0.0,
        max_grade_fwd_pct: 6.0,
        ..res
    };
    let steep = EdgeAttrs {
        ascent_fwd_m: 40.0,
        ascent_bwd_m: 40.0,
        max_grade_fwd_pct: 16.0,
        max_grade_bwd_pct: 16.0,
        ..res
    };
    vec![
        case(PrefId::Unpaved, track(SurfaceClass::Gravel), res),
        case(PrefId::PavedSmooth, res, track(SurfaceClass::Gravel)),
        case(
            PrefId::PavedRough,
            EdgeAttrs {
                surface: SurfaceClass::PavedRough,
                ..res
            },
            res,
        ),
        case(PrefId::FineGravel, track(SurfaceClass::Compacted), res),
        case(PrefId::SoftGround, track(SurfaceClass::Soft), res),
        case(
            PrefId::UnknownSurface,
            EdgeAttrs {
                highway: Highway::Track,
                ..EdgeAttrs::default()
            },
            track(SurfaceClass::Gravel),
        ),
        case(
            PrefId::Tracktype,
            EdgeAttrs {
                tracktype: Tracktype::Grade1,
                ..track(SurfaceClass::Gravel)
            },
            track(SurfaceClass::Gravel),
        ),
        case(
            PrefId::Smoothness,
            EdgeAttrs {
                smoothness: Smoothness::Excellent,
                ..res
            },
            res,
        ),
        case(PrefId::Track, track(SurfaceClass::Gravel), path),
        case(PrefId::Path, path, track(SurfaceClass::Compacted)),
        case(PrefId::CyclewaySep, cycleway(0.0), res),
        case(PrefId::CyclewayRoad, cycleway(1.0), res),
        case(PrefId::Residential, res, track(SurfaceClass::PavedSmooth)),
        case(
            PrefId::Service,
            EdgeAttrs {
                highway: Highway::Service,
                ..res
            },
            res,
        ),
        case(
            PrefId::Minor,
            EdgeAttrs {
                highway: Highway::Tertiary,
                ..res
            },
            res,
        ),
        case(PrefId::Main, primary, res),
        Case {
            sign: -1,
            ..case(PrefId::Quiet, primary, track(SurfaceClass::PavedSmooth))
        },
        case(PrefId::Speed, primary, res),
        case(PrefId::Lanes, primary, res),
        case(
            PrefId::NearRoad,
            EdgeAttrs {
                road_near: 1.0,
                ..res
            },
            res,
        ),
        case(PrefId::Forest, EdgeAttrs { forest: 1.0, ..res }, res),
        case(
            PrefId::ForestEdge,
            EdgeAttrs {
                forest_edge: 1.0,
                ..res
            },
            res,
        ),
        case(PrefId::Water, EdgeAttrs { water: 1.0, ..res }, res),
        case(PrefId::Open, res, EdgeAttrs { forest: 1.0, ..res }),
        case(PrefId::Built, EdgeAttrs { builtup: 1.0, ..res }, res),
        Case {
            elevations: Some([100.0, 130.0, 100.0, 100.0]),
            ..case(PrefId::Climb, climbing, res)
        },
        case(PrefId::Steep, steep, res),
        case(
            PrefId::BikeRoutes,
            EdgeAttrs {
                route_level: RouteLevel::Ncn,
                ..res
            },
            res,
        ),
        case(
            PrefId::MtbRoutes,
            EdgeAttrs {
                mtb_route: true,
                ..res
            },
            res,
        ),
        case(
            PrefId::Access,
            EdgeAttrs {
                bike_access: BikeAccess::FootOnly,
                ..res
            },
            res,
        ),
        case(
            PrefId::Sketchy,
            EdgeAttrs {
                trail_visibility: TrailVisibility::No,
                ..path
            },
            path,
        ),
        case(
            PrefId::Mtb,
            EdgeAttrs {
                mtb_scale: MtbScale::S3,
                ..path
            },
            path,
        ),
        case(
            PrefId::Visibility,
            EdgeAttrs {
                trail_visibility: TrailVisibility::Bad,
                ..path
            },
            path,
        ),
        Case {
            history: Some(((0, 0), (3, 10))),
            ..case(PrefId::Novel, res, res)
        },
        Case {
            history: Some(((1, 1000), (1, 10))),
            ..case(PrefId::Stale, res, res)
        },
        Case {
            history: Some(((6, 10), (0, 0))),
            ..case(PrefId::Familiar, res, res)
        },
    ]
}

fn personal_for(d: &Diamond, history: ((u16, u32), (u16, u32))) -> PersonalLayer {
    let today = 20_000;
    let mut layer = PersonalLayer::empty(d.built.graph.edge_count(), today);
    for (hs, (rides, ago)) in [(d.top, history.0), (d.bottom, history.1)] {
        for h in hs {
            let e = d.built.edge(h) as usize;
            layer.rides[e] = rides;
            layer.last_ridden[e] = if rides > 0 { today - ago } else { 0 };
        }
    }
    layer
}

#[test]
fn every_preference_moves_the_route_its_way() {
    let all = cases();
    // every preference has a case
    for &id in PrefId::ALL {
        assert!(all.iter().any(|c| c.pref == id), "no case for {id}");
    }
    for c in &all {
        // the top way 10 % longer or shorter than the bottom one
        let longer = HALF_M * 1.1;
        let shorter = HALF_M / 1.1;
        let build = |top_len: f32| diamond(c.top, top_len, c.bottom, HALF_M, c.elevations);
        let layer = |d: &Diamond| c.history.map(|h| personal_for(d, h));
        let (seek, avoid) = (weights(&[(c.pref, 100)]), weights(&[(c.pref, -100)]));
        // without an opinion: the shorter way
        let d = build(longer);
        assert!(
            !takes_top(&d, &Profile::default(), layer(&d)),
            "{}: neutral, top longer",
            c.pref
        );
        let d = build(shorter);
        assert!(
            takes_top(&d, &Profile::default(), layer(&d)),
            "{}: neutral, top shorter",
            c.pref
        );
        if c.sign > 0 {
            let d = build(longer);
            assert!(
                takes_top(&d, &seek, layer(&d)),
                "{}: +100 takes the longer matching way",
                c.pref
            );
            let d = build(shorter);
            assert!(
                !takes_top(&d, &avoid, layer(&d)),
                "{}: -100 avoids the shorter matching way",
                c.pref
            );
        } else {
            let d = build(shorter);
            assert!(
                !takes_top(&d, &seek, layer(&d)),
                "{}: +100 avoids the shorter opposite",
                c.pref
            );
            let d = build(longer);
            assert!(
                takes_top(&d, &avoid, layer(&d)),
                "{}: -100 takes the longer opposite",
                c.pref
            );
        }
    }
}

#[test]
fn history_preferences_need_the_personal_layer() {
    let d = diamond(residential(), HALF_M * 1.1, residential(), HALF_M, None);
    // without a layer, seeking new ground changes nothing
    assert!(!takes_top(&d, &weights(&[(PrefId::Novel, 100)]), None));
}

#[test]
fn novelty_is_a_bonus_only_within_acceptable_quality() {
    // the new way is soft ground, which the profile strongly avoids: novelty does not pull there
    let soft = EdgeAttrs {
        highway: Highway::Track,
        surface: SurfaceClass::Soft,
        ..EdgeAttrs::default()
    };
    let d = diamond(soft, HALF_M * 0.95, residential(), HALF_M, None);
    let layer = personal_for(&d, ((0, 0), (5, 3)));
    let p = weights(&[(PrefId::SoftGround, -60), (PrefId::Novel, 100)]);
    assert!(!takes_top(&d, &p, Some(layer.clone())));
    // on an acceptable way the same novelty wins a 10 % detour
    let d = diamond(residential(), HALF_M * 1.1, residential(), HALF_M, None);
    let layer = personal_for(&d, ((0, 0), (5, 3)));
    assert!(takes_top(&d, &weights(&[(PrefId::Novel, 100)]), Some(layer)));
}

/// A limit case: the top way is shorter and excluded by the limit.
fn limit_cases() -> Vec<(LimitId, LimitValue, EdgeAttrs, f32)> {
    let res = residential();
    let on = LimitValue::Flag(true);
    vec![
        (
            LimitId::NoMainRoads,
            on,
            EdgeAttrs {
                highway: Highway::Secondary,
                ..res
            },
            1.0,
        ),
        (
            LimitId::PavedOnly,
            on,
            EdgeAttrs {
                highway: Highway::Track,
                surface: SurfaceClass::Gravel,
                ..EdgeAttrs::default()
            },
            1.0,
        ),
        (
            LimitId::NoUnknownSurface,
            on,
            EdgeAttrs {
                highway: Highway::Path,
                ..EdgeAttrs::default()
            },
            1.0,
        ),
        (
            LimitId::MaxGrade,
            LimitValue::Number(12.0),
            EdgeAttrs {
                ascent_fwd_m: 40.0,
                ascent_bwd_m: 40.0,
                max_grade_fwd_pct: 16.0,
                max_grade_bwd_pct: 3.0,
                ..res
            },
            1.0,
        ),
        (
            LimitId::MaxMtbScale,
            LimitValue::Number(1.0),
            EdgeAttrs {
                highway: Highway::Path,
                surface: SurfaceClass::Soft,
                mtb_scale: MtbScale::S3,
                ..EdgeAttrs::default()
            },
            1.0,
        ),
        (
            LimitId::NoStairs,
            on,
            EdgeAttrs {
                highway: Highway::Steps,
                ..res
            },
            10.0,
        ),
        (
            LimitId::NoStairs,
            on,
            EdgeAttrs {
                highway: Highway::Path,
                sac_scale: SacScale::DemandingMountainHiking,
                ..EdgeAttrs::default()
            },
            1.0,
        ),
        (
            LimitId::LegalOnly,
            on,
            EdgeAttrs {
                highway: Highway::Footway,
                bike_access: BikeAccess::FootOnly,
                ..res
            },
            1.0,
        ),
        (
            LimitId::LegalOnly,
            on,
            EdgeAttrs {
                bike_access: BikeAccess::Private,
                ..res
            },
            1.0,
        ),
        (
            LimitId::NoFerries,
            on,
            EdgeAttrs {
                highway: Highway::Ferry,
                ..EdgeAttrs::default()
            },
            10.0,
        ),
    ]
}

#[test]
fn every_limit_excludes_its_ways() {
    for &id in LimitId::ALL {
        assert!(limit_cases().iter().any(|c| c.0 == id), "no case for {id}");
    }
    for (id, value, top, bottom_scale) in limit_cases() {
        let d = diamond(top, HALF_M / 1.1, residential(), HALF_M * bottom_scale, None);
        assert!(
            takes_top(&d, &Profile::default(), None),
            "{id}: without the limit"
        );
        let mut p = Profile::default();
        p.limits.insert(id, value);
        assert!(!takes_top(&d, &p, None), "{id}: with the limit");
        // switched off is the same as absent
        p.limits.insert(id, LimitValue::Flag(false));
        assert!(takes_top(&d, &p, None), "{id}: switched off");
    }
}

#[test]
fn bicycle_bans_and_one_way_always_hold() {
    let banned = EdgeAttrs {
        bike_access: BikeAccess::No,
        ..residential()
    };
    let d = diamond(banned, HALF_M / 1.5, residential(), HALF_M, None);
    assert!(!takes_top(&d, &Profile::default(), None));
    // one-way against the riding direction: the top way only works from T to S
    let against = EdgeAttrs {
        oneway: Oneway::Against,
        ..residential()
    };
    let d = diamond(against, HALF_M / 1.5, residential(), HALF_M, None);
    assert!(!takes_top(&d, &Profile::default(), None));
    let mut planner = Planner::new(d.built.graph.clone());
    let back = planner
        .route(&request(
            vec![wp(d.t.0, d.t.1), wp(d.s.0, d.s.1)],
            &Profile::default(),
        ))
        .unwrap();
    assert!(back.arcs.iter().any(|&a| arc_edge(a) == d.built.edge(d.top[0])));
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

#[test]
fn the_class_compile_equals_the_direct_compile_and_the_explanation() {
    let mut rng = Rng(0x0123_4567_89ab_cdef);
    for round in 0..12 {
        let built = random_grid(&mut rng, 9);
        let g = &built.graph;
        let classes = EdgeClasses::build(g).unwrap();
        let personal = (round % 2 == 0).then(|| random_personal(&mut rng, g.edge_count()));
        for _ in 0..6 {
            let p = random_profile(&mut rng);
            let m = CostModel::new(&p).unwrap();
            let (mut direct, mut fast) = (Vec::new(), Vec::new());
            let b0 = m.compile_into(g, personal.as_ref(), &mut direct);
            let b1 = m.compile_classes(g, &classes, personal.as_ref(), &mut fast);
            assert!((b0 - b1).abs() < 1e-5, "bounds {b0} {b1}");
            let bounds = p.bounds();
            for a in 0..g.arc_count() {
                let (x, y) = (direct[a], fast[a]);
                assert_eq!(x.is_finite(), y.is_finite(), "arc {a}: {x} vs {y} under {p:?}");
                if x.is_finite() {
                    assert!((x - y).abs() <= 1e-4 * x.max(1.0), "arc {a}: {x} vs {y}");
                    // the clamp: length × [min, max] (+ additive terms ≥ 0)
                    let len = g.length_m(arc_edge(a as ArcId));
                    assert!(x >= len * bounds.min_factor * 0.9999, "arc {a} below the clamp");
                    assert!(x >= len * b0 * 0.9999, "arc {a} below the bound");
                }
                let ex = m.explain(g, personal.as_ref(), a as ArcId);
                assert_eq!(ex.cost.is_finite(), x.is_finite(), "explain arc {a}");
                if x.is_finite() {
                    assert!(
                        (ex.cost - x).abs() <= 1e-4 * x.max(1.0),
                        "explain arc {a}: {} vs {x}",
                        ex.cost
                    );
                    assert!(ex.factor >= bounds.min_factor - 1e-6 && ex.factor <= bounds.max_factor + 1e-6);
                }
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

#[test]
fn a_star_finds_what_dijkstra_finds() {
    let mut rng = Rng(0xdead_beef_cafe_f00d);
    let mut compared = 0;
    for _ in 0..8 {
        let built = random_grid(&mut rng, 12);
        let g = built.graph.clone();
        let mut planner = Planner::new(g.clone());
        for _ in 0..5 {
            let p = random_profile(&mut rng);
            let costs = planner.arc_costs(&p).unwrap().0.to_vec();
            for _ in 0..8 {
                let s = rng.below(g.node_count() as u64) as NodeId;
                let t = rng.below(g.node_count() as u64) as NodeId;
                let (a, b) = (g.node(s), g.node(t));
                let want = dijkstra(&g, &costs, s, t);
                let got = planner.route(&request(vec![wp(a.lng, a.lat), wp(b.lng, b.lat)], &p));
                match got {
                    // (without detours over excluded ways near the waypoints, which Dijkstra
                    // over the compiled costs cannot take)
                    Ok(r)
                        if r.notes.is_empty()
                            && r.waypoints
                                .iter()
                                .all(|w| w.excluded_by.is_none() && w.distance_m < 0.01) =>
                    {
                        assert!(
                            want.is_finite(),
                            "A* found {} where Dijkstra found nothing",
                            r.summary.cost
                        );
                        assert!(
                            (r.summary.cost - want).abs() <= 1e-3 * want.max(1.0),
                            "A* {} vs Dijkstra {want}",
                            r.summary.cost
                        );
                        compared += 1;
                    }
                    Ok(_) => {}
                    Err(e) => {
                        // nothing reachable: Dijkstra agrees unless a waypoint snapped elsewhere
                        if e.code == ErrorCode::NoRoute {
                            assert!(!want.is_finite() || s == t, "A* found nothing, Dijkstra {want}");
                        }
                    }
                }
            }
        }
    }
    assert!(compared > 100, "only {compared} routes compared");
}

/// A line of nodes 100 m apart: residential, one gravel detour around the middle.
fn line() -> (Built, Vec<(f64, f64)>) {
    let mut b = GraphBuilder::new();
    let step = 100.0 / 111_195.0;
    let pts: Vec<(f64, f64)> = (0..7).map(|i| (0.07 + f64::from(i) * step, 0.08)).collect();
    let nodes: Vec<usize> = pts
        .iter()
        .map(|&(x, y)| b.node_at(x, y, 100.0 + x as f32))
        .collect();
    for w in nodes.windows(2) {
        b.edge(w[0], w[1], residential());
    }
    // the detour: from node 2 up and back to node 4
    let up = b.node(pts[3].0, 0.08 + step);
    let gravel = EdgeAttrs {
        highway: Highway::Track,
        surface: SurfaceClass::Gravel,
        ..EdgeAttrs::default()
    };
    b.edge(nodes[2], up, gravel);
    b.edge(up, nodes[4], gravel);
    (b.build(), pts)
}

#[test]
fn legs_join_at_the_waypoints() {
    let (built, pts) = line();
    let mut planner = Planner::new(built.graph.clone());
    let p = Profile::default();
    let full = planner
        .route(&request(vec![wp(pts[0].0, pts[0].1), wp(pts[6].0, pts[6].1)], &p))
        .unwrap();
    assert!(
        (full.summary.distance_m - 600.0).abs() < 1.0,
        "{}",
        full.summary.distance_m
    );
    let via = planner
        .route(&request(
            vec![
                wp(pts[0].0, pts[0].1),
                wp(pts[3].0 + 0.0001, pts[3].1),
                wp(pts[6].0, pts[6].1),
            ],
            &p,
        ))
        .unwrap();
    assert_eq!(via.legs.len(), 2);
    assert!((via.summary.distance_m - 600.0).abs() < 1.0);
    let leg_sum: f32 = via.legs.iter().map(|l| l.distance_m).sum();
    assert!((leg_sum - via.summary.distance_m).abs() < 0.1);
    assert_eq!(via.legs[0].arcs[1], via.legs[1].arcs[0]);
    assert_eq!(via.legs[1].arcs[1] as usize, via.arcs.len());
    assert_eq!(via.legs[1].segments[1] as usize, via.segments.len());
    // segments tile the route
    let mut at = 0.0;
    for s in &via.segments {
        assert!((s.start_m - at).abs() < 0.1);
        at += s.length_m;
    }
    assert!((at - via.summary.distance_m).abs() < 0.1);
    // geometry: per vertex distance and elevation, ending at the total
    let geo = via.geometry.as_ref().unwrap();
    assert_eq!(geo.coordinates.len(), geo.distance_m.len());
    let ele = geo.elevation_m.as_ref().unwrap();
    assert_eq!(ele.len(), geo.coordinates.len());
    assert!((geo.distance_m.last().unwrap() - via.summary.distance_m).abs() < 0.2);
    assert_eq!(via.arc_vertex.len(), via.arcs.len());
    // a waypoint back and forth: the second leg turns around
    let back = planner
        .route(&request(
            vec![
                wp(pts[1].0, pts[1].1),
                wp(pts[5].0, pts[5].1),
                wp(pts[2].0, pts[2].1),
            ],
            &p,
        ))
        .unwrap();
    assert!((back.summary.distance_m - 700.0).abs() < 1.0);
}

#[test]
fn leg_profiles_route_each_leg_their_way() {
    let (built, pts) = line();
    let mut planner = Planner::new(built.graph.clone());
    let gravel = weights(&[(PrefId::Unpaved, 100)]);
    let plain = Profile::default();
    let wps = vec![
        wp(pts[0].0, pts[0].1),
        wp(pts[6].0, pts[6].1),
        wp(pts[0].0, pts[0].1),
    ];
    let mut req = request(wps, &plain);
    let both_plain = planner.route(&req).unwrap();
    assert!(both_plain.summary.unpaved_share < 1e-6);
    req.leg_profiles = Some(vec![None, Some(gravel.clone())]);
    let r = planner.route(&req).unwrap();
    // only the way back takes the gravel detour
    let unpaved = |l: usize| {
        let [a, b] = r.legs[l].segments;
        r.segments[a as usize..b as usize]
            .iter()
            .filter(|s| s.surface == kompass_core::route::SurfaceKind::Gravel)
            .map(|s| s.length_m)
            .sum::<f32>()
    };
    assert!(
        unpaved(0) < 1e-3 && unpaved(1) > 100.0,
        "{} {}",
        unpaved(0),
        unpaved(1)
    );
    req.leg_profiles = Some(vec![None]);
    assert_eq!(planner.route(&req).unwrap_err().code, ErrorCode::InvalidRequest);
}

#[test]
fn waypoints_snap_onto_allowed_ways() {
    let mut b = GraphBuilder::new();
    let step = 100.0 / 111_195.0;
    // an allowed street, and a footway 30 m north of it (closer to the waypoint)
    let a = b.node(0.07, 0.08);
    let c = b.node(0.07 + 3.0 * step, 0.08);
    let f0 = b.node(0.07, 0.08 + 0.3 * step);
    let f1 = b.node(0.07 + 3.0 * step, 0.08 + 0.3 * step);
    let street = b.edge(a, c, residential());
    let foot = EdgeAttrs {
        highway: Highway::Footway,
        bike_access: BikeAccess::FootOnly,
        ..residential()
    };
    let fw = b.edge(f0, f1, foot);
    b.edge(f1, c, residential());
    // a pedestrian pocket 5 km away, only reachable on foot ways (more than the exemption's
    // 1 km around either waypoint)
    let m1 = b.node(0.07 + 18.0 * step, 0.08);
    let m2 = b.node(0.07 + 34.0 * step, 0.08);
    let p0 = b.node(0.07 + 50.0 * step, 0.08);
    let p1 = b.node(0.07 + 51.0 * step, 0.08);
    b.edge(c, m1, foot);
    b.edge(m1, m2, foot);
    b.edge(m2, p0, foot);
    let pocket = b.edge(p0, p1, foot);
    // and a small one: 600 m of foot ways to the street
    let q0 = b.node(0.07 + 3.0 * step, 0.08 + 6.0 * step);
    let q1 = b.node(0.07 + 4.0 * step, 0.08 + 6.0 * step);
    b.edge(c, q0, foot);
    let small = b.edge(q0, q1, foot);
    let built = b.build();
    let mut planner = Planner::new(built.graph.clone());
    let mut legal = Profile::default();
    legal.limits.insert(LimitId::LegalOnly, LimitValue::Flag(true));
    let near_foot = wp(0.07 + 1.0 * step, 0.08 + 0.25 * step);
    let r = planner
        .route(&request(
            vec![near_foot.clone(), wp(0.07 + 2.0 * step, 0.08)],
            &legal,
        ))
        .unwrap();
    assert_eq!(
        r.waypoints[0].edge,
        built.edge(street),
        "snapped past the footway onto the street"
    );
    // without the limit the footway is nearest
    let r = planner
        .route(&request(
            vec![near_foot, wp(0.07 + 2.0 * step, 0.08 + 0.3 * step)],
            &Profile::default(),
        ))
        .unwrap();
    assert_eq!(r.waypoints[0].edge, built.edge(fw));
    // only excluded ways within the radius: the route starts on one and gets away, with a note
    let mut req = request(
        vec![
            wp(0.07 + 1.5 * step, 0.08 + 0.3 * step),
            wp(0.07 + 2.0 * step, 0.08),
        ],
        &legal,
    );
    req.options.snap_radius_m = 10.0;
    let r = planner.route(&req).unwrap();
    assert_eq!(r.waypoints[0].edge, built.edge(fw));
    assert!(
        r.waypoints[0]
            .excluded_by
            .as_deref()
            .unwrap()
            .contains("Legal access only")
    );
    assert!(r.notes.iter().any(|n| n.contains("waypoint 1")), "{:?}", r.notes);
    // ... unless nothing allowed can be reached from it: an error naming the limit
    let mut req = request(
        vec![
            wp(0.07 + 3.5 * step, 0.08 + 6.0 * step),
            wp(0.07 + 2.0 * step, 0.08),
        ],
        &legal,
    );
    req.options.snap_radius_m = 20.0;
    let r = planner.route(&req).unwrap();
    assert_eq!(r.waypoints[0].edge, built.edge(small));
    assert!(
        r.notes.iter().any(|n| n.contains("ways the profile excludes")),
        "{:?}",
        r.notes
    );
    let mut req = request(
        vec![wp(0.07 + 50.5 * step, 0.08), wp(0.07 + 2.0 * step, 0.08)],
        &legal,
    );
    req.options.snap_radius_m = 20.0;
    let e = planner.route(&req).unwrap_err();
    assert_eq!(e.code, ErrorCode::Excluded);
    assert!(e.message.contains("Legal access only"), "{}", e.message);
    let _ = pocket;
    // and nothing within the radius at all
    let mut req = request(vec![wp(0.2, 0.2), wp(0.07, 0.08)], &legal);
    req.options.snap_radius_m = 50.0;
    let e = planner.route(&req).unwrap_err();
    assert_eq!((e.code, e.waypoint), (ErrorCode::NoWayNear, Some(0)));
}

#[test]
fn requests_are_checked_and_reserved_fields_noted() {
    let (built, pts) = line();
    let mut planner = Planner::new(built.graph.clone());
    let p = Profile::default();
    let e = planner
        .route(&request(vec![wp(pts[0].0, pts[0].1)], &p))
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidRequest);
    let mut bad = p.clone();
    bad.limits.insert(LimitId::MaxGrade, LimitValue::Number(99.0));
    let e = planner
        .route(&request(
            vec![wp(pts[0].0, pts[0].1), wp(pts[6].0, pts[6].1)],
            &bad,
        ))
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidProfile);
    let mut req = request(vec![wp(pts[0].0, pts[0].1), wp(pts[6].0, pts[6].1)], &p);
    req.avoid_zones = Some(vec![Zone::Circle {
        center: kompass_core::route::Coord {
            lon: pts[3].0,
            lat: pts[3].1,
        },
        radius_m: 50.0,
    }]);
    let r = planner.route(&req).unwrap();
    assert!(r.notes.iter().any(|n| n.starts_with("avoid_zones")));
    // the JSON of a request parses back
    let json = serde_json::to_string(&req).unwrap();
    let back: RouteRequest = serde_json::from_str(&json).unwrap();
    assert_eq!(back, req);
    let minimal: RouteRequest =
        serde_json::from_str(r#"{"waypoints":[{"lon":0,"lat":0},{"lon":1,"lat":1}],"profile":{}}"#).unwrap();
    assert!((minimal.options.snap_radius_m - 250.0).abs() < 1e-9);
    // the result serialises
    let json = serde_json::to_value(&r).unwrap();
    assert!(json["segments"][0]["why"].is_array());
}

#[test]
fn the_diff_finds_where_two_routes_part() {
    let (built, pts) = line();
    let mut planner = Planner::new(built.graph.clone());
    let wps = vec![wp(pts[0].0, pts[0].1), wp(pts[6].0, pts[6].1)];
    let a = planner.route(&request(wps.clone(), &Profile::default())).unwrap();
    let b = planner
        .route(&request(wps, &weights(&[(PrefId::Unpaved, 100)])))
        .unwrap();
    let d = planner.diff(&DiffRequest {
        a: a.arcs.clone(),
        b: b.arcs.clone(),
    });
    assert_eq!(d.stretches.len(), 1, "{d:?}");
    let s = d.stretches[0];
    // a rides two street edges where b takes the two gravel edges, from 200 m on
    assert_eq!(s.a.arcs[1] - s.a.arcs[0], 2);
    assert_eq!(s.b.arcs[1] - s.b.arcs[0], 2);
    assert!((s.a.start_m - 200.0).abs() < 1.0 && (s.a.length_m - 200.0).abs() < 1.0);
    assert!(s.b.length_m > 200.0);
    assert!((d.shared_m - 400.0).abs() < 1.0);
    // a route against itself, and against nothing
    let same = planner.diff(&DiffRequest {
        a: a.arcs.clone(),
        b: a.arcs.clone(),
    });
    assert_eq!(same.stretches, vec![]);
    let none = planner.diff(&DiffRequest {
        a: a.arcs.clone(),
        b: Vec::new(),
    });
    assert_eq!(none.stretches.len(), 1);
    assert_eq!(none.stretches[0].a.arcs, [0, a.arcs.len() as u32]);
}

#[test]
fn the_personal_layer_marks_ridden_and_new() {
    let (built, pts) = line();
    let mut planner = Planner::new(built.graph.clone());
    let mut layer = PersonalLayer::empty(built.graph.edge_count(), 20_000);
    for h in 0..3 {
        layer.record(built.edge(h), 19_990);
    }
    planner.set_personal(Some(layer)).unwrap();
    let r = planner
        .route(&request(
            vec![wp(pts[0].0, pts[0].1), wp(pts[6].0, pts[6].1)],
            &Profile::default(),
        ))
        .unwrap();
    let ridden = r.breakdown.ridden.as_ref().unwrap();
    assert!((ridden.ridden_m - 300.0).abs() < 1.0 && (ridden.new_m - 300.0).abs() < 1.0);
    assert!((r.summary.new_share.unwrap() - 0.5).abs() < 0.01);
    assert!(r.segments.iter().any(|s| s.ridden == Some(true)));
    assert!(r.segments.iter().any(|s| s.ridden == Some(false)));
    assert!(planner.set_personal(Some(PersonalLayer::empty(3, 0))).is_err());
}

#[test]
fn segments_say_why() {
    let (built, pts) = line();
    let mut planner = Planner::new(built.graph.clone());
    let p = weights(&[(PrefId::Unpaved, 100), (PrefId::Residential, -50)]);
    let r = planner
        .route(&request(vec![wp(pts[0].0, pts[0].1), wp(pts[6].0, pts[6].1)], &p))
        .unwrap();
    let gravel = r
        .segments
        .iter()
        .find(|s| s.surface == kompass_core::route::SurfaceKind::Gravel)
        .unwrap();
    assert_eq!(gravel.why[0].id, PrefId::Unpaved);
    assert!(gravel.why[0].factor < 0.7);
    let street = &r.segments[0];
    assert_eq!(street.why[0].id, PrefId::Residential);
    assert!(street.why[0].factor > 1.0);
    // the detailed explanation on demand
    let ex = planner.explain(&p, &r.arcs).unwrap();
    assert_eq!(ex.len(), r.arcs.len());
    assert!(ex.iter().all(|x| x.cost.is_some()));
}

#[test]
fn the_compiled_profiles_are_cached() {
    let (built, pts) = line();
    let mut planner = Planner::new(built.graph.clone());
    let a = weights(&[(PrefId::Unpaved, 50)]);
    let mut renamed = a.clone();
    renamed.name = Some("same costs".into());
    let b = weights(&[(PrefId::Unpaved, 51)]);
    let req = |p: &Profile| request(vec![wp(pts[0].0, pts[0].1), wp(pts[6].0, pts[6].1)], p);
    planner.route(&req(&a)).unwrap();
    planner.route(&req(&renamed)).unwrap();
    planner.route(&req(&b)).unwrap();
    planner.route(&req(&a)).unwrap();
    assert_eq!(planner.compiles, 2);
}
