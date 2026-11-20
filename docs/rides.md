# The ride library

Recorded rides (GPX from the Komoot download script, FIT from a Garmin) are imported into the browser,
kept there in IndexedDB, drawn on the map and later map-matched to feed the explored map. Raw tracks are
the source of truth; everything per edge is derived from them. **Nothing leaves the device**: no request
carries track data and the app makes no third-party requests at all (checked by `e2e/rides.spec.ts`: during
import, export and restore every request goes to the app's own origin and none has a body).

Code: `web/src/rides/` (logic, no layout), `web/src/components/rides-panel.tsx` and `rides-matching.tsx` (replaceable UI),
`web/src/map/` (the "My rides" layer). Tests: `web/test/rides-*.test.ts` (the matcher with a fake engine, the personal layer, the zip import, …),
`e2e/rides.spec.ts`, `e2e/explored.spec.ts` (import, matching, the explored layer, zip, reload, delete);
`e2e/rides-bench.spec.ts` measures (`KOMPASS_BENCH=<n>`, skipped otherwise).

## Shape

```
UI (React)  ── RidesState (state.ts) ──postMessage──▶  ride worker (worker.ts)
 rides panel    subscribe/snapshot, actions           owns IndexedDB, parses, hashes, dedups,
 map layer                                            builds the map layer, writes/reads the backup
```

A dedicated worker apart from the engine's wasm worker. Requests run one at a time in order, so an import
and a delete never interleave. `File`s are posted to the worker and read there; the UI thread never sees
points. The map layer comes back as a `blob:` URL of GeoJSON that MapLibre parses in its own worker (the
GeoJSON object itself where `URL.createObjectURL` is missing in workers).

## Import

- **Files**: `.gpx` and `.fit` (chosen by signature, not name: FIT has `.FIT` at byte 8). Many at once;
  progress per file, then a result: imported, duplicate, already imported, failed (with the reason).
- **Zips** (`zip.ts`): a `.zip` (told by its first bytes) is read as a stream with fflate's `Unzip` (MIT,
  ~8 kB used; already in the tree through pmtiles): the file is read in 1 MB slices and each entry is
  imported as soon as it is complete, so a zip of a whole history never sits unpacked in memory. Only
  `.gpx` / `.fit` entries count; folders, `__MACOSX`, dot files and other files are skipped. Progress runs
  over the entries (from the end-of-central-directory record). A zip without rides, or one that cannot be
  read, is one failed result with the reason; one entry that cannot be read does not stop the others.
  How to make one from the Komoot download: [tools/komoot/README.md](../tools/komoot/README.md).
