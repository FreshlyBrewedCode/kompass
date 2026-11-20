//! The engine's browser face: `kompass-core` exposed through wasm-bindgen. Built by
//! `bun run build:wasm` into `web/src/engine/pkg` (generated, gitignored) and loaded in a Web Worker
//! (`web/src/engine/worker.ts`, `docs/engine-web.md`).
//!
//! JSON text across the boundary for the API types (request in, result out: the generated types in
//! `web/src/engine/generated/`), typed arrays for the big numeric payloads (graph files, track
//! points, matched arcs, the personal layer, arc costs). The logic is in [`engine`], plain Rust
//! tested natively; this file only maps it onto wasm-bindgen.

#![allow(
    clippy::missing_errors_doc,
    clippy::many_single_char_names,
    reason = "errors are messages for the worker; short names in the geometry tests"
)]

pub mod engine;

use kompass_core::{LngLat, PersonalLayer};
use wasm_bindgen::prelude::{JsError, wasm_bindgen};

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

/// The shipped presets, JSON (`Preset[]`).
#[wasm_bindgen]
#[must_use]
pub fn presets() -> String {
    engine::presets_json()
}

/// The catalogue without a region's coverage, JSON (`Catalogue`).
#[wasm_bindgen]
#[must_use]
pub fn catalogue() -> String {
    engine::catalogue_json()
}

#[allow(clippy::needless_pass_by_value, reason = "used as map_err(js)")]
fn js(e: String) -> JsError {
    JsError::new(&e)
}

/// One region's engine (see [`engine::Engine`]).
#[wasm_bindgen]
pub struct Engine(engine::Engine);

/// A matched ride (`docs/matching.md`): typed arrays and totals.
#[wasm_bindgen]
pub struct MatchOutput(engine::MatchOutput);

#[wasm_bindgen]
impl MatchOutput {
    /// `edge << 1 | reverse`, in riding order.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn arcs(&self) -> Vec<u32> {
        self.0.arcs.clone()
    }
    /// Per arc: the covered share of the edge × 255.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn coverage(&self) -> Vec<u8> {
        self.0.coverage.clone()
    }
    /// Per arc: the first track point on it.
    #[wasm_bindgen(getter, js_name = firstPoint)]
    #[must_use]
    pub fn first_point(&self) -> Vec<u32> {
        self.0.first_point.clone()
    }
    /// Per unmatched stretch: first point, last point, metres.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn unmatched(&self) -> Vec<f64> {
        self.0.unmatched.clone()
    }
    #[wasm_bindgen(getter, js_name = trackM)]
    #[must_use]
    pub fn track_m(&self) -> f64 {
        self.0.track_m
    }
    #[wasm_bindgen(getter, js_name = matchedM)]
    #[must_use]
    pub fn matched_m(&self) -> f64 {
        self.0.matched_m
    }
    #[wasm_bindgen(getter, js_name = pathM)]
    #[must_use]
    pub fn path_m(&self) -> f64 {
        self.0.path_m
    }
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn breaks(&self) -> u32 {
        self.0.breaks
    }
}

fn tile_number(t: usize) -> u32 {
    u32::try_from(t).unwrap_or(u32::MAX)
}

fn tile_numbers(t: &[usize]) -> Vec<u32> {
    t.iter().copied().map(tile_number).collect()
}

#[wasm_bindgen]
impl Engine {
    /// Reads the graph index.
    #[wasm_bindgen(constructor)]
    pub fn new(index: &[u8]) -> Result<Engine, JsError> {
        engine::Engine::new(index).map(Engine).map_err(js)
    }

    #[wasm_bindgen(getter, js_name = buildId)]
    #[must_use]
    pub fn build_id(&self) -> String {
        self.0.build_id().to_owned()
    }

