//! Tiny graphs built in code, for tests here and in the other crates (routing, map-matching, the
//! wasm face): no real data needed.
//!
//! ```
//! use kompass_core::testing::GraphBuilder;
//! use kompass_core::attrs::{EdgeAttrs, Oneway, SurfaceClass};
//!
//! let mut b = GraphBuilder::new();
//! let a = b.node(0.0, 0.0);
//! let c = b.node(0.001, 0.0);
//! let e = b.edge(a, c, EdgeAttrs { surface: SurfaceClass::Gravel, oneway: Oneway::Along, ..EdgeAttrs::default() });
//! let built = b.build();
//! let g = &built.graph;
//! assert_eq!(g.surface(built.edge(e)), SurfaceClass::Gravel);
//! assert!(g.length_m(built.edge(e)) > 110.0); // filled in from the coordinates
//! ```

use crate::assemble::{Assembler, GraphFiles, write_files};
use crate::attrs::EdgeAttrs;
use crate::geometry::WayRef;
use crate::graph::{EdgeId, Graph, NodeId};
use crate::{LngLat, haversine_m, hilbert};

/// A node or edge handle of the builder (its index in insertion order).
pub type Handle = usize;

#[derive(Debug, Clone)]
struct Edge {
    from: Handle,
    to: Handle,
    attrs: EdgeAttrs,
    interior: Vec<(i32, i32)>,
    way: WayRef,
}

/// Builds a graph from nodes and edges given in any order. The builder groups edges by tile (keeping
/// their order within a tile) and numbers nodes by tile, so ids may differ from the insertion order
/// when the graph spans several tiles: [`Built::edge`] and [`Built::node`] map handles to ids. With
/// every edge in one tile (the default zoom 11 tile is ~20 km wide), ids equal the handles.
#[derive(Debug, Clone)]
pub struct GraphBuilder {
    zoom: u8,
    build_id: String,
    nodes: Vec<(i32, i32)>,
    elevations: Vec<Option<f32>>,
    edges: Vec<Edge>,
}

impl Default for GraphBuilder {
    fn default() -> Self {
        GraphBuilder::new()
    }
}

/// A built graph and the handle → id maps.
#[derive(Debug, Clone)]
pub struct Built {
    pub graph: Graph,
    /// Per edge handle: its id.
    pub edges: Vec<EdgeId>,
    /// Per node handle: its id.
    pub nodes: Vec<NodeId>,
    /// The graph as files (index and per-tile graph and geometry), the loaded graph's source.
    pub files: GraphFiles,
}

impl Built {
    #[must_use]
    pub fn edge(&self, h: Handle) -> EdgeId {
        self.edges[h]
    }

    #[must_use]
    pub fn node(&self, h: Handle) -> NodeId {
        self.nodes[h]
    }
}

impl GraphBuilder {
    /// Tile zoom 11, build id `test`.
    #[must_use]
    pub fn new() -> GraphBuilder {
        GraphBuilder {
            zoom: 11,
            build_id: "test".into(),
            nodes: Vec::new(),
            elevations: Vec::new(),
            edges: Vec::new(),
        }
    }

    /// The tile zoom (a high zoom splits a small graph into several tiles).
    #[must_use]
    pub fn zoom(mut self, zoom: u8) -> GraphBuilder {
        self.zoom = zoom;
        self
    }

    #[must_use]
    pub fn build_id(mut self, id: &str) -> GraphBuilder {
        id.clone_into(&mut self.build_id);
        self
    }

    /// A node at a coordinate in degrees (elevation unknown).
    pub fn node(&mut self, lng: f64, lat: f64) -> Handle {
        self.nodes.push(LngLat { lng, lat }.to_e7());
        self.elevations.push(None);
        self.nodes.len() - 1
    }

    /// A node at a coordinate in degrees with an elevation in metres.
    pub fn node_at(&mut self, lng: f64, lat: f64, ele_m: f32) -> Handle {
        let h = self.node(lng, lat);
        self.elevations[h] = Some(ele_m);
        h
    }

