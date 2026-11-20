//! `kompass`: the engine on the command line.
//!
//! - `kompass compile --build <dir> [--zoom 11]`: `<dir>/edges.parquet` → `<dir>/graph/`, registered
//!   in `<dir>/manifest.json`.
//! - `kompass info --build <dir> [--snaps N]`: loads the graph, prints counts, load times, memory and
//!   the time of N seeded random snaps (no coordinates).
//! - `kompass route --build <dir> --profile <file|preset> --from lon,lat [--via lon,lat]… --to
//!   lon,lat [--out file] [--segments] [--radius m]`: a route as GeoJSON.
//! - `kompass profile schema | catalogue [--build <dir>] | presets`: the profile's JSON Schema, the
//!   catalogue (with coverage shares of a region), the shipped presets.
//! - `kompass schema --write <dir> | --check <dir>`: the generated JSON Schemas and TypeScript types.
//! - `kompass bench --build <dir>`: seeded random routes at ~10/50/100 km under the main presets.
//! - `kompass compare --build <dir> --profiles a,b`: route quality of profiles on seeded random pairs.
//! - `kompass match --build <dir> [--geojson <dir>] [--explored <file>] <gpx files or directories>`:
//!   map-matches recorded tracks, prints aggregate numbers (`docs/matching.md`).

#![allow(
    clippy::doc_markdown,
    clippy::must_use_candidate,
    clippy::many_single_char_names,
    clippy::single_match_else,
    reason = "a binary: command-line text in the docs, no API to misuse, short names for pairs"
)]

mod bench;
mod gpx;
mod matchcmd;
mod route;

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use kompass_core::spatial::{DEFAULT_CELL_M, Grid};
use kompass_core::{Graph, LngLat};

const USAGE: &str = "usage: kompass [--version | --help]
       kompass compile --build <dir> [--zoom <z>]
       kompass info --build <dir> [--snaps <n>]
       kompass match --build <dir> [--geojson <dir>] [--explored <file>] [--no-geometry]
                     [--radius|--candidates|--sigma|--beta|--step|--skip|--gap|--spur <v>] <gpx files or directories>
       kompass route --build <dir> --profile <file|preset> --from <lon,lat> [--via <lon,lat>]... --to <lon,lat>
                     [--out <file>] [--segments] [--radius <m>]
       kompass profile schema | catalogue [--build <dir>] | presets
       kompass schema --write <dir> | --check <dir>
       kompass bench --build <dir> [--pairs <n>] [--seed <n>] [--profiles <a,b>]
       kompass compare --build <dir> --profiles <a,b,...> [--pairs <n>] [--km <min-max>] [--seed <n>] [--out-dir <dir>]";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rest = args.get(1..).unwrap_or(&[]);
    let result = match args.first().map(String::as_str) {
        None | Some("--version" | "-V" | "version") => {
            println!("kompass {}", kompass_core::version());
            Ok(())
        }
        Some("--help" | "-h" | "help") => {
            println!("{USAGE}");
            Ok(())
        }
        Some("compile") => Args::parse(rest, &[]).and_then(|a| compile(&a)),
        Some("info") => Args::parse(rest, &[]).and_then(|a| info(&a)),
        Some("match") => matchcmd::run(rest),
        Some("route") => Args::parse(rest, &["--segments"]).and_then(|a| route::run(&a)),
        Some("profile") => profile(rest),
        Some("schema") => Args::parse(rest, &[]).and_then(|a| schema(&a)),
        Some("bench") => Args::parse(rest, &[]).and_then(|a| bench::bench(&a)),
        Some("compare") => Args::parse(rest, &[]).and_then(|a| bench::compare(&a)),
        Some(other) => Err(Failure::Usage(format!("unknown command `{other}`"))),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(Failure::Usage(msg)) => {
            eprintln!("kompass: {msg}\n{USAGE}");
            ExitCode::from(2)
        }
        Err(Failure::Run(msg)) => {
            eprintln!("kompass: {msg}");
            ExitCode::FAILURE
        }
    }
}