    /// The tiles in index order, `[x0, y0, x1, y1, …]`.
    #[must_use]
    pub fn tiles(&self) -> Vec<u32> {
        self.0.tiles().iter().flat_map(|&(x, y)| [x, y]).collect()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn ready(&self) -> bool {
        self.0.ready()
    }

    /// Adds a graph tile (before `finish`); returns its tile number.
    #[wasm_bindgen(js_name = addTile)]
    pub fn add_tile(&mut self, bytes: &[u8]) -> Result<u32, JsError> {
        self.0.add_tile(bytes).map(tile_number).map_err(js)
    }

    /// Adds a geometry tile (any time); returns its tile number.
    #[wasm_bindgen(js_name = addGeometry)]
    pub fn add_geometry(&mut self, bytes: &[u8]) -> Result<u32, JsError> {
        self.0.add_geometry(bytes).map(tile_number).map_err(js)
    }

    #[wasm_bindgen(js_name = geometryLoaded)]
    #[must_use]
    pub fn geometry_loaded(&self, tile: u32) -> bool {
        self.0.geometry_loaded(tile as usize)
    }

    /// Builds the adjacency, the snapping grid and the planner.
    pub fn finish(&mut self) -> Result<(), JsError> {
        self.0.finish().map_err(js)
    }

    #[wasm_bindgen(js_name = missingTiles)]
    #[must_use]
    pub fn missing_tiles(&self) -> Vec<u32> {
        tile_numbers(&self.0.missing_tiles())
    }

    /// A `RouteRequest` (JSON) → `{ result, missingGeometry }` or `{ error }` (JSON).
    #[must_use]
    pub fn route(&mut self, request: &str) -> String {
        self.0.route(request)
    }

    pub fn prepare(&mut self, profile: &str) -> Result<(), JsError> {
        self.0.prepare(profile).map_err(js)
    }

    pub fn diff(&mut self, request: &str) -> Result<String, JsError> {
        self.0.diff(request).map_err(js)
    }

    pub fn explain(&mut self, request: &str) -> Result<String, JsError> {
        self.0.explain(request).map_err(js)
    }

    #[wasm_bindgen(js_name = arcCosts)]
    pub fn arc_costs(&mut self, profile: &str) -> Result<Vec<f32>, JsError> {
        self.0.arc_costs(profile).map_err(js)
    }

    /// The catalogue with this region's coverage (JSON).
    #[wasm_bindgen(js_name = regionCatalogue)]
    pub fn region_catalogue(&mut self) -> Result<String, JsError> {
        self.0.catalogue().map_err(js)
    }

    /// The personal layer: rides and last-ridden day per edge, today (days since 1970).
    #[wasm_bindgen(js_name = setPersonal)]
    pub fn set_personal(&mut self, rides: Vec<u16>, last_ridden: Vec<u32>, today: u32) -> Result<(), JsError> {
        self.0
            .set_personal(Some(PersonalLayer {
                rides,
                last_ridden,
                today,
            }))
            .map_err(js)
    }

    #[wasm_bindgen(js_name = clearPersonal)]
    pub fn clear_personal(&mut self) -> Result<(), JsError> {
        self.0.set_personal(None).map_err(js)
    }

    pub fn snap(&mut self, lon: f64, lat: f64, radius_m: f64) -> Result<String, JsError> {
        self.0.snap(lon, lat, radius_m).map_err(js)
    }

    /// The tiles a track needs whose geometry is not loaded.
    #[wasm_bindgen(js_name = matchTiles)]
    pub fn match_tiles(&mut self, lat: &[f64], lon: &[f64]) -> Result<Vec<u32>, JsError> {
        self.0.match_tiles(lat, lon).map(|t| tile_numbers(&t)).map_err(js)
    }

    #[wasm_bindgen(js_name = matchRide)]
    pub fn match_ride(&mut self, lat: &[f64], lon: &[f64]) -> Result<MatchOutput, JsError> {
        self.0.match_ride(lat, lon).map(MatchOutput).map_err(js)
    }

    /// Counts and heap bytes by part (JSON).
    #[must_use]
    pub fn info(&self) -> String {
        self.0.info()
    }

    #[wasm_bindgen(js_name = benchPairs)]
    pub fn bench_pairs(&self, seed: u32, min_km: f64, max_km: f64, n: u32) -> Result<Vec<f64>, JsError> {
        self.0.bench_pairs(seed, min_km, max_km, n as usize).map_err(js)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn exposes_the_core_functions() {
        assert_eq!(super::version(), kompass_core::version());
        assert!((super::distance_m(0.0, 0.0, 0.0, 1.0) - 111_195.08).abs() < 0.1);
        assert!(super::presets().contains("gravel_explorer"));
    }
}
