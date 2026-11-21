//! `kompass replay --build <dir> --profiles <a,b,...> [--ref <name>=<dir>]... [--leg-km <km>]
//! [--out-dir <dir>] <gpx files or directories>`: route quality against the lines the rider actually
//! rode. Each recorded ride is map-matched and cut into legs of about `--leg-km` (an A→B problem each,
//! from a graph node to a graph node); every profile routes each leg, and every reference router
//! (`--ref`, one GPX per leg named `ride<k>-leg<j>.gpx`, e.g. BRouter's output) is map-matched onto the
//! same graph, so all lines are arc lists measured the same way: length against the ridden line,
//! **overlap with the ridden line** (the share of the ridden length a line reproduces, and the share of
//! the line that was ridden), ascent, unpaved share, main roads, paths beside busy roads, the length at
//! the judge profile's `min_factor` clamp, closures, turns. The first profile is the judge: its cost of
//! every line, and per leg where its route leaves the ridden line, why (the `compare` stretches).
//!
//! Prints numbers and ride/leg indices only, no coordinates or file names. `--out-dir` gets the
//! private detail: `legs.json` (which file, the leg's end points: the input for a reference router),
//! one GeoJSON per leg with every line, and `stretches.txt` (the divergent stretches with reasons).
//! The rides are real: keep `--out-dir` in gitignored or temporary directories.

#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "counts and display values"
)]

use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use kompass_core::attrs::SurfaceClass;
use kompass_core::cost::{self, CostModel, Exclusion, WayKind};
use kompass_core::explain::{CompareRequest, StretchCost};
use kompass_core::matching::{Match, Matcher, TileGrids, dist_m, needed_tiles_of};
use kompass_core::route::{RouteOptions, Waypoint};
use kompass_core::{ArcId, EdgeId, Graph, LimitId, LngLat, NodeId, Planner, Profile, RouteRequest};

use crate::route::load_profile;
use crate::{Failure, gpx, percentile};

/// A path beside a busy road: a motor road's traffic level of at least this alongside (secondary
/// roads at 70 km/h and up, `docs/profile.md#traffic`) over at least half of the way.
const BUSY_TRAFFIC: f32 = 0.45;
const BUSY_SHARE: f32 = 0.5;
/// A turn: a heading change of at least this at a junction (3+ edges).
const TURN_DEG: f64 = 45.0;
/// A leg whose end points are closer than this share of its ridden length is a loop in itself: no
/// A→B router reproduces it, so it is skipped (`--min-straight`).
const MIN_STRAIGHTNESS: f64 = 0.55;
/// Divergent stretches shorter than this (either side) are noise (parallel ways, junction shapes).
const MIN_STRETCH_M: f32 = 300.0;
/// The way types of the mix table.
const WAYS: [WayKind; 9] = [
    WayKind::MainRoad,
    WayKind::CountryRoad,
    WayKind::Residential,
    WayKind::Service,
    WayKind::Track,
    WayKind::Path,
    WayKind::BikePath,
    WayKind::BikePathRoadside,
    WayKind::Other,
];

struct Opts {
    build: PathBuf,
    profiles: Vec<(String, Profile)>,
    refs: Vec<(String, PathBuf)>,
    leg_km: f64,
    out_dir: Option<PathBuf>,
    min_straight: f64,
    only: Option<String>,
    inputs: Vec<PathBuf>,
}

