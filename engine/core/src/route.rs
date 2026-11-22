//! The `route` query: waypoints snapped onto allowed ways, one A* per leg over the compiled cost of
//! the leg's profile, joined into one route with its geometry, elevation, totals, a run-length list
//! of segments (surface, way type, ridden), breakdowns and the reasons per segment. Plus
//! [`Planner::diff`]: where two routes differ. Request and result are plain serde data (the JSON of
//! the browser worker, schema in `web/src/engine/generated/`); `docs/routing.md` describes them.

use serde::{Deserialize, Serialize};

#[cfg(feature = "schema")]
use ts_rs::TS;

use crate::attrs::SurfaceClass;
use crate::cost::{self, CostModel, WayKind};
use crate::graph::{ArcId, EdgeId, Graph, NodeId, arc, arc_edge, arc_is_reverse};
use crate::personal::PersonalLayer;
use crate::profile::{PrefId, Profile};
use crate::search::{Exempt, Plane, Query, Search};
use crate::spatial::{DEFAULT_CELL_M, Grid, Snap};
use crate::{LngLat, M_PER_E7};

/// A coordinate in degrees.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct Coord {
    pub lon: f64,
    pub lat: f64,
}

impl Coord {
    fn lnglat(self) -> LngLat {
        LngLat {
            lng: self.lon,
            lat: self.lat,
        }
    }
}

/// A waypoint of the request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct Waypoint {
    pub lon: f64,
    pub lat: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Options of a route request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct RouteOptions {
    /// How far from a waypoint its way may be, metres (1..=5000, default 250).
    pub snap_radius_m: f64,
    /// Whether to return the geometry (coordinates, elevation, distances per vertex).
    pub geometry: bool,
}

impl Default for RouteOptions {
    fn default() -> RouteOptions {
        RouteOptions {
            snap_radius_m: 250.0,
            geometry: true,
        }
    }
}

/// An area of a via or avoid zone (reserved: accepted, not used yet).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub enum Zone {
    Circle { center: Coord, radius_m: f64 },
    Polygon { ring: Vec<Coord> },
}

/// A sketched line to fit the route to (reserved: accepted, not used yet).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct Sketch {
    pub points: Vec<Coord>,
}

/// The `route` request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct RouteRequest {
    /// Two or more: start, vias, end.
    pub waypoints: Vec<Waypoint>,
    pub profile: Profile,
    /// Per leg (waypoint i → i + 1), a profile replacing `profile`; `null` keeps it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leg_profiles: Option<Vec<Option<Profile>>>,
    #[serde(default)]
    pub options: RouteOptions,
    /// Reserved: "somewhere through here" zones.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via_zones: Option<Vec<Zone>>,
    /// Reserved: zones to stay out of.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avoid_zones: Option<Vec<Zone>>,
    /// Reserved: a sketched line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sketch: Option<Sketch>,
}

/// The surface classes of the result (the tag or a safe guess; `unknown` where neither).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub enum SurfaceKind {
    Paved,
    PavedRough,
    Compacted,
    Gravel,
    Soft,
    Other,
    Unknown,
}

impl SurfaceKind {
    pub(crate) fn of(s: SurfaceClass) -> SurfaceKind {
        match s {
            SurfaceClass::PavedSmooth => SurfaceKind::Paved,
            SurfaceClass::PavedRough => SurfaceKind::PavedRough,
            SurfaceClass::Compacted => SurfaceKind::Compacted,
            SurfaceClass::Gravel => SurfaceKind::Gravel,
            SurfaceClass::Soft => SurfaceKind::Soft,
            SurfaceClass::Other => SurfaceKind::Other,
            SurfaceClass::Unknown => SurfaceKind::Unknown,
        }
    }

    /// Not sealed (known to be).
    #[must_use]
    pub fn unpaved(self) -> bool {
        matches!(
            self,
            SurfaceKind::Compacted | SurfaceKind::Gravel | SurfaceKind::Soft | SurfaceKind::Other
        )
    }
}

/// A waypoint as snapped.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct Snapped {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The point on the way.
    pub point: Coord,
    /// Metres from the requested point.
    pub distance_m: f32,
    pub edge: EdgeId,
    /// Position along the edge's geometry, 0..1.
    pub fraction: f32,
    /// Set when no allowed way was within the radius and the route starts or ends on an excluded
    /// one (it only uses that one edge to get away): what excludes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excluded_by: Option<String>,
}

/// One preference's part in a cost: its factor (< 1 made it cheaper, > 1 dearer).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct Reason {
    pub id: PrefId,
    pub factor: f32,
}

/// A stretch of the route with one surface, way type and ridden state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct Segment {
    /// Metres from the route's start.
    pub start_m: f32,
    pub length_m: f32,
    /// `[first, end)` indices into the route's `arcs`.
    pub arcs: [u32; 2],
    /// `[first, last]` indices into the geometry's vertices (empty geometry: 0, 0).
    pub vertices: [u32; 2],
    pub surface: SurfaceKind,
    pub way: WayKind,
    /// Ridden before (only with a personal layer).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ridden: Option<bool>,
    /// The mean cost factor per metre (the clamp included).
    pub factor: f32,
    /// Additive cost (climbing, barriers, steps, …) in metres.
    pub extra_m: f32,
    /// Why this way: the strongest preferences here (length-weighted geometric means), at most 3,
    /// strongest first.
    pub why: Vec<Reason>,
}

/// One leg (waypoint `i` → `i + 1`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct Leg {
    pub distance_m: f32,
    pub ascent_m: f32,
    pub descent_m: f32,
    pub duration_s: f32,
    /// The leg's cost under its profile (metres-equivalent).
    pub cost: f32,
    /// `[first, end)` into `arcs` and `segments`.
    pub arcs: [u32; 2],
    pub segments: [u32; 2],
    /// Nodes the search settled.
    pub settled: u32,
}

