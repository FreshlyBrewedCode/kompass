//! A plan's edge overrides (avoid, prefer, allow) on synthetic graphs: each kind moves the route its
//! way, what still holds (a bicycle ban, one-way), a stop on an avoided way, every leg, the A* bound
//! with overrides cheaper than the compile (against Dijkstra), the explanation and the comparison
//! agree with the router, and the run of edges between junctions.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::many_single_char_names,
    clippy::too_many_lines,
    reason = "tiny test graphs and test data"
)]

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use kompass_core::attrs::{BikeAccess, EdgeAttrs, Highway, Oneway, SurfaceClass};
use kompass_core::cost::CostModel;
use kompass_core::explain::{CompareRequest, ExplainEdgeRequest};
use kompass_core::graph::{arc, arc_edge};
use kompass_core::overrides::{AVOID_M, EdgeOverride, OverrideKind, Overrides};
use kompass_core::route::{ErrorCode, RouteOptions, RouteResult, Waypoint};
use kompass_core::testing::{Built, GraphBuilder};
use kompass_core::turns::share_between;
use kompass_core::{EdgeId, Graph, LimitId, LimitValue, NodeId, Planner, PrefId, Profile, RouteRequest};

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
}

fn wp(lon: f64, lat: f64) -> Waypoint {
    Waypoint { lon, lat, name: None }
}

fn request(waypoints: Vec<Waypoint>, profile: &Profile, overrides: &[EdgeOverride]) -> RouteRequest {
    RouteRequest {
        waypoints,
        profile: profile.clone(),
        leg_profiles: None,
        options: RouteOptions::default(),
        overrides: (!overrides.is_empty()).then(|| overrides.to_vec()),
        via_zones: None,
        avoid_zones: None,
        sketch: None,
    }
}

fn residential() -> EdgeAttrs {
    EdgeAttrs {
        highway: Highway::Residential,
        surface: SurfaceClass::PavedSmooth,
        ..EdgeAttrs::default()
    }
}

fn gravel_track() -> EdgeAttrs {
    EdgeAttrs {
        highway: Highway::Track,
        surface: SurfaceClass::Gravel,
        ..EdgeAttrs::default()
    }
}

/// Two ways from S to T, two edges each: the top one with `top` attributes and `top_len` metres per
/// half, the bottom one residential at 650 m per half.
struct Diamond {
    built: Built,
    s: (f64, f64),
    t: (f64, f64),
    top: [EdgeId; 2],
    bottom: [EdgeId; 2],
}

fn diamond(top: EdgeAttrs, top_len: f32) -> Diamond {
    let mut b = GraphBuilder::new();
    let (s, t) = ((0.075, 0.08), (0.085, 0.08));
    let sn = b.node(s.0, s.1);
    let up = b.node(0.08, 0.0802);
    let tn = b.node(t.0, t.1);
    let down = b.node(0.08, 0.0798);
    let with = |a: EdgeAttrs, len: f32| EdgeAttrs { length_m: len, ..a };
    let t0 = b.edge(sn, up, with(top, top_len));
    let t1 = b.edge(up, tn, with(top, top_len));
    let b0 = b.edge(sn, down, with(residential(), 650.0));
    let b1 = b.edge(down, tn, with(residential(), 650.0));
    let built = b.build();
    Diamond {
        top: [built.edge(t0), built.edge(t1)],
        bottom: [built.edge(b0), built.edge(b1)],
        built,
        s,
        t,
    }
}

fn each(edges: &[EdgeId], kind: OverrideKind) -> Vec<EdgeOverride> {
    edges.iter().map(|&edge| EdgeOverride { edge, kind }).collect()
}

fn rides(r: &RouteResult, e: EdgeId) -> bool {
    r.arcs.iter().any(|&a| arc_edge(a) == e)
}

fn route(d: &Diamond, p: &Profile, o: &[EdgeOverride]) -> RouteResult {
    let mut planner = Planner::new(d.built.graph.clone());
    planner
        .route(&request(vec![wp(d.s.0, d.s.1), wp(d.t.0, d.t.1)], p, o))
        .unwrap()
}