fn parse(args: &[String]) -> Result<Opts, Failure> {
    let mut o = Opts {
        build: PathBuf::new(),
        profiles: Vec::new(),
        refs: Vec::new(),
        leg_km: 14.0,
        out_dir: None,
        min_straight: MIN_STRAIGHTNESS,
        only: None,
        inputs: Vec::new(),
    };
    let mut profiles = "gravel_explorer".to_string();
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let mut value = || {
            it.next()
                .cloned()
                .ok_or_else(|| Failure::Usage(format!("{flag} needs a value")))
        };
        match flag.as_str() {
            "--build" => o.build = PathBuf::from(value()?),
            "--profiles" => profiles = value()?,
            "--ref" => {
                let v = value()?;
                let (name, dir) = v
                    .split_once('=')
                    .ok_or_else(|| Failure::Usage("--ref must be <name>=<dir>".into()))?;
                o.refs.push((name.to_string(), PathBuf::from(dir)));
            }
            "--leg-km" => {
                o.leg_km = value()?
                    .parse()
                    .map_err(|_| Failure::Usage("--leg-km must be a number".into()))?;
            }
            "--out-dir" => o.out_dir = Some(PathBuf::from(value()?)),
            "--leg" => o.only = Some(value()?),
            "--min-straight" => {
                o.min_straight = value()?
                    .parse()
                    .map_err(|_| Failure::Usage("--min-straight must be a number".into()))?;
            }
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
    for spec in profiles.split(',').filter(|s| !s.is_empty()) {
        let p = load_profile(spec)?;
        let label = Path::new(spec)
            .file_stem()
            .map_or_else(|| spec.to_string(), |s| s.to_string_lossy().into_owned());
        o.profiles.push((label, p));
    }
    if o.profiles.is_empty() {
        return Err(Failure::Usage("--profiles needs at least one profile".into()));
    }
    Ok(o)
}

/// A line on the graph: arcs in riding order with the covered share of each edge.
type Line = Vec<(ArcId, f32)>;

fn edge_of(a: ArcId) -> EdgeId {
    a >> 1
}

fn pieces_line(m: &Match) -> Line {
    let mut out: Line = Vec::with_capacity(m.pieces.len());
    for p in &m.pieces {
        let a = p.arc();
        match out.last_mut() {
            Some((last, share)) if *last == a => *share = (*share + p.share()).min(1.0),
            _ => out.push((a, p.share())),
        }
    }
    out
}

/// The arcs of a line (whole edges).
fn arcs(l: &[(ArcId, f32)]) -> Vec<ArcId> {
    l.iter().map(|&(a, _)| a).collect()
}

/// The heading (degrees) of an arc at its start or its end, from the edge geometry.
fn heading(g: &Graph, a: ArcId, at_end: bool) -> Option<f64> {
    let pts: Vec<(f64, f64)> = g
        .edge_points(edge_of(a))
        .map(|(x, y)| (f64::from(x) * 1e-7, f64::from(y) * 1e-7))
        .collect();
    let pts: Vec<(f64, f64)> = if a & 1 == 1 {
        pts.into_iter().rev().collect()
    } else {
        pts
    };
    let n = pts.len();
    if n < 2 {
        return None;
    }
    // look about 15 m back/ahead of the junction to step over tiny kinks
    let (p, q) = if at_end {
        let q = pts[n - 1];
        let mut p = pts[n - 2];
        for &c in pts[..n - 1].iter().rev() {
            p = c;
            if dist_m(lnglat(c), lnglat(q)) >= 15.0 {
                break;
            }
        }
        (p, q)
    } else {
        let p = pts[0];
        let mut q = pts[1];
        for &c in &pts[1..] {
            q = c;
            if dist_m(lnglat(p), lnglat(c)) >= 15.0 {
                break;
            }
        }
        (p, q)
    };
    let k = p.1.to_radians().cos();
    let (dx, dy) = ((q.0 - p.0) * k, q.1 - p.1);
    if dx == 0.0 && dy == 0.0 {
        return None;
    }
    Some(dx.atan2(dy).to_degrees())
}

fn lnglat((lng, lat): (f64, f64)) -> LngLat {
    LngLat { lng, lat }
}

/// Turns of a line: heading changes of [`TURN_DEG`] or more at junctions, and of those the ones
/// within 300 m of the previous turn the other way (a zigzag).
fn turns(g: &Graph, l: &[(ArcId, f32)]) -> (u32, u32) {
    let (mut n, mut zig) = (0u32, 0u32);
    let mut last: Option<(f64, f64)> = None; // (signed change, distance at it)
    let mut dist = 0.0f64;
    for w in l.windows(2) {
        let (a, b) = (w[0].0, w[1].0);
        dist += f64::from(g.length_m(edge_of(a)) * w[0].1);
        let v = g.head(a);
        if g.arcs_at(v).0.len() < 3 || edge_of(a) == edge_of(b) {
            continue;
        }
        let (Some(h0), Some(h1)) = (heading(g, a, true), heading(g, b, false)) else {
            continue;
        };
        let d = (h1 - h0 + 540.0).rem_euclid(360.0) - 180.0;
        if d.abs() >= TURN_DEG {
            n += 1;
            if let Some((pd, pdist)) = last
                && pd.signum() != d.signum()
                && dist - pdist < 300.0
            {
                zig += 1;
            }
            last = Some((d, dist));
        }
    }
    (n, zig)
}

#[derive(Default, Clone)]
struct Measures {
    km: f64,
    /// Of the ridden length, reproduced by this line (km).
    reproduced_km: f64,
    /// Of this line, on ridden edges (km).
    on_ridden_km: f64,
    ascent_m: f64,
    unpaved_km: f64,
    main_km: f64,
    roadside_km: f64,
    busy_side_km: f64,
    clamp_km: f64,
    closed_km: f64,
    cost: f64,
    turns: u32,
    zigzag: u32,
    /// Km by way type, in [`WAYS`] order.
    ways: [f64; WAYS.len()],
    /// Km of paved tracks (farm roads).
    paved_track_km: f64,
    /// Per preference of the judge: Σ length × ln(factor) (km), for the geometric mean.
    prefs: Vec<(kompass_core::PrefId, f64)>,
}

impl Measures {
    fn add(&mut self, o: &Measures) {
        self.km += o.km;
        self.reproduced_km += o.reproduced_km;
        self.on_ridden_km += o.on_ridden_km;
        self.ascent_m += o.ascent_m;
        self.unpaved_km += o.unpaved_km;
        self.main_km += o.main_km;
        self.roadside_km += o.roadside_km;
        self.busy_side_km += o.busy_side_km;
        self.clamp_km += o.clamp_km;
        self.closed_km += o.closed_km;
        self.cost += o.cost;
        self.turns += o.turns;
        self.zigzag += o.zigzag;
        for (a, b) in self.ways.iter_mut().zip(o.ways) {
            *a += b;
        }
        self.paved_track_km += o.paved_track_km;
        for &(id, v) in &o.prefs {
            match self.prefs.iter_mut().find(|(i, _)| *i == id) {
                Some((_, x)) => *x += v,
                None => self.prefs.push((id, v)),
            }
        }
    }
}

fn measure(
    g: &Graph,
    model: &CostModel,
    l: &[(ArcId, f32)],
    ridden: &HashMap<EdgeId, f32>,
    judged: &StretchCost,
) -> Measures {
    let mut m = Measures::default();
    let mut seen: HashMap<EdgeId, f32> = HashMap::new();
    for &(a, share) in l {
        let e = edge_of(a);
        let len = f64::from(g.length_m(e) * share);
        m.km += len / 1e3;
        m.ascent_m += f64::from(cost::arc_ascent_m(g, a) * share);
        let surface = cost::reported_surface(g, e);
        if matches!(
            surface,
            SurfaceClass::Compacted | SurfaceClass::Gravel | SurfaceClass::Soft | SurfaceClass::Other
        ) {
            m.unpaved_km += len / 1e3;
        }
        let way = cost::way_kind(g, e);
        if way == WayKind::Track && matches!(surface, SurfaceClass::PavedSmooth | SurfaceClass::PavedRough) {
            m.paved_track_km += len / 1e3;
        }
        let ex = model.explain(g, None, a);
        if ex.excluded.is_none() {
            for &(id, f) in &ex.factors {
                let v = len / 1e3 * f64::from(f).ln();
                match m.prefs.iter_mut().find(|(i, _)| *i == id) {
                    Some((_, x)) => *x += v,
                    None => m.prefs.push((id, v)),
                }
            }
        }
        if let Some(i) = WAYS.iter().position(|&w| w == way) {
            m.ways[i] += len / 1e3;
        }
        if way == WayKind::MainRoad {
            m.main_km += len / 1e3;
        }
        if way == WayKind::BikePathRoadside {
            m.roadside_km += len / 1e3;
        }
        let motor = matches!(
            way,
            WayKind::MainRoad | WayKind::CountryRoad | WayKind::Residential | WayKind::Service
        );
        if !motor && g.road_near_share(e) >= BUSY_SHARE && g.road_near_traffic(e) >= BUSY_TRAFFIC {
            m.busy_side_km += len / 1e3;
        }
        if let Some(r) = ridden.get(&e) {
            m.on_ridden_km += len / 1e3;
            let s = seen.entry(e).or_insert(0.0);
            // a ridden edge counts once, up to the ridden share
            let add = (r - *s).clamp(0.0, share);
            *s += add;
            m.reproduced_km += f64::from(g.length_m(e) * add) / 1e3;
        }
    }
    m.clamp_km = f64::from(judged.clamped_min_m) / 1e3;
    m.closed_km = judged.closed.iter().map(|c| f64::from(c.length_m)).sum::<f64>() / 1e3;
    m.cost = f64::from(judged.cost);
    (m.turns, m.zigzag) = turns(g, l);
    m
}

fn closed_by_limit(c: &StretchCost, out: &mut HashMap<String, f64>) {
    for p in &c.closed {
        *out.entry(p.by.id().to_string()).or_insert(0.0) += f64::from(p.length_m) / 1e3;
    }
}

fn node_waypoint(g: &Graph, v: NodeId) -> Waypoint {
    let p = g.node(v);
    Waypoint {
        lon: p.lng,
        lat: p.lat,
        name: None,
    }
}

fn line_geojson(g: &Graph, s: &mut String, name: &str, l: &[(ArcId, f32)]) {
    let _ = write!(
        s,
        "{{\"type\":\"Feature\",\"properties\":{{\"line\":\"{name}\"}},\"geometry\":{{\"type\":\"LineString\",\"coordinates\":["
    );
    let mut first = true;
    for &(a, _) in l {
        let mut pts: Vec<(i32, i32)> = g.edge_points(edge_of(a)).collect();
        if a & 1 == 1 {
            pts.reverse();
        }
        for (x, y) in pts {
            let _ = write!(
                s,
                "{}[{:.6},{:.6}]",
                if first { "" } else { "," },
                f64::from(x) * 1e-7,
                f64::from(y) * 1e-7
            );
            first = false;
        }
    }
    s.push_str("]}}");
}

/// Equal-length cut points (indices into the line) for `n` legs.
fn cut_points(g: &Graph, l: &[(ArcId, f32)], n: usize) -> Vec<usize> {
    let total: f64 = l
        .iter()
        .map(|&(a, s)| f64::from(g.length_m(edge_of(a)) * s))
        .sum();
    let mut cuts = vec![0];
    let mut acc = 0.0;
    let mut k = 1;
    for (i, &(a, s)) in l.iter().enumerate() {
        acc += f64::from(g.length_m(edge_of(a)) * s);
        if k < n && acc >= total * k as f64 / n as f64 {
            cuts.push(i + 1);
            k += 1;
        }
    }
    cuts.push(l.len());
    cuts
}

struct Kind {
    name: String,
    total: Measures,
    legs: u32,
    missing: u32,
    ratios: Vec<f64>,
    repro: Vec<f64>,
}

impl Kind {
    fn new(name: &str) -> Kind {
        Kind {
            name: name.to_string(),
            total: Measures::default(),
            legs: 0,
            missing: 0,
            ratios: Vec::new(),
            repro: Vec::new(),
        }
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "a driver: match, cut, route, measure, print"
)]
pub fn run(args: &[String]) -> Result<(), Failure> {
    let o = parse(args)?;
    let files = crate::matchcmd::gpx_files(&o.inputs)?;
    let (graph, _) = kompass_compile::build::load(&o.build, true)?;
    let mut planner = Planner::new(graph);
    let mut grids = TileGrids::new(planner.graph());
    let mut matcher = Matcher::default();
    if let Some(d) = &o.out_dir {
        fs::create_dir_all(d)?;
    }
    let judge = o.profiles[0].1.clone();
    let judge_model = CostModel::new(&judge).map_err(|e| Failure::Run(e.to_string()))?;
    // the ridden length `legal_only` closes, by the access tag behind it (km, stretches of it)
    let mut legal: HashMap<&'static str, (f64, u32)> = HashMap::new();
    let mut kinds: Vec<Kind> = std::iter::once(Kind::new("ridden"))
        .chain(o.profiles.iter().map(|(n, _)| Kind::new(n)))
        .chain(o.refs.iter().map(|(n, _)| Kind::new(n)))
        .collect();
    let mut legs_json = String::from("[");
    let mut stretches_txt = String::new();
    let mut skipped = (0u32, 0u32); // (breaks, loops)
    let mut reasons: HashMap<String, (u32, f64)> = HashMap::new();
    let mut ridden_closed: HashMap<String, f64> = HashMap::new();
    let mut n_legs = 0u32;

    let match_file = |matcher: &mut Matcher, grids: &mut TileGrids, g: &Graph, path: &Path| -> Option<Line> {
        let text = fs::read_to_string(path).ok()?;
        let tr = gpx::parse(&text);
        if tr.points.len() < 2 {
            return None;
        }
        let needed = needed_tiles_of(g, matcher.params.radius_m, tr.points.iter().copied());
        grids.ensure(g, &needed);
        let m = matcher.match_track(g, grids, &tr.points);
        Some(pieces_line(&m))
    };

    println!(
        "| leg | ridden km | straight | {} |",
        kinds[1..]
            .iter()
            .map(|k| format!("{}: km / reproduced / on ridden", k.name))
            .collect::<Vec<_>>()
            .join(" | ")
    );
    println!("|---|---:|---:|{}", "---:|".repeat(kinds.len() - 1));
    for (ri, file) in files.iter().enumerate() {
        let Some(line) = match_file(&mut matcher, &mut grids, planner.graph(), file) else {
            continue;
        };
        let g = planner.graph();
        let total_km: f64 = line
            .iter()
            .map(|&(a, s)| f64::from(g.length_m(edge_of(a)) * s))
            .sum::<f64>()
            / 1e3;
        let n = ((total_km / o.leg_km).round() as usize).clamp(1, 4);
        let cuts = cut_points(g, &line, n);
        for (li, w) in cuts.windows(2).enumerate() {
            let g = planner.graph();
            let leg: Line = line[w[0]..w[1]].to_vec();
            if leg.len() < 2 {
                continue;
            }
            if leg.windows(2).any(|p| g.head(p[0].0) != g.tail(p[1].0)) {
                skipped.0 += 1;
                continue;
            }
            let (from, to) = (g.tail(leg[0].0), g.head(leg[leg.len() - 1].0));
            let ridden_km: f64 = leg
                .iter()
                .map(|&(a, s)| f64::from(g.length_m(edge_of(a)) * s))
                .sum::<f64>()
                / 1e3;
            let straight = g.node_distance_m(from, to) / 1e3 / ridden_km.max(1e-3);
            if straight < o.min_straight {
                skipped.1 += 1;
                continue;
            }
            let id = format!("ride{ri}-leg{li}");
            if o.only.as_ref().is_some_and(|x| *x != id) {
                continue;
            }
            n_legs += 1;
            let (fw, tw) = (node_waypoint(g, from), node_waypoint(g, to));
            let _ = write!(
                legs_json,
                "{}{{\"id\":\"{id}\",\"file\":{:?},\"from\":[{:.7},{:.7}],\"to\":[{:.7},{:.7}],\"ridden_km\":{ridden_km:.2}}}",
                if n_legs > 1 { "," } else { "" },
                file.to_string_lossy(),
                fw.lon,
                fw.lat,
                tw.lon,
                tw.lat
            );
            // ridden edges: the covered share of each edge
            let mut ridden: HashMap<EdgeId, f32> = HashMap::new();
            for &(a, s) in &leg {
                let r = ridden.entry(edge_of(a)).or_insert(0.0);
                *r = (*r + s).min(1.0);
            }
            // every line of this leg
            let mut lines: Vec<Option<Line>> = vec![Some(leg.clone())];
            for (_, p) in &o.profiles {
                let req = RouteRequest {
                    waypoints: vec![fw.clone(), tw.clone()],
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
                lines.push(planner.route(&req).ok().map(|r| {
                    let k = r.arcs.len();
                    r.arcs
                        .iter()
                        .enumerate()
                        .map(|(i, &a)| {
                            // the partial first and last arcs, from where the waypoints snapped
                            let share = match (i, r.waypoints.first(), r.waypoints.last()) {
                                (0, Some(w), _) if w.edge == edge_of(a) => {
                                    if a & 1 == 1 {
                                        w.fraction
                                    } else {
                                        1.0 - w.fraction
                                    }
                                }
                                (i, _, Some(w)) if i + 1 == k && w.edge == edge_of(a) => {
                                    if a & 1 == 1 {
                                        1.0 - w.fraction
                                    } else {
                                        w.fraction
                                    }
                                }
                                _ => 1.0,
                            };
                            (a, share)
                        })
                        .filter(|&(_, s)| s > 0.0)
                        .collect()
                }));
            }
            for (_, dir) in &o.refs {
                let path = dir.join(format!("{id}.gpx"));
                lines.push(match_file(&mut matcher, &mut grids, planner.graph(), &path));
            }
            let mut cells = Vec::new();
            let mut gj = String::from("{\"type\":\"FeatureCollection\",\"features\":[");
            for (k, l) in lines.iter().enumerate() {
                let Some(l) = l else {
                    kinds[k].missing += 1;
                    if k > 0 {
                        cells.push("—".to_string());
                    }
                    continue;
                };
                let a = arcs(l);
                let judged = planner
                    .stretch_costs(&judge, &a, &[[0, a.len() as u32]], 5)
                    .map_err(|e| Failure::Run(e.message))?
                    .remove(0);
                if k == 0 {
                    closed_by_limit(&judged, &mut ridden_closed);
                    let g = planner.graph();
                    let mut prev = false;
                    for &(a, share) in l.iter().filter(|x| x.1 > 0.0) {
                        let e = edge_of(a);
                        let hit =
                            judge_model.edge_exclusion(g, e) == Some(Exclusion::Limit(LimitId::LegalOnly));
                        if hit {
                            let t = legal.entry(g.bike_access(e).label()).or_insert((0.0, 0));
                            t.0 += f64::from(g.length_m(e) * share) / 1e3;
                            t.1 += u32::from(!prev);
                        }
                        prev = hit;
                    }
                }
                let g = planner.graph();
                let m = measure(g, &judge_model, l, &ridden, &judged);
                kinds[k].legs += 1;
                kinds[k].ratios.push(m.km / ridden_km.max(1e-3));
                kinds[k].repro.push(m.reproduced_km / ridden_km.max(1e-3));
                if k > 0 {
                    cells.push(format!(
                        "{:.1} / {:.0} % / {:.0} %",
                        m.km,
                        m.reproduced_km * 100.0 / ridden_km.max(1e-3),
                        m.on_ridden_km * 100.0 / m.km.max(1e-3)
                    ));
                }
                kinds[k].total.add(&m);
                if o.out_dir.is_some() {
                    if k > 0 {
                        gj.push(',');
                    }
                    line_geojson(g, &mut gj, &kinds[k].name, l);
                }
            }
            println!(
                "| {id} | {ridden_km:.1} | {straight:.2} | {} |",
                cells.join(" | ")
            );
            // where the judge's route leaves the ridden line, and why
            if let Some(Some(route)) = lines.get(1) {
                let cmp = planner
                    .compare(&CompareRequest {
                        profile: judge.clone(),
                        a: arcs(route),
                        b: arcs(&leg),
                    })
                    .map_err(|e| Failure::Run(e.message))?;
                for s in cmp
                    .stretches
                    .iter()
                    .filter(|s| s.a.span.length_m.max(s.b.span.length_m) >= MIN_STRETCH_M)
                {
                    let key = stretch_reason(&s.a, &s.b);
                    let r = reasons.entry(key.clone()).or_insert((0, 0.0));
                    r.0 += 1;
                    r.1 += f64::from(s.b.span.length_m) / 1e3;
                    let _ = writeln!(
                        stretches_txt,
                        "{id} at {:.1} km of the route / {:.1} km of the ride: route {:.2} km ({}) factor {:.2} | ridden {:.2} km ({}) factor {:.2} closed {} | cost delta {:+.0} | {key}",
                        s.a.span.start_m / 1e3,
                        s.b.span.start_m / 1e3,
                        s.a.span.length_m / 1e3,
                        describe(&s.a),
                        s.a.factor,
                        s.b.span.length_m / 1e3,
                        describe(&s.b),
                        s.b.factor,
                        s.b.closed
                            .iter()
                            .map(|c| format!("{} {:.0} m", c.by.id(), c.length_m))
                            .collect::<Vec<_>>()
                            .join(", "),
                        s.cost_delta
                    );
                }
            }
            if let Some(d) = &o.out_dir {
                gj.push_str("]}\n");
                fs::write(d.join(format!("{id}.geojson")), gj)?;
            }
        }
    }
    legs_json.push_str("]\n");
    if let Some(d) = &o.out_dir {
        fs::write(d.join("legs.json"), legs_json)?;
        fs::write(d.join("stretches.txt"), stretches_txt)?;
    }

    println!(
        "\n{n_legs} legs from {} rides (skipped: {} with a chain break, {} loops in themselves)\n",
        files.len(),
        skipped.0,
        skipped.1
    );
    println!(
        "| line | legs | km / ridden (median) | reproduced (all / median leg) | on ridden | ascent m/100 km | unpaved | main road km | roadside cycle path km | beside busy road km | at clamp | closed km | cost / ridden | turns / km | zigzags |"
    );
    println!("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    let ridden_cost = kinds[0].total.cost;
    let ridden_km = kinds[0].total.km;
    for k in &mut kinds {
        k.ratios.sort_by(f64::total_cmp);
        k.repro.sort_by(f64::total_cmp);
        let t = &k.total;
        let km = t.km.max(1e-6);
        println!(
            "| {} | {}{} | {:.2} ({:.2}) | {:.0} % / {:.0} % | {:.0} % | {:.0} | {:.0} % | {:.1} | {:.1} | {:.1} | {:.0} % | {:.1} | {:.2} | {:.2} | {} |",
            k.name,
            k.legs,
            if k.missing > 0 {
                format!(" ({} missing)", k.missing)
            } else {
                String::new()
            },
            t.km / ridden_km.max(1e-6),
            percentile(&k.ratios, 0.5),
            t.reproduced_km * 100.0 / ridden_km.max(1e-6),
            percentile(&k.repro, 0.5) * 100.0,
            t.on_ridden_km * 100.0 / km,
            t.ascent_m * 100.0 / km,
            t.unpaved_km * 100.0 / km,
            t.main_km,
            t.roadside_km,
            t.busy_side_km,
            t.clamp_km * 100.0 / km,
            t.closed_km,
            t.cost / ridden_cost.max(1e-6),
            f64::from(t.turns) / km,
            t.zigzag
        );
    }
    println!(
        "\n| line | {} |",
        WAYS.iter().map(|&w| way_name(w)).collect::<Vec<_>>().join(" | ")
    );
    println!("|---|{}", "---:|".repeat(WAYS.len()));
    for k in &kinds {
        let km = k.total.km.max(1e-6);
        println!(
            "| {} | {} |",
            k.name,
            k.total
                .ways
                .iter()
                .map(|w| format!("{:.0} %", w * 100.0 / km))
                .collect::<Vec<_>>()
                .join(" | ")
        );
    }
    let ids: Vec<kompass_core::PrefId> = kinds[0].total.prefs.iter().map(|(i, _)| *i).collect();
    let id_name = |id: kompass_core::PrefId| {
        serde_json::to_value(id)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default()
    };
    println!(
        "\n| line (judge's factor, length-weighted geometric mean) | paved tracks | {} |",
        ids.iter().map(|&i| id_name(i)).collect::<Vec<_>>().join(" | ")
    );
    println!("|---|---:|{}", "---:|".repeat(ids.len()));
    for k in &kinds {
        let km = k.total.km.max(1e-6);
        println!(
            "| {} | {:.0} % | {} |",
            k.name,
            k.total.paved_track_km * 100.0 / km,
            ids.iter()
                .map(|id| {
                    let v = k.total.prefs.iter().find(|(i, _)| i == id).map_or(0.0, |x| x.1);
                    format!("{:.2}", (v / km).exp())
                })
                .collect::<Vec<_>>()
                .join(" | ")
        );
    }
    println!(
        "\n(judge: {}; clamp, closed and cost are under it for every line; the sums are over the legs each line has)",
        o.profiles[0].0
    );
    let mut ridden_closed: Vec<_> = ridden_closed.into_iter().collect();
    ridden_closed.sort_by(|a, b| b.1.total_cmp(&a.1));
    println!(
        "ridden line closed by the judge: {}",
        if ridden_closed.is_empty() {
            "nothing".to_string()
        } else {
            ridden_closed
                .iter()
                .map(|(k, v)| format!("{k} {v:.1} km"))
                .collect::<Vec<_>>()
                .join(", ")
        }
    );
    let mut legal: Vec<_> = legal.into_iter().collect();
    legal.sort_by(|a, b| b.1.0.total_cmp(&a.1.0));
    if !legal.is_empty() {
        println!(
            "of it legal_only, by access: {}",
            legal
                .iter()
                .map(|(k, (km, n))| format!("{k} {km:.1} km in {n} pieces"))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    let mut reasons: Vec<_> = reasons.into_iter().collect();
    reasons.sort_by(|a, b| b.1.1.total_cmp(&a.1.1));
    println!("\nwhere the judge's route leaves the ridden line (stretches ≥ {MIN_STRETCH_M:.0} m):");
    for (k, (n, km)) in reasons {
        println!("- {k}: {n} stretches, {km:.1} km of the ridden line");
    }
    Ok(())
}

fn way_name(w: WayKind) -> String {
    serde_json::to_value(w)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn describe(s: &StretchCost) -> String {
    let ways: Vec<String> = s
        .ways
        .iter()
        .take(2)
        .map(|p| format!("{} {:.0} %", way_name(p.key), p.share * 100.0))
        .collect();
    let why: Vec<String> = s
        .why
        .iter()
        .take(3)
        .map(|r| {
            let id = serde_json::to_value(r.id)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default();
            format!("{id} {:.2}", r.factor)
        })
        .collect();
    format!("{}; {}", ways.join(", "), why.join(", "))
}

/// A first, automatic grouping of a divergent stretch (`a` the route, `b` the ridden line); the
/// report refines it by hand with `route --explain` / `--why-not`.
fn stretch_reason(a: &StretchCost, b: &StretchCost) -> String {
    if let Some(c) = b
        .closed
        .iter()
        .max_by(|x, y| x.length_m.total_cmp(&y.length_m))
        .filter(|c| c.length_m >= 100.0_f32.min(0.1 * b.span.length_m))
    {
        return format!("ridden line closed ({})", c.by.id());
    }
    let main_way = |s: &StretchCost| s.ways.first().map_or_else(String::new, |p| way_name(p.key));
    let detour = b.span.length_m / a.span.length_m.max(1.0);
    if b.factor <= a.factor {
        // the rider's way is as good or better per metre: it loses on length
        let band = if detour < 1.2 {
            "up to 1.2×"
        } else if detour < 1.5 {
            "1.2–1.5×"
        } else {
            "over 1.5×"
        };
        return format!("ridden line as good or better per metre, {band} longer");
    }
    format!("ridden {} dearer than route {}", main_way(b), main_way(a))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kompass_core::testing::grid;

    /// A 4 × 4 grid, 100 m apart: east edges first (row by row, handle `j * 3 + i`), then north
    /// edges (column by column, handle `12 + i * 3 + j`).
    fn line(handles: &[usize]) -> (kompass_core::testing::Built, Line) {
        let built = grid(4, 4, 100.0).build();
        let l = handles.iter().map(|&h| (built.edge(h) << 1, 1.0)).collect();
        (built, l)
    }

    #[test]
    fn counts_turns_and_zigzags_at_junctions() {
        // straight along the bottom row: junctions, but no turn
        let (b, straight) = line(&[0, 1, 2]);
        assert_eq!(turns(&b.graph, &straight), (0, 0));
        // a staircase east, north, east, …: five turns, each back the other way within 300 m
        let (b, stairs) = line(&[0, 15, 4, 19, 8, 23]);
        assert!(
            stairs
                .windows(2)
                .all(|w| b.graph.head(w[0].0) == b.graph.tail(w[1].0))
        );
        assert_eq!(turns(&b.graph, &stairs), (5, 4));
    }

    #[test]
    fn cuts_a_line_into_legs_of_equal_length() {
        let (b, stairs) = line(&[0, 15, 4, 19, 8, 23]);
        assert_eq!(cut_points(&b.graph, &stairs, 2), vec![0, 3, 6]);
        assert_eq!(cut_points(&b.graph, &stairs, 3), vec![0, 2, 4, 6]);
        assert_eq!(cut_points(&b.graph, &stairs, 1), vec![0, 6]);
    }
}
