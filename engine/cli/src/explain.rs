//! The cost debug view in the terminal: `kompass route --explain` (every segment's breakdown and
//! an aggregate), `kompass route --why-not lon,lat` (the route against one forced through that
//! point, stretch by stretch) and `kompass explain --edge <id>` (one edge, both directions).
//! Lengths, classes and factors only: no coordinates.

use std::fmt::Write as _;
use std::time::Instant;

use kompass_core::cost::{WayKind, reported_surface, way_kind};
use kompass_core::explain::{
    ArcCostExplanation, AttrValue, EdgeExplanation, EdgeSelection, ExplainEdgeRequest, StretchCost,
    TrafficFrom, describe_closure,
};
use kompass_core::graph::arc_edge;
use kompass_core::route::Reason;
use kompass_core::{Planner, PrefId, Profile, RouteResult};

use crate::route::load_profile;
use crate::{Args, Failure};

fn run_err(e: kompass_core::RouteError) -> Failure {
    Failure::Run(e.message)
}

fn reasons(why: &[Reason]) -> String {
    why.iter()
        .map(|r| format!("{} {:.2}×", r.id, r.factor))
        .collect::<Vec<_>>()
        .join(", ")
}

fn km(m: f32) -> String {
    format!("{:.2} km", m / 1000.0)
}

fn ways(s: &StretchCost) -> String {
    s.ways
        .iter()
        .take(3)
        .map(|p| format!("{} {:.0} %", label(p.key), p.share * 100.0))
        .collect::<Vec<_>>()
        .join(", ")
}

