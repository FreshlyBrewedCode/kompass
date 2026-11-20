//! Reading `edges.parquet` into a [`Graph`]: nodes numbered by first appearance along the
//! Hilbert-sorted edges, so every tile is a contiguous range of edges and of nodes.

use std::collections::HashMap;
use std::fs::File;
use std::path::Path;

use arrow_array::cast::AsArray;
use arrow_array::types::{Float32Type, Int8Type, Int64Type, UInt8Type, UInt16Type, UInt32Type};
use arrow_array::{Array, ArrayRef, RecordBatch};
use arrow_schema::DataType;
use kompass_core::Graph;
use kompass_core::assemble::Assembler;
use kompass_core::attrs::{
    BikeAccess, CyclewayKind, EdgeAttrs, Highway, MotorAccess, MtbScale, Oneway, RouteLevel, SacScale,
    Smoothness, SurfaceClass, Tracktype, TrailVisibility, UNUSED_ENUM_COLUMNS, code_tables,
};
use kompass_core::geometry::WayRef;
use parquet::arrow::ProjectionMask;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

use crate::{Error, SCHEMA_VERSION};

const COLUMNS: &[&str] = &[
    "edge_id",
    "hilbert_z16",
    "way_id",
    "way_pos_from",
    "way_pos_to",
    "node_from",
    "node_to",
    "length_m",
    "highway",
    "surface_class",
    "tracktype",
    "smoothness",
    "maxspeed_kmh",
    "lanes",
    "bike_access",
    "motor_access",
    "cycleway_kind",
    "route_level",
    "mtb_route",
    "oneway_bike",
    "width_m",
    "trail_visibility",
    "mtb_scale",
    "sac_scale",
    "informal",
    "on_bridge",
    "in_tunnel",
    "n_barriers",
    "forest_share",
    "forest_edge_share",
    "water_share",
    "builtup_share",
    "road_near_share",
    "ascent_fwd_m",
    "ascent_bwd_m",
    "max_grade_fwd_pct",
    "max_grade_bwd_pct",
    "geometry",
];

/// What the compiler saw (for the command line and the report; no coordinates).
#[derive(Debug, Clone, Default)]
pub struct CompileStats {
    pub build_id: String,
    pub edges: usize,
    pub nodes: usize,
    pub tiles: usize,
    /// Geometry points in the file (end nodes included).
    pub points: usize,
    /// Edges whose end nodes lie in different tiles.
    pub cross_tile_edges: usize,
    /// The largest disagreement between edges about a node's position, 1e-7 degrees.
    pub node_mismatch_e7: i64,
    pub max_length_m: f32,
}

fn column<'a>(batch: &'a RecordBatch, name: &str) -> Result<&'a ArrayRef, Error> {
    batch
        .column_by_name(name)
        .ok_or_else(|| Error(format!("edges.parquet has no column `{name}`")))
}

/// A numeric or boolean column as f64 (nulls → NaN).
fn num(batch: &RecordBatch, name: &str) -> Result<Vec<f64>, Error> {
    let a = column(batch, name)?;
    let n = a.len();
    let get = |i: usize, v: f64| if a.is_null(i) { f64::NAN } else { v };
    Ok(match a.data_type() {
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
        t => return Err(Error(format!("column `{name}`: unexpected type {t}"))),
    })
}

fn i64s(batch: &RecordBatch, name: &str) -> Result<Vec<i64>, Error> {
    let a = column(batch, name)?;
    match a.data_type() {
        DataType::Int64 => Ok(a.as_primitive::<Int64Type>().values().to_vec()),
        t => Err(Error(format!("column `{name}`: expected int64, got {t}"))),
    }
}

