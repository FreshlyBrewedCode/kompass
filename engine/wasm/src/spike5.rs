//! Spike #5: the map-matcher in the browser (graph + geometry load, grid, match), driven by
//! `engine/spike5/web/`. Times with `performance.now()` where it runs (worker or main thread).
#![allow(
    clippy::missing_errors_doc,
    clippy::missing_panics_doc,
    reason = "spike #5 bench face"
)]

use kompass_core::matching::{MatchParams, Matcher};
use kompass_core::spatial::{DEFAULT_CELL_M, Grid};
use kompass_core::{Graph, GraphLoader, LngLat};
use wasm_bindgen::prelude::{JsError, wasm_bindgen};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance)]
    fn now() -> f64;
}

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

#[wasm_bindgen]
pub struct MatchEngine {
    loader: Option<GraphLoader>,
    graph: Option<Graph>,
    grid: Option<Grid>,
    matcher: Option<Matcher>,
}

#[wasm_bindgen]
impl MatchEngine {
    /// Starts loading from the graph index (`graph/index.kmpg`).
    #[wasm_bindgen(constructor)]
    pub fn new(index: &[u8]) -> Result<MatchEngine, JsError> {
        Ok(MatchEngine {
            loader: Some(GraphLoader::new(index).map_err(err)?),
            graph: None,
            grid: None,
            matcher: None,
        })
    }

    #[wasm_bindgen(js_name = addTile)]
    pub fn add_tile(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        let l = self.loader.as_mut().ok_or_else(|| err("finished"))?;
        l.add_tile(bytes).map(|_| ()).map_err(err)
    }

    #[wasm_bindgen(js_name = addGeometry)]
    pub fn add_geometry(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        match (&mut self.loader, &mut self.graph) {
            (Some(l), _) => l.add_geometry(bytes).map(|_| ()).map_err(err),
            (None, Some(g)) => g.add_geometry(bytes).map(|_| ()).map_err(err),
            _ => Err(err("no graph")),
        }
    }

    /// Builds the adjacency; returns milliseconds.
    pub fn finish(&mut self) -> Result<f64, JsError> {
        let t = now();
        let l = self.loader.take().ok_or_else(|| err("finished"))?;
        self.graph = Some(l.finish());
        Ok(now() - t)
    }

    /// Builds the snapping grid and the matcher with the given parameters (0 = default); returns ms.
    #[wasm_bindgen(js_name = prepare)]
    pub fn prepare(&mut self, radius_m: f64, sigma_m: f64, beta_m: f64, step_m: f64) -> Result<f64, JsError> {
        let g = self.graph.as_ref().ok_or_else(|| err("not finished"))?;
        let t = now();
        let mut p = MatchParams::default();
        for (v, slot) in [
            (radius_m, &mut p.radius_m),
            (sigma_m, &mut p.sigma_m),
            (beta_m, &mut p.beta_m),
            (step_m, &mut p.min_step_m),
        ] {
            if v > 0.0 {
                *slot = v;
            }
        }
        self.grid = Some(Grid::build(g, DEFAULT_CELL_M));
        self.matcher = Some(Matcher::new(g, p));
        Ok(now() - t)
    }

    /// Matches a track given as interleaved longitude, latitude (degrees); returns JSON counters
    /// (`ms`, `pieces`, `chains`, `track_m`, `matched_m`, `path_m`).
    #[wasm_bindgen(js_name = matchTrack)]
    pub fn match_track(&mut self, lnglat: &[f64]) -> Result<String, JsError> {
        let (Some(graph), Some(grid), Some(matcher)) = (&self.graph, &self.grid, &mut self.matcher) else {
            return Err(err("not prepared"));
        };
        let pts: Vec<LngLat> = lnglat
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&[lng, lat]| LngLat { lng, lat })
            .collect();
        let t = now();
        let r = matcher.match_track(graph, grid, &pts);
        let ms = now() - t;
        let s = r.stats;
        Ok(format!(
            "{{\"ms\":{ms:.2},\"points\":{},\"pieces\":{},\"chains\":{},\"track_m\":{:.0},\"matched_m\":{:.0},\"path_m\":{:.0}}}",
            s.points,
            r.pieces.len(),
            r.chains.len(),
            s.track_m,
            s.matched_m,
            s.path_m
        ))
    }

    /// Bytes of linear memory (the wasm heap).
    #[wasm_bindgen(js_name = memoryBytes)]
    #[must_use]
    pub fn memory_bytes() -> usize {
        #[cfg(target_arch = "wasm32")]
        {
            core::arch::wasm32::memory_size::<0>() * 65536
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            0
        }
    }

    /// A busy loop of `n` iterations (does CPU throttling reach where this runs?).
    #[must_use]
    pub fn spin(n: u32) -> f64 {
        let t = now();
        let mut x = 0u64;
        for i in 0..n {
            x = x
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(u64::from(i));
        }
        std::hint::black_box(x);
        now() - t
    }
}
