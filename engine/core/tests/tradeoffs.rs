//! Hard limits as trade-offs on a synthetic graph: a short gravel link a paved-only profile rides
//! around on a long detour is offered (limit, edges, length, place, distance saved), a longer one or
//! one that saves too little is not, an allowed link is no longer offered, a bicycle ban is never
//! softened, and a profile without limits searches nothing.
#![allow(clippy::many_single_char_names, reason = "a tiny test graph")]

use kompass_core::attrs::{BikeAccess, EdgeAttrs, Highway, SurfaceClass};
use kompass_core::explain::ClosedBy;
use kompass_core::overrides::{EdgeOverride, OverrideKind};
use kompass_core::route::{RouteOptions, Waypoint};
use kompass_core::testing::GraphBuilder;
use kompass_core::tradeoffs::{Thresholds, TradeoffRequest};
use kompass_core::{EdgeId, LimitId, LimitValue, Planner, Profile, RouteRequest};

fn paved() -> EdgeAttrs {
    EdgeAttrs {
        highway: Highway::Residential,
        surface: SurfaceClass::PavedSmooth,
        ..EdgeAttrs::default()
    }
}

fn gravel() -> EdgeAttrs {
    EdgeAttrs {
        highway: Highway::Track,
        surface: SurfaceClass::Gravel,
        ..EdgeAttrs::default()
    }
}

/// S — X ~ Y — T on a line (S–X and Y–T paved, 220 m), X ~ Y the `link` (`link_deg` long), and a
/// paved detour from X to Y reaching `detour_lat` north.
struct Ladder {
    planner: Planner,
    s: (f64, f64),
    t: (f64, f64),
    link: EdgeId,
}

fn ladder(link: EdgeAttrs, link_deg: f64, detour_lat: f64) -> Ladder {
    let mut b = GraphBuilder::new();
    let (xs, xx) = (0.0, 0.002);
    let xy = xx + link_deg;
    let xt = xy + 0.002;
    let s = b.node(xs, 0.0);
    let x = b.node(xx, 0.0);
    let y = b.node(xy, 0.0);
    let t = b.node(xt, 0.0);
    let p = b.node(xx, detour_lat);
    let q = b.node(xy, detour_lat);
    b.edge(s, x, paved());
    let l = b.edge(x, y, link);
    b.edge(y, t, paved());
    b.edge(x, p, paved());
    b.edge(p, q, paved());
    b.edge(q, y, paved());
    let built = b.build();
    Ladder {
        link: built.edge(l),
        planner: Planner::new(built.graph),
        s: (xs, 0.0),
        t: (xt, 0.0),
    }
}

fn paved_only() -> Profile {
    let mut p = Profile::default();
    p.limits.insert(LimitId::PavedOnly, LimitValue::Flag(true));
    p
}

fn request(l: &Ladder, profile: &Profile, overrides: &[EdgeOverride]) -> RouteRequest {
    let wp = |(lon, lat): (f64, f64)| Waypoint { lon, lat, name: None };
    RouteRequest {
        waypoints: vec![wp(l.s), wp(l.t)],
        profile: profile.clone(),
        leg_profiles: None,
        options: RouteOptions::default(),
        overrides: (!overrides.is_empty()).then(|| overrides.to_vec()),
        via_zones: None,
        avoid_zones: None,
        sketch: None,
    }
}

fn tradeoffs(
    l: &mut Ladder,
    profile: &Profile,
    overrides: &[EdgeOverride],
) -> kompass_core::tradeoffs::Tradeoffs {
    let route = request(l, profile, overrides);
    let strict = l.planner.route(&route).unwrap().arcs;
    l.planner
        .tradeoffs(&TradeoffRequest {
            route,
            strict: Some(strict),
        })
        .unwrap()
}

