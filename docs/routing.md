# Routing

The `route` query: waypoints in, a route with everything the planner draws out. Plain serde data on
both sides (JSON in the browser worker; schemas and TypeScript types in `web/src/engine/generated/`).
Code: `engine/core/src/{route,search}.rs`; the cost it searches is [profile.md](profile.md).

## The engine object

`Planner::new(graph)` owns the loaded graph, builds the snapping grid (0.4 s for a 100 km region)
and the edge classes (60 ms, 4.8 MB: edges grouped by their tags, so a profile is evaluated once
per group instead of once per edge), and keeps one reusable search state (22 MB) and the last two
compiled profiles (19 MB each: the current one and, typically, the base preset's ghost). Queries:

| call | in → out |
|---|---|
| `route(&RouteRequest)` | → `RouteResult` or `RouteError` |
| `diff(&DiffRequest)` | two routes' `arcs` → `RouteDiff`: where they part and meet again |
| `explain(&Profile, &[arc])` | → per arc every factor, the gate, additive terms, what excludes it |
| `arc_costs(&Profile)` | → the compiled cost per arc (a "cost in this profile" map layer, later) |
| `prepare(&Profile)` | compile ahead of the first route |
| `set_personal(Option<PersonalLayer>)` | ride history per edge ([profile.md](profile.md)) |
| `catalogue()`, `catalogue_for(graph)`, `presets()`, `preset(id)` | free functions |

Compiling a profile is ~40 ms native for 2.3 M edges and happens only when the cost changes (weights,
limits, bounds: not the name), so dragging a slider costs one compile plus one search per step.

## Request

```json
{ "waypoints": [{ "lon": 0.001, "lat": 0.002, "name": "Start" }, { "lon": 0.03, "lat": 0.01 }],
  "profile": { "weights": { "unpaved": 70 }, "limits": { "legal_only": true } },
  "leg_profiles": [null],
  "options": { "snap_radius_m": 250, "geometry": true } }
```

Two or more waypoints, a profile, optionally a profile per leg (`null` keeps the main one; API only,
the planner sends one), options. Reserved and accepted but not used yet (the result says so in
`notes`): `via_zones` and `avoid_zones` (`{ "type": "circle", "center", "radius_m" }` or `{ "type":
"polygon", "ring" }`) and `sketch` (`{ "points": [...] }`). Loops (start, distance, bearing or a sketch)
will be their own query, not a variant of this one.

## Waypoints and limits

Each waypoint snaps to the **nearest allowed way** within `snap_radius_m` (default 250 m): a limit
never strands a tap that lands on a footway beside a street. A route must still be able to start and
end where the rider is, so:

- If no allowed way is within the radius, it snaps to the nearest way at all and says what excludes
  it (`waypoints[i].excluded_by`).
- Near such a waypoint, and near one whose allowed way sits in a small pocket the limits cut off
  (fewer than 10 000 nodes reachable, checked up front with a bounded walk), excluded ways within
  1 km may be ridden at `max_factor` per metre, never against a one-way or a bicycle ban. The result
  notes how many metres of it there are.
- If even that finds nothing: `excluded` (naming the limit) or `no_route`; no way within the radius:
  `no_way_near`. Errors carry the waypoint or leg index.

## Search

Plain A* per leg (spike #4: no landmarks, no corridor, no contraction), from the snapped point to the
snapped point: the search starts with labels on the source edge's two end nodes (the partial arcs
from the point) and ends at the target edge's end nodes plus the partial arc into the point; two
points on one edge also try the direct way. The bound is the straight line × the smallest factor the
compile produced, on a plane that never overestimates, so it is consistent and every node settles
once. The search state is reused with a generation counter: a query allocates only the result.

Real region, native, release, one thread on the shared 6-core VM (`kompass bench`, 100 seeded pairs
per bucket, routes that compile, snap, search and assemble geometry, segments and reasons):

| route | Gravel explorer ms p50 / p95 / max | Paved & quiet | settled p50 | result JSON |
|---|---:|---:|---:|---:|
| ~11 km | 1.5 / 3.4 / 4.5 | 1.5 / 2.9 / 3.9 | 9 k | 22 KB |
| ~57 km | 8.5 / 13.7 / 17.9 | 8.7 / 17.8 / 38.1 | 78 k | 91 KB |
| ~112 km | 31.2 / 43.2 / 55.6 | 27.5 / 47.5 / 61.1 | 270 k | 173 KB |

Compiling: 38 ms (Gravel explorer, per-arc climb terms), 21 ms (Paved & quiet). The spike measured
11.0 / 16.7 ms for the search alone at 50 km and 42 ms per compile; wasm in a worker was ~1.2× native
and a 6×-throttled phone estimate ~7×.

## Result

- `summary`: distance, ascent and descent (beyond the noise deadband, [profile.md](profile.md)), a
  rough duration (speed by surface, slower on narrow paths, walking on `dismount`, carrying on steps,
  faster downhill, plus 1 h per 900 m climbed), cost, unpaved and unknown-surface shares, main-road
  metres, and the never-ridden share with a personal layer.
- `geometry` (unless `options.geometry` is false): `[lon, lat]` per vertex (1e-6°), the distance
  from the start per vertex, and the elevation per vertex (from the graph's node elevations, linear
  along each edge) for the elevation profile.
- `arcs`: the route as arcs (`edge << 1 | reverse`, the first and last partial), and `arc_vertex`, the
  first vertex of each: edge ids for highlighting and the explored map.
- `segments`: a run-length list of stretches with one surface (the tag or a safe guess, else
  `unknown`), one way type (`main_road`, `country_road`, `residential`, `service`, `track`, `path`,
  `bike_path`, `bike_path_roadside`, `steps`, `ferry`, `other`) and one ridden state; each with its
  start and length, `[first, end)` into `arcs`, `[first, last]` vertices, the mean factor, additive
  metres, and **why**: the up to three strongest preferences there (length-weighted geometric mean
  factor, `< 1` made it cheaper, `> 1` dearer).
- `breakdown`: length and share per surface and per way type, longest first; ridden vs. new with a
  personal layer. `legs`: per leg the same totals and its ranges of arcs and segments.
- `waypoints`: where each one snapped (point, distance, edge, fraction, `excluded_by`). `notes`.

**What crosses the worker per slider step**: one result, ~90 KB of JSON for 50 km (the geometry is
most of it). Everything heavier is on demand: `explain` for one tapped stretch, `diff` against the
ghost (base profile, which stays compiled) or the previous route for the "moved" lane.

## Diff

`diff({ a, b })` takes two routes' `arcs` and returns the stretches where they part and meet again:
the edges both share in the same order (a longest increasing run, so a detour or a loop back does
not confuse it) are anchors, and every gap between anchors is a stretch with its span in `a` and in
`b` (`[first, end)` arcs, start and length in metres, edges counted in full). Plus the shared length
and what only one of them rides.
