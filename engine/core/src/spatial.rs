//! A uniform grid over the edges for nearest-edge queries: snapping waypoints and the candidates of
//! map-matching (which calls [`Grid::snap_into`] for every track point, so it allocates nothing).
//!
//! Each cell lists the edges whose segments' bounding boxes touch it (CSR). A query scans rings of
//! cells outwards and stops once no unscanned cell can hold anything nearer than what it has.
//! Distances are on a local equirectangular projection around the query point (well under 0.1 %
//! off at the radii snapping uses).

use crate::graph::{EdgeId, Graph};
use crate::{LngLat, M_PER_E7};

/// The cell size the spike measured as the best trade-off (build time, memory, query time).
pub const DEFAULT_CELL_M: f64 = 200.0;

/// A nearest-edge hit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Snap {
    pub edge: EdgeId,
    /// Position along the edge, 0 at `from`, 1 at `to` (by length along its points).
    pub fraction: f64,
    /// Metres from the query point to `point`.
    pub distance_m: f64,
    /// The nearest point on the edge.
    pub point: LngLat,
}

/// The grid. Built from a graph, and only valid for it (and for the geometry it was built with).
#[derive(Debug, Clone)]
pub struct Grid {
    lon0: i32,
    lat0: i32,
    /// Cell size in 1e-7 degrees of latitude.
    cell: f64,
    cols: usize,
    rows: usize,
    /// cos(latitude) at the grid's middle: east-west cells span `cell / kx` of longitude.
    kx: f64,
    use_geometry: bool,
    first: Vec<u32>,
    edges: Vec<EdgeId>,
}

