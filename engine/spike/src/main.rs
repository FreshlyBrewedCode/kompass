//! Spike #4: engine route speed. `kompass-spike <command>`:
//!
//! - `compile <edges.parquet> <out>`: graph blob, geometry, tiles (z10–z12), sizes raw/gzip/brotli
//! - `bench <out> [pairs]`: profile compile, landmarks, route benchmark (native)
//! - `tiles <out>`: tiles and bytes a 50 km route touches, corridor preload
//! - `spatial <out>`: nearest-edge grid build, memory, query time
//!
//! Benchmark pairs are seeded random node pairs, generated at run time. Outputs carry no
//! coordinates.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_lossless,
    clippy::many_single_char_names,
    clippy::missing_errors_doc,
    clippy::missing_panics_doc,
    clippy::chunks_exact_to_as_chunks,
    clippy::too_many_lines,
    clippy::similar_names,
    clippy::doc_markdown,
    clippy::map_unwrap_or,
    clippy::format_push_string,
    dead_code,
    reason = "spike #4: graph ids and counts fit in u32 by construction (≤ 2^32 nodes / arcs); quantisation casts are deliberate"
)]

mod compile;

use std::io::Write;
use std::time::Instant;

use kompass_core::bench::{self, Algo, Rng, Runner, Sample};
use kompass_core::graph::Graph;
use kompass_core::profile::Profile;
use kompass_core::search::{Landmarks, Plane};
use kompass_core::spatial::{Geometry, Grid};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |i: usize| args.get(i).map(String::as_str).unwrap_or_else(|| usage());
    match arg(0) {
        "compile" => cmd_compile(arg(1), arg(2)),
        "bench" => cmd_bench(arg(1), args.get(2).map_or(100, |s| s.parse().expect("pairs"))),
        "tiles" => cmd_tiles(arg(1)),
        "spatial" => cmd_spatial(arg(1)),
        _ => usage(),
    }
}

fn usage() -> ! {
    eprintln!(
        "usage: kompass-spike compile <edges.parquet> <out> | bench <out> [pairs] | tiles <out> | spatial <out>"
    );
    std::process::exit(2)
}

fn mb(bytes: usize) -> String {
    format!("{:.1} MB", bytes as f64 / 1e6)
}

fn gzip(data: &[u8], level: u32) -> usize {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(level));
    e.write_all(data).unwrap();
    e.finish().unwrap().len()
}

fn brotli(data: &[u8], quality: u32) -> usize {
    let mut out = Vec::new();
    {
        let mut w = brotli::CompressorWriter::new(&mut out, 1 << 16, quality, 22);
        w.write_all(data).unwrap();
    }
    out.len()
}

fn sizes(name: &str, data: &[u8], br11: bool) {
    let t = Instant::now();
    let (g6, g9, b9) = (gzip(data, 6), gzip(data, 9), brotli(data, 9));
    let b11 = if br11 { mb(brotli(data, 11)) } else { "–".into() };
    println!(
        "| {name} | {} | {} | {} | {} | {b11} |  ({:.0} s)",
        mb(data.len()),
        mb(g6),
        mb(g9),
        mb(b9),
        t.elapsed().as_secs_f64()
    );
}

fn time<T>(f: impl FnOnce() -> T) -> (T, f64) {
    let t = Instant::now();
    let r = f();
    (r, t.elapsed().as_secs_f64() * 1e3)
}

fn load(dir: &str) -> (Graph, f64, f64) {
    let (bytes, read_ms) = time(|| std::fs::read(format!("{dir}/graph.kmpg")).expect("graph.kmpg"));
    let (g, parse_ms) = time(|| Graph::read(&bytes).expect("graph"));
    (g, read_ms, parse_ms)
}

