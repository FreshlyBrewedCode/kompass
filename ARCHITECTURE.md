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
  │   snap · route · loop · lookahead · analyze                      │
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

## Engine (Rust)

Built so far: the crates, the graph, the profile and its compiled cost, and `route` with waypoints,
leg profiles and the route diff ([docs/profile.md](docs/profile.md), [docs/routing.md](docs/routing.md)),
map-matching ([docs/matching.md](docs/matching.md)).
Still to come:

- **Dead ends** (bridges, pockets beyond them) are found here, not in the pipeline: they depend
  on the profile's hard constraints. The pipeline only prunes tiny disconnected components.
- **Queries:**
  - `route` zones: via-zones and avoid-zones (the request already carries them; ignored for now).
  - `loop`: start, distance, bearing or sketched shape; a novelty prize.
  - `lookahead`: a bounded search per branch at the next junction.
- **Personal layer, later:** per direction, corrections and ridden today (the ridden count and last
  ridden per edge are built: [docs/rides.md](docs/rides.md)). Importing a ride never rebuilds the base
  graph.
- **Raw tracks are the source of truth.** Edge IDs change on rebuilds, so per-edge history is
  always re-derived by matching the tracks again. Corrections are stored by OSM way ID plus
  position, so they survive rebuilds.

## Profile

Built ([docs/profile.md](docs/profile.md)); still to come: personal overrides (corrections) and the
agent's `set_profile` tool on the generated schema.

## Ride mode (later)

- Foreground GPS with the screen kept on (Wake Lock). A PWA gets no reliable GPS in the
  background, so gaps in the live trail are filled by map-matching between points.
- Lookahead runs in WebAssembly with tiles cached on the phone, so it works offline in forest
  dead zones.
- If iOS turns out too limited, wrap the app with Capacitor without rewriting it.
- Garmin: a Connect IQ data field fed from a phone or server is possible later. Pushing the
  planned route as a course (GPX/FIT) is the easy first step.

## Things to keep in mind

- OSM gaps: many tracks lack `surface`. Keep *unknown* explicit and let personal corrections
  fill in over time.
- OSM has no traffic volumes. "Quiet" is a proxy; official German count data may help.
- Privacy: the repo is public. No home location, tracks, names, tokens or hostnames go into
  the repo.
