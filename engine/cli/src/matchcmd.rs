//! `kompass match --build <dir> [options] <gpx…>`: map-matches recorded tracks onto the graph
//! (spike #5). Prints aggregate numbers only; with `--out <dir>` writes one JSON per track (the
//! matched pieces, unmatched stretches, counters) for the analysis, with `--svg <dir>` debug
//! pictures of the unmatched stretches and of random windows. Both hold real coordinates or edge
//! ids of the user's rides: point them at gitignored or temporary directories only.

#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::many_single_char_names,
    reason = "spike driver: counts and display values; geometry reads best with short names"
)]

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use kompass_core::matching::{Match, MatchParams, Matcher};
use kompass_core::spatial::{DEFAULT_CELL_M, Grid};
use kompass_core::{Graph, LngLat};
use serde_json::{Value, json};

use crate::Failure;
use crate::gpx;

struct Opts {
    build: PathBuf,
    out: Option<PathBuf>,
    svg: Option<PathBuf>,
    points_out: Option<PathBuf>,
    /// JSON `{ "<file stem>": [point index…] }`: picture windows instead of the default ones.
    svg_at: Option<PathBuf>,
    /// JSON lines of the in-region unmatched stretches' points (every ~20 m), for the OSM check.
    unmatched_out: Option<PathBuf>,
    geometry: bool,
    reverse: bool,
    offset: usize,
    params: MatchParams,
    files: Vec<PathBuf>,
}

fn parse(args: &[String]) -> Result<Opts, Failure> {
    let mut o = Opts {
        build: PathBuf::new(),
        out: None,
        svg: None,
        points_out: None,
        svg_at: None,
        unmatched_out: None,
        geometry: true,
        reverse: false,
        offset: 0,
        params: MatchParams::default(),
        files: Vec::new(),
    };
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let mut value = || {
            it.next()
                .ok_or_else(|| Failure::Usage(format!("{flag} needs a value")))
        };
        let mut num = || -> Result<f64, Failure> {
            value()?
                .parse()
                .map_err(|_| Failure::Usage(format!("{flag} needs a number")))
        };
        let p = &mut o.params;
        match flag.as_str() {
            "--build" => o.build = PathBuf::from(value()?),
            "--out" => o.out = Some(PathBuf::from(value()?)),
            "--svg" => o.svg = Some(PathBuf::from(value()?)),
            "--points-out" => o.points_out = Some(PathBuf::from(value()?)),
            "--no-geometry" => o.geometry = false,
            "--reverse" => o.reverse = true,
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "a count")]
            "--offset" => o.offset = num()? as usize,
            "--radius" => p.radius_m = num()?,
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "a count")]
            "--candidates" => p.max_candidates = num()? as usize,
            "--sigma" => p.sigma_m = num()?,
            "--beta" => p.beta_m = num()?,
            "--step" => p.min_step_m = num()?,
            "--skip" => p.max_skip_m = num()?,
            "--gap" => p.max_gap_m = num()?,
            "--detour-factor" => p.detour_factor = num()?,
            "--detour-slack" => p.detour_slack_m = num()?,
            "--oneway-penalty" => p.oneway_penalty = num()?,
            "--spur" => p.spur_m = num()?,
            "--unmatched-out" => o.unmatched_out = Some(PathBuf::from(value()?)),
            "--svg-at" => o.svg_at = Some(PathBuf::from(value()?)),
            f if f.starts_with("--") => return Err(Failure::Usage(format!("unknown option `{f}`"))),
            f => o.files.push(PathBuf::from(f)),
        }
    }
    if o.build.as_os_str().is_empty() {
        return Err(Failure::Usage("--build <dir> is required".into()));
    }
    Ok(o)
}

