# Map-matching

Recorded tracks (the ride library, [rides.md](rides.md)) are matched onto the routing graph to find
the arcs ridden: the input of the explored map and, later, of the route query's personal layer. The
algorithm and its parameters come from spike #5, measured on a real history of 185 rides; do not tune
them without re-measuring. Code: `engine/core/src/matching/`; the command line driver is
`kompass match` (`engine/cli/src/matchcmd.rs`).

## Algorithm

A hidden Markov model after Newson & Krumm. Points are thinned (kept once 15 m from the last kept
one, the last always). Per kept point the candidates are the nearest edges within 40 m (at most 8,
the nearest point on each edge's *geometry*); emission is a Gaussian of the GPS distance (σ 8 m);
transition is `exp(-|network distance − great-circle distance| / β)` (β 8 m) where the network
distance comes from a bounded Dijkstra over **all** arcs (a one-way only costs ×1.3, access is
ignored: riders ride against one-ways and on forbidden ways; detour bound `2 × gc + 150 m`). Viterbi
picks the sequence, the Dijkstra is rerun between the chosen candidates for the path. A point with no
reachable candidate is skipped (bridged by the network path); after 200 m of skipped track, or a 2 km
jump between kept points, the chain **breaks** and a new one starts: the track between chains is an
*unmatched stretch*. Finally the **spur clean-up**: a turn-back on one edge shorter than 30 m is GPS
noise (jitter while standing, a detour into a short side edge) and is removed; without it the explored
map grows false stubs.

| parameter | value | | parameter | value |
|---|---|---|---|---|
| `min_step_m` | 15 | | `radius_m` / `max_candidates` | 40 / 8 |
| `sigma_m` | 8 | | `beta_m` | 8 |
| `oneway_penalty` | 1.3 | | `detour_factor` / `detour_slack_m` | 2 / 150 |
| `max_skip_m` / `max_gap_m` | 200 / 2000 | | `spur_m` | 30 |

The search state is a small hash table (a search settles ~20 nodes), not arrays sized to the graph.

## Lazy geometry

Matching needs the edge geometry: on straight node-to-node segments 6.7 % of the track goes unmatched
instead of 0.2 %. Geometry loads per tile (`Graph::add_geometry`, any order, any time) and a history
touches a quarter of a region's tiles, so the browser fetches only those:

1. `needed_tiles(graph, radius, lat, lon)` (or `Matcher::tiles_needed`) names the tiles whose edges a
   track can touch, from the points alone; `missing_geometry` keeps those without geometry.
2. Fetch the geometry files of those tiles (and any graph tile not loaded) and add them.
3. Match. `TileGrids` holds one snap grid per tile, built on demand for the tiles of the track and
   rebuilt when a tile's geometry or graph tile arrived since. A tile **without geometry falls back
   to straight segments** (a worse match, never an error).

## API

Plain typed arrays in and out (no serde), for the wasm face:

```rust
let mut matcher = Matcher::default();            // params: MatchParams, the spike's defaults
let mut grids = TileGrids::new(&graph);          // one per graph; keep it between rides
let tiles = matcher.tiles_needed(&graph, &lat, &lon);       // &[f64] or &[f32]
// … add geometry for `missing_geometry(&graph, &tiles)` …
let r: MatchResult = matcher.match_arrays(&graph, &mut grids, &lat, &lon);
```

`MatchResult`: `arcs` (`edge << 1 | reverse`, riding order, spurs removed, consecutive pieces merged;
an arc can repeat in a loop), `coverage` (per arc: the covered share of the edge × 255), `first_point`
(per arc: the first track point that covered it), `unmatched` (`first_point`, `last_point`, `length_m`),
`track_m`, `matched_m`, `path_m`, `breaks`. `match_track` returns the richer `Match` (pieces with
start/end fractions, chains, counters) that the CLI uses for GeoJSON; `Match::to_result` flattens it.
Non-finite points are skipped. Rides are independent: match them one at a time (a ride takes
~40 ms per 100 km natively), cancel between rides.

## The explored rule

`matching::Explored::fold(rides)`, rides as `RideMatchRef { arcs, coverage, day }`: **an arc is ridden
by a ride when the ride's pieces on it cover at least half of the edge** (`coverage ≥ 128`; the pieces
of one arc add up, so passing an edge twice in one ride counts once). An edge is ridden when either arc
is. Per edge it yields `count` (rides, either direction), `last_day` and the same per direction
(`along`, `against`): sparse, sorted by edge id (`Explored::get`, `arc`), or flat arrays by edge id
(`to_flat`) for a query's personal layer. Days are days since 1970-01-01 UTC, 0 for an untimed ride.
The 50 % drops the stub at a ride's start and end; on real rides the threshold hardly matters (99.4 %
of (ride, edge) pairs are covered 99 % or more). A full refold after every import, delete or rematch
is cheap (a million arcs ~100 ms). Raw tracks stay the source of truth: matches belong to a graph
build and are re-derived after a rebuild.

## Quality check

`kompass match --build <dir> <gpx files or dirs>` prints aggregates only: rides (in the region,
partly, outside: a point is inside with an edge within 300 m), the matched share of the in-region
track, path / matched length, breaks and spurs per 100 km, time per 100 km, tiles loaded.
`--explored <file>` writes the fold as JSON, `--geojson <dir>` one file per ride; both hold real
tracks, so only into gitignored or temporary directories. The parameter flags (`--radius`, `--sigma`,
…) and `--no-geometry` reproduce the spike's sensitivity runs. On the spike's real history
(6,755 km): 99.79 % of the in-region track matched, path / track 1.0036, 0.65 breaks per 100 km,
25,637 explored edges; a change that moves these needs a reason.

## Known gaps

Rides on ways missing from the graph stay unmatched (0.17 % of the track); topology gaps (a path that
shares no node with the road it crosses) break the chain instead of jumping ≤ 50 m; parallel ways
(road + sidepath) are ambiguous for ~0.7 % of the ridden length and may switch sides; GPS drift along
unmapped forest paths snaps to a neighbour within 40 m. The 200 m skip and 40 m radius may need to
scale with the sampling interval for sparse recordings.
