# The graph format

The engine's routing graph on disk: what `kompass compile --build <dir>` writes from
`edges.parquet` ([the contract](edges-parquet.md)) and what `kompass-core` loads, natively and in the
browser. The design and its numbers come from spike #4 (verdict in the issue). Code:
`engine/core/src/{format,graph,attrs,geometry,assemble}.rs`, the compiler in `engine/compile/`.

## Shape and why

- **Tiles as the file layout, the whole region in memory.** The graph is cut into web-mercator tiles
  at **z11** (about 250 files of at most 1 MB for a 100 km region; tiling costs ~5 % in compressed
  bytes over one blob). The app loads every tile of its region up front and appends them into one
  graph: the search stays synchronous and sees everything. The files are cached and revalidated one
  by one. Later, bigger regions can load a corridor of tiles before a search; the loader already
  takes tiles in any order and says which are missing.
- **Columns, not records** ("struct of arrays"), quantised to about **32 bytes per edge** including
  the nodes. Coordinates, endpoints and length are 80 % of the compressed size; the packed
  attribute bytes compress to almost nothing.
- **No adjacency on disk.** The CSR adjacency is rebuilt at load by a counting sort over the
  endpoints (~35 ms native for 2.3 M edges): that saves a third of the file and loads faster than
  it downloads.
- **Geometry apart.** The search needs only node coordinates; the polylines (and the OSM way
  references) are separate files per tile that can load later or not at all.
- **Readable without `unsafe`**: every section is copied out with `from_le_bytes`.

## Ids

- **Edge ids are `edge_id` of `edges.parquet`** (its row numbers, Hilbert-sorted), and so the overlay
  tiles' feature ids. They are not stable across builds; everything is tied together by the build id.
- **Nodes are numbered by first appearance along the edges**, so every tile is a contiguous range of
  edges *and* of nodes (a node belongs to the tile of its first edge). Edge endpoints are global node
  ids; about 1 % of the edges join nodes of two tiles.
- An **arc** is an edge in one direction: `edge << 1 | reverse`, `reverse = 0` along the geometry
  (from → to). Per-arc arrays (the compiled costs) are indexed by it.

## Files

`<build>/graph/`, listed in `manifest.json` (paths relative to the manifest):

| file | what |
|---|---|
| `index.kmpg` | build id, counts, bounds, the tile table |
| `tiles/<z>-<x>-<y>.kmpg` | one tile's nodes and edges |
| `geometry/<z>-<x>-<y>.kmpg` | one tile's edge geometry and OSM way references |

```json
"graph": { "formatVersion": 1, "buildId": "…", "tileZoom": 11, "nodes": 1822503, "edges": 2340341,
  "bytes": 120804952, "index": { "file": "graph/index.kmpg", "bytes": 9960 },
  "tiles": [ { "x": 1, "y": 2, "edges": 7400,
               "graph": { "file": "graph/tiles/11-1-2.kmpg", "bytes": 230000 },
               "geometry": { "file": "graph/geometry/11-1-2.kmpg", "bytes": 140000 } } ] }
```

`kompass compile` writes the files into `graph.part/`, swaps the directory in, then rewrites the
manifest through a temporary file (other keys and their order stay). It refuses a manifest whose
`buildId` is not the parquet's. The web app validates the key (`web/src/map/manifest.ts`).

## The container

Every file is one `KMPG` container, little endian:

| bytes | field |
|---|---|
| 0..4 | magic `KMPG` |
| 4..6 | u16 format version (**1**) |
| 6..8 | u16 kind: 1 index, 2 graph tile, 3 geometry tile |
| 8..12 | u32 section count |
| 12..16 | reserved, 0 |
| 16.. | section table: per section `[u8; 8]` name (padded with `_`), u64 offset, u64 length |

Then the sections, each 8-byte aligned (zero padding), each one array of one primitive type. A
reader looks sections up by name, so new sections can be added without breaking old readers; a
change to an existing section bumps the format version, and so does any change to the enum codes
or the packing below.

### Index (kind 1)