/// Region check: the share of the track (by length) whose points have an edge within 300 m.
fn in_region(g: &Graph, grid: &Grid, pts: &[LngLat]) -> (f64, Vec<bool>) {
    let mut buf = Vec::with_capacity(1);
    let inside: Vec<bool> = pts
        .iter()
        .map(|&p| {
            grid.snap_into(g, p, 300.0, 1, &mut buf);
            !buf.is_empty()
        })
        .collect();
    let (mut a, mut t) = (0.0, 0.0);
    for i in 1..pts.len() {
        let d = kompass_core::matching::dist_m(pts[i - 1], pts[i]);
        t += d;
        if inside[i - 1] && inside[i] {
            a += d;
        }
    }
    (if t > 0.0 { a / t } else { 0.0 }, inside)
}

#[allow(clippy::too_many_lines, reason = "a spike's driver")]
pub fn run(args: &[String]) -> Result<(), Failure> {
    let o = parse(args)?;
    let t = Instant::now();
    let (graph, _) = kompass_compile::build::load(&o.build, o.geometry)?;
    let load_ms = t.elapsed().as_secs_f64() * 1e3;
    let t = Instant::now();
    let grid = Grid::build(&graph, DEFAULT_CELL_M);
    let grid_ms = t.elapsed().as_secs_f64() * 1e3;
    let mut matcher = Matcher::new(&graph, o.params);
    eprintln!(
        "graph {} edges, geometry {}, loaded {load_ms:.0} ms, grid {grid_ms:.0} ms; params {:?}",
        graph.edge_count(),
        o.geometry,
        o.params
    );
    let svg_at: Option<Value> = match &o.svg_at {
        Some(p) => Some(serde_json::from_slice(&fs::read(p)?)?),
        None => None,
    };
    for d in [&o.out, &o.svg, &o.points_out].into_iter().flatten() {
        fs::create_dir_all(d)?;
    }
    let mut unmatched_lines = String::new();
    let (mut tot_track, mut tot_region, mut tot_matched, mut tot_path, mut tot_ms) =
        (0.0, 0.0, 0.0, 0.0, 0.0);
    let mut n = 0;
    for (k, file) in o.files.iter().enumerate() {
        let text = fs::read_to_string(file)?;
        let mut tr = gpx::parse(&text);
        if o.reverse {
            tr.points.reverse();
            tr.times.reverse();
        }
        let skip = o.offset.min(tr.points.len());
        let pts = &tr.points[skip..];
        let times = &tr.times[skip..];
        if pts.len() < 2 {
            continue;
        }
        let (region_share, inside) = in_region(&graph, &grid, pts);
        let t = Instant::now();
        let m = matcher.match_track(&graph, &grid, pts);
        let ms = t.elapsed().as_secs_f64() * 1e3;
        n += 1;
        tot_track += m.stats.track_m;
        tot_region += m.stats.track_m * region_share;
        tot_matched += m.stats.matched_m;
        tot_path += m.stats.path_m;
        tot_ms += ms;
        if o.unmatched_out.is_some() {
            for u in &m.unmatched {
                let r = u.first_point as usize..=u.last_point as usize;
                let ins = inside[r.clone()].iter().filter(|&&x| x).count();
                if u.length_m < 20.0 || (ins as f64) < 0.9 * r.clone().count() as f64 {
                    continue;
                }
                let mut sample = Vec::new();
                let mut last: Option<LngLat> = None;
                for &q in &pts[r] {
                    if last.is_none_or(|l| kompass_core::matching::dist_m(l, q) >= 20.0) {
                        sample.push(json!([q.lng, q.lat]));
                        last = Some(q);
                    }
                }
                // distance of each sampled point to the nearest graph edge (null: none within 40 m)
                let mut near = Vec::new();
                let mut buf = Vec::new();
                for q in &sample {
                    let p = LngLat {
                        lng: q[0].as_f64().unwrap_or(0.0),
                        lat: q[1].as_f64().unwrap_or(0.0),
                    };
                    grid.snap_into(&graph, p, 40.0, 1, &mut buf);
                    near.push(buf.first().map(|s| s.distance_m.round()));
                }
                let line =
                    json!({ "ride": k, "length_m": u.length_m.round(), "points": sample, "near": near });
                unmatched_lines.push_str(&line.to_string());
                unmatched_lines.push('\n');
            }
        }
        if let Some(dir) = &o.points_out {
            let mut b = Vec::with_capacity(pts.len() * 16);
            for p in pts {
                b.extend_from_slice(&p.lng.to_le_bytes());
                b.extend_from_slice(&p.lat.to_le_bytes());
            }
            fs::write(dir.join(format!("{k}.bin")), b)?;
        }
        if let Some(dir) = &o.out {
            let v = ride_json(&graph, file, &m, times, &inside, region_share, ms);
            let name = file
                .file_stem()
                .map_or_else(|| format!("{k}"), |s| s.to_string_lossy().into_owned());
            fs::write(dir.join(format!("{name}.json")), serde_json::to_vec(&v)?)?;
        }
        if let Some(dir) = &o.svg {
            let name = file
                .file_stem()
                .map_or_else(|| format!("{k}"), |s| s.to_string_lossy().into_owned());
            let at = svg_at.as_ref().map(|v| {
                v.get(&name).and_then(Value::as_array).map_or_else(Vec::new, |a| {
                    a.iter()
                        .filter_map(Value::as_u64)
                        .map(|i| {
                            let i = (i as usize).min(pts.len() - 1);
                            if o.reverse { pts.len() - 1 - i } else { i }
                        })
                        .collect::<Vec<_>>()
                })
            });
            pictures(&graph, dir, &name, pts, &m, at.as_deref())?;
        }
    }
    if let Some(f) = &o.unmatched_out {
        fs::write(f, unmatched_lines)?;
    }
    let pct = |a: f64, b: f64| if b > 0.0 { a * 100.0 / b } else { 0.0 };
    println!(
        "{n} tracks, {:.0} km ({:.0} km in region): matched {:.1} % of the in-region track, path/matched {:.3}, \
         {:.0} ms total, {:.1} ms per 100 km; matcher scratch {:.1} MB",
        tot_track / 1e3,
        tot_region / 1e3,
        pct(tot_matched, tot_region),
        tot_path / tot_matched.max(1.0),
        tot_ms,
        tot_ms / (tot_track / 1e5).max(1e-9),
        matcher.heap_bytes() as f64 / 1e6
    );
    Ok(())
}

