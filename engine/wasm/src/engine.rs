//! The engine object behind the wasm face, in plain Rust (errors are strings, JSON is text), so it
//! is tested natively; `lib.rs` only maps it onto wasm-bindgen.
//!
//! Life cycle: [`Engine::new`] reads the index, [`Engine::add_tile`] takes the graph tiles (any
//! order), [`Engine::finish`] builds the [`Planner`] (adjacency, snapping grid, edge classes).
//! Geometry tiles go in before or after `finish` ([`Engine::add_geometry`]); the snapping grid
//! follows the geometry that was loaded at `finish`.

use kompass_core::graph::arc_edge;
use kompass_core::matching::{Matcher, TileGrids, missing_geometry};
use kompass_core::route::ErrorCode;
use kompass_core::{
    DiffRequest, Graph, GraphLoader, LngLat, PersonalLayer, Planner, Profile, RouteError, RouteRequest,
};
use serde::{Deserialize, Serialize};

enum State {
    Loading(Box<GraphLoader>),
    Ready(Box<Planner>),
    /// Only while `finish` swaps the two.
    Empty,
}

/// One region's engine: the graph while it loads, then the planner and the matcher.
pub struct Engine {
    state: State,
    build_id: String,
    tiles: Vec<(u32, u32)>,
    matcher: Matcher,
    grids: Option<TileGrids>,
}

/// What `route` answers: the result (with the tiles whose geometry the route crosses but which
/// are not loaded) or the engine's error.
#[derive(Serialize)]
#[serde(untagged)]
enum RouteOutcome<'a> {
    Ok {
        result: &'a kompass_core::RouteResult,
        #[serde(rename = "missingGeometry")]
        missing_geometry: Vec<usize>,
    },
    Err {
        error: &'a RouteError,
    },
}

#[derive(Deserialize)]
struct ExplainRequest {
    profile: Profile,
    arcs: Vec<u32>,
}

/// A map-matched ride, as plain arrays (`docs/matching.md`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MatchOutput {
    pub arcs: Vec<u32>,
    pub coverage: Vec<u8>,
    pub first_point: Vec<u32>,
    /// Per unmatched stretch: first point, last point, length in metres.
    pub unmatched: Vec<f64>,
    pub track_m: f64,
    pub matched_m: f64,
    pub path_m: f64,
    pub breaks: u32,
}

/// Heap bytes the engine holds, by part.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeapStats {
    pub graph: usize,
    pub planner: usize,
    pub snap_grid: usize,
    pub match_grids: usize,
    pub matcher: usize,
}

fn invalid(message: String) -> RouteError {
    RouteError {
        code: ErrorCode::InvalidRequest,
        message,
        waypoint: None,
        leg: None,
    }
}

fn to_json<T: Serialize>(value: &T) -> String {
    // the API types serialise without failing (no maps with non-string keys, no NaN keys)
    serde_json::to_string(value).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
}

impl Engine {
    /// Reads the graph index (build id, counts, the tile table) and allocates the graph.
    pub fn new(index: &[u8]) -> Result<Engine, String> {
        let loader = GraphLoader::new(index).map_err(|e| e.to_string())?;
        let info = loader.info();
        let build_id = info.build_id.clone();
        let tiles = info.tiles.iter().map(|t| (t.x, t.y)).collect();
        Ok(Engine {
            state: State::Loading(Box::new(loader)),
            build_id,
            tiles,
            matcher: Matcher::default(),
            grids: None,
        })
    }

    #[must_use]
    pub fn build_id(&self) -> &str {
        &self.build_id
    }

    /// The tiles in index order, as `[x, y]`: the tile numbers the other calls use.
    #[must_use]
    pub fn tiles(&self) -> &[(u32, u32)] {
        &self.tiles
    }

    #[must_use]
    pub fn ready(&self) -> bool {
        matches!(self.state, State::Ready(_))
    }

    fn graph(&self) -> Option<&Graph> {
        match &self.state {
            State::Ready(p) => Some(p.graph()),
            _ => None,
        }
    }

    fn planner(&mut self) -> Result<&mut Planner, String> {
        match &mut self.state {
            State::Ready(p) => Ok(p),
            _ => Err("the graph is still loading".into()),
        }
    }