fn cmd_compile(parquet: &str, out: &str) {
    std::fs::create_dir_all(out).unwrap();
    let (c, ms) = time(|| compile::compile(parquet));
    let g = &c.graph;
    println!(
        "compiled {} edges, {} nodes, {} points in {:.1} s; node position mismatch ≤ {} e-7 deg",
        g.edge_count(),
        g.node_count(),
        c.points,
        ms / 1e3,
        c.node_mismatch
    );
    let blob = g.write();
    let geo = c.geometry.write();
    std::fs::write(format!("{out}/graph.kmpg"), &blob).unwrap();
    std::fs::write(format!("{out}/geometry.kmpg"), &geo).unwrap();
    println!("\n| file | raw | gzip -6 | gzip -9 | brotli 9 | brotli 11 |\n|---|---:|---:|---:|---:|---:|");
    sizes("graph.kmpg (blob)", &blob, true);
    sizes("geometry.kmpg", &geo, false);

    // per column, to see what dominates
    println!("\n| column | raw | gzip -6 | gzip -9 | brotli 9 | brotli 11 |\n|---|---:|---:|---:|---:|---:|");
    let r = kompass_core::graph::Reader::new(&blob).unwrap();
    for name in [
        "lon_____", "lat_____", "from____", "to______", "len_dm__", "highway_", "surf____", "smooth__",
        "access__", "road____", "speed___", "diff____", "ctx_____", "ctx2____", "asc_fwd_", "asc_bwd_",
        "grd_fwd_", "grd_bwd_",
    ] {
        let name_b: [u8; 8] = name.as_bytes().try_into().unwrap();
        sizes(name.trim_end_matches('_'), r.bytes(name_b).unwrap(), false);
    }
    // a delta transform of the topology (how much an encoding step would buy)
    let delta = |v: &[u32]| -> Vec<u8> {
        let mut prev = 0i64;
        let mut out = Vec::new();
        for &x in v {
            let d = i64::from(x) - prev;
            prev = i64::from(x);
            let z = ((d << 1) ^ (d >> 63)) as u64;
            let mut z = z;
            while z >= 0x80 {
                out.push((z as u8) | 0x80);
                z >>= 7;
            }
            out.push(z as u8);
        }
        out
    };
    sizes("from (delta varint)", &delta(&g.from), false);
    sizes("to (delta varint)", &delta(&g.to), false);
    let lon: Vec<u32> = g.lon.iter().map(|&x| x as u32).collect();
    sizes("lon (delta varint)", &delta(&lon), false);

    println!(
        "\n| tiles | count | edges/tile p50 / max | cross-tile edges | raw sum | gzip -6 sum | brotli 9 sum | gzip -6 p50 / max per tile |\n|---|---:|---:|---:|---:|---:|---:|---:|"
    );
    for zoom in [10, 11, 12] {
        let t = compile::tiling(&c, zoom);
        let mut raw = 0;
        let mut gz = Vec::new();
        let mut br = 0;
        let mut per_tile_edges: Vec<usize> = t.tiles.iter().map(|r| r.edges.len()).collect();
        let dir = format!("{out}/tiles-z{zoom}");
        std::fs::create_dir_all(&dir).unwrap();
        let mut index = String::from("[");
        for (i, r) in t.tiles.iter().enumerate() {
            let bytes = g.write_range(r.nodes.clone(), r.edges.clone());
            raw += bytes.len();
            gz.push(gzip(&bytes, 6));
            br += brotli(&bytes, 9);
            std::fs::write(format!("{dir}/{i}.kmpg"), &bytes).unwrap();
            if i > 0 {
                index.push(',');
            }
            index.push_str(&format!("{{\"file\":\"{i}.kmpg\",\"bytes\":{}}}", bytes.len()));
        }
        index.push(']');
        std::fs::write(format!("{dir}/index.json"), index).unwrap();
        let cross = (0..g.edge_count())
            .filter(|&e| t.node_tile[g.from[e] as usize] != t.node_tile[g.to[e] as usize])
            .count();
        per_tile_edges.sort_unstable();
        let gz_sum: usize = gz.iter().sum();
        gz.sort_unstable();
        println!(
            "| z{zoom} | {} | {} / {} | {} ({:.2} %) | {} | {} | {} | {} / {} |",
            t.tiles.len(),
            per_tile_edges[per_tile_edges.len() / 2],
            per_tile_edges.last().unwrap(),
            cross,
            cross as f64 * 100.0 / g.edge_count() as f64,
            mb(raw),
            mb(gz_sum),
            mb(br),
            mb(gz[gz.len() / 2]),
            mb(*gz.last().unwrap())
        );
    }
    // the Hilbert keys, for the tiles command
    let hb: Vec<u8> = c.hilbert.iter().flat_map(|h| h.to_le_bytes()).collect();
    std::fs::write(format!("{out}/hilbert.u32"), hb).unwrap();
}

