//! The graph compiler: `edges.parquet` (the pipeline contract, `docs/edges-parquet.md`) → the tiled
//! graph files (`docs/graph-format.md`), registered in the build's `manifest.json`. Native only: the
//! parquet reader stays out of the wasm build.
//!
//! - [`read_parquet`]: the file → a [`Graph`] (checks the schema version, the enum code tables, the
//!   sort order and that `edge_id` is the row number).
//! - [`build::write`]: a graph → `<build>/graph/…` plus the manifest's `graph` key, atomically.
//! - [`build::load`]: the graph of a build directory back (what `kompass` commands route on).
#![allow(clippy::missing_errors_doc, reason = "errors carry their own message")]

pub mod build;
mod parquet_read;

pub use parquet_read::{CompileStats, read_parquet};

use kompass_core::Graph;

/// The `edges.parquet` schema version this compiler reads.
pub const SCHEMA_VERSION: u32 = 1;

/// The tile zoom of the files (spike #4: ~250 tiles of ≤ 1 MB for a 100 km region).
pub const DEFAULT_TILE_ZOOM: u8 = 11;

/// A compile error, with a message for the command line.
#[derive(Debug)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

macro_rules! from_error {
    ($($t:ty),+) => {$(
        impl From<$t> for Error {
            fn from(e: $t) -> Error {
                Error(e.to_string())
            }
        }
    )+};
}

from_error!(
    std::io::Error,
    parquet::errors::ParquetError,
    arrow_schema::ArrowError,
    serde_json::Error,
    kompass_core::format::FormatError,
    kompass_core::assemble::AssembleError
);

/// Compiles `<build>/edges.parquet` into `<build>/graph/` and registers it in the manifest.
pub fn compile_build(
    dir: &std::path::Path,
    zoom: u8,
) -> Result<(Graph, CompileStats, build::Written), Error> {
    let (graph, stats) = read_parquet(&dir.join("edges.parquet"), zoom)?;
    let written = build::write(dir, &graph)?;
    Ok((graph, stats, written))
}