#[test]
fn a_short_link_around_a_long_detour_is_offered() {
    // a 140 m gravel link; around it 2 × 1.3 km paved
    let mut l = ladder(gravel(), 0.00126, 0.012);
    let compiles = l.planner.compiles;
    let out = tradeoffs(&mut l, &paved_only(), &[]);
    assert!(out.searched);
    assert_eq!(out.candidates, 1);
    let [t] = out.tradeoffs.as_slice() else {
        panic!("one trade-off: {out:?}")
    };
    assert_eq!(t.limits, vec![ClosedBy::PavedOnly]);
    let [run] = t.runs.as_slice() else {
        panic!("one run")
    };
    assert_eq!(run.edges, vec![l.link]);
    assert_eq!(run.way, kompass_core::cost::WayKind::Track);
    assert!((run.length_m - t.broken_m).abs() < 1e-3 && run.coordinates.len() >= 2);
    assert!((t.broken_m - 140.0).abs() < 2.0, "{}", t.broken_m);
    assert!((t.saved_m - 2670.0).abs() < 20.0, "{}", t.saved_m);
    // the marker is on the link, the preview spans it
    assert!(
        t.at.lon > 0.002 && t.at.lon < 0.00326 && t.at.lat.abs() < 1e-6,
        "{:?}",
        t.at
    );
    assert!(t.coordinates.len() >= 2);
    assert!(t.strict.length_m > t.soft.length_m);
    // the same compiled profile: no compile for the softened route
    assert_eq!(l.planner.compiles, compiles + 1);
    // without the strict arcs the query routes them itself
    let route = request(&l, &paved_only(), &[]);
    let again = l
        .planner
        .tradeoffs(&TradeoffRequest { route, strict: None })
        .unwrap();
    assert_eq!(again, out);
}

#[test]
fn the_thresholds_keep_short_bits_that_save_real_distance() {
    let th = Thresholds::DEFAULT;
    assert!(th.keep(140.0, 3800.0));
    assert!(th.keep(300.0, 1500.0));
    assert!(!th.keep(301.0, 5000.0), "too long a bit");
    assert!(!th.keep(100.0, 999.0), "too little saved");
    assert!(!th.keep(250.0, 1200.0), "less than 5 × the bit");
    // a 400 m link around 2 × 5.5 km: the softened route takes it, it is no trade-off
    let mut l = ladder(gravel(), 0.0036, 0.05);
    let out = tradeoffs(&mut l, &paved_only(), &[]);
    assert_eq!(out.candidates, 1);
    assert_eq!(out.tradeoffs.len(), 0);
    // a link that saves little: the softened route stays on the paved way
    let mut l = ladder(gravel(), 0.00126, 0.002);
    let out = tradeoffs(&mut l, &paved_only(), &[]);
    assert_eq!((out.candidates, out.tradeoffs.len()), (0, 0));
}

#[test]
fn an_allowed_link_is_no_longer_offered() {
    let mut l = ladder(gravel(), 0.00126, 0.012);
    let allow = [EdgeOverride {
        edge: l.link,
        kind: OverrideKind::Allow,
    }];
    let r = l.planner.route(&request(&l, &paved_only(), &allow)).unwrap();
    assert!(
        r.arcs.iter().any(|&a| a >> 1 == l.link),
        "the strict route rides the allowed link"
    );
    let out = tradeoffs(&mut l, &paved_only(), &allow);
    assert!(out.searched);
    assert_eq!((out.candidates, out.tradeoffs.len()), (0, 0));
}

#[test]
fn a_bicycle_ban_is_never_softened_and_no_limits_search_nothing() {
    let banned = EdgeAttrs {
        bike_access: BikeAccess::No,
        ..gravel()
    };
    let mut l = ladder(banned, 0.00126, 0.012);
    let out = tradeoffs(&mut l, &paved_only(), &[]);
    assert!(out.searched && out.tradeoffs.is_empty() && out.candidates == 0);
    let mut l = ladder(gravel(), 0.00126, 0.012);
    let out = tradeoffs(&mut l, &Profile::default(), &[]);
    assert!(!out.searched && out.tradeoffs.is_empty());
}