pub(crate) enum Failure {
    Usage(String),
    Run(String),
}

impl From<kompass_compile::Error> for Failure {
    fn from(e: kompass_compile::Error) -> Failure {
        Failure::Run(e.0)
    }
}

impl From<std::io::Error> for Failure {
    fn from(e: std::io::Error) -> Failure {
        Failure::Run(e.to_string())
    }
}

/// `--flag value` pairs (repeatable) and bare switches.
pub(crate) struct Args {
    values: Vec<(String, String)>,
    switches: Vec<String>,
}

impl Args {
    fn parse(args: &[String], switches: &[&str]) -> Result<Args, Failure> {
        let mut a = Args {
            values: Vec::new(),
            switches: Vec::new(),
        };
        let mut it = args.iter();
        while let Some(flag) = it.next() {
            if !flag.starts_with("--") {
                return Err(Failure::Usage(format!("unexpected argument `{flag}`")));
            }
            if switches.contains(&flag.as_str()) {
                a.switches.push(flag.clone());
                continue;
            }
            let v = it
                .next()
                .ok_or_else(|| Failure::Usage(format!("{flag} needs a value")))?;
            a.values.push((flag.clone(), v.clone()));
        }
        Ok(a)
    }

    /// The last value of a flag.
    pub(crate) fn get(&self, flag: &str) -> Option<&str> {
        self.values
            .iter()
            .rev()
            .find(|(f, _)| f == flag)
            .map(|(_, v)| v.as_str())
    }

    /// Every value of a repeatable flag, in order.
    pub(crate) fn all(&self, flag: &str) -> Vec<&str> {
        self.values
            .iter()
            .filter(|(f, _)| f == flag)
            .map(|(_, v)| v.as_str())
            .collect()
    }

    pub(crate) fn switch(&self, flag: &str) -> bool {
        self.switches.iter().any(|s| s == flag)
    }

    /// Rejects flags outside `known`.
    pub(crate) fn only(&self, known: &[&str]) -> Result<(), Failure> {
        for (f, _) in &self.values {
            if !known.contains(&f.as_str()) {
                return Err(Failure::Usage(format!("unknown option `{f}`")));
            }
        }
        Ok(())
    }

    pub(crate) fn build(&self) -> Result<PathBuf, Failure> {
        self.get("--build")
            .map(PathBuf::from)
            .ok_or_else(|| Failure::Usage("--build <dir> is required".into()))
    }

    pub(crate) fn number<T: std::str::FromStr>(&self, flag: &str, default: T) -> Result<T, Failure> {
        match self.get(flag) {
            None => Ok(default),
            Some(v) => v
                .parse()
                .map_err(|_| Failure::Usage(format!("{flag} must be a number"))),
        }
    }
}

#[allow(clippy::cast_precision_loss, reason = "sizes for display")]
pub(crate) fn mb(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1e6)
}

fn compile(a: &Args) -> Result<(), Failure> {
    a.only(&["--build", "--zoom"])?;
    let build = a.build()?;
    let zoom: u8 = a.number("--zoom", kompass_compile::DEFAULT_TILE_ZOOM)?;
    if !(8..=16).contains(&zoom) {
        return Err(Failure::Usage("--zoom must be 8..16".into()));
    }
    let t = Instant::now();
    let (graph, stats, written) = kompass_compile::compile_build(&build, zoom)?;
    let secs = t.elapsed().as_secs_f64();
    let info = graph.info();
    #[allow(clippy::cast_precision_loss, reason = "a ratio for display")]
    let cross = stats.cross_tile_edges as f64 * 100.0 / stats.edges.max(1) as f64;
    println!(
        "compiled build {}: {} edges, {} nodes, {} points; {} tiles at z{}, {} cross-tile edges ({cross:.2} %)",
        stats.build_id,
        stats.edges,
        stats.nodes,
        stats.points,
        stats.tiles,
        info.tile_zoom,
        stats.cross_tile_edges
    );
    println!(
        "longest edge {:.1} m; node positions agree within {} e-7 deg",
        stats.max_length_m, stats.node_mismatch_e7
    );
    let sum = |dir: &str| {
        written
            .files
            .iter()
            .filter(|(f, _)| f.contains(dir))
            .map(|(_, b)| b)
            .sum::<u64>()
    };
    println!(
        "wrote {} in {} files: graph tiles {}, geometry {}, index {} ({secs:.1} s)",
        mb(written.total_bytes()),
        written.files.len(),
        mb(sum("/tiles/")),
        mb(sum("/geometry/")),
        mb(sum("index.kmpg"))
    );
    Ok(())
}

