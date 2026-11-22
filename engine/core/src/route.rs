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
use crate::overrides::{self, EdgeOverride, OverrideKind, OverrideUse, Overrides};
use crate::personal::PersonalLayer;
use crate::profile::{BoardRow, PrefId, Profile, Tier};
use crate::search::{Exempt, Overlay, Plane, Query, Search, Source, Target, Turns, UTurn};
use crate::spatial::{DEFAULT_CELL_M, Grid, Snap};
use crate::turns::{Headings, share_between};
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
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS), ts(optional_fields))]
pub struct RouteOptions {
    /// How far from a waypoint its way may be, metres (1..=5000, default 250).
    pub snap_radius_m: f64,
    /// Whether to return the geometry (coordinates, elevation, distances per vertex).
    pub geometry: bool,
    /// Don't ride the same way twice (default on): legs are routed in order, and riding an edge an
    /// earlier leg rode (either direction) or leaving a via back the way it was reached costs
    /// extra. Finite costs: an out-and-back the waypoints ask for still routes.
    pub avoid_reuse: bool,
    /// The costs of `avoid_reuse` (for tools tuning them; absent: the defaults).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reuse_cost: Option<ReuseCost>,
}

impl Default for RouteOptions {
    fn default() -> RouteOptions {
        RouteOptions {
            snap_radius_m: 250.0,
            geometry: true,
            avoid_reuse: true,
            reuse_cost: None,
        }
    }
}

/// The route-shape costs of `avoid_reuse`, metres-equivalent (added to the profile's cost, which
/// stays compiled and cached).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct ReuseCost {
    /// Extra metres per metre ridden again (0..=10, default 1: [`REUSE_PER_M`]).
    pub per_m: f32,
    /// Extra metres for leaving a via back along the way it was reached (0..=10 000, default
    /// 600: [`U_TURN_M`]).
    pub u_turn_m: f32,
}

/// Riding a metre again costs this many metres more (the default of [`ReuseCost::per_m`]).
pub const REUSE_PER_M: f32 = 1.0;

/// A U-turn at a via costs this many metres (the default of [`ReuseCost::u_turn_m`]).
pub const U_TURN_M: f32 = 600.0;

impl Default for ReuseCost {
    fn default() -> ReuseCost {
        ReuseCost {
            per_m: REUSE_PER_M,
            u_turn_m: U_TURN_M,
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
    /// This plan's exceptions to the profile, by edge, for every leg (`docs/routing.md`, "This plan's
    /// exceptions"): avoid, prefer or allow an edge. Each edge at most once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overrides: Option<Vec<EdgeOverride>>,
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
    /// strongest first. Structured model: only what counts (per group its strongest bonus and
    /// penalty).
    pub why: Vec<Reason>,
    /// Structured model: the segment's row and tier on each board the profile has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tiers: Option<Vec<RowTier>>,
    /// Structured model with a hills curve: its metres here (part of `extra_m`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hills_m: Option<f32>,
}

/// A way's row on a board and the tier the profile puts it in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct RowTier {
    pub row: BoardRow,
    pub tier: Tier,
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
    /// Metres of it on ways earlier legs rode.
    pub reused_m: f32,
    /// The route-shape costs the search added on top of `cost` (riding again, a U-turn at the via
    /// it starts from), metres-equivalent.
    pub shape_cost: f32,
    /// What this plan's edge overrides added on top of `cost` (< 0 where a preferred way counts
    /// less), metres-equivalent.
    pub override_cost: f32,
    /// Turns that cost something (at junctions, U-turns; the one at the via it starts from too).
    pub turns: u32,
    /// What they cost, metres-equivalent: part of `cost` (`turn_m` per right-angle turn).
    pub turn_cost: f32,
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
    /// The profile's cost of the route (metres-equivalent): the compiled cost of every arc ridden
    /// plus its turns (`turn_cost`).
    pub cost: f32,
    /// Metres ridden twice: on ways an earlier leg rode (either direction).
    pub reused_m: f32,
    /// The route-shape costs on top of `cost` (`avoid_reuse`): the search minimised
    /// `cost + shape_cost` per leg (plus `override_cost`).
    pub shape_cost: f32,
    /// What this plan's edge overrides added on top of `cost` (< 0 where a preferred way counts less).
    pub override_cost: f32,
    /// Turns that cost something ([`Leg::turns`]).
    pub turns: u32,
    /// What they cost, metres-equivalent: part of `cost`.
    pub turn_cost: f32,
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
    /// Structured model: per row of the boards the profile has, the length of the route in it
    /// (board order, 0 m included): what each row "touches".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "schema", ts(optional))]
    pub rows: Option<Vec<Part<BoardRow>>>,
    /// Structured model with a hills curve: the route's length per grade as the curve reads it
    /// (the distribution behind the curve).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grades: Option<GradeHistogram>,
}

/// Metres per grade band: `metres[i]` lies in `[from_pct + i × step_pct, from_pct + (i + 1) ×
/// step_pct)`, the first and last band also hold everything beyond. Signed (< 0 downhill), as the
/// hills curve reads it (the steepest 50 m of each arc, the rest split by ascent and descent; loose
/// ground steeper).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema, TS))]
pub struct GradeHistogram {
    pub from_pct: f32,
    pub step_pct: f32,
    pub metres: Vec<f32>,
}

impl GradeHistogram {
    /// 1 % bands from −20 to +20 %.
    #[must_use]
    pub fn new() -> GradeHistogram {
        GradeHistogram {
            from_pct: -20.0,
            step_pct: 1.0,
            metres: vec![0.0; 40],
        }
    }