#[test]
fn avoid_moves_the_route_off_the_way_unless_there_is_no_other() {
    let d = diamond(residential(), 600.0);
    let plain = Profile::default();
    let r = route(&d, &plain, &[]);
    assert!(rides(&r, d.top[0]) && r.overrides.is_empty());
    // one edge of the top way avoided: the bottom one, in either direction
    let avoid = each(&d.top[..1], OverrideKind::Avoid);
    let r = route(&d, &plain, &avoid);
    assert!(rides(&r, d.bottom[0]) && !rides(&r, d.top[0]) && !rides(&r, d.top[1]));
    assert!(r.overrides.is_empty() && r.summary.override_cost.abs() < 1e-3);
    let mut planner = Planner::new(d.built.graph.clone());
    let back = planner
        .route(&request(vec![wp(d.t.0, d.t.1), wp(d.s.0, d.s.1)], &plain, &avoid))
        .unwrap();
    assert!(!rides(&back, d.top[0]));
    // everything avoided: it still routes (the penalty is finite), the cheaper way, and says so
    let all = each(
        &[d.top[0], d.top[1], d.bottom[0], d.bottom[1]],
        OverrideKind::Avoid,
    );
    let r = route(&d, &plain, &all);
    assert!(rides(&r, d.top[0]));
    assert_eq!(r.overrides.len(), 2);
    assert!(r.overrides.iter().all(|u| u.kind == OverrideKind::Avoid));
    assert!((r.summary.override_cost - 2.0 * AVOID_M).abs() < 1.0);
    // the profile's cost stays the line's own
    assert!((r.summary.cost - route(&d, &plain, &[]).summary.cost).abs() < 0.1);
    assert!(
        r.notes.iter().any(|n| n.contains("this plan avoids")),
        "{:?}",
        r.notes
    );
}

#[test]
fn a_stop_on_an_avoided_way_still_routes_and_leaves_by_the_nearer_end() {
    let d = diamond(residential(), 600.0);
    let g = &d.built.graph;
    // a stop a quarter along the top way's first edge (nearer S)
    let (a, b) = (g.node(g.from(d.top[0])), g.node(g.to(d.top[0])));
    let at = wp(a.lng + (b.lng - a.lng) * 0.25, a.lat + (b.lat - a.lat) * 0.25);
    let avoid = each(&d.top, OverrideKind::Avoid);
    let mut planner = Planner::new(g.clone());
    let r = planner
        .route(&request(vec![at, wp(d.t.0, d.t.1)], &Profile::default(), &avoid))
        .unwrap();
    assert_eq!(r.waypoints[0].edge, d.top[0]);
    // off it towards S and round the bottom, not on along the top
    assert!(rides(&r, d.bottom[0]) && !rides(&r, d.top[1]));
    let on_it: f32 = r.overrides.iter().map(|u| u.length_m).sum();
    assert!((on_it - 0.25 * g.length_m(d.top[0])).abs() < 5.0, "{on_it}");
    assert!((r.summary.override_cost - 0.25 * AVOID_M).abs() < 0.03 * AVOID_M);
}