    /// Adds a graph tile (before `finish`); returns its tile number.
    pub fn add_tile(&mut self, bytes: &[u8]) -> Result<usize, String> {
        match &mut self.state {
            State::Loading(l) => l.add_tile(bytes).map_err(|e| e.to_string()),
            _ => Err("graph tiles go in before finish".into()),
        }
    }

    /// Adds a geometry tile (any time); returns its tile number.
    pub fn add_geometry(&mut self, bytes: &[u8]) -> Result<usize, String> {
        match &mut self.state {
            State::Loading(l) => l.add_geometry(bytes).map_err(|e| e.to_string()),
            State::Ready(p) => p.add_geometry(bytes).map_err(|e| e.to_string()),
            State::Empty => Err("the engine is broken".into()),
        }
    }

    #[must_use]
    pub fn geometry_loaded(&self, tile: usize) -> bool {
        match &self.state {
            State::Loading(l) => l.info().tiles.get(tile).is_some() && l.geometry_loaded(tile),
            State::Ready(p) => tile < self.tiles.len() && p.graph().geometry_loaded(tile),
            State::Empty => false,
        }
    }

    /// Builds the adjacency and the planner. The graph tiles not added stay missing (their
    /// edges unreachable); the snapping grid follows the geometry loaded now.
    pub fn finish(&mut self) -> Result<(), String> {
        match std::mem::replace(&mut self.state, State::Empty) {
            State::Loading(l) => {
                let graph = l.finish();
                self.grids = Some(TileGrids::new(&graph));
                self.state = State::Ready(Box::new(Planner::new(graph)));
                Ok(())
            }
            other => {
                self.state = other;
                Err("finish was called twice".into())
            }
        }
    }

    /// The graph tiles not loaded (their edges are not in the adjacency).
    #[must_use]
    pub fn missing_tiles(&self) -> Vec<usize> {
        match &self.state {
            State::Loading(l) => l.missing_tiles(),
            State::Ready(p) => (0..self.tiles.len())
                .filter(|&t| !p.graph().tile_loaded(t))
                .collect(),
            State::Empty => Vec::new(),
        }
    }

    /// `route`: a [`RouteRequest`] as JSON → `{ result, missingGeometry }` or `{ error }`.
    pub fn route(&mut self, request: &str) -> String {
        let req: RouteRequest = match serde_json::from_str(request) {
            Ok(r) => r,
            Err(e) => {
                return to_json(&RouteOutcome::Err {
                    error: &invalid(format!("route request: {e}")),
                });
            }
        };
        let planner = match self.planner() {
            Ok(p) => p,
            Err(e) => return to_json(&RouteOutcome::Err { error: &invalid(e) }),
        };
        match planner.route(&req) {
            Ok(result) => {
                let g = planner.graph();
                let mut missing: Vec<usize> = result
                    .arcs
                    .iter()
                    .filter_map(|&a| g.info().tile_of_edge(arc_edge(a)))
                    .filter(|&t| !g.geometry_loaded(t))
                    .collect();
                missing.sort_unstable();
                missing.dedup();
                to_json(&RouteOutcome::Ok {
                    result: &result,
                    missing_geometry: missing,
                })
            }
            Err(error) => to_json(&RouteOutcome::Err { error: &error }),
        }
    }

    /// Compiles a profile ahead of the first route with it (JSON).
    pub fn prepare(&mut self, profile: &str) -> Result<(), String> {
        let p: Profile = serde_json::from_str(profile).map_err(|e| format!("profile: {e}"))?;
        self.planner()?.prepare(&p).map_err(|e| e.message)
    }

    /// `diff`: a [`DiffRequest`] as JSON → a `RouteDiff` as JSON.
    pub fn diff(&mut self, request: &str) -> Result<String, String> {
        let req: DiffRequest = serde_json::from_str(request).map_err(|e| format!("diff request: {e}"))?;
        Ok(to_json(&self.planner()?.diff(&req)))
    }

    /// `explain`: `{ profile, arcs }` as JSON → one `ArcExplanation` per arc, as JSON.
    pub fn explain(&mut self, request: &str) -> Result<String, String> {
        let req: ExplainRequest =
            serde_json::from_str(request).map_err(|e| format!("explain request: {e}"))?;
        let out = self
            .planner()?
            .explain(&req.profile, &req.arcs)
            .map_err(|e| e.message)?;
        Ok(to_json(&out))
    }