fn pair_sets(g: &Graph, costs: &[&[f32]], n: usize) -> Vec<Vec<(u32, u32)>> {
    let mut rng = Rng(0x4b4f_4d50_4153_5304);
    let nodes = bench::candidates(g, costs, &mut rng);
    bench::BUCKETS
        .iter()
        .map(|&(_, lo, hi)| bench::pairs(g, &nodes, &mut rng, lo, hi, n))
        .collect()
}

fn now_ms() -> f64 {
    use std::sync::OnceLock;
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1e3
}

fn cmd_bench(dir: &str, n: usize) {
    let (g, read_ms, parse_ms) = load(dir);
    println!(
        "load: read {read_ms:.0} ms, parse + CSR {parse_ms:.0} ms; graph heap {}",
        mb(g.heap_bytes())
    );
    let profiles = [Profile::gravel_explorer(), Profile::paved_quiet()];
    let mut costs: Vec<Vec<f32>> = Vec::new();
    for p in &profiles {
        let mut c = Vec::new();
        let mut best = f64::INFINITY;
        for _ in 0..5 {
            best = best.min(time(|| p.compile_into(&g, &mut c)).1);
        }
        let forbidden = c.iter().filter(|x| x.is_infinite()).count();
        println!(
            "compile {}: {best:.1} ms (best of 5), {} arcs, {:.1} % forbidden",
            p.name,
            c.len(),
            forbidden as f64 * 100.0 / c.len() as f64
        );
        costs.push(c);
    }
    let natural_min = |p: &Profile| {
        let mut m = f32::INFINITY;
        for e in 0..g.edge_count() {
            let f = p.edge_factor(&g, e);
            if f.is_finite() {
                m = m.min(f);
            }
        }
        m
    };
    for p in &profiles {
        println!(
            "{}: smallest unclamped factor product {:.3}, clamp {}",
            p.name,
            natural_min(p),
            p.min_factor
        );
    }
    let (lm8, lm8_ms) = time(|| Landmarks::build(&g, 8, 0));
    let (lm16, lm16_ms) = time(|| Landmarks::build(&g, 16, 0));
    println!(
        "landmarks: 8 in {:.1} s ({}), 16 in {:.1} s ({})",
        lm8_ms / 1e3,
        mb(lm8.dist.len() * 2),
        lm16_ms / 1e3,
        mb(lm16.dist.len() * 2)
    );
    std::fs::write(
        format!("{dir}/landmarks8.u16"),
        kompass_core::graph::le_u16(&lm8.dist),
    )
    .unwrap();
    let cref: Vec<&[f32]> = costs.iter().map(Vec::as_slice).collect();
    let sets = pair_sets(&g, &cref, n);
    let mut runner = Runner::new(&g);
    let plane = Plane::for_graph(&g);
    let mut json = Vec::new();
    println!(
        "\n| profile | bucket | algo | route km p50 | ms p50 | ms p95 | ms max | settled p50 | settled p95 | settled max |\n|---|---|---|---:|---:|---:|---:|---:|---:|---:|"
    );
    let algos = [
        (Algo::AStar, None),
        (Algo::AStarLazy, None),
        (Algo::Bidi, None),
        (Algo::Alt, Some(&lm8)),
        (Algo::AltBidi, Some(&lm8)),
        (Algo::Alt, Some(&lm16)),
        (Algo::AltBidi, Some(&lm16)),
        (Algo::Dijkstra, None),
    ];
    for (p, c) in profiles.iter().zip(&costs) {
        for (b, pairs) in bench::BUCKETS.iter().zip(&sets) {
            let mut bound_ratio = Vec::new();
            for &(algo, lm) in &algos {
                if algo == Algo::Dijkstra && b.0 != "50km" {
                    continue;
                }
                let samples: Vec<Sample> = pairs
                    .iter()
                    .map(|&pq| runner.run(&g, c, p, lm, algo, pq, &now_ms).0)
                    .collect();
                if algo == Algo::AStar {
                    for (s, &(a, z)) in samples.iter().zip(pairs) {
                        if s.found {
                            bound_ratio.push(f64::from(plane.dist(&g, a, z) * p.min_factor / s.cost));
                        }
                    }
                }
                let st = bench::stats(&samples);
                let name = match lm {
                    Some(l) => format!("{}{}", algo.name(), l.count),
                    None => algo.name().to_owned(),
                };
                println!(
                    "| {} | {} | {name} | {:.1} | {:.1} | {:.1} | {:.1} | {:.0} | {:.0} | {:.0} |",
                    p.name,
                    b.0,
                    st.km_p50,
                    st.ms_p50,
                    st.ms_p95,
                    st.ms_max,
                    st.settled_p50,
                    st.settled_p95,
                    st.settled_max
                );
                json.push(format!(
                    "{{\"where\":\"native\",\"profile\":\"{}\",\"bucket\":\"{}\",\"algo\":\"{name}\",\"stats\":{}}}",
                    p.name,
                    b.0,
                    st.json()
                ));
            }
            bound_ratio.sort_by(f64::total_cmp);
            if !bound_ratio.is_empty() {
                println!(
                    "|  | {} | bound / cost at the source: p50 {:.2} |  |  |  |  |  |  |  |",
                    b.0,
                    bound_ratio[bound_ratio.len() / 2]
                );
            }
        }
    }

    // the clamp sweep: how the smallest allowed factor drives search effort (gravel, 50 km)
    println!(
        "\n| gravel min_factor | algo | ms p50 | ms p95 | settled p50 | bound/cost p50 | cost change vs 0.5 p50 |\n|---:|---|---:|---:|---:|---:|---:|"
    );
    let base_costs: Vec<f32> = {
        let pairs = &sets[1];
        pairs
            .iter()
            .map(|&pq| {
                runner
                    .run(&g, &costs[0], &profiles[0], None, Algo::Bidi, pq, &now_ms)
                    .0
                    .cost
            })
            .collect()
    };
    for mf in [0.3f32, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0] {
        let mut p = Profile::gravel_explorer();
        p.min_factor = mf;
        let c = p.compile(&g);
        for algo in [Algo::AStar, Algo::Bidi, Algo::AltBidi] {
            let samples: Vec<Sample> = sets[1]
                .iter()
                .map(|&pq| runner.run(&g, &c, &p, Some(&lm8), algo, pq, &now_ms).0)
                .collect();
            let st = bench::stats(&samples);
            let mut ratio: Vec<f64> = samples
                .iter()
                .zip(&sets[1])
                .filter(|(s, _)| s.found)
                .map(|(s, &(a, z))| f64::from(plane.dist(&g, a, z) * mf / s.cost))
                .collect();
            ratio.sort_by(f64::total_cmp);
            let mut change: Vec<f64> = samples
                .iter()
                .zip(&base_costs)
                .filter(|(s, _)| s.found)
                .map(|(s, &b)| f64::from(s.cost / b - 1.0) * 100.0)
                .collect();
            change.sort_by(f64::total_cmp);
            println!(
                "| {mf} | {} | {:.1} | {:.1} | {:.0} | {:.2} | {:+.1} % |",
                algo.name(),
                st.ms_p50,
                st.ms_p95,
                st.settled_p50,
                ratio[ratio.len() / 2],
                change[change.len() / 2]
            );
        }
    }
    std::fs::write(format!("{dir}/bench-native.jsonl"), json.join("\n") + "\n").unwrap();
}