/// The totals.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct Summary {
    pub distance_m: f32,
    /// Climbing beyond the noise deadband (see `docs/profile.md`).
    pub ascent_m: f32,
    pub descent_m: f32,
    /// A rough riding time from a speed model by surface and grade.
    pub duration_s: f32,
    pub cost: f32,
    /// Shares of the length, 0..1.
    pub unpaved_share: f32,
    pub unknown_surface_share: f32,
    pub main_road_m: f32,
    /// Never-ridden share (only with a personal layer).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_share: Option<f32>,
}

/// A length per key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct Part<K> {
    pub key: K,
    pub length_m: f32,
    pub share: f32,
}

/// Ridden vs. new.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct RiddenParts {
    pub new_m: f32,
    pub ridden_m: f32,
    pub new_share: f32,
}

/// The breakdowns, longest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct Breakdown {
    pub surface: Vec<Part<SurfaceKind>>,
    pub way: Vec<Part<WayKind>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ridden: Option<RiddenParts>,
    /// Per preference the request's profile names (an explicit 0 too), the length of the route
    /// where it applies at all (membership ≠ 0): what each slider "touches". Catalogue order; 0 m
    /// where it touches nothing.
    #[serde(default)]
    pub touched: Vec<Part<PrefId>>,
}

/// The line: coordinates, and per vertex the distance from the start and the elevation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct RouteGeometry {
    /// `[lon, lat]`, 1e-6 degrees.
    pub coordinates: Vec<[f64; 2]>,
    /// Metres from the start.
    pub distance_m: Vec<f32>,
    /// Metres (from the end nodes of each edge, linear in between); absent where the build has no
    /// elevations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elevation_m: Option<Vec<f32>>,
}

/// The `route` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct RouteResult {
    pub summary: Summary,
    pub breakdown: Breakdown,
    pub waypoints: Vec<Snapped>,
    pub legs: Vec<Leg>,
    pub segments: Vec<Segment>,
    /// The route as arcs (`edge << 1 | reverse`; the first and last are partial).
    pub arcs: Vec<ArcId>,
    /// Per arc, the index of its first vertex in the geometry.
    pub arc_vertex: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geometry: Option<RouteGeometry>,
    /// What to know (ignored reserved fields, waypoints on excluded ways).
    pub notes: Vec<String>,
}

/// What went wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub enum ErrorCode {
    InvalidRequest,
    InvalidProfile,
    /// No way within the snap radius of a waypoint.
    NoWayNear,
    /// No allowed way could be reached from a waypoint (the message names the limit).
    Excluded,
    /// The waypoints are not connected under the profile.
    NoRoute,
}

/// A failed query.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct RouteError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waypoint: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leg: Option<u32>,
}

impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RouteError {}

/// An `invalid_request` error.
pub(crate) fn invalid_request(message: String) -> RouteError {
    err(ErrorCode::InvalidRequest, message)
}

fn err(code: ErrorCode, message: String) -> RouteError {
    RouteError {
        code,
        message,
        waypoint: None,
        leg: None,
    }
}

/// The `diff` request: two routes' arcs (`RouteResult::arcs`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct DiffRequest {
    pub a: Vec<ArcId>,
    pub b: Vec<ArcId>,
}

/// A stretch of one route.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct Span {
    /// `[first, end)` into that route's arcs (empty: the other route detours here).
    pub arcs: [u32; 2],
    /// Metres from that route's start (edges counted in full).
    pub start_m: f32,
    pub length_m: f32,
}

/// Where two routes part and meet again.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct Stretch {
    pub a: Span,
    pub b: Span,
}

/// The `diff` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct RouteDiff {
    pub stretches: Vec<Stretch>,
    /// Length both share (by `a`), and only one has.
    pub shared_m: f32,
    pub a_only_m: f32,
    pub b_only_m: f32,
}

/// A piece of an edge ridden: the arc and the part of its geometry, as fractions from `from` (0)
/// to `to` (1) in riding order.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Piece {
    arc: ArcId,
    t0: f32,
    t1: f32,
    /// The excluded edge a waypoint sits on (ridden anyway).
    exempt: bool,
}

impl Piece {
    fn full(a: ArcId) -> Piece {
        let (t0, t1) = if arc_is_reverse(a) { (1.0, 0.0) } else { (0.0, 1.0) };
        Piece {
            arc: a,
            t0,
            t1,
            exempt: false,
        }
    }

    fn fraction(&self) -> f32 {
        (self.t1 - self.t0).abs()
    }
}

/// A compiled profile.
#[derive(Debug)]
struct Compiled {
    key: String,
    model: CostModel,
    costs: Vec<f32>,
    bound: f32,
}

/// How many compiled profiles stay cached (the current one and, e.g., the base profile's ghost).
pub const COMPILED_CACHE: usize = 2;

/// How far from a waypoint on an excluded way the route may ride excluded ways to get away
/// (metres, at `max_factor` per metre).
pub const EXEMPT_RADIUS_M: f32 = 1000.0;

/// An end that reaches fewer nodes than this over allowed ways is in a pocket (and may get away
/// over excluded ways near it).
pub const POCKET_NODES: usize = 10_000;

/// Candidates looked at when snapping.
const SNAP_CANDIDATES: usize = 48;

/// The engine for one region: graph, snapping grid, a reusable search, the compiled profiles and
/// the optional personal layer. Every query takes plain data and returns plain data.
#[derive(Debug)]
pub struct Planner {
    graph: Graph,
    grid: Grid,
    classes: Option<cost::EdgeClasses>,
    plane: Plane,
    search: Search,
    compiled: Vec<Compiled>,
    personal: Option<PersonalLayer>,
    /// Profiles compiled since creation (for tests and stats).
    pub compiles: usize,
}

