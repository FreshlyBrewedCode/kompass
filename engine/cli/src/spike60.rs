//! Spike #60 (never merged): `kompass spike60 --build <dir> --profiles a,b [--pairs n] [--km lo-hi]
//! [--seed s] [--sliders]`. On seeded random pairs (never printed): the length at the floor and
//! saturated (the factor follows less than half of a change in the product), the grade data on the
//! routes, and with `--sliders` how far each active preference moves the route (weight −100,
//! w − 25, w + 25, +100: the share of the route's length that changes). The cost model is the one
//! `KOMPASS_SPIKE_MODEL` / `KOMPASS_SPIKE_HILLS` / `KOMPASS_SPIKE_MIN` select.

#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::too_many_lines,
    reason = "a spike"
)]

use std::collections::HashMap;

use kompass_core::cost::{self, Clamp, CostModel};
use kompass_core::route::{RouteOptions, Waypoint};
use kompass_core::{ArcId, EdgeId, Graph, NodeId, Planner, PrefId, Profile, RouteRequest, Weight};

use crate::{Args, Failure, Rng, percentile};

fn wp(g: &Graph, v: NodeId) -> Waypoint {
    let p = g.node(v);
    Waypoint {
        lon: p.lng,
        lat: p.lat,
        name: None,
    }
}

fn route(pl: &mut Planner, a: NodeId, b: NodeId, p: &Profile) -> Option<Vec<ArcId>> {
    let g = pl.graph();
    let req = RouteRequest {
        waypoints: vec![wp(g, a), wp(g, b)],
        profile: p.clone(),
        leg_profiles: None,
        options: RouteOptions {
            snap_radius_m: 50.0,
            geometry: false,
        },
        via_zones: None,
        avoid_zones: None,
        sketch: None,
    };
    pl.route(&req).ok().map(|r| {
        SETTLED.with(|c| c.set(c.get() + r.legs.iter().map(|l| u64::from(l.settled)).sum::<u64>()));
        r.arcs
    })
}

thread_local! {
    static SETTLED: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn edges(g: &Graph, arcs: &[ArcId]) -> HashMap<EdgeId, f32> {
    arcs.iter().map(|&a| (a >> 1, g.length_m(a >> 1))).collect()
}

/// The share of `base`'s length that `other` does not ride.
fn changed(g: &Graph, base: &[ArcId], other: &[ArcId]) -> f64 {
    let b = edges(g, base);
    let o = edges(g, other);
    let tot: f64 = b.values().map(|&l| f64::from(l)).sum();
    let shared: f64 = b
        .iter()
        .filter(|(e, _)| o.contains_key(e))
        .map(|(_, &l)| f64::from(l))
        .sum();
    1.0 - shared / tot.max(1.0)
}

#[derive(Default)]
struct Floor {
    km: f64,
    at_floor: f64,
    saturated: f64,
    factor_km: f64,
    // grade data on the route
    gap5: f64,
    gap3: f64,
    short: f64,
    mid: f64,
    long: f64,
    mismatch: u32,
}

fn floor_stats(pl: &Planner, model: &CostModel, costs: &[f32], arcs: &[ArcId], f: &mut Floor) {
    let g = pl.graph();
    let pers = pl.personal();
    for &a in arcs {
        let e = a >> 1;
        let len = f64::from(g.length_m(e));
        let b = model.breakdown(g, pers, a);
        f.km += len / 1e3;
        f.factor_km += len / 1e3 * f64::from(b.factor);
        if b.clamp == Some(Clamp::Min) {
            f.at_floor += len / 1e3;
        }
        if b.raw < 1.0 && model.leverage(b.raw) < 0.5 {
            f.saturated += len / 1e3;
        }
        let again = g.length_m(e) * b.factor + b.extra_m();
        if let Some(&c) = costs.get(a as usize)
            && c.is_finite()
            && (c - again).abs() > 1e-2 * c.max(1.0)
        {
            f.mismatch += 1;
        }
        // average climbing rate vs the tamed steepest 50 m, in the arc's direction
        let (up, _) = cost::arc_grade_pct(g, a);
        let raw_avg = f64::from(cost::arc_raw_ascent_m(g, a)) / len.max(1.0) * 100.0;
        if f64::from(up) - raw_avg > 5.0 {
            f.gap5 += len / 1e3;
        }
        if f64::from(up) - raw_avg > 3.0 {
            f.gap3 += len / 1e3;
        }
        if len < 100.0 {
            f.short += len / 1e3;
        } else if len < 300.0 {
            f.mid += len / 1e3;
        } else {
            f.long += len / 1e3;
        }
    }
}

/// The personal layer from an explored map (`kompass match --explored`).
pub(crate) fn load_personal(pl: &mut Planner, file: &str) -> Result<(), Failure> {
    let text = std::fs::read_to_string(file)?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| Failure::Run(e.to_string()))?;
    let today = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
        / 86_400) as u32;
    let mut layer = kompass_core::PersonalLayer::empty(pl.graph().edge_count(), today);
    if let Some(m) = v.get("edges").and_then(|e| e.as_object()) {
        for (k, x) in m {
            let e: EdgeId = k.parse().map_err(|_| Failure::Run("edge id".into()))?;
            let n = x.get("count").and_then(serde_json::Value::as_u64).unwrap_or(0);
            let day = x
                .get("lastRidden")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0)
                / 86_400_000;
            if (e as usize) < pl.graph().edge_count() {
                layer.rides[e as usize] = n.min(u64::from(u16::MAX)) as u16;
                layer.last_ridden[e as usize] = day as u32;
            }
        }
    }
    pl.set_personal(Some(layer)).map_err(|e| Failure::Run(e.message))
}