fn cmd_tiles(dir: &str) {
    let (g, _, _) = load(dir);
    let hb = std::fs::read(format!("{dir}/hilbert.u32")).unwrap();
    let hilbert: Vec<u32> = hb
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
        .collect();
    let c = compile::Compiled {
        graph: g,
        geometry: Geometry::default(),
        hilbert,
        node_mismatch: 0,
        points: 0,
    };
    let g = &c.graph;
    let profiles = [Profile::gravel_explorer(), Profile::paved_quiet()];
    let costs: Vec<Vec<f32>> = profiles.iter().map(|p| p.compile(g)).collect();
    let cref: Vec<&[f32]> = costs.iter().map(Vec::as_slice).collect();
    let sets = pair_sets(g, &cref, 100);
    let mut runner = Runner::new(g);
    let plane = Plane::for_graph(g);
    println!(
        "| zoom | profile | bucket | route tiles p50 / max | settled tiles p50 / max | corridor | corridor tiles p50 / max | corridor gzip MB p50 / max | same cost in corridor |\n|---|---|---|---:|---:|---|---:|---:|---:|"
    );
    for zoom in [10, 11, 12] {
        let t = compile::tiling(&c, zoom);
        let tile_gz: Vec<usize> = t
            .tiles
            .iter()
            .map(|r| gzip(&g.write_range(r.nodes.clone(), r.edges.clone()), 6))
            .collect();
        for (pi, p) in profiles.iter().enumerate() {
            for (bi, b) in bench::BUCKETS.iter().enumerate() {
                if b.0 == "10km" {
                    continue;
                }
                let mut route_tiles = Vec::new();
                let mut settled_tiles = Vec::new();
                let mut corridor = [(Vec::new(), Vec::new(), 0usize), (Vec::new(), Vec::new(), 0usize)];
                for &(s, z) in &sets[bi] {
                    let (sample, arcs) = runner.run(g, &costs[pi], p, None, Algo::Bidi, (s, z), &now_ms);
                    if !sample.found {
                        continue;
                    }
                    let mut tiles: Vec<u32> = arcs.iter().map(|&a| t.node_tile[g.head(a) as usize]).collect();
                    tiles.push(t.node_tile[s as usize]);
                    tiles.sort_unstable();
                    tiles.dedup();
                    route_tiles.push(tiles.len());
                    let mut st: Vec<u32> = (0..g.node_count() as u32)
                        .filter(|&v| runner.two.fwd.closed(v) || runner.two.bwd.closed(v))
                        .map(|v| t.node_tile[v as usize])
                        .collect();
                    st.sort_unstable();
                    st.dedup();
                    settled_tiles.push(st.len());
                    // corridor: tiles whose node bbox comes within a buffer of the segment s–z
                    let d = plane.dist(g, s, z);
                    for (ci, buffer) in [(0usize, (0.2 * d).max(5000.0)), (1, (0.35 * d).max(8000.0))] {
                        let inside: Vec<bool> = t
                            .tiles
                            .iter()
                            .map(|r| bbox_near_segment(g, r.bbox, s, z, buffer))
                            .collect();
                        let n_tiles = inside.iter().filter(|&&x| x).count();
                        let bytes: usize = inside
                            .iter()
                            .zip(&tile_gz)
                            .filter(|(x, _)| **x)
                            .map(|(_, b)| b)
                            .sum();
                        let mut cc = costs[pi].clone();
                        for (e, pair) in cc.chunks_exact_mut(2).enumerate() {
                            if !inside[t.node_tile[g.from[e] as usize] as usize]
                                || !inside[t.node_tile[g.to[e] as usize] as usize]
                            {
                                pair.fill(f32::INFINITY);
                            }
                        }
                        let r = runner.run(g, &cc, p, None, Algo::Bidi, (s, z), &now_ms).0;
                        let same = r.found && (r.cost - sample.cost).abs() <= sample.cost * 1e-5;
                        corridor[ci].0.push(n_tiles);
                        corridor[ci].1.push(bytes);
                        corridor[ci].2 += usize::from(same);
                    }
                }
                let pm = |v: &mut Vec<usize>| {
                    v.sort_unstable();
                    (v[v.len() / 2], *v.last().unwrap())
                };
                let (r50, rmax) = pm(&mut route_tiles);
                let (s50, smax) = pm(&mut settled_tiles);
                let n = route_tiles.len();
                for (ci, name) in [(0, "0.2 d, ≥ 5 km"), (1, "0.35 d, ≥ 8 km")] {
                    let (c50, cmax) = pm(&mut corridor[ci].0);
                    let (b50, bmax) = pm(&mut corridor[ci].1);
                    println!(
                        "| z{zoom} ({} tiles) | {} | {} | {r50} / {rmax} | {s50} / {smax} | {name} | {c50} / {cmax} | {:.1} / {:.1} | {}/{n} |",
                        t.tiles.len(),
                        p.name,
                        b.0,
                        b50 as f64 / 1e6,
                        bmax as f64 / 1e6,
                        corridor[ci].2
                    );
                }
            }
        }
    }
}