/// A compiled profile and what it is read with.
pub(crate) struct CostView<'a> {
    pub graph: &'a Graph,
    pub grid: &'a Grid,
    pub model: &'a CostModel,
    pub costs: &'a [f32],
    pub bound: f32,
    pub personal: Option<&'a PersonalLayer>,
}

struct Endpoint {
    snap: Snap,
    exempt: Option<cost::Exclusion>,
}

impl Planner {
    /// Wraps a loaded graph (builds the snapping grid: ~0.4 s for a 100 km region).
    #[must_use]
    pub fn new(graph: Graph) -> Planner {
        let grid = Grid::build(&graph, DEFAULT_CELL_M);
        let classes = cost::EdgeClasses::build(&graph);
        let plane = Plane::for_graph(&graph);
        let search = Search::new(graph.node_count());
        Planner {
            graph,
            grid,
            classes,
            plane,
            search,
            compiled: Vec::new(),
            personal: None,
            compiles: 0,
        }
    }

    #[must_use]
    pub fn graph(&self) -> &Graph {
        &self.graph
    }

    /// Adds a geometry tile to the graph after the planner was built (the browser loads geometry
    /// lazily). Nothing else depends on it: the route geometry follows it from now on, the
    /// snapping grid keeps the points it was built with (straight segments if it was built
    /// without geometry), so snapping stays consistent.
    pub fn add_geometry(&mut self, bytes: &[u8]) -> Result<usize, crate::format::FormatError> {
        self.graph.add_geometry(bytes)
    }

    #[must_use]
    pub fn grid(&self) -> &Grid {
        &self.grid
    }

    /// Sets (or clears) the personal layer; it must have one entry per edge.
    pub fn set_personal(&mut self, layer: Option<PersonalLayer>) -> Result<(), RouteError> {
        if let Some(l) = &layer
            && !l.fits(self.graph.edge_count())
        {
            return Err(err(
                ErrorCode::InvalidRequest,
                format!(
                    "personal layer has {} entries, the graph {} edges",
                    l.rides.len(),
                    self.graph.edge_count()
                ),
            ));
        }
        self.personal = layer;
        self.compiled.clear();
        Ok(())
    }

    #[must_use]
    pub fn personal(&self) -> Option<&PersonalLayer> {
        self.personal.as_ref()
    }

    /// Heap bytes of the search state, the edge classes and the compiled profiles.
    #[must_use]
    pub fn state_bytes(&self) -> usize {
        self.search.heap_bytes()
            + self.classes.as_ref().map_or(0, cost::EdgeClasses::heap_bytes)
            + self
                .compiled
                .iter()
                .map(|c| c.costs.capacity() * 4)
                .sum::<usize>()
    }

    /// Compiles a profile (or finds it cached); returns its index in the cache.
    fn compile(&mut self, p: &Profile) -> Result<usize, RouteError> {
        let key = p.cost_key();
        if let Some(i) = self.compiled.iter().position(|c| c.key == key) {
            // most recently used last
            let c = self.compiled.remove(i);
            self.compiled.push(c);
            return Ok(self.compiled.len() - 1);
        }
        let model = CostModel::new(p).map_err(|e| err(ErrorCode::InvalidProfile, e.0))?;
        let mut costs = if self.compiled.len() >= COMPILED_CACHE {
            self.compiled.remove(0).costs
        } else {
            Vec::new()
        };
        let bound = match &self.classes {
            Some(cl) => model.compile_classes(&self.graph, cl, self.personal.as_ref(), &mut costs),
            None => model.compile_into(&self.graph, self.personal.as_ref(), &mut costs),
        };
        self.compiles += 1;
        self.compiled.push(Compiled {
            key,
            model,
            costs,
            bound,
        });
        Ok(self.compiled.len() - 1)
    }

    /// Compiles a profile ahead of a route (the first route after a profile change otherwise pays
    /// for it).
    pub fn prepare(&mut self, p: &Profile) -> Result<(), RouteError> {
        self.compile(p).map(|_| ())
    }

    /// The compiled cost per arc of a profile (for a "cost in this profile" map layer) and the
    /// A* bound factor.
    pub fn arc_costs(&mut self, p: &Profile) -> Result<(&[f32], f32), RouteError> {
        let i = self.compile(p)?;
        Ok((&self.compiled[i].costs, self.compiled[i].bound))
    }

