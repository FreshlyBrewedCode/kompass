# Planner design round 1

Four directions for the responsive Kompass planner (issue #7). Real stack (Vite, React, TypeScript,
Tailwind v4, shadcn/ui, MapLibre GL JS), mock data. This is a design sandbox: it does not depend on
the monorepo and nothing here is the product yet.

## Run

```sh
cd design/planner
bun install
bun run dev        # http://127.0.0.1:7951
```

- `/` is the index, `/a` … `/d` are the directions. Resize the window or open it on a phone: below
  900 px you get the phone layout.
- URL switches: `?theme=light|dark`, `?view=plan|profile|layers`, `?layer=debug|explored`, `?compare=1`.
- Screenshots: `nix build nixpkgs#chromium -o .chromium`, start the dev server, then
  `bun scripts/shots.mjs` (writes `/tmp/kompass-design-1/<letter>-{phone,phone-profile,desktop,board}.png`;
  `EXTRA=1` adds dark phone, light desktop and the layer views). If Chromium fails with a GLIBC
  error, run it with `LD_LIBRARY_PATH` unset.

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

## The directions

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