    /// The compiled cost per arc of a profile (JSON); `f32::INFINITY` is excluded.
    pub fn arc_costs(&mut self, profile: &str) -> Result<Vec<f32>, String> {
        let p: Profile = serde_json::from_str(profile).map_err(|e| format!("profile: {e}"))?;
        let (costs, _) = self.planner()?.arc_costs(&p).map_err(|e| e.message)?;
        Ok(costs.to_vec())
    }

    /// The catalogue with this region's coverage (JSON).
    pub fn catalogue(&mut self) -> Result<String, String> {
        let p = self.planner()?;
        Ok(to_json(&kompass_core::catalogue::catalogue_for(
            p.graph(),
            p.personal(),
        )))
    }

    /// Sets the personal layer (one entry per edge) or clears it (`None`).
    pub fn set_personal(&mut self, layer: Option<PersonalLayer>) -> Result<(), String> {
        self.planner()?.set_personal(layer).map_err(|e| e.message)
    }

    /// The nearest way to a point within `radius_m` (any way: limits are the route's business), as
    /// JSON `{ edge, fraction, distanceM, lon, lat }` or `null`.
    pub fn snap(&mut self, lon: f64, lat: f64, radius_m: f64) -> Result<String, String> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Hit {
            edge: u32,
            fraction: f64,
            distance_m: f64,
            lon: f64,
            lat: f64,
        }
        let p = self.planner()?;
        let hit = p
            .grid()
            .snap(p.graph(), LngLat { lng: lon, lat }, radius_m, 1)
            .first()
            .map(|s| Hit {
                edge: s.edge,
                fraction: s.fraction,
                distance_m: s.distance_m,
                lon: s.point.lng,
                lat: s.point.lat,
            });
        Ok(to_json(&hit))
    }

    /// The tiles a track can touch whose geometry is not loaded: fetch and add them before
    /// [`Engine::match_ride`] (it falls back to straight segments where geometry is missing).
    pub fn match_tiles(&mut self, lat: &[f64], lon: &[f64]) -> Result<Vec<usize>, String> {
        let g = self.graph().ok_or("the graph is still loading")?;
        let tiles = self.matcher.tiles_needed(g, lat, lon);
        Ok(missing_geometry(g, &tiles))
    }

    /// Map-matches one ride (degrees, one entry per point).
    pub fn match_ride(&mut self, lat: &[f64], lon: &[f64]) -> Result<MatchOutput, String> {
        if lat.len() != lon.len() {
            return Err("lat and lon differ in length".into());
        }
        let State::Ready(planner) = &self.state else {
            return Err("the graph is still loading".into());
        };
        let g = planner.graph();
        let grids = self.grids.get_or_insert_with(|| TileGrids::new(g));
        let r = self.matcher.match_arrays(g, grids, lat, lon);
        Ok(MatchOutput {
            arcs: r.arcs,
            coverage: r.coverage,
            first_point: r.first_point,
            unmatched: r
                .unmatched
                .iter()
                .flat_map(|u| [f64::from(u.first_point), f64::from(u.last_point), u.length_m])
                .collect(),
            track_m: r.track_m,
            matched_m: r.matched_m,
            path_m: r.path_m,
            breaks: r.breaks,
        })
    }

    /// The summed length (metres) of the given edges, each counted once however often it is listed;
    /// ids beyond the graph are ignored. The explored map's "km of ways ridden".
    pub fn edges_length_m(&self, edges: &[u32]) -> Result<f64, String> {
        let g = self.graph().ok_or("the graph is still loading")?;
        let count = g.edge_count();
        let mut seen = vec![false; count];
        let mut sum = 0.0;
        for &e in edges {
            let i = e as usize;
            if i < count && !seen[i] {
                seen[i] = true;
                sum += f64::from(g.length_m(e));
            }
        }
        Ok(sum)
    }

    /// Heap bytes held, by part (the wasm memory itself is measured in JS).
    #[must_use]
    pub fn heap(&self) -> HeapStats {
        let mut h = HeapStats {
            matcher: self.matcher.heap_bytes(),
            match_grids: self.grids.as_ref().map_or(0, TileGrids::heap_bytes),
            ..HeapStats::default()
        };
        if let State::Ready(p) = &self.state {
            h.graph = p.graph().heap_bytes();
            h.planner = p.state_bytes();
            h.snap_grid = p.grid().heap_bytes();
        }
        h
    }

    /// Counts for the UI and the bench page (JSON): nodes, edges, tiles, geometry tiles loaded.
    #[must_use]
    pub fn info(&self) -> String {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Info<'a> {
            build_id: &'a str,
            nodes: usize,
            edges: usize,
            tiles: usize,
            geometry_tiles: usize,
            missing_tiles: usize,
            /// every edge's length, metres: what "share of the network explored" divides by
            network_m: f64,
            heap: HeapStats,
        }
        let (nodes, edges) = self.graph().map_or((0, 0), |g| (g.node_count(), g.edge_count()));
        let network_m = self.graph().map_or(0.0, |g| {
            let count = u32::try_from(g.edge_count()).unwrap_or(u32::MAX);
            (0..count).map(|e| f64::from(g.length_m(e))).sum()
        });
        to_json(&Info {
            build_id: &self.build_id,
            nodes,
            edges,
            tiles: self.tiles.len(),
            geometry_tiles: (0..self.tiles.len()).filter(|&t| self.geometry_loaded(t)).count(),
            missing_tiles: self.missing_tiles().len(),
            network_m,
            heap: self.heap(),
        })
    }

    /// `n` seeded random node pairs whose straight-line distance is `min_km..max_km`, as
    /// `[lon, lat, lon, lat]` per pair (fewer if the region is too small). For the bench page:
    /// generated on the device, never stored.
    pub fn bench_pairs(&self, seed: u32, min_km: f64, max_km: f64, n: usize) -> Result<Vec<f64>, String> {
        let g = self.graph().ok_or("the graph is still loading")?;
        let nodes = g.node_count() as u64;
        if nodes == 0 {
            return Ok(Vec::new());
        }
        let mut rng = Rng(u64::from(seed) | 1);
        let mut out = Vec::with_capacity(n * 4);
        let mut tries = 0;
        while out.len() < n * 4 && tries < n * 4000 {
            tries += 1;
            #[allow(clippy::cast_possible_truncation, reason = "below the node count, a u32")]
            let (a, b) = ((rng.next() % nodes) as u32, (rng.next() % nodes) as u32);
            let d = g.node_distance_m(a, b) / 1000.0;
            if d < min_km || d > max_km {
                continue;
            }
            let (pa, pb) = (g.node(a), g.node(b));
            out.extend([pa.lng, pa.lat, pb.lng, pb.lat]);
        }
        Ok(out)
    }
}

