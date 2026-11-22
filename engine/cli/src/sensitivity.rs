//! `kompass sensitivity --build <dir> --profiles <a,b,...> [--pairs <n>] [--km <min-max>] [--seed <n>]
//! [--personal <explored.json>]`: how far one control moves a route (spike #60's measure, for both
//! cost models). On seeded random pairs (never printed), every control of a profile is nudged one
//! step each way and the share of the route's length that changes is averaged over the pairs:
//!
//! - a slider: its weight ±25 (the personal ones are left out: on 99 % of a region they are a
//!   constant);
//! - a board row: one tier up or down (love, like, fine, dislike; `avoid` is a limit, not a step);
//! - a hills handle: its value × or ÷ 1.25; the loose-ground modifier ±10 points;
//! - detours: ±0.25.
//!
//! Also per profile, under its own model: the length at the floor (`min_factor`; the structured model
//! has none), the mean factor, settled nodes per route.

#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "counts and shares for display"
)]

use std::collections::HashMap;
use std::path::Path;

use kompass_core::cost::{Clamp, CostModel};
use kompass_core::profile::{DownHandles, Hills, Tier};
use kompass_core::route::{RouteOptions, Waypoint};
use kompass_core::{ArcId, EdgeId, Graph, NodeId, Planner, PrefId, Profile, RouteRequest, Weight};

use crate::{Args, Failure, Rng, percentile};

fn waypoint(g: &Graph, v: NodeId) -> Waypoint {
    let p = g.node(v);
    Waypoint {
        lon: p.lng,
        lat: p.lat,
        name: None,
    }
}

/// A route's arcs and settled nodes, `None` without one.
fn route(pl: &mut Planner, a: NodeId, b: NodeId, p: &Profile) -> Option<(Vec<ArcId>, u32)> {
    let g = pl.graph();
    let req = RouteRequest {
        overrides: None,
        waypoints: vec![waypoint(g, a), waypoint(g, b)],
        profile: p.clone(),
        leg_profiles: None,
        options: RouteOptions {
            snap_radius_m: 50.0,
            geometry: false,
            ..RouteOptions::default()
        },
        via_zones: None,
        avoid_zones: None,
        sketch: None,
    };
    pl.route(&req)
        .ok()
        .map(|r| (r.arcs, r.legs.iter().map(|l| l.settled).sum()))
}

/// The share of `base`'s length that `other` does not ride (edges, either direction).
fn changed(g: &Graph, base: &[ArcId], other: &[ArcId]) -> f64 {
    let edges = |r: &[ArcId]| -> HashMap<EdgeId, f64> {
        r.iter()
            .map(|&a| (a >> 1, f64::from(g.length_m(a >> 1))))
            .collect()
    };
    let (b, o) = (edges(base), edges(other));
    let total: f64 = b.values().sum();
    let shared: f64 = b.iter().filter(|(e, _)| o.contains_key(e)).map(|(_, l)| l).sum();
    1.0 - shared / total.max(1.0)
}

/// What a control is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
enum Family {
    Slider,
    Tier,
    Hills,
    Detours,
}

impl Family {
    fn name(self) -> &'static str {
        match self {
            Family::Slider => "sliders ±25",
            Family::Tier => "tiers ±1 step",
            Family::Hills => "hills handles ×/÷1.25, loose ±10",
            Family::Detours => "detours ±0.25",
        }
    }
}

/// One nudge: its family, a label, whether it makes something cheaper ("up": stronger bonus, a
/// better tier, a cheaper handle, more detours), and the profile.
struct Nudge {
    family: Family,
    label: String,
    up: bool,
    profile: Profile,
}

const LADDER: [Tier; 4] = [Tier::Love, Tier::Like, Tier::Fine, Tier::Dislike];

