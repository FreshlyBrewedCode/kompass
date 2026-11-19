# Planner design sandbox

Design rounds for the responsive Kompass planner (issue #7). Real stack (Vite, React, TypeScript,
Tailwind v4, shadcn/ui, MapLibre GL JS), mock data. This is a design sandbox: it does not depend on
the monorepo and nothing here is the product yet.

- **Round 2** (`/c1`, `/c2`, `/c3`): three takes on the direction picked in round 1, C "Sentence",
  rebuilt around sliders and a preference picker. [Jump to round 2](#round-2-c-with-sliders).
- **Round 1** (`/a` … `/d`): four directions. `/c` stays as the reference for round 2.

## Run

```sh
cd design/planner
bun install
bun run dev        # http://127.0.0.1:7952
```

- `/` is the index with links to every state. Resize the window or open it on a phone: below 900 px
  you get the phone layout.
- URL switches: `?theme=light|dark`, `?view=plan|profile|layers`, `?layer=debug|explored`, `?compare=1`.
  Round 2 adds `?demo=1` (two preferences already added), `?picker=1` (picker open) and, for `/c1`,
  `?hold=climb` (the sheet as it looks while a slider is held) and `?sheet=peek`.
- Screenshots: `nix build nixpkgs#chromium -o .chromium`, start the dev server, then
  `bun scripts/shots2.mjs` (round 2, writes `/tmp/kompass-design-2/<id>-{phone,phone-profile,phone-picker,desktop,board}.png`;
  `EXTRA=1` adds compare, layers, dark phone and more) or `bun scripts/shots.mjs` (round 1). If
  Chromium fails with a GLIBC error, run it with `LD_LIBRARY_PATH` unset.

## What is real and what is mock

- Real: waypoint add / reorder (drag the grip) / remove, profile choice, tuning (sliders, faders,
  nudges, rose handles all edit the same profile object), comparing two profiles on the map, light
  and dark, the three map views. The attribute map colours the base map's own road network with
  MapLibre style expressions, the way the architecture plans it for the edge overlay; "Cost in this
  profile" reacts to the tuning.
- Mock: the routes never change (three fixed routes, one per profile), "rerouted in n ms" is
  decoration, the import drop zone only lists file names, the explored map uses ten made-up tracks.
- Dashed chips and keys mark what comes later (per-leg profiles, via/avoid zones, sketch, loops,
  ride mode, the agent). They show where it would live, nothing more.
- Area: the Black Forest east of Freiburg, picked because it is public and has gravel. Route
  geometry, elevation and surface tags come from BRouter (`scripts/mock-routes.py`), data
  © OpenStreetMap contributors (ODbL). Base map: OpenFreeMap. No personal data anywhere.
- The edge views open zoomed in, because the public tiles only carry tracks and paths from zoom 13.
  The real overlay tiles will not have that limit.

## Round 1: the directions

### A · Field sheet (`/a`): bottom sheet, sliders

- **Idea:** a printed topo sheet with a card you pull up over it. One sheet with three tabs (Route,
  Profile, Layers) and three detents; on desktop the route sits left and the profile stays open on
  the right. Hard limits are switches, preferences are sliders that are neutral in the middle.
- **Good at:** familiar, nothing to learn, the most room for numbers (stats, both breakdowns, a
  proper side-by-side table). Scales to many preferences without redesign.
- **Weak spot:** the least distinctive of the four, and on the phone the sheet and the map fight for
  the same screen: tuning with the sheet up leaves a strip of map.
- **Grows into:** ride mode as the peek detent turned into a junction card; the agent as a fourth
  tab or a field at the top of the sheet whose edits show up as moved sliders.

### B · Mixer (`/b`): fixed split, faders, timeline

- **Idea:** an instrument panel. The profile is a mixing desk: one fader per preference (up seeks,
  down avoids), latching keys for hard cuts, and two decks so you can A/B two profiles; deck B shows
  as a marker on every fader and as the second line on the map. The route is a timeline with lanes
  for surface, way type and never-ridden.
- **Good at:** tuning. All eight preferences and both profiles are visible at once, and the timeline
  answers "why this way" along the distance. The legs under the timeline are a natural home for
  per-leg profiles.
- **Weak spot:** dense and a bit nerdy; the fixed split gives the map only the top third of the
  phone, and the console eats 40 % of a desktop window.
- **Grows into:** ride mode reuses the LCD readout as the glanceable junction display; the agent is
  the command line above the faders, and you watch it move them.

### C · Sentence (`/c`): full map, floating cards, words

- **Idea:** the map is the app. The profile is a sentence ("Take me along gravel and forest tracks,
  quiet roads … Never main roads"), every phrase can be tapped and nudged with less / more, and a
  comparison comes back as a trade-off in words plus a small table. The route line is coloured by
  surface and carries "why this way" notes on the map.
- **Good at:** legibility of the profile, and the straightest path to the agent: the agent bar and
  the nudge chips edit the same sentence, which is exactly the vision's "two editors of one profile".
- **Weak spot:** coarse tuning (five steps per preference) and no overview of the numbers behind the
  words; with twenty preferences the sentence gets long. Floating cards cover a lot of a phone map.
- **Grows into:** ride mode keeps the full map and swaps the card for junction chips; the agent is
  already the main input, only the wiring is missing.

### D · Rose (`/d`): tab bar, candidates, compass rose

- **Idea:** compare first. Every profile is a candidate route that is always on the map; you swipe
  the cards and pick a line. A profile is a shape on a compass rose (centre avoids, dashed ring is
  neutral, rim seeks) with draggable points, and comparing two profiles is two shapes on one rose.
- **Good at:** the first-playtest question "what does this profile do differently" is the default
  view, not a mode. The rose gives a profile a recognisable silhouette and carries the name.
- **Weak spot:** a radar chart is pretty but imprecise, breaks down beyond about ten axes and says
  nothing about hard limits; three always-on routes get busy on a small map.
- **Grows into:** ride mode is already a tab; the rose can become the junction display (one petal
  per branch). The agent proposes candidates as further cards in the same carousel.

## Round 2: C with sliders

The pick from round 1 was C, with this feedback: plain sliders are the best way to see and set the
weights; profiles start from pre-defined bases and are tweaked per plan, with the route following
in real time; only a few attributes are always on screen, the rest come from a picker you search,
"like a filter you put in"; the result can be saved as a preset.

### What all three share

- **A profile is a base plus this plan's changes.** Pick a base (Gravel explorer, Paved & quiet,
  River valley, Blank slate, your own presets), then tweak. The header says "Gravel explorer · 2
  changes", every changed row carries a dot (tap it to put the row back) and a ring on the slider
  at the base's value. Reset drops the changes, "Save as preset" turns them into a new base.
- **Four sliders are always there** (gravel & unpaved, low traffic, climbing, never ridden). The
  base brings its own extras; everything else comes from the picker and can be removed again.
- **Soft and hard look different.** A preference is a slider that is neutral in the middle (avoid ↔
  seek) with its value in a word ("prefer", "seek out"). A limit is a lock with a switch, and a
  stepper where it carries a number (max grade 15 %, max trail difficulty S1). Limits sit in their
  own block, "never broken".
- **The picker is the catalogue**: 36 preferences and 7 limits in eight groups (surface, way type,
  traffic, landscape, terrain, routes & access, trail difficulty, my rides), one line of
  explanation each, a note where the tag is thinly mapped. Search matches name, explanation and group.
- **Dragging reroutes.** The toy engine (`src/round2/model.ts`) cuts the three mock routes at the
  nodes they share and picks the cheapest candidate per section under the current profile, so a
  slider flips single stretches of the route at different positions, with real geometry.
- **The timeline from round 1's B is back**, compact: elevation over lanes for surface, way type
  and never ridden, a fourth lane marking the stretches your changes moved, and a scrub that puts a
  dot on the map.
- Kept from C: the full map, the route coloured by surface, "why this way" notes on the map (they
  follow the route as it changes), the trade-off in words when a second profile is compared, the
  agent bar.
- Map views: normal, attribute map (surface, way type, traffic, trail difficulty, cost in this
  profile; the last one reacts to the sliders), explored map. Rides import and the ride list live
  with the map views, because the explored map is what they feed.
- Dashed chips mark room for later: profile per leg, via and avoid areas, sketch, loops, ride mode,
  learn from my rides; the agent bar is in place and not wired.

### What happened to the sentence

It is gone as an editor and stays as a read-out. Three reasons: you asked for sliders; a sentence
that lists every preference grows with the catalogue; and tapping words to change numbers was the
coarse part of round 1.

What survives is one generated line that describes **the changes, not the profile**: "Gravel
explorer, but more water and never anything steeper than 15 %." Its length follows the number of
changes, so it stays short however large the catalogue gets. It is shown under the profile name, in
the collapsed sheet, and it is the default description of a saved preset. It is also exactly what
the agent needs later: when it edits the profile from "quiet, no forests", this line is how it says
what it did, next to the sliders that moved. The same voice answers "what did my changes do" (C3's
verdict) and "how does the other profile differ" (the compare card).

### C1 · Sheet (`/c1`): bottom sheet, the whole list, search-first picker

- **Idea:** one sheet with three detents (peek, half, full) and three tabs: Route, Profile, Map.
  The profile tab is the whole editor as a list. While a slider is held, the sheet clears away and
  leaves only that row and the totals, so the map is free at the moment you need it
  (`?hold=climb`). The base profile's route stays on the map as a dashed ghost while yours differs.
  On desktop: route card left, profile card right, as in round 1.
- **Answers:** editor in a sheet with detents; picker as a searchable list with room for every
  explanation; live comparison as a ghost route plus deltas next to the totals.
- **Weak spot:** at rest the half sheet covers 58 % of a phone screen, and the sixth slider is
  below the fold. Hold-to-clear needs to be found once (it happens by itself when you drag).

### C2 · Strip (`/c2`): chips, one slider at a time, chip picker

- **Idea:** the map keeps the screen. Above the agent bar runs a strip of chips: the base profile
  first, then one chip per active preference with a tiny meter, the limits with a lock, and "Add".
  Tap a chip and one slider opens in the card above, with its explanation; tap the base chip for
  chooser, diff, preset and compare. The totals card grows into the route details. On desktop the
  strip is a dock at the bottom centre.
- **Answers:** editor as a strip of chips that expand; picker as grouped chips (tap to read the
  explanation, tap again or "Add" to add); live comparison as numbers ("vs base +1.9 km, −147 m,
  −21 min, −9.6 km gravel").
- **Weak spot:** no overview. You see one value at a time, the strip scrolls sideways once there
  are more than three or four preferences, and reading a whole profile means swiping through it.
  The chip picker is fast for someone who knows the catalogue and thin for someone who does not.

### C3 · Bench (`/c3`): fixed split, dense rows, category grid

- **Idea:** nothing floats. The map has its own pane on top, the timeline is the seam, and below
  it a panel with four tabs (Profile, Stops, Compare, Map). Every slider is one line: name, slider,
  number. On desktop the profile is a docked column and the timeline a dock under the map, with the
  stops next to it, where per-leg profiles would go.
- **Answers:** editor as a full-height panel that never hides the map or the timeline; picker as a
  grid of categories you drill into ("2 in use · 5"); live comparison as a sentence ("Your version
  is 1.9 km longer but 21 min faster, with 147 m less climbing").
- **Weak spot:** the map is a third of the phone screen, always, and the app stops feeling like a
  map. The densest of the three, with small touch targets on the one-line sliders.

### Recommendation

**Build on C1, and borrow two things.** The list is the only form that shows a whole profile at a
glance (sliders, what differs from the base, the limits), and "build up your own set on the go"
needs that overview once there are eight rows. The sheet is what an iPhone user expects, it gives
the picker room for explanations, and hold-to-clear removes round 1's objection at exactly the
moment it mattered: while tuning. The desktop layout falls out of it without a second design.

Borrow from C2 the delta numbers next to the totals (already in C1's header) and, later, the chip
strip as the *peek* state of the sheet: profile at a glance with the map open, pull up for the
list. Borrow from C3 the verdict sentence under the profile name. C3's one-line rows are worth
having as a density setting on desktop.

### What is real and what is mock in round 2

- Real: base choice, sliders, limits with numbers, the picker with search, add and remove, the
  diff against the base, reset, save as preset (it appears in the chooser), compare, waypoints,
  the sheet detents and hold-to-clear, the timeline scrub, the three map views, light and dark.
- Mock: the engine. It knows three routes and splices them, so the numbers are honest for the line
  on the map but the landscape shares (forest, water, edge) are made up, and "rerouted in n ms" is
  decoration. Waypoint edits do not reroute. Presets are gone on reload. The attribute map paints
  five attributes from the public base tiles; the rest of the catalogue needs the real overlay.
- What the profile data must support, as this design uses it, is in `src/round2/model.ts`: a base
  id, soft weights by attribute id (−100 … +100, absent means no opinion), hard limits by id with
  an optional number, the diff of both against the base, and presets as full copies.
