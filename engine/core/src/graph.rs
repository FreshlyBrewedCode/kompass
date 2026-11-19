//! The routing graph: struct-of-arrays edges with quantised attributes, node coordinates, and a CSR
//! adjacency (built at load time from the edge endpoints, so the file stores no adjacency).
//!
//! File format (`KMPG`, little endian): a 16-byte header (`b"KMPG"`, version u32, section count
//! u32, reserved u32), a table of sections (`[u8; 8]` name, u64 offset, u64 length), then the
//! sections, each 8-byte aligned. Every section is one column (an array of one primitive type).
//! A tile file is the same container holding a contiguous range of edges and nodes (`meta` says
//! which), so "load all tiles" and "load one blob" give the same `Graph`.
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
    reason = "spike #4: graph ids and counts fit in u32 by construction (≤ 2^32 nodes / arcs); quantisation casts are deliberate"
)]

/// Bit layouts of the packed attribute bytes (see the field docs on [`Graph`]).
pub mod bits {
    /// In `surf`: ridable only along the geometry (from → to).
    pub const ONEWAY_FWD: u8 = 1 << 6;
    /// In `surf`: ridable only against the geometry.
    pub const ONEWAY_BWD: u8 = 2 << 6;
}

/// The routing graph. Edge `e` joins `from[e]` and `to[e]`; arcs are `e << 1 | d`, `d = 0` along
/// the geometry (from → to), `d = 1` against it. Costs are indexed by arc.
#[derive(Debug, Default, Clone)]
pub struct Graph {
    /// Node longitude and latitude in 1e-7 degrees (OSM precision).
    pub lon: Vec<i32>,
    pub lat: Vec<i32>,
    pub from: Vec<u32>,
    pub to: Vec<u32>,
    /// Length in decimetres (max 6553.5 m; the compiler rejects longer edges).
    pub length_dm: Vec<u16>,
    /// Highway class code (the pipeline's `HIGHWAY` table, 0..=21).
    pub highway: Vec<u8>,
    /// `surface_class` (bits 0-2) | `tracktype` (bits 3-5) | one-way (bits 6-7: 1 fwd, 2 bwd).
    pub surf: Vec<u8>,
    /// `smoothness` (0-3) | `trail_visibility` (4-6) | informal (7).
    pub smooth: Vec<u8>,
    /// `bike_access` (0-3) | `motor_access` (4-6) | mtb route (7).
    pub access: Vec<u8>,
    /// `cycleway_kind` (0-2) | `route_level` (3-5) | bridge (6) | tunnel (7).
    pub road: Vec<u8>,
    /// maxspeed / 5 km/h (0-4, 0 unknown, saturates at 155) | lanes (5-7, 0 unknown, 7 = 7+).
    pub speed: Vec<u8>,
    /// `mtb_scale` (0-2) | `sac_scale` (3-5) | barriers (6-7, saturates at 3).
    pub diff: Vec<u8>,
    /// Context shares in sixteenths: forest (0-3) | forest edge (4-7) | water (8-11) | built-up (12-15).
    pub ctx: Vec<u16>,
    /// Near a motor road in sixteenths (0-3) | width class (4-7: 0 unknown, else 0.5 m steps).
    pub ctx2: Vec<u8>,
    /// Ascent along / against the geometry in decimetres.
    pub ascent_fwd_dm: Vec<u16>,
    pub ascent_bwd_dm: Vec<u16>,
    /// Steepest 50 m in percent along / against the geometry (saturates at 255).
    pub grade_fwd: Vec<u8>,
    pub grade_bwd: Vec<u8>,
    /// CSR adjacency (derived): node `v`'s arcs leaving it are `arcs[first[v]..first[v + 1]]`.
    pub first: Vec<u32>,
    pub arcs: Vec<u32>,
}

impl Graph {
    #[must_use]
    pub fn node_count(&self) -> usize {
        self.lon.len()
    }

    #[must_use]
    pub fn edge_count(&self) -> usize {
        self.from.len()
    }

    /// The node an arc leads to.
    #[inline]
    #[must_use]
    pub fn head(&self, arc: u32) -> u32 {
        let e = (arc >> 1) as usize;
        if arc & 1 == 0 { self.to[e] } else { self.from[e] }
    }

    /// The arcs leaving `v` (both edge directions; one-way and constraints are in the costs).
    #[inline]
    #[must_use]
    pub fn out_arcs(&self, v: u32) -> &[u32] {
        let v = v as usize;
        &self.arcs[self.first[v] as usize..self.first[v + 1] as usize]
    }