fn ride_json(
    g: &Graph,
    file: &Path,
    m: &Match,
    times: &[Option<f64>],
    inside: &[bool],
    region_share: f64,
    ms: f64,
) -> Value {
    let t0 = times.iter().flatten().next().copied();
    let rel = |i: u32| -> Value {
        match (t0, times.get(i as usize).copied().flatten()) {
            (Some(a), Some(b)) => json!(((b - a) / 1000.0).round()),
            _ => Value::Null,
        }
    };
    let pieces: Vec<Value> = m
        .pieces
        .iter()
        .map(|p| {
            json!([
                p.edge,
                u8::from(p.reverse),
                (p.start * 1000.0).round() / 1000.0,
                (p.end * 1000.0).round() / 1000.0,
                (g.length_m(p.edge) * 10.0).round() / 10.0,
                rel(p.first_point),
                rel(p.last_point),
                p.first_point,
                p.last_point
            ])
        })
        .collect();
    let unmatched: Vec<Value> = m
        .unmatched
        .iter()
        .map(|u| {
            let ins = inside[u.first_point as usize..=u.last_point as usize]
                .iter()
                .filter(|&&x| x)
                .count();
            #[allow(clippy::cast_precision_loss, reason = "a share")]
            let share = ins as f64 / f64::from(u.last_point - u.first_point + 1);
            json!([
                (u.length_m * 10.0).round() / 10.0,
                u.first_point,
                u.last_point,
                (share * 100.0).round() / 100.0
            ])
        })
        .collect();
    let s = m.stats;
    json!({
        "file": file.file_name().map(|f| f.to_string_lossy().into_owned()),
        "start": t0, "end": times.iter().rev().flatten().next().copied(),
        "ms": (ms * 100.0).round() / 100.0,
        "region_share": (region_share * 1000.0).round() / 1000.0,
        "points": s.points, "kept": s.kept, "no_candidates": s.no_candidates, "unreachable": s.unreachable,
        "candidates": s.candidates, "searches": s.searches, "settled": s.settled,
        "track_m": s.track_m.round(), "matched_m": s.matched_m.round(), "path_m": s.path_m.round(),
        "contra_oneway_m": s.contra_oneway_m.round(), "spurs": s.spurs,
        "dist_hist_m": s.dist_hist_m.map(f64::round), "bridged_m": s.bridged_m.round(),
        "forest_m": s.forest_m.round(), "far_forest_m": s.far_forest_m.round(),
        "chains": m.chains.len(),
        "unmatched": unmatched,
        "pieces": pieces,
    })
}