    /// Sets a node's elevation.
    pub fn set_elevation(&mut self, node: Handle, ele_m: Option<f32>) {
        self.elevations[node] = ele_m;
    }

    /// Edge attributes, to change them after adding.
    pub fn attrs_mut(&mut self, edge: Handle) -> &mut EdgeAttrs {
        &mut self.edges[edge].attrs
    }

    /// The number of nodes and edges added so far.
    #[must_use]
    pub fn counts(&self) -> (usize, usize) {
        (self.nodes.len(), self.edges.len())
    }

    /// An edge; a `length_m` of 0 is filled in from the points.
    pub fn edge(&mut self, from: Handle, to: Handle, attrs: EdgeAttrs) -> Handle {
        self.edge_via(from, to, &[], attrs)
    }

    /// An edge through interior points (degrees).
    pub fn edge_via(&mut self, from: Handle, to: Handle, via: &[(f64, f64)], attrs: EdgeAttrs) -> Handle {
        let interior = via
            .iter()
            .map(|&(lng, lat)| LngLat { lng, lat }.to_e7())
            .collect();
        let n = self.edges.len();
        self.edges.push(Edge {
            from,
            to,
            attrs,
            interior,
            way: WayRef {
                way_id: 1000 + i64::try_from(n).unwrap_or(0),
                pos_from: 0,
                pos_to: 1 + u16::try_from(via.len()).unwrap_or(u16::MAX - 1),
            },
        });
        n
    }

    /// Sets the OSM way of an edge (default: way 1000 + handle, positions 0..points).
    pub fn way(&mut self, edge: Handle, way: WayRef) {
        self.edges[edge].way = way;
    }

    fn points(&self, e: &Edge) -> Vec<(i32, i32)> {
        let mut pts = vec![self.nodes[e.from]];
        pts.extend(&e.interior);
        pts.push(self.nodes[e.to]);
        pts
    }