    /// Adds metres at a grade.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "a band index, clamped"
    )]
    pub fn add(&mut self, pct: f32, metres: f32) {
        let n = self.metres.len();
        let i = ((pct - self.from_pct) / self.step_pct)
            .floor()
            .clamp(0.0, (n - 1) as f32) as usize;
        self.metres[i] += metres;
    }
}

impl Default for GradeHistogram {
    fn default() -> GradeHistogram {
        GradeHistogram::new()
    }
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
    /// The request's overrides the route rides, by edge (route order of first use): the preferred and
    /// allowed ways it uses, the avoided ones it could not get around.
    #[serde(default)]
    pub overrides: Vec<OverrideUse>,
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
    headings: Headings,
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
    pub headings: &'a Headings,
}

struct Endpoint {
    snap: Snap,
    exempt: Option<cost::Exclusion>,
}

/// A leg as routed, before assembling.
struct LegRaw {
    /// `[first, end)` into the pieces.
    pieces: (usize, usize),
    /// The profile's cost.
    cost: f32,
    reused_m: f32,
    shape_cost: f32,
    override_cost: f32,
    turns: u32,
    turn_cost: f32,
    settled: u32,
}

/// What a leg's search adds on top of the compiled profile.
#[derive(Clone, Copy)]
struct Shape<'a> {
    /// Edges earlier legs rode, penalised (`None`: nothing, or `avoid_reuse` off).
    overlay: Option<&'a Overlay>,
    /// Leaving the via back along this arc (the reverse of the one it was reached by) costs this.
    back: Option<(ArcId, f32)>,
    /// The arc the via this leg starts from was reached by (the turn there counts from it).
    arrival: Option<ArcId>,
    /// What a right-angle turn costs (0: free).
    turn_m: f32,
}