pub(crate) fn run(a: &Args) -> Result<(), Failure> {
    a.only(&[
        "--build",
        "--profiles",
        "--pairs",
        "--km",
        "--seed",
        "--sliders",
        "--personal",
        "--dump",
        "--against",
        "--time",
    ])?;
    let build = a.build()?;
    let n: usize = a.number("--pairs", 24)?;
    let seed: u64 = a.number("--seed", 0x60_60)?;
    let (lo, hi) = a
        .get("--km")
        .unwrap_or("15-35")
        .split_once('-')
        .and_then(|(x, y)| Some((x.parse::<f64>().ok()?, y.parse::<f64>().ok()?)))
        .ok_or_else(|| Failure::Usage("--km must be <min>-<max>".into()))?;
    let profiles: Vec<(String, Profile)> = a
        .get("--profiles")
        .unwrap_or("gravel_explorer,paved_quiet,river_valley")
        .split(',')
        .map(|s| crate::route::load_profile(s.trim()).map(|p| (s.trim().to_string(), p)))
        .collect::<Result<_, _>>()?;
    let (graph, _) = kompass_compile::build::load(&build, false)?;
    let mut pl = Planner::new(graph);
    if let Some(file) = a.get("--personal") {
        load_personal(&mut pl, file)?;
    }
    if a.switch("--time") {
        // the per-edge compile (no edge classes) of each profile, best of 5: the cost of a per-arc term
        println!("| profile | compile_into ms (best of 5) | with classes ms |");
        println!("|---|---:|---:|");
        let classes = kompass_core::cost::EdgeClasses::build(pl.graph());
        for (name, p) in &profiles {
            let model = CostModel::new(p).map_err(|e| Failure::Run(e.0))?;
            let mut out = Vec::new();
            let (mut best, mut best_c) = (f64::INFINITY, f64::INFINITY);
            for _ in 0..5 {
                let t = std::time::Instant::now();
                model.compile_into(pl.graph(), pl.personal(), &mut out);
                best = best.min(t.elapsed().as_secs_f64() * 1e3);
                if let Some(c) = &classes {
                    let t = std::time::Instant::now();
                    model.compile_classes(pl.graph(), c, pl.personal(), &mut out);
                    best_c = best_c.min(t.elapsed().as_secs_f64() * 1e3);
                }
            }
            println!("| {name} | {best:.0} | {best_c:.0} |");
        }
        return Ok(());
    }
    let mut rng = Rng(seed | 1);
    let nodes = pl.graph().node_count() as u64;
    let mut pairs: Vec<(NodeId, NodeId)> = Vec::new();
    let mut tries = 0;
    while pairs.len() < n && tries < n * 400 {
        tries += 1;
        let x = (rng.next_u64() % nodes) as NodeId;
        let y = (rng.next_u64() % nodes) as NodeId;
        let d = pl.graph().node_distance_m(x, y) / 1000.0;
        if d < lo || d > hi {
            continue;
        }
        if profiles.iter().all(|(_, p)| route(&mut pl, x, y, p).is_some()) {
            pairs.push((x, y));
        }
    }
    println!(
        "model {} hills {} min {}; {} pairs, straight line {lo:.0}–{hi:.0} km",
        std::env::var("KOMPASS_SPIKE_MODEL").unwrap_or_else(|_| "today".into()),
        std::env::var("KOMPASS_SPIKE_HILLS").unwrap_or_else(|_| "-".into()),
        std::env::var("KOMPASS_SPIKE_MIN").unwrap_or_else(|_| "-".into()),
        pairs.len()
    );
    println!(
        "\n| profile | route km mean | at floor | saturated (leverage < 0.5) | mean factor | arcs < 100 m / 100–300 / > 300 m | steepest 50 m − average climb > 3 / > 5 pts | cost mismatches |"
    );
    println!("|---|---:|---:|---:|---:|---:|---:|---:|");
    let mut base: Vec<Vec<Vec<ArcId>>> = Vec::new();
    for (name, p) in &profiles {
        let model = CostModel::new(p).map_err(|e| Failure::Run(e.0))?;
        model.compile_into(pl.graph(), pl.personal(), &mut Vec::new()); // Mode::Norm's γ
        let mut f = Floor::default();
        let mut routes = Vec::new();
        SETTLED.with(|c| c.set(0));
        let t0 = std::time::Instant::now();
        for &(x, y) in &pairs {
            routes.push(route(&mut pl, x, y, p).unwrap_or_default());
        }
        let ms = t0.elapsed().as_secs_f64() * 1e3 / pairs.len().max(1) as f64;
        let settled = SETTLED.with(std::cell::Cell::get) / pairs.len().max(1) as u64;
        let costs = pl.arc_costs(p).map(|c| c.0.to_vec()).unwrap_or_default();
        println!("  ({name}: settled {settled} per route, {ms:.1} ms per route incl. the first compile)");
        for r in &routes {
            floor_stats(&pl, &model, &costs, r, &mut f);
        }
        let km = f.km.max(1e-6);
        println!(
            "| {name} | {:.1} | {:.1} % | {:.1} % | {:.3} | {:.0} / {:.0} / {:.0} % | {:.0} / {:.0} % | {} |",
            f.km / pairs.len().max(1) as f64,
            f.at_floor * 100.0 / km,
            f.saturated * 100.0 / km,
            f.factor_km / km,
            f.short * 100.0 / km,
            f.mid * 100.0 / km,
            f.long * 100.0 / km,
            f.gap3 * 100.0 / km,
            f.gap5 * 100.0 / km,
            f.mismatch
        );
        base.push(routes);
    }
    if let Some(file) = a.get("--dump") {
        let s = serde_json::to_string(&base).map_err(|e| Failure::Run(e.to_string()))?;
        std::fs::write(file, s)?;
    }
    if let Some(file) = a.get("--against") {
        let text = std::fs::read_to_string(file)?;
        let other: Vec<Vec<Vec<ArcId>>> =
            serde_json::from_str(&text).map_err(|e| Failure::Run(e.to_string()))?;
        println!("\n| profile | changed against the other run, mean | median | pairs moved > 5 % |");
        println!("|---|---:|---:|---:|");
        for (k, (name, _)) in profiles.iter().enumerate() {
            let mut ch: Vec<f64> = base[k]
                .iter()
                .zip(&other[k])
                .map(|(x, y)| changed(pl.graph(), y, x))
                .collect();
            ch.sort_by(f64::total_cmp);
            println!(
                "| {name} | {:.1} % | {:.1} % | {} / {} |",
                ch.iter().sum::<f64>() / ch.len().max(1) as f64 * 100.0,
                percentile(&ch, 0.5) * 100.0,
                ch.iter().filter(|&&c| c > 0.05).count(),
                ch.len()
            );
        }
    }
    if !a.switch("--sliders") {
        return Ok(());
    }
    println!(
        "\n| profile | preference | weight | changed at −100 | at w − 25 | at w + 25 | at +100 | pairs moved > 5 % at ±25 |"
    );
    println!("|---|---|---:|---:|---:|---:|---:|---:|");
    let mut summary = Vec::new();
    for ((name, p), routes) in profiles.iter().zip(&base) {
        let mut nudges = Vec::new();
        let mut extremes = Vec::new();
        let mut moved_pairs = 0usize;
        let mut nudge_runs = 0usize;
        for (&id, &w) in &p.weights {
            if matches!(id, PrefId::Novel | PrefId::Stale | PrefId::Familiar) {
                continue;
            }
            let w = i64::from(w);
            let mut cells = Vec::new();
            let mut moved = 0usize;
            for (k, target) in [-100, w - 25, w + 25, 100].into_iter().enumerate() {
                let t = target.clamp(-100, 100);
                if t == w {
                    cells.push("—".to_string());
                    continue;
                }
                let mut q = p.clone();
                q.weights
                    .insert(id, Weight::new(t).ok_or_else(|| Failure::Run("weight".into()))?);
                let mut ch = Vec::new();
                for (i, &(x, y)) in pairs.iter().enumerate() {
                    let r = route(&mut pl, x, y, &q).unwrap_or_default();
                    let c = changed(pl.graph(), &routes[i], &r);
                    if (k == 1 || k == 2) && c > 0.05 {
                        moved += 1;
                    }
                    ch.push(c);
                }
                let mut mean = ch.iter().sum::<f64>() / ch.len().max(1) as f64;
                if k == 3 && std::env::var("KOMPASS_SPIKE_FLOOR100").is_ok() {
                    // the length at the floor with this slider at +100
                    let model = CostModel::new(&q).map_err(|e| Failure::Run(e.0))?;
                    model.compile_into(pl.graph(), pl.personal(), &mut Vec::new());
                    let costs = pl.arc_costs(&q).map(|c| c.0.to_vec()).unwrap_or_default();
                    let mut f = Floor::default();
                    for &(x, y) in &pairs {
                        let r = route(&mut pl, x, y, &q).unwrap_or_default();
                        floor_stats(&pl, &model, &costs, &r, &mut f);
                    }
                    let _ = &mut mean;
                    cells.push(format!("floor {:.0} %", f.at_floor * 100.0 / f.km.max(1e-6)));
                }
                if k == 1 || k == 2 {
                    nudges.push(mean);
                    nudge_runs += ch.len();
                } else {
                    extremes.push(mean);
                }
                cells.push(format!("{:.0} %", mean * 100.0));
            }
            moved_pairs += moved;
            let id_name = serde_json::to_value(id)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default();
            println!(
                "| {name} | {id_name} | {w} | {} | {} / {} |",
                cells.join(" | "),
                moved,
                2 * pairs.len()
            );
        }
        let mut sn = nudges.clone();
        sn.sort_by(f64::total_cmp);
        let mut se = extremes.clone();
        se.sort_by(f64::total_cmp);
        summary.push(format!(
            "| {name} | {:.1} % | {:.1} % | {:.1} % | {:.1} % | {:.0} % |",
            nudges.iter().sum::<f64>() / nudges.len().max(1) as f64 * 100.0,
            percentile(&sn, 0.5) * 100.0,
            extremes.iter().sum::<f64>() / extremes.len().max(1) as f64 * 100.0,
            percentile(&se, 0.5) * 100.0,
            moved_pairs as f64 * 100.0 / nudge_runs.max(1) as f64
        ));
    }
    println!(
        "\n| profile | ±25 nudge: changed, mean | median | extremes: changed, mean | median | nudge runs that move > 5 % |"
    );
    println!("|---|---:|---:|---:|---:|---:|");
    for s in summary {
        println!("{s}");
    }
    Ok(())
}