#[allow(clippy::too_many_lines, reason = "one list per kind of control")]
fn nudges(p: &Profile) -> Vec<Nudge> {
    let mut out = Vec::new();
    for (&id, &w) in &p.weights {
        if matches!(id, PrefId::Novel | PrefId::Stale | PrefId::Familiar) {
            continue;
        }
        let w = i64::from(w);
        for (up, t) in [(true, w + 25), (false, w - 25)] {
            let t = t.clamp(-100, 100);
            if t == w {
                continue;
            }
            let mut q = p.clone();
            q.weights.insert(id, Weight::new(t).unwrap_or_default());
            out.push(Nudge {
                family: Family::Slider,
                label: format!("{id} {w} → {t}"),
                up,
                profile: q,
            });
        }
    }
    if let Some(b) = p.boards {
        for row in b.rows() {
            let Some(i) = b.tier(row).and_then(|t| LADDER.iter().position(|&x| x == t)) else {
                continue;
            };
            for (up, j) in [
                (true, i.checked_sub(1)),
                (false, Some(i + 1).filter(|&j| j < LADDER.len())),
            ] {
                let Some(j) = j else { continue };
                let mut nb = b;
                nb.set(row, LADDER[j]);
                out.push(Nudge {
                    family: Family::Tier,
                    label: format!("{row} {} → {}", LADDER[i], LADDER[j]),
                    up,
                    profile: Profile {
                        boards: Some(nb),
                        ..p.clone()
                    },
                });
            }
        }
    }
    if let Some(h) = p.hills {
        let down = kompass_core::structured::down_handles(&h);
        let base = Hills {
            down: Some(down),
            ..h
        };
        for k in 0..6 {
            for up in [true, false] {
                let mut x = base;
                let mut d: DownHandles = down;
                let (v, lo, hi, name): (&mut f32, f32, f32, &str) = match k {
                    0 => (&mut d.at15, Hills::DOWN_RANGE.0, Hills::DOWN_RANGE.1, "−15 %"),
                    1 => (&mut d.at8, Hills::DOWN_RANGE.0, Hills::DOWN_RANGE.1, "−8 %"),
                    2 => (&mut x.up.at3, Hills::UP_RANGE.0, Hills::UP_RANGE.1, "3 %"),
                    3 => (&mut x.up.at6, Hills::UP_RANGE.0, Hills::UP_RANGE.1, "6 %"),
                    4 => (&mut x.up.at10, Hills::UP_RANGE.0, Hills::UP_RANGE.1, "10 %"),
                    _ => (&mut x.up.at15, Hills::UP_RANGE.0, Hills::UP_RANGE.1, "15 %"),
                };
                let was = *v;
                *v = (if up { was / 1.25 } else { was * 1.25 }).clamp(lo, hi);
                let now = *v;
                if (now - was).abs() < 1e-4 {
                    continue;
                }
                x.down = Some(d);
                out.push(Nudge {
                    family: Family::Hills,
                    label: format!("hills {name} {was:.2} → {now:.2}"),
                    up,
                    profile: Profile {
                        hills: Some(x),
                        ..p.clone()
                    },
                });
            }
        }
        for up in [true, false] {
            let l = (h.loose_pct + if up { -10.0 } else { 10.0 })
                .clamp(Hills::LOOSE_RANGE.0, Hills::LOOSE_RANGE.1);
            if (l - h.loose_pct).abs() < 1e-4 {
                continue;
            }
            out.push(Nudge {
                family: Family::Hills,
                label: format!("loose {:.0} → {l:.0} %", h.loose_pct),
                up,
                profile: Profile {
                    hills: Some(Hills { loose_pct: l, ..h }),
                    ..p.clone()
                },
            });
        }
    }
    if p.structured() {
        let d = p.detours();
        for up in [true, false] {
            let n = (d + if up { 0.25 } else { -0.25 }).clamp(0.5, 2.0);
            if (n - d).abs() < 1e-4 {
                continue;
            }
            out.push(Nudge {
                family: Family::Detours,
                label: format!("detours {d:.2} → {n:.2}"),
                up,
                profile: Profile {
                    detours: Some(n),
                    ..p.clone()
                },
            });
        }
    }
    out
}

fn mean(v: &[f64]) -> f64 {
    v.iter().sum::<f64>() / v.len().max(1) as f64
}