    /// A compiled profile with what reads it (the cost debug queries, [`crate::explain`]).
    pub(crate) fn cost_view(&mut self, p: &Profile) -> Result<CostView<'_>, RouteError> {
        let i = self.compile(p)?;
        let c = &self.compiled[i];
        Ok(CostView {
            graph: &self.graph,
            grid: &self.grid,
            model: &c.model,
            costs: &c.costs,
            bound: c.bound,
            personal: self.personal.as_ref(),
        })
    }

    /// Snaps a waypoint: the nearest allowed way within the radius, else the nearest way at all
    /// (exempt, its exclusion reported), else an error.
    fn snap(&self, ci: usize, wp: &Waypoint, radius: f64, i: usize) -> Result<Endpoint, RouteError> {
        let c = &self.compiled[ci];
        let at = LngLat {
            lng: wp.lon,
            lat: wp.lat,
        };
        let cands = self.grid.snap(&self.graph, at, radius, SNAP_CANDIDATES);
        let allowed = |s: &Snap| {
            let e = s.edge as usize;
            c.costs[e * 2].is_finite() || c.costs[e * 2 + 1].is_finite()
        };
        if let Some(s) = cands.iter().find(|s| allowed(s)) {
            return Ok(Endpoint {
                snap: *s,
                exempt: None,
            });
        }
        let Some(s) = cands.first() else {
            return Err(RouteError {
                waypoint: Some(u32::try_from(i).unwrap_or(u32::MAX)),
                ..err(
                    ErrorCode::NoWayNear,
                    format!("waypoint {} has no way within {radius:.0} m", i + 1),
                )
            });
        };
        let why = c
            .model
            .edge_exclusion(&self.graph, s.edge)
            .unwrap_or(cost::Exclusion::Oneway);
        Ok(Endpoint {
            snap: *s,
            exempt: Some(why),
        })
    }

    /// The cost of riding a fraction of an arc from a snapped point (an exempt edge costs
    /// `max_factor` per metre; one-way still holds).
    fn partial(&self, ci: usize, a: ArcId, fraction: f32, exempt: bool) -> f32 {
        if fraction <= 1e-6 {
            return 0.0; // already at the node
        }
        let c = &self.compiled[ci];
        let full = c.costs[a as usize];
        if full.is_finite() {
            return full * fraction;
        }
        if exempt && self.graph.arc_allowed(a) {
            return self.graph.length_m(arc_edge(a)) * c.model.max_factor * fraction;
        }
        f32::INFINITY
    }

    /// Routes a request.
    #[allow(clippy::too_many_lines, reason = "legs, then assembling the result")]
    pub fn route(&mut self, req: &RouteRequest) -> Result<RouteResult, RouteError> {
        let n = req.waypoints.len();
        if n < 2 {
            return Err(err(
                ErrorCode::InvalidRequest,
                "a route needs at least two waypoints".into(),
            ));
        }
        let radius = req.options.snap_radius_m;
        if !(1.0..=5000.0).contains(&radius) {
            return Err(err(
                ErrorCode::InvalidRequest,
                format!("snap_radius_m {radius} is outside 1..5000"),
            ));
        }
        if let Some(lp) = &req.leg_profiles
            && lp.len() != n - 1
        {
            return Err(err(
                ErrorCode::InvalidRequest,
                format!("leg_profiles has {} entries for {} legs", lp.len(), n - 1),
            ));
        }
        if let Some(w) = req
            .waypoints
            .iter()
            .position(|w| !(w.lon.is_finite() && w.lat.is_finite() && w.lat.abs() <= 90.0))
        {
            return Err(err(
                ErrorCode::InvalidRequest,
                format!("waypoint {} is not a coordinate", w + 1),
            ));
        }
        let mut notes = Vec::new();
        for (field, set) in [
            ("via_zones", req.via_zones.is_some()),
            ("avoid_zones", req.avoid_zones.is_some()),
            ("sketch", req.sketch.is_some()),
        ] {
            if set {
                notes.push(format!("{field} is not supported yet and was ignored"));
            }
        }
        let leg_profile = |l: usize| {
            req.leg_profiles
                .as_ref()
                .and_then(|lp| lp[l].as_ref())
                .unwrap_or(&req.profile)
        };
        // compile every profile first (the cache holds two; with more distinct leg profiles the
        // later ones recompile as needed)
        let mut pieces: Vec<Piece> = Vec::new();
        let mut legs_raw: Vec<(usize, usize, f32, u32)> = Vec::new(); // (piece start, end, cost, settled)
        let mut snapped: Vec<Snapped> = Vec::with_capacity(n);
        let mut models: Vec<usize> = Vec::with_capacity(n - 1);
        for l in 0..n - 1 {
            let ci = self.compile(leg_profile(l))?;
            let (wa, wb) = (&req.waypoints[l], &req.waypoints[l + 1]);
            let a = self.snap(ci, wa, radius, l)?;
            let b = self.snap(ci, wb, radius, l + 1)?;
            if l == 0 {
                snapped.push(Self::snapped(wa, &a));
            }
            snapped.push(Self::snapped(wb, &b));
            for (i, ep) in [(l, &a), (l + 1, &b)] {
                if let Some(why) = ep.exempt {
                    let note = format!(
                        "waypoint {} is on a way excluded by {}: the route uses it only to get away",
                        i + 1,
                        why.describe()
                    );
                    if !notes.contains(&note) {
                        notes.push(note);
                    }
                }
            }
            let start = pieces.len();
            let (cost, settled) = self.leg(ci, &a, &b, &mut pieces).map_err(|mut e| {
                e.leg = Some(u32::try_from(l).unwrap_or(u32::MAX));
                e
            })?;
            legs_raw.push((start, pieces.len(), cost, settled));
            models.push(ci);
        }
        let mut result = self.assemble(&pieces, &legs_raw, &models, snapped, notes, req.options.geometry);
        result.breakdown.touched = self.touched(&pieces, &req.profile);
        Ok(result)
    }

    /// The length of the route each preference of `profile` applies to (`breakdown.touched`).
    fn touched(&self, pieces: &[Piece], profile: &Profile) -> Vec<Part<PrefId>> {
        let (g, personal) = (&self.graph, self.personal.as_ref());
        let ids: Vec<PrefId> = profile.weights.keys().copied().collect();
        let mut m = vec![0.0f32; ids.len()];
        for piece in pieces {
            let len = g.length_m(arc_edge(piece.arc)) * piece.fraction();
            cost::touches(g, personal, piece.arc, &ids, |id| {
                if let Some(i) = ids.iter().position(|&x| x == id) {
                    m[i] += len;
                }
            });
        }
        let total: f32 = pieces
            .iter()
            .map(|p| g.length_m(arc_edge(p.arc)) * p.fraction())
            .sum::<f32>()
            .max(1e-6);
        ids.into_iter()
            .zip(m)
            .map(|(key, length_m)| Part {
                key,
                length_m,
                share: length_m / total,
            })
            .collect()
    }

    fn snapped(wp: &Waypoint, ep: &Endpoint) -> Snapped {
        #[allow(clippy::cast_possible_truncation, reason = "metres and fractions")]
        Snapped {
            name: wp.name.clone(),
            point: Coord {
                lon: round6(ep.snap.point.lng),
                lat: round6(ep.snap.point.lat),
            },
            distance_m: ep.snap.distance_m as f32,
            edge: ep.snap.edge,
            fraction: ep.snap.fraction as f32,
            excluded_by: ep.exempt.map(cost::Exclusion::describe),
        }
    }

    /// One leg: A* between two snapped points; appends its pieces.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::too_many_lines,
        clippy::single_match_else,
        reason = "fractions; the labels, the search and the pieces; found or not"
    )]
    fn leg(
        &mut self,
        ci: usize,
        a: &Endpoint,
        b: &Endpoint,
        pieces: &mut Vec<Piece>,
    ) -> Result<(f32, u32), RouteError> {
        let g = &self.graph;
        let (ea, ta) = (a.snap.edge, a.snap.fraction as f32);
        let (eb, tb) = (b.snap.edge, b.snap.fraction as f32);
        let (xa, xb) = (a.exempt.is_some(), b.exempt.is_some());
        // from the point: to `to` along the edge, to `from` against it
        let fwd_a = self.partial(ci, arc(ea, false), 1.0 - ta, xa);
        let bwd_a = self.partial(ci, arc(ea, true), ta, xa);
        let sources = [(g.to(ea), fwd_a), (g.from(ea), bwd_a)];
        // into the point: from `from` along the edge, from `to` against it
        let fwd_b = self.partial(ci, arc(eb, false), tb, xb);
        let bwd_b = self.partial(ci, arc(eb, true), 1.0 - tb, xb);
        let targets = [(g.from(eb), fwd_b), (g.to(eb), bwd_b)];
        // the direct way along one edge
        let mut direct = f32::INFINITY;
        let mut direct_piece = None;
        if ea == eb {
            let rev = tb < ta;
            let p = self.partial(ci, arc(ea, rev), (tb - ta).abs(), xa || xb);
            if p.is_finite() {
                direct = p;
                direct_piece = Some(Piece {
                    arc: arc(ea, rev),
                    t0: ta,
                    t1: tb,
                    exempt: xa || xb,
                });
            }
        }
        let target = LngLat {
            lng: b.snap.point.lng,
            lat: b.snap.point.lat,
        }
        .to_e7();
        let c = &self.compiled[ci];
        // an end in a small pocket the limits cut off may get away over excluded ways (checked up
        // front: a search that fails explores everything it can reach)
        let starts: Vec<NodeId> = sources.iter().filter(|s| s.1.is_finite()).map(|s| s.0).collect();
        let ends: Vec<NodeId> = targets.iter().filter(|t| t.1.is_finite()).map(|t| t.0).collect();
        let pocket_a = !xa
            && self
                .search
                .cut_off(g, &c.costs, &starts, &ends, POCKET_NODES, true);
        let pocket_b = !xb
            && self
                .search
                .cut_off(g, &c.costs, &ends, &starts, POCKET_NODES, false);
        let exempt_points: Vec<(i32, i32)> = [(a, pocket_a), (b, pocket_b)]
            .iter()
            .filter(|(ep, pocket)| ep.exempt.is_some() || *pocket)
            .map(|(ep, _)| ep.snap.point.to_e7())
            .collect();
        let both = [a.snap.point.to_e7(), b.snap.point.to_e7()];
        let mut query = Query {
            costs: &c.costs,
            plane: self.plane,
            bound: c.bound,
            sources: &sources,
            targets: &targets,
            target,
            best: direct,
            exempt: (!exempt_points.is_empty()).then_some(Exempt {
                plane: self.plane,
                points: &exempt_points,
                radius_m: EXEMPT_RADIUS_M,
                max_factor: c.model.max_factor,
            }),
        };
        let mut found = self.search.run(g, &query);
        let mut settled_all = self.search.settled;
        if found.is_none() && direct_piece.is_none() && exempt_points.len() < 2 {
            // a waypoint in a pocket the limits cut off: let both ends get away over excluded ways
            query.exempt = Some(Exempt {
                plane: self.plane,
                points: &both,
                radius_m: EXEMPT_RADIUS_M,
                max_factor: c.model.max_factor,
            });
            found = self.search.run(g, &query);
            settled_all += self.search.settled;
        }
        let settled = u32::try_from(settled_all).unwrap_or(u32::MAX);
        match found {
            Some(f) => {
                // the first piece: from the point to the start node
                let first = if f.start == g.to(ea)
                    && fwd_a.is_finite()
                    && (f.start != g.from(ea) || fwd_a <= bwd_a)
                {
                    Piece {
                        arc: arc(ea, false),
                        t0: ta,
                        t1: 1.0,
                        exempt: xa,
                    }
                } else {
                    Piece {
                        arc: arc(ea, true),
                        t0: ta,
                        t1: 0.0,
                        exempt: xa,
                    }
                };
                let last =
                    if f.end == g.from(eb) && fwd_b.is_finite() && (f.end != g.to(eb) || fwd_b <= bwd_b) {
                        Piece {
                            arc: arc(eb, false),
                            t0: 0.0,
                            t1: tb,
                            exempt: xb,
                        }
                    } else {
                        Piece {
                            arc: arc(eb, true),
                            t0: 1.0,
                            t1: tb,
                            exempt: xb,
                        }
                    };
                // a waypoint on a node rides nothing of its snapped edge
                if first.fraction() > 1e-6 {
                    pieces.push(first);
                }
                pieces.extend(f.arcs.iter().map(|&a| Piece::full(a)));
                if last.fraction() > 1e-6 {
                    pieces.push(last);
                }
                Ok((f.cost, settled))
            }
            None => {
                if let Some(p) = direct_piece {
                    pieces.push(p);
                    return Ok((direct, settled));
                }
                let exempt = a.exempt.or(b.exempt);
                let msg = if let Some(why) = exempt {
                    format!(
                        "no route: a waypoint is on a way excluded by {} and no allowed way can be reached from it",
                        why.describe()
                    )
                } else {
                    "no route between these waypoints under this profile (its limits may cut them apart)"
                        .into()
                };
                let code = if exempt.is_some() {
                    ErrorCode::Excluded
                } else {
                    ErrorCode::NoRoute
                };
                Err(err(code, msg))
            }
        }
    }

    /// Builds the result from the pieces of every leg.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        clippy::too_many_lines,
        reason = "indices fit u32; one pass over the route"
    )]
    fn assemble(
        &self,
        pieces: &[Piece],
        legs_raw: &[(usize, usize, f32, u32)],
        models: &[usize],
        waypoints: Vec<Snapped>,
        notes: Vec<String>,
        with_geometry: bool,
    ) -> RouteResult {
        let g = &self.graph;
        let personal = self.personal.as_ref();
        let mut geo = Geo::default();
        let mut arcs = Vec::with_capacity(pieces.len());
        let mut arc_vertex = Vec::with_capacity(pieces.len());
        let mut segments: Vec<Segment> = Vec::new();
        let mut legs = Vec::with_capacity(legs_raw.len());
        let mut surface_m: Vec<(SurfaceKind, f32)> = Vec::new();
        let mut way_m: Vec<(WayKind, f32)> = Vec::new();
        let (mut new_m, mut ridden_m) = (0.0f32, 0.0f32);
        let mut excluded_m = 0.0f32;
        let mut dist = 0.0f32;
        let (mut tot_up, mut tot_down, mut tot_secs, mut tot_cost) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
        let mut acc = SegAcc::default();
        for (l, &(p0, p1, leg_cost, settled)) in legs_raw.iter().enumerate() {
            let model = &self.compiled[models[l]].model;
            let (leg_start_arc, leg_start_seg, leg_start_m) = (arcs.len(), segments.len(), dist);
            let (mut up, mut down, mut secs) = (0.0f32, 0.0f32, 0.0f32);
            for piece in &pieces[p0..p1] {
                let e = arc_edge(piece.arc);
                let frac = piece.fraction();
                let len = g.length_m(e) * frac;
                let first_vertex = geo.push_piece(g, piece, len, with_geometry);
                arc_vertex.push(first_vertex);
                arcs.push(piece.arc);
                let a_up = cost::arc_ascent_m(g, piece.arc) * frac;
                let a_down = cost::arc_ascent_m(g, piece.arc ^ 1) * frac;
                up += a_up;
                down += a_down;
                secs += cost::arc_seconds(g, piece.arc, frac);
                let surface = SurfaceKind::of(cost::reported_surface(g, e));
                let way = cost::way_kind(g, e);
                let ridden = personal.map(|p| p.rides(e) > 0);
                add_len(&mut surface_m, surface, len);
                add_len(&mut way_m, way, len);
                match ridden {
                    Some(true) => ridden_m += len,
                    Some(false) => new_m += len,
                    None => {}
                }
                let ex = model.explain(g, personal, piece.arc);
                let (factor, extra) = if ex.excluded.is_some() {
                    // ridden near a waypoint on an excluded way, to get away from it
                    excluded_m += len;
                    (model.max_factor, 0.0)
                } else {
                    (ex.factor, (ex.climb_m + ex.penalty_m) * frac)
                };
                let key = (surface, way, ridden);
                if acc.key != Some(key) {
                    acc.flush(&mut segments, arcs.len() - 1, first_vertex);
                    acc.start(key, dist, arcs.len() - 1, first_vertex);
                }
                acc.add(len, factor, extra, &ex.factors);
                dist += len;
            }
            acc.flush(&mut segments, arcs.len(), geo.last_vertex());
            tot_up += up;
            tot_down += down;
            tot_secs += secs;
            tot_cost += leg_cost;
            legs.push(Leg {
                distance_m: dist - leg_start_m,
                ascent_m: up,
                descent_m: down,
                duration_s: secs,
                cost: leg_cost,
                arcs: [leg_start_arc as u32, arcs.len() as u32],
                segments: [leg_start_seg as u32, segments.len() as u32],
                settled,
            });
        }
        let total = dist.max(1e-6);
        let mut notes = notes;
        if excluded_m > 0.0 {
            notes.push(format!(
                "{excluded_m:.0} m of the route are on ways the profile excludes, near a waypoint that lies on one"
            ));
        }
        let sum = |it: &mut dyn Iterator<Item = f32>| it.fold(0.0f32, |a, b| a + b);
        let unpaved = sum(&mut surface_m.iter().filter(|(k, _)| k.unpaved()).map(|(_, m)| *m));
        let unknown = sum(&mut surface_m
            .iter()
            .filter(|(k, _)| *k == SurfaceKind::Unknown)
            .map(|(_, m)| *m));
        let main = sum(&mut way_m
            .iter()
            .filter(|(k, _)| *k == WayKind::MainRoad)
            .map(|(_, m)| *m));
        let ridden = personal.map(|_| RiddenParts {
            new_m,
            ridden_m,
            new_share: new_m / total,
        });
        RouteResult {
            summary: Summary {
                distance_m: dist,
                ascent_m: tot_up,
                descent_m: tot_down,
                duration_s: tot_secs,
                cost: tot_cost,
                unpaved_share: unpaved / total,
                unknown_surface_share: unknown / total,
                main_road_m: main,
                new_share: ridden.as_ref().map(|r| r.new_share),
            },
            breakdown: Breakdown {
                surface: parts(surface_m, total),
                way: parts(way_m, total),
                ridden,
                touched: Vec::new(),
            },
            waypoints,
            legs,
            segments,
            arcs,
            arc_vertex,
            geometry: with_geometry.then(|| geo.finish()),
            notes,
        }
    }

    /// Per arc, the cost explained under a profile (on demand: "why this way" in detail).
    pub fn explain(&mut self, p: &Profile, arcs: &[ArcId]) -> Result<Vec<ArcExplanation>, RouteError> {
        let i = self.compile(p)?;
        let m = &self.compiled[i].model;
        let g = &self.graph;
        if let Some(a) = arcs.iter().find(|&&a| arc_edge(a) as usize >= g.edge_count()) {
            return Err(err(
                ErrorCode::InvalidRequest,
                format!("arc {a} is not in the graph"),
            ));
        }
        Ok(arcs
            .iter()
            .map(|&a| {
                let x = m.explain(g, self.personal.as_ref(), a);
                ArcExplanation {
                    arc: a,
                    length_m: g.length_m(arc_edge(a)),
                    cost: x.cost.is_finite().then_some(x.cost),
                    factor: x.factor,
                    gate: x.gate,
                    climb_m: x.climb_m,
                    penalty_m: x.penalty_m,
                    reasons: x
                        .factors
                        .iter()
                        .filter(|(_, f)| (f - 1.0).abs() > 1e-4)
                        .map(|&(id, factor)| Reason { id, factor })
                        .collect(),
                    excluded_by: x.excluded.map(cost::Exclusion::describe),
                }
            })
            .collect())
    }

    /// Where two routes differ.
    #[must_use]
    pub fn diff(&self, req: &DiffRequest) -> RouteDiff {
        diff(&self.graph, &req.a, &req.b)
    }
}

