//! The e2e fixture region (`e2e/fixtures/region`, built by `e2e/fixtures/build-region.ts`) carries a
//! compiled graph whose edge ids are the overlay's feature ids: the browser routes on it (#19) and
//! colours the overlay by the ids the engine reports.

use std::path::Path;

use kompass_compile::build;
use kompass_core::attrs::Oneway;
use kompass_core::graph::arc;

#[test]
fn the_fixture_graph_matches_the_overlay_source() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../e2e/fixtures");
    let (g, _) = build::load(&root.join("region"), true).unwrap();
    assert_eq!(g.info().build_id, "fixture");
    assert!(
        g.info().tiles.len() > 1,
        "the fixture spans tiles (it sits on 0°N 0°E)"
    );
    let src: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("src/edges.geojson")).unwrap()).unwrap();
    let features = src["features"].as_array().unwrap();
    assert_eq!(features.len(), g.edge_count());
    for f in features {
        let e = u32::try_from(f["id"].as_u64().unwrap()).unwrap();
        // the same line, point by point (interior points at 1e-6 degrees)
        let want: Vec<(f64, f64)> = f["geometry"]["coordinates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| (c[0].as_f64().unwrap(), c[1].as_f64().unwrap()))
            .collect();
        let got: Vec<(f64, f64)> = g
            .edge_points(e)
            .map(|p| (f64::from(p.0) * 1e-7, f64::from(p.1) * 1e-7))
            .collect();
        assert_eq!(got.len(), want.len(), "edge {e}");
        for (a, b) in got.iter().zip(&want) {
            assert!((a.0 - b.0).abs() < 1e-6 && (a.1 - b.1).abs() < 1e-6, "edge {e}");
        }
        let p = &f["properties"];
        assert_eq!(
            u64::from(g.highway(e).code()),
            p["highway"].as_u64().unwrap(),
            "edge {e}"
        );
        assert_eq!(
            u64::from(g.surface(e).code()),
            p["surface_class"].as_u64().unwrap(),
            "edge {e}"
        );
        let oneway = Oneway::from_code(i8::try_from(p["oneway_bike"].as_i64().unwrap()).unwrap()).unwrap();
        assert_eq!(g.oneway(e), oneway);
        if oneway != Oneway::Both {
            assert!(!g.arc_allowed(arc(e, oneway == Oneway::Along)));
        }
    }
}

/// The two main presets take different ways across the fixture (the browser e2e of #19 relies on
/// it), and a waypoint leg joins.
#[test]
fn the_main_presets_route_differently_on_the_fixture() {
    use kompass_core::route::{RouteOptions, Waypoint};
    use kompass_core::{Planner, RouteRequest, preset};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../e2e/fixtures");
    let (g, _) = build::load(&root.join("region"), true).unwrap();
    // the grid's nodes: 6 × 6, 0.0045° apart, centred on 0°N 0°E (build-region.ts)
    let node = |i: f64, j: f64| (-0.01125 + i * 0.0045, -0.01125 + j * 0.0045);
    let mut planner = Planner::new(g);
    let wp = |(lon, lat): (f64, f64)| Waypoint { lon, lat, name: None };
    let route = |planner: &mut Planner, id: &str, waypoints: Vec<Waypoint>| {
        planner
            .route(&RouteRequest {
                overrides: None,
                waypoints,
                profile: preset(id).unwrap().profile,
                leg_profiles: None,
                options: RouteOptions::default(),
                via_zones: None,
                avoid_zones: None,
                sketch: None,
            })
            .unwrap()
    };
    // 2.5 km both ways: about 60 % unpaved for the gravel preset, none for the paved one
    let (a, b) = (wp(node(1.0, 1.0)), wp(node(3.0, 0.0)));
    let gravel = route(&mut planner, "gravel_explorer", vec![a.clone(), b.clone()]);
    let paved = route(&mut planner, "paved_quiet", vec![a.clone(), b.clone()]);
    assert_ne!(gravel.arcs, paved.arcs);
    assert!(gravel.summary.unpaved_share > paved.summary.unpaved_share);
    let via = route(&mut planner, "gravel_explorer", vec![a, wp(node(3.0, 1.0)), b]);
    assert_eq!(via.legs.len(), 2);
}
