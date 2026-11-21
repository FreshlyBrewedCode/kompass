# The planner shell

The screen: the region map with the planner on top, built on the consolidated design
([design/planner.md](design/planner.md), the binding reference for layout, parts and tokens). Code:
`web/src/planner/`; tests `web/test/planner-*.test.ts`, `e2e/planner.spec.ts`.

| file | what |
|---|---|
| `store.ts` | the one state model (`PlannerStore`), its engine wiring, persistence; `usePlan(selector)` |
| `model.ts` | pure logic: waypoint insertion, the diff against the base and its sentence, read-outs, the trade-off, why-notes, plan and preset parsing |
| `route-layer.ts` | what the planner draws on the map, and the map's taps |
| `parts.tsx` | the components of the design's inventory (one set for every breakpoint) |
| `shell.tsx` | the arrangement per breakpoint (phone, tablet, desk), sheets, the chip strip; wires map, engine, rides |
| `layers-panel.tsx` | "Map & rides": map / one information layer / explored / cost, toggles, inspect, the ride library |
| `cost/` | the cost debug view: the words (`model.ts`), the key, tap panel and "why not" card (`panel.tsx`), the layer's wiring (`use-cost-layer.ts`) |
| `palette.ts` | data colours (route, compare, ghost, surface, way type, ridden) as CSS variables |
| `gpx.ts` | the GPX writer and the export (share sheet on touch devices, else a download) |

## State

`PlannerStore` is a plain TS store (subscribe / getSnapshot, like `engine/store.ts`). The snapshot
holds the **plan** (waypoints, base preset id, this plan's `weights` and `limits`, the compared
preset), what is **derived** from it (the base, the changes and their sentence, the rows on
screen, whether the changes route differently), the **routes** (one `Line` per lane: main, ghost,
compare; the moved stretches; the blamed limit after an error) and the **shell** (which sheet,
chip or picker is open, route colouring, inspect mode, the timeline cursor). Components read slices
with `usePlan(s => …)` (`useSyncExternalStore`), so a slider step re-renders the row, the totals
and the strip, not the tree.

- **A profile is a base plus changes.** The base is a preset (the engine's `presets()` or one saved
  on the device); `weights` and `limits` are this plan's full values, the diff is computed. An
  absent weight has no opinion; an explicit 0 stays on screen (`docs/profile.md`). Core preferences
  missing from a profile count as 0. A base limit switched off is kept as `false`, so the change
  stays listed.
- **Waypoints**: the first tap is the start, the second the destination; later taps join the leg
  they detour least from, or extend the route when a tap lies beyond the destination (`insertIndex`).
  Names are the nearest place label the map has rendered around the tap (no geocoding), else
  "Start", "Waypoint n", "Destination".

## Routing

Every change schedules one pass per animation frame. Each line has its own latest-wins lane of
the engine client (`docs/engine-web.md`): `route` (the plan), `ghost` (the base preset, only while
the changes route differently and nothing is compared), `compare`; a lane whose input did not
change is not sent again, so a slider drag sends only `route` and the ghost stays compiled in the
engine's two-profile cache. When main and ghost differ, `diff` gives the "moved" stretches; with a
comparison, `diff` gives the shared share for the trade-off sentence. "Routing…" shows only when
the main route takes longer than 250 ms.

A failed route (`no_route`, `excluded`) is explained by **probing**: the limit the error names, then
this plan's own limits, then the base's are lifted one at a time (lane `probe`); the first that
makes a route is blamed ("No route with “Paved only”", "Lift …") and its route is the dashed line.
If no single limit is to blame, all of them off. `no_way_near` names the waypoint.

The ride library feeds the engine's personal layer after matching (`docs/rides.md`); the shell
reroutes when the explored store changes, so "new to me" and the ridden lane follow.

## Map

The light/dark choice (system / light / dark) is the "Appearance" row of the Map & rides sheet: app-level
settings live there, no extra menu (see docs/map.md, Theme).

