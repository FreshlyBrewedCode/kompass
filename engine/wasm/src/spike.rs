//! Spike #4: the benchmark engine for the browser (graph load, cost compile, route benchmark),
//! driven by `engine/spike/web/`. Times with `performance.now()` inside the worker.
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

use kompass_core::bench::{self, Algo, Rng, Runner, Sample};
use kompass_core::graph::Graph;
use kompass_core::profile::Profile;
use kompass_core::search::Landmarks;
use wasm_bindgen::prelude::{JsError, wasm_bindgen};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance)]
    fn now() -> f64;
}

#[wasm_bindgen]
pub struct SpikeEngine {
    graph: Graph,
    profiles: Vec<Profile>,
    costs: Vec<Vec<f32>>,
    landmarks: Option<Landmarks>,
    runner: Option<Runner>,
    pairs: Vec<Vec<(u32, u32)>>,
}

#[wasm_bindgen]
impl SpikeEngine {
    /// An empty engine; feed it with `append` (a blob or tiles in order), then `finish`.
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> SpikeEngine {
        SpikeEngine {
            graph: Graph::default(),
            profiles: vec![Profile::gravel_explorer(), Profile::paved_quiet()],
            costs: Vec::new(),
            landmarks: None,
            runner: None,
            pairs: Vec::new(),
        }
    }

    pub fn append(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.graph.append(bytes).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Builds the adjacency and the search state; returns the milliseconds that took.
    pub fn finish(&mut self) -> f64 {
        let t = now();
        self.graph.build_adjacency();
        self.runner = Some(Runner::new(&self.graph));
        now() - t
    }

    #[wasm_bindgen(js_name = nodeCount)]
    #[must_use]
    pub fn node_count(&self) -> usize {
        self.graph.node_count()
    }

    /// Compiles profile `i` (0 gravel explorer, 1 paved & quiet); returns milliseconds.
    pub fn compile(&mut self, i: usize) -> f64 {
        while self.costs.len() <= i {
            self.costs.push(Vec::new());
        }
        let t = now();
        self.profiles[i].compile_into(&self.graph, &mut self.costs[i]);
        now() - t
    }

    /// Landmark distances as written by the native bench (`landmarks8.u16`).
    #[wasm_bindgen(js_name = setLandmarks)]
    pub fn set_landmarks(&mut self, bytes: &[u8], count: usize) {
        let dist: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        self.landmarks = Some(Landmarks {
            count,
            nodes: Vec::new(),
            dist,
        });
    }

    /// Generates `n` pairs per bucket (same seed as the native bench); returns milliseconds.
    #[wasm_bindgen(js_name = makePairs)]
    pub fn make_pairs(&mut self, n: usize) -> f64 {
        let t = now();
        let mut rng = Rng(0x4b4f_4d50_4153_5304);
        let cref: Vec<&[f32]> = self.costs.iter().map(Vec::as_slice).collect();
        let nodes = bench::candidates(&self.graph, &cref, &mut rng);
        self.pairs = bench::BUCKETS
            .iter()
            .map(|&(_, lo, hi)| bench::pairs(&self.graph, &nodes, &mut rng, lo, hi, n))
            .collect();
        now() - t
    }

    /// Runs one benchmark cell and returns its stats as JSON. `limit` caps the pairs (0 = all).
    pub fn bench(
        &mut self,
        profile: usize,
        bucket: usize,
        algo: &str,
        limit: usize,
    ) -> Result<String, JsError> {
        let algo = Algo::parse(algo).ok_or_else(|| JsError::new("unknown algo"))?;
        let lm = match algo {
            Algo::Alt | Algo::AltBidi => Some(
                self.landmarks
                    .as_ref()
                    .ok_or_else(|| JsError::new("no landmarks"))?,
            ),
            _ => None,
        };
        let runner = self.runner.as_mut().ok_or_else(|| JsError::new("not finished"))?;
        let pairs = &self.pairs[bucket];
        let pairs = if limit > 0 && limit < pairs.len() {
            &pairs[..limit]
        } else {
            &pairs[..]
        };
        let now_fn = || now();
        let samples: Vec<Sample> = pairs
            .iter()
            .map(|&pq| {
                runner
                    .run(
                        &self.graph,
                        &self.costs[profile],
                        &self.profiles[profile],
                        lm,
                        algo,
                        pq,
                        &now_fn,
                    )
                    .0
            })
            .collect();
        Ok(bench::stats(&samples).json())
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

    /// A busy loop of `n` iterations (to check that CPU throttling reaches the worker).
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

impl Default for SpikeEngine {
    fn default() -> Self {
        Self::new()
    }
}
