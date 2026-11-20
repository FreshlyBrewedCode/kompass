# The engine in the browser

How the Rust engine runs in the web app: the wasm face, the worker and its protocol, the region graph
on the device, the states the UI shows, and the bench page. Code: `engine/wasm/`, `web/src/engine/`.

## Pieces

```
UI (React) ── engineStore() ── EngineClient ──postMessage──▶ worker.ts ── kompass-wasm Engine
  useEngine()   states, busy     call / latest                GraphStore     graph, planner, matcher
                                                              (Cache API)
```

- **`kompass-wasm`** (`engine/wasm/src/engine.rs`, plain Rust tested natively; `lib.rs` maps it onto
  wasm-bindgen): an `Engine` built from the index bytes, `addTile` / `addGeometry` (any order;
  geometry also after `finish`), `finish` (adjacency, snapping grid, edge classes: the `Planner`),
  then `route`, `prepare`, `diff`, `explain`, `arcCosts`, `regionCatalogue`, `setPersonal`, `snap`,
  `matchTiles` + `matchRide`, `info` (counts and heap by part), `benchPairs`. Free functions:
  `version`, `presets`, `catalogue`. The API types cross as JSON text (serde_json, the generated
  types in `web/src/engine/generated/`); big numeric payloads as typed arrays (graph files, track
  points, matched arcs and coverage, the personal layer, arc costs). A route result stays JSON:
  ~90 KB at 50 km parses in about a millisecond, below the noise of the route itself. 448 KB of
  wasm, 178 KB gzip.
- **The worker** (`worker.ts`) owns the engine and the graph files. Requests run one at a time in
  arrival order (one wasm object; a request may wait for files halfway). Each answer carries the
  worker's time (`ms`); typed arrays in params and results are transferred, not copied (a caller's
  `Float64Array` of points is empty after `matchRide`).
- **The client** (`client.ts`): `call(method, params)`, `timed(…)`, `latest(lane, method, params)`,
  `routeLatest(request)`, `cancel(lane)`, `onEvent(listener)`. `EngineMethods` in `protocol.ts`
  lists every method with its params and result.
- **The store** (`store.ts`, `use-engine.ts`): one engine per app (`engineStore()`), its state for
  React (`useEngine()`), `load(dataUrl, graph)`, `call`, `routeLatest(request, lane)`.

## Latest wins

The planner reroutes on every slider step. Per **lane** (one per line on the map: `route`, a
comparison, …) at most one request is in the worker. A request made while one runs waits; a newer
one replaces the waiting one, which resolves `SUPERSEDED` at once. The running one always delivers
its result: dropping it whenever a newer one waits would show nothing at all while a slider moves on
a phone where a route takes longer than a step. `cancel(lane)` makes the waiting and the running
request resolve `SUPERSEDED` (their results are stale). On a 30-step drag the worker sees 2
requests: the first and the last.

`route` never throws for a route that cannot be made: it answers `{ ok: false, error: RouteError }`
(`no_way_near`, `excluded`, …); exceptions are engine failures.

## Download and cache

The manifest lists every graph file (`docs/graph-format.md`) with its size and, since this task, the
size of its **gzip sibling** `<file>.gz` that `kompass compile` writes next to it. The worker
fetches the siblings and decompresses them itself (`DecompressionStream`, Safari 16.4+): a static
host needs no compression setup (GitHub Pages does not reliably compress big files), and a host that
compresses anyway (`Content-Encoding`) is detected by the bytes and still works. Sizes are checked
against the manifest; the engine checks every tile's build id against the index.

- **Cache API, one cache per graph build** (`kompass-graph-v<format>-<buildId>`), one entry per file
  under its URL, holding the **raw** bytes (decompressed once, so a start never pays for gzip).
  Cache API rather than OPFS: it works in Safari 17+ in a tab, in an installed PWA and in workers,
  stores `Response`s without a file-handle API (`createWritable` arrived in Safari only in 2025;
  sync access handles exist only in workers and lock the file), and its entries are per file, which
  is what resume needs. Both count against the same origin quota and are evicted alike under
  Safari's 7-day rule for sites without use; an installed PWA is exempt. After a load the app asks
  for persistent storage (`navigator.storage.persist()`).
- **Resume**: a start downloads only the files the cache lacks, six at a time, three attempts each.
  A download that stops halfway keeps what it stored.
- **A new build** downloads into a new cache; the caches of other builds are deleted once it has
  loaded. HTTP caching is bypassed (`cache: "no-store"`): file names do not change between builds.
- **No Cache API** (not a secure context, e.g. plain `http://` on a LAN address): every start
  fetches from the network.
- **Offline**: the service worker (`web/public/sw.js`, production builds only) keeps the app shell
  and the manifest (network first, the last good copy offline); the graph comes from the cache.
  The map's PMTiles are not cached yet: offline the planner routes over a blank map.

