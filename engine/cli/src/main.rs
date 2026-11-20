//! `kompass`: the engine on the command line.
//!
//! - `kompass compile --build <dir> [--zoom 11]`: `<dir>/edges.parquet` → `<dir>/graph/`, registered
//!   in `<dir>/manifest.json`.
//! - `kompass info --build <dir> [--snaps N]`: loads the graph, prints counts, load times, memory and
//!   the time of N seeded random snaps (no coordinates).
//! - `kompass match --build <dir> [--geojson <dir>] [--explored <file>] <gpx files or directories>`:
//!   map-matches recorded tracks, prints aggregate numbers (`docs/matching.md`).

mod gpx;
mod matchcmd;

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use kompass_core::spatial::{DEFAULT_CELL_M, Grid};
use kompass_core::{Graph, LngLat};

const USAGE: &str = "usage: kompass [--version | --help]
       kompass compile --build <dir> [--zoom <z>]
       kompass info --build <dir> [--snaps <n>]
       kompass match --build <dir> [--geojson <dir>] [--explored <file>] [--no-geometry]
                     [--radius|--candidates|--sigma|--beta|--step|--skip|--gap|--spur <v>] <gpx files or directories>";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        None | Some("--version" | "-V" | "version") => {
            println!("kompass {}", kompass_core::version());
            Ok(())
        }
        Some("--help" | "-h" | "help") => {
            println!("{USAGE}");
            Ok(())
        }
        Some("compile") => Options::parse(&args[1..]).and_then(|o| compile(&o)),
        Some("info") => Options::parse(&args[1..]).and_then(|o| info(&o)),
        Some("match") => matchcmd::run(&args[1..]),
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

enum Failure {
    Usage(String),
    Run(String),
}

impl From<kompass_compile::Error> for Failure {
    fn from(e: kompass_compile::Error) -> Failure {
        Failure::Run(e.0)
    }
}

struct Options {
    build: PathBuf,
    zoom: u8,
    snaps: usize,
}

impl Options {
    fn parse(args: &[String]) -> Result<Options, Failure> {
        let mut o = Options {
            build: PathBuf::new(),
            zoom: kompass_compile::DEFAULT_TILE_ZOOM,
            snaps: 100_000,
        };
        let mut it = args.iter();
        while let Some(flag) = it.next() {
            let mut value = || {
                it.next()
                    .ok_or_else(|| Failure::Usage(format!("{flag} needs a value")))
            };
            match flag.as_str() {
                "--build" => o.build = PathBuf::from(value()?),
                "--zoom" => {
                    o.zoom = value()?
                        .parse()
                        .ok()
                        .filter(|z| (8..=16).contains(z))
                        .ok_or_else(|| Failure::Usage("--zoom must be 8..16".into()))?;
                }
                "--snaps" => {
                    o.snaps = value()?
                        .parse()
                        .map_err(|_| Failure::Usage("--snaps must be a number".into()))?;
                }
                other => return Err(Failure::Usage(format!("unknown option `{other}`"))),
            }
        }
        if o.build.as_os_str().is_empty() {
            return Err(Failure::Usage("--build <dir> is required".into()));
        }
        Ok(o)
    }
}

#[allow(clippy::cast_precision_loss, reason = "sizes for display")]
fn mb(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1e6)
}

fn compile(o: &Options) -> Result<(), Failure> {
    let t = Instant::now();
    let (graph, stats, written) = kompass_compile::compile_build(&o.build, o.zoom)?;
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
fn peak_rss() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    line.split_whitespace()
        .nth(1)?
        .parse::<u64>()
        .ok()
        .map(|kb| kb * 1024)
}

/// A deterministic xorshift for the snap queries.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    #[allow(clippy::cast_precision_loss, reason = "a uniform value in -1..1")]
    fn signed(&mut self) -> f64 {
        (self.next() % 2_000_001) as f64 / 1e6 - 1.0
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
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
fn info(o: &Options) -> Result<(), Failure> {
    let (graph, t) = kompass_compile::build::load(&o.build, true)?;
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
    if o.snaps > 0 && graph.node_count() > 0 {
        snaps(&graph, &grid, o.snaps);
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
            let v = (rng.next() % graph.node_count() as u64) as u32;
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
