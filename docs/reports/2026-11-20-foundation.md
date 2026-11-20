# Foundation run: closing report (2026-11-20)

The first run of Kompass: from two bootstrap documents to a planner that routes on the real region in
the browser, with the rider's own history on the map. Epic #1, Iteration 1.

## What was built, in order

| PR | What |
|---|---|
| #8 | Scaffold: monorepo (engine, web, pipeline, tools, e2e, docs), one gate, CI, nix dev shell |
| #9 | Komoot download script (run by the user; worked on the first live run) |
| #14 | Web map: region base map, attribute map, explored-map hooks |
| #16 | Pipeline: region config → `edges.parquet`, overlay and base map tiles, manifest |
| #20 | Ride library: GPX/FIT import, on-device storage, dedup, backup |
| #23 | Engine graph: compiler, tiled format, loader, snapping |
| #24 | Outdoor map style with hillshade, contours and information layers on demand |
| #27 | Engine map-matching |
| #29 | Engine profile model, cost compile, the route query, presets |
| #28 | Planner design, three rounds, consolidated in `docs/design/planner.md` |
| #30 | The engine in the browser: cached graph, worker client with latest-wins, bench page |
| #32 | Explored map from imported rides, matched in the browser; zip import |
| #33 | The planner shell on the consolidated design |

Spikes (branches tagged `spike/3`, `spike/4`, `spike/5`, verdicts on the issues): the Python pipeline
approach (#3), plain A* speed natively and in WebAssembly (#4), HMM map-matching (#5).

## Decisions taken

- **Toolchain:** a nix dev shell locally, plain setup actions in CI (ADR 0001).
- **Pipeline:** Python holds up: a 100 km region builds in about 9 minutes. Dead-end detection moved to
  the engine because it depends on the profile.
- **Elevation:** Copernicus GLO-30 for now. It measures the canopy, so climbs in forest are noisy; the
  cost function uses a deadband. A bare-ground model is #12.
- **Search:** plain A* over a cost compiled once per profile change; no landmarks (slower here).
- **Tiling:** tiles are the file format, but the whole home region loads up front. Corridor loading
  missed the best route too often; it waits for bikepacking-scale regions.
- **Profile:** data keyed by a catalogue the engine exports (36 preferences, 8 limits): weights from
  −100 to +100, hard limits apart, a base preset plus per-plan changes. Bonuses (landscape, novelty,
  signed routes) only count on ways the rest of the profile accepts.
- **Matching:** needs exact edge geometry; an edge counts as ridden when a ride covers at least half
  of it, per direction.
- **Graph in the browser:** gzip copies decompressed by the app (works on any static host), cached per
  build in the Cache API.
- **Design:** direction C ("the map is the app"); strip layout on the phone, cards on desktop; plain
  sliders; a searchable picker to add preferences; monotone chrome with one accent that is also the
  route colour.
- **Map:** an own outdoor style where tracks and paths come from the routing edges (dash = firmness);
  attribute views are layers on demand, one at a time.

## Scorecard

| Bar | State |
|---|---|
| Static PWA, no backend, personal data on the device (hard) | Met in the code: e2e asserts that every request stays on the app's origin and none carries a body. |
| First playtest (hard) | Build is ready and handed over; the user's verdict is open. |
| ~50 km route in the browser on a phone under 1 s (soft) | Desktop worker: 12.5 ms median, 18.8 ms p95. Phone estimate about 90 ms (6× CPU throttle). The real phone figure comes from the bench page (`?bench&run`); not measured yet. |
| Route quality at least BRouter's gravel profile (soft) | Not compared yet. Internal check on 12 random 30–60 km pairs: Gravel explorer 61 % unpaved at a 1.19× detour with 0.1 km of main road; the two main presets share 0–21 % of their edges. |
| Design: 3–5 directions, one chosen, refined (hard) | Met: four directions, the user chose C, two more rounds, built. |

Numbers on the real region: 2.34 M edges, 226,000 km of ways; graph 66 MB to download once; a profile
change recompiles in 21–70 ms; the user's history of 180 rides imports in about 3 s and matches in
about 6 s on desktop.

## How to try it

1. Build the region once: `kompass-pipeline build …`, then `kompass compile --build …` (AGENTS.md).
2. `bun run build && bun run serve -- --port 7950 --data data/build/region`, open it on the phone
   through a tailnet HTTPS entry.
3. Import rides (a zip of the Komoot download works), switch on the Explored layer.
4. Tap the map for start, destination and waypoints; pick a base profile, drag sliders, add
   preferences; compare with a second profile.
5. `?bench&run` measures route times on the device.

## Not verified

- Anything on a real iPhone: the 1 s bar, memory (the wasm heap is 210–250 MB), hillshade frame rate,
  the file picker for `.zip`, storage persistence, safe areas and touch on sheets and markers.
- Route quality by the rider's eye, and against BRouter.

## Left open

- The demo region does not compile: an 8 km ferry edge exceeds the graph format's edge length limit.
- The dedup rule folds a few time-overlapping rides into others and loses their explored ways.
- Starting the app builds the snapping grid (1.25 s on desktop): the first thing to speed up on a phone.
- Map: no bridges or tunnels, tracks only from zoom 12–13, the dark relief is muddy, no key for the
  line styles; map tiles are not cached for offline use.
- `ARCHITECTURE.md` still holds what is not built: loop, lookahead, ride mode, the agent.

## Proposed next steps

1. **Playtest fixes** from the user's first session (recommended first: it decides the rest).
2. **Route quality round:** the BRouter comparison on 5–10 of the user's typical routes, preset tuning
   on what it shows, bare-ground elevation (#12).
3. **Phone hardening:** start-up time, memory, offline map tiles, install as a PWA; GitHub Pages hosting.
4. **Loops and novelty** (the vision's next step): "a 40 km loop to the north-west", preferring ways
   never ridden; then sketch routing.