impl Planner {
    /// Wraps a loaded graph (builds the snapping grid: ~0.4 s for a 100 km region).
    #[must_use]
    pub fn new(graph: Graph) -> Planner {
        let grid = Grid::build(&graph, DEFAULT_CELL_M);
        let classes = cost::EdgeClasses::build(&graph);
        let plane = Plane::for_graph(&graph);
        let headings = Headings::build(&graph);
        let search = Search::new(graph.node_count(), graph.arc_count(), Some(&headings));
        Planner {
            graph,
            grid,
            classes,
            plane,
            headings,
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

    /// The heading of every arc at either end (the turn costs read it).
    #[must_use]
    pub fn headings(&self) -> &Headings {
        &self.headings
    }

    /// Heap bytes of the search state, the headings, the edge classes and the compiled profiles.
    #[must_use]
    pub fn state_bytes(&self) -> usize {
        self.search.heap_bytes()
            + self.headings.heap_bytes()
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
            headings: &self.headings,
        })
    }

    /// Snaps a waypoint: the nearest allowed way within the radius, else the nearest way at all
    /// (exempt, its exclusion reported), else an error.
    fn snap(
        &self,
        ci: usize,
        wp: &Waypoint,
        radius: f64,
        i: usize,
        ov: Option<&Overrides>,
    ) -> Result<Endpoint, RouteError> {
        let c = &self.compiled[ci];
        let at = LngLat {
            lng: wp.lon,
            lat: wp.lat,
        };
        let cands = self.grid.snap(&self.graph, at, radius, SNAP_CANDIDATES);
        let allowed = |s: &Snap| {
            let (along, against) = (arc(s.edge, false), arc(s.edge, true));
            overrides::arc_cost(ov, &c.costs, along).is_finite()
                || overrides::arc_cost(ov, &c.costs, against).is_finite()
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
    fn partial(&self, ci: usize, a: ArcId, fraction: f32, exempt: bool, ov: Option<&Overrides>) -> f32 {
        if fraction <= 1e-6 {
            return 0.0; // already at the node
        }
        let c = &self.compiled[ci];
        let full = overrides::arc_cost(ov, &c.costs, a);
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
        let reuse = req.options.reuse_cost.unwrap_or_default();
        if !(0.0..=10.0).contains(&reuse.per_m) || !(0.0..=10_000.0).contains(&reuse.u_turn_m) {
            return Err(err(
                ErrorCode::InvalidRequest,
                format!(
                    "reuse_cost {} m per m, {} m per U-turn is outside 0..10, 0..10000",
                    reuse.per_m, reuse.u_turn_m
                ),
            ));
        }
        let avoid_reuse = req.options.avoid_reuse;
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
        let list = req.overrides.as_deref().unwrap_or(&[]);
        overrides::check(list, self.graph.edge_count())?;
        // the overrides under each leg's profile (by its cost key), built once
        let mut built: Vec<(String, Overrides)> = Vec::new();
        let mut uses: Vec<OverrideUse> = Vec::new();
        // per piece: an arc a limit closes that an override opens
        let mut lifted: Vec<bool> = Vec::new();
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
        let mut legs_raw: Vec<LegRaw> = Vec::with_capacity(n - 1);
        // the edges ridden so far (counted always, penalised with `avoid_reuse`)
        let mut ridden = (n > 2).then(|| Overlay::new(self.graph.edge_count(), reuse.per_m));
        let mut snapped: Vec<Snapped> = Vec::with_capacity(n);
        let mut models: Vec<usize> = Vec::with_capacity(n - 1);
        for l in 0..n - 1 {
            let ci = self.compile(leg_profile(l))?;
            let oi = (!list.is_empty()).then(|| {
                let key = leg_profile(l).cost_key();
                built.iter().position(|(k, _)| *k == key).unwrap_or_else(|| {
                    let c = &self.compiled[ci];
                    let o = Overrides::build(&self.graph, &c.model, self.personal.as_ref(), &c.costs, list);
                    built.push((key, o));
                    built.len() - 1
                })
            });
            let ov = oi.map(|i| &built[i].1);
            let (wa, wb) = (&req.waypoints[l], &req.waypoints[l + 1]);
            let a = self.snap(ci, wa, radius, l, ov)?;
            let b = self.snap(ci, wb, radius, l + 1, ov)?;
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
            let turn_m = leg_profile(l).turn_m();
            let shape = Shape {
                overlay: ridden.as_ref().filter(|o| avoid_reuse && !o.is_empty()),
                back: (avoid_reuse && l > 0)
                    .then(|| pieces.last().map(|p| (p.arc ^ 1, reuse.u_turn_m)))
                    .flatten(),
                arrival: (l > 0).then(|| pieces.last().map(|p| p.arc)).flatten(),
                turn_m,
            };
            let (found, settled, uturn) = self.leg(ci, &a, &b, shape, ov, &mut pieces).map_err(|mut e| {
                e.leg = Some(u32::try_from(l).unwrap_or(u32::MAX));
                e
            })?;
            let leg_pieces = &pieces[start..];
            let reused_m = ridden.as_ref().map_or(0.0, |o| {
                leg_pieces
                    .iter()
                    .map(|p| o.reused_m(&self.graph, arc_edge(p.arc), p.t0, p.t1))
                    .sum()
            });
            // what the search added: the penalty on the metres ridden again, the U-turn if the leg
            // leaves the via back along its arrival
            let mut shape_cost = 0.0;
            if avoid_reuse {
                shape_cost += reused_m * reuse.per_m;
                if uturn {
                    shape_cost += reuse.u_turn_m;
                }
            }
            // what the overrides added (the profile's cost is without them), and which they rode
            let mut override_cost = 0.0;
            if let Some(o) = ov {
                let costs = &self.compiled[ci].costs;
                for p in leg_pieces {
                    let e = arc_edge(p.arc);
                    let Some(kind) = o.kind(e) else { continue };
                    let d = o.cost(costs, p.arc) - o.base(costs, p.arc);
                    if d.is_finite() {
                        override_cost += d * p.fraction();
                    }
                    let len = self.graph.length_m(e) * p.fraction();
                    match uses.iter_mut().find(|u| u.edge == e) {
                        Some(u) => u.length_m += len,
                        None => uses.push(OverrideUse {
                            edge: e,
                            kind,
                            length_m: len,
                        }),
                    }
                }
            }
            lifted.extend(leg_pieces.iter().map(|p| ov.is_some_and(|o| o.lifted(p.arc))));
            if let Some(o) = ridden.as_mut() {
                for p in leg_pieces {
                    o.mark(arc_edge(p.arc), p.t0, p.t1);
                }
            }
            // the turns: between the leg's pieces, and from the arrival at the via it starts from
            let (turns, turn_cost) = self.piece_turns(&pieces[start.saturating_sub(1)..], turn_m);
            legs_raw.push(LegRaw {
                pieces: (start, pieces.len()),
                cost: (found - shape_cost - override_cost).max(0.0),
                reused_m,
                shape_cost,
                override_cost,
                turns,
                turn_cost,
                settled,
            });
            models.push(ci);
        }
        let avoided: f32 = uses
            .iter()
            .filter(|u| u.kind == OverrideKind::Avoid)
            .map(|u| u.length_m)
            .sum();
        if avoided > 0.0 {
            notes.push(format!(
                "{avoided:.0} m of the route are on ways this plan avoids: there is no other way, or a stop is on one"
            ));
        }
        let mut result = self.assemble(
            &pieces,
            &lifted,
            &legs_raw,
            &models,
            snapped,
            notes,
            req.options.geometry,
        );
        result.breakdown.touched = self.touched(&pieces, &req.profile);
        if req.profile.structured() {
            self.structured_breakdown(&pieces, &req.profile, &mut result.breakdown);
        }
        result.overrides = uses;
        Ok(result)
    }

    /// The turns between consecutive pieces (riding on along one arc through a via is none): how
    /// many cost something and what (`turn_m` per right-angle turn).
    fn piece_turns(&self, pieces: &[Piece], turn_m: f32) -> (u32, f32) {
        let arcs: Vec<ArcId> = pieces.iter().map(|p| p.arc).collect();
        crate::turns::line_turns(&self.graph, &self.headings, turn_m, &arcs)
    }

    /// The structured model's breakdowns: length per board row, and per grade as the hills curve
    /// reads it (`breakdown.rows`, `breakdown.grades`).
    fn structured_breakdown(&self, pieces: &[Piece], profile: &Profile, out: &mut Breakdown) {
        let g = &self.graph;
        let Ok(model) = CostModel::new(profile) else {
            return;
        };
        let rows = model.rows();
        let mut m = vec![0.0f32; rows.len()];
        let mut hist = model.has_hills().then(GradeHistogram::new);
        let mut total = 0.0f32;
        for piece in pieces {
            let e = arc_edge(piece.arc);
            let frac = piece.fraction();
            let len = g.length_m(e) * frac;
            total += len;
            let (surface, way) = cost::board_rows(g, e);
            for (i, r) in rows.iter().enumerate() {
                if *r == surface || Some(*r) == way {
                    m[i] += len;
                }
            }
            if let (Some(h), Some(parts)) = (&mut hist, model.hills_parts(g, piece.arc)) {
                for (pct, metres) in parts {
                    h.add(pct, metres * frac);
                }
            }
        }
        let total = total.max(1e-6);
        out.rows = Some(
            rows.into_iter()
                .zip(m)
                .map(|(key, length_m)| Part {
                    key,
                    length_m,
                    share: length_m / total,
                })
                .collect(),
        );
        out.grades = hist;
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

    /// One leg: A* between two snapped points; appends its pieces. Returns the cost the search
    /// minimised (the shape costs included), the nodes settled, and whether it leaves the via back
    /// along its arrival (the U-turn cost is in the cost).
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
        shape: Shape<'_>,
        ov: Option<&Overrides>,
        pieces: &mut Vec<Piece>,
    ) -> Result<(f32, u32, bool), RouteError> {
        let g = &self.graph;
        let (ea, ta) = (a.snap.edge, a.snap.fraction as f32);
        let (eb, tb) = (b.snap.edge, b.snap.fraction as f32);
        let (xa, xb) = (a.exempt.is_some(), b.exempt.is_some());
        let mut scratch = Vec::new();
        // the turn from the arrival at the via onto a first piece (none at the start)
        let mut turn_onto = |p: ArcId| match shape.arrival {
            Some(x) if shape.turn_m > 0.0 => {
                shape.turn_m * share_between(g, &self.headings, x, p, &mut scratch)
            }
            _ => 0.0,
        };
        // a partial arc's cost with the shape costs: riding again, the U-turn at the via
        let shaped = |cost: f32, a: ArcId, t0: f32, t1: f32| {
            if !cost.is_finite() {
                return cost;
            }
            let mut c = cost;
            if let Some(o) = shape.overlay {
                c += o.extra(g, arc_edge(a), t0, t1);
            }
            if let Some((back, u)) = shape.back
                && back == a
            {
                c += u;
            }
            c
        };
        // from the point: to `to` along the edge, to `from` against it; a piece of no length
        // leaves the turn to the node (from the arrival)
        let source = |cost: f32, a: ArcId, fraction: f32, turn: f32| {
            let some = fraction > 1e-6;
            Source {
                node: g.head(a),
                arc: a,
                cost: if some && cost.is_finite() {
                    cost + turn
                } else {
                    cost
                },
                turn_from: if some { Some(a) } else { shape.arrival },
            }
        };
        let (fwd, bwd) = (arc(ea, false), arc(ea, true));
        let fwd_a = shaped(self.partial(ci, fwd, 1.0 - ta, xa, ov), fwd, ta, 1.0);
        let bwd_a = shaped(self.partial(ci, bwd, ta, xa, ov), bwd, 0.0, ta);
        let sources = [
            source(fwd_a, fwd, 1.0 - ta, turn_onto(fwd)),
            source(bwd_a, bwd, ta, turn_onto(bwd)),
        ];
        // into the point: from `from` along the edge, from `to` against it (never a U-turn: the
        // U-turn is the first move from the via)
        let into = |cost: f32, e: EdgeId, t0: f32, t1: f32| match shape.overlay {
            Some(o) if cost.is_finite() => cost + o.extra(g, e, t0, t1),
            _ => cost,
        };
        let fwd_b = into(self.partial(ci, arc(eb, false), tb, xb, ov), eb, 0.0, tb);
        let bwd_b = into(self.partial(ci, arc(eb, true), 1.0 - tb, xb, ov), eb, tb, 1.0);
        let targets = [
            Target {
                node: g.from(eb),
                arc: (tb > 1e-6).then_some(arc(eb, false)),
                cost: fwd_b,
            },
            Target {
                node: g.to(eb),
                arc: (1.0 - tb > 1e-6).then_some(arc(eb, true)),
                cost: bwd_b,
            },
        ];
        // the direct way along one edge
        let mut direct = f32::INFINITY;
        let mut direct_piece = None;
        if ea == eb {
            let rev = tb < ta;
            let p = shaped(
                self.partial(ci, arc(ea, rev), (tb - ta).abs(), xa || xb, ov),
                arc(ea, rev),
                ta,
                tb,
            );
            if p.is_finite() {
                direct = p + turn_onto(arc(ea, rev));
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
        let starts: Vec<NodeId> = sources
            .iter()
            .filter(|s| s.cost.is_finite())
            .map(|s| s.node)
            .collect();
        let ends: Vec<NodeId> = targets
            .iter()
            .filter(|t| t.cost.is_finite())
            .map(|t| t.node)
            .collect();
        let pocket_a = !xa
            && self
                .search
                .cut_off(g, &c.costs, ov, &starts, &ends, POCKET_NODES, true);
        let pocket_b = !xb
            && self
                .search
                .cut_off(g, &c.costs, ov, &ends, &starts, POCKET_NODES, false);
        let exempt_points: Vec<(i32, i32)> = [(a, pocket_a), (b, pocket_b)]
            .iter()
            .filter(|(ep, pocket)| ep.exempt.is_some() || *pocket)
            .map(|(ep, _)| ep.snap.point.to_e7())
            .collect();
        let both = [a.snap.point.to_e7(), b.snap.point.to_e7()];
        let mut query = Query {
            costs: &c.costs,
            plane: self.plane,
            // an override may count less than anything the compile produced
            bound: ov.map_or(c.bound, |o| o.bound(c.bound)),
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
            overlay: shape.overlay,
            uturn: shape.back.map(|(back, cost)| UTurn {
                node: g.tail(back),
                arc: back,
                // the target whose tail rides `back` (from `from` along, from `to` against)
                target: [arc(eb, false), arc(eb, true)].iter().position(|&t| t == back),
                cost,
            }),
            overrides: ov,
            turns: (shape.turn_m > 0.0).then_some(Turns {
                headings: &self.headings,
                turn_m: shape.turn_m,
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
                // the first piece: from the point to the start node; the last: on to the point
                let first = Piece {
                    arc: sources[f.source].arc,
                    t0: ta,
                    t1: if f.source == 0 { 1.0 } else { 0.0 },
                    exempt: xa,
                };
                let last = if f.target == 0 {
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
                let start = sources[f.source].node;
                // back along the arrival: the partial from the point, or the first move from the
                // node the arrival reached (a full arc, or the target's partial arc)
                let uturn = shape.back.is_some_and(|(back, _)| {
                    first.arc == back
                        || (start == g.tail(back) && f.arcs.first().map_or(last.arc == back, |&a| a == back))
                });
                // a waypoint on a node rides nothing of its snapped edge
                if first.fraction() > 1e-6 {
                    pieces.push(first);
                }
                pieces.extend(f.arcs.iter().map(|&a| Piece::full(a)));
                if last.fraction() > 1e-6 {
                    pieces.push(last);
                }
                Ok((f.cost, settled, uturn))
            }
            None => {
                if let Some(p) = direct_piece {
                    let uturn = shape.back.is_some_and(|(back, _)| p.arc == back);
                    pieces.push(p);
                    return Ok((direct, settled, uturn));
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
    #[allow(
        clippy::too_many_arguments,
        reason = "the legs' pieces and what goes with them"
    )]
    fn assemble(
        &self,
        pieces: &[Piece],
        lifted: &[bool],
        legs_raw: &[LegRaw],
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
        let (mut tot_reused, mut tot_shape, mut tot_override) = (0.0f32, 0.0f32, 0.0f32);
        let (mut tot_turns, mut tot_turn) = (0u32, 0.0f32);
        let mut acc = SegAcc::default();
        for (l, raw) in legs_raw.iter().enumerate() {
            let (p0, p1) = raw.pieces;
            let model = &self.compiled[models[l]].model;
            let (leg_start_arc, leg_start_seg, leg_start_m) = (arcs.len(), segments.len(), dist);
            let (mut up, mut down, mut secs) = (0.0f32, 0.0f32, 0.0f32);
            for (piece, &lifted) in pieces[p0..p1].iter().zip(&lifted[p0..p1]) {
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
                // (an arc an override of the plan opens counts as the profile without its limits)
                let (factor, extra, hills) = if ex.excluded.is_some() && !lifted {
                    // ridden near a waypoint on an excluded way, to get away from it
                    excluded_m += len;
                    (model.max_factor, 0.0, 0.0)
                } else {
                    (
                        ex.factor,
                        (ex.climb_m + ex.penalty_m + ex.hills_m) * frac,
                        ex.hills_m * frac,
                    )
                };
                let key = (surface, way, ridden);
                if acc.key != Some(key) {
                    acc.flush(&mut segments, arcs.len() - 1, first_vertex);
                    acc.start(key, dist, arcs.len() - 1, first_vertex);
                    acc.tiers = model.is_structured().then(|| model.row_tiers(g, e));
                    acc.hills = model.has_hills().then_some(0.0);
                }
                if let Some(h) = &mut acc.hills {
                    *h += hills;
                }
                acc.add(len, factor, extra, &ex.factors);
                dist += len;
            }
            acc.flush(&mut segments, arcs.len(), geo.last_vertex());
            tot_up += up;
            tot_down += down;
            tot_secs += secs;
            tot_cost += raw.cost;
            tot_reused += raw.reused_m;
            tot_shape += raw.shape_cost;
            tot_override += raw.override_cost;
            tot_turns += raw.turns;
            tot_turn += raw.turn_cost;
            legs.push(Leg {
                distance_m: dist - leg_start_m,
                ascent_m: up,
                descent_m: down,
                duration_s: secs,
                cost: raw.cost,
                reused_m: raw.reused_m,
                shape_cost: raw.shape_cost,
                override_cost: raw.override_cost,
                turns: raw.turns,
                turn_cost: raw.turn_cost,
                arcs: [leg_start_arc as u32, arcs.len() as u32],
                segments: [leg_start_seg as u32, segments.len() as u32],
                settled: raw.settled,
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
                reused_m: tot_reused,
                shape_cost: tot_shape,
                override_cost: tot_override,
                turns: tot_turns,
                turn_cost: tot_turn,
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
                rows: None,
                grades: None,
            },
            waypoints,
            legs,
            segments,
            arcs,
            arc_vertex,
            geometry: with_geometry.then(|| geo.finish()),
            notes,
            overrides: Vec::new(),
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
                    hills_m: x.hills_m,
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
    /// The hills curve's metres (structured model).
    #[serde(default)]
    pub hills_m: f32,
    /// Every preference whose factor is not 1 here (structured model: that counts).
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
    tiers: Option<Vec<RowTier>>,
    hills: Option<f32>,
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
            tiers: self.tiers.take(),
            hills_m: self.hills.take(),
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