/// Peak resident memory of this process (Linux), in bytes.
pub(crate) fn peak_rss() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    line.split_whitespace()
        .nth(1)?
        .parse::<u64>()
        .ok()
        .map(|kb| kb * 1024)
}

/// A deterministic xorshift (snap queries, benchmark pairs).
pub(crate) struct Rng(pub u64);

impl Rng {
    pub(crate) fn next_u64(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    #[allow(clippy::cast_precision_loss, reason = "a uniform value in -1..1")]
    pub(crate) fn signed(&mut self) -> f64 {
        (self.next_u64() % 2_000_001) as f64 / 1e6 - 1.0
    }
}

pub(crate) fn percentile(sorted: &[f64], p: f64) -> f64 {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "an index into the samples"
    )]
    let i = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted.get(i).copied().unwrap_or(f64::NAN)
}

#[allow(clippy::cast_possible_truncation, reason = "node ids fit u32")]
fn info(a: &Args) -> Result<(), Failure> {
    a.only(&["--build", "--snaps"])?;
    let build = a.build()?;
    let n_snaps: usize = a.number("--snaps", 100_000)?;
    let (graph, t) = kompass_compile::build::load(&build, true)?;
    let i = graph.info();
    println!(
        "graph of build {}: format {}, {} nodes, {} edges, {} tiles at z{}",
        i.build_id,
        i.format_version,
        i.node_count,
        i.edge_count,
        i.tiles.len(),
        i.tile_zoom
    );
    println!(
        "load: read {} {:.0} ms, tiles {:.0} ms, adjacency {:.0} ms, geometry {:.0} ms",
        mb(t.bytes),
        t.read_ms,
        t.tiles_ms,
        t.adjacency_ms,
        t.geometry_ms
    );
    let start = Instant::now();
    let grid = Grid::build(&graph, DEFAULT_CELL_M);
    let grid_ms = start.elapsed().as_secs_f64() * 1e3;
    println!(
        "memory: graph {} (adjacency {}), grid {} ({} cells, {} entries, built in {grid_ms:.0} ms)",
        mb(graph.heap_bytes() as u64),
        mb(graph.adjacency_bytes() as u64),
        mb(grid.heap_bytes() as u64),
        grid.cells(),
        grid.entries()
    );
    if n_snaps > 0 && graph.node_count() > 0 {
        snaps(&graph, &grid, n_snaps);
    }
    if let Some(rss) = peak_rss() {
        println!("peak RSS {}", mb(rss));
    }
    Ok(())
}

