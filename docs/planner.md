# The planner shell

The screen: the region map with the planner on top, built on the consolidated design
([design/planner.md](design/planner.md), the binding reference for layout, parts and tokens). Code:
`web/src/planner/`; tests `web/test/planner-*.test.ts`, `e2e/planner.spec.ts`.

| file | what |
|---|---|
| `store.ts` | the one state model (`PlannerStore`), its engine wiring, persistence; `usePlan(selector)` |
| `model.ts` | pure logic: waypoint insertion, the diff against the base and its sentence, the panel's groups and their lines, what a slider touches, read-outs, the trade-off, why-notes, plan and preset parsing |
| `route-layer.ts` | what the planner draws on the map, and the map's gestures (tap, right-click, long press) |
| `parts.tsx` | the components of the design's inventory (one set for every breakpoint) |
| `shell.tsx` | the arrangement per breakpoint (phone, tablet, desk), sheets, the chip strip; wires map, engine, rides |
| `layers-panel.tsx` | "Map & rides": map (with the tracks legend and the key, `map-key.tsx`, and the map style options, `map-style.tsx`) / one information layer / explored / cost, toggles, inspect, the ride library |
| `inspector/` | the segment inspector: the words (`model.ts`: exchange rates, the three groups, the "why not" verdict), the long press (`gesture.ts`), the panel (`panel.tsx`), this plan's actions (`actions.tsx`) |
| `overrides.ts` | this plan's exceptions: the list (one per edge), what the engine gets, the words, the saved form per build |
| `tradeoffs.ts`, `tradeoff-card.tsx` | the hard limits as trade-offs: the words per limit, what is still offered, the exceptions "Allow here" makes; the card |
| `cost/` | the cost debug view: the words of one edge and of a comparison (`model.ts`), the layer's key (`panel.tsx`), the layer's wiring (`use-cost-layer.ts`) |
| `structured/` | the structured controls, a prototype behind a switch ([below](#structured-controls-prototype-behind-a-switch)): the words, tier moves and the curve (`model.ts`), the tier board (`board.tsx`), the hills curve (`hills.tsx`), Detours as the spread, the switch and its note (`controls.tsx`), the inspector's lines (`inspect.tsx`) |
| `palette.ts` | data colours (route, compare, ghost, surface, way type, ridden) as CSS variables |
| `gpx.ts` | the GPX writer and the export (share sheet on touch devices, else a download) |

## State

`PlannerStore` is a plain TS store (subscribe / getSnapshot, like `engine/store.ts`). The snapshot
holds the **plan** (waypoints, base preset id, this plan's `weights` and `limits`, the compared
preset, its exceptions `overrides`), what is **derived** from it (the base, the changes and their sentence, the rows on
screen, whether the changes route differently), the **routes** (one `Line` per lane: main, ghost,
compare; the moved stretches; the blamed limit after an error) and the **shell** (which sheet,
chip or picker is open, route colouring, inspect mode, the timeline cursor). Components read slices
with `usePlan(s => …)` (`useSyncExternalStore`), so a slider step re-renders the row, the totals
and the strip, not the tree.

- **A profile is a base plus changes.** The base is a preset (the engine's `presets()` or one saved
  on the device); `weights` and `limits` are this plan's full values, the diff is computed. An
  absent weight has no opinion; an explicit 0 stays on screen (`docs/profile.md`). There is no core
  set: a row is on screen only while the plan names it, so any row can be removed and the Blank
  slate has none. A base limit switched off is kept as `false`, so the change stays listed.
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

Every lane sends the plan's exceptions ([below](#this-plans-exceptions)): the main route, the ghost and
a compared preset (so the moved stretches and the trade-off show what the profiles do, on the same
exceptions), the probe after an error, and "why not" with its comparison.

A failed route (`no_route`, `excluded`) is explained by **probing**: the limit the error names, then
this plan's own limits, then the base's are lifted one at a time (lane `probe`); the first that
makes a route is blamed ("No route with “Paved only”", "Lift …") and its route is the dashed line.
If no single limit is to blame, all of them off. `no_way_near` names the waypoint.

The ride library feeds the engine's personal layer after matching (`docs/rides.md`); the shell
reroutes when the explored store changes, so "new to me" and the ridden lane follow.

## Map

The light/dark choice (system / light / dark) is the "Appearance" row of the Map & rides sheet: app-level
settings live there, no extra menu (see docs/map.md, Theme).

`RouteLayer` adds GeoJSON sources (main, alt, cursor, the inspector's ring, the plan's exceptions) above the map's ways and "My rides" and
below the labels, and re-adds them after a theme change (a new style). It subscribes to the store
itself and calls `setData` only for the source whose data changed. Waypoints are MapLibre markers
(44 px targets, draggable; a drag moves the waypoint live and reroutes), notes are a few HTML
markers. `fitSeq` in the store asks for a fit (a restored plan, a new comparison).

**Hiding the route**: the eye button in the top bar (shown while there is a route) or the key `H` (not
while typing in a field) sets `routeHidden` in the store; `RouteLayer` sets the route lines' layout
`visibility` (`ROUTE_LINES`: main, ghost, compared and "why not" lines with their casings) and drops the
notes. Markers, the cursor and the plan stay; the state is not saved.

**Sliders** (`KnobSlider` in `parts.tsx`, behind the preference `Dial` and Detours) move only from the
knob: a press elsewhere on the track is ignored, a drag goes live after 4 px of mostly sideways travel
(so a vertical swipe on a row scrolls the sheet instead), the knob keeps its offset to the finger.
Arrow keys step (a preference: 5, Shift or Page keys 25), Home / End go to the ends.

**Taps**: a tap adds a waypoint, or closes the open sheet. A **right-click** (desk) or a **long press**
(touch: one finger held still for 500 ms, cancelled by 10 px of movement, a second finger or an early
lift) opens the [segment inspector](#the-segment-inspector) on the nearest way, in normal planning: it
never adds a waypoint (the click a browser sends after a long press is swallowed) and never opens the
browser's menu. A press on a waypoint marker stays the marker's (dragging). The attribute layers'
"Inspect a way" (Map & rides) is the region map's own tap handling (`RegionMap.setPicking`, the
attributes panel); on the Cost layer a tap opens the segment inspector instead.

## The segment inspector

The hub of steering (`inspector/`, design: [design/steering.md](design/steering.md) §1): why the route
uses a way, why it does not, and the sliders that would change it, in place. Opened by a right-click or a
long press on any way (`RouteLayer`: the region map's `pickEdge` on the way layers, `docs/map.md`), or a
tap while the Cost layer inspects. The way gets an ink ring (`planner-inspect-ring`, a line with a gap,
so the way stays readable inside it): around the route's own line where the route rides it (the route's
vertices of that edge), else around the way's pieces in the tiles. Where: the summary card's place on the
phone (a sheet over the lower half, the map visible above it), bottom-left beside the route card on the
desk (the map's fit then keeps the parted stretches above it). Escape or × closes it; a tap still adds a
stop while it is open, and the inspector follows.

- **The way in numbers, as an exchange rate.** `explainEdge` under the plan's profile (lane `explain`,
  again on every profile change), the direction the route rides (else the cheaper open one): "Counts as
  0.63× its length", "420 m count as 265 m: worth a detour of up to 1.6×" (additive terms included:
  climbing makes a neutral way dearer than its length). A dearer way on the route: "the ways around it
  count more". The edge verdict's notes follow (the detour limit, the gate, the other direction).
- **Three groups of lines**: what makes it cheaper, what makes it dearer, and what could apply here but
  is neutral now. Each line names how much the way is what the preference names ("matches 80 %",
  "traffic 45 %", "the opposite here"), the weight, and the effect in a rider's words ("worth a 1.3×
  detour", "counts 1.6× as long", "+120 m" for avoiding climbs, fixed costs such as barriers with no
  slider). Neutral: an active preference that does not match this way, one at 0, and a catalogue
  preference not in the plan that would match ("not in this plan: at its usual −80 it would count ×3.6
  here"). Those come from a **probe**: the same edge explained with every preference at +100 (lane
  `explain-probe`, once per way: memberships do not depend on the weights).
