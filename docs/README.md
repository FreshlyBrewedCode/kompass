# Kompass docs

High-level concepts only: what is tedious to derive from the code. The code is the source of
truth; commands, layout and conventions are in [AGENTS.md](../AGENTS.md). Parts not built yet are
still described in the bootstrap [ARCHITECTURE.md](../ARCHITECTURE.md); whoever builds one moves its
lasting shape here and deletes the section there.

- [Shape](#shape): how the pieces fit together
- [map.md](map.md): region data, base map, overlay modes, explored map
- [pipeline.md](pipeline.md): the region build, from config to `edges.parquet` and map tiles
- [edges-parquet.md](edges-parquet.md): the contract between pipeline and engine (columns, enums)
- [rides.md](rides.md): the ride library: GPX/FIT import, on-device storage, dedup, backup, the map-matching seam
- [graph-format.md](graph-format.md): the engine's tiled binary graph, its files and how it loads
- [matching.md](matching.md): map-matching recorded tracks onto the graph, lazy geometry, the explored fold
- [profile.md](profile.md): the routing profile, the catalogue, how a profile becomes a cost, presets
- [routing.md](routing.md): the `route` query (request, snapping, search, result), the route diff
- [planner.md](planner.md): the planner shell: its state model, routing lanes, map layer, persistence
- [engine-web.md](engine-web.md): the engine in the browser: wasm face, worker protocol, latest wins,
  the graph download and device cache, states, the bench page
- [adr/](adr/): architecture decision records
  - [0001](adr/0001-toolchain.md): toolchain, nix locally and setup actions in CI
- [design/](design/): design rounds (directions, mock-ups, the chosen one)
  - [map-round-2](design/map-round-2.md): the map's line styles (D, "Bands", chosen; light first)
  - [map-round-3](design/map-round-3.md): one line per track on a straw ground (B, "Graded", chosen; the map style options)
- [reports/](reports/): spike verdicts, benchmarks, playtest reports

## Shape

```
pipeline/ (Python, offline)  ──edges.parquet──▶  engine/ (Rust)
                                                   compile ── graph/ tiles (`kompass compile`)
                                                   core ── cli  (native: `kompass`)
                                                    │  profile → cost per arc → A* → route
                                                    └── wasm (wasm-bindgen)
                                                          │ bun run build:wasm
                                                          ▼
web/ (static PWA)   React UI ──postMessage──▶ Web Worker (web/src/engine/worker.ts)
                    MapLibre map                loads the wasm, answers typed requests
```

- **No backend.** The app is static files and works from any sub-path (relative Vite `base`).
  Personal data (the ride library, [rides.md](rides.md)) stays in the browser.
- **The engine runs off the main thread.** The UI talks to it only through the typed client in
  `web/src/engine/` (`EngineMethods` lists every query with its params and result); the worker
  loads the wasm once, downloads and caches the region graph, and answers each request with a
  result or an error ([engine-web.md](engine-web.md)).
- **One engine, two faces.** `kompass-core` is platform-free; `kompass-wasm` and `kompass-cli` are
  thin shells, so a query works the same in the browser and on the command line.
- **Generated, not committed:** the wasm-bindgen output (`web/src/engine/pkg`) and everything under
  `data/`.
- **Region data is loaded at run time** from a data URL, described by a manifest: see [map.md](map.md);
  the pipeline that writes it is in [pipeline.md](pipeline.md).