/// One arc's cost, explained.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct ArcExplanation {
    pub arc: ArcId,
    pub length_m: f32,
    /// Absent when excluded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f32>,
    pub factor: f32,
    /// How much of the gated bonuses counted (0..1).
    pub gate: f32,
    pub climb_m: f32,
    pub penalty_m: f32,
    /// Every preference whose factor is not 1 here.
    pub reasons: Vec<Reason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excluded_by: Option<String>,
}

fn parts<K>(mut v: Vec<(K, f32)>, total: f32) -> Vec<Part<K>> {
    v.sort_by(|a, b| b.1.total_cmp(&a.1));
    v.into_iter()
        .map(|(key, length_m)| Part {
            key,
            length_m,
            share: length_m / total,
        })
        .collect()
}

fn add_len<K: PartialEq + Copy>(v: &mut Vec<(K, f32)>, k: K, len: f32) {
    if let Some(x) = v.iter_mut().find(|x| x.0 == k) {
        x.1 += len;
    } else {
        v.push((k, len));
    }
}

fn round6(v: f64) -> f64 {
    (v * 1e6).round() / 1e6
}

/// The segment being built.
#[derive(Default)]
struct SegAcc {
    key: Option<(SurfaceKind, WayKind, Option<bool>)>,
    start_m: f32,
    arc0: usize,
    vertex0: u32,
    len: f32,
    cost: f32,
    extra: f32,
    /// Σ length × ln(factor) per preference.
    logs: Vec<(PrefId, f32)>,
}