    #[must_use]
    pub fn length_m(&self, e: usize) -> f32 {
        f32::from(self.length_dm[e]) * 0.1
    }

    /// Builds the CSR adjacency from the edge endpoints (a counting sort, O(V + E)).
    pub fn build_adjacency(&mut self) {
        let n = self.node_count();
        let mut first = vec![0u32; n + 1];
        for (&a, &b) in self.from.iter().zip(&self.to) {
            first[a as usize + 1] += 1;
            first[b as usize + 1] += 1;
        }
        for i in 0..n {
            first[i + 1] += first[i];
        }
        let mut fill = first.clone();
        let mut arcs = vec![0u32; first[n] as usize];
        for (e, (&a, &b)) in self.from.iter().zip(&self.to).enumerate() {
            let e = e as u32;
            arcs[fill[a as usize] as usize] = e << 1;
            fill[a as usize] += 1;
            arcs[fill[b as usize] as usize] = (e << 1) | 1;
            fill[b as usize] += 1;
        }
        self.first = first;
        self.arcs = arcs;
    }

    /// Heap bytes held by the graph (columns + adjacency).
    #[must_use]
    pub fn heap_bytes(&self) -> usize {
        let n = self.node_count();
        let m = self.edge_count();
        n * 8 + m * (8 + 2 + 9 + 2 + 1 + 4 + 2) + self.first.len() * 4 + self.arcs.len() * 4
    }

    /// Serialises nodes `nodes` and edges `edges` (ranges of global ids) as one container. Edge
    /// endpoints stay global ids, so tiles can reference nodes in other tiles.
    #[must_use]
    pub fn write_range(&self, nodes: std::ops::Range<usize>, edges: std::ops::Range<usize>) -> Vec<u8> {
        let mut w = Writer::default();
        let meta = [
            nodes.start as u64,
            nodes.end as u64,
            edges.start as u64,
            edges.end as u64,
            self.node_count() as u64,
            self.edge_count() as u64,
        ];
        w.section(*b"meta____", &le_u64(&meta));
        let (n, e) = (nodes, edges);
        w.section(*b"lon_____", &le_i32(&self.lon[n.clone()]));
        w.section(*b"lat_____", &le_i32(&self.lat[n]));
        w.section(*b"from____", &le_u32(&self.from[e.clone()]));
        w.section(*b"to______", &le_u32(&self.to[e.clone()]));
        w.section(*b"len_dm__", &le_u16(&self.length_dm[e.clone()]));
        w.section(*b"highway_", &self.highway[e.clone()]);
        w.section(*b"surf____", &self.surf[e.clone()]);
        w.section(*b"smooth__", &self.smooth[e.clone()]);
        w.section(*b"access__", &self.access[e.clone()]);
        w.section(*b"road____", &self.road[e.clone()]);
        w.section(*b"speed___", &self.speed[e.clone()]);
        w.section(*b"diff____", &self.diff[e.clone()]);
        w.section(*b"ctx_____", &le_u16(&self.ctx[e.clone()]));
        w.section(*b"ctx2____", &self.ctx2[e.clone()]);
        w.section(*b"asc_fwd_", &le_u16(&self.ascent_fwd_dm[e.clone()]));
        w.section(*b"asc_bwd_", &le_u16(&self.ascent_bwd_dm[e.clone()]));
        w.section(*b"grd_fwd_", &self.grade_fwd[e.clone()]);
        w.section(*b"grd_bwd_", &self.grade_bwd[e]);
        w.finish()
    }

    #[must_use]
    pub fn write(&self) -> Vec<u8> {
        self.write_range(0..self.node_count(), 0..self.edge_count())
    }

    /// Reads one container (a whole graph, or a set of tiles concatenated range by range with
    /// [`Graph::append`]) and builds the adjacency.
    pub fn read(bytes: &[u8]) -> Result<Graph, FormatError> {
        let mut g = Graph::default();
        g.append(bytes)?;
        g.build_adjacency();
        Ok(g)
    }