#[test]
fn prefer_counts_at_the_detour_limit_and_lifts_limits() {
    // the top way is 1.6× as long: plain routing takes the bottom
    let d = diamond(residential(), 1040.0);
    let plain = Profile::default();
    assert!(rides(&route(&d, &plain, &[]), d.bottom[0]));
    // preferred, it counts at min_factor (0.5): 1040 m as 520 m, cheaper than 650 m
    let prefer = each(&d.top, OverrideKind::Prefer);
    let r = route(&d, &plain, &prefer);
    assert!(rides(&r, d.top[0]) && rides(&r, d.top[1]));
    assert_eq!(r.overrides.len(), 2);
    let len: f32 = d.top.iter().map(|&e| d.built.graph.length_m(e)).sum();
    assert!(
        (r.summary.override_cost + 0.5 * len).abs() < 1.0,
        "{}",
        r.summary.override_cost
    );
    assert!((r.summary.cost - len).abs() < 1.0);
    // with a direct profile (min_factor 1) preferring buys nothing
    let mut direct = Profile::default();
    let mut b = direct.bounds();
    b.min_factor = 1.0;
    direct.bounds = Some(b);
    assert!(rides(&route(&d, &direct, &prefer), d.bottom[0]));
    // a limit that closes the top way does not close a preferred one
    let g = diamond(gravel_track(), 1040.0);
    let mut paved = Profile::default();
    paved.limits.insert(LimitId::PavedOnly, LimitValue::Flag(true));
    assert!(rides(
        &route(&g, &paved, &each(&g.top, OverrideKind::Prefer)),
        g.top[0]
    ));
    // a bicycle ban and one-way still hold
    let banned = diamond(
        EdgeAttrs {
            bike_access: BikeAccess::No,
            ..residential()
        },
        600.0,
    );
    assert!(rides(
        &route(&banned, &plain, &each(&banned.top, OverrideKind::Prefer)),
        banned.bottom[0]
    ));
    let oneway = diamond(
        EdgeAttrs {
            oneway: Oneway::Against,
            ..residential()
        },
        600.0,
    );
    assert!(rides(
        &route(&oneway, &plain, &each(&oneway.top, OverrideKind::Prefer)),
        oneway.bottom[0]
    ));
}

#[test]
fn allow_lifts_the_limits_and_only_the_limits() {
    let d = diamond(gravel_track(), 600.0);
    let mut paved = Profile::default();
    paved.limits.insert(LimitId::PavedOnly, LimitValue::Flag(true));
    assert!(rides(&route(&d, &paved, &[]), d.bottom[0]));
    // allowed: costed as if the limit were off (a shorter gravel way wins)
    let allow = each(&d.top, OverrideKind::Allow);
    let r = route(&d, &paved, &allow);
    assert!(rides(&r, d.top[0]));
    assert!(r.overrides.iter().all(|u| u.kind == OverrideKind::Allow));
    assert!(r.summary.override_cost.abs() < 1e-3);
    // nothing on the route counts as excluded near a waypoint
    assert!(r.notes.is_empty(), "{:?}", r.notes);
    // the cost is the profile's without the limit
    let off = route(&d, &Profile::default(), &[]);
    assert!((r.summary.cost - off.summary.cost).abs() < 0.1);
    // allowing only one of the two edges leaves the way closed
    assert!(rides(&route(&d, &paved, &allow[..1]), d.bottom[0]));
    // allowing a banned way changes nothing
    let banned = diamond(
        EdgeAttrs {
            bike_access: BikeAccess::No,
            ..residential()
        },
        600.0,
    );
    let mut legal = Profile::default();
    legal.limits.insert(LimitId::LegalOnly, LimitValue::Flag(true));
    assert!(rides(
        &route(&banned, &legal, &each(&banned.top, OverrideKind::Allow)),
        banned.bottom[0]
    ));
}

#[test]
fn overrides_apply_to_every_leg_and_are_checked() {
    let d = diamond(residential(), 600.0);
    let g = &d.built.graph;
    let mid = g.node(g.to(d.bottom[0]));
    let mut planner = Planner::new(g.clone());
    // S → the bottom's middle → T → S again: the last leg avoids the top
    let wps = vec![
        wp(d.s.0, d.s.1),
        wp(mid.lng, mid.lat),
        wp(d.t.0, d.t.1),
        wp(d.s.0, d.s.1),
    ];
    let mut req = request(wps, &Profile::default(), &each(&d.top, OverrideKind::Avoid));
    req.options.avoid_reuse = false;
    let r = planner.route(&req).unwrap();
    assert!(!rides(&r, d.top[0]) && !rides(&r, d.top[1]));
    // ids are checked
    for bad in [
        vec![EdgeOverride {
            edge: 9999,
            kind: OverrideKind::Avoid,
        }],
        [
            each(&d.top[..1], OverrideKind::Avoid),
            each(&d.top[..1], OverrideKind::Prefer),
        ]
        .concat(),
    ] {
        let e = planner
            .route(&request(
                vec![wp(d.s.0, d.s.1), wp(d.t.0, d.t.1)],
                &Profile::default(),
                &bad,
            ))
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidRequest, "{e:?}");
    }
}