impl SegAcc {
    fn start(&mut self, key: (SurfaceKind, WayKind, Option<bool>), start_m: f32, arc0: usize, vertex0: u32) {
        self.key = Some(key);
        self.start_m = start_m;
        self.arc0 = arc0;
        self.vertex0 = vertex0;
        self.len = 0.0;
        self.cost = 0.0;
        self.extra = 0.0;
        self.logs.clear();
    }

    fn add(&mut self, len: f32, factor: f32, extra: f32, factors: &[(PrefId, f32)]) {
        self.len += len;
        self.cost += len * factor;
        self.extra += extra;
        for &(id, f) in factors {
            let l = len * f.ln();
            if let Some(x) = self.logs.iter_mut().find(|x| x.0 == id) {
                x.1 += l;
            } else {
                self.logs.push((id, l));
            }
        }
    }

    #[allow(clippy::cast_possible_truncation, reason = "indices fit u32")]
    fn flush(&mut self, out: &mut Vec<Segment>, arc_end: usize, vertex1: u32) {
        let Some((surface, way, ridden)) = self.key.take() else {
            return;
        };
        let len = self.len.max(1e-6);
        let mut why: Vec<Reason> = self
            .logs
            .iter()
            .map(|&(id, l)| Reason {
                id,
                factor: (l / len).exp(),
            })
            .filter(|r| (r.factor.ln()).abs() > 0.03)
            .collect();
        why.sort_by(|a, b| b.factor.ln().abs().total_cmp(&a.factor.ln().abs()));
        why.truncate(3);
        out.push(Segment {
            start_m: self.start_m,
            length_m: self.len,
            arcs: [self.arc0 as u32, arc_end as u32],
            vertices: [self.vertex0, vertex1.max(self.vertex0)],
            surface,
            way,
            ridden,
            factor: self.cost / len,
            extra_m: self.extra,
            why,
        });
    }
}