/// Seeded random nodes moved by up to ±150 m, nearest edge within 500 m (the spike's query).
#[allow(clippy::cast_possible_truncation, reason = "node ids fit u32")]
fn snaps(graph: &Graph, grid: &Grid, n: usize) {
    let mut rng = Rng(0x2545_f491_4f6c_dd1d);
    let deg = 150.0 / 111_195.0;
    let points: Vec<LngLat> = (0..n)
        .map(|_| {
            let v = (rng.next_u64() % graph.node_count() as u64) as u32;
            let p = graph.node(v);
            let kx = p.lat.to_radians().cos();
            LngLat {
                lng: p.lng + rng.signed() * deg / kx,
                lat: p.lat + rng.signed() * deg,
            }
        })
        .collect();
    let mut out = Vec::with_capacity(5);
    let mut times = Vec::with_capacity(n);
    let mut found = 0;
    for &p in &points {
        let t = Instant::now();
        grid.snap_into(graph, p, 500.0, 1, &mut out);
        times.push(t.elapsed().as_secs_f64() * 1e6);
        found += usize::from(!out.is_empty());
    }
    let mut five = Vec::with_capacity(n.min(10_000));
    for &p in points.iter().take(10_000) {
        let t = Instant::now();
        grid.snap_into(graph, p, 50.0, 5, &mut out);
        five.push(t.elapsed().as_secs_f64() * 1e6);
    }
    times.sort_by(f64::total_cmp);
    five.sort_by(f64::total_cmp);
    println!(
        "snap (nearest within 500 m, {n} queries, {found} found): p50 {:.1} / p95 {:.1} / max {:.0} µs",
        percentile(&times, 0.5),
        percentile(&times, 0.95),
        percentile(&times, 1.0)
    );
    println!(
        "snap (5 nearest within 50 m, {} queries): p50 {:.1} / p95 {:.1} / max {:.0} µs",
        five.len(),
        percentile(&five, 0.5),
        percentile(&five, 0.95),
        percentile(&five, 1.0)
    );
}

fn profile(rest: &[String]) -> Result<(), Failure> {
    let json = |v: &serde_json::Value| serde_json::to_string_pretty(v).unwrap_or_default();
    match rest.first().map(String::as_str) {
        Some("schema") => {
            Args::parse(&rest[1..], &[])?.only(&[])?;
            let files = kompass_core::schema::files();
            let schema = files
                .iter()
                .find(|(f, _)| *f == "profile.schema.json")
                .map_or_else(String::new, |(_, s)| s.clone());
            print!("{schema}");
            Ok(())
        }
        Some("catalogue") => {
            let a = Args::parse(&rest[1..], &[])?;
            a.only(&["--build"])?;
            let c = match a.get("--build") {
                Some(dir) => {
                    let (g, _) = kompass_compile::build::load(std::path::Path::new(dir), false)?;
                    kompass_core::catalogue::catalogue_for(&g, None)
                }
                None => kompass_core::catalogue(),
            };
            println!("{}", json(&serde_json::to_value(c).unwrap_or_default()));
            Ok(())
        }
        Some("presets") => {
            Args::parse(&rest[1..], &[])?.only(&[])?;
            println!(
                "{}",
                json(&serde_json::to_value(kompass_core::presets()).unwrap_or_default())
            );
            Ok(())
        }
        _ => Err(Failure::Usage(
            "profile needs one of: schema, catalogue, presets".into(),
        )),
    }
}

fn schema(a: &Args) -> Result<(), Failure> {
    a.only(&["--write", "--check"])?;
    let files = kompass_core::schema::files();
    if let Some(dir) = a.get("--write") {
        let dir = PathBuf::from(dir);
        std::fs::create_dir_all(&dir)?;
        for (name, contents) in &files {
            std::fs::write(dir.join(name), contents)?;
        }
        println!("wrote {} files to {}", files.len(), dir.display());
        return Ok(());
    }
    let dir = a
        .get("--check")
        .map(PathBuf::from)
        .ok_or_else(|| Failure::Usage("schema needs --write <dir> or --check <dir>".into()))?;
    let stale: Vec<&str> = files
        .iter()
        .filter(|(name, contents)| std::fs::read_to_string(dir.join(name)).ok().as_ref() != Some(contents))
        .map(|(name, _)| *name)
        .collect();
    if stale.is_empty() {
        println!("{} files up to date", files.len());
        Ok(())
    } else {
        Err(Failure::Run(format!(
            "stale generated files in {}: {} (run `bun run gen:engine`)",
            dir.display(),
            stale.join(", ")
        )))
    }
}