- **Backups in the same picker**: a file that starts with the backup's magic bytes is restored instead
  (after the tracks of the same pick), whatever its name. The picker's `accept` lists `.gpx,.fit,.zip,
  .kompassrides` and the MIME types iOS attaches (`application/zip`, `application/x-zip-compressed`, and
  octet-stream so nothing stays greyed out).
- **GPX** (`gpx.ts`): a small scanner, no DOM (workers have no `DOMParser`) and no dependency. Reads every
  `<trkpt lat lon>` with `<ele>` and `<time>` across all tracks and segments, the track's `<name>` and
  `<type>` (Komoot writes its sport id there). Tolerates namespaces on children, comments, CDATA, self-closing
  points, missing children. Waypoints and routes are ignored.
- **FIT** (`fit.ts`): an own minimal decoder, about 200 lines, instead of a library. Reads `record`
  messages (position in semicircles, altitude or enhanced altitude, timestamp) and the `session` sport;
  handles both byte orders, compressed timestamp headers, developer fields (skipped by size) and chained
  files; records without a position are skipped. Checksums are not verified, so a cut-off file still gives
  its points. `web/test/synthetic.ts` has a tiny encoder; no real recording is committed.
- **Cleaning** (`geo.ts`): points at exactly (0, 0), out of range or NaN are dropped, and so are isolated
  jumps (more than 50 km from the last good point, or faster than 250 km/h when timed). A track that stays
  at the new place for three points really moved (a gap, a train) and is kept. The ride's `notes` say how
  many points were dropped. Fewer than two usable points: the file fails.
- **Untimed tracks** (no timestamp on some point) are imported and flagged "no timestamps": never
  deduplicated by time (the content hash still catches the same file), no "last ridden".

## Storage

IndexedDB `kompass-rides`, version 1 (`store.ts`):

| store     | key      | value                                                                         |
| --------- | -------- | ----------------------------------------------------------------------------- |
| `rides`   | id       | `RideSummary`: start/end time, distance, point count, bounds, sport, name, source file, `alsoSeenAs`, content `hashes`, notes, bytes. Small: the list, dedup and "fit to ride" read only this. |
| `points`  | id       | `ArrayBuffer`, the binary points (below): the source of truth                  |
| `lines`   | id       | `ArrayBuffer`, the simplified map line (same encoding, positions only)         |
| `hashes`  | SHA-256  | `{ hash, rideId }` for every imported file, so re-importing a file is a no-op  |
| `matches` | rideId   | `RideMatch`: the map-matching seam (below), derived and re-computable          |

Plain `ArrayBuffer`s, not Blobs (older iOS Safari is unreliable with Blobs in IndexedDB). A ride is written
in one transaction: complete or absent. Ride ids are 12 random hex characters.

**Binary points** (`codec.ts`): `u8 version · u8 flags (time, elevation) · u32 count · f64 first time`, then
per channel `u32 byte length` + zigzag-LEB128 varints of deltas: latitude and longitude in 1e-6° (11 cm),
time in ms, elevation in 0.1 m. About 5 bytes per point (a 4000-point ride with time and elevation: ~19 kB,
against ~400 kB of GPX). Elevation gaps are filled from the previous point; a ride with any untimed point
has no time channel.

**Map line**: Douglas–Peucker to 10 m, built once at import and kept in `lines`, so the layer never decodes
the full points. `storage.persist()` is requested after the first successful import (and offered as a button
while the library is not persistent); the panel shows whether storage is persistent, what the rides take and
what the browser reports for the origin.

## Dedup rule

Two timed rides are **the same ride** when their time spans overlap by at least **80 % of the shorter one**
(`dedup.ts`, `isSameRide`; a zero-length ride inside the other counts). Typical case: the same ride
recorded by Komoot and by a Garmin. Checked against every stored ride at import and when merging a backup.

- **Which copy wins** (`pickKeeper`): the one with more points; on a tie the denser sampled (points per
  second); on a further tie the one already stored (so a re-import never swaps copies).
- The loser is not stored; its source file name goes into the winner's `alsoSeenAs` and its content hash
  into the winner's `hashes`. If the new file wins, the sparser stored copy is removed (with its match, which
  described other points) and its name and hashes move to the new ride.
- **Same file again**: the content hash is checked first (cheap, before parsing), so the same bytes under any
  name are "already imported". Deleting a ride forgets its hashes.
- Not applied to untimed rides.

## Backup

One file, `kompass-rides-YYYY-MM-DD.kompassrides` (`backup.ts`). All numbers little-endian.

```
"KMPSRIDE" (8 bytes) · u32 format version (1) · u32 header length · header JSON (UTF-8)
records, each:  u32 summary length (> 0) · u32 points length · summary JSON · points bytes (as stored)
trailer:        u32 0 · u32 0 · u32 ride count · u32 CRC-32 of every byte before the CRC
```

- The header JSON is `{ format, app, createdAt, rides }`. A file with a higher format version is refused
  with a message to update the app. The summary JSON is the stored `RideSummary`.
- **Matches are not in the backup**: they depend on the graph build and are re-derived. The map lines are
  recomputed on import.
- **Memory**: export reads the points 50 rides at a time and chains the bytes into Blobs of ~8 MB (the
  browser keeps big Blobs off the JS heap); import streams the file twice, first only to check magic,
  structure and CRC, then to merge, one ride in memory at a time. A damaged or foreign file is refused
  before anything is imported.
- **Import merges** with the dedup rule, and skips a ride whose id or any content hash is already known,
  so restoring the same backup twice changes nothing.

## The map-matching seam

The matcher runs in the engine worker (`engine.call("matchRide", { lat, lon })`,
[engine-web.md](engine-web.md), [matching.md](matching.md)). The library gives it everything to plug in
(`RideLibrary`, reachable through the worker as the `RideMethods` in `protocol.ts`):

- `listRides()` summaries, `getPoints(rideId)` → `{ count, lat, lon, time, ele }` typed arrays (degrees, ms, m).
- `saveMatch(rideId, { graphBuild, arcs: Uint32Array, coverage: Uint8Array, firstPoint?, trackM?, matchedM? })`:
  what the matcher returns (the arcs in riding order, `edge << 1 | reverse`; per arc the covered share of the
  edge × 255), marked with the graph build (the engine's build id). `clearMatches()` forgets them all (rides
  stay). A match of another build is stale; saving replaces a ride's match.
- `matchStatus(graphBuild)`: the saved matches of that build without their arcs (`rideId, trackM, matchedM,
  arcs`): which rides are done and how well.
- `exploredInput(graphBuild)` → `Map<edgeId, { count, lastRidden }>` (`match.ts`, `foldMatches`): the
  explored rule of [matching.md](matching.md) (an arc counts when the ride covers half of the edge, its
  pieces summed; an edge when either arc does), per edge the number of rides (once per ride) and the latest
  ride end (0 = only untimed rides). Matches of another `graphBuild` are stale and ignored.

## Matching in the background

`matcher.ts` (`RideMatcher`, logic only: the ride store and the engine are interfaces, tested with fakes in
`web/test/rides-matcher.test.ts`) and `state.ts` (`RidesState`, which owns it) turn "import my rides" into
"see my explored map" in one step.

- **When**: once the engine has a graph (`session.ts` follows `engineStore()`: `attachEngine` with the
  build id, the edge count and the network length; `detachEngine` while it reloads), after every import,
  restore or delete, and at start-up. Nothing is remembered about progress: a ride is *pending* while it
  has no saved match for the current build. So a reload resumes where it stopped, and a **new graph build**
  (every saved match is stale) rematches everything, newest ride first.
- **How**: one ride at a time. Points come from the ride worker to the main thread and on to the engine
  worker (`points` results and the engine's inputs are transferred, not copied): a `MessageChannel` between
  the two workers was not needed, because the main thread only forwards the buffers (48 kB for 3000 points)
  and measured no long task (below). Rides imported during a run are picked up by it. The UI thread never
  waits: every step is a worker message.
- **Progress, pause**: `snapshot.matching` is `{ phase: idle | running | paused, done, total, failed }`
  (updates are coalesced to ~4 per second); the panel shows "Matching rides to the map… n / m" with a pause
  button and a resume. Pausing stops after the ride in the engine, which is dropped (matched again on resume).
- **Results**: `snapshot.matches` maps a ride to `{ share, outside }`. `share` is `matchedM / trackM`; a
  ride whose share is under 50 % (`OUTSIDE_SHARE`) is **outside the region**: a result, not an error (it is
  saved all the same, so it is not pending again). A ride the engine throws on is skipped for the session and
  counted in `failed` ("n rides could not be matched"); it is tried again at the next start. A ride deleted
  while it is being matched is not a failure.
- **After matching** (every ~2 s during a run, and when it ends; after every delete): the saved matches are
  folded (`exploredInput`) into the `ExploredStore` (so the layer follows), into the engine's **personal
  layer**, and into the explored stats. At start-up `attachExplored(store, graphBuild)` folds the saved
  matches of the manifest's build at once, so the explored map shows before the engine has loaded; with no
  matches at all the store is left alone (the `?fakeRidden` dev hook keeps working).
- **The personal layer** (`personal.ts`): `engine.call("setPersonal", { rides, lastRidden, today })`, flat
  arrays sized to the graph's edge count: per edge the number of rides (saturating at 65535) and the day (since
  1970, UTC) of the last one (0 = only untimed rides), today. The profile's novelty preferences ("never
  ridden", "not ridden for long", "ridden often") read it in the route query. With no matches left it is
  cleared (`setPersonal(null)`); a new graph starts without one.
- **Summary** (`summary.ts`): rides matched (n of m, how many outside the region), km of distinct ways
  explored (`engine.edgesLength` over the explored edges: each edge counted once, whole) and the share of the
  network (`EngineInfo.networkM`, every edge of the graph, including ways a gravel profile avoids).

On the real history of 185 GPX files (180 rides after the dedup rule), headless Chromium with software
WebGL, the app and the region from a local server: import 3 s (zip: 3 s), matching of all 180 rides 6 s
(about 33 ms per ride, all in the background), 25,420 edges / 2,568 km explored, 13 rides outside the region,
no UI long task during the import or the matching, the engine's wasm memory 236 MB after (graph 152 MB), and
a reload brings the explored map back from the saved matches in under a second without matching again. The
native matcher on the same 180 rides finds the same 25,420 edges / 2,568 km.

## UI

`RidesButton` (the chrome's "Rides n" entry and the "My rides" eye toggle) and `RidesPanel`: a bottom sheet
on a phone, a right-hand panel on a desktop, both without hiding the map. Add files (picker accepting
`.gpx,.fit,.zip,.kompassrides` and the MIME types iOS and Android attach, multiple; or drop them anywhere
on the page), progress, the matching progress line and the explored summary (`rides-matching.tsx`), the
result summary with the problems listed, the list (newest first; each row says how much of the ride
matched, or tags it "outside the region"; tap a ride to highlight it and zoom the map to it; delete one;
delete all after a confirmation), export, restore and the storage status. The list renders in pages of 60 as it is scrolled. "My rides" is a GeoJSON line layer between the
overlay and the labels (magenta, with a casing, readable on the light and the dark base map).

## Measured

Headless Chromium with software WebGL, synthetic rides of ~4000 points each (1 Hz GPX, 390 KB), the e2e
server on the same machine (`KOMPASS_BENCH=<n> bunx playwright test bench --project desktop`):

| rides | import | stored       | layer fetch | export / restore |
| ----- | ------ | ------------ | ----------- | ---------------- |
| 500   | 7.5 s  | 10.3 MB      | 30–110 ms   | 1.3 s / 2.2 s    |
| 1000  | 14 s   | 20.6 MB      | 35–200 ms   | 1.0 s / 3.5 s    |
| 2000  | 32 s   | 41.3 MB      | 150–400 ms  | 7 s / 9.6 s      |

About 15 ms and 20 kB per ride. The worker does all of it; the UI thread had one long task (~250 ms) while a
thousand rides were imported and the layer was handed to the map. A real iPhone will be slower.
