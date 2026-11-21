//! `kompass match --build <dir> [options] <gpx files or directories>`: map-matches recorded tracks
//! onto the graph and prints aggregate numbers only (`docs/matching.md`): rides, the share of the
//! track inside the region, the matched share, chain breaks and time per 100 km. Geometry loads
//! per tile, only where the tracks are, exactly as the browser does.
//!
//! - `--geojson <dir>`: one `GeoJSON` per ride (the matched path and the unmatched stretches).
//! - `--explored <file>`: the folded explored map as JSON,
//!   `{ "graphBuild": …, "edges": { "<id>": { "count", "lastRidden", "countAlong", "countAgainst" } } }`
//!   (`lastRidden`: milliseconds since the epoch at the start of the ride's last day, 0 if untimed).
//!
//! Both outputs hold the rider's real tracks and edge ids: write them to gitignored or temporary
//! directories only.

#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "counts and display values"
)]

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use kompass_core::matching::{
    Explored, Match, MatchParams, Matcher, RideMatchRef, TileGrids, dist_m, missing_geometry, needed_tiles_of,
};
use kompass_core::{Graph, LngLat};

use crate::Failure;
use crate::gpx;

/// "Inside the region": a track point with an edge within this distance.
const REGION_RADIUS_M: f64 = 300.0;

struct Opts {
    build: PathBuf,
    geojson: Option<PathBuf>,
    explored: Option<PathBuf>,
    geometry: bool,
    params: MatchParams,
    inputs: Vec<PathBuf>,
}

fn parse(args: &[String]) -> Result<Opts, Failure> {
    let mut o = Opts {
        build: PathBuf::new(),
        geojson: None,
        explored: None,
        geometry: true,
        params: MatchParams::default(),
        inputs: Vec::new(),
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
            "--geojson" => o.geojson = Some(PathBuf::from(value()?)),
            "--explored" => o.explored = Some(PathBuf::from(value()?)),
            "--no-geometry" => o.geometry = false,
            "--radius" => p.radius_m = num()?,
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
            f if f.starts_with("--") => return Err(Failure::Usage(format!("unknown option `{f}`"))),
            f => o.inputs.push(PathBuf::from(f)),
        }
    }
    if o.build.as_os_str().is_empty() {
        return Err(Failure::Usage("--build <dir> is required".into()));
    }
    if o.inputs.is_empty() {
        return Err(Failure::Usage("no GPX files or directories given".into()));
    }
    Ok(o)
}

fn io(e: &std::io::Error, what: &Path) -> Failure {
    Failure::Run(format!("{}: {e}", what.display()))
}

/// The `.gpx` files among the inputs: files as given, directories scanned (sorted).
pub(crate) fn gpx_files(inputs: &[PathBuf]) -> Result<Vec<PathBuf>, Failure> {
    let mut files = Vec::new();
    for p in inputs {
        if p.is_dir() {
            let mut found: Vec<PathBuf> = fs::read_dir(p)
                .map_err(|e| io(&e, p))?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|f| f.extension().is_some_and(|x| x.eq_ignore_ascii_case("gpx")))
                .collect();
            found.sort();
            files.extend(found);
        } else {
            files.push(p.clone());
        }
    }
    Ok(files)
}

/// The geometry tile files, read on demand.
struct Geometry {
    paths: Vec<PathBuf>,
    loaded: usize,
    bytes: u64,
}

impl Geometry {
    fn load(&mut self, g: &mut Graph, tiles: &[usize]) -> Result<(), Failure> {
        for &t in tiles {
            let path = self
                .paths
                .get(t)
                .ok_or_else(|| Failure::Run(format!("no geometry file for tile {t}")))?;
            let bytes = fs::read(path).map_err(|e| io(&e, path))?;
            self.bytes += bytes.len() as u64;
            g.add_geometry(&bytes)
                .map_err(|e| Failure::Run(format!("{}: {e}", path.display())))?;
            self.loaded += 1;
        }
        Ok(())
    }
}

/// Share of the track (by length) whose points have an edge within [`REGION_RADIUS_M`].
fn in_region(g: &Graph, grids: &TileGrids, pts: &[LngLat]) -> f64 {
    let mut buf = Vec::with_capacity(1);
    let inside: Vec<bool> = pts
        .iter()
        .map(|&p| {
            grids.snap_into(g, p, REGION_RADIUS_M, 1, &mut buf);
            !buf.is_empty()
        })
        .collect();
    let (mut a, mut t) = (0.0, 0.0);
    for i in 1..pts.len() {
        let d = dist_m(pts[i - 1], pts[i]);
        t += d;
        if inside[i - 1] && inside[i] {
            a += d;
        }
    }
    if t > 0.0 { a / t } else { 0.0 }
}