// --- debug pictures ---------------------------------------------------------------------------

struct View {
    lng0: f64,
    lat0: f64,
    kx: f64,
    half_m: f64,
}

impl View {
    fn xy(&self, p: (f64, f64)) -> (f64, f64) {
        let m = kompass_core::M_PER_E7 * 1e7;
        let x = (p.0 - self.lng0) * self.kx * m;
        let y = (p.1 - self.lat0) * m;
        // 800 px for the window
        let s = 400.0 / self.half_m;
        (400.0 + x * s, 400.0 - y * s)
    }

    fn inside(&self, p: (f64, f64)) -> bool {
        let (x, y) = self.xy(p);
        (-50.0..850.0).contains(&x) && (-50.0..850.0).contains(&y)
    }
}

fn edge_pts(g: &Graph, e: u32) -> Vec<(f64, f64)> {
    g.edge_points(e)
        .map(|(x, y)| (f64::from(x) * 1e-7, f64::from(y) * 1e-7))
        .collect()
}

/// The part of a polyline between two fractions of its length.
fn cut(pts: &[(f64, f64)], a: f32, b: f32, kx: f64) -> Vec<(f64, f64)> {
    let (lo, hi) = (f64::from(a.min(b)), f64::from(a.max(b)));
    let seg: Vec<f64> = pts
        .windows(2)
        .map(|w| ((w[1].0 - w[0].0) * kx).hypot(w[1].1 - w[0].1))
        .collect();
    let total: f64 = seg.iter().sum();
    if total <= 0.0 {
        return pts.to_vec();
    }
    let lerp = |i: usize, t: f64| {
        (
            pts[i].0 + (pts[i + 1].0 - pts[i].0) * t,
            pts[i].1 + (pts[i + 1].1 - pts[i].1) * t,
        )
    };
    let mut out = Vec::new();
    let mut acc = 0.0;
    for (i, &l) in seg.iter().enumerate() {
        let (s0, s1) = (acc / total, (acc + l) / total);
        if s1 >= lo && s0 <= hi && l > 0.0 {
            let ta = ((lo - s0) * total / l).clamp(0.0, 1.0);
            let tb = ((hi - s0) * total / l).clamp(0.0, 1.0);
            if out.is_empty() {
                out.push(lerp(i, ta));
            }
            out.push(lerp(i, tb));
        }
        acc += l;
    }
    out
}

fn polyline(svg: &mut String, v: &View, pts: &[(f64, f64)], style: &str) {
    if pts.len() < 2 {
        return;
    }
    svg.push_str("<polyline points=\"");
    for &p in pts {
        let (x, y) = v.xy(p);
        let _ = write!(svg, "{x:.1},{y:.1} ");
    }
    let _ = writeln!(svg, "\" fill=\"none\" {style}/>");
}