    /// The `hilbert_z16` key of an edge, as the pipeline computes it (the z16 tile of the midpoint
    /// by planar length in degrees).
    #[allow(clippy::cast_possible_truncation, reason = "a z16 Hilbert key fits u32")]
    fn key(&self, e: &Edge) -> u32 {
        let pts = self.points(e);
        let p = |i: usize| (f64::from(pts[i].0) * 1e-7, f64::from(pts[i].1) * 1e-7);
        let seg = |i: usize| {
            let (a, b) = (p(i), p(i + 1));
            (b.0 - a.0).hypot(b.1 - a.1)
        };
        let total: f64 = (0..pts.len() - 1).map(seg).sum();
        let mut left = total / 2.0;
        let mut mid = p(0);
        for i in 0..pts.len() - 1 {
            let l = seg(i);
            if left <= l || i == pts.len() - 2 {
                let t = if l > 0.0 { (left / l).min(1.0) } else { 0.0 };
                let (a, b) = (p(i), p(i + 1));
                mid = (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
                break;
            }
            left -= l;
        }
        let (x, y) = hilbert::tile_of(mid.0, mid.1, hilbert::KEY_ZOOM);
        hilbert::xy_to_d(hilbert::KEY_ZOOM, x, y) as u32
    }

    /// Builds the graph through the real format: assembled, written as files, loaded back.
    ///
    /// # Panics
    /// If an edge refers to a node handle that does not exist, or a node has no edge.
    #[must_use]
    #[allow(clippy::cast_possible_truncation, reason = "test graphs are tiny")]
    pub fn build(&self) -> Built {
        let mut asm = Assembler::new(&self.build_id, 1, self.zoom);
        // edges grouped by tile, in order of first appearance of the tile, stable within it
        let keys: Vec<u64> = self.edges.iter().map(|e| asm.tile_key(self.key(e))).collect();
        let mut tile_order: Vec<u64> = Vec::new();
        for &k in &keys {
            if !tile_order.contains(&k) {
                tile_order.push(k);
            }
        }
        let mut order: Vec<usize> = (0..self.edges.len()).collect();
        order.sort_by_key(|&i| tile_order.iter().position(|&k| k == keys[i]));
        // nodes by the tile of their first edge, then by handle
        let mut node_rank = vec![usize::MAX; self.nodes.len()];
        for &i in &order {
            let tile = tile_order.iter().position(|&k| k == keys[i]).unwrap_or(0);
            for v in [self.edges[i].from, self.edges[i].to] {
                if node_rank[v] == usize::MAX {
                    node_rank[v] = tile;
                }
            }
        }
        let mut node_order: Vec<usize> = (0..self.nodes.len()).collect();
        node_order.sort_by_key(|&v| (node_rank[v], v));
        let mut nodes = vec![0; self.nodes.len()];
        for &v in &node_order {
            nodes[v] = asm.add_node(self.nodes[v].0, self.nodes[v].1, self.elevations[v]);
        }
        let mut edges = vec![0; self.edges.len()];
        for &i in &order {
            let e = &self.edges[i];
            let mut attrs = e.attrs;
            if attrs.length_m <= 0.0 {
                let pts = self.points(e);
                attrs.length_m = pts
                    .windows(2)
                    .map(|w| haversine_m(LngLat::from_e7(w[0].0, w[0].1), LngLat::from_e7(w[1].0, w[1].1)))
                    .sum::<f64>() as f32;
            }
            edges[i] = asm
                .add_edge(keys[i], nodes[e.from], nodes[e.to], &attrs, e.way, &e.interior)
                .expect("a valid test edge");
        }
        let assembled = asm.finish().expect("a valid test graph");
        let files = write_files(&assembled);
        let graph = files.load().expect("the written files load");
        assert_eq!(graph, assembled, "the files hold the assembled graph");
        Built {
            graph,
            edges,
            nodes,
            files,
        }
    }
}

/// Where [`grid`] centres its grids: near 0°N 0°E (open sea in reality), inside one z11 tile (0° is a
/// tile border at every zoom) for grids up to ~15 km wide.
pub const GRID_CENTER: (f64, f64) = (0.08, 0.08);

/// A grid of `nx` × `ny` nodes `step_m` apart around [`GRID_CENTER`], joined east and north by default-attribute edges: node `(i, j)` is handle `j * nx + i`; the east edges come
/// first (row by row), then the north edges (column by column).
#[must_use]
#[allow(clippy::cast_precision_loss, reason = "tiny grids")]
pub fn grid(nx: usize, ny: usize, step_m: f64) -> GraphBuilder {
    let mut b = GraphBuilder::new();
    let step = step_m / (crate::M_PER_E7 * 1e7);
    let ox = GRID_CENTER.0 - (nx as f64 - 1.0) * step / 2.0;
    let oy = GRID_CENTER.1 - (ny as f64 - 1.0) * step / 2.0;
    for j in 0..ny {
        for i in 0..nx {
            b.node(ox + i as f64 * step, oy + j as f64 * step);
        }
    }
    for j in 0..ny {
        for i in 0..nx - 1 {
            b.edge(j * nx + i, j * nx + i + 1, EdgeAttrs::default());
        }
    }
    for i in 0..nx {
        for j in 0..ny - 1 {
            b.edge(j * nx + i, (j + 1) * nx + i, EdgeAttrs::default());
        }
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_edge_longer_than_the_old_u16_limit_survives_the_files() {
        let mut b = GraphBuilder::new();
        let a = b.node(0.0, 0.0);
        let c = b.node(0.1, 0.0);
        let e = b.edge(
            a,
            c,
            EdgeAttrs {
                length_m: 8123.4,
                ..EdgeAttrs::default()
            },
        );
        let built = b.build(); // asserts the write/load round trip
        assert!((built.graph.length_m(built.edge(e)) - 8123.4).abs() < 0.06);
    }
}