    /// Reserves the columns for the whole graph (tiles carry its totals), so loading tile by tile
    /// doesn't over-allocate.
    fn reserve_exact(&mut self, nodes: usize, edges: usize) {
        let dn = nodes.saturating_sub(self.node_count());
        let de = edges.saturating_sub(self.edge_count());
        self.lon.reserve_exact(dn);
        self.lat.reserve_exact(dn);
        for v in [&mut self.from, &mut self.to] {
            v.reserve_exact(de);
        }
        for v in [
            &mut self.length_dm,
            &mut self.ctx,
            &mut self.ascent_fwd_dm,
            &mut self.ascent_bwd_dm,
        ] {
            v.reserve_exact(de);
        }
        for v in [
            &mut self.highway,
            &mut self.surf,
            &mut self.smooth,
            &mut self.access,
            &mut self.road,
            &mut self.speed,
            &mut self.diff,
            &mut self.ctx2,
            &mut self.grade_fwd,
            &mut self.grade_bwd,
        ] {
            v.reserve_exact(de);
        }
    }

    /// Appends a tile (its ranges must continue the ones already loaded). Call
    /// [`Graph::build_adjacency`] once all tiles are in.
    pub fn append(&mut self, bytes: &[u8]) -> Result<(), FormatError> {
        let r = Reader::new(bytes)?;
        let meta = r.u64s(*b"meta____")?;
        if meta.len() < 4 || meta[0] as usize != self.node_count() || meta[2] as usize != self.edge_count() {
            return Err(FormatError("tile out of order"));
        }
        if let (Some(&nodes), Some(&edges)) = (meta.get(4), meta.get(5)) {
            self.reserve_exact(nodes as usize, edges as usize);
        }
        self.lon.extend(r.i32s(*b"lon_____")?);
        self.lat.extend(r.i32s(*b"lat_____")?);
        self.from.extend(r.u32s(*b"from____")?);
        self.to.extend(r.u32s(*b"to______")?);
        self.length_dm.extend(r.u16s(*b"len_dm__")?);
        self.highway.extend_from_slice(r.bytes(*b"highway_")?);
        self.surf.extend_from_slice(r.bytes(*b"surf____")?);
        self.smooth.extend_from_slice(r.bytes(*b"smooth__")?);
        self.access.extend_from_slice(r.bytes(*b"access__")?);
        self.road.extend_from_slice(r.bytes(*b"road____")?);
        self.speed.extend_from_slice(r.bytes(*b"speed___")?);
        self.diff.extend_from_slice(r.bytes(*b"diff____")?);
        self.ctx.extend(r.u16s(*b"ctx_____")?);
        self.ctx2.extend_from_slice(r.bytes(*b"ctx2____")?);
        self.ascent_fwd_dm.extend(r.u16s(*b"asc_fwd_")?);
        self.ascent_bwd_dm.extend(r.u16s(*b"asc_bwd_")?);
        self.grade_fwd.extend_from_slice(r.bytes(*b"grd_fwd_")?);
        self.grade_bwd.extend_from_slice(r.bytes(*b"grd_bwd_")?);
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatError(pub &'static str);

impl std::fmt::Display for FormatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "graph format: {}", self.0)
    }
}

impl std::error::Error for FormatError {}

const MAGIC: &[u8; 4] = b"KMPG";
const VERSION: u32 = 1;

/// Writes a section container.
#[derive(Default)]
pub struct Writer {
    sections: Vec<([u8; 8], Vec<u8>)>,
}

impl Writer {
    pub fn section(&mut self, name: [u8; 8], data: &[u8]) {
        self.sections.push((name, data.to_vec()));
    }

    #[must_use]
    pub fn finish(self) -> Vec<u8> {
        let table = 16 + self.sections.len() * 24;
        let mut out = Vec::new();
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&VERSION.to_le_bytes());
        out.extend_from_slice(&(self.sections.len() as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        let mut offset = table.next_multiple_of(8);
        for (name, data) in &self.sections {
            out.extend_from_slice(name);
            out.extend_from_slice(&(offset as u64).to_le_bytes());
            out.extend_from_slice(&(data.len() as u64).to_le_bytes());
            offset = (offset + data.len()).next_multiple_of(8);
        }
        for (_, data) in &self.sections {
            out.resize(out.len().next_multiple_of(8), 0);
            out.extend_from_slice(data);
        }
        out
    }
}

/// Reads a section container.
pub struct Reader<'a> {
    bytes: &'a [u8],
    table: Vec<([u8; 8], usize, usize)>,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Result<Self, FormatError> {
        if bytes.len() < 16 || &bytes[0..4] != MAGIC {
            return Err(FormatError("bad magic"));
        }
        if u32_at(bytes, 4) != VERSION {
            return Err(FormatError("unsupported version"));
        }
        let count = u32_at(bytes, 8) as usize;
        let mut table = Vec::with_capacity(count);
        for i in 0..count {
            let at = 16 + i * 24;
            let entry = bytes.get(at..at + 24).ok_or(FormatError("truncated table"))?;
            let mut name = [0u8; 8];
            name.copy_from_slice(&entry[0..8]);
            let off = u64::from_le_bytes(entry[8..16].try_into().unwrap_or_default()) as usize;
            let len = u64::from_le_bytes(entry[16..24].try_into().unwrap_or_default()) as usize;
            if off.checked_add(len).is_none_or(|end| end > bytes.len()) {
                return Err(FormatError("section out of bounds"));
            }
            table.push((name, off, len));
        }
        Ok(Reader { bytes, table })
    }

