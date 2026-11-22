//! The profile, the cost and the route query on synthetic graphs: every preference and every limit
//! changes the chosen route in its direction, the class compile equals the direct one, A* equals
//! Dijkstra under random profiles (turn costs included), legs, snapping onto allowed ways, one-way,
//! the diff, the personal layer, the turns.
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
use kompass_core::route::{
    DiffRequest, ErrorCode, REUSE_PER_M, ReuseCost, RouteOptions, U_TURN_M, Waypoint, Zone,
};
use kompass_core::testing::{Built, GraphBuilder};
use kompass_core::turns::{line_turns, share_between};
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

/// The same profile with turns free (tests about preferences on a tiny detour the turn cost would
/// otherwise price out).
fn no_turns(mut p: Profile) -> Profile {
    p.turn_m = Some(0.0);
    p
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
    // 20 % both ways: full membership for every threshold of the family
    let steeper = EdgeAttrs {
        ascent_fwd_m: 90.0,
        ascent_bwd_m: 90.0,
        max_grade_fwd_pct: 20.0,
        max_grade_bwd_pct: 20.0,
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
        case(PrefId::RampsOver6, steeper, res),
        case(PrefId::RampsOver8, steeper, res),
        case(PrefId::RampsOver10, steeper, res),
        case(PrefId::RampsOver12, steeper, res),
        case(PrefId::RampsOver15, steeper, res),
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
    p.turn_m = match rng.below(4) {
        0 => Some(0.0),
        1 => None,
        _ => Some(rng.unit() * 300.0),
    };
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

/// Dijkstra from node to node over arcs, the reference with turns: a label per arc, every move
/// costs the next arc (`cost(arc, first move)`) plus its turn (`turn_m` per right-angle turn, the
/// first move's from `arrival` if given), no U-turns but as the first move.
fn dijkstra_turns(
    g: &Graph,
    planner: &Planner,
    turn_m: f32,
    s: NodeId,
    t: NodeId,
    arrival: Option<ArcId>,
    cost: &dyn Fn(ArcId, bool) -> f32,
) -> f32 {
    if s == t {
        return 0.0;
    }
    let mut scratch = Vec::new();
    let mut turn = |a: ArcId, b: ArcId| turn_m * share_between(g, planner.headings(), a, b, &mut scratch);
    let mut dist = vec![f32::INFINITY; g.arc_count()];
    let mut heap = BinaryHeap::new();
    for b in g.out_arcs(s) {
        let c = cost(b, true) + arrival.map_or(0.0, |x| turn(x, b));
        if c.is_finite() && c < dist[b as usize] {
            dist[b as usize] = c;
            heap.push(Reverse((c.to_bits(), b)));
        }
    }
    while let Some(Reverse((d, a))) = heap.pop() {
        let d = f32::from_bits(d);
        if d > dist[a as usize] {
            continue;
        }
        let v = g.head(a);
        if v == t {
            return d;
        }
        for b in g.out_arcs(v) {
            if b == a ^ 1 {
                continue;
            }
            let c = cost(b, false) + turn(a, b);
            if c.is_finite() && d + c < dist[b as usize] {
                dist[b as usize] = d + c;
                heap.push(Reverse(((d + c).to_bits(), b)));
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
                let want = dijkstra_turns(&g, &planner, p.turn_m(), s, t, None, &|a, _| costs[a as usize]);
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
                        // the turns counted again from the arcs: the same
                        let (n, tc) = line_turns(&g, planner.headings(), p.turn_m(), &r.arcs);
                        assert_eq!(n, r.summary.turns);
                        assert!((tc - r.summary.turn_cost).abs() <= 1e-3 * tc.max(1.0));
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
    // a waypoint back and forth: the second leg turns around, and then takes the gravel detour
    // (283 m) rather than ride 200 m of the line again
    let mut req = request(
        vec![
            wp(pts[1].0, pts[1].1),
            wp(pts[5].0, pts[5].1),
            wp(pts[2].0, pts[2].1),
        ],
        &p,
    );
    let back = planner.route(&req).unwrap();
    assert!(
        (back.summary.distance_m - 783.0).abs() < 2.0,
        "{}",
        back.summary.distance_m
    );
    assert!(
        (back.summary.reused_m - 100.0).abs() < 1.0,
        "{}",
        back.summary.reused_m
    );
    assert!((back.legs[1].reused_m - back.summary.reused_m).abs() < 1e-3);
    req.options.avoid_reuse = false;
    let free = planner.route(&req).unwrap();
    assert!((free.summary.distance_m - 700.0).abs() < 1.0);
    assert!((free.summary.reused_m - 300.0).abs() < 1.0);
    assert_eq!(free.summary.shape_cost, 0.0);
}

/// A rectangle 300 × 100 m: P0 (south-west), P1, P2, P3 anticlockwise, residential.
fn rectangle() -> (Built, [(f64, f64); 4]) {
    let mut b = GraphBuilder::new();
    let m = 1.0 / 111_195.0;
    let pts = [
        (0.07, 0.08),
        (0.07 + 300.0 * m, 0.08),
        (0.07 + 300.0 * m, 0.08 + 100.0 * m),
        (0.07, 0.08 + 100.0 * m),
    ];
    let n: Vec<usize> = pts.iter().map(|&(x, y)| b.node(x, y)).collect();
    for i in 0..4 {
        b.edge(n[i], n[(i + 1) % 4], residential());
    }
    (b.build(), pts)
}

#[test]
fn a_via_on_a_through_road_is_ridden_through() {
    let (built, pts) = rectangle();
    let mut planner = Planner::new(built.graph.clone());
    let p = Profile::default();
    let start = wp(pts[0].0, pts[0].1);
    // a via mid-edge on the south side, 200 m from the start; back to the start
    let via = wp(pts[0].0 + (pts[1].0 - pts[0].0) * 2.0 / 3.0, pts[0].1);
    let mut req = request(vec![start.clone(), via, start], &p);
    let r = planner.route(&req).unwrap();
    // on round the block (800 m) rather than back (400 m), nor on to the corner and back along
    // the south side (600 m: a U-turn at the corner is a U-turn too)
    assert!(
        (r.summary.distance_m - 800.0).abs() < 1.0,
        "{}",
        r.summary.distance_m
    );
    assert!(r.summary.reused_m < 1.0);
    assert_eq!(r.summary.shape_cost, 0.0);
    // the reuse penalty alone does not do it: back is 400 m + 200 m ridden again, < 800 m
    req.options.reuse_cost = Some(ReuseCost {
        per_m: 1.0,
        u_turn_m: 0.0,
    });
    let no_u = planner.route(&req).unwrap();
    assert!((no_u.summary.distance_m - 400.0).abs() < 1.0);
    assert!((no_u.summary.reused_m - 200.0).abs() < 1.0);
    assert!((no_u.summary.shape_cost - 200.0).abs() < 1.0);
    // and off: straight back
    req.options.reuse_cost = None;
    req.options.avoid_reuse = false;
    let off = planner.route(&req).unwrap();
    assert!((off.summary.distance_m - 400.0).abs() < 1.0);
    assert!((off.summary.reused_m - 200.0).abs() < 1.0);
    // the costs are the profile's (the length on these streets, and the turns), the shape costs
    // on top
    for x in [&r, &no_u, &off] {
        let legs: f32 = x.legs.iter().map(|l| l.cost).sum();
        assert!((legs - x.summary.cost).abs() < 1e-2);
        assert!(
            (x.summary.cost - x.summary.turn_cost - x.summary.distance_m).abs() < 1.0,
            "{} {}",
            x.summary.cost,
            x.summary.turn_cost
        );
    }
    // round the block: three corners at a right angle (the corners have two edges: no junctions,
    // free); back: a U-turn, at twice a turn
    assert_eq!(r.summary.turns, 0);
    assert_eq!(no_u.summary.turns, 1);
    assert!((no_u.summary.turn_cost - 2.0 * Profile::default().turn_m()).abs() < 1e-3);
    // a via near a corner: the U-turn is a full arc from the via's node
    let near = wp(pts[1].0, pts[1].1);
    let r = planner
        .route(&request(
            vec![wp(pts[0].0, pts[0].1), near, wp(pts[0].0, pts[0].1)],
            &p,
        ))
        .unwrap();
    assert!(
        (r.summary.distance_m - 800.0).abs() < 1.0,
        "{}",
        r.summary.distance_m
    );
}

#[test]
fn an_out_and_back_the_waypoints_ask_for_still_routes() {
    let (built, pts) = line();
    let mut planner = Planner::new(built.graph.clone());
    let p = Profile::default();
    // the via at the dead end (the line's east end), then back to the middle
    let r = planner
        .route(&request(
            vec![
                wp(pts[0].0, pts[0].1),
                wp(pts[6].0, pts[6].1),
                wp(pts[3].0, pts[3].1),
            ],
            &p,
        ))
        .unwrap();
    assert!(
        (r.summary.distance_m - 900.0).abs() < 1.0,
        "{}",
        r.summary.distance_m
    );
    assert!((r.summary.reused_m - 300.0).abs() < 1.0);
    // ridden again (300 m) and the U-turn at the dead end
    let want = 300.0 * REUSE_PER_M + U_TURN_M;
    assert!(
        (r.summary.shape_cost - want).abs() < 1.0,
        "{}",
        r.summary.shape_cost
    );
    assert!((r.legs[1].shape_cost - want).abs() < 1.0);
    // a via in the middle of a dead-end edge: back the same way, mid-edge
    let r = planner
        .route(&request(
            vec![
                wp(pts[4].0, pts[4].1),
                wp(pts[5].0 + (pts[6].0 - pts[5].0) * 0.5, pts[5].1),
                wp(pts[4].0, pts[4].1),
            ],
            &p,
        ))
        .unwrap();
    assert!(
        (r.summary.distance_m - 300.0).abs() < 1.0,
        "{}",
        r.summary.distance_m
    );
    assert!((r.summary.reused_m - 150.0).abs() < 1.0);
    assert!((r.summary.shape_cost - (150.0 * REUSE_PER_M + U_TURN_M)).abs() < 1.0);
    // the same point twice (a via on the start): nothing to ride, nothing ridden twice
    let r = planner
        .route(&request(
            vec![
                wp(pts[2].0, pts[2].1),
                wp(pts[2].0, pts[2].1),
                wp(pts[4].0, pts[4].1),
            ],
            &p,
        ))
        .unwrap();
    assert!((r.summary.distance_m - 200.0).abs() < 1.0);
    assert_eq!(r.summary.reused_m, 0.0);
    // out of range
    let mut req = request(vec![wp(pts[0].0, pts[0].1), wp(pts[6].0, pts[6].1)], &p);
    req.options.reuse_cost = Some(ReuseCost {
        per_m: -1.0,
        u_turn_m: 0.0,
    });
    assert_eq!(planner.route(&req).unwrap_err().code, ErrorCode::InvalidRequest);
}

#[test]
fn every_leg_is_the_cheapest_with_the_shape_costs() {
    let mut rng = Rng(0x0b5e_55ed_100b_5eed);
    let mut compared = 0;
    for _ in 0..6 {
        let built = random_grid(&mut rng, 10);
        let g = built.graph.clone();
        let mut planner = Planner::new(g.clone());
        for _ in 0..4 {
            let p = random_profile(&mut rng);
            let costs = planner.arc_costs(&p).unwrap().0.to_vec();
            for _ in 0..6 {
                let nodes: Vec<NodeId> = (0..4)
                    .map(|_| rng.below(g.node_count() as u64) as NodeId)
                    .collect();
                let wps: Vec<Waypoint> = nodes
                    .iter()
                    .map(|&v| {
                        let x = g.node(v);
                        wp(x.lng, x.lat)
                    })
                    .collect();
                let Ok(r) = planner.route(&request(wps, &p)) else {
                    continue;
                };
                if r.arcs.is_empty()
                    || !r.notes.is_empty()
                    || r.waypoints
                        .iter()
                        .any(|w| w.excluded_by.is_some() || w.distance_m >= 0.01)
                {
                    continue;
                }
                // the length ridden of each arc (a waypoint "at a node" may sit a sliver into an
                // edge: its first or last piece is that sliver)
                let geo = r.geometry.as_ref().unwrap();
                let ridden_m: Vec<f32> = (0..r.arcs.len())
                    .map(|i| {
                        let v0 = r.arc_vertex[i] as usize;
                        let end = r
                            .arc_vertex
                            .get(i + 1)
                            .map_or(geo.distance_m.len() - 1, |&v| v as usize);
                        geo.distance_m[end] - geo.distance_m[v0]
                    })
                    .collect();
                let piece = |i: usize| ridden_m[i] / g.length_m(arc_edge(r.arcs[i])).max(1e-3);
                // the route's cost is its arcs' compiled cost and its turns; the shape costs come on
                // top
                // (a waypoint repeated on a node: a piece of no length, whatever its arc costs)
                let arcs_cost: f32 = r
                    .arcs
                    .iter()
                    .enumerate()
                    .filter(|&(i, _)| piece(i) > 0.0)
                    .map(|(i, &a)| costs[a as usize] * piece(i))
                    .sum();
                let (_, turns) = line_turns(&g, planner.headings(), p.turn_m(), &r.arcs);
                assert!((turns - r.summary.turn_cost).abs() <= 1e-3 * turns.max(1.0));
                assert!(
                    (arcs_cost + turns - r.summary.cost).abs() <= 1e-3 * arcs_cost.max(1.0),
                    "{arcs_cost} + {turns} vs {}",
                    r.summary.cost
                );
                // each leg is the cheapest given the legs before it
                let mut ridden: Vec<EdgeId> = Vec::new();
                let mut reused = 0.0f32;
                let mut back: Option<ArcId> = None;
                let mut arrival: Option<ArcId> = None;
                for (l, leg) in r.legs.iter().enumerate() {
                    let range = leg.arcs[0] as usize..leg.arcs[1] as usize;
                    let leg_arcs = &r.arcs[range.clone()];
                    // the arcs ridden in full (not a sliver at a waypoint)
                    let full: Vec<ArcId> = range.filter(|&i| piece(i) > 0.5).map(|i| r.arcs[i]).collect();
                    let marked = ridden.clone();
                    let price = |a: ArcId, first: bool| {
                        let c = costs[a as usize];
                        let e = arc_edge(a);
                        let mut extra = 0.0;
                        if marked.contains(&e) {
                            extra += g.length_m(e) * REUSE_PER_M;
                        }
                        if first && back == Some(a) {
                            extra += U_TURN_M;
                        }
                        c + extra
                    };
                    let want =
                        dijkstra_turns(&g, &planner, p.turn_m(), nodes[l], nodes[l + 1], arrival, &price);
                    let got = leg.cost + leg.shape_cost;
                    assert!(
                        (got - want).abs() <= 1e-3 * want.max(1.0),
                        "leg {l}: {got} vs Dijkstra {want}"
                    );
                    let leg_reused: f32 = full
                        .iter()
                        .filter(|&&a| marked.contains(&arc_edge(a)))
                        .map(|&a| g.length_m(arc_edge(a)))
                        .sum();
                    assert!(
                        (leg_reused - leg.reused_m).abs() < 0.5,
                        "{leg_reused} {}",
                        leg.reused_m
                    );
                    reused += leg_reused;
                    ridden.extend(full.iter().map(|&a| arc_edge(a)));
                    if let Some(&a) = leg_arcs.last() {
                        back = Some(a ^ 1);
                        arrival = Some(a);
                    }
                    compared += 1;
                }
                assert!((reused - r.summary.reused_m).abs() < 1.0);
            }
        }
    }
    assert!(compared > 100, "only {compared} legs compared");
}

#[test]
fn leg_profiles_route_each_leg_their_way() {
    let (built, pts) = line();
    let mut planner = Planner::new(built.graph.clone());
    let gravel = no_turns(weights(&[(PrefId::Unpaved, 100)]));
    let plain = no_turns(Profile::default());
    let wps = vec![
        wp(pts[0].0, pts[0].1),
        wp(pts[6].0, pts[6].1),
        wp(pts[0].0, pts[0].1),
    ];
    let mut req = request(wps, &plain);
    // (the way back on the line itself: this is about leg profiles, not about riding again)
    req.options.avoid_reuse = false;
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
        .route(&request(wps, &no_turns(weights(&[(PrefId::Unpaved, 100)]))))
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
fn the_route_says_what_each_preference_touches() {
    let (built, pts) = line();
    let mut planner = Planner::new(built.graph.clone());
    // an explicit 0 is reported too: a row on screen at "no opinion" still learns what it would touch
    let p = no_turns(weights(&[
        (PrefId::Unpaved, 100),
        (PrefId::Track, 0),
        (PrefId::Forest, 50),
    ]));
    let r = planner
        .route(&request(vec![wp(pts[0].0, pts[0].1), wp(pts[6].0, pts[6].1)], &p))
        .unwrap();
    let keys: Vec<PrefId> = r.breakdown.touched.iter().map(|t| t.key).collect();
    assert_eq!(
        keys,
        [PrefId::Unpaved, PrefId::Track, PrefId::Forest],
        "catalogue order"
    );
    let gravel: f32 = r
        .segments
        .iter()
        .filter(|s| s.surface == kompass_core::route::SurfaceKind::Gravel)
        .map(|s| s.length_m)
        .sum();
    assert!(gravel > 200.0, "the route takes the gravel detour");
    let at = |id| r.breakdown.touched.iter().find(|t| t.key == id).unwrap();
    assert!((at(PrefId::Unpaved).length_m - gravel).abs() < 1.0);
    assert!((at(PrefId::Track).length_m - gravel).abs() < 1.0);
    assert!((at(PrefId::Unpaved).share - gravel / r.summary.distance_m).abs() < 1e-3);
    assert_eq!(at(PrefId::Forest).length_m, 0.0, "no forest on this route");
    // a profile without weights touches nothing, and says so with an empty list
    let blank = planner
        .route(&request(
            vec![wp(pts[0].0, pts[0].1), wp(pts[6].0, pts[6].1)],
            &Profile::default(),
        ))
        .unwrap();
    assert_eq!(blank.breakdown.touched.len(), 0);
}

#[test]
fn touches_is_the_costs_membership() {
    // on every arc, `touches` names exactly the active preferences whose membership in the cost's
    // breakdown is not 0
    let mut rng = Rng(0x7041_c4e5_0000_0061);
    for round in 0..6 {
        let built = random_grid(&mut rng, 8);
        let g = &built.graph;
        let personal = (round % 2 == 0).then(|| random_personal(&mut rng, g.edge_count()));
        let mut p = Profile::default();
        for &id in PrefId::ALL {
            p.set_weight(id, Some(if rng.below(2) == 0 { 60 } else { -60 }));
        }
        let m = CostModel::new(&p).unwrap();
        for a in 0..g.arc_count() {
            let a = a as ArcId;
            let mut hit = Vec::new();
            kompass_core::cost::touches(g, personal.as_ref(), a, PrefId::ALL, |id| hit.push(id));
            let want: Vec<PrefId> = m
                .breakdown(g, personal.as_ref(), a)
                .terms
                .iter()
                .filter(|t| t.membership != 0.0)
                .map(|t| t.id)
                .collect();
            assert_eq!(hit, want, "arc {a}");
        }
    }
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

// --- the cost debug queries (explain.rs) ---

/// The presets, a few extreme profiles and random ones.
fn explain_profiles(rng: &mut Rng) -> Vec<Profile> {
    let mut out: Vec<Profile> = kompass_core::presets().into_iter().map(|p| p.profile).collect();
    let mut all_max = Profile::default();
    let mut all_min = Profile::default();
    for &id in PrefId::ALL {
        all_max.set_weight(id, Some(100));
        all_min.set_weight(id, Some(-100));
    }
    all_min.bounds = Some(kompass_core::profile::Bounds {
        min_factor: 0.3,
        max_factor: 100.0,
    });
    out.extend([all_max, all_min]);
    out.extend((0..6).map(|_| random_profile(rng)));
    out
}

#[test]
fn the_explained_cost_is_the_routed_cost() {
    use kompass_core::cost::Role;
    use kompass_core::explain::{ClosedBy, EdgeSelection, ExplainEdgeRequest};
    let mut rng = Rng(0x5eed_cafe_f00d_0001);
    for round in 0..4 {
        let built = random_grid(&mut rng, 8);
        let g = built.graph.clone();
        let mut planner = Planner::new(g.clone());
        if round % 2 == 1 {
            planner
                .set_personal(Some(random_personal(&mut rng, g.edge_count())))
                .unwrap();
        }
        for p in explain_profiles(&mut rng) {
            let compiled = planner.arc_costs(&p).unwrap().0.to_vec();
            let costs = planner.edge_costs(&p, &EdgeSelection::All).unwrap();
            assert_eq!(costs.edges.len(), g.edge_count());
            let bounds = p.bounds();
            for e in 0..g.edge_count() as EdgeId {
                let x = planner
                    .explain_edge(&ExplainEdgeRequest {
                        overrides: None,
                        profile: p.clone(),
                        edge: e,
                    })
                    .unwrap();
                let len = g.length_m(e);
                for (dir, side) in [&x.along, &x.against].into_iter().enumerate() {
                    let a = (e << 1) | dir as u32;
                    assert_eq!(side.arc, a);
                    let c = compiled[a as usize];
                    let i = e as usize * 2 + dir;
                    assert_eq!(
                        side.closed_by.is_empty(),
                        c.is_finite(),
                        "arc {a} under {p:?}: {side:?}"
                    );
                    // the steps add up
                    let q: f32 = side
                        .preferences
                        .iter()
                        .filter(|t| matches!(t.role, Role::Quality | Role::GatedPenalty))
                        .map(|t| t.factor)
                        .product();
                    let bonus: f32 = side
                        .preferences
                        .iter()
                        .filter(|t| t.role == Role::GatedBonus)
                        .map(|t| t.factor)
                        .product();
                    assert!(
                        (q - side.quality).abs() <= 1e-4 * q,
                        "quality {q} {}",
                        side.quality
                    );
                    assert!((bonus - side.bonus).abs() <= 1e-4, "bonus {bonus} {}", side.bonus);
                    let raw = side.quality * (1.0 + (side.bonus - 1.0) * side.gate);
                    assert!((raw - side.raw_factor).abs() <= 1e-5 * raw);
                    assert!(
                        (side.raw_factor.clamp(bounds.min_factor, bounds.max_factor) - side.factor).abs()
                            < 1e-6
                    );
                    assert_eq!(
                        side.clamp.is_some(),
                        side.raw_factor < bounds.min_factor || side.raw_factor > bounds.max_factor
                    );
                    let extra: f32 = side.additive.iter().map(|t| t.metres).sum();
                    assert!((extra - side.extra_m).abs() <= 1e-3);
                    for t in &side.preferences {
                        assert_eq!(t.weight, i32::from(p.weight(t.id).unwrap()), "{t:?}");
                    }
                    if c.is_finite() {
                        // exactly the router's cost, and the breakdown recomputes it
                        assert_eq!(side.cost, Some(c));
                        let again = len * side.factor + side.extra_m;
                        assert!(
                            (again - c).abs() <= 1e-4 * c.max(1.0),
                            "arc {a}: {again} vs {c} under {p:?}"
                        );
                        assert!(
                            (costs.factor[i] - side.factor).abs() <= 1e-3 * side.factor,
                            "arc {a}"
                        );
                        assert!((costs.cost_per_m[i] * len.max(0.1) - c).abs() <= 1e-4 * c.max(1.0));
                    } else {
                        assert_eq!(side.cost, None);
                        assert_eq!(costs.factor[i], 0.0);
                        assert_eq!(costs.cost_per_m[i], 0.0);
                    }
                }
                let both_closed = !x.along.closed_by.is_empty() && !x.against.closed_by.is_empty();
                let code = costs.closed[e as usize];
                if both_closed {
                    let first = x.along.closed_by[0].by;
                    assert_eq!(code, first.code(), "edge {e}");
                    assert_ne!(first, ClosedBy::Oneway);
                    assert_eq!(ClosedBy::ALL[code as usize - 1], first);
                } else {
                    assert_eq!(code, 0, "edge {e}");
                }
            }
        }
    }
}

#[test]
fn closed_edges_name_every_limit_that_closes_them() {
    use kompass_core::explain::{ClosedBy, EdgeSelection, ExplainEdgeRequest};
    for (id, value, top, scale) in limit_cases() {
        let d = diamond(top, HALF_M / 1.1, residential(), HALF_M * scale, None);
        let mut planner = Planner::new(d.built.graph.clone());
        let mut p = Profile::default();
        p.limits.insert(id, value);
        let e = d.built.edge(d.top[0]);
        let x = planner
            .explain_edge(&ExplainEdgeRequest {
                overrides: None,
                profile: p.clone(),
                edge: e,
            })
            .unwrap();
        let by: Vec<ClosedBy> = x.along.closed_by.iter().map(|c| c.by).collect();
        assert_eq!(
            by,
            vec![ClosedBy::from(kompass_core::cost::Exclusion::Limit(id))],
            "{id}"
        );
        assert_eq!(by[0].limit(), Some(id));
        assert_eq!(by[0].id(), id.id());
        assert!(x.along.cost.is_none() && x.against.cost.is_none());
        let costs = planner.edge_costs(&p, &EdgeSelection::List(vec![e])).unwrap();
        assert_eq!(costs.closed, vec![by[0].code()], "{id}");
        assert_eq!(costs.factor, vec![0.0, 0.0]);
    }
    // several at once, each with the attribute that triggers it
    let private_main = EdgeAttrs {
        highway: Highway::Secondary,
        bike_access: BikeAccess::Private,
        oneway: Oneway::Along,
        ..residential()
    };
    let d = diamond(private_main, HALF_M, residential(), HALF_M, None);
    let mut planner = Planner::new(d.built.graph.clone());
    let mut p = Profile::default();
    p.limits.insert(LimitId::NoMainRoads, LimitValue::Flag(true));
    p.limits.insert(LimitId::LegalOnly, LimitValue::Flag(true));
    let x = planner
        .explain_edge(&ExplainEdgeRequest {
            overrides: None,
            profile: p.clone(),
            edge: d.built.edge(d.top[0]),
        })
        .unwrap();
    let words: Vec<String> = x
        .against
        .closed_by
        .iter()
        .map(kompass_core::explain::describe_closure)
        .collect();
    assert_eq!(
        words,
        [
            "no_main_roads (highway = secondary)",
            "legal_only (bike_access = private)",
            "oneway (oneway_bike = along)"
        ]
    );
    assert_eq!(x.along.closed_by.len(), 2);
    // without the limits only the one-way closes it, one way
    let x = planner
        .explain_edge(&ExplainEdgeRequest {
            overrides: None,
            profile: Profile::default(),
            edge: d.built.edge(d.top[0]),
        })
        .unwrap();
    assert!(x.along.closed_by.is_empty() && x.along.cost.is_some());
    assert_eq!(x.against.closed_by.len(), 1);
    let attr = |k: &str| {
        x.attributes
            .iter()
            .find(|a| a.attribute == k)
            .unwrap()
            .value
            .clone()
    };
    assert_eq!(
        attr("highway"),
        Some(kompass_core::explain::AttrValue::Text("secondary".into()))
    );
    assert_eq!(attr("maxspeed_kmh"), None);
    // a bicycle ban, whatever the profile
    let banned = EdgeAttrs {
        bike_access: BikeAccess::No,
        ..residential()
    };
    let d = diamond(banned, HALF_M, residential(), HALF_M, None);
    let mut planner = Planner::new(d.built.graph.clone());
    let costs = planner
        .edge_costs(
            &Profile::default(),
            &EdgeSelection::List(vec![d.built.edge(d.top[0])]),
        )
        .unwrap();
    assert_eq!(costs.closed, vec![ClosedBy::NoBikes.code()]);
    assert!(
        planner
            .edge_costs(&Profile::default(), &EdgeSelection::List(vec![99]))
            .is_err()
    );
}

#[test]
fn the_clamp_and_the_gate_are_explained() {
    use kompass_core::cost::{Clamp, Role};
    use kompass_core::explain::ExplainEdgeRequest;
    let gravel = EdgeAttrs {
        highway: Highway::Track,
        surface: SurfaceClass::Gravel,
        forest: 1.0,
        ..EdgeAttrs::default()
    };
    let d = diamond(gravel, HALF_M, residential(), HALF_M, None);
    let mut planner = Planner::new(d.built.graph.clone());
    let e = d.built.edge(d.top[0]);
    let mut p = weights(&[
        (PrefId::Unpaved, 100),
        (PrefId::Track, 100),
        (PrefId::Forest, 100),
        (PrefId::Main, -50),
    ]);
    let x = planner
        .explain_edge(&ExplainEdgeRequest {
            overrides: None,
            profile: p.clone(),
            edge: e,
        })
        .unwrap();
    let s = &x.along;
    // unpaved × track × forest at +100 (forest is gated: the quality is fine, so it counts in
    // full), below 0.5: clamped
    let bonus = |id: PrefId| {
        kompass_core::catalogue()
            .preferences
            .iter()
            .find(|m| m.id == id)
            .unwrap()
            .max_bonus
    };
    let want = bonus(PrefId::Unpaved) * bonus(PrefId::Track) * bonus(PrefId::Forest);
    assert_eq!(s.clamp, Some(Clamp::Min));
    assert!((s.factor - 0.5).abs() < 1e-6);
    assert!((s.gate - 1.0).abs() < 1e-6);
    let forest = s.preferences.iter().find(|t| t.id == PrefId::Forest).unwrap();
    assert_eq!(forest.role, Role::GatedBonus);
    let main = s.preferences.iter().find(|t| t.id == PrefId::Main).unwrap();
    assert!((main.factor - 1.0).abs() < 1e-6 && main.membership == 0.0 && main.weight == -50);
    assert!(
        want < 0.5 && (s.raw_factor - want).abs() < 1e-3,
        "{}",
        s.raw_factor
    );
    // a bad way: the gate closes and the forest bonus no longer counts
    p.set_weight(PrefId::Unpaved, Some(-100));
    p.set_weight(PrefId::Track, None);
    let x = planner
        .explain_edge(&ExplainEdgeRequest {
            profile: p,
            edge: e,
            overrides: None,
        })
        .unwrap();
    assert!(x.along.quality >= 2.2 && x.along.gate == 0.0);
    assert!((x.along.raw_factor - x.along.quality).abs() < 1e-5);
}

/// The explanation of the top way's first arc (uphill: `grade_up`, downhill: `grade_down`).
fn ramp_terms(grade_up: f32, grade_down: f32, p: &Profile) -> kompass_core::explain::ArcCostExplanation {
    use kompass_core::explain::ExplainEdgeRequest;
    let way = EdgeAttrs {
        // a steady climb: the taming cap (2.5 × average + 5) stays above the grades
        ascent_fwd_m: 0.08 * HALF_M,
        ascent_bwd_m: 0.08 * HALF_M,
        max_grade_fwd_pct: grade_up,
        max_grade_bwd_pct: grade_down,
        ..residential()
    };
    let d = diamond(way, HALF_M, residential(), HALF_M, None);
    let mut planner = Planner::new(d.built.graph.clone());
    let edge = d.built.edge(d.top[0]);
    planner
        .explain_edge(&ExplainEdgeRequest {
            overrides: None,
            profile: p.clone(),
            edge,
        })
        .unwrap()
        .along
}

#[test]
fn the_grade_thresholds_ramp_up_stack_and_clamp() {
    use kompass_core::cost::grade_ramp;
    let penalty = |id: PrefId| {
        kompass_core::catalogue()
            .preferences
            .iter()
            .find(|m| m.id == id)
            .unwrap()
            .max_penalty
    };
    let term = |x: &kompass_core::explain::ArcCostExplanation, id: PrefId| {
        *x.preferences.iter().find(|t| t.id == id).unwrap()
    };
    // the ramp: 0 at the threshold, a third per point, 1 three points above; descents half
    let ten = weights(&[(PrefId::RampsOver10, -100)]);
    for (up, down, m) in [
        (8.0, 0.0, 0.0),
        (10.0, 0.0, 0.0),
        (11.0, 0.0, 1.0 / 3.0),
        (12.0, 0.0, 2.0 / 3.0),
        (13.0, 0.0, 1.0),
        (19.0, 0.0, 1.0),
        (0.0, 13.0, 0.5),
        (0.0, 16.0, 1.0),
        (11.0, 13.0, 0.5),
    ] {
        // quantised to fifteenths like every membership (a half rounds up to 8/15)
        let m: f32 = ((m * 15.0_f32) + 15.5).floor() / 15.0 - 1.0;
        let x = ramp_terms(up, down, &ten);
        let t = term(&x, PrefId::RampsOver10);
        assert!((t.membership - m).abs() < 1e-6, "{up}/{down}: {}", t.membership);
        let want = penalty(PrefId::RampsOver10).powf(m);
        assert!(
            (t.factor - want).abs() < 1e-4,
            "{up}/{down}: {} vs {want}",
            t.factor
        );
    }
    let r = grade_ramp(PrefId::RampsOver15).unwrap();
    assert!((r.from_pct - 15.0).abs() < 1e-6 && (r.full_pct - 18.0).abs() < 1e-6);
    // stacking: 8 % mildly and 12 % strongly multiply; on 14 % both act, on 10 % only 8 %
    let both = weights(&[(PrefId::RampsOver8, -40), (PrefId::RampsOver12, -100)]);
    let x = ramp_terms(14.0, 0.0, &both);
    let (a, b) = (term(&x, PrefId::RampsOver8), term(&x, PrefId::RampsOver12));
    assert!((a.factor - 4f32.powf(0.4)).abs() < 1e-4 && (b.factor - 4f32.powf(2.0 / 3.0)).abs() < 1e-3);
    assert!((x.quality - a.factor * b.factor).abs() < 1e-4);
    let x = ramp_terms(10.0, 0.0, &both);
    assert!(
        term(&x, PrefId::RampsOver8).factor > 1.0
            && (term(&x, PrefId::RampsOver12).factor - 1.0).abs() < 1e-6
    );
    // with `steep` too, and the clamp caps the product
    let mut all = weights(&[(PrefId::Steep, -100)]);
    for id in [
        PrefId::RampsOver6,
        PrefId::RampsOver8,
        PrefId::RampsOver10,
        PrefId::RampsOver12,
        PrefId::RampsOver15,
    ] {
        all.set_weight(id, Some(-100));
    }
    let x = ramp_terms(25.0, 0.0, &all);
    assert!(x.quality > 1000.0, "{}", x.quality);
    assert!((x.factor - all.bounds().max_factor).abs() < 1e-4);
    assert_eq!(x.clamp, Some(kompass_core::cost::Clamp::Max));
    // seeking one: a mild bonus, quality like `steep`
    let x = ramp_terms(20.0, 0.0, &weights(&[(PrefId::RampsOver12, 100)]));
    assert!((term(&x, PrefId::RampsOver12).factor - 0.85).abs() < 1e-4);
}

#[test]
fn steep_keeps_its_ramp() {
    // `steep` is now one ramp of the grade family: the same membership as its old formula
    // (0 at 8 %, 1 at 16 %, downhill at half the rate), at every whole grade
    let steep = weights(&[(PrefId::Steep, -100)]);
    for up in 0..=25u8 {
        for down in (0..=25u8).step_by(3) {
            let (u, d) = (f32::from(up), f32::from(down));
            let old = ((u - 8.0) / 8.0).max(0.5 * (d - 8.0) / 8.0).clamp(0.0, 1.0);
            let old = ((old * 15.0) + 0.5).floor() / 15.0;
            let x = ramp_terms(u, d, &steep);
            let t = x.preferences.iter().find(|t| t.id == PrefId::Steep).unwrap();
            assert!(
                (t.membership - old).abs() < 1e-6,
                "{up}/{down}: {} vs {old}",
                t.membership
            );
        }
    }
    // the shipped presets name none of the new thresholds: their costs are unchanged
    for p in kompass_core::presets() {
        for id in p.profile.weights.keys() {
            assert!(!id.id().starts_with("ramps_over_"), "{}: {id}", p.id);
        }
    }
}

#[test]
fn compare_says_why_not_the_other_way() {
    let (built, pts) = line();
    let mut planner = Planner::new(built.graph.clone());
    let wps = vec![wp(pts[0].0, pts[0].1), wp(pts[6].0, pts[6].1)];
    let plain = Profile::default();
    let a = planner.route(&request(wps.clone(), &plain)).unwrap();
    // forced over the gravel detour: through a via on it
    let up = (pts[3].0, 0.08 + 100.0 / 111_195.0);
    let via = vec![wps[0].clone(), wp(up.0, up.1), wps[1].clone()];
    let b = planner.route(&request(via, &plain)).unwrap();
    let c = planner
        .compare(&kompass_core::explain::CompareRequest {
            overrides: None,
            profile: weights(&[(PrefId::Unpaved, -60)]),
            a: a.arcs.clone(),
            b: b.arcs.clone(),
        })
        .unwrap();
    assert_eq!(c.stretches.len(), 1, "{c:?}");
    let s = &c.stretches[0];
    assert!(s.cost_delta > 0.0 && s.length_delta_m > 0.0);
    assert!((s.cost_delta - (s.b.cost - s.a.cost)).abs() < 1e-3);
    // b is dearer for the gravel: unpaved is its strongest reason, a has none
    assert_eq!(s.b.why[0].id, PrefId::Unpaved);
    assert!(s.b.why[0].factor > 1.0);
    assert_eq!(s.a.why, vec![]);
    assert_eq!(s.b.ways[0].key, kompass_core::cost::WayKind::Track);
    assert!(s.b.factor > s.a.factor);
    // the totals cover the whole routes, the shared part included
    assert!((c.a.cost + s.cost_delta - c.b.cost).abs() < 1e-2);
    assert!((c.shared_m + s.a.span.length_m - c.a.span.length_m).abs() < 1.0);
    // a closed arc counts at max_factor and is named
    let mut paved = Profile::default();
    paved.limits.insert(LimitId::PavedOnly, LimitValue::Flag(true));
    let c = planner
        .compare(&kompass_core::explain::CompareRequest {
            overrides: None,
            profile: paved,
            a: a.arcs.clone(),
            b: b.arcs.clone(),
        })
        .unwrap();
    let side = &c.stretches[0].b;
    assert_eq!(side.closed[0].by, kompass_core::explain::ClosedBy::PavedOnly);
    assert!((side.closed[0].length_m - side.span.length_m).abs() < 1e-3);
    assert!((side.factor - 20.0).abs() < 1e-4);
}

#[test]
fn edge_costs_by_bbox_cover_the_box() {
    use kompass_core::explain::EdgeSelection;
    let mut rng = Rng(77);
    let built = random_grid(&mut rng, 8);
    let g = &built.graph;
    let mut planner = Planner::new(g.clone());
    let p = Profile::default();
    let step = 200.0 / 111_195.0;
    let bbox = [0.07 + step, 0.07 + step, 0.07 + 3.5 * step, 0.07 + 2.5 * step];
    let costs = planner.edge_costs(&p, &EdgeSelection::Bbox(bbox)).unwrap();
    assert!(costs.edges.windows(2).all(|w| w[0] < w[1]), "ascending, once");
    assert_eq!(costs.factor.len(), costs.edges.len() * 2);
    let inside = |v: NodeId| {
        let n = g.node(v);
        n.lng >= bbox[0] && n.lng <= bbox[2] && n.lat >= bbox[1] && n.lat <= bbox[3]
    };
    let want: Vec<EdgeId> = (0..g.edge_count() as EdgeId)
        .filter(|&e| inside(g.from(e)) && inside(g.to(e)))
        .collect();
    assert_ne!(want, Vec::<EdgeId>::new());
    for e in want {
        assert!(costs.edges.contains(&e), "edge {e} is in the box");
    }
    assert!(costs.edges.len() < g.edge_count() / 2, "not the whole graph");
    let outside = planner
        .edge_costs(&p, &EdgeSelection::Bbox([1.0, 1.0, 1.1, 1.1]))
        .unwrap();
    assert_eq!(outside.edges, Vec::<EdgeId>::new());
    assert!(
        planner
            .edge_costs(&p, &EdgeSelection::Bbox([f64::NAN, 0.0, 1.0, 1.0]))
            .is_err()
    );
}

/// A paved farm track (car-free, grade 1) against a compacted gravel track: Gravel explorer still
/// prefers the gravel, but not at any length. Its stacked surface bonuses (`unpaved`, `fine_gravel`,
/// `track`) used to put a compacted track at the `min_factor` clamp (0.50 against 0.87, a 1.7× detour
/// for gravel); on the rider's own rides that sent it off the paved tracks they ride (route-quality
/// report of #40). Now gravel is worth a detour up to about 1.35×.
#[test]
fn gravel_explorer_takes_gravel_but_not_at_any_length() {
    let paved_track = EdgeAttrs {
        highway: Highway::Track,
        tracktype: Tracktype::Grade1,
        surface: SurfaceClass::PavedSmooth,
        ..EdgeAttrs::default()
    };
    let gravel_track = EdgeAttrs {
        highway: Highway::Track,
        tracktype: Tracktype::Grade2,
        surface: SurfaceClass::Compacted,
        ..EdgeAttrs::default()
    };
    let gravel = kompass_core::presets::preset("gravel_explorer").unwrap().profile;
    let takes_gravel = |detour: f32| {
        let d = diamond(gravel_track, HALF_M * detour, paved_track, HALF_M, None);
        takes_top(&d, &gravel, None)
    };
    assert!(takes_gravel(1.25), "gravel 1.25× longer: still the gravel");
    assert!(!takes_gravel(1.45), "gravel 1.45× longer: the paved track");
}

/// A cycle path right beside a primary road and a quieter one away from roads, 15 % longer: the
/// roadside path's traffic comes from the road alongside (`road_near_traffic` × `road_near_share` ×
/// 0.3), so seeking quiet now moves the route off it; without the column (an older build) it stays.
#[test]
fn quiet_moves_the_route_off_a_roadside_path() {
    use kompass_core::explain::{ExplainEdgeRequest, TrafficFrom};
    let path = |road_near: f32, road_near_traffic: f32| EdgeAttrs {
        highway: Highway::Cycleway,
        surface: SurfaceClass::PavedSmooth,
        cycleway: CyclewayKind::SeparatePath,
        road_near,
        road_near_traffic,
        ..EdgeAttrs::default()
    };
    // beside a primary at 80 km/h (level 0.9 × 0.91 ≈ 0.8) for its whole length
    let roadside = path(1.0, 0.8);
    let away = path(0.0, 0.0);
    let gravel = kompass_core::presets::preset("gravel_explorer").unwrap().profile;
    let d = diamond(roadside, HALF_M, away, HALF_M * 1.15, None);
    assert!(
        takes_top(&d, &Profile::default(), None),
        "neutral: the shorter roadside path"
    );
    assert!(
        !takes_top(&d, &gravel, None),
        "Gravel explorer (quiet 70) leaves the roadside path"
    );
    assert!(
        !takes_top(&d, &weights(&[(PrefId::Quiet, 50)]), None),
        "quiet 50 alone does too"
    );
    // the same ways from an older build: no traffic beside them, the shorter way wins
    let old = diamond(path(1.0, 0.0), HALF_M, away, HALF_M * 1.15, None);
    assert!(takes_top(&old, &gravel, None));

    // the membership, as the cost debug view explains it
    let mut planner = Planner::new(d.built.graph.clone());
    let explain = |planner: &mut Planner, h: usize| {
        planner
            .explain_edge(&ExplainEdgeRequest {
                overrides: None,
                profile: weights(&[(PrefId::Quiet, 100)]),
                edge: d.built.edge(h),
            })
            .unwrap()
    };
    let x = explain(&mut planner, d.top[0]);
    assert_eq!(x.traffic_from, TrafficFrom::Alongside);
    assert!((x.traffic - 0.24).abs() < 1e-6, "0.8 × 1 × 0.3: {}", x.traffic);
    let quiet = x
        .along
        .preferences
        .iter()
        .find(|p| p.id == PrefId::Quiet)
        .unwrap();
    assert!(
        (quiet.membership + 4.0 / 15.0).abs() < 1e-6,
        "quantised: {}",
        quiet.membership
    );
    assert!(
        quiet.factor > 1.4 && quiet.factor < 1.5,
        "4^(4/15): {}",
        quiet.factor
    );
    let attr = x
        .attributes
        .iter()
        .find(|a| a.attribute == "road_near_traffic")
        .unwrap();
    assert_eq!(attr.value, Some(kompass_core::explain::AttrValue::Number(80.0)));
    let y = explain(&mut planner, d.bottom[0]);
    assert_eq!(y.traffic_from, TrafficFrom::Way);
    assert!(y.traffic.abs() < 1e-6);
}

/// A road keeps its own traffic level: the roads beside it never make it quieter, and a louder one
/// within 20 m makes a quiet road count as loud as a path beside that road would.
#[test]
fn roads_keep_their_own_traffic_level() {
    use kompass_core::explain::{ExplainEdgeRequest, TrafficFrom};
    let primary = EdgeAttrs {
        highway: Highway::Primary,
        surface: SurfaceClass::PavedSmooth,
        maxspeed_kmh: Some(100),
        road_near: 1.0,
        road_near_traffic: 0.9,
        ..EdgeAttrs::default()
    };
    let service_beside = EdgeAttrs {
        highway: Highway::Service,
        surface: SurfaceClass::PavedSmooth,
        road_near: 1.0,
        road_near_traffic: 0.9,
        ..EdgeAttrs::default()
    };
    let d = diamond(primary, HALF_M, service_beside, HALF_M, None);
    let mut planner = Planner::new(d.built.graph.clone());
    let explain = |planner: &mut Planner, h: usize| {
        planner
            .explain_edge(&ExplainEdgeRequest {
                overrides: None,
                profile: weights(&[(PrefId::Quiet, 100)]),
                edge: d.built.edge(h),
            })
            .unwrap()
    };
    let road = explain(&mut planner, d.top[0]);
    assert_eq!(road.traffic_from, TrafficFrom::Way);
    assert!((road.traffic - 0.9).abs() < 1e-6, "{}", road.traffic);
    let service = explain(&mut planner, d.bottom[0]);
    assert_eq!(service.traffic_from, TrafficFrom::Alongside);
    assert!(
        (service.traffic - 0.28).abs() < 1e-6,
        "0.9 is 14/15: {}",
        service.traffic
    );
}

#[test]
fn a_turn_cost_keeps_the_route_off_a_short_excursion() {
    // the line's gravel detour leaves the road at 45° and rejoins it at 45°: worth taking for a
    // strong gravel preference when turns are free, not when turning costs enough
    let (built, pts) = line();
    let mut planner = Planner::new(built.graph.clone());
    let wps = vec![wp(pts[0].0, pts[0].1), wp(pts[6].0, pts[6].1)];
    let gravel = |turn_m: f32| {
        let mut p = weights(&[(PrefId::Unpaved, 100)]);
        p.turn_m = Some(turn_m);
        p
    };
    let unpaved = |r: &kompass_core::RouteResult| r.summary.unpaved_share * r.summary.distance_m;
    let free = planner.route(&request(wps.clone(), &gravel(0.0))).unwrap();
    assert!(unpaved(&free) > 200.0, "{}", unpaved(&free));
    assert_eq!((free.summary.turns, free.summary.turn_cost), (0, 0.0));
    // the default: still worth it here, and the turns are counted (leaving the road: half a turn
    // at least; back onto it at 45°: a quarter)
    let def = planner
        .route(&request(wps.clone(), &gravel(Profile::default().turn_m())))
        .unwrap();
    assert!(unpaved(&def) > 200.0);
    assert_eq!(def.summary.turns, 2);
    let want = 0.75 * Profile::default().turn_m();
    assert!(
        (def.summary.turn_cost - want).abs() < 0.05 * want,
        "{}",
        def.summary.turn_cost
    );
    assert!((def.legs[0].turn_cost - def.summary.turn_cost).abs() < 1e-3);
    assert_eq!(def.legs[0].turns, 2);
    // a strong turn cost: straight on along the road
    let strong = planner.route(&request(wps.clone(), &gravel(100.0))).unwrap();
    assert!(unpaved(&strong) < 1.0, "{}", unpaved(&strong));
    assert_eq!(strong.summary.turns, 0);
    // why not the excursion: by the arcs alone it is cheaper, the two turns make it dearer
    let c = planner
        .compare(&kompass_core::explain::CompareRequest {
            profile: gravel(100.0),
            a: strong.arcs.clone(),
            b: free.arcs.clone(),
            overrides: None,
        })
        .unwrap();
    assert_eq!(c.stretches.len(), 1, "{c:?}");
    let s = &c.stretches[0];
    assert_eq!((s.a.turns, s.b.turns), (0, 2));
    assert!((s.b.turn_cost - 75.0).abs() < 4.0, "{}", s.b.turn_cost);
    assert!(s.cost_delta > 0.0);
    assert!(s.b.cost - s.b.turn_cost < s.a.cost, "the arcs alone are cheaper");
    assert!((c.a.cost + s.cost_delta - c.b.cost).abs() < 1e-2);
    assert_eq!(c.b.turns, 2);
}