#[allow(clippy::too_many_lines, reason = "one report")]
pub(crate) fn run(a: &Args) -> Result<(), Failure> {
    a.only(&["--build", "--profiles", "--pairs", "--km", "--seed", "--personal"])?;
    let build = a.build()?;
    let n: usize = a.number("--pairs", 30)?;
    let seed: u64 = a.number("--seed", 0x60_60)?;
    let (lo, hi) = a
        .get("--km")
        .unwrap_or("15-35")
        .split_once('-')
        .and_then(|(x, y)| Some((x.parse::<f64>().ok()?, y.parse::<f64>().ok()?)))
        .ok_or_else(|| Failure::Usage("--km must be <min>-<max>".into()))?;
    let profiles: Vec<(String, Profile)> = a
        .get("--profiles")
        .unwrap_or("gravel_explorer,gravel_explorer_structured")
        .split(',')
        .map(|s| {
            let label = Path::new(s.trim())
                .file_stem()
                .map_or_else(|| s.to_string(), |x| x.to_string_lossy().into_owned());
            crate::route::load_profile(s.trim()).map(|p| (label, p))
        })
        .collect::<Result<_, _>>()?;
    let (graph, _) = kompass_compile::build::load(&build, false)?;
    let mut pl = Planner::new(graph);
    if let Some(file) = a.get("--personal") {
        crate::personal::load(&mut pl, file)?;
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
        "{} pairs, straight line {lo:.0}–{hi:.0} km{}",
        pairs.len(),
        if a.get("--personal").is_some() {
            ", with the personal layer"
        } else {
            ""
        }
    );
    println!(
        "\n| profile | route km | settled per route | at the floor | mean factor | nudges | changed, mean | median | runs moving > 5 % | up / down |"
    );
    println!("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    let mut detail = Vec::new();
    let mut families = Vec::new();
    for (name, p) in &profiles {
        let model = CostModel::new(p).map_err(|e| Failure::Run(e.0))?;
        let mut base = Vec::new();
        let (mut km, mut floor, mut fkm, mut settled) = (0.0f64, 0.0f64, 0.0f64, 0u64);
        for &(x, y) in &pairs {
            let (arcs, s) = route(&mut pl, x, y, p).unwrap_or_default();
            settled += u64::from(s);
            for &arc in &arcs {
                let g = pl.graph();
                let len = f64::from(g.length_m(arc >> 1)) / 1e3;
                let b = model.breakdown(g, pl.personal(), arc);
                km += len;
                fkm += len * f64::from(b.factor);
                if b.clamp == Some(Clamp::Min) {
                    floor += len;
                }
            }
            base.push(arcs);
        }
        let mut all = Vec::new();
        let (mut ups, mut downs) = (Vec::new(), Vec::new());
        let mut moved = 0usize;
        let mut by_family: HashMap<Family, Vec<f64>> = HashMap::new();
        for nudge in nudges(p) {
            let mut ch = Vec::new();
            for (i, &(x, y)) in pairs.iter().enumerate() {
                let r = route(&mut pl, x, y, &nudge.profile).map_or_else(Vec::new, |r| r.0);
                let c = changed(pl.graph(), &base[i], &r);
                if c > 0.05 {
                    moved += 1;
                }
                ch.push(c);
            }
            let m = mean(&ch);
            all.push(m);
            if nudge.up {
                ups.push(m);
            } else {
                downs.push(m);
            }
            by_family.entry(nudge.family).or_default().push(m);
            detail.push(format!("| {name} | {} | {:.1} % |", nudge.label, m * 100.0));
        }
        let mut sorted = all.clone();
        sorted.sort_by(f64::total_cmp);
        let runs = all.len() * pairs.len();
        println!(
            "| {name} | {:.1} | {:.1}k | {:.1} % | {:.3} | {} | {:.1} % | {:.1} % | {:.0} % | {:.1} / {:.1} % |",
            km / pairs.len().max(1) as f64,
            settled as f64 / pairs.len().max(1) as f64 / 1e3,
            floor * 100.0 / km.max(1e-9),
            fkm / km.max(1e-9),
            all.len(),
            mean(&all) * 100.0,
            percentile(&sorted, 0.5) * 100.0,
            moved as f64 * 100.0 / runs.max(1) as f64,
            mean(&ups) * 100.0,
            mean(&downs) * 100.0
        );
        let mut fam: Vec<_> = by_family.into_iter().collect();
        fam.sort_by_key(|(f, _)| *f);
        for (f, v) in fam {
            families.push(format!(
                "| {name} | {} | {} | {:.1} % |",
                f.name(),
                v.len(),
                mean(&v) * 100.0
            ));
        }
    }
    println!("\n| profile | controls | nudges | changed, mean |");
    println!("|---|---|---:|---:|");
    for f in families {
        println!("{f}");
    }
    println!("\n| profile | nudge | changed, mean |");
    println!("|---|---|---:|");
    for d in detail {
        println!("{d}");
    }
    Ok(())
}
