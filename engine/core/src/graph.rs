//! The routing graph in memory: struct-of-arrays node and edge columns (quantised attributes, see
//! [`crate::attrs`]), optional edge geometry, and a CSR adjacency rebuilt at load (the files store
//! none). Loaded from the tiled format (`docs/graph-format.md`) by [`GraphLoader`]: the index first,
//! then the tiles in any order.
//!
//! Ids: nodes and edges are dense `u32`; edge ids are the `edge_id` of `edges.parquet` (and the
//! overlay tiles' feature ids). An *arc* is an edge in one direction, `edge << 1 | reverse`, where
//! `reverse = 0` follows the geometry (from → to); per-arc arrays (costs) are indexed by it.

use std::ops::Range;

use crate::attrs::{
    BikeAccess, CyclewayKind, EdgeAttrs, Highway, MotorAccess, MtbScale, Oneway, Packed, RouteLevel,
    SacScale, Smoothness, SurfaceClass, Tracktype, TrailVisibility, oneway_of,
};
use crate::format::{FORMAT_VERSION, FileKind, FormatError, Reader, Writer};
use crate::geometry::{self, EdgePoints, Geometry, WayRef};
use crate::{LngLat, M_PER_E7};

pub type NodeId = u32;
pub type EdgeId = u32;
pub type ArcId = u32;

/// The arc of edge `e` along (`reverse = false`) or against its geometry.
#[inline]
#[must_use]
pub const fn arc(e: EdgeId, reverse: bool) -> ArcId {
    (e << 1) | reverse as u32
}

/// The edge of an arc.
#[inline]
#[must_use]
pub const fn arc_edge(a: ArcId) -> EdgeId {
    a >> 1
}

/// Whether an arc runs against its edge's geometry (to → from).
#[inline]
#[must_use]
pub const fn arc_is_reverse(a: ArcId) -> bool {
    a & 1 == 1
}

/// Adjacency slot flags (see [`Graph::arcs_at`]).
pub mod flags {
    /// The slot's arc (leaving the node) may be ridden: one-way allows it.
    pub const OUT: u8 = 1;
    /// The opposite arc (arriving at the node along the same edge) may be ridden.
    pub const IN: u8 = 2;
}

/// One tile of the region: a contiguous range of nodes and of edges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TileInfo {
    /// Web-mercator tile column and row at [`GraphInfo::tile_zoom`].
    pub x: u32,
    pub y: u32,
    pub nodes: Range<u32>,
    pub edges: Range<u32>,
    /// Bounding box of the tile's edges (all their points), 1e-7 degrees: min lon, min lat, max
    /// lon, max lat.
    pub bbox: [i32; 4],
}

/// What the index file says about the region's graph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphInfo {
    /// The build the graph was compiled from (`kompass:build_id`, the manifest's `buildId`).
    pub build_id: String,
    pub format_version: u16,
    /// The `edges.parquet` schema version it was compiled from.
    pub schema_version: u32,
    pub tile_zoom: u8,
    pub node_count: u32,
    pub edge_count: u32,
    /// Bounding box of every point, 1e-7 degrees: min lon, min lat, max lon, max lat.
    pub bbox: [i32; 4],
    /// In edge (and node) order.
    pub tiles: Vec<TileInfo>,
}

impl GraphInfo {
    /// West, south, east, north in degrees.
    #[must_use]
    pub fn bounds(&self) -> [f64; 4] {
        bbox_degrees(self.bbox)
    }

    /// The tile holding edge `e`.
    #[must_use]
    pub fn tile_of_edge(&self, e: EdgeId) -> Option<usize> {
        let i = self.tiles.partition_point(|t| t.edges.end <= e);
        (i < self.tiles.len() && self.tiles[i].edges.contains(&e)).then_some(i)
    }

    /// The tile holding node `v` (a node belongs to the tile of its first edge).
    #[must_use]
    pub fn tile_of_node(&self, v: NodeId) -> Option<usize> {
        let i = self.tiles.partition_point(|t| t.nodes.end <= v);
        (i < self.tiles.len() && self.tiles[i].nodes.contains(&v)).then_some(i)
    }

    /// The tile at (x, y).
    #[must_use]
    pub fn tile_at(&self, x: u32, y: u32) -> Option<usize> {
        self.tiles.iter().position(|t| t.x == x && t.y == y)
    }
}

/// West, south, east, north in degrees of a 1e-7 bounding box.
#[must_use]
pub fn bbox_degrees(b: [i32; 4]) -> [f64; 4] {
    [b[0], b[1], b[2], b[3]].map(|v| f64::from(v) * 1e-7)
}

