//! `kompass bench` and `kompass compare`: seeded random routes on a real build. The pairs are drawn
//! at run time from the seed and never printed or stored (the region is private); only numbers come
//! out, and GeoJSON only where `--out-dir` points.

use std::path::Path;
use std::time::Instant;

use kompass_core::cost::{CostModel, EdgeClasses};
use kompass_core::route::{RouteOptions, Waypoint};
use kompass_core::{Graph, NodeId, Planner, Profile, RouteRequest, RouteResult};

use crate::{Args, Failure, Rng, mb, peak_rss, percentile};

fn waypoint(g: &Graph, v: NodeId) -> Waypoint {
    let p = g.node(v);
    Waypoint {
        lon: p.lng,
        lat: p.lat,
        name: None,
    }
}

fn request(g: &Graph, a: NodeId, b: NodeId, profile: &Profile, geometry: bool) -> RouteRequest {
    RouteRequest {
        waypoints: vec![waypoint(g, a), waypoint(g, b)],
        profile: profile.clone(),
        leg_profiles: None,
        options: RouteOptions {
            snap_radius_m: 50.0,
            geometry,
        },
        via_zones: None,
        avoid_zones: None,
        sketch: None,
    }
}

/// Seeded random node pairs at a straight-line distance in `km`, routable under every profile.
#[allow(clippy::cast_possible_truncation, reason = "node ids fit u32")]
fn pairs(
    planner: &mut Planner,
    profiles: &[Profile],
    rng: &mut Rng,
    km: (f64, f64),
    n: usize,
    accept: &mut dyn FnMut(&mut Planner, NodeId, NodeId) -> bool,
) -> Vec<(NodeId, NodeId)> {
    let nodes = planner.graph().node_count() as u64;
    let mut out = Vec::with_capacity(n);
    let mut tries = 0;
    while out.len() < n && tries < n * 400 {
        tries += 1;
        let a = (rng.next_u64() % nodes) as NodeId;
        let b = (rng.next_u64() % nodes) as NodeId;
        let d = planner.graph().node_distance_m(a, b) / 1000.0;
        if d < km.0 || d > km.1 {
            continue;
        }
        let g = planner.graph();
        let reqs: Vec<RouteRequest> = profiles.iter().map(|p| request(g, a, b, p, false)).collect();
        if reqs.iter().all(|r| planner.route(r).is_ok()) && accept(planner, a, b) {
            out.push((a, b));
        }
    }
    out
}

fn profile_list(a: &Args, default: &str) -> Result<Vec<Profile>, Failure> {
    a.get("--profiles")
        .unwrap_or(default)
        .split(',')
        .map(|s| crate::route::load_profile(s.trim()))
        .collect()
}

fn name(p: &Profile) -> String {
    p.name.clone().unwrap_or_else(|| "(unnamed)".into())
}

