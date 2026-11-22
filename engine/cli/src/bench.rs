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
        overrides: None,
        waypoints: vec![waypoint(g, a), waypoint(g, b)],
        profile: profile.clone(),
        leg_profiles: None,
        options: RouteOptions {
            snap_radius_m: 50.0,
            geometry,
            ..RouteOptions::default()
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
    let (graph, _) = kompass_compile::build::load(&build, true)?;
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
    let t = Instant::now();
    let mut planner = Planner::new(graph);
    println!(
        "planner (snapping grid, edge classes, turn headings, search state): {:.0} ms, headings {}",
        t.elapsed().as_secs_f64() * 1e3,
        mb(planner.headings().heap_bytes() as u64)
    );
    let mut rng = Rng(seed | 1);
    println!(
        "\n| profile | straight line | pairs | route km p50 | ms p50 / p95 / max | settled p50 / p95 | result JSON p50 |"
    );
    println!("|---|---|---:|---:|---:|---:|---:|");
    for (lo, hi) in [(7.0, 9.0), (37.0, 43.0), (75.0, 85.0)] {
        let set = pairs(&mut planner, &profiles, &mut rng, (lo, hi), n, &mut |_, _, _| {
            true
        });
        for p in &profiles {
            planner.prepare(p).map_err(|e| Failure::Run(e.message))?;
            let (mut ms, mut settled, mut km, mut json) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
            for &(x, y) in &set {
                let req = request(planner.graph(), x, y, p, true);
                let t = Instant::now();
                let r = planner.route(&req).map_err(|e| Failure::Run(e.message))?;
                ms.push(t.elapsed().as_secs_f64() * 1e3);
                settled.push(f64::from(r.legs.iter().map(|l| l.settled).sum::<u32>()));
                km.push(f64::from(r.summary.distance_m) / 1000.0);
                json.push(serde_json::to_string(&r).map_or(0.0, |j| j.len() as f64));
            }
            for v in [&mut ms, &mut settled, &mut km, &mut json] {
                v.sort_by(f64::total_cmp);
            }
            println!(
                "| {} | {lo:.0}–{hi:.0} km | {} | {:.0} | {:.1} / {:.1} / {:.1} | {:.0}k / {:.0}k | {:.0} KB |",
                name(p),
                set.len(),
                percentile(&km, 0.5),
                percentile(&ms, 0.5),
                percentile(&ms, 0.95),
                percentile(&ms, 1.0),
                percentile(&settled, 0.5) / 1000.0,
                percentile(&settled, 0.95) / 1000.0,
                percentile(&json, 0.5) / 1000.0
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
    water: f64,
    forest: f64,
    /// Km whose tamed grade exceeds `--grade` uphill, and downhill.
    steep_up_km: f64,
    steep_down_km: f64,
    /// Turns (≥ 45° at junctions), zigzags and short excursions (`replay`'s measures).
    turns: u32,
    zigzags: u32,
    excursions: u32,
}

fn quality(g: &Graph, r: &RouteResult, shortest_km: f64, grade: f32) -> Quality {
    let s = &r.summary;
    let km = f64::from(s.distance_m) / 1000.0;
    let share = |k: kompass_core::cost::WayKind| {
        r.breakdown
            .way
            .iter()
            .filter(|p| p.key == k)
            .map(|p| f64::from(p.share))
            .fold(0.0, |a, b| a + b)
    };
    let along = |f: &dyn Fn(kompass_core::EdgeId) -> f32| {
        r.arcs
            .iter()
            .map(|&a| f64::from(g.length_m(a >> 1) * f(a >> 1)))
            .sum::<f64>()
            / (km * 1000.0).max(1.0)
    };
    let steep = |up: bool| {
        r.arcs
            .iter()
            .filter(|&&a| {
                let (u, d) = kompass_core::cost::arc_grade_pct(g, a);
                (if up { u } else { d }) > grade
            })
            .map(|&a| f64::from(g.length_m(a >> 1)))
            .sum::<f64>()
            / 1000.0
    };
    let line: Vec<(kompass_core::ArcId, f32)> = r.arcs.iter().map(|&a| (a, 1.0)).collect();
    let (turns, zigzags) = crate::replay::turns(g, &line);
    Quality {
        turns,
        zigzags,
        excursions: crate::replay::excursions(g, &r.arcs),
        steep_up_km: steep(true),
        steep_down_km: steep(false),
        water: along(&|e| g.water_share(e)),
        forest: along(&|e| g.forest_share(e)),
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
    if a.get("--loop").is_some() {
        return loops(a);
    }
    a.only(&[
        "--build",
        "--pairs",
        "--seed",
        "--profiles",
        "--km",
        "--out-dir",
        "--grade",
    ])?;
    let build = a.build()?;
    let n: usize = a.number("--pairs", 12)?;
    let grade: f32 = a.number("--grade", 10.0)?;
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
    // (with the geometry: the turn costs read its headings)
    let (graph, _) = kompass_compile::build::load(&build, true)?;
    let mut planner = Planner::new(graph);
    // the shortest way: the blank slate, turns free
    let mut shortest = kompass_core::preset("blank_slate")
        .map(|p| p.profile)
        .ok_or_else(|| Failure::Run("no blank slate preset".into()))?;
    shortest.turn_m = Some(0.0);
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
                "{}: km (detour) unpaved / unknown / main km / tracks / bike paths / ascent / km up > {grade} %",
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
        per_profile[profiles.len()].push(quality(planner.graph(), &base, sk, grade));
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
            let q = quality(planner.graph(), &r, sk, grade);
            cells.push(format!(
                "{:.1} ({:.2}) {:.0} % / {:.0} % / {:.1} / {:.0} % / {:.0} % / {:.0} m / {:.2}",
                q.km,
                q.detour,
                q.unpaved * 100.0,
                q.unknown * 100.0,
                q.main_km,
                q.track * 100.0,
                q.bike_path * 100.0,
                q.ascent,
                q.steep_up_km
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
        "\n| profile | detour p50 / p90 / max | unpaved mean (min) | unknown surface mean | main road km mean / max | tracks mean | bike paths mean | ascent mean | water / forest | km > {grade} % up / down mean | turns / km | zigzags | excursions |"
    );
    println!("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    let mut rows: Vec<String> = profiles.iter().map(name).collect();
    rows.push("(shortest)".into());
    for (k, label) in rows.iter().enumerate() {
        let q = &per_profile[k];
        let det = sorted(q.iter().map(|x| x.detour).collect());
        let unp: Vec<f64> = q.iter().map(|x| x.unpaved).collect();
        let main: Vec<f64> = q.iter().map(|x| x.main_km).collect();
        println!(
            "| {label} | {:.2} / {:.2} / {:.2} | {:.0} % ({:.0} %) | {:.0} % | {:.1} / {:.1} | {:.0} % | {:.0} % | {:.0} m | {:.0} % / {:.0} % | {:.2} / {:.2} | {:.2} | {} | {} |",
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
            mean(&q.iter().map(|x| x.water).collect::<Vec<_>>()) * 100.0,
            mean(&q.iter().map(|x| x.forest).collect::<Vec<_>>()) * 100.0,
            mean(&q.iter().map(|x| x.steep_up_km).collect::<Vec<_>>()),
            mean(&q.iter().map(|x| x.steep_down_km).collect::<Vec<_>>()),
            f64::from(q.iter().map(|x| x.turns).sum::<u32>()) / q.iter().map(|x| x.km).sum::<f64>().max(1e-6),
            q.iter().map(|x| x.zigzags).sum::<u32>(),
            q.iter().map(|x| x.excursions).sum::<u32>(),
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

/// One loop routed under one variant.
struct LoopRun {
    km: f64,
    reused_km: f64,
    cost: f64,
    /// Vias left back along the arc they were reached by.
    uturns: usize,
    ms: f64,
}

/// The waypoints of a seeded loop: `start`, then `corners − 1` points around a circle through it
/// (jittered in angle and radius), then `start` again; the polygon's perimeter is `km`. With
/// `through`, each corner moves onto the nearest way within 500 m that is not a dead end (both
/// ends at junctions) that every profile rides both ways (`open`, compiled costs per profile),
/// mid-edge: a via where a rider would put one, where no U-turn is forced.
fn loop_waypoints(
    planner: &Planner,
    open: &[Vec<f32>],
    start: NodeId,
    corners: usize,
    km: f64,
    through: bool,
    rng: &mut Rng,
) -> Option<Vec<Waypoint>> {
    use std::f64::consts::PI;
    let g = planner.graph();
    #[allow(clippy::cast_precision_loss, reason = "a corner count")]
    let n = corners as f64;
    let r = km * 1000.0 / (2.0 * n * (PI / n).sin());
    let p = g.node(start);
    let m_lat = 111_195.0;
    let m_lon = m_lat * p.lat.to_radians().cos();
    let theta = rng.signed() * PI;
    let (cx, cy) = (r * theta.cos(), r * theta.sin());
    let mut out = vec![waypoint(g, start)];
    for k in 1..corners {
        #[allow(clippy::cast_precision_loss, reason = "a corner index")]
        let ang = theta + PI + 2.0 * PI * k as f64 / n + rng.signed() * 0.25;
        let rr = r * (1.0 + rng.signed() * 0.15);
        let at = kompass_core::LngLat {
            lng: p.lng + (cx + rr * ang.cos()) / m_lon,
            lat: p.lat + (cy + rr * ang.sin()) / m_lat,
        };
        let at = if through {
            // two more ways every profile rides at least one way
            let junction = |v: NodeId| {
                g.arcs_at(v)
                    .0
                    .iter()
                    .filter(|&&a| {
                        let e = a as usize & !1;
                        open.iter().all(|c| c[e].is_finite() || c[e + 1].is_finite())
                    })
                    .count()
                    >= 3
            };
            let s = planner.grid().snap(g, at, 500.0, 64).into_iter().find(|s| {
                (0.2..=0.8).contains(&s.fraction)
                    && g.length_m(s.edge) >= 50.0
                    && junction(g.from(s.edge))
                    && junction(g.to(s.edge))
                    && open.iter().all(|c| {
                        let e = s.edge as usize * 2;
                        c[e].is_finite() && c[e + 1].is_finite()
                    })
            })?;
            s.point
        } else {
            at
        };
        out.push(Waypoint {
            lon: at.lng,
            lat: at.lat,
            name: None,
        });
    }
    out.push(waypoint(g, start));
    Some(out)
}

/// U-turns at the vias of a result: a leg whose first arc is the reverse of the last arc before it.
fn uturns(r: &RouteResult) -> usize {
    let mut n = 0;
    let mut last: Option<u32> = None;
    for (l, leg) in r.legs.iter().enumerate() {
        let [a0, a1] = leg.arcs;
        if a1 > a0 {
            if l > 0 && last.is_some_and(|x| r.arcs[a0 as usize] == x ^ 1) {
                n += 1;
            }
            last = Some(r.arcs[a1 as usize - 1]);
        }
    }
    n
}

/// `kompass compare --loop <corners>`: seeded loops of waypoints (a triangle, a square, …) routed
/// per profile under each `--reuse` variant: how much is ridden twice, U-turns at the vias, and the
/// price in length and in the profile's cost against the first variant.
#[allow(
    clippy::cast_precision_loss,
    clippy::too_many_lines,
    reason = "numbers for display; one report"
)]
fn loops(a: &Args) -> Result<(), Failure> {
    a.only(&[
        "--build",
        "--loop",
        "--pairs",
        "--seed",
        "--profiles",
        "--km",
        "--reuse",
        "--corners",
    ])?;
    let through = match a.get("--corners").unwrap_or("through") {
        "through" => true,
        "any" => false,
        _ => return Err(Failure::Usage("--corners must be through or any".into())),
    };
    let build = a.build()?;
    let corners: usize = a.number("--loop", 3)?;
    if !(3..=8).contains(&corners) {
        return Err(Failure::Usage("--loop takes 3..8 corners".into()));
    }
    let n: usize = a.number("--pairs", 40)?;
    let seed: u64 = a.number("--seed", 0x100b)?;
    let profiles = profile_list(a, "gravel_explorer,paved_quiet")?;
    let specs: Vec<&str> = a.get("--reuse").unwrap_or("off,on").split(',').collect();
    let variants = specs
        .iter()
        .map(|s| crate::reuse(s))
        .collect::<Result<Vec<_>, _>>()?;
    let (lo, hi) = a
        .get("--km")
        .unwrap_or("30-60")
        .split_once('-')
        .and_then(|(x, y)| Some((x.parse::<f64>().ok()?, y.parse::<f64>().ok()?)))
        .ok_or_else(|| Failure::Usage("--km must be <min>-<max>".into()))?;
    // (with the geometry: the turn costs read its headings)
    let (graph, _) = kompass_compile::build::load(&build, true)?;
    let mut planner = Planner::new(graph);
    let mut rng = Rng(seed | 1);
    let nodes = planner.graph().node_count() as u64;
    let req =
        |wps: &[Waypoint], p: &Profile, v: (bool, Option<kompass_core::route::ReuseCost>)| RouteRequest {
            overrides: None,
            waypoints: wps.to_vec(),
            profile: p.clone(),
            leg_profiles: None,
            options: RouteOptions {
                snap_radius_m: 500.0,
                geometry: false,
                avoid_reuse: v.0,
                reuse_cost: v.1,
            },
            via_zones: None,
            avoid_zones: None,
            sketch: None,
        };
    let open = profiles
        .iter()
        .map(|p| {
            Ok(planner
                .arc_costs(p)
                .map_err(|e| Failure::Run(e.message))?
                .0
                .to_vec())
        })
        .collect::<Result<Vec<_>, Failure>>()?;
    // loops every profile routes under the first variant
    let mut set: Vec<Vec<Waypoint>> = Vec::new();
    let mut tries = 0;
    while set.len() < n && tries < n * 200 {
        tries += 1;
        #[allow(clippy::cast_possible_truncation, reason = "node ids fit u32")]
        let start = (rng.next_u64() % nodes) as NodeId;
        let km = lo + (hi - lo) * (rng.signed() + 1.0) / 2.0;
        let Some(wps) = loop_waypoints(&planner, &open, start, corners, km, through, &mut rng) else {
            continue;
        };
        let ok = profiles
            .iter()
            .all(|p| planner.route(&req(&wps, p, variants[0])).is_ok());
        if ok {
            set.push(wps);
        }
    }
    println!(
        "{} loops of {corners} corners ({}), polygon {lo:.0}–{hi:.0} km; length and cost against `{}`\n",
        set.len(),
        if through { "on through ways" } else { "anywhere" },
        specs[0]
    );
    println!(
        "| profile | reuse | km p50 | ridden twice: share of km all / p50 / p90 / max | loops with > 5 % twice | U-turns at vias | km vs {0} p50 / p90 / max | cost vs {0} p50 / p90 | ms p50 / max |",
        specs[0]
    );
    println!("|---|---|---:|---:|---:|---:|---:|---:|---:|");
    for p in &profiles {
        planner.prepare(p).map_err(|e| Failure::Run(e.message))?;
        let mut runs: Vec<Vec<LoopRun>> = (0..variants.len()).map(|_| Vec::new()).collect();
        let mut failed = vec![0usize; variants.len()];
        for wps in &set {
            let mut one = Vec::with_capacity(variants.len());
            for (k, &v) in variants.iter().enumerate() {
                let t = Instant::now();
                let Ok(r) = planner.route(&req(wps, p, v)) else {
                    failed[k] += 1;
                    continue;
                };
                let ms = t.elapsed().as_secs_f64() * 1e3;
                one.push(LoopRun {
                    km: f64::from(r.summary.distance_m) / 1000.0,
                    reused_km: f64::from(r.summary.reused_m) / 1000.0,
                    cost: f64::from(r.summary.cost),
                    uturns: uturns(&r),
                    ms,
                });
            }
            // compared only where every variant routes
            if one.len() == variants.len() {
                for (k, r) in one.into_iter().enumerate() {
                    runs[k].push(r);
                }
            }
        }
        let sorted = |mut v: Vec<f64>| {
            v.sort_by(f64::total_cmp);
            v
        };
        for (k, spec) in specs.iter().enumerate() {
            let rs = &runs[k];
            let km = sorted(rs.iter().map(|r| r.km).collect());
            let share = sorted(rs.iter().map(|r| r.reused_km / r.km.max(1e-3)).collect());
            let all =
                rs.iter().map(|r| r.reused_km).sum::<f64>() / rs.iter().map(|r| r.km).sum::<f64>().max(1e-3);
            let over = share.iter().filter(|&&s| s > 0.05).count();
            let ut: usize = rs.iter().map(|r| r.uturns).sum();
            let dkm = sorted(
                rs.iter()
                    .zip(&runs[0])
                    .map(|(r, b)| r.km / b.km.max(1e-3))
                    .collect(),
            );
            let dcost = sorted(
                rs.iter()
                    .zip(&runs[0])
                    .map(|(r, b)| r.cost / b.cost.max(1e-3))
                    .collect(),
            );
            let ms = sorted(rs.iter().map(|r| r.ms).collect());
            println!(
                "| {} | {spec} | {:.1} | {:.1} % / {:.1} % / {:.1} % / {:.1} % | {over} / {} | {ut} of {} | {:.3} / {:.3} / {:.3} | {:.3} / {:.3} | {:.0} / {:.0} |",
                name(p),
                percentile(&km, 0.5),
                all * 100.0,
                percentile(&share, 0.5) * 100.0,
                percentile(&share, 0.9) * 100.0,
                percentile(&share, 1.0) * 100.0,
                rs.len(),
                rs.len() * (corners - 1),
                percentile(&dkm, 0.5),
                percentile(&dkm, 0.9),
                percentile(&dkm, 1.0),
                percentile(&dcost, 0.5),
                percentile(&dcost, 0.9),
                percentile(&ms, 0.5),
                percentile(&ms, 1.0),
            );
        }
        for (k, spec) in specs.iter().enumerate() {
            if failed[k] > 0 {
                println!("{} with {spec}: no route for {} loops", name(p), failed[k]);
            }
        }
    }
    Ok(())
}
