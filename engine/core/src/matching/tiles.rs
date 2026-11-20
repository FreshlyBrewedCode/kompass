//! Lazy geometry: which tiles a track needs, and a snap grid per tile, built only where tracks are.
//!
//! The history of a rider touches a quarter of a region's tiles, so the browser loads the geometry
//! tile files of those only. [`needed_tiles`] says which, from the points alone. [`TileGrids`] holds
//! one [`Grid`] per tile, built on demand and rebuilt when a tile's geometry arrives later: a tile
//! without geometry is matched on the straight segments between its nodes rather than failing.

use crate::graph::Graph;
use crate::spatial::{DEFAULT_CELL_M, Grid, Snap};
use crate::{LngLat, M_PER_E7};

/// The tiles within `radius_m` of the track (the ones whose edges a candidate search can touch),
/// sorted by index. Tiles are the graph's (`GraphInfo::tiles`): fetch the graph and geometry file
/// of each tile for which [`Graph::tile_loaded`] / [`Graph::geometry_loaded`] is false, then match.
/// Points that are not finite are ignored.
#[must_use]
pub fn needed_tiles<T: Copy + Into<f64>>(g: &Graph, radius_m: f64, lat: &[T], lon: &[T]) -> Vec<usize> {
    needed_tiles_of(
        g,
        radius_m,
        lat.iter().zip(lon).map(|(&la, &lo)| LngLat {
            lng: lo.into(),
            lat: la.into(),
        }),
    )
}

/// [`needed_tiles`] for points as [`LngLat`].
#[must_use]
pub fn needed_tiles_of(g: &Graph, radius_m: f64, points: impl IntoIterator<Item = LngLat>) -> Vec<usize> {
    let tiles = &g.info().tiles;
    let mut hit = vec![false; tiles.len()];
    let mut left = tiles.len();
    // a point nearer than `step` to the last tested one adds at most `step` to what it reaches
    let step = 20.0;
    let reach = radius_m.max(0.0) + step;
    let mut last: Option<LngLat> = None;
    for p in points {
        if !(p.lat.is_finite() && p.lng.is_finite()) || left == 0 {
            continue;
        }
        if last.is_some_and(|l| super::dist_m(l, p) < step) {
            continue;
        }
        last = Some(p);
        let (lng7, lat7) = (p.lng * 1e7, p.lat * 1e7);
        let dlat = reach / M_PER_E7;
        let dlng = dlat / p.lat.to_radians().cos().max(0.01);
        for (t, tile) in tiles.iter().enumerate() {
            let [w, s, e, n] = tile.bbox.map(f64::from);
            if !hit[t] && lng7 >= w - dlng && lng7 <= e + dlng && lat7 >= s - dlat && lat7 <= n + dlat {
                hit[t] = true;
                left -= 1;
            }
        }
    }
    (0..tiles.len()).filter(|&t| hit[t]).collect()
}

/// The subset of `tiles` whose geometry is not loaded yet.
#[must_use]
pub fn missing_geometry(g: &Graph, tiles: &[usize]) -> Vec<usize> {
    tiles.iter().copied().filter(|&t| !g.geometry_loaded(t)).collect()
}

#[derive(Debug, Clone)]
struct TileGrid {
    grid: Grid,
    /// What the grid was built from: it is stale when either changes.
    geometry: bool,
    tile_loaded: bool,
}

/// One snap grid per tile, built on demand for the tiles a track touches.
#[derive(Debug, Clone, Default)]
pub struct TileGrids {
    build_id: String,
    cell_m: f64,
    grids: Vec<Option<TileGrid>>,
}

impl TileGrids {
    /// An empty set for graph `g` (it stays valid for that graph's build, with tiles and geometry
    /// loaded later: [`TileGrids::ensure`] refreshes what changed).
    #[must_use]
    pub fn new(g: &Graph) -> TileGrids {
        TileGrids::with_cell(g, DEFAULT_CELL_M)
    }

    #[must_use]
    pub fn with_cell(g: &Graph, cell_m: f64) -> TileGrids {
        TileGrids {
            build_id: g.info().build_id.clone(),
            cell_m,
            grids: vec![None; g.info().tiles.len()],
        }
    }

    /// Builds the grids of `tiles` that are missing or stale (their geometry, or the graph tile,
    /// was loaded since). A graph of another build drops everything first.
    pub fn ensure(&mut self, g: &Graph, tiles: &[usize]) {
        if self.build_id != g.info().build_id || self.grids.len() != g.info().tiles.len() {
            *self = TileGrids::with_cell(g, self.cell_m);
        }
        for t in tiles
            .iter()
            .copied()
            .filter(|&t| t < self.grids.len())
            .collect::<Vec<_>>()
        {
            let (geometry, tile_loaded) = (g.geometry_loaded(t), g.tile_loaded(t));
            let fresh = self.grids[t]
                .as_ref()
                .is_some_and(|x| x.geometry == geometry && x.tile_loaded == tile_loaded);
            if !fresh {
                self.grids[t] = Some(TileGrid {
                    grid: Grid::build_tile(g, self.cell_m, t),
                    geometry,
                    tile_loaded,
                });
            }
        }
    }

    /// How many tiles have a grid.
    #[must_use]
    pub fn built(&self) -> usize {
        self.grids.iter().flatten().count()
    }

    /// Whether tile `t` has a grid.
    #[must_use]
    pub fn has(&self, t: usize) -> bool {
        self.grids.get(t).is_some_and(Option::is_some)
    }

    #[must_use]
    pub fn heap_bytes(&self) -> usize {
        self.grids.iter().flatten().map(|x| x.grid.heap_bytes()).sum()
    }

    /// The up to `max_results` nearest edges within `radius_m`, nearest first, among the tiles that
    /// have a grid (see [`Grid::snap_more`]). `out` is cleared first.
    pub fn snap_into(&self, g: &Graph, at: LngLat, radius_m: f64, max_results: usize, out: &mut Vec<Snap>) {
        out.clear();
        let (lng7, lat7) = (at.lng * 1e7, at.lat * 1e7);
        let dlat = radius_m / M_PER_E7;
        let dlng = dlat / at.lat.to_radians().cos().max(0.01);
        for x in self.grids.iter().flatten() {
            let [w, s, e, n] = x.grid.bbox().map(f64::from);
            if lng7 >= w - dlng && lng7 <= e + dlng && lat7 >= s - dlat && lat7 <= n + dlat {
                x.grid.snap_more(g, at, radius_m, max_results, out);
            }
        }
    }
}