/// A WKB `LineString`'s points as 1e-7 degrees.
#[allow(
    clippy::cast_possible_truncation,
    reason = "valid coordinates fit i32 at 1e-7 degrees"
)]
fn wkb_points(wkb: &[u8], out: &mut Vec<(i32, i32)>) -> Result<(), Error> {
    out.clear();
    let bad = || Error("geometry: expected a little-endian 2D WKB LineString".into());
    let head = wkb.get(0..9).ok_or_else(bad)?;
    if head[0] != 1 || u32::from_le_bytes([head[1], head[2], head[3], head[4]]) != 2 {
        return Err(bad());
    }
    let n = u32::from_le_bytes([head[5], head[6], head[7], head[8]]) as usize;
    let body = wkb.get(9..9 + n * 16).ok_or_else(bad)?;
    for c in body.as_chunks::<16>().0 {
        let (xb, yb) = c.split_at(8);
        let x = f64::from_le_bytes(xb.try_into().map_err(|_| bad())?);
        let y = f64::from_le_bytes(yb.try_into().map_err(|_| bad())?);
        out.push(((x * 1e7).round() as i32, (y * 1e7).round() as i32));
    }
    if out.len() < 2 {
        return Err(Error("geometry: a LineString needs two points".into()));
    }
    Ok(())
}

/// Checks the file's `kompass:enums` code tables against the engine's enums.
fn check_enums(json: &str) -> Result<(), Error> {
    let file: serde_json::Map<String, serde_json::Value> = serde_json::from_str(json)?;
    for (column, table) in code_tables() {
        let got = file
            .get(column)
            .and_then(serde_json::Value::as_object)
            .ok_or_else(|| Error(format!("kompass:enums has no table for `{column}`")))?;
        let want: serde_json::Map<String, serde_json::Value> = table
            .iter()
            .map(|(c, l)| (c.to_string(), serde_json::Value::from(*l)))
            .collect();
        if got.len() != want.len() || want.iter().any(|(k, v)| got.get(k) != Some(v)) {
            return Err(Error(format!(
                "the enum codes of `{column}` in edges.parquet differ from the engine's: the schema \
                 changed, the engine's enums (kompass-core attrs.rs) and the graph format version must \
                 follow"
            )));
        }
    }
    if let Some(extra) = file
        .keys()
        .find(|k| !UNUSED_ENUM_COLUMNS.contains(&k.as_str()) && !code_tables().iter().any(|(c, _)| c == k))
    {
        return Err(Error(format!(
            "edges.parquet has an enum column the engine does not know: `{extra}`"
        )));
    }
    Ok(())
}

fn code<T>(v: f64, column: &str, from: impl Fn(u8) -> Option<T>) -> Result<T, Error> {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "checked range"
    )]
    let c = (0.0..=255.0).contains(&v).then_some(v as u8).and_then(from);
    c.ok_or_else(|| Error(format!("column `{column}`: unknown code {v}")))
}

/// `Some(v)` unless null.
fn opt(v: f64) -> Option<f64> {
    (!v.is_nan()).then_some(v)
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "f32 holds every stored value (they came from f32/u8)"
)]
fn f(v: f64) -> f32 {
    v as f32
}

