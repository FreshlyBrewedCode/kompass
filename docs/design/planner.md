# The planner: design reference

The outcome of three design rounds (issue #7). This is what the planner shell is built from. The
running mock is the sandbox route `/final` (`design/planner`, see its README); every part named here
is implemented there under `design/planner/src/round3/`.

| file | what it holds |
|---|---|
| `Final.tsx` | the arrangement per breakpoint: `Phone`, `Desk` (desk and tablet), `Strip`, `SummaryCard`, `Sheet`, `Sheets`, `TopBar`, `LegendPill` |
| `parts.tsx` | the shared components (the inventory below) |
| `state.ts` | `usePlan` (the one state model), `useMode` (the breakpoints), the URL switches |
| `tokens.css` | chrome tokens, light and dark, and the `@theme` block |
| `palette.ts` | data colours |
| `map.tsx` | what is drawn on the map, and in which colour |
| `../round2/model.ts`, `useTuner.ts` | the profile model, the diff against the base, the toy engine (unchanged since round 2) |

## Principles

- **The map is the app.** Everything floats over it; nothing docks.
- **One set of parts, one state model.** A breakpoint changes where a part sits, never which part
  it is. `ProfileList` in the phone's sheet and in the desktop's card is the same component.
- **Monotone chrome, coloured data.** The chrome is ink, greys and one accent. If something is
  coloured, it is data, and the same colour means the same thing on the map, in the timeline and in
  a legend.
- **A profile is a base plus this plan's changes.** The changes are always visible, countable and
  reversible one by one.

## Layout

`useMode()`: **phone** below 720 px wide, or below 560 px high (a phone in landscape); **tablet**
720 to 1099 px; **desk** from 1100 px.

### Phone

```
┌──────────────────────────┐
│ (◎) (Ride mode)    (≋ ☾) │  top bar: brand, layers
│                          │
│           map            │  route, ghost, notes, waypoints
│                          │
│ ┌──────────────────────┐ │
│ │ 35.5 km 1160 m 3:42 ⌃ ⬇│  summary card: tap for the route sheet
│ │ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ │ │  surface lane; "vs base" when changed
│ └──────────────────────┘ │
│ (≡ Gravel explorer ②⌃) (Water ▪) (Gravel ▪)
│ (Quiet ▪) (+3) (🔒3) (+) │  strip: two rows at most
│ (✧ 40 km loop …   later) │  agent bar
└──────────────────────────┘
```

- The bottom stack is the summary card, the strip and the agent bar. Anything larger than one row
  opens as a **bottom sheet** over the stack, one at a time: route, profile, picker, map & rides.
  A sheet has two detents (60 % and full); the grabber toggles or drags. The picker is always full.
- Where things live:

| thing | on the phone |
|---|---|
| totals, GPX export | summary card |
| timeline lanes, shares, waypoint list, the "later" chips | route sheet (tap the summary card) |
| one preference | its chip → one slider inside the summary card |
| the whole profile, limits, base chooser, diff, reset, save as preset, compare-with | profile sheet (the profile chip, "+N", the limits chip) |
| picker | full sheet (the "+" chip, or "Add" in the profile sheet) |
| compare result | replaces the summary card, both routes on the map |
| layers control, legend, rides import, ride list | "Map & rides" sheet (top right); the legend stays on the map as a pill while a layer is on |
| empty, download, error | replace the summary card |

- **Landscape** (short and at least 600 px wide): the stack sits bottom left (440 px), the strip is
  one row, the agent bar is dropped, sheets open as a panel on the right.

### Desk

```
┌───────────────────────────────────────────────────────────────┐
│ (◎ kompass) (Ride mode)                                (≋ ☾)  │
│ ┌─────────────┐                              ┌──────────────┐ │
│ │ ROUTE       │                              │ Gravel expl. ⌄│ │
│ │ totals  GPX │                              │ 2 changes     │ │
│ │ vs base     │            map               │ sliders       │ │
│ │ timeline    │                              │ + add         │ │
│ │ shares      │                              │ limits        │ │
│ │ waypoints   │                              │ compare with  │ │
│ └─────────────┘     (✧ agent bar)            └──────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

- Route card left (372 px), profile card right (404 px), both scroll inside themselves. The picker
  replaces the profile card's content; the compare result sits at the top of the profile card; the
  layers control is a popover left of the profile card. No strip, no sheets.

### Tablet

The desk's route card (340 px) on the left; the phone's strip and agent bar beside it at the
bottom; a chip opens its slider in a card above the strip; profile, picker and layers open as a
panel on the right (400 px).

## Components

All in `parts.tsx` unless noted. "Both" means identical on every breakpoint.

| component | purpose | states | phone | desk |
|---|---|---|---|---|
| `Stats` | distance, climb, time | lg, sm (while tuning), dimmed when busy | summary card, sheet heads | route card |
| `BusyBar` | the engine is working | hidden, running | summary card | route card |
| `DeltaLine` | what the changes did against the base route, in numbers | hidden (no changes), "do not move the route yet", deltas | summary card (first 3–4), route sheet (all) | route card |
| `Lanes` | timeline: elevation, lanes for surface, way type, ridden, and "moved" | rest, scrubbing (cursor on the map), comparing (second elevation line) | route sheet | route card |
| `LaneStrip` | one lane | surface, way, ridden | also alone in the summary card | in `Lanes` |
| `Shares` | legends with percentages for the lanes | | route sheet | route card |
| `Waypoints` | stops: reorder, remove, add; room for per-leg profiles | rest, dragging | route sheet | route card |
| `GpxButton` | the primary action | full, compact, disabled | summary card (compact), route sheet | route card |
| `Strip` (`Final.tsx`) | the profile as chips | chip: rest, selected, changed (dot) | above the agent bar | not used |
| `Tune` (`Final.tsx`) | one chip's slider with hint, reroute time, done | preference, limit | in the summary card | not used (tablet: own card) |
| `DiffBar` | profile head: name (opens the base chooser), "N changes", the changes in words, save as preset, reset | untouched, changed, choosing, naming | profile sheet | profile card |
| `ProfileList` | the sliders by group (collapsed to a summary), add, detours, limits; empty: an invitation | group: collapsed, open, nothing on this route; row: rest, changed, added, held, just added, touches nothing (dimmed) | profile sheet | profile card |
| `PrefRow`, `Dial` | one preference: label, word, number, slider | as above | sheet and `Tune` | profile card |
| `LimitRow`, `Switch` | one hard limit: lock, optional stepper, switch | on, off (struck through), changed, blamed by an error | profile sheet | profile card |
| `Picker` | catalogue: search, groups, add | browsing, searching, no match, item already in use | full sheet | replaces the profile card |
| `ComparePick` | choose the second profile | none, one chosen | end of the profile sheet | end of the profile card |
| `CompareResult` | line keys, trade-off sentence, six metrics, "Ride it this way", dismiss | | replaces the summary card | top of the profile card |
| `LayersPanel` | map / one attribute layer / explored; legend; rides import and list | per mode | "Map & rides" sheet | popover |
| `Legend`, `LegendPill` | the active layer's legend | | pill under the top bar | pill beside the route card |
| `StatusBody` | empty, download, error | see below | replaces the summary card | replaces the route card's body |
| `AgentBar` | the agent's place, not wired | "later" | bottom of the stack | bottom centre |
| `Sheet`, `Sheets` (`Final.tsx`) | bottom sheet or side panel | half, full, dragging, cleared (hold) | all sheets | not used |

## Interaction rules

- **Chip → slider.** Tapping a preference chip selects it and opens its one slider in the summary
  card (totals shrink, the surface lane gives way). Tapping it again, another chip, or "done"
  closes it. A preference added from the strip's "+" opens as a chip straight away.
- **The strip never scrolls sideways.** It wraps to two rows (one in landscape). Order: the profile
  chip, changed preferences, the rest, then "+N", the limits chip (lock and count), "+". What does
  not fit collapses into "+N", from the end. The profile chip, "+N" and the limits chip all open
  the profile sheet (the limits chip scrolls to the limits).
- **Hold-to-clear.** In the phone's profile sheet, holding a slider for 110 ms fades the sheet to
  nothing but that row and the totals; the map shows through while the route reacts. Release brings
  the sheet back. Not needed where the list sits beside the map.
- **Live reroute and the ghost.** Every slider movement reroutes; there is no apply button. While
  the result differs from the base profile's route, that route stays on the map as a dashed ink
  line, `DeltaLine` shows the numbers, and the timeline's "moved" lane marks the stretches.
  A changed profile that does not move the route says so.
- **Diff against the base.** A changed row carries the accent dot; tapping the dot puts the row
  back (an added row is removed). A ring on the slider marks the base value. The head counts the
  changes and says them in one sentence ("Gravel explorer, but more water and never anything
  steeper than 15 %"). Reset drops them all; "Save as preset" makes them a new base.
- **Avoid ↔ seek** is told by position (left of the centre tick or right) and by the word beside
  the label ("avoid", "rather not", "nice to have", "prefer", "seek out"), never by colour.
- **Picker.** Search first, groups below, one line of explanation each, coverage noted where a tag
  is thinly mapped. A tap adds and closes; items in use are dimmed with a check. Limits are in the
  same catalogue, marked with a lock and "limit".
- **Limits** are never sliders: lock, switch, and a stepper where the limit has a number. A base
  limit that was switched off stays in the list, struck through, so the change remains visible.
- **Compare.** Choosing a second profile draws its route in blue beside the plan's in vermilion and
  shows the trade-off in words plus six metrics as "a → b". "Ride it this way" makes it the base.
- **Layers.** Exactly one of: the plain map, one attribute layer (with legend), the explored map.
  On the plain map a switch colours the route by surface instead of the single route colour (off by
  default). Rides import and the ride list live in the same panel, because they feed the explored
  map. The real app's relief and cycle-route toggles belong here too.

## Tokens

### Chrome (`tokens.css`)

Copy the `.r3` block into `:root`, `.dark .r3` into `.dark`, and the `@theme inline` block as it
is, in `web/src/index.css`. shadcn's names keep their meaning; new are `signal`, `glass`, `track`.

| token | light | dark | use |
|---|---|---|---|
| `background` | `#f4f4f1` | `#0f1110` | behind the map |
| `foreground`, `primary` | `#161816` | `#f0f1ed` | ink: text, slider fill and thumb ring, switch on, selected chip, secondary buttons |
| `primary-foreground` | `#ffffff` | `#0f1110` | text on ink |
| `card`, `popover` | `#ffffff` | `#1a1c1b` | opaque surfaces |
| `glass` | `rgb(255 255 255 / .9)` | `rgb(26 28 27 / .9)` | floating cards, with `backdrop-blur-xl` |
| `muted`, `secondary`, `accent` | `#ecece8` | `#262928` | quiet fills |
| `muted-foreground` | `#5f635f` | `#a2a7a2` | secondary text |
| `border` | ink 10 % | white 10 % | hairlines |
| `input` | ink 18 % | white 20 % | field borders |
| `track` | ink 12 % | white 16 % | slider track, empty lane, progress |
| `signal` | `#d23f18` | `#ff7a57` | **the one accent** |
| `signal-foreground` | `#ffffff` | `#1c0b05` | text on the accent |

The accent is used for exactly three things: the primary action (GPX export), the
changed-from-base marker (dot, count badge, "moved" lane), and the needle of the brand mark. It is
the route's hue on purpose: one colour means "your plan".

The audit of round 2's coloured chrome:

| element | round 2 | round 3 |
|---|---|---|
| slider fill | green (seek) / orange (avoid) | ink |
| "prefer", "seek out" … | green / orange text | grey text |
| number beside a slider | green / orange | ink |
| "added", "limit" tags | accent fill | grey outline |
| lock icons | accent | ink |
| switches | accent | ink |
| agent sparkle and send | accent, ink | grey (it is not wired) |
| delta numbers beside the totals | accent | removed; `DeltaLine` in ink |
| "N changes" | accent text | accent dot, grey text |
| compare chip, card and numbers | blue fill, blue tint, two colours | ink chip, neutral card, ink numbers; colour only in the two line keys |
| ghost route | ink, dashed | unchanged (neutral) |
| timeline cursor | accent | route colour (data) |

### Data (`palette.ts`)

Not theme tokens: picked against the outdoor map, like `web/src/map/palette.ts`, and exposed to the
chrome as CSS variables by `dataVars(theme)`.

| what | light | dark | why |
|---|---|---|---|
| route | `#d23f18` | `#ff7a57` | vermilion, the hue the map keeps free; white / near-black rim |
| compared route | `#0072b2` | `#56b4e9` | Okabe–Ito blue, darker than the map's water |
| ghost (base route) | `#161816` dashed | `#f0f1ed` dashed | neutral |
| surface: paved | `#5d6b7c` | `#93a3b8` | slate |
| surface: gravel | `#c98a1e` | `#e3ab45` | ochre |
| surface: dirt & grass | `#8f5630` | `#b9794d` | brown |
| surface: unknown | `#a3a3a3` hatched | `#8f8f98` hatched | the map palette's "unknown" |
| way: path | `#1f7a5c` | `#4fb891` | |
| way: forest track | `#86a845` | `#a9c865` | |
| way: bike path | `#6f5df0` | `#a59cff` | the map's cycling violet |
| way: quiet street | `#a8aeb6` | `#7d858e` | |
| way: minor road | `#dcae2f` | `#e6c456` | the map's road yellow |
| way: main road | `#8e2f3c` | `#d0677a` | maroon, apart from the route's vermilion |
| ridden before | `#0a8f86` | `#35d0c0` | the explored map's teal; never ridden has no colour |
| ordered values | viridis, 5 steps | viridis, 5 steps | traffic, trail difficulty, cost; the end that would vanish on the map is dropped |

Surface runs firm to soft in earth tones, way type runs car-free (greens, violet) to busy (yellow,
maroon). Lanes are 8 px high on `track`; legends use 8 px swatches.

### Type, radii, spacing, elevation, icons

- **Font:** Manrope Variable (self-hosted through `@fontsource-variable/manrope`), figures always
  `tabular-nums`.
- **Type scale** (Tailwind's names, so class mergers know them; only `2xs` is added):

| class | size / line | weight | use |
|---|---|---|---|
| `text-2xs` | 11 / 14 | 700, uppercase, wide tracking | section labels, tags |
| `text-xs` | 12 / 16 | 500–600 | secondary text, chips, deltas |
| `text-sm` | 14 / 20 | 600 | rows, body, buttons |
| `text-base` | 16 / 24 | 800 | titles |
| `text-2xl` | 24, tight | 700 | the totals (`text-lg` while tuning) |

- **Radii:** `rounded-control` 12 px (rows, inputs, inner boxes), `rounded-card` 20 px (floating
  cards), `rounded-sheet` 26 px (top of a sheet), `rounded-full` (chips, buttons, switches).
- **Spacing:** a 4 px grid. `--gutter` between a card and the screen edge: 10 px on the phone,
  16 px from 720 px. Card padding 14 px on the phone, 16 px otherwise; 8 px between stacked cards,
  6 px between chips.
- **Touch:** chips 36 px high, buttons 32 to 36 px, list rows 44 px, the slider thumb 22 px in a
  28 px row.
- **Elevation:** two levels: `shadow-float` (cards, chips) and `shadow-sheet`.
- **Icons:** lucide, 16 px in controls, 14 px beside small text, always in the text colour. A lock
  means a hard limit, everywhere.

## Empty, loading and error states

Switch with `?state=`. On the phone they replace the summary card, on desk the route card's body;
the strip and the profile stay usable (the profile can be set before there is a route).

| state | shows | map |
|---|---|---|
| `empty` | "Tap the map to set a start", and which profile will decide the way | no route, no waypoints |
| `download` | "Getting the region ready", progress bar, MB done of total; the strip is dimmed and inert | no route |
| `busy` | totals dimmed, a running bar and "Routing…" under them | the route at 45 % |
| `error` | "No route with “Paved only”", where the gap is, "Lift “Paved only”" and "Show the limits"; the limit's row says "blocks the route" | the route without the limit as the dashed ghost |

An error always names the limit and offers to lift it. States are ink; no red.

## Reserved for later

Visible as dashed chips, not built: **Ride mode** (top bar), **profile per leg**, **through this
area** and **avoid this area**, **draw it** (sketch routing), **make it a loop** (all with the
waypoints), **learn from my rides** (base chooser), more attribute layers from the catalogue (layers
panel), and the **agent bar**, which will edit the same profile and report in the diff's words.

## As built (#31)

The shell (`web/src/planner/`, [../planner.md](../planner.md)) follows this reference; where it
deliberately differs:

- **Real data, grouped.** Surface lanes and legends group the engine's seven classes into the four
  colours (paved and rough paving → Paved; compacted and gravel → Gravel; soft and other → Dirt &
  grass; unknown). The way types map to the six colours; "Forest track" reads "Track" (the engine's
  `track` is farm tracks too).
- **Map & rides**: the modes are Map / Information / Explored. The information chips are the
  region's own overlay attributes (seven first, the rest behind "+N more", working, not reserved);
  "Cost in this profile" is not built yet (needs an `arcCosts` layer). Relief, cycle routes and
  "My rides on the map" are switches in the same panel; the ride library is mounted as it is.
- **Inspect a way** (the design is silent): a tap adds a waypoint; inspecting is a switch in Map &
  rides, offered with an information layer, with a "Tap a way to inspect · Done" pill while on.
- **Stops**: the list's "+ Stop" became the hint "tap the map to add a stop" plus Reverse and
  Clear; a tap joins the nearest leg (least detour) or extends past the destination.
- **The error** names the limit by lifting limits one at a time (the engine says only that there is
  no route); it does not say where the gap is.
- **Own presets** are renamed and deleted from the profile's head while one is the untouched base.
- **The sixth compare metric** is "New to me" with a personal layer, else "Tracks & paths".
- **Sheets**: dragging the grabber below half the first detent closes the sheet.
- **Engine state**: a dot on the brand mark while the graph loads; the download state replaces the
  summary card as designed. The theme choice (system / light / dark) was added later, in Map & rides (docs/map.md).

## Changed after playtest 1 (#36)

The sections above are the design as drawn; these points override them.

- **Phone stack**: the strip sits *above* the summary card and is **one row that scrolls sideways**
  (no scrollbar, a fade at an edge with more behind it, the profile chip first, changed preferences
  next); no "+N" chip on the phone. The tablet keeps the two-row strip.
- **No agent bar on the phone** for now (`AGENT_ON_PHONE` in `shell.tsx`); the desk and tablet keep it.
- **Route toggle**: an eye button in the top bar's right pill (only while there is a route), and the
  key `H`. It hides every route line (plan, ghost, compared, "why not") and the route notes; stops stay.
  Not saved.
- **Sliders move only from the knob** (44 px target): a tap or press on the track does nothing, a
  drag starts after 4 px sideways (a vertical swipe scrolls the sheet), the keyboard as before. The
  Detours slider uses the same control.

## Sandbox only

The theme toggle (the real app follows the system setting), the toy engine and its fixed routes,
the map repainted in the outdoor colours on public tiles, the wash under the attribute layers, the
ride list.
