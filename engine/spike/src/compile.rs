//! `edges.parquet` (the pipeline contract) → [`Graph`] + [`Geometry`]. Nodes are numbered in order
//! of first appearance along the Hilbert-sorted edges, so every Hilbert tile is a contiguous range
//! of edges *and* of nodes (a node belongs to the tile of its first edge).
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

use std::collections::HashMap;
use std::fs::File;

use arrow_array::cast::AsArray;
use arrow_array::types::{Float32Type, Int8Type, Int64Type, UInt8Type, UInt16Type, UInt32Type};
use arrow_array::{Array, RecordBatch};
use arrow_schema::DataType;
use kompass_core::graph::{Graph, bits};
use kompass_core::spatial::Geometry;
use parquet::arrow::ProjectionMask;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

pub struct Compiled {
    pub graph: Graph,
    pub geometry: Geometry,
    /// Per edge: the Hilbert index of its midpoint's z16 tile.
    pub hilbert: Vec<u32>,
    /// Largest disagreement (1e-7 deg) between edges about a node's position.
    pub node_mismatch: i64,
    pub points: usize,
}

const COLUMNS: &[&str] = &[
    "hilbert_z16",
    "node_from",
    "node_to",
    "length_m",
    "highway",
    "surface_class",
    "tracktype",
    "smoothness",
    "trail_visibility",
    "informal",
    "bike_access",
    "motor_access",
    "mtb_route",
    "cycleway_kind",
    "route_level",
    "on_bridge",
    "in_tunnel",
    "maxspeed_kmh",
    "lanes",
    "mtb_scale",
    "sac_scale",
    "n_barriers",
    "forest_share",
    "forest_edge_share",
    "water_share",
    "builtup_share",
    "road_near_share",
    "width_m",
    "oneway_bike",
    "ascent_fwd_m",
    "ascent_bwd_m",
    "max_grade_fwd_pct",
    "max_grade_bwd_pct",
    "geometry",
];

/// A numeric column as f64 (nulls → NaN).
fn num(batch: &RecordBatch, name: &str) -> Vec<f64> {
    let a = batch
        .column_by_name(name)
        .unwrap_or_else(|| panic!("column {name}"));
    let n = a.len();
    let get = |i: usize, v: f64| if a.is_null(i) { f64::NAN } else { v };
    match a.data_type() {
        DataType::UInt8 => {
            let p = a.as_primitive::<UInt8Type>();
            (0..n).map(|i| get(i, f64::from(p.value(i)))).collect()
        }
        DataType::UInt16 => {
            let p = a.as_primitive::<UInt16Type>();
            (0..n).map(|i| get(i, f64::from(p.value(i)))).collect()
        }
        DataType::UInt32 => {
            let p = a.as_primitive::<UInt32Type>();
            (0..n).map(|i| get(i, f64::from(p.value(i)))).collect()
        }
        DataType::Int8 => {
            let p = a.as_primitive::<Int8Type>();
            (0..n).map(|i| get(i, f64::from(p.value(i)))).collect()
        }
        DataType::Float32 => {
            let p = a.as_primitive::<Float32Type>();
            (0..n).map(|i| get(i, f64::from(p.value(i)))).collect()
        }
        DataType::Boolean => {
            let p = a.as_boolean();
            (0..n)
                .map(|i| get(i, if p.value(i) { 1.0 } else { 0.0 }))
                .collect()
        }
        t => panic!("column {name}: unexpected type {t}"),
    }
}

fn ids(batch: &RecordBatch, name: &str) -> Vec<i64> {
    let a = batch
        .column_by_name(name)
        .unwrap_or_else(|| panic!("column {name}"));
    a.as_primitive::<Int64Type>().values().to_vec()
}

/// A WKB LineString's points as 1e-7 degrees.
fn wkb_points(wkb: &[u8], out: &mut Vec<(i32, i32)>) {
    out.clear();
    assert_eq!(wkb[0], 1, "little-endian WKB");
    let kind = u32::from_le_bytes(wkb[1..5].try_into().unwrap());
    assert_eq!(kind, 2, "2D LineString");
    let n = u32::from_le_bytes(wkb[5..9].try_into().unwrap()) as usize;
    for i in 0..n {
        let at = 9 + i * 16;
        let x = f64::from_le_bytes(wkb[at..at + 8].try_into().unwrap());
        let y = f64::from_le_bytes(wkb[at + 8..at + 16].try_into().unwrap());
        out.push(((x * 1e7).round() as i32, (y * 1e7).round() as i32));
    }
}

