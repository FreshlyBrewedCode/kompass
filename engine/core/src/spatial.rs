//! Edge geometry (stored apart from the graph, not needed by the search) and a uniform grid for
//! nearest-edge queries (snapping waypoints, map-matching candidates).
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

use crate::graph::{Graph, Reader, Writer, le_u32};

/// Interior points of every edge as zigzag-varint deltas in 1e-6 degrees, starting from the edge's
/// `from` node. The end nodes come from the graph.
#[derive(Debug, Clone, Default)]
pub struct Geometry {
    pub offsets: Vec<u32>,
    pub bytes: Vec<u8>,
}

#[inline]
fn zigzag(v: i32) -> u32 {
    ((v << 1) ^ (v >> 31)) as u32
}

#[inline]
fn unzigzag(v: u32) -> i32 {
    ((v >> 1) as i32) ^ -((v & 1) as i32)
}

fn put_varint(out: &mut Vec<u8>, mut v: u32) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn get_varint(b: &[u8], at: &mut usize) -> u32 {
    let mut v = 0u32;
    let mut shift = 0;
    loop {
        let byte = b[*at];
        *at += 1;
        v |= u32::from(byte & 0x7f) << shift;
        if byte < 0x80 {
            return v;
        }
        shift += 7;
    }
}

impl Geometry {
    /// Appends one edge's interior points (1e-7 degrees), given its `from` node position.
    pub fn push(&mut self, start: (i32, i32), interior: &[(i32, i32)]) {
        self.offsets.push(self.bytes.len() as u32);
        put_varint(&mut self.bytes, interior.len() as u32);
        let (mut px, mut py) = (start.0 / 10, start.1 / 10);
        for &(x, y) in interior {
            let (x, y) = (x / 10, y / 10);
            put_varint(&mut self.bytes, zigzag(x - px));
            put_varint(&mut self.bytes, zigzag(y - py));
            (px, py) = (x, y);
        }
    }

    /// All points of edge `e` (1e-7 degrees), from → to.
    pub fn points(&self, g: &Graph, e: usize, out: &mut Vec<(i32, i32)>) {
        out.clear();
        let (a, b) = (g.from[e] as usize, g.to[e] as usize);
        out.push((g.lon[a], g.lat[a]));
        let mut at = self.offsets[e] as usize;
        let n = get_varint(&self.bytes, &mut at);
        let (mut px, mut py) = (g.lon[a] / 10, g.lat[a] / 10);
        for _ in 0..n {
            px += unzigzag(get_varint(&self.bytes, &mut at));
            py += unzigzag(get_varint(&self.bytes, &mut at));
            out.push((px * 10, py * 10));
        }
        out.push((g.lon[b], g.lat[b]));
    }

    #[must_use]
    pub fn write(&self) -> Vec<u8> {
        let mut w = Writer::default();
        w.section(*b"geo_off_", &le_u32(&self.offsets));
        w.section(*b"geo_pts_", &self.bytes);
        w.finish()
    }

    pub fn read(bytes: &[u8]) -> Result<Geometry, crate::graph::FormatError> {
        let r = Reader::new(bytes)?;
        Ok(Geometry {
            offsets: r.u32s(*b"geo_off_")?.collect(),
            bytes: r.bytes(*b"geo_pts_")?.to_vec(),
        })
    }

    #[must_use]
    pub fn heap_bytes(&self) -> usize {
        self.offsets.len() * 4 + self.bytes.len()
    }
}

/// A uniform grid over the graph's bounding box; each cell lists the edges whose segments' bounding
/// boxes touch it (CSR).
#[derive(Debug, Clone)]
pub struct Grid {
    lon0: i32,
    lat0: i32,
    cell: i32,
    cols: usize,
    rows: usize,
    kx: f64,
    first: Vec<u32>,
    edges: Vec<u32>,
}

/// A nearest-edge hit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Snap {
    pub edge: u32,
    pub dist_m: f64,
    /// Position along the edge, 0 at `from`, 1 at `to` (by planar length).
    pub fraction: f64,
}

const M_PER_E7: f64 = crate::EARTH_RADIUS_M * std::f64::consts::PI / 180.0 * 1e-7;