/// The geometry being built.
#[derive(Default)]
struct Geo {
    coords: Vec<[f64; 2]>,
    dist: Vec<f32>,
    ele: Vec<f32>,
    ele_known: bool,
    at_m: f32,
    started: bool,
}

impl Geo {
    fn last_vertex(&self) -> u32 {
        u32::try_from(self.coords.len().saturating_sub(1)).unwrap_or(u32::MAX)
    }

    /// Appends a piece's points (its first point is the previous piece's last); returns the index
    /// of the piece's first vertex.
    #[allow(clippy::cast_possible_truncation, reason = "metres")]
    fn push_piece(&mut self, g: &Graph, p: &Piece, len: f32, on: bool) -> u32 {
        if !on {
            return 0;
        }
        if !self.started {
            self.started = true;
            self.ele_known = true;
        }
        let e = arc_edge(p.arc);
        let pts: Vec<(i32, i32)> = g.edge_points(e).collect();
        // planar cumulative lengths along the geometry (from → to)
        let kx = (f64::from(pts[0].1) * 1e-7).to_radians().cos();
        let mut cum = Vec::with_capacity(pts.len());
        let mut s = 0.0f64;
        cum.push(0.0);
        for w in pts.windows(2) {
            let dx = f64::from(w[1].0 - w[0].0) * kx;
            let dy = f64::from(w[1].1 - w[0].1);
            s += dx.hypot(dy) * M_PER_E7;
            cum.push(s);
        }
        let total = s.max(1e-9);
        let (e0, e1) = (g.node_elevation_m(g.from(e)), g.node_elevation_m(g.to(e)));
        if e0.is_none() || e1.is_none() {
            self.ele_known = false;
        }
        let (e0, e1) = (e0.unwrap_or(0.0), e1.unwrap_or(0.0));
        let point_at = |t: f64| -> [f64; 2] {
            let d = t * total;
            let i = cum.partition_point(|&c| c < d).clamp(1, pts.len() - 1);
            let (a, b) = (pts[i - 1], pts[i]);
            let seg = (cum[i] - cum[i - 1]).max(1e-12);
            let u = ((d - cum[i - 1]) / seg).clamp(0.0, 1.0);
            let lon = f64::from(a.0) + (f64::from(b.0) - f64::from(a.0)) * u;
            let lat = f64::from(a.1) + (f64::from(b.1) - f64::from(a.1)) * u;
            [round6(lon * 1e-7), round6(lat * 1e-7)]
        };
        let (t0, t1) = (f64::from(p.t0), f64::from(p.t1));
        // the interior vertices strictly between t0 and t1, in riding order
        let mut ts: Vec<f64> = vec![t0];
        let inner = cum[1..cum.len() - 1].iter().map(|&c| c / total);
        if t1 >= t0 {
            ts.extend(inner.filter(|&t| t > t0 && t < t1));
        } else {
            let mut v: Vec<f64> = inner.filter(|&t| t < t0 && t > t1).collect();
            v.reverse();
            ts.extend(v);
        }
        ts.push(t1);
        let span = (t1 - t0).abs().max(1e-12);
        let first = if self.coords.is_empty() {
            0
        } else {
            self.coords.len() - 1
        };
        for (k, &t) in ts.iter().enumerate() {
            if k == 0 && !self.coords.is_empty() {
                continue; // shared with the previous piece
            }
            self.coords.push(point_at(t));
            self.dist.push(self.at_m + len * ((t - t0).abs() / span) as f32);
            self.ele.push(e0 + (e1 - e0) * t as f32);
        }
        self.at_m += len;
        u32::try_from(first).unwrap_or(u32::MAX)
    }

