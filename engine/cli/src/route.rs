//! `kompass route`: one route as a GeoJSON FeatureCollection.

use std::path::Path;
use std::time::Instant;

use kompass_core::route::{RouteOptions, Waypoint};
use kompass_core::{Planner, Profile, RouteRequest, RouteResult};
use serde_json::{Value, json};

use crate::{Args, Failure};

/// A profile from a JSON file (a profile or a preset) or a preset's id or name.
pub(crate) fn load_profile(spec: &str) -> Result<Profile, Failure> {
    let path = Path::new(spec);
    if path.is_file() {
        let text = std::fs::read_to_string(path)?;
        let v: Value = serde_json::from_str(&text).map_err(|e| Failure::Run(format!("{spec}: {e}")))?;
        if v.get("profile").is_some() {
            return kompass_core::presets::parse(&text)
                .map(|p| p.profile)
                .map_err(|e| Failure::Run(format!("{spec}: {e}")));
        }
        return Profile::from_json(&text).map_err(|e| Failure::Run(format!("{spec}: {e}")));
    }
    kompass_core::preset(spec).map(|p| p.profile).ok_or_else(|| {
        let names: Vec<String> = kompass_core::presets().into_iter().map(|p| p.id).collect();
        Failure::Usage(format!(
            "--profile {spec}: no such file or preset (presets: {})",
            names.join(", ")
        ))
    })
}

fn coord(flag: &str, v: &str) -> Result<Waypoint, Failure> {
    let bad = || Failure::Usage(format!("{flag} must be lon,lat"));
    let (lon, lat) = v.split_once(',').ok_or_else(bad)?;
    Ok(Waypoint {
        lon: lon.trim().parse().map_err(|_| bad())?,
        lat: lat.trim().parse().map_err(|_| bad())?,
        name: None,
    })
}

/// The route as GeoJSON: the line (with elevations as a third coordinate) carrying the summary,
/// breakdowns, legs and waypoints; optionally every segment as a feature too.
#[must_use]
pub(crate) fn geojson(r: &RouteResult, profile: &Profile, segments: bool) -> Value {
    let geo = r.geometry.as_ref();
    let coords: Vec<Value> = geo.map_or_else(Vec::new, |g| {
        g.coordinates
            .iter()
            .enumerate()
            .map(|(i, c)| match g.elevation_m.as_ref().and_then(|e| e.get(i)) {
                Some(z) => json!([c[0], c[1], z]),
                None => json!([c[0], c[1]]),
            })
            .collect()
    });
    let mut features = vec![json!({
        "type": "Feature",
        "geometry": { "type": "LineString", "coordinates": coords },
        "properties": {
            "kind": "route",
            "profile": profile.name,
            "summary": r.summary,
            "breakdown": r.breakdown,
            "legs": r.legs,
            "waypoints": r.waypoints,
            "notes": r.notes,
        },
    })];
    if segments && let Some(g) = geo {
        for s in &r.segments {
            let [v0, v1] = s.vertices;
            let pts: Vec<Value> = (v0..=v1)
                .filter_map(|i| g.coordinates.get(i as usize))
                .map(|c| json!([c[0], c[1]]))
                .collect();
            features.push(json!({
                "type": "Feature",
                "geometry": { "type": "LineString", "coordinates": pts },
                "properties": {
                    "kind": "segment",
                    "start_m": s.start_m,
                    "length_m": s.length_m,
                    "surface": s.surface,
                    "way": s.way,
                    "ridden": s.ridden,
                    "factor": s.factor,
                    "extra_m": s.extra_m,
                    "why": s.why,
                    "edges": r.arcs[s.arcs[0] as usize..s.arcs[1] as usize].iter().map(|a| a >> 1).collect::<Vec<_>>(),
                },
            }));
        }
    }
    json!({ "type": "FeatureCollection", "features": features })
}

pub(crate) fn run(a: &Args) -> Result<(), Failure> {
    a.only(&[
        "--build",
        "--profile",
        "--from",
        "--via",
        "--to",
        "--out",
        "--radius",
    ])?;
    let build = a.build()?;
    let profile = load_profile(
        a.get("--profile")
            .ok_or_else(|| Failure::Usage("--profile <file|preset> is required".into()))?,
    )?;
    let mut waypoints = vec![coord(
        "--from",
        a.get("--from")
            .ok_or_else(|| Failure::Usage("--from is required".into()))?,
    )?];
    for v in a.all("--via") {
        waypoints.push(coord("--via", v)?);
    }
    waypoints.push(coord(
        "--to",
        a.get("--to")
            .ok_or_else(|| Failure::Usage("--to is required".into()))?,
    )?);
    let (graph, _) = kompass_compile::build::load(&build, true)?;
    let mut planner = Planner::new(graph);
    let req = RouteRequest {
        waypoints,
        profile: profile.clone(),
        leg_profiles: None,
        options: RouteOptions {
            snap_radius_m: a.number("--radius", RouteOptions::default().snap_radius_m)?,
            geometry: true,
        },
        via_zones: None,
        avoid_zones: None,
        sketch: None,
    };
    let t = Instant::now();
    let r = planner.route(&req).map_err(|e| Failure::Run(e.message))?;
    let ms = t.elapsed().as_secs_f64() * 1e3;
    let out = serde_json::to_string(&geojson(&r, &profile, a.switch("--segments")))
        .map_err(|e| Failure::Run(e.to_string()))?;
    let s = &r.summary;
    let summary = format!(
        "{:.1} km, +{:.0} m / -{:.0} m, {:.0} min, unpaved {:.0} %, unknown surface {:.0} %, main roads {:.1} km ({ms:.0} ms incl. compile)",
        s.distance_m / 1000.0,
        s.ascent_m,
        s.descent_m,
        s.duration_s / 60.0,
        s.unpaved_share * 100.0,
        s.unknown_surface_share * 100.0,
        s.main_road_m / 1000.0
    );
    match a.get("--out") {
        Some(path) => {
            std::fs::write(path, out)?;
            println!("{summary}");
        }
        None => {
            println!("{out}");
            eprintln!("{summary}");
        }
    }
    Ok(())
}