| section | type | content |
|---|---|---|
| `build_id` | UTF-8 | `kompass:build_id` of the parquet (= the manifest's `buildId`) |
| `counts__` | u64 × 4 | node count, edge count, tile zoom, parquet schema version |
| `bbox____` | i32 × 4 | bounds of every point, 1e-7°: min lon, min lat, max lon, max lat |
| `tiles___` | u32 × 6 per tile | x, y, node start, node end, edge start, edge end (in order: the ranges partition the nodes and the edges) |
| `tilebbox` | i32 × 4 per tile | bounds of the tile's edges (all their points) |

### Graph tile (kind 2)

`build_id` as in the index, `tile____` (u32 × 9: zoom, x, y, node start, node end, edge start,
edge end, total nodes, total edges; checked against the index), then one section per column for
the tile's range:

| section | type | per | meaning |
|---|---|---|---|
| `lon_____`, `lat_____` | i32 | node | coordinates in 1e-7° (OSM precision) |
| `from____`, `to______` | u32 | edge | end nodes (global ids); the geometry runs from → to |
| `len_dm__` | u16 | edge | length in decimetres (edges over 6553.5 m are rejected; the longest real one is 5.1 km) |
| `highway_` | u8 | edge | `highway` code |
| `surf____` | u8 | edge | `surface_class` bits 0–2 · `tracktype` 3–5 · one-way 6–7 (0 both, 1 along, 2 against) |
| `smooth__` | u8 | edge | `smoothness` 0–3 · `trail_visibility` 4–6 · `informal` 7 |
| `access__` | u8 | edge | `bike_access` 0–3 · `motor_access` 4–6 · `mtb_route` 7 |
| `road____` | u8 | edge | `cycleway_kind` 0–2 · `route_level` 3–5 · `on_bridge` 6 · `in_tunnel` 7 |
| `speed___` | u8 | edge | maxspeed in 5 km/h steps 0–4 (0 unknown, saturates at 155) · `lanes` 5–7 (0 unknown, 7 = 7+) |
| `diff____` | u8 | edge | `mtb_scale` 0–2 · `sac_scale` 3–5 · `n_barriers` 6–7 (saturates at 3) |
| `ctx_____` | u16 | edge | shares in fifteenths (0..15 = 0..100 %): forest 0–3 · forest edge 4–7 · water 8–11 · built-up 12–15 |
| `ctx2____` | u8 | edge | `road_near_share` 0–3 (fifteenths) · width 4–7 (0 unknown, k × 0.5 m, 15 = 7.5 m+) |
| `asc_fwd_`, `asc_bwd_` | u16 | edge | ascent along / against the geometry, decimetres (descent one way is ascent the other) |
| `grd_fwd_`, `grd_bwd_` | u8 | edge | steepest 50 m along / against, whole percent |

The enum codes are those of `edges.parquet`. The engine's enums (`attrs.rs`) are checked against
them twice: a unit test compares them with the generated `docs/edges-parquet.md`, and the compiler
compares them with the `kompass:enums` metadata of every file it reads. Not carried (the profile
does not need them): `service`, `surface` (raw), `maxspeed_src`, `foot_access_no`, `segregated`,
`is_sidepath_tag`, `lit`, `name`, `ref`, node elevations.

### Geometry tile (kind 3)

`build_id`, `tile____` as above, then:

| section | type | content |
|---|---|---|
| `geo_off_` | u32 × (edges + 1) | byte offset of each edge's record in `geo_dat_`, then the end |
| `geo_dat_` | bytes | one record per edge |

A record is a run of varints (LEB128; signed values zigzag-encoded): the number of interior points;
per interior point the delta in **1e-6°** (about 10 cm) from the previous point, x then y, starting
from the `from` node; then the OSM way: `way_id`, `way_pos_from`, `way_pos_to − way_pos_from`. The
end points are the graph's nodes. The way comes last so walking the points (snapping, drawing)
never decodes it; it is kept for corrections, which are stored by way id and position and so
survive rebuilds.

## In memory

`GraphLoader::new(index)` allocates every column for the whole region (the index has the totals);
`add_tile(bytes)` copies a tile into its ranges, in any order; `finish()` builds the CSR adjacency
over what is loaded. Edges that touch a node of a missing tile are left out of the adjacency, so a
search never reaches them; `missing_tiles()` lists them and `Graph::into_loader()` adds more later.
Geometry tiles are added on the loader or the graph at any time.

The CSR lists, per node, every edge once as the arc leaving it, with two flags: one-way allows the
arc (`OUT`, the forward search) and allows the opposite arc arriving here (`IN`, a backward search).
`out_arcs` / `in_arcs` filter by them; `arcs_at` gives all of them (map-matching follows tracks that
ride against a one-way). Legal access is not in the adjacency: it is the profile's call, and hard
constraints are infinite costs.

The snapping grid (200 m cells over the segments' bounding boxes, `spatial.rs`) is built after
loading, not shipped: it follows the geometry when loaded, else the straight segments between nodes.

## Sizes (a 100 km region, 2.34 M edges, 1.82 M nodes)

| | raw | gzip -6 (sum of files) |
|---|---:|---:|
| graph tiles (244) | 75.6 MB | 33.9 MB (largest 1.0 MB) |
| geometry tiles (244) | 45.2 MB | 29.0 MB (largest 0.5 MB) |
| index | 10 KB | |

Native, release: compiling takes 2.1 s (0.3 GB peak), loading the tiles 50 ms plus 35 ms for the
adjacency and 30 ms for the geometry; in memory the graph is 106 MB with its adjacency and 156 MB
with the geometry; the snapping grid is 20 MB and builds in 0.4 s; a nearest-edge query takes
10 µs median and 35 µs p95.