/// Declares a struct of columns with their section names, and how to read and write a range.
macro_rules! columns {
    ($(#[$meta:meta])* $name:ident { $($(#[$fmeta:meta])* $field:ident: $ty:ty = $sec:literal,)+ }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Default, PartialEq, Eq)]
        pub struct $name {
            $($(#[$fmeta])* pub $field: Vec<$ty>,)+
        }

        impl $name {
            /// The section names, in file order.
            pub const SECTIONS: &'static [&'static [u8; 8]] = &[$($sec,)+];

            fn with_len(n: usize) -> Self {
                Self { $($field: vec![<$ty>::default(); n],)+ }
            }

            fn write(&self, w: &mut Writer, r: &Range<usize>) {
                $(w.put(*$sec, &self.$field[r.clone()]);)+
            }

            fn read(&mut self, rd: &Reader<'_>, r: &Range<usize>) -> Result<(), FormatError> {
                $(rd.read_into(*$sec, &mut self.$field[r.clone()])?;)+
                Ok(())
            }

            fn heap_bytes(&self) -> usize {
                0 $(+ self.$field.capacity() * std::mem::size_of::<$ty>())+
            }
        }
    };
}

columns! {
    /// Per node.
    NodeColumns {
        /// Longitude in 1e-7 degrees (OSM precision).
        lon: i32 = b"lon_____",
        /// Latitude in 1e-7 degrees.
        lat: i32 = b"lat_____",
        /// Elevation, packed by [`crate::attrs::pack_elevation`] (decimetres above −1000 m, 0 unknown).
        ele_dm: u16 = b"ele_dm__",
    }
}

columns! {
    /// Per edge, the packed columns (bit layouts in `docs/graph-format.md` and [`crate::attrs`]).
    EdgeColumns {
        from: u32 = b"from____",
        to: u32 = b"to______",
        length_dm: u32 = b"len_dm__",
        highway: u8 = b"highway_",
        /// `surface_class` 0-2 · `tracktype` 3-5 · one-way 6-7
        surf: u8 = b"surf____",
        /// `smoothness` 0-3 · `trail_visibility` 4-6 · `informal` 7
        smooth: u8 = b"smooth__",
        /// `bike_access` 0-3 · `motor_access` 4-6 · `mtb_route` 7
        access: u8 = b"access__",
        /// `cycleway_kind` 0-2 · `route_level` 3-5 · bridge 6 · tunnel 7
        road: u8 = b"road____",
        /// maxspeed / 5 0-4 · lanes 5-7
        speed: u8 = b"speed___",
        /// `mtb_scale` 0-2 · `sac_scale` 3-5 · barriers 6-7
        diff: u8 = b"diff____",
        /// forest · forest edge · water · built-up, 4 bits each (fifteenths)
        ctx: u16 = b"ctx_____",
        /// `road_near_share` 0-3 · width 4-7
        ctx2: u8 = b"ctx2____",
        /// `road_near_traffic` 0-3 (fifteenths) · 4-7 reserved (0)
        ctx3: u8 = b"ctx3____",
        ascent_fwd_dm: u16 = b"asc_fwd_",
        ascent_bwd_dm: u16 = b"asc_bwd_",
        grade_fwd: u8 = b"grd_fwd_",
        grade_bwd: u8 = b"grd_bwd_",
    }
}

impl NodeColumns {
    pub(crate) fn push(&mut self, lon: i32, lat: i32, ele_dm: u16) {
        self.lon.push(lon);
        self.lat.push(lat);
        self.ele_dm.push(ele_dm);
    }
}

impl EdgeColumns {
    pub(crate) fn push(&mut self, from: NodeId, to: NodeId, p: &Packed) {
        self.from.push(from);
        self.to.push(to);
        self.length_dm.push(p.length_dm);
        self.highway.push(p.highway);
        self.surf.push(p.surf);
        self.smooth.push(p.smooth);
        self.access.push(p.access);
        self.road.push(p.road);
        self.speed.push(p.speed);
        self.diff.push(p.diff);
        self.ctx.push(p.ctx);
        self.ctx2.push(p.ctx2);
        self.ctx3.push(p.ctx3);
        self.ascent_fwd_dm.push(p.ascent_fwd_dm);
        self.ascent_bwd_dm.push(p.ascent_bwd_dm);
        self.grade_fwd.push(p.grade_fwd);
        self.grade_bwd.push(p.grade_bwd);
    }

    #[inline]
    fn packed(&self, e: usize) -> Packed {
        Packed {
            length_dm: self.length_dm[e],
            highway: self.highway[e],
            surf: self.surf[e],
            smooth: self.smooth[e],
            access: self.access[e],
            road: self.road[e],
            speed: self.speed[e],
            diff: self.diff[e],
            ctx: self.ctx[e],
            ctx2: self.ctx2[e],
            ctx3: self.ctx3[e],
            ascent_fwd_dm: self.ascent_fwd_dm[e],
            ascent_bwd_dm: self.ascent_bwd_dm[e],
            grade_fwd: self.grade_fwd[e],
            grade_bwd: self.grade_bwd[e],
        }
    }
}

const BUILD_ID: [u8; 8] = *b"build_id";
const COUNTS: [u8; 8] = *b"counts__";
const BBOX: [u8; 8] = *b"bbox____";
const TILES: [u8; 8] = *b"tiles___";
const TILE_BBOX: [u8; 8] = *b"tilebbox";
const TILE: [u8; 8] = *b"tile____";
const GEO_OFFSETS: [u8; 8] = *b"geo_off_";
const GEO_DATA: [u8; 8] = *b"geo_dat_";

/// The routing graph. Build it with [`GraphLoader`] (from files) or
/// [`crate::assemble::Assembler`] (from edges); every query borrows it immutably.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Graph {
    info: GraphInfo,
    tile_loaded: Vec<bool>,
    /// Every tile loaded (kept with the adjacency).
    complete: bool,
    geometry_loaded: Vec<bool>,
    nodes: NodeColumns,
    edges: EdgeColumns,
    geometry: Geometry,
    /// CSR: the arcs leaving node `v` are `arcs[first[v]..first[v + 1]]`, with `flags` per slot.
    first: Vec<u32>,
    arcs: Vec<ArcId>,
    flags: Vec<u8>,
}

impl Graph {
    pub(crate) fn from_parts(
        info: GraphInfo,
        nodes: NodeColumns,
        edges: EdgeColumns,
        geometry: Geometry,
    ) -> Graph {
        let tiles = info.tiles.len();
        let mut g = Graph {
            info,
            tile_loaded: vec![true; tiles],
            complete: true,
            geometry_loaded: vec![true; tiles],
            nodes,
            edges,
            geometry,
            first: Vec::new(),
            arcs: Vec::new(),
            flags: Vec::new(),
        };
        g.build_adjacency();
        g
    }

    /// Loads a whole graph: the index, every graph tile and any geometry tiles (each in any order).
    pub fn load<'a>(
        index: &[u8],
        tiles: impl IntoIterator<Item = &'a [u8]>,
        geometry: impl IntoIterator<Item = &'a [u8]>,
    ) -> Result<Graph, FormatError> {
        let mut loader = GraphLoader::new(index)?;
        for t in tiles {
            loader.add_tile(t)?;
        }
        for t in geometry {
            loader.add_geometry(t)?;
        }
        Ok(loader.finish())
    }

    #[must_use]
    pub fn info(&self) -> &GraphInfo {
        &self.info
    }

    #[must_use]
    pub fn node_count(&self) -> usize {
        self.nodes.lon.len()
    }

    #[must_use]
    pub fn edge_count(&self) -> usize {
        self.edges.from.len()
    }

    /// Arcs: two per edge (indices of per-arc arrays).
    #[must_use]
    pub fn arc_count(&self) -> usize {
        self.edge_count() * 2
    }

    /// Whether every tile is loaded.
    #[must_use]
    pub fn is_complete(&self) -> bool {
        self.complete
    }

    #[must_use]
    pub fn tile_loaded(&self, tile: usize) -> bool {
        self.tile_loaded.get(tile).copied().unwrap_or(false)
    }

    #[must_use]
    pub fn geometry_loaded(&self, tile: usize) -> bool {
        self.geometry_loaded.get(tile).copied().unwrap_or(false)
    }

    /// The raw columns, for passes over every edge (cost compilation).
    #[must_use]
    pub fn edge_columns(&self) -> &EdgeColumns {
        &self.edges
    }

    #[must_use]
    pub fn node_columns(&self) -> &NodeColumns {
        &self.nodes
    }

    // --- topology -------------------------------------------------------------------------------

    /// A node's position in 1e-7 degrees.
    #[inline]
    #[must_use]
    pub fn node_e7(&self, v: NodeId) -> (i32, i32) {
        (self.nodes.lon[v as usize], self.nodes.lat[v as usize])
    }

    /// A node's elevation in metres (0.1 m steps), `None` where the build had none.
    #[inline]
    #[must_use]
    pub fn node_elevation_m(&self, v: NodeId) -> Option<f32> {
        crate::attrs::unpack_elevation(self.nodes.ele_dm[v as usize])
    }

    #[inline]
    #[must_use]
    pub fn node(&self, v: NodeId) -> LngLat {
        let (x, y) = self.node_e7(v);
        LngLat::from_e7(x, y)
    }

    #[inline]
    #[must_use]
    pub fn from(&self, e: EdgeId) -> NodeId {
        self.edges.from[e as usize]
    }

    #[inline]
    #[must_use]
    pub fn to(&self, e: EdgeId) -> NodeId {
        self.edges.to[e as usize]
    }

    /// The node an arc leaves.
    #[inline]
    #[must_use]
    pub fn tail(&self, a: ArcId) -> NodeId {
        let e = arc_edge(a) as usize;
        if arc_is_reverse(a) {
            self.edges.to[e]
        } else {
            self.edges.from[e]
        }
    }

    /// The node an arc leads to.
    #[inline]
    #[must_use]
    pub fn head(&self, a: ArcId) -> NodeId {
        let e = arc_edge(a) as usize;
        if arc_is_reverse(a) {
            self.edges.from[e]
        } else {
            self.edges.to[e]
        }
    }

    /// Whether one-way allows riding the arc. Legal access is not checked here: that is the
    /// profile's call (hard constraints are infinite costs).
    #[inline]
    #[must_use]
    pub fn arc_allowed(&self, a: ArcId) -> bool {
        oneway_of(self.edges.surf[arc_edge(a) as usize]).allows(arc_is_reverse(a))
    }

    #[inline]
    fn slots(&self, v: NodeId) -> Range<usize> {
        let v = v as usize;
        self.first[v] as usize..self.first[v + 1] as usize
    }

    /// Every arc leaving `v` regardless of one-way, with its [`flags`] (map-matching follows tracks
    /// that ride against a one-way). Each edge at `v` appears once (twice for a loop).
    #[inline]
    #[must_use]
    pub fn arcs_at(&self, v: NodeId) -> (&[ArcId], &[u8]) {
        let r = self.slots(v);
        (&self.arcs[r.clone()], &self.flags[r])
    }

    /// The arcs leaving `v` that one-way allows (forward search).
    #[inline]
    pub fn out_arcs(&self, v: NodeId) -> impl Iterator<Item = ArcId> + '_ {
        let (arcs, flags) = self.arcs_at(v);
        arcs.iter()
            .zip(flags)
            .filter(|&(_, f)| f & flags::OUT != 0)
            .map(|(&a, _)| a)
    }

    /// The arcs arriving at `v` that one-way allows (backward search): `head(a) == v`.
    #[inline]
    pub fn in_arcs(&self, v: NodeId) -> impl Iterator<Item = ArcId> + '_ {
        let (arcs, flags) = self.arcs_at(v);
        arcs.iter()
            .zip(flags)
            .filter(|&(_, f)| f & flags::IN != 0)
            .map(|(&a, _)| a ^ 1)
    }

    /// Straight-line (equirectangular) distance between two nodes in metres: the A* bound's base.
    #[inline]
    #[must_use]
    pub fn node_distance_m(&self, a: NodeId, b: NodeId) -> f64 {
        let (ax, ay) = self.node_e7(a);
        let (bx, by) = self.node_e7(b);
        let kx = ((f64::from(ay) + f64::from(by)) * 0.5e-7).to_radians().cos();
        let dx = f64::from(bx - ax) * kx;
        let dy = f64::from(by - ay);
        dx.hypot(dy) * M_PER_E7
    }

    /// Builds the CSR adjacency over the edges of loaded tiles whose end nodes are loaded too (a
    /// counting sort, O(V + E)). Slots of a node are in edge order.
    #[allow(
        clippy::cast_possible_truncation,
        reason = "arc and slot counts fit in u32 (checked at load)"
    )]
    fn build_adjacency(&mut self) {
        self.complete = self.tile_loaded.iter().all(|&l| l);
        let n = self.node_count();
        let mask = self.usable_mask();
        let usable = |e: usize| mask.as_ref().is_none_or(|m| m[e]);
        let m = self.edge_count();
        let mut first = vec![0u32; n + 1];
        for e in (0..m).filter(|&e| usable(e)) {
            first[self.edges.from[e] as usize + 1] += 1;
            first[self.edges.to[e] as usize + 1] += 1;
        }
        for i in 0..n {
            first[i + 1] += first[i];
        }
        let total = first[n] as usize;
        let mut fill = first.clone();
        let mut arcs = vec![0u32; total];
        let mut fl = vec![0u8; total];
        for e in (0..m).filter(|&e| usable(e)) {
            let ow = oneway_of(self.edges.surf[e]);
            let (a, b) = (self.edges.from[e] as usize, self.edges.to[e] as usize);
            let e = e as EdgeId;
            let (fwd, bwd) = (ow.allows(false), ow.allows(true));
            for (v, a_out, ok_out, ok_in) in [(a, arc(e, false), fwd, bwd), (b, arc(e, true), bwd, fwd)] {
                let slot = fill[v] as usize;
                arcs[slot] = a_out;
                fl[slot] = if ok_out { flags::OUT } else { 0 } | if ok_in { flags::IN } else { 0 };
                fill[v] += 1;
            }
        }
        self.first = first;
        self.arcs = arcs;
        self.flags = fl;
    }

    /// Per edge: whether the adjacency covers it; `None` when every tile is loaded (all edges).
    fn usable_mask(&self) -> Option<Vec<bool>> {
        if self.is_complete() {
            return None;
        }
        let mut node_ok = vec![false; self.node_count()];
        let mut mask = vec![false; self.edge_count()];
        for (t, tile) in self.info.tiles.iter().enumerate() {
            if self.tile_loaded[t] {
                node_ok[tile.nodes.start as usize..tile.nodes.end as usize].fill(true);
            }
        }
        for (t, tile) in self.info.tiles.iter().enumerate() {
            if self.tile_loaded[t] {
                for e in tile.edges.start as usize..tile.edges.end as usize {
                    mask[e] = node_ok[self.edges.from[e] as usize] && node_ok[self.edges.to[e] as usize];
                }
            }
        }
        Some(mask)
    }

    /// Whether the adjacency covers edge `e` (always, once every tile is loaded).
    #[must_use]
    pub fn edge_usable(&self, e: EdgeId) -> bool {
        if self.is_complete() {
            return (e as usize) < self.edge_count();
        }
        let ok = |v: NodeId| self.info.tile_of_node(v).is_some_and(|t| self.tile_loaded[t]);
        self.info.tile_of_edge(e).is_some_and(|t| self.tile_loaded[t]) && ok(self.from(e)) && ok(self.to(e))
    }

    // --- attributes ----------------------------------------------------------------------------

    /// All attributes of an edge, decoded.
    #[must_use]
    pub fn attrs(&self, e: EdgeId) -> EdgeAttrs {
        self.edges.packed(e as usize).unpack()
    }

    /// The packed attribute bytes of an edge.
    #[must_use]
    pub fn packed(&self, e: EdgeId) -> Packed {
        self.edges.packed(e as usize)
    }

    /// Length in metres (0.1 m steps).
    #[inline]
    #[must_use]
    pub fn length_m(&self, e: EdgeId) -> f32 {
        crate::attrs::length_m_of(self.edges.length_dm[e as usize])
    }

    #[inline]
    #[must_use]
    pub fn highway(&self, e: EdgeId) -> Highway {
        Highway::from_code(self.edges.highway[e as usize]).unwrap_or_default()
    }

    #[inline]
    #[must_use]
    pub fn surface(&self, e: EdgeId) -> SurfaceClass {
        SurfaceClass::from_code(self.edges.surf[e as usize] & 7).unwrap_or_default()
    }

    #[inline]
    #[must_use]
    pub fn tracktype(&self, e: EdgeId) -> Tracktype {
        Tracktype::from_code((self.edges.surf[e as usize] >> 3) & 7).unwrap_or_default()
    }

    #[inline]
    #[must_use]
    pub fn oneway(&self, e: EdgeId) -> Oneway {
        oneway_of(self.edges.surf[e as usize])
    }

    #[inline]
    #[must_use]
    pub fn smoothness(&self, e: EdgeId) -> Smoothness {
        Smoothness::from_code(self.edges.smooth[e as usize] & 15).unwrap_or_default()
    }

    #[inline]
    #[must_use]
    pub fn trail_visibility(&self, e: EdgeId) -> TrailVisibility {
        TrailVisibility::from_code((self.edges.smooth[e as usize] >> 4) & 7).unwrap_or_default()
    }

    /// `informal=yes` (a desire path).
    #[inline]
    #[must_use]
    pub fn informal(&self, e: EdgeId) -> bool {
        self.edges.smooth[e as usize] >> 7 != 0
    }

    #[inline]
    #[must_use]
    pub fn bike_access(&self, e: EdgeId) -> BikeAccess {
        BikeAccess::from_code(self.edges.access[e as usize] & 15).unwrap_or_default()
    }

    #[inline]
    #[must_use]
    pub fn motor_access(&self, e: EdgeId) -> MotorAccess {
        MotorAccess::from_code((self.edges.access[e as usize] >> 4) & 7).unwrap_or_default()
    }

    /// Member of a `route=mtb` relation.
    #[inline]
    #[must_use]
    pub fn mtb_route(&self, e: EdgeId) -> bool {
        self.edges.access[e as usize] >> 7 != 0
    }

    #[inline]
    #[must_use]
    pub fn cycleway(&self, e: EdgeId) -> CyclewayKind {
        CyclewayKind::from_code(self.edges.road[e as usize] & 7).unwrap_or_default()
    }

    #[inline]
    #[must_use]
    pub fn route_level(&self, e: EdgeId) -> RouteLevel {
        RouteLevel::from_code((self.edges.road[e as usize] >> 3) & 7).unwrap_or_default()
    }

    #[inline]
    #[must_use]
    pub fn bridge(&self, e: EdgeId) -> bool {
        (self.edges.road[e as usize] >> 6) & 1 != 0
    }

    #[inline]
    #[must_use]
    pub fn tunnel(&self, e: EdgeId) -> bool {
        self.edges.road[e as usize] >> 7 != 0
    }

    /// km/h in 5 km/h steps; `None` unknown.
    #[inline]
    #[must_use]
    pub fn maxspeed_kmh(&self, e: EdgeId) -> Option<u8> {
        let v = self.edges.speed[e as usize] & 31;
        (v != 0).then_some(v * 5)
    }

    /// 1..=7 (7 = 7 or more); `None` unknown.
    #[inline]
    #[must_use]
    pub fn lanes(&self, e: EdgeId) -> Option<u8> {
        let v = self.edges.speed[e as usize] >> 5;
        (v != 0).then_some(v)
    }

    #[inline]
    #[must_use]
    pub fn mtb_scale(&self, e: EdgeId) -> MtbScale {
        MtbScale::from_code(self.edges.diff[e as usize] & 7).unwrap_or_default()
    }

    #[inline]
    #[must_use]
    pub fn sac_scale(&self, e: EdgeId) -> SacScale {
        SacScale::from_code((self.edges.diff[e as usize] >> 3) & 7).unwrap_or_default()
    }

    /// Barriers on the edge's nodes (0..=3, 3 = three or more).
    #[inline]
    #[must_use]
    pub fn barriers(&self, e: EdgeId) -> u8 {
        self.edges.diff[e as usize] >> 6
    }

    #[inline]
    fn ctx_share(&self, e: EdgeId, shift: u16) -> f32 {
        f32::from((self.edges.ctx[e as usize] >> shift) & 15) / 15.0
    }

    /// Share of the length inside forest, 0..=1.
    #[inline]
    #[must_use]
    pub fn forest_share(&self, e: EdgeId) -> f32 {
        self.ctx_share(e, 0)
    }

    /// Share along a forest boundary, 0..=1.
    #[inline]
    #[must_use]
    pub fn forest_edge_share(&self, e: EdgeId) -> f32 {
        self.ctx_share(e, 4)
    }

    /// Share near water, 0..=1.
    #[inline]
    #[must_use]
    pub fn water_share(&self, e: EdgeId) -> f32 {
        self.ctx_share(e, 8)
    }

    /// Share inside built-up land, 0..=1.
    #[inline]
    #[must_use]
    pub fn builtup_share(&self, e: EdgeId) -> f32 {
        self.ctx_share(e, 12)
    }

    /// Share within 20 m of a motor road, 0..=1 (1 on roads themselves).
    #[inline]
    #[must_use]
    pub fn road_near_share(&self, e: EdgeId) -> f32 {
        f32::from(self.edges.ctx2[e as usize] & 15) / 15.0
    }

    /// The traffic level of the motor roads within 20 m, 0..=1, over the part of the length near
    /// them (0 where none is).
    #[inline]
    #[must_use]
    pub fn road_near_traffic(&self, e: EdgeId) -> f32 {
        f32::from(self.edges.ctx3[e as usize] & 15) / 15.0
    }

    /// Metres in 0.5 m steps (7.5 = 7.5 or more); `None` unknown.
    #[inline]
    #[must_use]
    pub fn width_m(&self, e: EdgeId) -> Option<f32> {
        let v = self.edges.ctx2[e as usize] >> 4;
        (v != 0).then(|| f32::from(v) * 0.5)
    }

    /// Climbing along the arc in metres.
    #[inline]
    #[must_use]
    pub fn ascent_m(&self, a: ArcId) -> f32 {
        let e = arc_edge(a) as usize;
        let dm = if arc_is_reverse(a) {
            self.edges.ascent_bwd_dm[e]
        } else {
            self.edges.ascent_fwd_dm[e]
        };
        f32::from(dm) * 0.1
    }

    /// Descending along the arc in metres (the climb of the opposite arc).
    #[inline]
    #[must_use]
    pub fn descent_m(&self, a: ArcId) -> f32 {
        self.ascent_m(a ^ 1)
    }

    /// Steepest 50 m along the arc, whole percent.
    #[inline]
    #[must_use]
    pub fn max_grade_pct(&self, a: ArcId) -> f32 {
        let e = arc_edge(a) as usize;
        f32::from(if arc_is_reverse(a) {
            self.edges.grade_bwd[e]
        } else {
            self.edges.grade_fwd[e]
        })
    }

    // --- geometry ------------------------------------------------------------------------------

    /// Whether edge `e`'s geometry is loaded.
    #[must_use]
    pub fn has_geometry(&self, e: EdgeId) -> bool {
        self.geometry.record(e as usize).is_some()
    }

    /// The points of edge `e` from `from` to `to` (1e-7 degrees): the geometry if loaded, else the
    /// straight segment between its nodes.
    #[inline]
    #[must_use]
    pub fn edge_points(&self, e: EdgeId) -> EdgePoints<'_> {
        self.edge_points_with(e, true)
    }

    /// [`Graph::edge_points`], ignoring the geometry when `use_geometry` is false.
    #[inline]
    #[must_use]
    pub fn edge_points_with(&self, e: EdgeId, use_geometry: bool) -> EdgePoints<'_> {
        let (a, b) = (self.from(e), self.to(e));
        let record = if use_geometry {
            self.geometry.record(e as usize)
        } else {
            None
        };
        EdgePoints::new(self.node_e7(a), self.node_e7(b), record)
    }

    /// The OSM way of edge `e` and its nodes' positions in it (with the geometry).
    #[must_use]
    pub fn way(&self, e: EdgeId) -> Option<WayRef> {
        self.geometry.way(e as usize)
    }

    /// Adds a geometry tile (any order, any time).
    pub fn add_geometry(&mut self, bytes: &[u8]) -> Result<usize, FormatError> {
        let r = Reader::new(bytes, FileKind::Geometry)?;
        let t = self.check_tile_header(&r)?;
        if self.geometry_loaded[t] {
            return Err(FormatError::new("geometry tile loaded twice"));
        }
        let edges = self.info.tiles[t].edges.clone();
        let offsets: Vec<u32> = r.vec(GEO_OFFSETS)?;
        let data = r.bytes(GEO_DATA)?;
        if offsets.len() != edges.len() + 1
            || offsets.windows(2).any(|w| w[0] > w[1])
            || offsets.last().is_none_or(|&end| end as usize != data.len())
        {
            return Err(FormatError::new("geometry offsets do not match the tile"));
        }
        let base = u32::try_from(self.geometry.bytes.len() + data.len())
            .map_err(|_| FormatError::new("geometry larger than 4 GB"))?
            - u32::try_from(data.len()).unwrap_or(0);
        self.geometry.bytes.extend_from_slice(data);
        for (e, off) in edges.zip(&offsets) {
            self.geometry.offsets[e as usize] = base + off;
        }
        self.geometry_loaded[t] = true;
        Ok(t)
    }

    /// Checks a tile file's build id and header against the index; returns the tile's index.
    fn check_tile_header(&self, r: &Reader<'_>) -> Result<usize, FormatError> {
        let id = r.bytes(BUILD_ID)?;
        if id != self.info.build_id.as_bytes() {
            return Err(FormatError(format!(
                "tile of build {} in graph of build {}",
                String::from_utf8_lossy(id),
                self.info.build_id
            )));
        }
        let h: Vec<u32> = r.vec(TILE)?;
        let [zoom, x, y, n0, n1, e0, e1, nodes, edges] = h[..] else {
            return Err(FormatError::new("bad tile header"));
        };
        let t = self
            .info
            .tile_at(x, y)
            .filter(|_| zoom == u32::from(self.info.tile_zoom))
            .ok_or_else(|| FormatError(format!("tile {zoom}/{x}/{y} is not in the index")))?;
        let tile = &self.info.tiles[t];
        if tile.nodes != (n0..n1)
            || tile.edges != (e0..e1)
            || nodes != self.info.node_count
            || edges != self.info.edge_count
        {
            return Err(FormatError(format!(
                "tile {zoom}/{x}/{y} disagrees with the index"
            )));
        }
        Ok(t)
    }

    /// Heap bytes held (columns, geometry, adjacency).
    #[must_use]
    pub fn heap_bytes(&self) -> usize {
        self.nodes.heap_bytes()
            + self.edges.heap_bytes()
            + self.geometry.heap_bytes()
            + (self.first.capacity() + self.arcs.capacity()) * 4
            + self.flags.capacity()
    }

    /// Heap bytes of the adjacency alone.
    #[must_use]
    pub fn adjacency_bytes(&self) -> usize {
        (self.first.capacity() + self.arcs.capacity()) * 4 + self.flags.capacity()
    }

    // --- writing -------------------------------------------------------------------------------

    /// The index file.
    #[must_use]
    pub fn write_index(&self) -> Vec<u8> {
        let info = &self.info;
        let mut w = Writer::new(FileKind::Index);
        w.bytes(BUILD_ID, info.build_id.as_bytes());
        w.put(
            COUNTS,
            &[
                u64::from(info.node_count),
                u64::from(info.edge_count),
                u64::from(info.tile_zoom),
                u64::from(info.schema_version),
            ],
        );
        w.put(BBOX, &info.bbox);
        let tiles: Vec<u32> = info
            .tiles
            .iter()
            .flat_map(|t| [t.x, t.y, t.nodes.start, t.nodes.end, t.edges.start, t.edges.end])
            .collect();
        w.put(TILES, &tiles);
        let bboxes: Vec<i32> = info.tiles.iter().flat_map(|t| t.bbox).collect();
        w.put(TILE_BBOX, &bboxes);
        w.finish()
    }

    fn tile_writer(&self, kind: FileKind, t: usize) -> Writer {
        let tile = &self.info.tiles[t];
        let mut w = Writer::new(kind);
        w.bytes(BUILD_ID, self.info.build_id.as_bytes());
        w.put(
            TILE,
            &[
                u32::from(self.info.tile_zoom),
                tile.x,
                tile.y,
                tile.nodes.start,
                tile.nodes.end,
                tile.edges.start,
                tile.edges.end,
                self.info.node_count,
                self.info.edge_count,
            ],
        );
        w
    }

    /// Graph tile `t` (its nodes and edges). The tile must be loaded.
    #[must_use]
    pub fn write_tile(&self, t: usize) -> Vec<u8> {
        assert!(self.tile_loaded[t], "tile {t} is not loaded");
        let tile = &self.info.tiles[t];
        let mut w = self.tile_writer(FileKind::Graph, t);
        self.nodes
            .write(&mut w, &(tile.nodes.start as usize..tile.nodes.end as usize));
        self.edges
            .write(&mut w, &(tile.edges.start as usize..tile.edges.end as usize));
        w.finish()
    }

    /// Geometry tile `t`. Its geometry must be loaded.
    #[must_use]
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a tile's geometry is far below 4 GB"
    )]
    pub fn write_geometry_tile(&self, t: usize) -> Vec<u8> {
        assert!(self.geometry_loaded[t], "geometry of tile {t} is not loaded");
        let tile = &self.info.tiles[t];
        let mut data = Vec::new();
        let mut offsets = Vec::with_capacity(tile.edges.len() + 1);
        for e in tile.edges.clone() {
            offsets.push(data.len() as u32);
            let rec = self.geometry.record(e as usize).unwrap_or(&[]);
            data.extend_from_slice(&rec[..geometry::record_len(rec)]);
        }
        offsets.push(data.len() as u32);
        let mut w = self.tile_writer(FileKind::Geometry, t);
        w.put(GEO_OFFSETS, &offsets);
        w.bytes(GEO_DATA, &data);
        w.finish()
    }
}

