//! The Kompass routing engine: graph, cost and queries. Platform-free: the `wasm` and `cli`
//! crates are thin shells around it.

/// The engine version (the crate version), shown by the CLI and the web app.
#[must_use]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Mean Earth radius in metres (IUGG), the sphere the distances are measured on.
pub const EARTH_RADIUS_M: f64 = 6_371_008.8;

/// A WGS84 coordinate in degrees.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LngLat {
    pub lng: f64,
    pub lat: f64,
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
}