- **Sliders in place.** Tapping a line opens that preference's `Dial` under it; the route and the
  explanation follow every step. While a slider is open the lines keep their group and place (a line
  whose value crosses into another group does not jump away under the finger). A preference not in the
  plan joins it when its slider moves, or with "Add at +50" (its catalogue default). On the desk the
  profile card's row flashes too.
- **On the route: "Why the route uses this".** The above.
- **Off the route: "Why the route does not use this".** With a route, the store's `whyNot` routes again
  through the point halfway along the way (`whyNot` lane, the via inserted where it detours least), and
  `compare` judges both (lane `whynot-compare`); both follow every slider move. The verdict first
  (`whyNotVerdict`): "Not used: through here counts 1.8 km more" (the difference in cost, in kilometres),
  the preference or limit to blame (a closure by a limit or a rule; else the preference whose log factor
  times length differs most between the two sides, "“Low traffic” counts it dearer: ×2.1 through here
  against ×1.0 planned", or one that favours the planned side; else the distance), "No slider can change
  this" when the way through here would cost more even if all of it sat at the detour limit, then the
  lengths and costs. "Use this way" adds the point as a stop (the inspector then turns to "why used").
  The route through it is drawn in the compared route's blue with a ring at the point; the map fits where
  they part only when that is not in view. Below: the way's own lines, and the stretches side by side,
  folded (length, what it counts as, mean factor, main way type, top reasons, share at the clamp, closed
  length, and the clamp's diagnosis).
- **A way closed both ways** gets no comparison (a via snaps to an open way nearby): what closes it,
  "No slider can change this", and "Lift “…”" where a limit of the plan closes it.
- **No route yet**: "How this way counts", the numbers and the lines.
- Folded at the end: the arithmetic per direction (quality × bonus through the gate → raw → clamped,
  additive terms, what the router counts) and the way's data.
- **Actions for this plan** ([below](#this-plans-exceptions)): on the route "Avoid this segment"; off it
  "Use this way" (a stop), "Prefer this way" and "Avoid"; on a way a limit closes "Allow here" next to
  "Lift …"; with no route "Avoid" and "Prefer". A way with an exception says so first ("Avoided in this
  plan: the route takes any other way round these 420 m") with the way back ("Stop avoiding"); an
  avoided way off the route gets no "why not" (the plan is why) and counts as the profile has it.

## This plan's exceptions

A plan carries a few exceptions to its profile, made in the segment inspector: the profile stays what
the rider wants in general, an exception is about one stretch of this plan (the engine side:
[routing.md](routing.md#this-plans-exceptions)).

- **What they apply to.** A rider means the way between junctions, not one graph edge: the inspector
  loads the way's run (`edgeRun`, lane `edge-run`: the edge extended through nodes where nothing
  branches off), the ring on the map covers all of it, and the buttons name its length ("Avoid this
  segment · 420 m"). An exception holds the run's edges, its line and the way's name; a new one on an
  edge replaces the one there (one exception per way).
- **Avoid this segment**: the route takes any other way round it (a high finite penalty: with no other
  way, or a stop on it, the route still rides it, and the inspector says so).
- **Prefer this way** vs. **Use this way**: "Use" adds a stop, so the route must pass; "Prefer" adds no
  stop: the run counts as little as Detours allow (`min_factor` × its length), and the route takes it
  where that pays. Both stay: a stop is for "ride through here", a preference for "this one if it is on
  the way", which also survives moving the stops; the line under the buttons says the difference.
- **Allow here** (a way a limit closes): only that limit-closed run opens, for this plan, costed as if
  the limits were off there; "Lift …" switches the limit off for the whole plan. A bicycle ban or a
  one-way never opens. A limit's trade-off makes the same exception from its marker ([below](#limits-as-trade-offs)).
- **Where they are.** "This plan · 2 exceptions" closes the profile panel (`PlanExceptions` in
  `parts.tsx`), each row with its kind, way and length, removable; on the map a quiet mark under the
  route on each (avoided: a dotted ink line; preferred and allowed: a soft halo in the planner palette's
  `OVERRIDE` colours). Every change (add, remove, "Stop …") shows "Undo" for 8 s (`UndoToast`).
- **Not on the Cost layer**: it colours the profile, which an exception does not change.

## Limits as trade-offs

A limit can send the route on a long detour round a tiny link (paved only, round 40 m of gravel). The
engine finds those ([routing.md](routing.md#limits-as-trade-offs)); the planner shows them and lets
the rider decide per plan.

- **When it asks.** After the main route settles, if the profile closes ways (a limit on, or a board
  row on Avoid), and only once the route has stayed put for 400 ms (`TRADEOFF_DELAY_MS`): a slider drag
  or a dragged stop asks nothing until it rests. Lane `tradeoffs`, latest wins, with the main route's
  request and its `arcs` (one extra search in the engine, no compile). A new main route drops the
  markers at once; the answer is used only while the route it was asked for is still the main one.
- **The marker**: a small badge in the "allowed" colour (`OVERRIDE.allow`) on the route, halfway along
  the bit (at most three per route, the engine's choice). Not while comparing, during "why not", after
  an error or with the route hidden.
- **The card**, in the segment inspector's place (opening one closes the other): "40 m unpaved here
  would save 2.1 km." in a rider's words per limit (unpaved, on a main road, with private or farm-only
  access, of steps, of unknown surface, steeper than your limit, by ferry, on a surface / way type you
  avoid; `tradeoffs.ts`), the limit by its label, and the shortcut dashed on the map in the same colour
  while the card is open.
- **Allow here** adds one allowed exception per run of the bit's edges, through the plan's exceptions
  (so it lists under "This plan · N exceptions", the undo toast says "Allowed: 40 m unpaved", and the
  route reroutes; the allowed bit is no longer offered). **Keep the limit** stops offering that bit for
  this session (by its edges; not saved with the plan).


## Cost (the debug view)

Why the router goes where it goes, over an area ([routing.md](routing.md#explaining-the-cost)); one way
at a time is the segment inspector's job.

- **The Cost layer**: one more entry in "Map & rides" (`?layer=cost`). The visible edges coloured by
  the plan's profile ([map.md](map.md#cost-layer)), recoloured on every map move and profile change
  (lane `cost`, latest wins). Its key names the scale, the clamp and what closes the closed ways in view.
- **A tap on the layer** opens the segment inspector (inspect is on by default with the layer; "Done"
  turns it off and taps add stops again). The words of one edge (`edgeVerdict`) and of a comparison
  (`whyNot()`: the stretches, the clamp's diagnosis) live in `cost/model.ts`.
- The profile behind the layer, the inspector and the comparison is the plan's, Detours included
  (`PlannerStore.profile()`).

## The preferences panel

The profile editor (`ProfileList` in `parts.tsx`; the phone's sheet, the tablet's panel, the desk's
card) shows the plan's preferences by the catalogue's groups, the same sections as "add a
preference" (`prefGroups` in `model.ts`), in the catalogue's order and only groups with rows. Then
"add", Detours and the limits, as before.

- **Collapsed by default.** A group is a header: its icon and name, the number of rows, the accent
  dot when one of them is changed, and one line of what is set in it in a rider's words, strongest
  first, two named and the rest counted (`groupSummary`: "likes gravel, avoids soft ground +1";
  "no opinion on water yet"). A tap opens it to its sliders (with the avoid / seek legend). Which
  groups are open is the panel's own state, not saved; a row that is added or flashed (the cost
  view's tap on the desk) opens its group, which then stays open.
- **What a slider touches.** Each row shows how much of the plan's route the preference applies to
  ("8.2 km", "350 m"), from the route's `breakdown.touched` (`docs/profile.md`). A row that touches
  nothing (under 5 m) says "0 km" and is dimmed, still usable; a collapsed group whose rows all touch
  nothing says "nothing on this route" in its head and dims too. No route (or an error): no figures, no dimming;
  a row just added gets its figure with the next route.
- **Empty.** Without any preference (the Blank slate, or every row removed) the panel says so and
  invites: the route takes the shortest way, and "add a preference" sits right in the message.
- The chip strip (phone, tablet) lists the same rows ungrouped, so it is empty on the Blank slate
  but for the profile, the limits and "+".

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
  preset, route colouring, and its exceptions with the region build they were made on (`overrides:
  { build, list }`, absent when there are none: older plans load as before). Edge ids change with every
  build of the region, so exceptions of another build are dropped on load, and the panel says how many
  ("2 exceptions dropped: the region's map data changed"). Re-picking them by their line on a new build
  was the alternative; a plan's exceptions are few and quickly made again, a wrong re-pick would avoid
  the wrong way silently; written 250 ms after a change and on `pagehide`. Waypoints outside the
  region's bounds are dropped on load; a missing base falls back to Gravel explorer.
- Own presets (`kompass.presets.v1`): `{ id, blurb, profile }` like the shipped ones; saved, renamed
  and deleted from the profile's head.
- **From the core-set days.** Plans and own presets saved while `unpaved`, `quiet`, `climb` and
  `novel` were on screen in every profile carry explicit 0s for them. On load
  (`dropFormerCoreZeros`) such a 0 goes when the base does not set the preference either: it only
  existed because the row was always there, and it routes the same. A 0 against a base that sets it
  ("less climbing") stays, as does a 0 on any other preference ("added, not set yet"). So an old plan
  on the Blank slate opens empty, not with four rows at "no opinion".

## Structured controls (prototype, behind a switch)

Tier boards and a hills curve in place of the surface, way-type and terrain sliders (epic #58, task
#66; the design: [design/steering-widgets.md](design/steering-widgets.md), direction A, "Lanes"; the
engine's model: [profile.md](profile.md#the-structured-model-prototype-behind-a-switch)). Built so the
rider can playtest them next to today's sliders; with the switch off nothing changes.

- **The switch.** "Structured controls (prototype)" in Map & rides, under Appearance (an app setting, not
  the plan's): saved on the device (`kompass.controls.v1`), off by default; `?controls=structured` (or
  `=sliders`) sets it and is remembered. Store: `setControls`, `controls`, `converting`.
- **Two profiles in one plan.** On: the plan's slider profile goes to the engine's `toStructured`
  (worker method; the store keeps per part the twin's own board or curve where the plan changed nothing
  that feeds it, so River valley keeps its tuned curve), based on the preset's structured twin
  (`structuredPresets`: the picker offers the twins and the own structured presets). An unchanged plan
  takes the twin as it is. From then on the plan edits the structured profile; off goes back to the
  slider profile as it was. Both are kept (the plan's `structured` key beside the sliders' fields), so
  the rider can flip and compare routes. Until it is edited, the structured profile follows the sliders
  (converted again on the next switch); once edited the two are separate, and the note at the head of
  the profile says so (with "Sliders" to switch back). An own slider preset has no twin: its plan
  converts onto Gravel explorer's twin (the changes are counted against that).
- **Tier boards** (Surface, Way type groups): collapsed, the ranking in words ("love tracks, cycle
  paths · never main roads") and the lanes in miniature (a dot per row); open, a lane per tier, Love to
  Avoid (hatched, "never"), each with what a kilometre counts as under the spread ("1 km → 1.35 km"),
  the rows as chips with the route's length on them (`breakdown.rows`) and the change dot. A tap selects
  a chip, the tier picker under the lanes moves it with one tap (its change dot puts it back). No drag
  between lanes. Below: the exchange sentence ("up to 1.35× longer than on ways that are fine").
  Sliders of the group the boards do not replace (`tracktype`, `smoothness`) stay below the board.
- **The hills curve** (Terrain): collapsed, the curve's name (a named curve, the preset's own, "Your
  own curve") and a metre at 10 %, with a sparkline; open, the named curves, the chart (grade −20 … +20 %,
  what a metre counts as on a log axis 0.5 … 10 m, 0 % pinned, the route's length per 1 % band from
  `breakdown.grades` behind it), handles that drag vertically, and the stepper row for the selected
  handle (‹ +10 % › and − 2.5 m +, a ladder of values from 0.5 to 10) that does everything without a
  drag. Then the handle's sentence (the route's km in its band, halfway to the neighbours, and what they
  count as), "Steeper on loose ground" in steps of 5 %, and the route's hills total (the segments'
  `hills_m`).
- **Detours** edits `detours` (the spread, 0.5 … 2), in words: what a loved and a disliked way are
  worth against a fine one.
- **The rest stays.** The other groups keep their sliders. What the boards and the curve replace (the
  catalogue's `replaces`, `replaces_limits`) is never offered by the picker, not listed among the
  limits and never sent (`structuredProfile`). The diff sentence names rows ("paths a tier up", "never
  main roads"), the curve ("hills: Climber", "own hills curve") and the spread; the change count, the
  ghost route, the compared preset (its twin), own presets (saved as structured profiles) and this
  plan's exceptions work as before. The chip strip shows the remaining sliders only (the boards and the
  curve are in the profile sheet).
- **The inspector** under the structured controls: "On the boards and the curve", the way's row and
  tier per board ("Tracks: like, counts 1.15×") and its hills ("these 400 m (up to 10 %) count 600 m
  more"); a tap opens the tier picker or the nearest handle's stepper in place. A way a board's Avoid
  closes says which row and offers the picker (and "Allow here"); "why not" can blame a row's tier or
  the hills (from `compare`'s `rows` and `hills_m`), and its "no control can change this" floor is the
  loved way on the flat. The arithmetic shows boards × groups ÷ best ^ detours.

## Performance

A drag of one slider on the demo region (39 km, four stops, 63 KB result), production build,
headless Chromium on the shared VM, 40 pointer steps over ~4 s: 34 route answers delivered, round
trip p50 13 ms / p95 20 ms, one main-thread long task; with the CPU throttled 4×: p50 19 ms /
p95 52 ms, 3 long tasks (max 186 ms). Frame times in this setup are dominated by software WebGL
(SwiftShader) and say little about a phone GPU.