impl Grid {
    /// `cell_m`: the cell size in metres (north-south; east-west uses the same degree span scaled
    /// by the latitude).
    #[must_use]
    pub fn build(g: &Graph, geo: &Geometry, cell_m: f64) -> Grid {
        let lon0 = g.lon.iter().copied().min().unwrap_or(0);
        let lat0 = g.lat.iter().copied().min().unwrap_or(0);
        let lon1 = g.lon.iter().copied().max().unwrap_or(0);
        let lat1 = g.lat.iter().copied().max().unwrap_or(0);
        let mid_lat = (f64::from(lat0) + f64::from(lat1)) * 0.5e-7;
        let kx = mid_lat.to_radians().cos();
        let cell = (cell_m / M_PER_E7) as i32;
        let cols = ((lon1 - lon0) as f64 * kx / f64::from(cell)) as usize + 1;
        let rows = ((lat1 - lat0) / cell) as usize + 1;
        let mut grid = Grid {
            lon0,
            lat0,
            cell,
            cols,
            rows,
            kx,
            first: vec![0; cols * rows + 1],
            edges: Vec::new(),
        };
        let mut pts = Vec::new();
        let mut last = vec![u32::MAX; cols * rows];
        // two passes: count, then fill
        for pass in 0..2 {
            for e in 0..g.edge_count() {
                geo.points(g, e, &mut pts);
                for w in pts.windows(2) {
                    let (c0, r0) = grid.cell_of(w[0].0.min(w[1].0), w[0].1.min(w[1].1));
                    let (c1, r1) = grid.cell_of(w[0].0.max(w[1].0), w[0].1.max(w[1].1));
                    for r in r0..=r1 {
                        for c in c0..=c1 {
                            let i = r * cols + c;
                            if last[i] == e as u32 {
                                continue;
                            }
                            last[i] = e as u32;
                            if pass == 0 {
                                grid.first[i + 1] += 1;
                            } else {
                                grid.edges[grid.first[i] as usize] = e as u32;
                                grid.first[i] += 1;
                            }
                        }
                    }
                }
            }
            if pass == 0 {
                for i in 0..cols * rows {
                    grid.first[i + 1] += grid.first[i];
                }
                grid.edges = vec![0; grid.first[cols * rows] as usize];
                last.fill(u32::MAX);
            }
        }
        // the fill advanced first[i] to the end of cell i: shift back to the starts
        grid.first.rotate_right(1);
        grid.first[0] = 0;
        grid
    }

    #[inline]
    fn cell_of(&self, lon: i32, lat: i32) -> (usize, usize) {
        let c = ((f64::from(lon - self.lon0) * self.kx) / f64::from(self.cell)).max(0.0) as usize;
        let r = ((lat - self.lat0) / self.cell).max(0) as usize;
        (c.min(self.cols - 1), r.min(self.rows - 1))
    }

    #[must_use]
    pub fn heap_bytes(&self) -> usize {
        self.first.len() * 4 + self.edges.len() * 4
    }

    #[must_use]
    pub fn cells(&self) -> usize {
        self.cols * self.rows
    }

    #[must_use]
    pub fn entries(&self) -> usize {
        self.edges.len()
    }

