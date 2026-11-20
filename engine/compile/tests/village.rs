//! End to end on the pipeline's invented village (`tests/fixtures/village/edges.parquet`, written by
//! `pipeline/tests/test_engine_fixture.py`): parquet → graph → files in a build dir → loaded back.

use std::fs;
use std::path::{Path, PathBuf};

use arrow_array::cast::AsArray;
use arrow_array::types::{Float32Type, Int8Type, Int64Type, UInt8Type};
use kompass_compile::{DEFAULT_TILE_ZOOM, build, compile_build, read_parquet};
use kompass_core::graph::arc;
use kompass_core::spatial::{DEFAULT_CELL_M, Grid};
use kompass_core::{LngLat, hilbert};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/village/edges.parquet")
}

/// A fresh build dir with the fixture and a manifest.
fn build_dir(name: &str, build_id: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::copy(fixture(), dir.join("edges.parquet")).unwrap();
    let manifest = format!(
        "{{\n  \"schemaVersion\": 1,\n  \"buildId\": \"{build_id}\",\n  \"overlay\": {{ \"file\": \"overlay.pmtiles\" }}\n}}\n"
    );
    fs::write(dir.join("manifest.json"), manifest).unwrap();
    dir
}

#[test]
fn the_graph_carries_the_parquet_rows_by_edge_id() {
    let (g, stats) = read_parquet(&fixture(), DEFAULT_TILE_ZOOM).unwrap();
    assert_eq!(stats.build_id, "build123");
    assert_eq!(g.edge_count(), 19);
    assert_eq!(stats.node_mismatch_e7, 0);
    // the village sits on 0°N 0°E, a tile corner at every zoom: several tiles, edges across them
    assert!(stats.tiles >= 2, "{} tiles", stats.tiles);
    assert!(stats.cross_tile_edges > 0);

    let file = fs::File::open(fixture()).unwrap();
    let batch = ParquetRecordBatchReaderBuilder::try_new(file)
        .unwrap()
        .build()
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
    let col = |n: &str| batch.column_by_name(n).unwrap().clone();
    let length = col("length_m");
    let length = length.as_primitive::<Float32Type>();
    let oneway = col("oneway_bike");
    let oneway = oneway.as_primitive::<Int8Type>();
    let surface = col("surface_class");
    let surface = surface.as_primitive::<UInt8Type>();
    let way = col("way_id");
    let way = way.as_primitive::<Int64Type>();
    let forest = col("forest_share");
    let forest = forest.as_primitive::<UInt8Type>();
    let ascent = col("ascent_fwd_m");
    let ascent = ascent.as_primitive::<Float32Type>();
    for row in 0..batch.num_rows() {
        let e = u32::try_from(row).unwrap();
        assert!((g.length_m(e) - length.value(row)).abs() <= 0.05, "edge {e}");
        assert_eq!(g.oneway(e).code(), oneway.value(row), "edge {e}");
        assert_eq!(g.surface(e).code(), surface.value(row), "edge {e}");
        assert_eq!(g.way(e).unwrap().way_id, way.value(row), "edge {e}");
        assert!((g.forest_share(e) * 100.0 - f32::from(forest.value(row))).abs() <= 100.0 / 30.0);
        assert!((g.ascent_m(arc(e, false)) - ascent.value(row)).abs() <= 0.05);
    }
}