    fn finish(self) -> RouteGeometry {
        let ele_known = self.ele_known && !self.ele.is_empty();
        RouteGeometry {
            coordinates: self.coords,
            distance_m: self.dist.iter().map(|d| (d * 10.0).round() / 10.0).collect(),
            elevation_m: ele_known.then(|| self.ele.iter().map(|e| (e * 10.0).round() / 10.0).collect()),
        }
    }
}

/// Where two routes (as arcs) differ: the stretches between the edges they share in the same order
/// (a longest increasing run of shared edges), each with the part of `a` and of `b`.
#[must_use]
#[allow(clippy::cast_possible_truncation, reason = "indices fit u32")]
pub fn diff(g: &Graph, a: &[ArcId], b: &[ArcId]) -> RouteDiff {
    let len = |x: ArcId| {
        if (arc_edge(x) as usize) < g.edge_count() {
            g.length_m(arc_edge(x))
        } else {
            0.0
        }
    };
    let cum = |r: &[ArcId]| {
        let mut c = Vec::with_capacity(r.len() + 1);
        let mut s = 0.0f32;
        c.push(0.0);
        for &x in r {
            s += len(x);
            c.push(s);
        }
        c
    };
    let (ca, cb) = (cum(a), cum(b));
    // positions of b's edges
    let mut pos: std::collections::HashMap<EdgeId, Vec<usize>> = std::collections::HashMap::new();
    for (j, &x) in b.iter().enumerate() {
        pos.entry(arc_edge(x)).or_default().push(j);
    }
    // candidate pairs in order of a; for one i, b's positions descending so at most one is taken
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    for (i, &x) in a.iter().enumerate() {
        if let Some(js) = pos.get(&arc_edge(x)) {
            for &j in js.iter().rev() {
                pairs.push((i, j));
            }
        }
    }
    // longest strictly increasing subsequence of j (patience sorting)
    let mut tails: Vec<usize> = Vec::new(); // index into pairs
    let mut prev: Vec<usize> = vec![usize::MAX; pairs.len()];
    for (k, &(_, j)) in pairs.iter().enumerate() {
        let at = tails.partition_point(|&t| pairs[t].1 < j);
        if at > 0 {
            prev[k] = tails[at - 1];
        }
        if at == tails.len() {
            tails.push(k);
        } else {
            tails[at] = k;
        }
    }
    let mut anchors = Vec::with_capacity(tails.len());
    let mut k = tails.last().copied().unwrap_or(usize::MAX);
    while k != usize::MAX {
        anchors.push(pairs[k]);
        k = prev[k];
    }
    anchors.reverse();
    let span = |c: &[f32], s: usize, e: usize| Span {
        arcs: [s as u32, e as u32],
        start_m: c[s],
        length_m: c[e] - c[s],
    };
    let mut stretches = Vec::new();
    let (mut i0, mut j0) = (0usize, 0usize);
    let mut shared = 0.0f32;
    for &(i, j) in anchors.iter().chain(std::iter::once(&(a.len(), b.len()))) {
        if i > i0 || j > j0 {
            stretches.push(Stretch {
                a: span(&ca, i0, i),
                b: span(&cb, j0, j),
            });
        }
        if i < a.len() {
            shared += len(a[i]);
        }
        (i0, j0) = (i + 1, j + 1);
    }
    let a_only = stretches.iter().map(|s| s.a.length_m).sum();
    let b_only = stretches.iter().map(|s| s.b.length_m).sum();
    RouteDiff {
        stretches,
        shared_m: shared,
        a_only_m: a_only,
        b_only_m: b_only,
    }
}

/// The waypoint coordinate of a request as a [`LngLat`] (for tools).
#[must_use]
pub fn waypoint_lnglat(w: &Waypoint) -> LngLat {
    Coord {
        lon: w.lon,
        lat: w.lat,
    }
    .lnglat()
}