#[derive(Default)]
struct Totals {
    rides: u32,
    inside: u32,
    partial: u32,
    outside: u32,
    track_m: f64,
    region_m: f64,
    matched_m: f64,
    path_m: f64,
    contra_m: f64,
    breaks: u32,
    spurs: u32,
    match_ms: f64,
    match_m: f64,
}

#[allow(
    clippy::too_many_lines,
    reason = "a driver: read the tracks, match, print the aggregates"
)]
pub fn run(args: &[String]) -> Result<(), Failure> {
    let o = parse(args)?;
    let files = gpx_files(&o.inputs)?;
    let t = Instant::now();
    let (mut graph, _) = kompass_compile::build::load(&o.build, false)?;
    let mut geometry = Geometry {
        paths: if o.geometry {
            kompass_compile::build::geometry_paths(&o.build)?
        } else {
            Vec::new()
        },
        loaded: 0,
        bytes: 0,
    };
    let load_ms = t.elapsed().as_secs_f64() * 1e3;
    let tiles = graph.info().tiles.len();
    let mut grids = TileGrids::new(&graph);
    let mut matcher = Matcher::new(o.params);
    for d in [&o.geojson].into_iter().flatten() {
        fs::create_dir_all(d).map_err(|e| io(&e, d))?;
    }
    let mut tot = Totals::default();
    let mut prep_ms = 0.0;
    let mut rides: Vec<(Vec<u32>, Vec<u8>, u32)> = Vec::new();
    for file in &files {
        let text = fs::read_to_string(file).map_err(|e| io(&e, file))?;
        let tr = gpx::parse(&text);
        if tr.points.len() < 2 {
            continue;
        }
        let pts = &tr.points;
        // the tiles within reach of the track (the region check reaches further than the matcher)
        let t = Instant::now();
        let reach = REGION_RADIUS_M.max(matcher.params.radius_m);
        let needed = needed_tiles_of(&graph, reach, pts.iter().copied());
        if o.geometry {
            let missing = missing_geometry(&graph, &needed);
            geometry.load(&mut graph, &missing)?;
        }
        grids.ensure(&graph, &needed);
        prep_ms += t.elapsed().as_secs_f64() * 1e3;

        let share = in_region(&graph, &grids, pts);
        let t = Instant::now();
        let m = matcher.match_track(&graph, &mut grids, pts);
        tot.match_ms += t.elapsed().as_secs_f64() * 1e3;
        let r = m.to_result();
        tot.rides += 1;
        if share >= 0.99 {
            tot.inside += 1;
        } else if share <= 0.01 {
            tot.outside += 1;
        } else {
            tot.partial += 1;
        }
        tot.track_m += m.stats.track_m;
        tot.region_m += m.stats.track_m * share;
        tot.matched_m += m.stats.matched_m;
        tot.path_m += m.stats.path_m;
        tot.contra_m += m.stats.contra_oneway_m;
        tot.breaks += r.breaks;
        tot.spurs += m.stats.spurs;
        tot.match_m += m.stats.track_m;
        let day = tr
            .times
            .iter()
            .rev()
            .flatten()
            .next()
            .map_or(0, |&ms| (ms / 86_400_000.0).floor().max(0.0) as u32);
        rides.push((r.arcs, r.coverage, day));
        if let Some(dir) = &o.geojson {
            let name = file.file_stem().map_or_else(
                || format!("ride{}", tot.rides),
                |s| s.to_string_lossy().into_owned(),
            );
            let out = dir.join(format!("{name}.geojson"));
            fs::write(&out, geojson(&graph, pts, &m)).map_err(|e| io(&e, &out))?;
        }
    }

    let pct = |a: f64, b: f64| if b > 0.0 { a * 100.0 / b } else { 0.0 };
    println!(
        "rides: {} ({} in the region, {} partly, {} outside), {:.0} km, {:.0} km in the region",
        tot.rides,
        tot.inside,
        tot.partial,
        tot.outside,
        tot.track_m / 1e3,
        tot.region_m / 1e3
    );
    println!(
        "matched: {:.2} % of the in-region track; path / matched track {:.4}; against a one-way {:.2} % of the path",
        pct(tot.matched_m, tot.region_m),
        tot.path_m / tot.matched_m.max(1.0),
        pct(tot.contra_m, tot.path_m)
    );
    println!(
        "breaks: {:.2} per 100 km (in region); spurs removed: {:.1} per 100 km",
        f64::from(tot.breaks) / (tot.region_m / 1e5).max(1e-9),
        f64::from(tot.spurs) / (tot.region_m / 1e5).max(1e-9)
    );
    println!(
        "time: {:.1} ms per 100 km matching ({:.2} s for {:.0} km); graph {load_ms:.0} ms; geometry {} of {tiles} tiles \
         ({:.1} MB) and grids {} of {tiles}: {prep_ms:.0} ms; matcher scratch {:.0} kB, grids {:.1} MB",
        tot.match_ms / (tot.match_m / 1e5).max(1e-9),
        tot.match_ms / 1e3,
        tot.match_m / 1e3,
        geometry.loaded,
        geometry.bytes as f64 / 1e6,
        grids.built(),
        matcher.heap_bytes() as f64 / 1e3,
        grids.heap_bytes() as f64 / 1e6
    );

    if let Some(file) = &o.explored {
        let x = Explored::fold(rides.iter().map(|(arcs, coverage, day)| RideMatchRef {
            arcs,
            coverage,
            day: *day,
        }));
        let km: f64 = x
            .edges
            .iter()
            .map(|e| f64::from(graph.length_m(e.edge)))
            .sum::<f64>()
            / 1e3;
        let mut s = format!("{{\"graphBuild\":{:?},\"edges\":{{", graph.info().build_id);
        for (i, e) in x.edges.iter().enumerate() {
            let _ = write!(
                s,
                "{}\"{}\":{{\"count\":{},\"lastRidden\":{},\"countAlong\":{},\"countAgainst\":{}}}",
                if i > 0 { "," } else { "" },
                e.edge,
                e.count,
                u64::from(e.last_day) * 86_400_000,
                e.along.count,
                e.against.count
            );
        }
        s.push_str("}}\n");
        fs::write(file, s).map_err(|e| io(&e, file))?;
        println!("explored: {} edges, {km:.0} km", x.len());
    }
    Ok(())
}