/// Reads `edges.parquet` into a graph with tiles at `zoom`.
#[allow(
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "one pass over the contract's columns; casts of values the schema bounds"
)]
pub fn read_parquet(path: &Path, zoom: u8) -> Result<(Graph, CompileStats), Error> {
    let file = File::open(path).map_err(|e| Error(format!("{}: {e}", path.display())))?;
    let builder = ParquetRecordBatchReaderBuilder::try_new(file)?;
    let meta: HashMap<String, String> = builder
        .metadata()
        .file_metadata()
        .key_value_metadata()
        .map_or_else(HashMap::new, |kv| {
            kv.iter()
                .filter_map(|k| Some((k.key.clone(), k.value.clone()?)))
                .collect()
        });
    let version = meta.get("kompass:schema_version").map(String::as_str);
    if version != Some(&SCHEMA_VERSION.to_string()) {
        return Err(Error(format!(
            "edges.parquet schema version {} is not supported (this compiler reads {SCHEMA_VERSION})",
            version.unwrap_or("(none)")
        )));
    }
    check_enums(
        meta.get("kompass:enums")
            .ok_or_else(|| Error("edges.parquet has no kompass:enums".into()))?,
    )?;
    let build_id = meta
        .get("kompass:build_id")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error("edges.parquet has no kompass:build_id".into()))?
        .clone();
    let rows = usize::try_from(builder.metadata().file_metadata().num_rows()).unwrap_or(0);
    let mask = ProjectionMask::columns(builder.parquet_schema(), COLUMNS.iter().copied());
    let reader = builder.with_projection(mask).with_batch_size(64 * 1024).build()?;

    let mut asm = Assembler::new(&build_id, SCHEMA_VERSION, zoom);
    let mut node_of: HashMap<i64, u32> = HashMap::with_capacity(rows);
    let mut stats = CompileStats {
        build_id,
        ..CompileStats::default()
    };
    let mut pts = Vec::new();
    let mut last_key = 0u32;
    let mut row = 0usize;
    for batch in reader {
        let b = batch?;
        let c = |name: &str| num(&b, name);
        let edge_id = match column(&b, "edge_id")?.data_type() {
            DataType::UInt32 => column(&b, "edge_id")?
                .as_primitive::<UInt32Type>()
                .values()
                .to_vec(),
            t => return Err(Error(format!("column `edge_id`: expected uint32, got {t}"))),
        };
        let (hilbert, pos_from, pos_to) = (c("hilbert_z16")?, c("way_pos_from")?, c("way_pos_to")?);
        let (way, nf, nt) = (i64s(&b, "way_id")?, i64s(&b, "node_from")?, i64s(&b, "node_to")?);
        let (len, highway, surface, tracktype, smooth) = (
            c("length_m")?,
            c("highway")?,
            c("surface_class")?,
            c("tracktype")?,
            c("smoothness")?,
        );
        let (maxspeed, lanes, bike, motor) = (
            c("maxspeed_kmh")?,
            c("lanes")?,
            c("bike_access")?,
            c("motor_access")?,
        );
        let (cycleway, route, mtb_route, oneway) = (
            c("cycleway_kind")?,
            c("route_level")?,
            c("mtb_route")?,
            c("oneway_bike")?,
        );
        let (width, vis, mtb, sac) = (
            c("width_m")?,
            c("trail_visibility")?,
            c("mtb_scale")?,
            c("sac_scale")?,
        );
        let (informal, bridge, tunnel, barriers) =
            (c("informal")?, c("on_bridge")?, c("in_tunnel")?, c("n_barriers")?);
        let (forest, rim, water, builtup, road) = (
            c("forest_share")?,
            c("forest_edge_share")?,
            c("water_share")?,
            c("builtup_share")?,
            c("road_near_share")?,
        );
        let (asc_f, asc_b, grd_f, grd_b) = (
            c("ascent_fwd_m")?,
            c("ascent_bwd_m")?,
            c("max_grade_fwd_pct")?,
            c("max_grade_bwd_pct")?,
        );
        let geom = column(&b, "geometry")?;
        for i in 0..b.num_rows() {
            if edge_id[i] as usize != row {
                return Err(Error(format!(
                    "edge_id {} at row {row}: edge ids must be the row numbers",
                    edge_id[i]
                )));
            }
            let key = hilbert[i] as u32;
            if key < last_key {
                return Err(Error(format!(
                    "row {row}: edges.parquet is not sorted by hilbert_z16"
                )));
            }
            last_key = key;
            let wkb = match geom.data_type() {
                DataType::Binary => geom.as_binary::<i32>().value(i),
                DataType::LargeBinary => geom.as_binary::<i64>().value(i),
                t => return Err(Error(format!("column `geometry`: unexpected type {t}"))),
            };
            wkb_points(wkb, &mut pts)?;
            stats.points += pts.len();
            let (first, last) = (pts[0], pts[pts.len() - 1]);
            // nodes by first appearance; edges sharing a node must agree on its position
            let mut node = |id: i64, at: (i32, i32), asm: &mut Assembler, stats: &mut CompileStats| -> u32 {
                if let Some(&v) = node_of.get(&id) {
                    let q = asm.node_e7(v);
                    let d = i64::from((q.0 - at.0).abs().max((q.1 - at.1).abs()));
                    stats.node_mismatch_e7 = stats.node_mismatch_e7.max(d);
                    v
                } else {
                    let v = asm.add_node(at.0, at.1);
                    node_of.insert(id, v);
                    v
                }
            };
            let a = node(nf[i], first, &mut asm, &mut stats);
            let z = node(nt[i], last, &mut asm, &mut stats);
            let attrs = EdgeAttrs {
                length_m: f(len[i]),
                highway: code(highway[i], "highway", Highway::from_code)?,
                surface: code(surface[i], "surface_class", SurfaceClass::from_code)?,
                tracktype: code(tracktype[i], "tracktype", Tracktype::from_code)?,
                smoothness: code(smooth[i], "smoothness", Smoothness::from_code)?,
                oneway: Oneway::from_code(oneway[i] as i8)
                    .ok_or_else(|| Error(format!("column `oneway_bike`: unknown code {}", oneway[i])))?,
                trail_visibility: code(vis[i], "trail_visibility", TrailVisibility::from_code)?,
                informal: informal[i] > 0.5,
                bike_access: code(bike[i], "bike_access", BikeAccess::from_code)?,
                motor_access: code(motor[i], "motor_access", MotorAccess::from_code)?,
                mtb_route: mtb_route[i] > 0.5,
                cycleway: code(cycleway[i], "cycleway_kind", CyclewayKind::from_code)?,
                route_level: code(route[i], "route_level", RouteLevel::from_code)?,
                bridge: bridge[i] > 0.5,
                tunnel: tunnel[i] > 0.5,
                maxspeed_kmh: opt(maxspeed[i]).map(|v| v.clamp(0.0, 255.0) as u8),
                lanes: opt(lanes[i]).filter(|&v| v >= 1.0).map(|v| v.min(255.0) as u8),
                mtb_scale: code(mtb[i], "mtb_scale", MtbScale::from_code)?,
                sac_scale: code(sac[i], "sac_scale", SacScale::from_code)?,
                barriers: barriers[i].clamp(0.0, 255.0) as u8,
                forest: f(forest[i] / 100.0),
                forest_edge: f(rim[i] / 100.0),
                water: f(water[i] / 100.0),
                builtup: f(builtup[i] / 100.0),
                road_near: f(road[i] / 100.0),
                width_m: opt(width[i]).filter(|&w| w > 0.0).map(f),
                ascent_fwd_m: f(asc_f[i]),
                ascent_bwd_m: f(asc_b[i]),
                max_grade_fwd_pct: f(grd_f[i]),
                max_grade_bwd_pct: f(grd_b[i]),
            };
            stats.max_length_m = stats.max_length_m.max(attrs.length_m);
            let way_ref = WayRef {
                way_id: way[i],
                pos_from: pos_from[i] as u16,
                pos_to: pos_to[i] as u16,
            };
            asm.add_edge(asm.tile_key(key), a, z, &attrs, way_ref, &pts[1..pts.len() - 1])
                .map_err(|e| Error(format!("row {row}: {e}")))?;
            row += 1;
        }
    }
    let graph = asm.finish()?;
    let info = graph.info();
    stats.edges = graph.edge_count();
    stats.nodes = graph.node_count();
    stats.tiles = info.tiles.len();
    stats.cross_tile_edges = (0..graph.edge_count() as u32)
        .filter(|&e| info.tile_of_node(graph.from(e)) != info.tile_of_node(graph.to(e)))
        .count();
    Ok((graph, stats))
}