/// A deterministic xorshift (the bench pairs).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

/// The shipped presets (JSON list).
#[must_use]
pub fn presets_json() -> String {
    to_json(&kompass_core::presets())
}

/// The catalogue without a region's coverage (JSON).
#[must_use]
pub fn catalogue_json() -> String {
    to_json(&kompass_core::catalogue())
}

#[cfg(test)]
#[allow(
    clippy::cast_possible_truncation,
    clippy::assert_is_empty,
    reason = "tiny test graphs; plain asserts read best"
)]
mod tests {
    use kompass_core::assemble::write_files;
    use kompass_core::attrs::EdgeAttrs;
    use kompass_core::testing::grid;
    use serde_json::Value;

    use super::*;

    /// A 4 × 4 street grid spread over several tiles at z14, as its files.
    fn files() -> kompass_core::assemble::GraphFiles {
        let built = grid(4, 4, 800.0).zoom(14).build_id("wasm-test").build();
        write_files(&built.graph)
    }

    fn loaded(geometry: bool) -> Engine {
        let f = files();
        let mut e = Engine::new(&f.index).unwrap();
        for t in &f.tiles {
            e.add_tile(&t.graph).unwrap();
            if geometry {
                e.add_geometry(&t.geometry).unwrap();
            }
        }
        e.finish().unwrap();
        e
    }

