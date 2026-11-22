# Routing

The `route` query: waypoints in, a route with everything the planner draws out. Plain serde data on
both sides (JSON in the browser worker; schemas and TypeScript types in `web/src/engine/generated/`).
Code: `engine/core/src/{route,search,turns,explain,overrides}.rs`; the cost it searches is [profile.md](profile.md).

## The engine object

`Planner::new(graph)` owns the loaded graph, builds the snapping grid (0.4 s for a 100 km region)
and the edge classes (60 ms, 4.8 MB: edges grouped by their tags, so a profile is evaluated once
per group instead of once per edge), the turn headings (0.2 s, 6.5 MB: [below](#turns)), and keeps one
reusable search state (52 MB: a label per arc) and the last two compiled profiles (19 MB each: the
current one and, typically, the base preset's ghost). Queries:

| call | in → out |
|---|---|
| `route(&RouteRequest)` | → `RouteResult` or `RouteError` |
| `diff(&DiffRequest)` | two routes' `arcs` → `RouteDiff`: where they part and meet again |
| `explain(&Profile, &[arc])` | → per arc every factor, the gate, additive terms, what excludes it |
| `arc_costs(&Profile)` | → the compiled cost per arc |
| `edge_costs(&Profile, &EdgeSelection)` | → factor and cost per metre per edge and direction, what closes it ([below](#explaining-the-cost)) |
| `explain_edge(&ExplainEdgeRequest)` | → one edge, both directions, every step of its cost |
| `compare(&CompareRequest)` | two routes' `arcs` → `RouteComparison`: the `diff` stretches, each side costed |
| `edge_run(edge)` | → `EdgeRun`: the edge extended to the next real junctions, with its line ([below](#this-plans-exceptions)) |
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
  "options": { "snap_radius_m": 250, "geometry": true, "avoid_reuse": true },
  "overrides": [{ "edge": 4711, "kind": "avoid" }] }
```

Two or more waypoints, a profile, optionally a profile per leg (`null` keeps the main one; API only,
the planner sends one), options (`avoid_reuse`, on by default: [below](#dont-ride-the-same-way-twice);
`reuse_cost` tunes it for tools, the planner sends none), and the plan's exceptions by edge
(`overrides`, for every leg: [below](#this-plans-exceptions)). Reserved and accepted but not used yet (the result says so in
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
(a via at a dead end, a waypoint reachable one way only) routes as before, just dearer. Elsewhere in a
leg the search takes no U-turn at all (as the node search before it): only the first move from a via may
turn back, at the U-turn cost and twice a turn ([turns](#turns)). Each leg is the cheapest given the
legs before it (greedy, not a joint optimum; a test checks every leg against Dijkstra with the shape
costs). The result says what it did: `summary.reused_m` and `legs[i].reused_m`, the metres on ways an
earlier leg rode (counted with `avoid_reuse` off too), and `shape_cost`, what the search added. `cost`
stays the profile's cost of the line (the compiled cost of every arc ridden), so `compare` and the
segments read the same numbers as before; the search minimised `cost + shape_cost` per leg. A
single-leg route has no overlay and pays nothing for it.

The plan's edge overrides ride the same per-request layer ([next](#this-plans-exceptions)).

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

## This plan's exceptions

A plan carries a few exceptions to its profile, by edge (`overrides`: `{ edge, kind }`, each edge at
most once, ids checked; `overrides.rs`). They apply to every leg, per request, on top of the compiled
profile, which stays compiled and cached: an `Overrides` (a bit per edge, a map for the few marked,
like the reuse overlay) replaces the cost of its arcs in the search, the snapping, the pocket check and
the partial arcs at the waypoints.

- **avoid**: the edge costs `AVOID_M` = **100 km** more per full arc, in either direction. A finite
  penalty, not a closure: the route takes any other way that costs less than 100 km more, and when
  there is none (a dead end, a bridge) it still routes and says so (a note, and the edge in
  `overrides`). A stop on the edge still works: a part of the edge costs that part of the penalty, so
  the route leaves by the nearer end and rides no more of it than it must.
- **prefer**: the edge counts `min_factor × length` plus its additive terms (climbing, barriers): as
  cheap as the profile's bounds allow, the Detours slider's floor (in the structured model, which has
  no floor, 1 × length: the best a way can be). The limits do not close it.
- **allow**: the limits do not close the edge; it is costed as the profile has it without them. A
  bicycle ban and one-way still hold (for prefer too): an exception never makes a route illegal in a
  way the profile cannot switch off either.

**The bound.** A prefer or an allow can make an arc cheaper per metre than anything the compile
produced (the A* bound is the smallest compiled factor). The search's bound is then the smaller of
that and the cheapest override's cost per metre (`Overrides::bound`), so it stays consistent; a test
checks a preferred detour that only the lowered bound finds, and random grids against Dijkstra over the
override costs. Avoid only adds.

**What the result says.** `summary.cost` and `legs[i].cost` stay the profile's cost of the line (an
allowed arc at its cost without the limits); `override_cost` is what the exceptions added (< 0 where a
preferred way counts less; the search minimised `cost + shape_cost + override_cost`). `overrides` lists
the overridden edges the route rides, with the metres on each: the preferred and allowed ways it uses,
the avoided ones it could not get around. `explainEdge` and `compare` take the same `overrides`:
`plan_override` names the edge's exception, an arc's `cost` is what the router counts with it, and
`base_cost` what it would count without (avoid, prefer); the limits an allow or a prefer lifts move from
`closed_by` to `lifted`. A `compare` side counts the exceptions in its `cost` and lists their length
by kind (`overrides`).

**"This segment".** A rider means the way between junctions, not a graph edge: `edge_run(edge)` extends
the edge through every node where only one other edge meets it (nothing branches off), up to the next
real junction or dead end (at most 256 edges), and returns the edges in order, their length and the
line. Avoiding one edge of such a chain avoids all of it for a route through it anyway; preferring or
allowing needs all of it, so the planner applies an exception to the whole run.

Edge ids hold for one build of the region only: the planner saves the build id with a plan's
exceptions and drops them on another build ([planner.md](planner.md#persistence)).

## Turns

Turning is not free: without a cost for it, any slightly cheaper parallel bit wins, and a route leaves
a road for 200 m of gravel and rejoins it at once. The profile's `turn_m` ([profile.md](profile.md),
default **20**, 0 turns it off) is what a right-angle turn at a junction costs, metres-equivalent, the
same under every profile's factors (a fixed cost like barriers). Per move from one arc onto the next
(`turns.rs`):

- **No junction, no turn**: a node with fewer than three edges costs nothing, however it bends.
- **By angle**: the heading change θ to the way taken counts from 30° (straight on and small kinks are
  free), `turn_m` at 90°, twice it from 150°: `clamp((θ − 30°) / 60°, 0, 2)` turns.
- **Leaving the through road** (not taking the straightest way on) costs at least half a turn, phased
  in over the first 30° by which the way taken is less straight than it (a fork of near equals costs
  next to nothing either way). Following the straightest way costs only its bend. So leaving a road at
  45° and rejoining it at 45° costs ¾ of a turn; off and on at right angles two.
- **A U-turn** (back along the arc just ridden) costs twice a turn, the most there is, so it never buys
  a cheaper turn later. The search takes one only as the first move from a via (where the reuse
  layer's U-turn cost comes on top, [above](#dont-ride-the-same-way-twice)), mid-edge or at its node.
- The turn at a via (from the arrival onto the next leg) belongs to the next leg.

The headings are a byte per adjacency slot (1.4° steps), from the geometry ~15 m from the node so a
tiny kink at the junction does not count, built once with the planner; with the web app's lazy
geometry (`?geometry=lazy`) they come from the straight segments (so routes there may differ a little,
but stay the same once the geometry arrives).

**The search** needs the way a node was reached by, so a label is an arc ([below](#search)). The
result says what the turns cost: `summary.turns` / `legs[i].turns` count the moves that cost
something, `turn_cost` what they cost; both are part of `cost`, the profile's cost of the line (the
compiled cost of every arc plus its turns), and `shape_cost` stays the reuse layer's. `compare` and
`stretch_costs` count them per stretch, the moves onto and off it included (where a detour leaves the
other route and rejoins it), in its `cost`, with `turns` and `turn_cost` beside: a stretch that loses
for two turns says "2 turns, +15 m" (the CLI's `--explain` and `--why-not` print it).

**The strength, from the rider's rides** (`kompass replay`, the route-quality report's 24 legs of
10 rides, 348 km ridden; BRouter's lines on the same legs; aggregates only):

| line, `turn_m` | reproduced (all / median leg) | on ridden | ascent m / 100 km | unpaved | roadside cycle path km | beside busy road km | turns / km | zigzags | excursions |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ridden | 100 % | 100 % | 1276 | 17 % | 54.6 | 48.4 | 1.53 | 215 | 18 |
| Gravel explorer, 0 (before) | 36 % / 34 % | 38 % | 1700 | 47 % | 26.2 | 20.8 | 1.72 | 202 | 11 |
| Gravel explorer, 15 | 38 % / 34 % | 40 % | 1653 | 46 % | 27.5 | 22.3 | 1.56 | 169 | 8 |
| **Gravel explorer, 20** | **38 % / 34 %** | **40 %** | **1582** | **45 %** | **32.1** | **26.2** | **1.48** | **155** | **7** |
| Gravel explorer, 30 | 38 % / 34 % | 40 % | 1569 | 45 % | 34.5 | 26.1 | 1.44 | 145 | 8 |
| Gravel explorer, 60 | 38 % / 34 % | 41 % | 1574 | 42 % | 40.9 | 32.7 | 1.32 | 124 | 8 |
| Paved & quiet, 0 (before) | 37 % / 26 % | 34 % | 1115 | 0 % | 100.4 | 82.0 | 1.56 | 244 | 19 |
| **Paved & quiet, 20** | **37 % / 26 %** | **33 %** | **1111** | **0 %** | **98.9** | **81.2** | **1.42** | **196** | **17** |
| Paved & quiet, 60 | 37 % / 26 % | 34 % | 1112 | 0 % | 99.0 | 82.0 | 1.27 | 163 | 13 |
| BRouter gravel | 41 % / 34 % | 41 % | 1395 | 28 % | 46.7 | 40.1 | 1.33 | 145 | 4 |
| BRouter trekking | 43 % / 43 % | 44 % | 1018 | 7 % | 83.0 | 68.6 | 1.15 | 141 | 9 |

An **excursion** is the playtest's complaint measured: the line leaves a way, rides at most 500 m
elsewhere and rejoins it where that way, followed straight on from where the line left it (same way
type, no turn of 45° or more), gets in at most 1.5 times the excursion's length. On the legs they are
few, so the seeded pairs count them too (`kompass compare`, 40 pairs of 30–60 km, the shortest way with
turns free as the reference):

| profile, `turn_m` | detour p50 / p90 | unpaved | turns / km | zigzags | excursions |
|---|---:|---:|---:|---:|---:|
| Gravel explorer, 0 | 1.17 / 1.20 | 55 % | 1.62 | 1270 | 45 |
| Gravel explorer, 15 | 1.17 / 1.22 | 54 % | 1.44 | 1021 | 25 |
| **Gravel explorer, 20** | **1.17 / 1.21** | **54 %** | **1.41** | **978** | **22** |
| Gravel explorer, 30 | 1.17 / 1.22 | 54 % | 1.35 | 902 | 18 |
| Gravel explorer, 60 | 1.18 / 1.21 | 53 % | 1.21 | 762 | 19 |
| Paved & quiet, 0 | 1.21 / 1.50 | 0 % | 1.52 | 1395 | 81 |
| **Paved & quiet, 20** | **1.20 / 1.50** | **0 %** | **1.36** | **1152** | **59** |
| Paved & quiet, 60 | 1.21 / 1.50 | 0 % | 1.21 | 925 | 41 |
| (shortest way) | 1.00 | 24 % | 1.19 | 897 | 37 |

20 m is the knee: it halves the excursions on the pairs (45 → 22) and brings the Gravel explorer's
turns per km to the rider's (1.72 → 1.48 against 1.53) for two points more overlap with the rides,
less climbing and a little less unpaved, without a longer detour. Stronger costs buy few more
excursions and push the route onto straight roadside cycle paths (+15 km beside busy roads at 60, of
348). The zigzags were already below the rider's before and drop further: fewer quick left-right
moves is what the turn cost is for. The excursions left are ones the profile's own preferences pay
for (a long enough gravel piece). Leaving the through road at half a turn rather than by angle alone
removes a few more of them (seeded pairs at 20: 24 → 22, at 30: 21 → 18) and changes nothing else.
Paved & quiet gives up one point of "on ridden" (34 → 33 %) for 40 % fewer zigzags.

## Search

Plain A* per leg (spike #4: no landmarks, no corridor, no contraction), from the snapped point to the
snapped point: the search starts with labels on the source edge's two end nodes (the partial arcs
from the point) and ends at the target edge's end nodes plus the partial arc into the point (and the
turn onto it); two points on one edge also try the direct way. The bound is the straight line × the
smallest factor the compile produced (the structured model: the smallest factor plus hills metres
per metre, since the curve may be below 1), on a plane that never overestimates, so it is consistent.

A label is an **arc**, having arrived at its head by it, because the turn cost depends on it. Beside
the labels each node keeps its cheapest label so far, and a label dearer than that by more than the
most a turn there can cost (a byte per node, from the headings: 0 at a node that is no junction) is
dominated and dropped. That is exact: whatever way on the dominated label could take, the cheaper one
takes for less, except back where the cheaper one came from, and a path that does that is beaten
where it parts from the cheaper label's own path (no U-turns on the way is what makes this hold). With
turns free it is the plain node search (every node settles once, the same settled counts as before);
with them a junction settles about once more per way in worth keeping. Tests check every route and leg
against a Dijkstra over arcs with the turns, the reuse layer and the plan's overrides. The search state
(a label per arc and per node, 8 bytes each: 52 MB for 2.3 M edges, was 22 MB) is reused with a
generation counter: a query allocates only the result.

Real region, native, release, one thread on the shared 6-core VM (`kompass bench`, 100 seeded pairs
per bucket, routes that compile, snap, search and assemble geometry, segments and reasons), with the
default turn cost; before it (node labels) in brackets:

| route | Gravel explorer ms p50 / p95 / max | Paved & quiet | settled p50 | result JSON |
|---|---:|---:|---:|---:|
| ~11 km | 2.0 / 5.0 / 8.8 (1.6 / 3.6 / 4.8) | 2.1 / 4.3 / 5.6 (1.6 / 3.1 / 4.1) | 10 k (10 k) | 22 KB |
| ~57 km | 13.3 / 22.7 / 26.8 (9.5 / 15.0 / 19.1) | 12.6 / 23.6 / 51.3 (9.2 / 18.0 / 40.2) | 94 k (87 k) | 86 KB |
| ~112 km | 48.5 / 67.0 / 77.2 (34.4 / 47.5 / 55.9) | 39.2 / 68.2 / 82.1 (29.5 / 52.0 / 61.3) | 336 k (311 k) | 165 KB |

So exact turn costs cost about 40 % more time per route (most of it per label: the turn shares at each
junction, the larger state), 37 MB more memory and 0.2 s more when the planner is built. Turns off
(`turn_m` 0) settle what the node search settled, at about 10 % more time (the arc-sized state).

Compiling: 38 ms (Gravel explorer, per-arc climb terms), 21 ms (Paved & quiet). The spike measured
11.0 / 16.7 ms for the search alone at 50 km and 42 ms per compile; wasm in a worker was ~1.2× native
and a 6×-throttled phone estimate ~7×.

## Result

- `summary`: distance, ascent and descent (beyond the noise deadband, [profile.md](profile.md)), a
  rough duration (speed by surface, slower on narrow paths, walking on `dismount`, carrying on steps,
  faster downhill, plus 1 h per 900 m climbed), cost (the profile's, turns included), the turns and what
  they cost ([above](#turns)), the metres ridden twice and the shape costs on top
  ([above](#dont-ride-the-same-way-twice)), unpaved and unknown-surface shares,
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
  factor, `< 1` made it cheaper, `> 1` dearer). Under a structured profile only what counts (per
  group the strongest bonus and penalty), plus `tiers` (the segment's row and tier per board) and
  `hills_m` ([profile.md](profile.md#the-structured-model-prototype-behind-a-switch)).
- `breakdown`: length and share per surface and per way type, longest first; ridden vs. new with a
  personal layer; `touched` per named preference; under a structured profile `rows` (length per board
  row) and `grades` (length per 1 % grade band as the hills curve reads it). `legs`: per leg the same totals and its ranges of arcs and segments.
- `waypoints`: where each one snapped (point, distance, edge, fraction, `excluded_by`). `notes`.
- `overrides`: the plan's exceptions the route rides ([above](#this-plans-exceptions)).

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
it: `codes[code − 1]`, a limit id, `no_bikes`, `oneway`, `avoided_surface` or `avoided_way`), and
`minFactor`, `maxFactor`, `bound`.
Native: every edge of the demo region (51 k) in 1.3 ms, 25 k listed in 0.5 ms, a box of 2.4 k in 0.08 ms
(so ~60 ms for 2.34 M); the browser worker: 2.2 ms for the 51 k, 1.2 ms for 25 k listed (round trip
included, `?bench`).

**`explainEdge`: the segment inspector** ([planner.md](planner.md#the-segment-inspector)). `{ profile, edge, overrides? }` → `EdgeExplanation`: the way type, the reported
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
Under a structured profile each preference says whether it `counted`, the additive terms include
`hills`, and `structured` has the boards' rows and tiers, what counts per group, `best`, `relative`,
`detours` and the hills curve's reading ([profile.md](profile.md#the-structured-model-prototype-behind-a-switch)).

**`compare`: why not this way?** Route as usual, route again with a via on the wanted line, then
`compare({ profile, a, b, overrides? })` with both routes' `arcs` and the profile (and the plan's
exceptions) to judge them by. The answer: both
whole routes and every `diff` stretch, each side a `StretchCost`: its span, cost under the profile
(closed arcs at `max_factor` per metre, as near a waypoint), mean factor, additive metres, length at the
clamp (`clamped_min_m`: the bonuses wanted it lower, more seeking changes nothing; `clamped_max_m`),
the up to five strongest preferences (length-weighted geometric mean factor), the way types and the
length on closed arcs by closure (structured: also `rows`, length per board row, and `hills_m`), the
turns (`turns`, `turn_cost`, in `cost`: [turns](#turns)); per
stretch `cost_delta` (b − a; > 0 is why the router took `a`) and
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
- turns (≥ 45° at a junction) per km, zigzags (a turn the other way within 300 m) and short excursions
  (leaving a way and rejoining it at once, [turns](#turns));
- where the judge's route leaves the ridden line: the `compare` stretches of ≥ 300 m with a first grouping.

Stdout holds numbers and ride/leg indices only; `--out-dir` gets the private detail (`legs.json` with the
end points, a GeoJSON per leg with every line, `stretches.txt`), so it belongs under `data/` or a temporary
directory. The first round is [the route-quality report](reports/2026-11-21-route-quality.md).
`--personal <explored.json>` routes with a ride history (`kompass match --explored`, best without the
replayed rides: the playtest's condition), also private.

**How far one control moves a route**: `kompass sensitivity --build <dir> --profiles <a,b,...>
[--pairs 30] [--km 15-35] [--personal <explored.json>]` (spike #60's measure, for both models): on
seeded pairs (never printed), every control nudged one step each way (a slider ±25, a board row one
tier, a hills handle × or ÷ 1.25, the loose modifier ±10, detours ±0.25), the share of the route's length
that changes, averaged; plus the length at the floor and the mean factor under each profile's own
model.