/// `kompass bench`.
#[allow(clippy::cast_precision_loss, reason = "timings and counts for display")]
pub(crate) fn bench(a: &Args) -> Result<(), Failure> {
    a.only(&["--build", "--pairs", "--seed", "--profiles"])?;
    let build = a.build()?;
    let n: usize = a.number("--pairs", 100)?;
    let seed: u64 = a.number("--seed", 0x5eed_0018)?;
    let profiles = profile_list(a, "gravel_explorer,paved_quiet")?;
    let t = Instant::now();
    let (graph, _) = kompass_compile::build::load(&build, false)?;
    let load_ms = t.elapsed().as_secs_f64() * 1e3;
    println!(
        "graph: {} nodes, {} edges, {} ({load_ms:.0} ms)",
        graph.node_count(),
        graph.edge_count(),
        mb(graph.heap_bytes() as u64)
    );
    let t = Instant::now();
    let classes = EdgeClasses::build(&graph).ok_or_else(|| Failure::Run("too many edge classes".into()))?;
    println!(
        "edge classes: {} ({}, {:.0} ms)",
        classes.count(),
        mb(classes.heap_bytes() as u64),
        t.elapsed().as_secs_f64() * 1e3
    );
    // compile times, fresh each time
    let mut buf = Vec::new();
    for p in &profiles {
        let model = CostModel::new(p).map_err(|e| Failure::Run(e.0))?;
        let mut ms = Vec::new();
        let mut bound = 0.0;
        for _ in 0..7 {
            let t = Instant::now();
            bound = model.compile_classes(&graph, &classes, None, &mut buf);
            ms.push(t.elapsed().as_secs_f64() * 1e3);
        }
        ms.sort_by(f64::total_cmp);
        println!(
            "compile {}: median {:.1} ms, min {:.1} ms ({} arcs, bound factor {bound:.2})",
            name(p),
            percentile(&ms, 0.5),
            ms[0],
            buf.len()
        );
    }
    drop(buf);
    drop(classes);
    let mut planner = Planner::new(graph);
    let mut rng = Rng(seed | 1);
    println!("\n| profile | straight line | pairs | route km p50 | ms p50 / p95 / max | settled p50 / p95 |");
    println!("|---|---|---:|---:|---:|---:|");
    for (lo, hi) in [(7.0, 9.0), (37.0, 43.0), (75.0, 85.0)] {
        let set = pairs(&mut planner, &profiles, &mut rng, (lo, hi), n, &mut |_, _, _| {
            true
        });
        for p in &profiles {
            planner.prepare(p).map_err(|e| Failure::Run(e.message))?;
            let (mut ms, mut settled, mut km) = (Vec::new(), Vec::new(), Vec::new());
            for &(x, y) in &set {
                let req = request(planner.graph(), x, y, p, false);
                let t = Instant::now();
                let r = planner.route(&req).map_err(|e| Failure::Run(e.message))?;
                ms.push(t.elapsed().as_secs_f64() * 1e3);
                settled.push(f64::from(r.legs.iter().map(|l| l.settled).sum::<u32>()));
                km.push(f64::from(r.summary.distance_m) / 1000.0);
            }
            for v in [&mut ms, &mut settled, &mut km] {
                v.sort_by(f64::total_cmp);
            }
            println!(
                "| {} | {lo:.0}–{hi:.0} km | {} | {:.0} | {:.1} / {:.1} / {:.1} | {:.0}k / {:.0}k |",
                name(p),
                set.len(),
                percentile(&km, 0.5),
                percentile(&ms, 0.5),
                percentile(&ms, 0.95),
                percentile(&ms, 1.0),
                percentile(&settled, 0.5) / 1000.0,
                percentile(&settled, 0.95) / 1000.0
            );
        }
    }
    println!(
        "\nsearch state + compiled profiles {}; peak RSS {}",
        mb(planner.state_bytes() as u64),
        peak_rss().map_or_else(|| "?".into(), mb)
    );
    Ok(())
}

/// One route's quality numbers.
struct Quality {
    km: f64,
    detour: f64,
    unpaved: f64,
    unknown: f64,
    main_km: f64,
    ascent: f64,
    track: f64,
    bike_path: f64,
}

fn quality(r: &RouteResult, shortest_km: f64) -> Quality {
    let s = &r.summary;
    let km = f64::from(s.distance_m) / 1000.0;
    let share = |k: kompass_core::cost::WayKind| {
        r.breakdown
            .way
            .iter()
            .filter(|p| p.key == k)
            .map(|p| f64::from(p.share))
            .sum::<f64>()
    };
    Quality {
        km,
        detour: km / shortest_km.max(1e-3),
        unpaved: f64::from(s.unpaved_share),
        unknown: f64::from(s.unknown_surface_share),
        main_km: f64::from(s.main_road_m) / 1000.0,
        ascent: f64::from(s.ascent_m),
        track: share(kompass_core::cost::WayKind::Track),
        bike_path: share(kompass_core::cost::WayKind::BikePath),
    }
}