fn u8c(v: f64, max: f64) -> u8 {
    if v.is_nan() {
        0
    } else {
        v.round().clamp(0.0, max) as u8
    }
}

/// A 0..100 share as sixteenths (0..=15).
fn sixteenth(v: f64) -> u16 {
    if v.is_nan() {
        0
    } else {
        (v / 100.0 * 15.0).round().clamp(0.0, 15.0) as u16
    }
}

pub fn compile(path: &str) -> Compiled {
    let file = File::open(path).expect("open edges.parquet");
    let builder = ParquetRecordBatchReaderBuilder::try_new(file).expect("parquet");
    let mask = ProjectionMask::columns(builder.parquet_schema(), COLUMNS.iter().copied());
    let reader = builder
        .with_projection(mask)
        .with_batch_size(64 * 1024)
        .build()
        .expect("reader");

    let mut g = Graph::default();
    let mut geo = Geometry::default();
    let mut hilbert = Vec::new();
    let mut node_of: HashMap<i64, u32> = HashMap::new();
    let mut mismatch = 0i64;
    let mut pts = Vec::new();
    let mut points = 0usize;
    let mut node = |id: i64, at: (i32, i32), g: &mut Graph, mismatch: &mut i64| -> u32 {
        if let Some(&v) = node_of.get(&id) {
            let v_ = v as usize;
            let d = i64::from((g.lon[v_] - at.0).abs().max((g.lat[v_] - at.1).abs()));
            *mismatch = (*mismatch).max(d);
            v
        } else {
            let v = g.lon.len() as u32;
            g.lon.push(at.0);
            g.lat.push(at.1);
            node_of.insert(id, v);
            v
        }
    };
    for batch in reader {
        let b = batch.expect("batch");
        let h = num(&b, "hilbert_z16");
        let (nf, nt) = (ids(&b, "node_from"), ids(&b, "node_to"));
        let c = |name: &str| num(&b, name);
        let (len, highway, surface, tracktype) =
            (c("length_m"), c("highway"), c("surface_class"), c("tracktype"));
        let (smooth, vis, informal) = (c("smoothness"), c("trail_visibility"), c("informal"));
        let (bike, motor, mtb_route) = (c("bike_access"), c("motor_access"), c("mtb_route"));
        let (cycleway, route, bridge, tunnel) = (
            c("cycleway_kind"),
            c("route_level"),
            c("on_bridge"),
            c("in_tunnel"),
        );
        let (maxspeed, lanes, mtb, sac, barriers) = (
            c("maxspeed_kmh"),
            c("lanes"),
            c("mtb_scale"),
            c("sac_scale"),
            c("n_barriers"),
        );
        let (forest, rim, water, builtup, road) = (
            c("forest_share"),
            c("forest_edge_share"),
            c("water_share"),
            c("builtup_share"),
            c("road_near_share"),
        );
        let (width, oneway) = (c("width_m"), c("oneway_bike"));
        let (asc_f, asc_b, grd_f, grd_b) = (
            c("ascent_fwd_m"),
            c("ascent_bwd_m"),
            c("max_grade_fwd_pct"),
            c("max_grade_bwd_pct"),
        );
        let geom = b.column_by_name("geometry").expect("geometry");
        let wkb = |i: usize| -> &[u8] {
            match geom.data_type() {
                DataType::Binary => geom.as_binary::<i32>().value(i),
                DataType::LargeBinary => geom.as_binary::<i64>().value(i),
                t => panic!("geometry type {t}"),
            }
        };
        for i in 0..b.num_rows() {
            wkb_points(wkb(i), &mut pts);
            points += pts.len();
            let first = pts[0];
            let last = *pts.last().unwrap();
            let a = node(nf[i], first, &mut g, &mut mismatch);
            let z = node(nt[i], last, &mut g, &mut mismatch);
            g.from.push(a);
            g.to.push(z);
            assert!(len[i] < 6553.0, "edge longer than 6.5 km");
            g.length_dm.push((len[i] * 10.0).round().max(1.0) as u16);
            g.highway.push(u8c(highway[i], 31.0));
            let ow = match oneway[i] as i32 {
                1 => bits::ONEWAY_FWD,
                -1 => bits::ONEWAY_BWD,
                _ => 0,
            };
            g.surf
                .push(u8c(surface[i], 7.0) | (u8c(tracktype[i], 7.0) << 3) | ow);
            g.smooth
                .push(u8c(smooth[i], 15.0) | (u8c(vis[i], 7.0) << 4) | (u8c(informal[i], 1.0) << 7));
            g.access
                .push(u8c(bike[i], 15.0) | (u8c(motor[i], 7.0) << 4) | (u8c(mtb_route[i], 1.0) << 7));
            g.road.push(
                u8c(cycleway[i], 7.0)
                    | (u8c(route[i], 7.0) << 3)
                    | (u8c(bridge[i], 1.0) << 6)
                    | (u8c(tunnel[i], 1.0) << 7),
            );
            g.speed
                .push(u8c(maxspeed[i] / 5.0, 31.0) | (u8c(lanes[i], 7.0) << 5));
            g.diff
                .push(u8c(mtb[i], 7.0) | (u8c(sac[i], 7.0) << 3) | (u8c(barriers[i], 3.0) << 6));
            g.ctx.push(
                sixteenth(forest[i])
                    | (sixteenth(rim[i]) << 4)
                    | (sixteenth(water[i]) << 8)
                    | (sixteenth(builtup[i]) << 12),
            );
            let w = if width[i].is_nan() {
                0
            } else {
                u8c(width[i] / 0.5, 15.0).max(1)
            };
            g.ctx2.push(sixteenth(road[i]) as u8 | (w << 4));
            g.ascent_fwd_dm
                .push((asc_f[i] * 10.0).round().clamp(0.0, 65535.0) as u16);
            g.ascent_bwd_dm
                .push((asc_b[i] * 10.0).round().clamp(0.0, 65535.0) as u16);
            g.grade_fwd.push(u8c(grd_f[i], 255.0));
            g.grade_bwd.push(u8c(grd_b[i], 255.0));
            geo.push(first, &pts[1..pts.len() - 1]);
            hilbert.push(h[i] as u32);
        }
    }
    assert!(
        hilbert.windows(2).all(|w| w[0] <= w[1]),
        "edges sorted by hilbert_z16"
    );
    g.build_adjacency();
    Compiled {
        graph: g,
        geometry: geo,
        hilbert,
        node_mismatch: mismatch,
        points,
    }
}