    pub fn bytes(&self, name: [u8; 8]) -> Result<&'a [u8], FormatError> {
        self.table
            .iter()
            .find(|(n, _, _)| *n == name)
            .map(|&(_, off, len)| &self.bytes[off..off + len])
            .ok_or(FormatError("missing section"))
    }

    pub fn u16s(&self, name: [u8; 8]) -> Result<impl Iterator<Item = u16> + 'a, FormatError> {
        Ok(self
            .bytes(name)?
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]])))
    }

    pub fn u32s(&self, name: [u8; 8]) -> Result<impl Iterator<Item = u32> + 'a, FormatError> {
        Ok(self
            .bytes(name)?
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])))
    }

    pub fn i32s(&self, name: [u8; 8]) -> Result<impl Iterator<Item = i32> + 'a, FormatError> {
        Ok(self
            .bytes(name)?
            .chunks_exact(4)
            .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]])))
    }

    pub fn u64s(&self, name: [u8; 8]) -> Result<Vec<u64>, FormatError> {
        Ok(self
            .bytes(name)?
            .chunks_exact(8)
            .map(|c| u64::from_le_bytes(c.try_into().unwrap_or_default()))
            .collect())
    }
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

#[must_use]
pub fn le_u16(v: &[u16]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

#[must_use]
pub fn le_u32(v: &[u32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

#[must_use]
pub fn le_i32(v: &[i32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

#[must_use]
pub fn le_u64(v: &[u64]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A 3×3 grid of nodes 100 m apart (around 0°, 0°), 12 edges, the top row one-way eastwards.
    pub(crate) fn grid() -> Graph {
        let mut g = Graph::default();
        let step = 8993; // ≈ 100 m in 1e-7 degrees
        for y in 0..3 {
            for x in 0..3 {
                g.lon.push(x * step);
                g.lat.push(y * step);
            }
        }
        let mut edges = Vec::new();
        for y in 0..3u32 {
            for x in 0..3u32 {
                let v = y * 3 + x;
                if x < 2 {
                    edges.push((v, v + 1, y == 2));
                }
                if y < 2 {
                    edges.push((v, v + 3, false));
                }
            }
        }
        for (a, b, oneway) in edges {
            g.from.push(a);
            g.to.push(b);
            g.length_dm.push(1000);
            g.highway.push(14); // track
            g.surf.push(4 | if oneway { bits::ONEWAY_FWD } else { 0 });
            g.smooth.push(0);
            g.access.push(0);
            g.road.push(0);
            g.speed.push(0);
            g.diff.push(0);
            g.ctx.push(0);
            g.ctx2.push(0);
            g.ascent_fwd_dm.push(0);
            g.ascent_bwd_dm.push(0);
            g.grade_fwd.push(0);
            g.grade_bwd.push(0);
        }
        g.build_adjacency();
        g
    }

    #[test]
    fn roundtrips_through_the_container() {
        let g = grid();
        let h = Graph::read(&g.write()).unwrap();
        assert_eq!(h.from, g.from);
        assert_eq!(h.lat, g.lat);
        assert_eq!(h.arcs, g.arcs);
        assert_eq!(h.surf, g.surf);
    }

    #[test]
    fn tiles_append_to_the_same_graph() {
        let g = grid();
        let mut h = Graph::default();
        h.append(&g.write_range(0..4, 0..5)).unwrap();
        h.append(&g.write_range(4..9, 5..12)).unwrap();
        h.build_adjacency();
        assert_eq!(h.arcs, g.arcs);
        assert!(h.append(&g.write_range(0..4, 0..5)).is_err());
    }

    #[test]
    fn adjacency_covers_both_ends() {
        let g = grid();
        assert_eq!(g.arcs.len(), 24);
        // the centre node has 4 arcs, each leading to a neighbour
        let mut heads: Vec<u32> = g.out_arcs(4).iter().map(|&a| g.head(a)).collect();
        heads.sort_unstable();
        assert_eq!(heads, vec![1, 3, 5, 7]);
    }
}