/// Whether a bbox (1e-7 deg) comes within `buffer` metres of the segment between nodes s and z.
fn bbox_near_segment(g: &Graph, bbox: [i32; 4], s: u32, z: u32, buffer: f32) -> bool {
    // planar metres around s, with the latitude cosine at s
    let k = 0.011_119_5_f32;
    let cos = (g.lat[s as usize] as f32 * 1e-7).to_radians().cos();
    let xy = |lon: i32, lat: i32| {
        (
            (lon - g.lon[s as usize]) as f32 * k * cos,
            (lat - g.lat[s as usize]) as f32 * k,
        )
    };
    let (bx, by) = xy(g.lon[z as usize], g.lat[z as usize]);
    let (x0, y0) = xy(bbox[0], bbox[1]);
    let (x1, y1) = xy(bbox[2], bbox[3]);
    // distance between the segment and the box: sample the segment densely (cheap, fine for a spike)
    let steps = 200;
    (0..=steps).any(|i| {
        let f = i as f32 / steps as f32;
        let (px, py) = (bx * f, by * f);
        let dx = (x0 - px).max(0.0).max(px - x1);
        let dy = (y0 - py).max(0.0).max(py - y1);
        dx * dx + dy * dy <= buffer * buffer
    })
}

fn cmd_spatial(dir: &str) {
    let (g, _, _) = load(dir);
    let (bytes, read_ms) = time(|| std::fs::read(format!("{dir}/geometry.kmpg")).unwrap());
    let (geo, parse_ms) = time(|| Geometry::read(&bytes).unwrap());
    println!(
        "geometry: read {read_ms:.0} ms, parse {parse_ms:.0} ms, heap {}",
        mb(geo.heap_bytes())
    );
    let mut rng = Rng(42);
    // query points: random nodes moved by up to ±150 m (1e-7 deg ≈ 1.1 cm)
    let queries: Vec<(i32, i32)> = (0..100_000)
        .map(|_| {
            let v = rng.below(g.node_count());
            let dx = (rng.below(27_000) as i32) - 13_500;
            let dy = (rng.below(27_000) as i32) - 13_500;
            (g.lon[v] + dx, g.lat[v] + dy)
        })
        .collect();
    println!(
        "\n| cell | build | cells | entries | heap | query p50 | query p95 | query max |\n|---:|---:|---:|---:|---:|---:|---:|---:|"
    );
    for cell in [100.0, 200.0, 400.0] {
        let (grid, build_ms) = time(|| Grid::build(&g, &geo, cell));
        let mut us: Vec<f64> = Vec::with_capacity(queries.len());
        let mut found = 0;
        for &(lon, lat) in &queries {
            let t = Instant::now();
            let r = grid.nearest(&g, &geo, lon, lat, 500.0);
            us.push(t.elapsed().as_secs_f64() * 1e6);
            found += usize::from(r.is_some());
        }
        us.sort_by(f64::total_cmp);
        println!(
            "| {cell} m | {build_ms:.0} ms | {} | {} | {} | {:.1} µs | {:.1} µs | {:.0} µs |  found {found}/{}",
            grid.cells(),
            grid.entries(),
            mb(grid.heap_bytes()),
            us[us.len() / 2],
            us[us.len() * 95 / 100],
            us.last().unwrap(),
            queries.len()
        );
    }
}