/// Tiles of one zoom level: contiguous edge and node ranges (see the module docs).
pub struct Tiling {
    pub zoom: u32,
    pub tiles: Vec<TileRange>,
    /// Per node: its tile index.
    pub node_tile: Vec<u32>,
}

#[derive(Debug, Clone)]
pub struct TileRange {
    pub key: u32,
    pub edges: std::ops::Range<usize>,
    pub nodes: std::ops::Range<usize>,
    /// Bounding box of the tile's nodes (1e-7 deg): min lon, min lat, max lon, max lat.
    pub bbox: [i32; 4],
}

pub fn tiling(c: &Compiled, zoom: u32) -> Tiling {
    let g = &c.graph;
    let shift = 2 * (16 - zoom);
    let mut tiles: Vec<TileRange> = Vec::new();
    let mut next_node = 0usize;
    for (e, &h) in c.hilbert.iter().enumerate() {
        let key = h >> shift;
        if tiles.last().is_none_or(|t| t.key != key) {
            if let Some(t) = tiles.last_mut() {
                t.edges.end = e;
            }
            tiles.push(TileRange {
                key,
                edges: e..e,
                nodes: next_node..next_node,
                bbox: [i32::MAX, i32::MAX, i32::MIN, i32::MIN],
            });
        }
        // first appearance numbering: new nodes are exactly next_node, next_node + 1
        for v in [g.from[e], g.to[e]] {
            if v as usize == next_node {
                next_node += 1;
            }
        }
        tiles.last_mut().unwrap().nodes.end = next_node;
    }
    if let Some(t) = tiles.last_mut() {
        t.edges.end = g.edge_count();
    }
    let mut node_tile = vec![0u32; g.node_count()];
    for (i, t) in tiles.iter_mut().enumerate() {
        for v in t.nodes.clone() {
            node_tile[v] = i as u32;
            t.bbox[0] = t.bbox[0].min(g.lon[v]);
            t.bbox[1] = t.bbox[1].min(g.lat[v]);
            t.bbox[2] = t.bbox[2].max(g.lon[v]);
            t.bbox[3] = t.bbox[3].max(g.lat[v]);
        }
    }
    assert_eq!(tiles.last().map(|t| t.nodes.end), Some(g.node_count()));
    Tiling {
        zoom,
        tiles,
        node_tile,
    }
}
