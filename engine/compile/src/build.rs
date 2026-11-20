//! A build directory (`data/build/<name>/`): `edges.parquet`, the map tiles, `manifest.json`, and
//! the graph this crate writes under `graph/`, registered in the manifest's `graph` key
//! (`docs/graph-format.md`):
//!
//! ```json
//! "graph": { "formatVersion": 2, "buildId": "…", "tileZoom": 11, "nodes": 1, "edges": 1,
//!   "bytes": 1, "index": { "file": "graph/index.kmpg", "bytes": 1 },
//!   "tiles": [ { "x": 1, "y": 1, "edges": 1,
//!                "graph": { "file": "graph/tiles/11-1-1.kmpg", "bytes": 1, "gzip": 1 },
//!                "geometry": { "file": "graph/geometry/11-1-1.kmpg", "bytes": 1, "gzip": 1 } } ] }
//! ```
//!
//! Every file also gets a gzip sibling (`<file>.gz`, its size in `gzip`): the web app downloads
//! those and decompresses them itself, so no host has to compress (`docs/engine-web.md`).

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Instant;

use kompass_core::assemble::write_files;
use kompass_core::format::FORMAT_VERSION;
use kompass_core::{Graph, GraphLoader};
use serde_json::{Map, Value, json};

use crate::Error;

/// The directory under the build that holds the graph files.
pub const GRAPH_DIR: &str = "graph";

/// What [`write`] wrote.
#[derive(Debug, Clone)]
pub struct Written {
    /// The manifest's new `graph` value.
    pub manifest_graph: Value,
    /// Relative path and size of every file.
    pub files: Vec<(String, u64)>,
    /// The size of all gzip siblings together.
    pub gzip_bytes: u64,
}

impl Written {
    #[must_use]
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|(_, b)| b).sum()
    }
}

fn read_manifest(dir: &Path) -> Result<Map<String, Value>, Error> {
    let path = dir.join("manifest.json");
    let text = fs::read_to_string(&path).map_err(|e| Error(format!("{}: {e}", path.display())))?;
    match serde_json::from_str(&text)? {
        Value::Object(m) => Ok(m),
        _ => Err(Error(format!("{}: not a JSON object", path.display()))),
    }
}

/// Writes `path` through a temporary file in the same directory and a rename.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    let tmp = path.with_extension("json.part");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Writes the graph into `<dir>/graph/` (replacing an older one) and sets the manifest's `graph`
/// key. The manifest must exist and, if it names a build, be of the graph's build.
pub fn write(dir: &Path, graph: &Graph) -> Result<Written, Error> {
    let mut manifest = read_manifest(dir)?;
    let info = graph.info();
    if let Some(id) = manifest.get("buildId").and_then(Value::as_str)
        && id != info.build_id
    {
        return Err(Error(format!(
            "manifest.json is of build {id}, edges.parquet of build {}: rebuild them together",
            info.build_id
        )));
    }
    let files = write_files(graph);
    let z = info.tile_zoom;
    let tmp = dir.join(format!("{GRAPH_DIR}.part"));
    if tmp.exists() {
        fs::remove_dir_all(&tmp)?;
    }
    fs::create_dir_all(tmp.join("tiles"))?;
    fs::create_dir_all(tmp.join("geometry"))?;
    let mut written = Vec::new();
    let mut gzipped = Vec::new();
    let mut put = |rel: String, bytes: &[u8]| -> Result<Value, Error> {
        fs::write(tmp.join(&rel), bytes)?;
        let gz = gzip(bytes)?;
        fs::write(tmp.join(format!("{rel}.gz")), &gz)?;
        let file = format!("{GRAPH_DIR}/{rel}");
        written.push((file.clone(), bytes.len() as u64));
        gzipped.push(gz.len() as u64);
        Ok(json!({ "file": file, "bytes": bytes.len(), "gzip": gz.len() }))
    };
    let index = put("index.kmpg".into(), &files.index)?;
    let mut tiles = Vec::with_capacity(files.tiles.len());
    for t in &files.tiles {
        let name = format!("{z}-{}-{}.kmpg", t.x, t.y);
        let g = put(format!("tiles/{name}"), &t.graph)?;
        let geo = put(format!("geometry/{name}"), &t.geometry)?;
        tiles.push(json!({ "x": t.x, "y": t.y, "edges": t.edges, "graph": g, "geometry": geo }));
    }
    let total: u64 = written.iter().map(|(_, b)| b).sum();
    let total_gzip: u64 = gzipped.iter().sum();
    let value = json!({
        "formatVersion": FORMAT_VERSION,
        "buildId": info.build_id,
        "tileZoom": z,
        "nodes": info.node_count,
        "edges": info.edge_count,
        "bytes": total,
        "gzipBytes": total_gzip,
        "index": index,
        "tiles": tiles,
    });
    // swap the directories, then point the manifest at the new files
    let target = dir.join(GRAPH_DIR);
    let old = dir.join(format!("{GRAPH_DIR}.old"));
    if old.exists() {
        fs::remove_dir_all(&old)?;
    }
    if target.exists() {
        fs::rename(&target, &old)?;
    }
    fs::rename(&tmp, &target)?;
    manifest.insert("graph".into(), value.clone());
    let mut text = serde_json::to_string_pretty(&Value::Object(manifest))?;
    text.push('\n');
    write_atomic(&dir.join("manifest.json"), text.as_bytes())?;
    if old.exists() {
        fs::remove_dir_all(&old)?;
    }
    Ok(Written {
        manifest_graph: value,
        files: written,
        gzip_bytes: total_gzip,
    })
}