`RouteLayer` adds three GeoJSON sources (main, alt, cursor) above the map's ways and "My rides" and
below the labels, and re-adds them after a theme change (a new style). It subscribes to the store
itself and calls `setData` only for the source whose data changed. Waypoints are MapLibre markers
(44 px targets, draggable; a drag moves the waypoint live and reroutes), notes are a few HTML
markers. `fitSeq` in the store asks for a fit (a restored plan, a new comparison).

**Taps**: a tap adds a waypoint, or closes the open sheet. Inspecting a way (the region map's
`pickEdge`, `docs/map.md`) is on only while asked for: "Inspect a way" in Map & rides, available
with an information layer; `RegionMap.setPicking` turns the map's own tap handling on and off.

## Cost (the debug view)

Why the router goes where it goes, for a rider. Three parts on the engine's cost queries
([routing.md](routing.md#explaining-the-cost)); nothing of it is on the default screen.

- **The Cost layer**: one more entry in "Map & rides" (`?layer=cost`). The visible edges coloured by
  the plan's profile ([map.md](map.md#cost-layer)), recoloured on every map move and profile change
  (lane `cost`, latest wins). Its key names the scale, the clamp and what closes the closed ways in view.
- **Tap for the breakdown**: with the layer on, a tap explains the way (inspect is on by default;
  off, a tap adds a stop as usual). `explainEdge` on lane `explain`, again on every profile change: the
  verdict in words first (`edgeVerdict`: "Preferred ×0.50, held by the detour limit", "Closed: legal
  access only (access=agricultural)", "Neutral ×1.0: nothing in this profile applies"), notes on the
  gate, additive terms and the other direction; then each active preference, strongest first (a tap
  opens its slider right there, and flashes its row in the desk's profile card); quality × bonus → raw
  → clamped → what the router counts, per direction when they differ; the way's data, folded.
- **"Why not through here?"** (the panel's button, with a route planned): `whyNot` in the store. The
  plan's route and one through the tapped point (inserted where it detours least, lane `whynot`), then
  `compare` (lane `whynot-compare`); both follow every slider move. The second line is drawn in the
  compared route's blue with a ring at the point, and the map fits where they part. The card
  (`whyNot()` in `cost/model.ts`): a verdict on top, the diagnosis (closed parts; "no slider can
  change this" when the way through here would cost more even if all of it sat at `min_factor`; both
  sides at the clamp; a neutral planned stretch), then the stretches side by side (length, what it
  counts as, mean factor, main way type, top reasons, share at the clamp, closed length). "Back to the
  plan" leaves nothing behind; "Use this route" adds the point as a stop.

Where: the panel and the card take the summary card's place on the phone, the bottom-left slot (above
the agent bar) on the desk.

## Detours

The profile editor has, apart from the preference sliders and above the limits, a **Detours** control:
`bounds.min_factor` in a rider's words, from "Direct" (1.0: preferences only avoid) to "Go far for good
ways" (0.3), in steps of 0.05, with the hint "Up to 1/min_factor × longer for a way you like". It is not a
preference but the bound on all of them (the clamp, `docs/profile.md`). Like the sliders it is a per-plan
change on the base preset: the store holds `detours` (`null`: the base's value, saved in the plan only when
moved), a moved value is a change ("more detours"), has the change dot to reset, and is sent as
`profile.bounds`.

## Persistence

- The plan (`kompass.plan.v1` in `localStorage`): waypoints, base id, weights, limits, detours (when moved), compared
  preset, route colouring; written 250 ms after a change and on `pagehide`. Waypoints outside the
  region's bounds are dropped on load; a missing base falls back to Gravel explorer.
- Own presets (`kompass.presets.v1`): `{ id, blurb, profile }` like the shipped ones; saved, renamed
  and deleted from the profile's head.

## Performance

A drag of one slider on the demo region (39 km, four stops, 63 KB result), production build,
headless Chromium on the shared VM, 40 pointer steps over ~4 s: 34 route answers delivered, round
trip p50 13 ms / p95 20 ms, one main-thread long task; with the CPU throttled 4×: p50 19 ms /
p95 52 ms, 3 long tasks (max 186 ms). Frame times in this setup are dominated by software WebGL
(SwiftShader) and say little about a phone GPU.
