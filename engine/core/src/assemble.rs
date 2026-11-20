//! Building a [`Graph`] from edges in tile order (the compiler reads them from `edges.parquet`,
//! [`crate::testing`] from code), and writing it as files.
//!
//! The one rule: edges come grouped by tile, and nodes are numbered so that every tile's nodes are a
//! contiguous range following the previous tile's. A node belongs to the tile of the first edge
//! that uses it; numbering nodes by first appearance along the edges satisfies the rule.

use crate::attrs::{EdgeAttrs, MAX_LENGTH_M};
use crate::format::FORMAT_VERSION;
use crate::geometry::{self, Geometry, WayRef};
use crate::graph::{EdgeColumns, EdgeId, Graph, GraphInfo, NodeColumns, NodeId, TileInfo};
use crate::hilbert;

/// Collects nodes and edges, then [`Assembler::finish`] checks and builds the graph.
#[derive(Debug)]
pub struct Assembler {
    build_id: String,
    schema_version: u32,
    zoom: u8,
    nodes: NodeColumns,
    edges: EdgeColumns,
    geometry: Geometry,
    /// Per tile: its Hilbert key at `zoom`, edges and bounding box (nodes are filled in at the end).
    tiles: Vec<(u64, TileInfo)>,
    /// Per node: the tile of the first edge using it (`u32::MAX`: none yet).
    node_tile: Vec<u32>,
}

/// Why the edges do not make a graph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssembleError(pub String);

impl std::fmt::Display for AssembleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for AssembleError {}

impl Assembler {
    /// `zoom`: the tile zoom of the files (≤ 16, the zoom of the `hilbert_z16` keys).
    #[must_use]
    pub fn new(build_id: &str, schema_version: u32, zoom: u8) -> Assembler {
        assert!(zoom <= hilbert::KEY_ZOOM, "tile zoom above {}", hilbert::KEY_ZOOM);
        Assembler {
            build_id: build_id.to_owned(),
            schema_version,
            zoom,
            nodes: NodeColumns::default(),
            edges: EdgeColumns::default(),
            geometry: Geometry::default(),
            tiles: Vec::new(),
            node_tile: Vec::new(),
        }
    }

    #[must_use]
    pub fn zoom(&self) -> u8 {
        self.zoom
    }

    #[must_use]
    pub fn node_count(&self) -> usize {
        self.nodes.lon.len()
    }

    #[must_use]
    pub fn edge_count(&self) -> usize {
        self.edges.from.len()
    }

    /// Adds a node at 1e-7 degrees; ids are given in order.
    #[allow(clippy::cast_possible_truncation, reason = "checked: at most u32::MAX nodes")]
    pub fn add_node(&mut self, lon: i32, lat: i32) -> NodeId {
        assert!(self.node_count() < u32::MAX as usize, "too many nodes");
        self.nodes.push(lon, lat);
        self.node_tile.push(u32::MAX);
        (self.node_count() - 1) as NodeId
    }

    /// A node's position (1e-7 degrees).
    #[must_use]
    pub fn node_e7(&self, v: NodeId) -> (i32, i32) {
        (self.nodes.lon[v as usize], self.nodes.lat[v as usize])
    }

    /// The Hilbert key at the tile zoom of a `hilbert_z16` key.
    #[must_use]
    pub fn tile_key(&self, hilbert_z16: u32) -> u64 {
        u64::from(hilbert_z16) >> (2 * u32::from(hilbert::KEY_ZOOM - self.zoom))
    }