Order: everything onto the device first (state `downloading`, bytes over the wire), then everything
from the device into the engine (`loading`), then `finish`.

## Geometry: eager by default

Two ways, measured on the 100 km region (2.34 M edges, 244 tiles; desktop worker, headless
Chromium, the files on the same machine):

| | eager (default) | lazy (`?geometry=lazy`) |
|---|---:|---:|
| load from the device (planner build) | 1.68 s (1.25 s) | 0.88 s (0.67 s) |
| wasm heap after load | 209 MB | 167 MB |
| … after 120 routes all over the region | 245 MB | 287 MB |
| 50 km route p50 (gravel / paved) | 12.5 / 10.3 ms | 21.1 / 13.2 ms |

**Eager** adds every geometry tile before `finish`, so the snapping grid follows the drawn ways and
memory stays where it was after the two compiled profiles. **Lazy** builds the planner on the
graph alone: a route whose tiles lack geometry is assembled a second time after the worker added
them (the search is the same), a match adds the tiles `matchTiles` names first. It starts 0.8 s
faster and 42 MB smaller, but snaps waypoints to straight segments between nodes (a tap on a curvy
path can snap to a neighbour), pays the second pass in every new area, and the heap ends higher
once the geometry has trickled in (the appended buffers grow by doubling). Both cache every file,
so both work offline. Eager wins on predictability; the phone's numbers decide whether the 0.8 s
(times the phone factor) matter. The planner build is mostly the snapping grid: the place to
optimise if a phone start is too slow.

## States

`engineStore()` → `{ status, busy, version }`:

| status | when | fields |
|---|---|---|
| `idle` | no region graph asked for (no manifest `graph`, no region) | |
| `downloading` | files are missing on the device | `done`, `total` bytes over the wire |
| `loading` | reading the files into the engine, building the planner | `done`, `total` bytes |
| `ready` | routes and matches | `buildId`, `stats` (`LoadStats`: download and load times, bytes, heap) |
| `error` | a download or load failed | `message`; `load` again retries (and resumes) |

`busy` is true while any request through the store runs. The app starts the load as soon as the
region manifest has a `graph`; the pill top right (`EngineStatus`) shows the state ("region data
12.3 of 66.3 MB").

## Matching and the rides seam

`engine.call("matchRide", { lat, lon })` (degrees, `Float64Array`s) loads the geometry tiles the
track needs (from the device), matches it (`docs/matching.md`) and returns
`{ graphBuild, arcs, coverage, firstPoint, unmatched, trackM, matchedM, pathM, breaks, tilesLoaded }`.
The ride store saves it with `saveMatch(rideId, { graphBuild, arcs, coverage, firstPoint?, trackM?,
matchedM? })` (`docs/rides.md`); its explored fold applies the matching's 50 % rule in TypeScript
(where the matches are: the ride worker), so nothing crosses to the engine for it. Orchestration
(auto-match after import, progress, rematch on a new build) is #26.

## Bench page

`?bench` (on whatever region the data URL names): seeded random pairs at 7–9, 37–43 and 75–85 km
straight line (routes of ~11 / 57 / 112 km) from the loaded graph, each routed with the two main
presets in the worker; the first route after load; five profile compiles per preset; 20 fake
rides along the ~50 km routes (a point every 5 m, ±3 m noise) matched; the wasm heap after load,
after the routes and after matching. A table to read on the phone and the same as text to copy.
`&run` starts it at once; `&pairs=`, `&rides=`, `&seed=`, `&geometry=lazy` change it. The pairs exist
only in the page's memory: never shown, logged or stored.

The desktop worker on the 100 km region (eager), engine time per route in ms (p50 / p95 / max; the
round trip to the UI adds ~1 ms):

| route | Gravel explorer | Paved & quiet | result |
|---|---:|---:|---:|
| ~11 km | 2.5 / 9.5 / 9.5 | 2.7 / 8.9 / 8.9 | 25 KB |
| ~57 km | 12.5 / 18.8 / 21.0 | 10.3 / 26.4 / 32.9 | 88 KB |
| ~112 km | 37.5 / 46.8 / 52.3 | 30.5 / 58.0 / 69.6 | 166 KB |

Profile compile 70 ms (Gravel explorer) and 38 ms (Paved & quiet); first route after load 120 ms
(compile included); matching 30 ms per 65 km ride (p50). Download of the gzip siblings (66.3 MB,
489 files) from a local server: 2.4 s.

## The route lab (temporary)

`?lab` replaces the bottom panel with a proof of the chain (`web/src/planner-lab/`, nothing else
depends on it): tap the map for A, B and waypoints (drag to move, tap to remove), a preset, the
route in vermilion with its totals, a second preset in blue to compare. The planner shell replaces
it.