    /// The nearest edge to a point within `max_m`, searching rings of cells outwards.
    #[must_use]
    pub fn nearest(&self, g: &Graph, geo: &Geometry, lon: i32, lat: i32, max_m: f64) -> Option<Snap> {
        let (c, r) = self.cell_of(lon, lat);
        let cell_m = f64::from(self.cell) * M_PER_E7;
        let max_ring = (max_m / cell_m).ceil() as usize + 1;
        let mut best: Option<Snap> = None;
        let mut pts = Vec::new();
        let mut seen_last = u32::MAX;
        for ring in 0..=max_ring {
            // every point of the cells beyond this ring is at least (ring - 1) cells away
            if let Some(b) = best
                && b.dist_m <= (ring as f64 - 1.0).max(0.0) * cell_m
            {
                break;
            }
            let (r0, r1) = (r.saturating_sub(ring), (r + ring).min(self.rows - 1));
            let (c0, c1) = (c.saturating_sub(ring), (c + ring).min(self.cols - 1));
            for rr in r0..=r1 {
                for cc in c0..=c1 {
                    if rr.abs_diff(r).max(cc.abs_diff(c)) != ring {
                        continue;
                    }
                    let i = rr * self.cols + cc;
                    for &e in &self.edges[self.first[i] as usize..self.first[i + 1] as usize] {
                        if e == seen_last {
                            continue;
                        }
                        seen_last = e;
                        geo.points(g, e as usize, &mut pts);
                        let (d, f) = self.point_to_line(&pts, lon, lat);
                        if d <= max_m && best.is_none_or(|b| d < b.dist_m) {
                            best = Some(Snap {
                                edge: e,
                                dist_m: d,
                                fraction: f,
                            });
                        }
                    }
                }
            }
        }
        best
    }

    /// Distance (m) from a point to a polyline and the position along it (0..=1).
    fn point_to_line(&self, pts: &[(i32, i32)], lon: i32, lat: i32) -> (f64, f64) {
        let xy = |p: (i32, i32)| {
            (
                f64::from(p.0 - lon) * self.kx * M_PER_E7,
                f64::from(p.1 - lat) * M_PER_E7,
            )
        };
        let (mut best, mut best_at, mut total) = (f64::INFINITY, 0.0, 0.0);
        for w in pts.windows(2) {
            let (ax, ay) = xy(w[0]);
            let (bx, by) = xy(w[1]);
            let (dx, dy) = (bx - ax, by - ay);
            let len2 = dx * dx + dy * dy;
            let t = if len2 > 0.0 {
                (-(ax * dx + ay * dy) / len2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let (px, py) = (ax + t * dx, ay + t * dy);
            let d = (px * px + py * py).sqrt();
            let len = len2.sqrt();
            if d < best {
                best = d;
                best_at = total + t * len;
            }
            total += len;
        }
        (best, if total > 0.0 { best_at / total } else { 0.0 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::tests::grid;

    fn straight(g: &Graph) -> Geometry {
        let mut geo = Geometry::default();
        for e in 0..g.edge_count() {
            let (a, b) = (g.from[e] as usize, g.to[e] as usize);
            let mid = (
                i32::midpoint(g.lon[a], g.lon[b]),
                i32::midpoint(g.lat[a], g.lat[b]),
            );
            geo.push((g.lon[a], g.lat[a]), &[mid]);
        }
        geo
    }

    #[test]
    fn geometry_roundtrips() {
        let g = grid();
        let geo = Geometry::read(&straight(&g).write()).unwrap();
        let mut pts = Vec::new();
        geo.points(&g, 0, &mut pts);
        assert_eq!(pts.len(), 3);
        assert_eq!(pts[0], (0, 0));
        assert_eq!(pts[2], (8993, 0));
        assert!((pts[1].0 - 4496).abs() <= 10);
    }

    #[test]
    fn finds_the_nearest_edge() {
        let g = grid();
        let geo = straight(&g);
        let grid = Grid::build(&g, &geo, 30.0);
        // 10 m north of the middle of edge 0 (node 0 → node 1)
        let snap = grid.nearest(&g, &geo, 4496, 899, 200.0).unwrap();
        assert_eq!(snap.edge, 0);
        assert!((snap.dist_m - 10.0).abs() < 0.5, "{}", snap.dist_m);
        assert!((snap.fraction - 0.5).abs() < 0.01);
        // brute force agrees on a sweep of points
        for i in 0..40 {
            let (lon, lat) = (i * 500 - 1000, (i * 7919) % 20000 - 1000);
            let got = grid.nearest(&g, &geo, lon, lat, 1000.0).unwrap();
            let mut pts = Vec::new();
            let want = (0..g.edge_count())
                .map(|e| {
                    geo.points(&g, e, &mut pts);
                    grid.point_to_line(&pts, lon, lat).0
                })
                .fold(f64::INFINITY, f64::min);
            assert!((got.dist_m - want).abs() < 1e-6, "{lon},{lat}");
        }
    }
}