    fn request(e: &Engine, profile: &str) -> String {
        let g = e.graph().unwrap();
        let (a, b) = (g.node(0), g.node(g.node_count() as u32 - 1));
        serde_json::json!({
            "waypoints": [{ "lon": a.lng, "lat": a.lat }, { "lon": b.lng, "lat": b.lat }],
            "profile": serde_json::from_str::<Value>(profile).unwrap(),
        })
        .to_string()
    }

    fn preset(id: &str) -> String {
        serde_json::to_string(&kompass_core::preset(id).unwrap().profile).unwrap()
    }

    #[test]
    fn loads_then_routes() {
        let mut e = loaded(true);
        assert_eq!(e.build_id(), "wasm-test");
        assert!(e.tiles().len() > 1, "the test graph spans tiles");
        assert!(e.missing_tiles().is_empty());
        let out: Value = serde_json::from_str(&e.route(&request(&e, &preset("gravel_explorer")))).unwrap();
        assert!(
            out["result"]["summary"]["distance_m"].as_f64().unwrap() > 1000.0,
            "{out}"
        );
        assert_eq!(out["missingGeometry"], serde_json::json!([]));
        let info: Value = serde_json::from_str(&e.info()).unwrap();
        assert_eq!(info["geometryTiles"].as_u64().unwrap() as usize, e.tiles().len());
        assert!(info["heap"]["graph"].as_u64().unwrap() > 0);
        // the network's length is the sum of the edges; listing an edge twice counts it once
        let network = info["networkM"].as_f64().unwrap();
        let edges = info["edges"].as_u64().unwrap() as u32;
        assert!(network > 1000.0);
        let all: Vec<u32> = (0..edges).collect();
        assert!((e.edges_length_m(&all).unwrap() - network).abs() < 1e-6 * network);
        let twice: Vec<u32> = [0, 0, 1, 1, edges + 5].into();
        assert!((e.edges_length_m(&twice).unwrap() - e.edges_length_m(&[0, 1]).unwrap()).abs() < 1e-9);
        assert!(e.edges_length_m(&[]).unwrap().abs() < f64::EPSILON);
    }

    #[test]
    fn lazy_geometry_names_the_missing_tiles_and_takes_them_later() {
        let f = files();
        let mut e = loaded(false);
        let req = request(&e, &preset("gravel_explorer"));
        let out: Value = serde_json::from_str(&e.route(&req)).unwrap();
        let missing: Vec<usize> = serde_json::from_value(out["missingGeometry"].clone()).unwrap();
        assert!(!missing.is_empty());
        for &t in &missing {
            assert_eq!(e.add_geometry(&f.tiles[t].geometry).unwrap(), t);
            assert!(e.geometry_loaded(t));
        }
        let again: Value = serde_json::from_str(&e.route(&req)).unwrap();
        assert_eq!(again["missingGeometry"], serde_json::json!([]));
        assert_eq!(
            again["result"]["arcs"], out["result"]["arcs"],
            "geometry never changes the route"
        );
    }

    #[test]
    fn errors_are_values_not_panics() {
        let mut e = loaded(true);
        let bad: Value = serde_json::from_str(&e.route("{")).unwrap();
        assert_eq!(bad["error"]["code"], "invalid_request");
        let far = serde_json::json!({
            "waypoints": [{ "lon": 50.0, "lat": 50.0 }, { "lon": 50.1, "lat": 50.0 }],
            "profile": serde_json::from_str::<Value>(&preset("paved_quiet")).unwrap(),
        });
        let out: Value = serde_json::from_str(&e.route(&far.to_string())).unwrap();
        assert_eq!(out["error"]["code"], "no_way_near");
        assert!(e.prepare("{\"weights\":{\"nope\":1}}").is_err());
        assert!(e.finish().is_err());
        let f = files();
        assert!(
            e.add_tile(&f.tiles[0].graph).is_err(),
            "tiles go in before finish"
        );
        assert!(Engine::new(b"not a graph").is_err());
    }

    #[test]
    fn routing_waits_for_finish() {
        let f = files();
        let mut e = Engine::new(&f.index).unwrap();
        assert!(!e.ready());
        let out: Value = serde_json::from_str(&e.route("{\"waypoints\":[],\"profile\":{}}")).unwrap();
        assert!(out["error"]["message"].as_str().unwrap().contains("loading"));
        assert_eq!(e.missing_tiles().len(), f.tiles.len());
    }