/// Dijkstra over a cost per arc and the turns (`turn_m` per right-angle turn): a label per arc,
/// no U-turns (with free turns: the node search).
fn dijkstra(
    g: &Graph,
    planner: &Planner,
    turn_m: f32,
    cost: &dyn Fn(u32) -> f32,
    s: NodeId,
    t: NodeId,
) -> f32 {
    let mut scratch = Vec::new();
    let mut dist = vec![f32::INFINITY; g.arc_count()];
    let mut heap = BinaryHeap::new();
    for b in g.out_arcs(s) {
        let c = cost(b);
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
        if g.head(a) == t {
            return d;
        }
        for b in g.out_arcs(g.head(a)) {
            if b == a ^ 1 {
                continue;
            }
            let c = cost(b) + turn_m * share_between(g, planner.headings(), a, b, &mut scratch);
            if c.is_finite() && d + c < dist[b as usize] {
                dist[b as usize] = d + c;
                heap.push(Reverse(((d + c).to_bits(), b)));
            }
        }
    }
    f32::INFINITY
}

/// A grid of ~200 m: main roads, tracks and paths at random.
fn grid(rng: &mut Rng, n: usize) -> Built {
    let mut b = GraphBuilder::new();
    let step = 200.0 / 111_195.0;
    for j in 0..n {
        for i in 0..n {
            b.node(0.07 + i as f64 * step, 0.07 + j as f64 * step);
        }
    }
    let kinds = [
        EdgeAttrs {
            highway: Highway::Primary,
            surface: SurfaceClass::PavedSmooth,
            ..EdgeAttrs::default()
        },
        gravel_track(),
        residential(),
        EdgeAttrs {
            highway: Highway::Path,
            surface: SurfaceClass::Soft,
            ..EdgeAttrs::default()
        },
    ];
    for j in 0..n {
        for i in 0..n {
            let v = j * n + i;
            let mut pick = || kinds[rng.below(kinds.len() as u64) as usize];
            if i + 1 < n {
                b.edge(v, v + 1, pick());
            }
            if j + 1 < n {
                b.edge(v, v + n, pick());
            }
        }
    }
    b.build()
}

#[test]
fn a_star_with_overrides_finds_what_dijkstra_finds() {
    let mut rng = Rng(0x5eed_0f0a_11d0);
    // dear everywhere (main roads, soft paths), a floor below anything compiled
    let mut p = Profile::default();
    p.set_weight(PrefId::Main, Some(-100));
    p.set_weight(PrefId::Unpaved, Some(-60));
    let mut bounds = p.bounds();
    bounds.min_factor = 0.3;
    p.bounds = Some(bounds);
    p.limits.insert(LimitId::PavedOnly, LimitValue::Flag(true));
    let mut compared = 0;
    for round in 0..6 {
        // turns free, the default, dear
        p.turn_m = Some([0.0, 20.0, 80.0][round % 3]);
        let built = grid(&mut rng, 10);
        let g = built.graph.clone();
        let mut planner = Planner::new(g.clone());
        let (costs, bound) = planner.arc_costs(&p).map(|(c, b)| (c.to_vec(), b)).unwrap();
        let kinds = [OverrideKind::Avoid, OverrideKind::Prefer, OverrideKind::Allow];
        let mut list: Vec<EdgeOverride> = Vec::new();
        for edge in 0..g.edge_count() as EdgeId {
            let r = rng.below(12);
            if r < 3 {
                list.push(EdgeOverride {
                    edge,
                    kind: kinds[r as usize],
                });
            }
        }
        let model = CostModel::new(&p).unwrap();
        let o = Overrides::build(&g, &model, None, &costs, &list);
        // preferred ways count less than anything the profile compiled to
        assert!(o.bound(bound) < bound);
        for _ in 0..12 {
            let s = rng.below(g.node_count() as u64) as NodeId;
            let t = rng.below(g.node_count() as u64) as NodeId;
            if s == t {
                continue;
            }
            let want = dijkstra(&g, &planner, p.turn_m(), &|a| o.cost(&costs, a), s, t);
            let (a, b) = (g.node(s), g.node(t));
            let got = planner.route(&request(vec![wp(a.lng, a.lat), wp(b.lng, b.lat)], &p, &list));
            match got {
                Ok(r)
                    if r.notes.iter().all(|n| !n.contains("excludes"))
                        && r.waypoints.iter().all(|w| w.distance_m < 0.01) =>
                {
                    let total = r.summary.cost + r.summary.override_cost;
                    assert!(
                        (total - want).abs() <= 1e-3 * want.max(1.0) + 0.5,
                        "A* {total} vs Dijkstra {want}"
                    );
                    compared += 1;
                }
                _ => {}
            }
        }
    }
    assert!(compared > 30, "only {compared} routes compared");
}