/// Writes pictures of a track: every unmatched stretch over 50 m (up to 6) and 2 windows at fixed
/// positions along the track. Grey: graph edges; blue / purple: matched path along / against the
/// edge's direction; red: the track (dots: points); orange: unmatched track.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "indices"
)]
fn pictures(
    g: &Graph,
    dir: &Path,
    name: &str,
    pts: &[LngLat],
    m: &Match,
    at: Option<&[usize]>,
) -> Result<(), Failure> {
    let mut centers: Vec<(String, usize, f64)> = Vec::new();
    if let Some(at) = at {
        centers.extend(at.iter().enumerate().map(|(k, &i)| (format!("a{k}"), i, 200.0)));
    } else {
        for (k, u) in m
            .unmatched
            .iter()
            .filter(|u| u.length_m > 50.0)
            .take(6)
            .enumerate()
        {
            let mid = (u.first_point + u.last_point) as usize / 2;
            centers.push((format!("u{k}"), mid, (u.length_m * 0.4).clamp(250.0, 1500.0)));
        }
        for (k, f) in [0.3, 0.7].iter().enumerate() {
            centers.push((format!("w{k}"), ((pts.len() - 1) as f64 * f) as usize, 300.0));
        }
    }
    let n = g.edge_count() as u32;
    for (tag, c, half) in centers {
        let p = pts[c];
        let v = View {
            lng0: p.lng,
            lat0: p.lat,
            kx: p.lat.to_radians().cos(),
            half_m: half,
        };
        let mut svg = String::from(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"800\" height=\"800\"><rect width=\"800\" height=\"800\" fill=\"white\"/>\n",
        );
        let dlat = half * 1.2 / (kompass_core::M_PER_E7 * 1e7);
        let dlng = dlat / v.kx;
        for e in 0..n {
            let (a, b) = (g.node(g.from(e)), g.node(g.to(e)));
            if (a.lat - p.lat).abs().min((b.lat - p.lat).abs()) > dlat * 4.0
                || (a.lng - p.lng).abs().min((b.lng - p.lng).abs()) > dlng * 4.0
            {
                continue;
            }
            let ep = edge_pts(g, e);
            if ep.iter().any(|&q| v.inside(q)) {
                polyline(&mut svg, &v, &ep, "stroke=\"#bbb\" stroke-width=\"1.5\"");
            }
        }
        for pc in &m.pieces {
            let ep = edge_pts(g, pc.edge);
            if !ep.iter().any(|&q| v.inside(q)) {
                continue;
            }
            let col = if pc.reverse { "#a0f" } else { "#06f" };
            polyline(
                &mut svg,
                &v,
                &cut(&ep, pc.start, pc.end, v.kx),
                &format!("stroke=\"{col}\" stroke-width=\"5\" stroke-opacity=\"0.5\""),
            );
        }
        let tp: Vec<(f64, f64)> = pts.iter().map(|q| (q.lng, q.lat)).collect();
        polyline(&mut svg, &v, &tp, "stroke=\"#e00\" stroke-width=\"1\"");
        for u in &m.unmatched {
            polyline(
                &mut svg,
                &v,
                &tp[u.first_point as usize..=u.last_point as usize],
                "stroke=\"#f90\" stroke-width=\"3\"",
            );
        }
        for &q in &tp {
            if v.inside(q) {
                let (x, y) = v.xy(q);
                let _ = writeln!(
                    svg,
                    "<circle cx=\"{x:.1}\" cy=\"{y:.1}\" r=\"1.5\" fill=\"#e00\"/>"
                );
            }
        }
        let _ = writeln!(
            svg,
            "<text x=\"8\" y=\"20\" font-size=\"14\">{:.0} m wide</text></svg>",
            half * 2.0
        );
        fs::write(dir.join(format!("{name}-{tag}.svg")), svg)?;
    }
    Ok(())
}