/// Loads a graph tile by tile: the index first, then graph and geometry tiles in any order. The
/// columns are allocated once for the whole region (the index has the totals).
#[derive(Debug)]
pub struct GraphLoader {
    graph: Graph,
}

impl GraphLoader {
    /// Reads the index and allocates the graph.
    pub fn new(index: &[u8]) -> Result<GraphLoader, FormatError> {
        let r = Reader::new(index, FileKind::Index)?;
        let build_id = String::from_utf8(r.bytes(BUILD_ID)?.to_vec())
            .map_err(|_| FormatError::new("build id is not UTF-8"))?;
        let counts: Vec<u64> = r.vec(COUNTS)?;
        let [node_count, edge_count, zoom, schema_version] = counts[..] else {
            return Err(FormatError::new("bad counts"));
        };
        let node_count = u32::try_from(node_count).map_err(|_| FormatError::new("too many nodes"))?;
        let edge_count = u32::try_from(edge_count)
            .ok()
            .filter(|&m| m < 1 << 31)
            .ok_or_else(|| FormatError::new("too many edges"))?;
        let tile_zoom = u8::try_from(zoom)
            .ok()
            .filter(|&z| z <= crate::hilbert::KEY_ZOOM)
            .ok_or_else(|| FormatError::new("bad tile zoom"))?;
        let bbox: Vec<i32> = r.vec(BBOX)?;
        let bbox: [i32; 4] = bbox.try_into().map_err(|_| FormatError::new("bad bbox"))?;
        let raw: Vec<u32> = r.vec(TILES)?;
        let boxes: Vec<i32> = r.vec(TILE_BBOX)?;
        if !raw.len().is_multiple_of(6) || boxes.len() != raw.len() / 6 * 4 {
            return Err(FormatError::new("bad tile table"));
        }
        let tiles: Vec<TileInfo> = raw
            .as_chunks::<6>()
            .0
            .iter()
            .zip(boxes.as_chunks::<4>().0)
            .map(|(t, b)| TileInfo {
                x: t[0],
                y: t[1],
                nodes: t[2]..t[3],
                edges: t[4]..t[5],
                bbox: [b[0], b[1], b[2], b[3]],
            })
            .collect();
        // the tiles partition the nodes and the edges, in order
        let (mut n, mut m) = (0, 0);
        for t in &tiles {
            if t.nodes.start != n || t.nodes.end < n || t.edges.start != m || t.edges.end < m {
                return Err(FormatError::new("tile ranges do not partition the graph"));
            }
            (n, m) = (t.nodes.end, t.edges.end);
        }
        if n != node_count || m != edge_count {
            return Err(FormatError::new("tile ranges do not cover the graph"));
        }
        let info = GraphInfo {
            build_id,
            format_version: FORMAT_VERSION,
            schema_version: u32::try_from(schema_version).unwrap_or(0),
            tile_zoom,
            node_count,
            edge_count,
            bbox,
            tiles,
        };
        let tiles = info.tiles.len();
        Ok(GraphLoader {
            graph: Graph {
                info,
                tile_loaded: vec![false; tiles],
                complete: tiles == 0,
                geometry_loaded: vec![false; tiles],
                nodes: NodeColumns::with_len(node_count as usize),
                edges: EdgeColumns::with_len(edge_count as usize),
                geometry: Geometry::with_edges(edge_count as usize),
                first: Vec::new(),
                arcs: Vec::new(),
                flags: Vec::new(),
            },
        })
    }

