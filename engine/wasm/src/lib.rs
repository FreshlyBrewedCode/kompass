//! The engine's browser face: `kompass-core` exposed through wasm-bindgen. Built by
//! `bun run build:wasm` into `web/src/engine/pkg` (generated, gitignored) and loaded in a Web Worker.

use kompass_core::LngLat;
use wasm_bindgen::prelude::wasm_bindgen;

/// The engine version.
#[wasm_bindgen]
#[must_use]
pub fn version() -> String {
    kompass_core::version().to_owned()
}

/// Great-circle distance between two coordinates (degrees) in metres.
#[wasm_bindgen(js_name = distanceM)]
#[must_use]
pub fn distance_m(from_lng: f64, from_lat: f64, to_lng: f64, to_lat: f64) -> f64 {
    kompass_core::haversine_m(
        LngLat {
            lng: from_lng,
            lat: from_lat,
        },
        LngLat {
            lng: to_lng,
            lat: to_lat,
        },
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn exposes_the_core_functions() {
        assert_eq!(super::version(), kompass_core::version());
        assert!((super::distance_m(0.0, 0.0, 0.0, 1.0) - 111_195.08).abs() < 0.1);
    }
}