/// gzip at the default level (6): ~50 % of the raw graph, ~3 s for a 100 km region.
fn gzip(bytes: &[u8]) -> Result<Vec<u8>, Error> {
    let mut enc = flate2::write::GzEncoder::new(
        Vec::with_capacity(bytes.len() / 2),
        flate2::Compression::default(),
    );
    enc.write_all(bytes)?;
    Ok(enc.finish()?)
}

/// How long [`load`] took, per phase (milliseconds).
#[derive(Debug, Clone, Copy, Default)]
pub struct LoadTimes {
    pub read_ms: f64,
    pub tiles_ms: f64,
    pub adjacency_ms: f64,
    pub geometry_ms: f64,
    /// Bytes read from disk.
    pub bytes: u64,
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}

/// The graph files a manifest lists: (index, graph tiles, geometry tiles), relative paths.
fn manifest_files(dir: &Path) -> Result<(PathBuf, Vec<PathBuf>, Vec<PathBuf>), Error> {
    let manifest = read_manifest(dir)?;
    let graph = manifest.get("graph").ok_or_else(|| {
        Error(format!(
            "{}: no graph (run `kompass compile --build`)",
            dir.display()
        ))
    })?;
    let file = |v: &Value, what: &str| -> Result<PathBuf, Error> {
        v.get("file")
            .and_then(Value::as_str)
            .filter(|f| !f.starts_with('/') && !f.split('/').any(|p| p == ".."))
            .map(|f| dir.join(f))
            .ok_or_else(|| Error(format!("manifest.json: graph {what} has no valid file")))
    };
    let index = file(graph.get("index").unwrap_or(&Value::Null), "index")?;
    let tiles = graph
        .get("tiles")
        .and_then(Value::as_array)
        .ok_or_else(|| Error("manifest.json: graph.tiles is not a list".into()))?;
    let mut g = Vec::with_capacity(tiles.len());
    let mut geo = Vec::with_capacity(tiles.len());
    for t in tiles {
        g.push(file(t.get("graph").unwrap_or(&Value::Null), "tile")?);
        geo.push(file(t.get("geometry").unwrap_or(&Value::Null), "geometry")?);
    }
    Ok((index, g, geo))
}

/// The geometry tile files of a build directory, one per graph tile in tile order (index = the
/// tile's index in `GraphInfo::tiles`): for loading geometry only where it is needed.
pub fn geometry_paths(dir: &Path) -> Result<Vec<PathBuf>, Error> {
    Ok(manifest_files(dir)?.2)
}

/// Loads the graph of a build directory, all tiles; with `geometry`, also every geometry tile.
pub fn load(dir: &Path, geometry: bool) -> Result<(Graph, LoadTimes), Error> {
    let (index, tile_paths, geos) = manifest_files(dir)?;
    let mut times = LoadTimes::default();
    let t = Instant::now();
    let index = fs::read(&index)?;
    let tile_bytes = tile_paths.iter().map(fs::read).collect::<Result<Vec<_>, _>>()?;
    let geo_bytes = if geometry {
        geos.iter().map(fs::read).collect::<Result<Vec<_>, _>>()?
    } else {
        Vec::new()
    };
    times.read_ms = ms(t);
    times.bytes = (index.len() + tile_bytes.iter().chain(&geo_bytes).map(Vec::len).sum::<usize>()) as u64;
    let t = Instant::now();
    let mut loader = GraphLoader::new(&index)?;
    for b in &tile_bytes {
        loader.add_tile(b)?;
    }
    times.tiles_ms = ms(t);
    let t = Instant::now();
    let mut graph = loader.finish();
    times.adjacency_ms = ms(t);
    let t = Instant::now();
    for b in &geo_bytes {
        graph.add_geometry(b)?;
    }
    times.geometry_ms = ms(t);
    Ok((graph, times))
}