#[test]
fn the_explanation_and_the_comparison_say_what_the_router_counts() {
    let d = diamond(gravel_track(), 600.0);
    let g = &d.built.graph;
    let mut planner = Planner::new(g.clone());
    let mut paved = Profile::default();
    paved.limits.insert(LimitId::PavedOnly, LimitValue::Flag(true));
    let explain = |planner: &mut Planner, p: &Profile, e: EdgeId, o: Vec<EdgeOverride>| {
        planner
            .explain_edge(&ExplainEdgeRequest {
                profile: p.clone(),
                edge: e,
                overrides: Some(o),
            })
            .unwrap()
    };
    let len = g.length_m(d.top[0]);
    // allowed: open, the limit said as lifted, costed as the profile without it
    let x = explain(&mut planner, &paved, d.top[0], each(&d.top, OverrideKind::Allow));
    assert_eq!(x.plan_override, Some(OverrideKind::Allow));
    assert!(x.along.closed_by.is_empty() && x.along.lifted.len() == 1);
    assert!((x.along.cost.unwrap() - (len * x.along.factor + x.along.extra_m)).abs() < 0.1);
    assert_eq!(x.along.base_cost, None);
    // another edge's override does not touch this one
    let y = explain(
        &mut planner,
        &paved,
        d.top[0],
        each(&d.top[1..], OverrideKind::Allow),
    );
    assert_eq!(y.plan_override, None);
    assert!(!y.along.closed_by.is_empty() && y.along.cost.is_none());
    // avoided: the penalty on top, the profile's cost kept
    let plain = Profile::default();
    let x = explain(&mut planner, &plain, d.top[0], each(&d.top, OverrideKind::Avoid));
    let base = x.along.base_cost.unwrap();
    assert_eq!(x.plan_override, Some(OverrideKind::Avoid));
    assert!((x.along.cost.unwrap() - base - AVOID_M).abs() < 1.0);
    // preferred: at min_factor; the route's override cost is the explanation's difference
    let x = explain(&mut planner, &plain, d.top[0], each(&d.top, OverrideKind::Prefer));
    let (cost, base) = (x.along.cost.unwrap(), x.along.base_cost.unwrap());
    assert!((cost - (len * 0.5 + x.along.extra_m)).abs() < 0.1);
    let r = route(&d, &plain, &each(&d.top, OverrideKind::Prefer));
    let both: f32 = d
        .top
        .iter()
        .map(|&e| {
            let x = explain(&mut planner, &plain, e, each(&d.top, OverrideKind::Prefer));
            x.along.cost.unwrap() - x.along.base_cost.unwrap()
        })
        .sum();
    assert!(
        (r.summary.override_cost - both).abs() < 0.5,
        "{} vs {both}",
        r.summary.override_cost
    );
    assert!(cost < base);
    // compare: the avoided side carries the penalty and says so
    let a = route(&d, &plain, &[]);
    let b = route(&d, &plain, &each(&d.top, OverrideKind::Avoid));
    let c = planner
        .compare(&CompareRequest {
            profile: plain.clone(),
            a: a.arcs.clone(),
            b: b.arcs.clone(),
            overrides: Some(each(&d.top, OverrideKind::Avoid)),
        })
        .unwrap();
    assert_eq!(c.a.overrides.len(), 1);
    assert_eq!(c.a.overrides[0].kind, OverrideKind::Avoid);
    assert!((c.a.overrides[0].length_m - 2.0 * len).abs() < 1.0);
    assert_eq!(c.b.overrides, vec![]);
    assert!(c.stretches[0].cost_delta < -AVOID_M);
    // without the overrides it is the profile's comparison
    let c = planner
        .compare(&CompareRequest {
            profile: plain,
            a: a.arcs.clone(),
            b: b.arcs.clone(),
            overrides: None,
        })
        .unwrap();
    assert!(c.a.overrides.is_empty() && c.stretches[0].cost_delta > 0.0);
    let _ = arc(d.top[0], false);
}

