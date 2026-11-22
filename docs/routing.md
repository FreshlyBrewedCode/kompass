# Routing

The `route` query: waypoints in, a route with everything the planner draws out. Plain serde data on
both sides (JSON in the browser worker; schemas and TypeScript types in `web/src/engine/generated/`).
Code: `engine/core/src/{route,search,explain}.rs`; the cost it searches is [profile.md](profile.md).

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
| `arc_costs(&Profile)` | → the compiled cost per arc |
| `edge_costs(&Profile, &EdgeSelection)` | → factor and cost per metre per edge and direction, what closes it ([below](#explaining-the-cost)) |
| `explain_edge(&ExplainEdgeRequest)` | → one edge, both directions, every step of its cost |
| `compare(&CompareRequest)` | two routes' `arcs` → `RouteComparison`: the `diff` stretches, each side costed |
| `stretch_costs(&Profile, arcs, spans, n)` | → stretches of one route costed like `compare`'s sides |
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
  "options": { "snap_radius_m": 250, "geometry": true, "avoid_reuse": true } }
```

Two or more waypoints, a profile, optionally a profile per leg (`null` keeps the main one; API only,
the planner sends one), options (`avoid_reuse`, on by default: [below](#dont-ride-the-same-way-twice);
`reuse_cost` tunes it for tools, the planner sends none). Reserved and accepted but not used yet (the result says so in
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

## Don't ride the same way twice

Legs are routed in order, and each leg's search pays for the route's shape on top of the compiled
profile (which stays compiled and cached: the costs are a per-request layer, `search::Overlay` and
`search::UTurn`, read beside the compiled arc costs):

- **Riding again:** every metre of an edge an earlier leg rode, in either direction, costs
  `reuse_cost.per_m` metres more (default **1**). Only the part ridden before counts (a leg that starts
  or ends mid-edge marks only its piece). So a new way is taken where it is up to about twice the
  cost of the stretch it saves riding again; a longer one is not.
- **A U-turn at a via:** leaving a via back along the arc it was reached by costs
  `reuse_cost.u_turn_m` metres (default **600**): mid-edge (the partial back), from the node the
  arrival reached (the arc back), and riding on to the next node and back along the target edge.
  So a via on a through road is ridden through where a loop round the block is less than ~600 m
  longer than turning.

Both are finite and only add, so the A* bound stays valid, and an out-and-back the waypoints ask for
(a via at a dead end, a waypoint reachable one way only) routes as before, just dearer. A U-turn at a
dead end elsewhere in a leg is free: a node-labelled search cannot ride one (each node settles once),
except into the target, which the turn cost (#64) will charge. Each leg is the cheapest given the
legs before it (greedy, not a joint optimum; a test checks every leg against Dijkstra with the shape
costs). The result says what it did: `summary.reused_m` and `legs[i].reused_m`, the metres on ways an
earlier leg rode (counted with `avoid_reuse` off too), and `shape_cost`, what the search added. `cost`
stays the profile's cost of the line (the compiled cost of every arc ridden), so `compare` and the
segments read the same numbers as before; the search minimised `cost + shape_cost` per leg. A
single-leg route has no overlay and pays nothing for it.

Per-plan edge overrides (#59: avoid, prefer, allow an edge) fit the same layer: more entries, each
with its own term (a prefer or an allow below the compiled cost then has to lower the bound).

**The strengths, from seeded loops on the real region** (`kompass compare --loop 3|4 --reuse …`:
40 loops each, 30–60 km polygons, corners mid-edge on ways that are not dead ends for any profile;
Gravel explorer, triangles / squares):

| `per_m` / `u_turn_m` | ridden twice | U-turns at vias | km vs off p50 / p90 | cost vs off p50 / p90 |
|---|---:|---:|---:|---:|
| off | 5.5 % / 3.3 % | 59 of 80 / 72 of 120 | 1 | 1 |
| 0.5 / 600 | 1.4 % / 1.1 % | 17 / 26 | 1.003 / 1.023 · 1.004 / 1.018 | 1.009 / 1.019 · 1.007 / 1.020 |
| 1 / 0 | 0.8 % / 0.8 % | 40 / 48 | 1.006 / 1.027 · 1.002 / 1.022 | 1.008 / 1.031 · 1.004 / 1.019 |
| 1 / 300 | 0.6 % / 0.7 % | 21 / 32 | 1.009 / 1.033 · 1.004 / 1.022 | 1.011 / 1.036 · 1.007 / 1.022 |
| **1 / 600** | **0.5 % / 0.7 %** | **12 / 27** | **1.011 / 1.045 · 1.004 / 1.022** | **1.015 / 1.038 · 1.008 / 1.026** |
| 2 / 600 | 0.3 % / 0.3 % | 9 / 21 | 1.011 / 1.045 · 1.008 / 1.026 | 1.019 / 1.043 · 1.010 / 1.036 |
| 1 / 1000 | 0.4 % / 0.6 % | 7 / 18 | 1.014 / 1.045 · 1.009 / 1.026 | 1.019 / 1.042 · 1.011 / 1.028 |

`per_m` 1 is the knee: it cuts what is ridden twice by a factor of 6–10 for about 1 % more length at
the median; 2 halves the rest at twice the price. Without a U-turn cost two thirds of the vias are
still left the way they were reached (mostly mid-edge, where riding back is cheap); 600 m leaves
about a fifth, and 1000 m buys little more for more length. Paved & quiet rides more twice with any
setting (12.8 % → 4.1 % on triangles, 6.9 % → 2.7 % on squares): with `paved_only` its network is
sparse and many corners sit on stretches with no paved way round. With corners anywhere (often on a
dead-end spur, where reuse is forced) every loop still routes. Multi-leg routes are as fast as
before (the overlay is a bit per edge, 290 KB for the region, and a map for the few marked ones).

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
  faster downhill, plus 1 h per 900 m climbed), cost (the profile's), the metres ridden twice and the
  shape costs on top ([above](#dont-ride-the-same-way-twice)), unpaved and unknown-surface shares,
  main-road metres, and the never-ridden share with a personal layer.
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

## Explaining the cost

The cost debug view (`explain.rs`): why the route goes where it goes. All three queries read the
compiled profile the router uses (compiled once, cached like a route's), and the breakdown runs the
same functions the compile does (`CostModel::breakdown`: membership, tables, gate, clamp, additive
terms, limits). A test checks on every arc of random graphs, for the presets, extreme and random
profiles, that `length × factor + extra` is the compiled cost and that a closed arc is exactly one
with closures.

**`edgeCosts`: a map layer.** For many edges at once: the edges listed (the overlay tiles' feature ids
are edge ids, [map.md](map.md)), or those in a `bbox` (from the snapping grid: every edge in it and a
few just outside, ascending), or every edge. Flat arrays (typed arrays in the browser, transferred):
`edges`, `factor` and `costPerM` two per edge (`[2i]` along the geometry, `[2i + 1]` against it; the
factor after the clamp, the cost per metre with the additive terms; 0 where that direction may not
be ridden), `closed` one per edge (0 when one direction at least is open, else the code of what closes
it: `codes[code − 1]`, a limit id, `no_bikes` or `oneway`), and `minFactor`, `maxFactor`, `bound`.
Native: every edge of the demo region (51 k) in 1.3 ms, 25 k listed in 0.5 ms, a box of 2.4 k in 0.08 ms
(so ~60 ms for 2.34 M); the browser worker: 2.2 ms for the 51 k, 1.2 ms for 25 k listed (round trip
included, `?bench`).

**`explainEdge`: the tap panel.** `{ profile, edge }` → `EdgeExplanation`: the way type, the reported
surface and the one the cost uses (`tagged`, `strong_guess`, `weak_guess`), the traffic level `quiet`
penalises and where it comes from (`traffic_from`: `way`, or `alongside` for the roads beside it), every
attribute by its `edges.parquet` column (shares in percent), the bounds, and per direction (`along`,
`against`) an `ArcCostExplanation`: every active preference (weight ≠ 0, also where it does not
apply) with its weight, membership (−1…1, fifteenths), factor and role (`quality`, `gated_penalty`,
`gated_bonus`, `additive` for avoiding climbs), then `quality`, `bonus`, `gate`, `raw_factor` (before the
clamp), `factor`, `clamp` (`min` / `max` when it bit), ascent beyond the deadband and the tamed grades,
the additive terms (`climb`, `barriers`, `steps`, `dismount`, `ferry`) and their sum `extra_m`, the
router's `cost` and `cost_per_m` (absent when closed), and `closed_by`: every closure in the order the
engine checks, each with the attribute that triggers it (`legal_only (bike_access = agri_forestry)`).

**`compare`: why not this way?** Route as usual, route again with a via on the wanted line, then
`compare({ profile, a, b })` with both routes' `arcs` and the profile to judge them by. The answer: both
whole routes and every `diff` stretch, each side a `StretchCost`: its span, cost under the profile
(closed arcs at `max_factor` per metre, as near a waypoint), mean factor, additive metres, length at the
clamp (`clamped_min_m`: the bonuses wanted it lower, more seeking changes nothing; `clamped_max_m`),
the up to five strongest preferences (length-weighted geometric mean factor), the way types and the
length on closed arcs by closure; per stretch `cost_delta` (b − a; > 0 is why the router took `a`) and
`length_delta_m`. Edges count in full (the routes' partial first and last arcs too). The `segments` of a
route stay as they are (three reasons, no closures); `compare` is the on-demand detail.

**CLI.** `kompass route … --explain` prints every segment (length, surface, way, factor, extra,
cost per metre, reasons, share at the clamp, closures), a table by way type and surface, and the
whole route per preference; `--why-not lon,lat` routes again through that point (inserted where it
adds the least straight-line distance) and prints the comparison. Text only, no coordinates; the GeoJSON
then goes only to `--out`. `kompass explain --build … --profile … --edge <id> [--json]` prints one edge;
`--time` times `edgeCosts`.

## Route quality against the rider's rides

`kompass replay` (`engine/cli/src/replay.rs`) asks the vision's question, "routes the rider would actually
ride", of the rider's own history. Each recorded ride is map-matched ([matching.md](matching.md)) and cut
into legs of about `--leg-km` (graph node to graph node; legs with a chain break, or whose end points are
closer than `--min-straight` × the ridden length, are skipped: no A→B router reproduces a loop). Every
profile routes each leg; `--ref name=dir` adds another router's answer (`<dir>/ride<k>-leg<j>.gpx`, e.g. a
local BRouter fed from `legs.json`), map-matched onto the same graph, so all lines are arc lists measured
alike:

- **reproduced**: the share of the ridden length the line rides too (edges, either direction; a parallel
  way such as a road and its sidepath counts as missed), and **on ridden**, the share of the line that was
  ridden;
- length against the ridden line, ascent (the tamed one), unpaved share, main roads, roadside cycle paths,
  km beside busy roads (`road_near_traffic` ≥ 0.45 over half of a path or track), paved tracks, the mix of
  way types;
- under the first profile (the judge): its cost of every line, the length at its `min_factor` clamp, what it
  closes on each line (for the ridden line also by access tag), and per preference the length-weighted
  geometric mean factor;
- turns (≥ 45° at a junction) per km and zigzags (a turn the other way within 300 m);
- where the judge's route leaves the ridden line: the `compare` stretches of ≥ 300 m with a first grouping.

Stdout holds numbers and ride/leg indices only; `--out-dir` gets the private detail (`legs.json` with the
end points, a GeoJSON per leg with every line, `stretches.txt`), so it belongs under `data/` or a temporary
directory. The first round is [the route-quality report](reports/2026-11-21-route-quality.md).