    #[test]
    fn diff_explain_costs_catalogue_snap() {
        let mut e = loaded(true);
        let out: Value = serde_json::from_str(&e.route(&request(&e, &preset("gravel_explorer")))).unwrap();
        let arcs = out["result"]["arcs"].clone();
        let diff: Value = serde_json::from_str(
            &e.diff(&serde_json::json!({ "a": arcs, "b": arcs }).to_string())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(diff["stretches"], serde_json::json!([]));
        let explain = serde_json::json!({
            "profile": serde_json::from_str::<Value>(&preset("gravel_explorer")).unwrap(),
            "arcs": [arcs[0]],
        });
        let x: Value = serde_json::from_str(&e.explain(&explain.to_string()).unwrap()).unwrap();
        assert_eq!(x.as_array().unwrap().len(), 1);
        let costs = e.arc_costs(&preset("paved_quiet")).unwrap();
        assert_eq!(costs.len(), e.graph().unwrap().arc_count());
        let c: Value = serde_json::from_str(&e.catalogue().unwrap()).unwrap();
        assert!(c["preferences"].as_array().is_some_and(|p| !p.is_empty()));
        let n = e.graph().unwrap().node(0);
        let hit: Value = serde_json::from_str(&e.snap(n.lng, n.lat, 50.0).unwrap()).unwrap();
        assert!(hit["distanceM"].as_f64().unwrap() < 1.0);
        assert_eq!(e.snap(50.0, 50.0, 50.0).unwrap(), "null");
    }

    #[test]
    fn personal_layer_must_fit() {
        let mut e = loaded(true);
        let edges = e.graph().unwrap().edge_count();
        assert!(e.set_personal(Some(PersonalLayer::empty(edges, 1))).is_ok());
        assert!(e.set_personal(Some(PersonalLayer::empty(edges + 1, 1))).is_err());
        assert!(e.set_personal(None).is_ok());
    }

    #[test]
    fn matches_a_ride_along_the_streets() {
        let f = files();
        let mut e = loaded(false);
        // along the bottom row of the grid, a point every ~50 m
        let g = e.graph().unwrap();
        let (a, b) = (g.node(0), g.node(3));
        let (lat, lon): (Vec<f64>, Vec<f64>) = (0..=48)
            .map(|i| {
                let t = f64::from(i) / 48.0;
                (a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t)
            })
            .unzip();
        let tiles = e.match_tiles(&lat, &lon).unwrap();
        assert!(!tiles.is_empty());
        for &t in &tiles {
            e.add_geometry(&f.tiles[t].geometry).unwrap();
        }
        assert!(e.match_tiles(&lat, &lon).unwrap().is_empty());
        let m = e.match_ride(&lat, &lon).unwrap();
        assert!(!m.arcs.is_empty());
        assert_eq!(m.arcs.len(), m.coverage.len());
        assert!(m.matched_m > 0.9 * m.track_m, "{m:?}");
        assert!(e.heap().match_grids > 0);
        assert!(e.match_ride(&lat, &lon[1..]).is_err());
    }

    #[test]
    fn bench_pairs_are_seeded_and_in_range() {
        let e = loaded(true);
        let a = e.bench_pairs(7, 1.0, 3.0, 5).unwrap();
        assert_eq!(a, e.bench_pairs(7, 1.0, 3.0, 5).unwrap());
        assert_eq!(a.len(), 20);
        for p in a.chunks(4) {
            let d =
                kompass_core::haversine_m(LngLat { lng: p[0], lat: p[1] }, LngLat { lng: p[2], lat: p[3] });
            assert!((1000.0..=3000.0).contains(&d));
        }
        assert!(e.bench_pairs(7, 500.0, 600.0, 5).unwrap().is_empty());
    }

    #[test]
    fn presets_and_catalogue_without_a_graph() {
        let p: Value = serde_json::from_str(&presets_json()).unwrap();
        assert!(p.as_array().unwrap().iter().any(|x| x["id"] == "gravel_explorer"));
        let c: Value = serde_json::from_str(&catalogue_json()).unwrap();
        assert!(c["limits"].is_array());
        let _ = EdgeAttrs::default();
    }
}