#[test]
fn the_run_goes_to_the_next_junctions() {
    // a — b — c — d with a branch at c (c — e), and a dead end at d
    let mut b = GraphBuilder::new();
    let step = 100.0 / 111_195.0;
    let n: Vec<usize> = (0..4).map(|i| b.node(0.07 + f64::from(i) * step, 0.08)).collect();
    let e_node = b.node(0.07 + 2.0 * step, 0.08 + step);
    let x_node = b.node(0.07 - step, 0.08 + step);
    let ab = b.edge(n[0], n[1], residential());
    let bc = b.edge(n[2], n[1], residential()); // drawn the other way round
    let cd = b.edge(n[2], n[3], residential());
    let ce = b.edge(n[2], e_node, residential());
    // a is a junction too: two more edges meet there
    let ax = b.edge(n[0], x_node, residential());
    let ay = b.edge(n[0], e_node, residential());
    let built = b.build();
    let planner = Planner::new(built.graph.clone());
    let r = planner.edge_run(built.edge(ab)).unwrap();
    assert_eq!(r.edges, vec![built.edge(ab), built.edge(bc)]);
    assert_eq!(r.index, 0);
    assert!((r.length_m - 200.0).abs() < 2.0);
    // a straight line from a to c, joined once at b
    assert_eq!(r.coordinates.len(), 3);
    assert!(r.coordinates[0][0] < r.coordinates[1][0] && r.coordinates[1][0] < r.coordinates[2][0]);
    // from the other end: the same run, in its own direction
    let r = planner.edge_run(built.edge(bc)).unwrap();
    assert_eq!(r.edges.len(), 2);
    assert!(r.edges.contains(&built.edge(ab)));
    // c is a junction: the spur to the dead end is a run of its own
    let r = planner.edge_run(built.edge(cd)).unwrap();
    assert_eq!(r.edges, vec![built.edge(cd)]);
    let _ = (ce, ax, ay);
    assert!(planner.edge_run(9999).is_err());
}

#[test]
fn the_bound_drops_to_a_preferred_way_cheaper_than_anything_compiled() {
    // S — T direct (1 km), or a detour 1 km to the north (2.2 km): preferred at 0.3, it counts
    // 0.67 km. A bound at the compiled 1.0 per metre would stop at the direct way first.
    let mut b = GraphBuilder::new();
    let km = 1000.0 / 111_195.0;
    let (s, t) = ((0.07, 0.08), (0.07 + km, 0.08));
    let sn = b.node(s.0, s.1);
    let tn = b.node(t.0, t.1);
    let n = b.node(0.07 + km / 2.0, 0.08 + km);
    b.edge(sn, tn, residential());
    let up = b.edge(sn, n, residential());
    let down = b.edge(n, tn, residential());
    let built = b.build();
    let mut p = Profile::default();
    let mut bounds = p.bounds();
    bounds.min_factor = 0.3;
    p.bounds = Some(bounds);
    let mut planner = Planner::new(built.graph.clone());
    assert!((planner.arc_costs(&p).unwrap().1 - 1.0).abs() < 1e-6);
    let prefer = each(&[built.edge(up), built.edge(down)], OverrideKind::Prefer);
    let r = planner
        .route(&request(vec![wp(s.0, s.1), wp(t.0, t.1)], &p, &prefer))
        .unwrap();
    assert!(
        rides(&r, built.edge(up)) && rides(&r, built.edge(down)),
        "{:?}",
        r.arcs
    );
}