#[test]
fn tiles_are_the_web_mercator_tiles_of_the_edge_midpoints() {
    // the Hilbert decoding agrees with the pipeline's key: each edge's midpoint (by planar length,
    // like shapely) lies in its tile
    let (g, _) = read_parquet(&fixture(), DEFAULT_TILE_ZOOM).unwrap();
    for (t, tile) in g.info().tiles.iter().enumerate() {
        for e in tile.edges.clone() {
            let pts: Vec<(f64, f64)> = g
                .edge_points(e)
                .map(|p| (f64::from(p.0) * 1e-7, f64::from(p.1) * 1e-7))
                .collect();
            let seg = |w: &[(f64, f64)]| (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1);
            let mut left = pts.windows(2).map(seg).sum::<f64>() / 2.0;
            let mut mid = pts[0];
            for w in pts.windows(2) {
                let l = seg(w);
                if left <= l {
                    let k = if l > 0.0 { left / l } else { 0.0 };
                    mid = (w[0].0 + (w[1].0 - w[0].0) * k, w[0].1 + (w[1].1 - w[0].1) * k);
                    break;
                }
                left -= l;
            }
            assert_eq!(
                hilbert::tile_of(mid.0, mid.1, DEFAULT_TILE_ZOOM),
                (tile.x, tile.y),
                "edge {e} tile {t}"
            );
        }
    }
}

#[test]
fn compiles_into_a_build_dir_and_loads_back() {
    let dir = build_dir("village-build", "build123");
    let (graph, stats, written) = compile_build(&dir, DEFAULT_TILE_ZOOM).unwrap();
    assert_eq!(stats.edges, 19);
    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
    // the other keys stay, in order; the graph key lists every file with its size
    let keys: Vec<&String> = manifest.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["schemaVersion", "buildId", "overlay", "graph"]);
    let mg = &manifest["graph"];
    assert_eq!(mg, &written.manifest_graph);
    assert_eq!(mg["formatVersion"], 1);
    assert_eq!(mg["buildId"], "build123");
    assert_eq!(mg["tileZoom"], 11);
    assert_eq!(mg["edges"], 19);
    assert_eq!(mg["tiles"].as_array().unwrap().len(), stats.tiles);
    let mut total = 0;
    for (file, bytes) in &written.files {
        assert_eq!(fs::metadata(dir.join(file)).unwrap().len(), *bytes, "{file}");
        assert!(file.starts_with("graph/"));
        total += bytes;
    }
    assert_eq!(mg["bytes"], total);
    let tile = &mg["tiles"][0];
    assert!(
        tile["graph"]["file"]
            .as_str()
            .unwrap()
            .starts_with("graph/tiles/11-")
    );
    assert!(
        tile["geometry"]["file"]
            .as_str()
            .unwrap()
            .starts_with("graph/geometry/11-")
    );

    let (loaded, _) = build::load(&dir, true).unwrap();
    assert_eq!(loaded, graph);
    let (bare, _) = build::load(&dir, false).unwrap();
    assert!(!bare.has_geometry(0) && bare.is_complete());

    // recompiling replaces the files and leaves nothing behind
    compile_build(&dir, DEFAULT_TILE_ZOOM).unwrap();
    let mut entries: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    entries.sort();
    assert_eq!(entries, ["edges.parquet", "graph", "manifest.json"]);

    // snapping a point 10 m off a node finds an edge at that node
    let grid = Grid::build(&loaded, DEFAULT_CELL_M);
    let v = loaded.to(3);
    let p = loaded.node(v);
    let hits = grid.snap(
        &loaded,
        LngLat {
            lng: p.lng,
            lat: p.lat + 10.0 / 111_195.0,
        },
        50.0,
        3,
    );
    assert!(!hits.is_empty() && hits[0].distance_m <= 10.01);
    let e = hits[0].edge;
    assert!(loaded.from(e) == v || loaded.to(e) == v || hits[0].distance_m < 10.0);
}

#[test]
fn refuses_a_manifest_of_another_build() {
    let dir = build_dir("village-other", "elsewhere");
    let err = compile_build(&dir, DEFAULT_TILE_ZOOM).unwrap_err();
    assert!(err.0.contains("build elsewhere"), "{err}");
    assert!(!dir.join("graph").exists());
}

#[test]
fn refuses_a_file_that_is_not_the_contract() {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("not-parquet");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("edges.parquet"), b"not parquet").unwrap();
    assert!(read_parquet(&dir.join("edges.parquet"), 11).is_err());
    assert!(
        read_parquet(&dir.join("missing.parquet"), 11)
            .unwrap_err()
            .0
            .contains("missing.parquet")
    );
}