    /// Adds an edge in tile `tile_key` (see [`Assembler::tile_key`]): edges of one tile must be
    /// consecutive. `interior`: the geometry's points between the end nodes, 1e-7 degrees.
    #[allow(
        clippy::cast_possible_truncation,
        reason = "edge and tile counts are checked to fit u32"
    )]
    pub fn add_edge(
        &mut self,
        tile_key: u64,
        from: NodeId,
        to: NodeId,
        attrs: &EdgeAttrs,
        way: WayRef,
        interior: &[(i32, i32)],
    ) -> Result<EdgeId, AssembleError> {
        let e = self.edge_count();
        if e >= (1 << 31) - 1 {
            return Err(AssembleError("too many edges".into()));
        }
        if from as usize >= self.node_count() || to as usize >= self.node_count() {
            return Err(AssembleError(format!("edge {e}: unknown node")));
        }
        if attrs.length_m.is_nan() || attrs.length_m > MAX_LENGTH_M {
            return Err(AssembleError(format!(
                "edge {e}: length {} m (the format holds up to {MAX_LENGTH_M} m)",
                attrs.length_m
            )));
        }
        if self.tiles.last().is_none_or(|(k, _)| *k != tile_key) {
            if self.tiles.iter().any(|(k, _)| *k == tile_key) {
                return Err(AssembleError(format!(
                    "edge {e}: its tile's edges are not consecutive"
                )));
            }
            let (x, y) = hilbert::d_to_xy(self.zoom, tile_key);
            self.tiles.push((
                tile_key,
                TileInfo {
                    x,
                    y,
                    nodes: 0..0,
                    edges: e as u32..e as u32,
                    bbox: [i32::MAX, i32::MAX, i32::MIN, i32::MIN],
                },
            ));
        }
        let t = self.tiles.len() - 1;
        let tile = &mut self.tiles[t].1;
        tile.edges.end = e as u32 + 1;
        let (fp, tp) = (
            (self.nodes.lon[from as usize], self.nodes.lat[from as usize]),
            (self.nodes.lon[to as usize], self.nodes.lat[to as usize]),
        );
        for &(x, y) in [fp, tp].iter().chain(interior) {
            tile.bbox = [
                tile.bbox[0].min(x),
                tile.bbox[1].min(y),
                tile.bbox[2].max(x),
                tile.bbox[3].max(y),
            ];
        }
        for v in [from, to] {
            if self.node_tile[v as usize] == u32::MAX {
                self.node_tile[v as usize] = t as u32;
            }
        }
        self.edges.push(from, to, &attrs.pack());
        self.geometry.offsets.push(self.geometry.bytes.len() as u32);
        geometry::encode(&mut self.geometry.bytes, fp, way, interior);
        if self.geometry.bytes.len() > u32::MAX as usize {
            return Err(AssembleError("geometry larger than 4 GB".into()));
        }
        Ok(e as EdgeId)
    }

    /// Checks the node numbering rule and builds the graph (with its adjacency).
    #[allow(
        clippy::cast_possible_truncation,
        reason = "node and edge counts fit u32 (checked on add)"
    )]
    pub fn finish(mut self) -> Result<Graph, AssembleError> {
        let mut next = 0u32;
        let mut start = 0u32;
        let mut tile = 0u32;
        for (v, &t) in self.node_tile.iter().enumerate() {
            if t == u32::MAX {
                return Err(AssembleError(format!("node {v} has no edge")));
            }
            if t < tile {
                return Err(AssembleError(format!(
                    "node {v} belongs to an earlier tile than node {}: nodes must be numbered in tile order",
                    v - 1
                )));
            }
            while tile < t {
                self.tiles[tile as usize].1.nodes = start..next;
                start = next;
                tile += 1;
            }
            next = v as u32 + 1;
        }
        for (_, t) in self.tiles.iter_mut().skip(tile as usize) {
            t.nodes = start..next;
            start = next;
        }
        let tiles: Vec<TileInfo> = self.tiles.into_iter().map(|(_, t)| t).collect();
        let bbox = tiles
            .iter()
            .fold([i32::MAX, i32::MAX, i32::MIN, i32::MIN], |b, t| {
                [
                    b[0].min(t.bbox[0]),
                    b[1].min(t.bbox[1]),
                    b[2].max(t.bbox[2]),
                    b[3].max(t.bbox[3]),
                ]
            });
        let info = GraphInfo {
            build_id: self.build_id,
            format_version: FORMAT_VERSION,
            schema_version: self.schema_version,
            tile_zoom: self.zoom,
            node_count: self.nodes.lon.len() as u32,
            edge_count: self.edges.from.len() as u32,
            bbox: if tiles.is_empty() { [0; 4] } else { bbox },
            tiles,
        };
        Ok(Graph::from_parts(info, self.nodes, self.edges, self.geometry))
    }
}

/// One tile's two files.
#[derive(Debug, Clone)]
pub struct TileFiles {
    pub x: u32,
    pub y: u32,
    pub edges: u32,
    pub graph: Vec<u8>,
    pub geometry: Vec<u8>,
}

/// Every file of a graph.
#[derive(Debug, Clone)]
pub struct GraphFiles {
    pub index: Vec<u8>,
    pub tiles: Vec<TileFiles>,
}

/// Writes a fully loaded graph (with geometry) as its files.
#[must_use]
pub fn write_files(g: &Graph) -> GraphFiles {
    GraphFiles {
        index: g.write_index(),
        tiles: g
            .info()
            .tiles
            .iter()
            .enumerate()
            .map(|(i, t)| TileFiles {
                x: t.x,
                y: t.y,
                edges: t.edges.end - t.edges.start,
                graph: g.write_tile(i),
                geometry: g.write_geometry_tile(i),
            })
            .collect(),
    }
}

impl GraphFiles {
    /// Loads them back (the tiles in the given order).
    pub fn load(&self) -> Result<Graph, crate::format::FormatError> {
        Graph::load(
            &self.index,
            self.tiles.iter().map(|t| t.graph.as_slice()),
            self.tiles.iter().map(|t| t.geometry.as_slice()),
        )
    }
}