    #[must_use]
    pub fn info(&self) -> &GraphInfo {
        &self.graph.info
    }

    /// Whether graph tile `t` is loaded.
    #[must_use]
    pub fn tile_loaded(&self, t: usize) -> bool {
        self.graph.tile_loaded(t)
    }

    /// Whether the geometry of tile `t` is loaded.
    #[must_use]
    pub fn geometry_loaded(&self, t: usize) -> bool {
        self.graph.geometry_loaded(t)
    }

    /// The tiles not loaded yet.
    #[must_use]
    pub fn missing_tiles(&self) -> Vec<usize> {
        (0..self.graph.info.tiles.len())
            .filter(|&t| !self.graph.tile_loaded[t])
            .collect()
    }

    /// Adds a graph tile; returns its index in [`GraphInfo::tiles`].
    pub fn add_tile(&mut self, bytes: &[u8]) -> Result<usize, FormatError> {
        let g = &mut self.graph;
        let r = Reader::new(bytes, FileKind::Graph)?;
        let t = g.check_tile_header(&r)?;
        if g.tile_loaded[t] {
            return Err(FormatError::new("tile loaded twice"));
        }
        let tile = &g.info.tiles[t];
        let (nodes, edges) = (
            tile.nodes.start as usize..tile.nodes.end as usize,
            tile.edges.start as usize..tile.edges.end as usize,
        );
        g.nodes.read(&r, &nodes)?;
        g.edges.read(&r, &edges)?;
        let n = g.info.node_count;
        if g.edges.from[edges.clone()]
            .iter()
            .chain(&g.edges.to[edges])
            .any(|&v| v >= n)
        {
            return Err(FormatError::new("edge endpoint out of range"));
        }
        g.tile_loaded[t] = true;
        Ok(t)
    }

    /// Adds a geometry tile (also possible later, on the [`Graph`]).
    pub fn add_geometry(&mut self, bytes: &[u8]) -> Result<usize, FormatError> {
        self.graph.add_geometry(bytes)
    }

    /// Builds the adjacency over what is loaded. With tiles missing, edges touching a node of a
    /// missing tile are left out of the adjacency (a search never reaches them).
    #[must_use]
    pub fn finish(mut self) -> Graph {
        self.graph.build_adjacency();
        self.graph
    }
}

impl Graph {
    /// Back to a loader, to add more tiles (then [`GraphLoader::finish`] again).
    #[must_use]
    pub fn into_loader(self) -> GraphLoader {
        GraphLoader { graph: self }
    }
}

/// Reads the build id of any graph file (index or tile) without loading it.
pub fn build_id_of(bytes: &[u8]) -> Result<String, FormatError> {
    for kind in [FileKind::Index, FileKind::Graph, FileKind::Geometry] {
        if let Ok(r) = Reader::new(bytes, kind) {
            return Ok(String::from_utf8_lossy(r.bytes(BUILD_ID)?).into_owned());
        }
    }
    Err(FormatError::new("not a graph file"))
}