/// `kompass compare`: route quality of profiles on seeded random pairs, against the shortest way.
#[allow(
    clippy::cast_precision_loss,
    clippy::too_many_lines,
    reason = "numbers for display; one report"
)]
pub(crate) fn compare(a: &Args) -> Result<(), Failure> {
    a.only(&["--build", "--pairs", "--seed", "--profiles", "--km", "--out-dir"])?;
    let build = a.build()?;
    let n: usize = a.number("--pairs", 12)?;
    let seed: u64 = a.number("--seed", 0xc0_ffee)?;
    let profiles = profile_list(a, "gravel_explorer,paved_quiet")?;
    let (lo, hi) = a
        .get("--km")
        .unwrap_or("30-60")
        .split_once('-')
        .and_then(|(x, y)| Some((x.parse::<f64>().ok()?, y.parse::<f64>().ok()?)))
        .ok_or_else(|| Failure::Usage("--km must be <min>-<max>".into()))?;
    let out_dir = a.get("--out-dir").map(Path::new);
    if let Some(d) = out_dir {
        std::fs::create_dir_all(d)?;
    }
    let (graph, _) = kompass_compile::build::load(&build, out_dir.is_some())?;
    let mut planner = Planner::new(graph);
    let shortest = kompass_core::preset("blank_slate")
        .map(|p| p.profile)
        .ok_or_else(|| Failure::Run("no blank slate preset".into()))?;
    let all = vec![shortest.clone()];
    let mut rng = Rng(seed | 1);
    // pairs whose shortest route is lo..hi km (straight line a bit below)
    let set = pairs(
        &mut planner,
        &all,
        &mut rng,
        (lo * 0.6, hi * 0.85),
        n,
        &mut |pl: &mut Planner, x, y| {
            let req = request(pl.graph(), x, y, &shortest, false);
            pl.route(&req).is_ok_and(|r| {
                let km = f64::from(r.summary.distance_m) / 1000.0;
                (lo..=hi).contains(&km)
            })
        },
    );
    println!("{} pairs, shortest route {lo:.0}–{hi:.0} km\n", set.len());
    let mut per_profile: Vec<Vec<Quality>> = (0..=profiles.len()).map(|_| Vec::new()).collect();
    let mut failed = vec![0usize; profiles.len()];
    let mut short_km = Vec::new();
    println!(
        "| pair | shortest km | {} |",
        profiles
            .iter()
            .map(|p| format!(
                "{}: km (detour) unpaved / unknown / main km / tracks / bike paths / ascent",
                name(p)
            ))
            .collect::<Vec<_>>()
            .join(" | ")
    );
    println!("|---|---:|{}", "---|".repeat(profiles.len()));
    for (i, &(x, y)) in set.iter().enumerate() {
        let geometry = out_dir.is_some();
        let base = planner
            .route(&request(planner.graph(), x, y, &shortest, geometry))
            .map_err(|e| Failure::Run(e.message))?;
        let sk = f64::from(base.summary.distance_m) / 1000.0;
        short_km.push(sk);
        per_profile[profiles.len()].push(quality(&base, sk));
        if let Some(d) = out_dir {
            let gj = crate::route::geojson(&base, &shortest, false);
            std::fs::write(d.join(format!("pair-{i:02}-shortest.geojson")), gj.to_string())?;
        }
        let mut cells = Vec::new();
        for (k, p) in profiles.iter().enumerate() {
            let r = match planner.route(&request(planner.graph(), x, y, p, geometry)) {
                Ok(r) => r,
                Err(e) => {
                    failed[k] += 1;
                    cells.push(format!("no route ({:?})", e.code));
                    continue;
                }
            };
            let q = quality(&r, sk);
            cells.push(format!(
                "{:.1} ({:.2}) {:.0} % / {:.0} % / {:.1} / {:.0} % / {:.0} % / {:.0} m",
                q.km,
                q.detour,
                q.unpaved * 100.0,
                q.unknown * 100.0,
                q.main_km,
                q.track * 100.0,
                q.bike_path * 100.0,
                q.ascent
            ));
            if let Some(d) = out_dir {
                let gj = crate::route::geojson(&r, p, true);
                let id = name(p).to_lowercase().replace([' ', '&'], "_");
                std::fs::write(d.join(format!("pair-{i:02}-{id}.geojson")), gj.to_string())?;
            }
            per_profile[k].push(q);
        }
        println!("| {i} | {sk:.1} | {} |", cells.join(" | "));
    }
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len().max(1) as f64;
    let sorted = |mut v: Vec<f64>| {
        v.sort_by(f64::total_cmp);
        v
    };
    println!(
        "\n| profile | detour p50 / p90 / max | unpaved mean (min) | unknown surface mean | main road km mean / max | tracks mean | bike paths mean | ascent mean |"
    );
    println!("|---|---:|---:|---:|---:|---:|---:|---:|");
    let mut rows: Vec<String> = profiles.iter().map(name).collect();
    rows.push("(shortest)".into());
    for (k, label) in rows.iter().enumerate() {
        let q = &per_profile[k];
        let det = sorted(q.iter().map(|x| x.detour).collect());
        let unp: Vec<f64> = q.iter().map(|x| x.unpaved).collect();
        let main: Vec<f64> = q.iter().map(|x| x.main_km).collect();
        println!(
            "| {label} | {:.2} / {:.2} / {:.2} | {:.0} % ({:.0} %) | {:.0} % | {:.1} / {:.1} | {:.0} % | {:.0} % | {:.0} m |",
            percentile(&det, 0.5),
            percentile(&det, 0.9),
            percentile(&det, 1.0),
            mean(&unp) * 100.0,
            unp.iter().copied().fold(f64::INFINITY, f64::min) * 100.0,
            mean(&q.iter().map(|x| x.unknown).collect::<Vec<_>>()) * 100.0,
            mean(&main),
            main.iter().copied().fold(0.0, f64::max),
            mean(&q.iter().map(|x| x.track).collect::<Vec<_>>()) * 100.0,
            mean(&q.iter().map(|x| x.bike_path).collect::<Vec<_>>()) * 100.0,
            mean(&q.iter().map(|x| x.ascent).collect::<Vec<_>>()),
        );
    }
    for (k, p) in profiles.iter().enumerate() {
        if failed[k] > 0 {
            println!("{}: no route for {} pairs", name(p), failed[k]);
        }
    }
    let _ = mean(&short_km);
    Ok(())
}
