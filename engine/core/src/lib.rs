//! The Kompass routing engine: graph, cost and queries. Platform-free: the `wasm` and `cli`
//! crates are thin shells around it.
//!
//! - [`graph`]: the routing graph in memory ([`Graph`]), loaded from the tiled binary format
//!   ([`format`], `docs/graph-format.md`) with [`GraphLoader`], with a CSR adjacency built at load.
//! - [`attrs`]: the edge attributes, their enums (the code tables of `edges.parquet`) and how they
//!   are quantised.
//! - [`spatial`]: a uniform grid over the edges and [`spatial::Grid::snap`], the nearest edges to
//!   a point (waypoints, map-matching candidates).
//! - [`assemble`]: building a [`Graph`] from edges in tile order (the compiler and tests use it) and
//!   writing it as files.
//! - [`testing`]: tiny graphs built in code, for tests here and in the other crates.
#![allow(
    clippy::missing_errors_doc,
    clippy::missing_panics_doc,
    clippy::many_single_char_names,
    clippy::struct_excessive_bools,
    reason = "errors are self-describing types; geometry code reads best with x, y, a, b; the edge \
              attributes are a flat record of OSM flags"
)]

pub mod assemble;
pub mod attrs;
pub mod format;
pub mod geometry;
pub mod graph;
pub mod hilbert;
pub mod spatial;
pub mod testing;

pub use graph::{ArcId, EdgeId, Graph, GraphInfo, GraphLoader, NodeId, TileInfo};

/// The engine version (the crate version), shown by the CLI and the web app.
#[must_use]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Mean Earth radius in metres (IUGG), the sphere the distances are measured on.
pub const EARTH_RADIUS_M: f64 = 6_371_008.8;

/// Metres per 1e-7 degree of latitude (and of longitude at the equator).
pub const M_PER_E7: f64 = EARTH_RADIUS_M * std::f64::consts::PI / 180.0 * 1e-7;

/// A WGS84 coordinate in degrees.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LngLat {
    pub lng: f64,
    pub lat: f64,
}

impl LngLat {
    /// From 1e-7 degrees (the graph's fixed-point coordinates).
    #[must_use]
    pub fn from_e7(lng: i32, lat: i32) -> LngLat {
        LngLat {
            lng: f64::from(lng) * 1e-7,
            lat: f64::from(lat) * 1e-7,
        }
    }

    /// As 1e-7 degrees, rounded (saturates outside the i32 range, which no valid coordinate is).
    #[must_use]
    #[allow(
        clippy::cast_possible_truncation,
        reason = "saturating float → int cast is intended"
    )]
    pub fn to_e7(self) -> (i32, i32) {
        ((self.lng * 1e7).round() as i32, (self.lat * 1e7).round() as i32)
    }
}

/// Great-circle distance between two coordinates in metres (haversine on a sphere).
#[must_use]
pub fn haversine_m(a: LngLat, b: LngLat) -> f64 {
    let (lat1, lat2) = (a.lat.to_radians(), b.lat.to_radians());
    let dlat = lat2 - lat1;
    let dlng = (b.lng - a.lng).to_radians();
    let h = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlng / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * h.sqrt().asin()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_the_crate_version() {
        assert_eq!(version(), "0.1.0");
    }

    #[test]
    fn haversine_is_zero_for_the_same_point() {
        let p = LngLat { lng: 13.4, lat: 52.5 };
        assert!(haversine_m(p, p).abs() < 1e-9);
    }

    #[test]
    fn haversine_one_degree_of_latitude() {
        let a = LngLat { lng: 0.0, lat: 0.0 };
        let b = LngLat { lng: 0.0, lat: 1.0 };
        // 2πR / 360
        assert!((haversine_m(a, b) - 111_195.08).abs() < 0.1);
        assert!((M_PER_E7 * 1e7 - 111_195.08).abs() < 0.1);
    }

    #[test]
    fn haversine_is_symmetric() {
        let a = LngLat {
            lng: 8.54,
            lat: 47.37,
        };
        let b = LngLat {
            lng: 13.40,
            lat: 52.52,
        };
        assert!((haversine_m(a, b) - haversine_m(b, a)).abs() < 1e-6);
    }

    #[test]
    fn e7_roundtrip() {
        let p = LngLat {
            lng: -0.123_456_7,
            lat: 0.765_432_1,
        };
        assert_eq!(p.to_e7(), (-1_234_567, 7_654_321));
        let q = LngLat::from_e7(-1_234_567, 7_654_321);
        assert!((q.lng - p.lng).abs() < 1e-12 && (q.lat - p.lat).abs() < 1e-12);
    }
}