// --- GeoJSON ----------------------------------------------------------------------------------

fn edge_points(g: &Graph, e: u32) -> Vec<(f64, f64)> {
    g.edge_points(e)
        .map(|(x, y)| (f64::from(x) * 1e-7, f64::from(y) * 1e-7))
        .collect()
}

/// The part of a polyline between two fractions of its length.
fn cut(pts: &[(f64, f64)], a: f32, b: f32) -> Vec<(f64, f64)> {
    let (lo, hi) = (f64::from(a.min(b)), f64::from(a.max(b)));
    let kx = pts.first().map_or(1.0, |p| p.1.to_radians().cos());
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

fn line(s: &mut String, pts: &[(f64, f64)]) {
    s.push('[');
    for (i, (x, y)) in pts.iter().enumerate() {
        let _ = write!(s, "{}[{x:.6},{y:.6}]", if i > 0 { "," } else { "" });
    }
    s.push(']');
}

/// A `FeatureCollection`: one `MultiLineString` per matched piece direction (`along`, `against`: in
/// riding order) and one for the unmatched
/// stretches of the track.
fn geojson(g: &Graph, pts: &[LngLat], m: &Match) -> String {
    let mut s = String::from("{\"type\":\"FeatureCollection\",\"features\":[");
    for (k, (name, reverse)) in [("along", false), ("against", true)].into_iter().enumerate() {
        let _ = write!(
            s,
            "{}{{\"type\":\"Feature\",\"properties\":{{\"kind\":\"{name}\"}},\"geometry\":{{\"type\":\"MultiLineString\",\"coordinates\":[",
            if k > 0 { "," } else { "" }
        );
        let mut first = true;
        for pc in m.pieces.iter().filter(|p| p.reverse == reverse) {
            let part = cut(&edge_points(g, pc.edge), pc.start, pc.end);
            if part.len() < 2 {
                continue;
            }
            if !first {
                s.push(',');
            }
            first = false;
            // in riding order: against pieces run from the edge's end to its start
            if reverse {
                line(&mut s, &part.iter().rev().copied().collect::<Vec<_>>());
            } else {
                line(&mut s, &part);
            }
        }
        s.push_str("]}}");
    }
    s.push_str(",{\"type\":\"Feature\",\"properties\":{\"kind\":\"unmatched\"},\"geometry\":{\"type\":\"MultiLineString\",\"coordinates\":[");
    for (i, u) in m.unmatched.iter().enumerate() {
        let part: Vec<(f64, f64)> = pts[u.first_point as usize..=u.last_point as usize]
            .iter()
            .map(|p| (p.lng, p.lat))
            .collect();
        if i > 0 {
            s.push(',');
        }
        line(&mut s, &part);
    }
    s.push_str("]}}]}\n");
    s
}
