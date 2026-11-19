# Kompass: architecture (starting point)

> **Bootstrap document.** This is the brainstorm's proposal, a rough starting point and not a
> plan to follow strictly. Retire it quickly: as each part gets built, its real shape goes into
> `docs/` (lightweight, high-level concepts only; the code is the source of truth), and the
> matching section here gets deleted. Spikes may overturn anything below.

## Shape

```
  ┌──────────── BUILD (batch, ~weekly, local) ─────────────┐
  │ OSM extract (region clip) + elevation + POIs           │
  │   → pipeline/ (Python): filter, split, enrich          │
  │   → edges.parquet            ← the contract            │
  │   → engine compile (Rust): graph tiles (.bin)          │
  │   → overlay vector tiles (.pmtiles, edge id + attrs)   │
  │   → base map extract (.pmtiles, Protomaps)             │
  └────────────────────────────────────────────────────────┘
                         │ static files
  ┌──────────────────────┴──── BROWSER (no backend) ─────────────────┐
  │ engine (Rust → WebAssembly, in a Web Worker)                     │
  │   snap · route · loop · lookahead · analyze · match_track        │
  │ web app (bun, Vite, React, shadcn, Tailwind, MapLibre GL)        │
  │   planner · ride mode · explored map · debug map                 │
  │ personal data in IndexedDB: tracks, history, profiles,           │
  │   corrections. Export/import as a file for backup and sync.      │
  └──────────────────────────────────────────────────────────────────┘
  Later, only if needed: a tiny proxy (e.g. a Cloudflare Worker) holding the LLM API key;
  the agent's tools still run in the browser.
```

**Static PWA, no backend.** During development it's served from the dev VM over Tailscale.
Later: GitHub Pages for the app, and Cloudflare (R2) for the large data files if needed.

## Pipeline (Python, uv)

- Input: an OSM extract clipped to the region (a 100 km radius to start; the centre lives in a
  gitignored local config, never in the repo). The radius crosses state borders, so it's
  clipped from a larger Geofabrik extract.
- Steps: keep bike-routable ways, split them at junctions, and derive attributes per edge:
  - **Surface:** `surface`, `tracktype`, `smoothness`, with *unknown* kept explicit.
  - **Road type:** `highway` class and cycleways (including paved paths away from the road).
  - **Traffic proxy:** road class, `maxspeed`, `lanes`.
  - **Legal access:** `access`, `bicycle`, and state rules such as forest-path rules.
  - **Context, from spatial joins:** share of the edge inside forest, along a forest edge,
    near a river or lake, built-up vs. open land.
  - **Terrain:** elevation sampled along the geometry, ascent per direction, max gradient.
  - **Sketchiness:** `tracktype` grade4/5, path width, `trail_visibility`, `mtb:scale`, plus
    missing data.
- Graph-level: bridges and two-edge-connected components (cheap dead-end detection), and
  pruning of tiny disconnected components.
- Output: `edges.parquet`, one row per edge with geometry and attributes. It can be inspected
  with DuckDB or a notebook. Python is used for its geo libraries (pyosmium, geopandas, shapely,
  rasterio); hot spots can move to Rust later.
- Elevation: Copernicus 30 m to start, or the open DGM1 (1 m terrain models) of the German
  states.

## Engine (Rust)

- Crates: `core` (graph, cost, queries), `wasm` (wasm-bindgen, runs in a Web Worker),
  `cli` (native: `kompass route --profile gravel.json --from … --to …` → GeoJSON, for tests,
  golden routes, the BRouter comparison and agent tool development).
- **Graph tiles:** a compact adjacency layout (CSR), quantised attributes, geometry stored
  separately. Tiled from the start, so the phone loads only what it needs and bikepacking
  later just means more tiles.
- **Cost:** per request, the profile is compiled into a cost per edge (a few ms for about 2M
  edges). Cost = length × positive factors, so the search stays correct. Hard constraints
  remove edges. A* uses the smallest factor the profile allows as its lower bound. Regional
  scale needs none of the heavy speedups big routing engines use (contraction hierarchies).
  Waypoints split the route into legs, and each leg searches a corridor.
- **Queries:**
  - `route`: A→B through waypoints and zones, profile per leg.
  - `loop`: start, distance, bearing or sketched shape; a novelty prize.
  - `lookahead`: a bounded search per branch at the next junction.
  - `analyze`: surface, traffic, climb and novelty breakdown, cost explanation.
  - `match_track`: map-matching with a hidden Markov model.
- **Base vs. personal layer:** the base graph is static. The personal layer is arrays indexed
  by edge: ridden count and last ridden per direction, corrections, ridden today. Importing a
  ride never rebuilds the base graph.
- **Raw tracks are the source of truth.** Edge IDs change on rebuilds, so per-edge history is
  always re-derived by matching the tracks again. Corrections are stored by OSM way ID plus
  position, so they survive rebuilds.

## Profile

- One schema, defined in Rust (serde), with a JSON Schema generated from it (schemars) and
  TypeScript types generated too (ts-rs). The same schema becomes the agent's `set_profile`
  tool. The sliders, the LLM and the engine can't drift apart.
- It contains hard constraints, soft weights (surface, road class, traffic, context bonuses,
  climb, novelty mode) and personal overrides. A preset is a saved profile.

## Map rendering

- **MapLibre GL JS** draws vector tiles in the browser (WebGL).
- **Base map:** a Protomaps PMTiles extract for the region. A PMTiles file is a single file
  holding all tiles; the browser fetches the parts it needs with HTTP range requests, so no
  tile server is needed, and it can be cached for offline use.
- **Overlay:** the routing edges with their attributes and edge IDs, turned into PMTiles by
  tippecanoe. MapLibre style expressions colour the overlay by any attribute (the debug map),
  and switching views needs no regeneration.
- **Personal data on the map:** MapLibre `feature-state` colours overlay edges by edge ID from
  history held in IndexedDB (the explored map), so personal data never has to become tiles.
  Routes and the live trail are drawn as GeoJSON.

## History import

- A Komoot download script runs locally as a CLI. Komoot's API isn't public and can't be
  called from the browser. I run the script myself with my own login.
- GPX (Komoot) and FIT (Garmin) files are dropped into the app. They're map-matched in the
  browser and deduplicated by overlapping time.

## Ride mode (later)

- Foreground GPS with the screen kept on (Wake Lock). A PWA gets no reliable GPS in the
  background, so gaps in the live trail are filled by map-matching between points.
- Lookahead runs in WebAssembly with tiles cached on the phone, so it works offline in forest
  dead zones.
- If iOS turns out too limited, wrap the app with Capacitor without rewriting it.
- Garmin: a Connect IQ data field fed from a phone or server is possible later. Pushing the
  planned route as a course (GPX/FIT) is the easy first step.

## Repo layout

```
kompass/
  pipeline/   Python (uv): OSM → edges.parquet
  engine/     Rust workspace: core, wasm, cli
  web/        TypeScript (bun, Vite, React, shadcn, Tailwind, MapLibre)
  data/       region builds, local config, tracks (gitignored)
  docs/       high-level concepts, ADRs
```

## Things to keep in mind

- OSM gaps: many tracks lack `surface`. Keep *unknown* explicit and let personal corrections
  fill in over time.
- OSM has no traffic volumes. "Quiet" is a proxy; official German count data may help.
- Evaluation: compare against BRouter's gravel profile, and use my own history as ground truth.
- Privacy: the repo is public. No home location, tracks, names, tokens or hostnames go into
  the repo.