impl Grid {
    /// Builds the grid over every edge the adjacency covers. With geometry loaded the cells follow
    /// it, else the straight segments between the end nodes; queries then use the same points.
    #[must_use]
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "grid dimensions are small positive numbers"
    )]
    pub fn build(g: &Graph, cell_m: f64) -> Grid {
        let [w, s, e, n] = g.info().bbox;
        let (w, s, e, n) = if w > e { (0, 0, 0, 0) } else { (w, s, e, n) };
        let mid_lat = (f64::from(s) + f64::from(n)) * 0.5e-7;
        let kx = mid_lat.to_radians().cos().max(0.01);
        let cell = (cell_m / M_PER_E7).max(1.0);
        let cols = (f64::from(e - w) * kx / cell) as usize + 1;
        let rows = (f64::from(n - s) / cell) as usize + 1;
        let use_geometry = (0..g.info().tiles.len()).any(|t| g.geometry_loaded(t));
        let mut grid = Grid {
            lon0: w,
            lat0: s,
            cell,
            cols,
            rows,
            kx,
            use_geometry,
            first: vec![0; cols * rows + 1],
            edges: Vec::new(),
        };
        let cells = cols * rows;
        let mut last = vec![u32::MAX; cells];
        let m = g.edge_count() as EdgeId;
        // two passes: count, then fill
        for pass in 0..2 {
            for e in (0..m).filter(|&e| g.edge_usable(e)) {
                let mut pts = g.edge_points_with(e, use_geometry);
                let Some(mut prev) = pts.next() else { continue };
                for p in pts {
                    let (c0, r0) = grid.cell_clamped(prev.0.min(p.0), prev.1.min(p.1));
                    let (c1, r1) = grid.cell_clamped(prev.0.max(p.0), prev.1.max(p.1));
                    for r in r0..=r1 {
                        for c in c0..=c1 {
                            let i = r * cols + c;
                            if last[i] == e {
                                continue;
                            }
                            last[i] = e;
                            if pass == 0 {
                                grid.first[i + 1] += 1;
                            } else {
                                grid.edges[grid.first[i] as usize] = e;
                                grid.first[i] += 1;
                            }
                        }
                    }
                    prev = p;
                }
            }
            if pass == 0 {
                for i in 0..cells {
                    grid.first[i + 1] += grid.first[i];
                }
                grid.edges = vec![0; grid.first[cells] as usize];
                last.fill(u32::MAX);
            }
        }
        // the fill advanced first[i] to the end of cell i: shift back to the starts
        grid.first.rotate_right(1);
        grid.first[0] = 0;
        grid
    }

    /// The cell of a point, unclamped (may be outside the grid).
    #[inline]
    #[allow(clippy::cast_possible_truncation, reason = "floor of a bounded value")]
    fn cell_of(&self, lon: i32, lat: i32) -> (i64, i64) {
        let c = (f64::from(lon - self.lon0) * self.kx / self.cell).floor() as i64;
        let r = (f64::from(lat - self.lat0) / self.cell).floor() as i64;
        (c, r)
    }

    #[inline]
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_possible_wrap,
        reason = "clamped to the grid"
    )]
    fn cell_clamped(&self, lon: i32, lat: i32) -> (usize, usize) {
        let (c, r) = self.cell_of(lon, lat);
        (
            c.clamp(0, self.cols as i64 - 1) as usize,
            r.clamp(0, self.rows as i64 - 1) as usize,
        )
    }

    #[must_use]
    pub fn heap_bytes(&self) -> usize {
        (self.first.capacity() + self.edges.capacity()) * 4
    }

    #[must_use]
    pub fn cells(&self) -> usize {
        self.cols * self.rows
    }

    /// Cell entries (an edge counts once per cell it touches).
    #[must_use]
    pub fn entries(&self) -> usize {
        self.edges.len()
    }

    /// Whether the grid (and its queries) follow the edge geometry.
    #[must_use]
    pub fn uses_geometry(&self) -> bool {
        self.use_geometry
    }

    /// The up to `max_results` nearest edges within `radius_m` of a point, nearest first.
    #[must_use]
    pub fn snap(&self, g: &Graph, at: LngLat, radius_m: f64, max_results: usize) -> Vec<Snap> {
        let mut out = Vec::with_capacity(max_results);
        self.snap_into(g, at, radius_m, max_results, &mut out);
        out
    }

    /// [`Grid::snap`] into a reused vector (cleared first): no allocation once it has capacity.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_possible_wrap,
        clippy::cast_precision_loss,
        reason = "ring and cell indices are small"
    )]
    pub fn snap_into(&self, g: &Graph, at: LngLat, radius_m: f64, max_results: usize, out: &mut Vec<Snap>) {
        out.clear();
        if max_results == 0 || radius_m.is_nan() || radius_m < 0.0 {
            return;
        }
        let (lon, lat) = at.to_e7();
        let q = Query::new(lon, lat);
        let (c, r) = self.cell_of(lon, lat);
        let cell_m = self.cell * M_PER_E7;
        // a cell `ring` steps away is at least (ring - 1) cells away; east-west cells shrink by
        // kx_q / kx where the query is further from the equator than the grid's middle
        let step_m = cell_m * (q.kx / self.kx).min(1.0);
        let max_ring = (radius_m / step_m).ceil() as i64 + 1;
        let (cols, rows) = (self.cols as i64, self.rows as i64);
        let mut seen_last = u32::MAX;
        for ring in 0..=max_ring {
            let bound = (ring as f64 - 1.0).max(0.0) * step_m;
            if bound > radius_m
                || (out.len() == max_results && out.last().is_some_and(|s| s.distance_m <= bound))
            {
                break;
            }
            let (r0, r1) = ((r - ring).max(0), (r + ring).min(rows - 1));
            let (c0, c1) = ((c - ring).max(0), (c + ring).min(cols - 1));
            for rr in r0..=r1 {
                if (rr - r).abs() == ring {
                    for cc in c0..=c1 {
                        self.scan_cell(
                            (rr * cols + cc) as usize,
                            g,
                            &q,
                            radius_m,
                            max_results,
                            out,
                            &mut seen_last,
                        );
                    }
                } else {
                    // inner rows of the ring: only its two side columns
                    for cc in [c - ring, c + ring] {
                        if (0..cols).contains(&cc) {
                            self.scan_cell(
                                (rr * cols + cc) as usize,
                                g,
                                &q,
                                radius_m,
                                max_results,
                                out,
                                &mut seen_last,
                            );
                        }
                    }
                }
            }
        }
    }

    #[inline]
    #[allow(clippy::too_many_arguments, reason = "the query's state, kept off the heap")]
    fn scan_cell(
        &self,
        i: usize,
        g: &Graph,
        q: &Query,
        radius_m: f64,
        max_results: usize,
        out: &mut Vec<Snap>,
        seen_last: &mut u32,
    ) {
        for &e in &self.edges[self.first[i] as usize..self.first[i + 1] as usize] {
            if e == *seen_last {
                continue;
            }
            *seen_last = e;
            if out.iter().any(|s| s.edge == e) {
                continue;
            }
            let (d, fraction, point) = q.to_line(g.edge_points_with(e, self.use_geometry));
            let full = out.len() == max_results;
            if d > radius_m || (full && out.last().is_some_and(|s| (d, e) >= (s.distance_m, s.edge))) {
                continue;
            }
            let at = out.partition_point(|s| (s.distance_m, s.edge) < (d, e));
            if full {
                out.pop();
            }
            out.insert(
                at,
                Snap {
                    edge: e,
                    fraction,
                    distance_m: d,
                    point,
                },
            );
        }
    }
}