fn label(w: WayKind) -> String {
    serde_json::to_value(w)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn closed(s: &StretchCost) -> String {
    let mut out = String::new();
    let len = s.span.length_m.max(1e-3);
    if s.clamped_min_m > 0.0 {
        let _ = write!(out, "; at min_factor {:.0} %", s.clamped_min_m / len * 100.0);
    }
    if s.clamped_max_m > 0.0 {
        let _ = write!(out, "; at max_factor {:.0} %", s.clamped_max_m / len * 100.0);
    }
    if s.closed.is_empty() {
        return out;
    }
    let parts: Vec<String> = s
        .closed
        .iter()
        .map(|c| format!("{} {:.0} m", c.by.id(), c.length_m))
        .collect();
    format!("{out}; closed: {}", parts.join(", "))
}

/// Every segment of a route with its breakdown, then the aggregate over the route.
pub(crate) fn route_explanation(
    planner: &mut Planner,
    profile: &Profile,
    r: &RouteResult,
) -> Result<String, Failure> {
    let spans: Vec<[u32; 2]> = r.segments.iter().map(|s| s.arcs).collect();
    let costs = planner
        .stretch_costs(profile, &r.arcs, &spans, 8)
        .map_err(run_err)?;
    let mut out = String::new();
    let _ = writeln!(out, "segments (edges counted in full):");
    let _ = writeln!(
        out,
        "| # | at | length | surface | way | factor | extra m | cost/m | why |"
    );
    let _ = writeln!(out, "|---:|---:|---:|---|---|---:|---:|---:|---|");
    for (i, (s, c)) in r.segments.iter().zip(&costs).enumerate() {
        let surface = serde_json::to_value(s.surface)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        let _ = writeln!(
            out,
            "| {i} | {} | {} | {surface} | {} | {:.2} | {:.0} | {:.2} | {}{} |",
            km(s.start_m),
            km(s.length_m),
            label(s.way),
            c.factor,
            c.extra_m,
            c.cost / c.span.length_m.max(1e-3),
            reasons(&c.why),
            closed(c),
        );
    }
    // the aggregate: per way type and surface, and per preference over the whole route
    let n = u32::try_from(r.arcs.len()).unwrap_or(u32::MAX);
    let whole = planner
        .stretch_costs(profile, &r.arcs, &[[0, n]], PrefId::ALL.len())
        .map_err(run_err)?;
    let costs_all = planner.arc_costs(profile).map_err(run_err)?.0.to_vec();
    let g = planner.graph();
    let mut classes: Vec<((String, String), f32, f32)> = Vec::new();
    for &a in &r.arcs {
        let e = arc_edge(a);
        let len = g.length_m(e);
        let c = costs_all[a as usize];
        let key = (label(way_kind(g, e)), reported_surface(g, e).label().to_owned());
        let cost = if c.is_finite() { c } else { f32::NAN };
        match classes.iter_mut().find(|x| x.0 == key) {
            Some(x) => {
                x.1 += len;
                x.2 += cost;
            }
            None => classes.push((key, len, cost)),
        }
    }
    classes.sort_by(|a, b| b.1.total_cmp(&a.1));
    let total: f32 = classes.iter().map(|c| c.1).sum::<f32>().max(1e-3);
    let _ = writeln!(out, "\nby way and surface:");
    let _ = writeln!(out, "| way | surface | length | share | cost/m |");
    let _ = writeln!(out, "|---|---|---:|---:|---:|");
    for ((way, surface), len, cost) in &classes {
        let _ = writeln!(
            out,
            "| {way} | {surface} | {} | {:.0} % | {:.2} |",
            km(*len),
            len / total * 100.0,
            cost / len.max(1e-3)
        );
    }
    if let Some(w) = whole.first() {
        let _ = writeln!(
            out,
            "\nwhole route: {}, cost {}, mean factor {:.2}, extra {:.0} m{}",
            km(w.span.length_m),
            km(w.cost),
            w.factor,
            w.extra_m,
            closed(w)
        );
        let _ = writeln!(out, "| preference | weight | mean factor |");
        let _ = writeln!(out, "|---|---:|---:|");
        for r in &w.why {
            let _ = writeln!(
                out,
                "| {} | {} | {:.3} |",
                r.id,
                profile.weight(r.id).unwrap_or(0),
                r.factor
            );
        }
    }
    Ok(out)
}

/// The route against one forced through `via`, stretch by stretch.
pub(crate) fn why_not(
    planner: &mut Planner,
    profile: &Profile,
    a: &RouteResult,
    b: &RouteResult,
) -> Result<String, Failure> {
    let c = planner
        .compare(&kompass_core::explain::CompareRequest {
            profile: profile.clone(),
            a: a.arcs.clone(),
            b: b.arcs.clone(),
        })
        .map_err(run_err)?;
    let mut out = String::new();
    let _ = writeln!(
        out,
        "why not this way: the route {} at cost {}; through the point {} at cost {} ({:+.0} m, cost {:+.0} m)",
        km(c.a.span.length_m),
        km(c.a.cost),
        km(c.b.span.length_m),
        km(c.b.cost),
        c.b.span.length_m - c.a.span.length_m,
        c.b.cost - c.a.cost,
    );
    for (i, s) in c.stretches.iter().enumerate() {
        let _ = writeln!(
            out,
            "\nstretch {i}: route at {}, through the point at {}: length {:+.0} m, cost {:+.0} m",
            km(s.a.span.start_m),
            km(s.b.span.start_m),
            s.length_delta_m,
            s.cost_delta
        );
        for (name, side) in [("route", &s.a), ("point", &s.b)] {
            let _ = writeln!(
                out,
                "  {name}: {}, cost {}, factor {:.2}, extra {:.0} m [{}] why: {}{}",
                km(side.span.length_m),
                km(side.cost),
                side.factor,
                side.extra_m,
                ways(side),
                reasons(&side.why),
                closed(side)
            );
        }
    }
    Ok(out)
}

fn value(v: Option<&AttrValue>) -> String {
    match v {
        None => "?".into(),
        Some(AttrValue::Text(s)) => s.clone(),
        Some(AttrValue::Number(n)) => format!("{n}"),
        Some(AttrValue::Flag(b)) => b.to_string(),
    }
}

fn direction(out: &mut String, name: &str, len: f32, d: &ArcCostExplanation) {
    let _ = writeln!(out, "\n{name} (arc {}):", d.arc);
    if !d.closed_by.is_empty() {
        let words: Vec<String> = d.closed_by.iter().map(describe_closure).collect();
        let _ = writeln!(out, "  closed by {}", words.join(", "));
    }
    let _ = writeln!(out, "  | preference | weight | membership | factor | role |");
    let _ = writeln!(out, "  |---|---:|---:|---:|---|");
    for t in &d.preferences {
        let role = serde_json::to_value(t.role)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        let _ = writeln!(
            out,
            "  | {} | {} | {:.2} | {:.3} | {role} |",
            t.id, t.weight, t.membership, t.factor
        );
    }
    let clamp = d.clamp.map_or(String::new(), |c| {
        format!(
            " (clamped to the {})",
            if c == kompass_core::cost::Clamp::Min {
                "min"
            } else {
                "max"
            }
        )
    });
    let _ = writeln!(
        out,
        "  quality {:.3} × (1 + (bonus {:.3} − 1) × gate {:.2}) = {:.3} → factor {:.3}{clamp}",
        d.quality, d.bonus, d.gate, d.raw_factor, d.factor
    );
    let adds: Vec<String> = d
        .additive
        .iter()
        .map(|a| {
            let k = serde_json::to_value(a.kind)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default();
            format!("{k} {:.1} m", a.metres)
        })
        .collect();
    let _ = writeln!(
        out,
        "  ascent {:.1} m, grade up {:.0} % / down {:.0} %; additive: {}",
        d.ascent_m,
        d.grade_up_pct,
        d.grade_down_pct,
        if adds.is_empty() {
            "none".into()
        } else {
            adds.join(", ")
        }
    );
    match d.cost {
        Some(c) => {
            let _ = writeln!(
                out,
                "  cost {len:.1} m × {:.3} + {:.1} m = {c:.1} m ({:.3} per metre)",
                d.factor,
                d.extra_m,
                d.cost_per_m.unwrap_or(0.0)
            );
        }
        None => {
            let _ = writeln!(out, "  cost: closed");
        }
    }
}

/// One edge as text.
pub(crate) fn edge_text(x: &EdgeExplanation) -> String {
    let mut out = String::new();
    let source = serde_json::to_value(x.surface_source)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    let _ = writeln!(
        out,
        "edge {}: {:.1} m, {}, surface for the cost {} ({source}), traffic {:.2}{}; bounds {} … {}",
        x.edge,
        x.length_m,
        label(x.way),
        x.cost_surface,
        x.traffic,
        if x.traffic_from == TrafficFrom::Alongside {
            " (from the road alongside)"
        } else {
            ""
        },
        x.bounds.min_factor,
        x.bounds.max_factor
    );
    let attrs: Vec<String> = x
        .attributes
        .iter()
        .map(|a| format!("{}={}", a.attribute, value(a.value.as_ref())))
        .collect();
    let _ = writeln!(out, "  {}", attrs.join(" "));
    direction(&mut out, "along", x.length_m, &x.along);
    direction(&mut out, "against", x.length_m, &x.against);
    out
}

/// `kompass explain --build <dir> --profile <file|preset> --edge <id> [--json]`, plus the timing
/// of the bulk edge costs (`--time`).
pub(crate) fn run(a: &Args) -> Result<(), Failure> {
    a.only(&["--build", "--profile", "--edge"])?;
    let build = a.build()?;
    let profile = load_profile(
        a.get("--profile")
            .ok_or_else(|| Failure::Usage("--profile <file|preset> is required".into()))?,
    )?;
    let (graph, _) = kompass_compile::build::load(&build, true)?;
    let mut planner = Planner::new(graph);
    if a.switch("--time") {
        return time_edge_costs(&mut planner, &profile);
    }
    let edge: u32 = a
        .get("--edge")
        .ok_or_else(|| Failure::Usage("--edge <id> is required (or --time)".into()))?
        .parse()
        .map_err(|_| Failure::Usage("--edge must be an edge id".into()))?;
    let x = planner
        .explain_edge(&ExplainEdgeRequest {
            profile: profile.clone(),
            edge,
        })
        .map_err(run_err)?;
    if a.switch("--json") {
        println!(
            "{}",
            serde_json::to_string_pretty(&x).map_err(|e| Failure::Run(e.to_string()))?
        );
    } else {
        print!("{}", edge_text(&x));
    }
    Ok(())
}

/// The bulk edge costs' timing: every edge, a viewport-sized list, a box.
#[allow(clippy::cast_precision_loss, reason = "timings")]
fn time_edge_costs(planner: &mut Planner, profile: &Profile) -> Result<(), Failure> {
    let t = Instant::now();
    planner.prepare(profile).map_err(run_err)?;
    let compile_ms = t.elapsed().as_secs_f64() * 1e3;
    let m = planner.graph().edge_count();
    let median = |f: &mut dyn FnMut() -> usize| {
        let mut ms = Vec::new();
        let mut n = 0;
        for _ in 0..7 {
            let t = Instant::now();
            n = f();
            ms.push(t.elapsed().as_secs_f64() * 1e3);
        }
        ms.sort_by(f64::total_cmp);
        (ms[3], n)
    };
    let (all_ms, _) = median(&mut || {
        planner
            .edge_costs(profile, &EdgeSelection::All)
            .map_or(0, |c| c.edges.len())
    });
    let list: Vec<u32> = (0..u32::try_from(m).unwrap_or(u32::MAX))
        .step_by((m / 20_000).max(1))
        .collect();
    let (list_ms, list_n) = median(&mut || {
        planner
            .edge_costs(profile, &EdgeSelection::List(list.clone()))
            .map_or(0, |c| c.edges.len())
    });
    // a box of a fifth of the region's width, in its middle
    let b = planner.graph().info().bounds();
    let (cx, cy) = (f64::midpoint(b[0], b[2]), f64::midpoint(b[1], b[3]));
    let (hx, hy) = ((b[2] - b[0]) / 10.0, (b[3] - b[1]) / 10.0);
    let bbox = [cx - hx, cy - hy, cx + hx, cy + hy];
    let (box_ms, box_n) = median(&mut || {
        planner
            .edge_costs(profile, &EdgeSelection::Bbox(bbox))
            .map_or(0, |c| c.edges.len())
    });
    println!("compile {compile_ms:.1} ms (cached afterwards)");
    println!(
        "edge costs, median of 7: all {m} edges {all_ms:.1} ms; a list of {list_n} {list_ms:.2} ms; a box of {box_n} {box_ms:.2} ms"
    );
    Ok(())
}