/// A query point and its local projection (metres east and north of it).
struct Query {
    lon: i32,
    lat: i32,
    kx: f64,
}

impl Query {
    fn new(lon: i32, lat: i32) -> Query {
        Query {
            lon,
            lat,
            kx: (f64::from(lat) * 1e-7).to_radians().cos(),
        }
    }

    #[inline]
    fn xy(&self, p: (i32, i32)) -> (f64, f64) {
        (
            f64::from(p.0 - self.lon) * self.kx * M_PER_E7,
            f64::from(p.1 - self.lat) * M_PER_E7,
        )
    }

    /// Distance (m) to a polyline, the position along it (0..=1) and the nearest point.
    fn to_line(&self, mut pts: impl Iterator<Item = (i32, i32)>) -> (f64, f64, LngLat) {
        let Some(first) = pts.next() else {
            return (f64::INFINITY, 0.0, LngLat { lng: 0.0, lat: 0.0 });
        };
        let mut a = self.xy(first);
        // squared distances while scanning, one square root at the end
        let (mut best2, mut best_at, mut best_p, mut total) = (a.0 * a.0 + a.1 * a.1, 0.0, a, 0.0);
        for p in pts {
            let b = self.xy(p);
            let (dx, dy) = (b.0 - a.0, b.1 - a.1);
            let len2 = dx * dx + dy * dy;
            let t = if len2 > 0.0 {
                (-(a.0 * dx + a.1 * dy) / len2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let (px, py) = (a.0 + t * dx, a.1 + t * dy);
            let d2 = px * px + py * py;
            let len = len2.sqrt();
            if d2 < best2 {
                best2 = d2;
                best_at = total + t * len;
                best_p = (px, py);
            }
            total += len;
            a = b;
        }
        let best = best2.sqrt();
        let point = LngLat {
            lng: f64::from(self.lon) * 1e-7 + best_p.0 / (self.kx * M_PER_E7) * 1e-7,
            lat: f64::from(self.lat) * 1e-7 + best_p.1 / M_PER_E7 * 1e-7,
        };
        (best, if total > 0.0 { best_at / total } else { 0.0 }, point)
    }
}

/// The nearest edges by brute force over every usable edge (the reference for tests).
#[must_use]
pub fn snap_brute_force(
    g: &Graph,
    at: LngLat,
    radius_m: f64,
    max_results: usize,
    use_geometry: bool,
) -> Vec<Snap> {
    let (lon, lat) = at.to_e7();
    let q = Query::new(lon, lat);
    #[allow(clippy::cast_possible_truncation, reason = "edge count fits u32")]
    let m = g.edge_count() as EdgeId;
    let mut all: Vec<Snap> = (0..m)
        .filter(|&e| g.edge_usable(e))
        .map(|e| {
            let (d, fraction, point) = q.to_line(g.edge_points_with(e, use_geometry));
            Snap {
                edge: e,
                fraction,
                distance_m: d,
                point,
            }
        })
        .filter(|s| s.distance_m <= radius_m)
        .collect();
    all.sort_by(|a, b| {
        (a.distance_m, a.edge)
            .partial_cmp(&(b.distance_m, b.edge))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    all.truncate(max_results);
    all
}
