# Map style round 2: four variants

Design round for issue #37 (epic #36). The verdict after the first playtest: the map is not readable
enough; the lines should be thicker, cased, and tell the tier and the track grade at a glance, and the
surface matters most to a gravel rider. This note describes four variants, built as real styles on
the branch `design/map-round-2` (a prototype branch, not merged; the prototype code is not carried
over). The chosen one is built as the outdoor style: [map.md](../map.md#the-outdoor-style).

## Decision: D, light first (2026-11-21)

The user picked **D · Bands**. Their note on the pick: "The dark mode is much less readable imo. I
would deprioritize it for now and focus on light mode." So light is the product and gets the polish;
dark keeps D's colours and has to work (no broken or invisible layers), with cheap fixes only.

What the build (#37) changed against the mock-up, and why:

- **Tracks before z13 from the overlay** (it now carries grade 1–3 tracks from z11, all from z12, with
  grade and surface): the bands start at z11 instead of a plain base-tile line at z12. To keep the
  overview calm they fade in (half opacity at z11, full from z12.5), are thinner there and have no
  rim at z10, and the contour lines are faint at z11–12 (as brown hairlines they read as tracks).
- **Bridges, tunnels, crossings, car parks from the overlay** (`bridge`, `tunnel`, `layer`,
  `service_kind`): the bands are sorted by crossing level, bridges get rails, tunnels are faint;
  driveways from z14 and car-park aisles from z15, thinner than service roads (no more combs at z15).
- **Ferries** are a blue dashed line, never a band; the information, explored and cost bands skip
  them (no rings on the lakes) and everything the ways do not draw at that zoom.
- **Quieter land cover**, half way to C's: forest `#d3e6c3` (D `#cde3ba`), meadow `#e8efd8`,
  hillshade 0.22 (D 0.26). The ochre bands read better on it; it is still clearly a forest.
- **The ochre stays D's `#e2a85a`**: on the demo region the route (vermilion with its white rim), the
  explored band (teal) and the cost layer (green, grey, magenta) all read on top of it at z13–15.
- **Paths**: firm (long dashes) and soft (short dashes) are told apart, as the tracks are.
- **Widths** got stops at z8, z10, z12, z14 and z16 for a smoother hierarchy; the tertiary road's
  casing is a step darker than the minor roads'.
- **Dark**: the tracks' rim is a visible brown instead of black, the paved track a grey band like
  the roads instead of a bright one (it read as the most important road).
- **The key** is part of the app ("Map & rides", the Map tab), drawn from the style's own tables
  rather than by MapLibre layers (no second map on the phone).

## How to look at them (on the prototype branch)

```sh
KOMPASS_DATA_DIR=<demo build> KOMPASS_DEV_PORT=7960 nix develop -c bun run dev
# http://127.0.0.1:7960/?mapstyle=a|b|c|d      a variant (without the parameter: today's style)
# http://127.0.0.1:7960/?mapkey=a|b|c|d        its key, drawn by MapLibre with the variant's own layers
nix develop -c bun design/map-round-2/shots.ts      # the screenshots (see the file's head for options)
nix develop -c bun design/map-round-2/keys.ts       # key-<variant>.png
nix develop -c bun design/map-round-2/sheet.ts      # the 2×2 comparison sheets
```

The screenshots are not in the repository. They are all from the demo region (Titisee, Black Forest):
phone 390×844 at z11, z13 and z15 in both themes, desktop 1440×900 at z13, plus z13 with a route line,
with the explored band and with the "Surface" information band.

Code: `web/src/map/round2/` (`shared.ts` the classes, widths and the layer builder, `variants.ts` the
four variants, `key.ts` the key page), switched in by `style.ts` and `controller.ts`.

## What all four share

These are answers to the known weak points, independent of the choice:

- **Tiers.** main road (trunk, primary) › secondary › tertiary › minor road (unclassified) › street
  (residential) › service › track › cycle path › path. Width always follows the tier.
- **Surface in three classes**: paved, gravel (compacted or loose), ground (earth, grass). From
  `surface_class`, else the track grade; roads, cycle paths and footways with nothing mapped count as
  paved, tracks and paths with nothing mapped are *unknown* and drawn as such, never guessed.
- **Grade 1 to 5**: the track grade where mapped, else read off the surface (paved 1, compacted 2,
  gravel 3, soft 4). A paved way is always drawn as a road-like band, whatever its class.
- **Thicker lines, every line with a rim.** Roads are cased bands, single lines lie on a light halo
  (dark in the dark theme). Widths in px (band fill; the casing adds 1.0 / 1.6 / 2.0 / 2.6):

  | | z11 | z13 | z15 | z17 |
  |---|---|---|---|---|
  | main road | 2.7 | 4.6 | 8.4 | 16 |
  | secondary | 2.2 | 4.0 | 7.4 | 14 |
  | tertiary | 1.6 | 3.3 | 6.4 | 12.5 |
  | minor road | 1.1 | 2.6 | 5.2 | 10.5 |
  | street | 0.9 | 2.2 | 4.6 | 9.5 |
  | service | 0.6 | 1.3 | 2.8 | 6 |
  | paved track (band) | 0.9 | 1.7 | 3.0 | 5.4 |
  | track (line; halo +1.2 / 1.9 / 2.4 / 3.0) | 0.9 | 1.7 | 2.5 | 3.8 |
  | cycle path | 0.8 | 1.5 | 2.2 | 3.3 |
  | path | 0.6 | 1.1 | 1.6 | 2.5 |

  Today's style draws a track 1.15 px and a minor road 1.8 px wide at z13.
- **One source for the roads at every zoom.** The overlay draws each way from the zoom it is in the
  tiles (main roads z8, secondary z9, tertiary z11, minor roads z12, tracks and paths z13). The base
  tiles only add tracks at z12 (one plain line, they know no grade), motorways and railways.
- **Bridges and tunnels**, from the base tiles' flags (prototype, see "Missing data"): a bridge gets
  two rails from z13.5, a tunnel is veiled and gets dashed rails from z13.
- **Lakes above the relief**: no hillshade and no contour lines on water.
- **The dark relief**: shadows barely darker than the land (`#050706`, strength 0.3 instead of black
  at 0.4), the lit slopes carry the form. Forest stays distinguishable from open land.
- **Kept from today**: violet for cycle paths and the band of signed cycle routes, grey-out (here: 45 %
  opacity) for private / no bicycle access, paved paths along a road only from z15, the information
  band and the explored band between the rims and the lines. A ferry line is no longer drawn as a way.
- **Dashes** (dash / gap in line widths): grade 3 `6 / 1.7`, grade 4 `2.6 / 1.6`, grade 5 `0.9 / 1.5`,
  unknown `4 / 2.2`, path `3 / 1.7`. One layer per dash pattern, as today.

## A · Classic

The outdoor-map convention the user knows: the colour of a road is its tier, a track is a brown line
whose dash is its grade.

| | light | dark | shape |
|---|---|---|---|
| main road | `#f8c467`, casing `#b3822b` | `#9a742c` | band |
| secondary | `#fde488`, casing `#b09a45` | `#8d7c44` | band |
| tertiary | `#fff5c0`, casing `#8c8578` | `#77704f` | band |
| minor road, street, service | `#ffffff`, casing `#8c8578` | `#62676a` | band |
| track grade 1 (paved) | `#ffffff`, casing brown `#7a5632` | `#62676a` | narrow band |
| track grade 2 | `#6b4423` | `#ead3ac` | solid line |
| track grade 3 / 4 / 5 | `#6b4423` | `#ead3ac` | long dashes / short dashes / dots |
| track unknown | `#a38a70` | `#93806a` | medium dashes, paler |
| unpaved road | as the track of its grade, a little wider | | |
| path unpaved / paved | `#5b4633` dashed / `#93897a` solid | `#c7ae92` / `#8b8072` | thin line |

- **For it**: nothing to learn; the hierarchy is the one of every outdoor map; five grades fit in one
  colour, so the map stays in a narrow range (green, white to yellow, brown) and the layers on top
  are the only strong colours.
- **Against**: the surface is only implied by the dash. At z13 on a phone three steps read at a
  glance (solid, dashed, dotted), not five. The orange main road is the colour nearest to the route's
  vermilion. Dense forest networks get heavy in dark brown.

## B · Surface first

The colour is the surface, in the planner's own surface colours (`planner/palette.ts`): slate is paved,
amber is gravel, brown is ground. The width is the tier; the grade is not shown.

| | light | dark | shape |
|---|---|---|---|
| paved road | `#ffffff`, casing slate `#566476`; main `#d3d5d9` / `#414d5e`, secondary `#e6e8eb` | `#707882`, main `#939ca8`, secondary `#838b96` | band |
| gravel (track, road, path) | `#c4820f` | `#edb04a` | solid line |
| ground | `#8a4f2a` | `#cf8a5e` | long dashes (path: short) |
| unknown | `#77777c` | `#8f8f98` | short dashes |
| paved path | `#7b8794` | `#8e98a4` | thin solid line |

- **For it**: the gravel rider's first question is answered without a key and from far away; the same
  three colours mean the same in the timeline and the legend.
- **Against**: the loudest of the four: amber covers the forest and sits next to the route's
  vermilion (worst in the dark theme, where the route is salmon). Roads lose the tier colour: a main
  road is only wider, and its grey-blue band can be read as a river. Grade 2 and 3 look alike. The
  "Surface" information band becomes a second, differently coloured copy of the map.

## C · Quiet base

A pale base and one ink. What a gravel rider rides is the foreground: tracks, paths and the small
connecting roads. Main roads are present but recede.

| | light | dark | shape |
|---|---|---|---|
| main road, secondary | `#dbd7ce`, casing `#a39d91` | `#313433` | band, under the small roads |
| tertiary, minor road | `#ffffff`, casing ink `#4a443c` | `#a3a8aa` | band, the strong one |
| street, service | `#ffffff`, casing `#aca69b` | `#5d6163` | band |
| track grade 2 / 3 / 4 / 5 | ink `#4b3524`, 15 % wider than in A | `#f1dfc2` | solid / long / short dashes / dots |
| track unknown | `#8f8275` | `#9a8f80` | medium dashes |
| path | `#4d3e31` dashed, paved `#8e8a84` | `#cdbba2` / `#7c7f80` | thin line |
| base | land `#f5f4f0`, forest `#dbe8d1`, water `#bcdcf0`, hillshade 0.2 | land `#191c1a`, forest `#1c2a20` | |

- **For it**: the calmest: route, explored band and information band are the only colours on the
  map. The rideable network is the first thing one sees. Best base for the cost debug view (#36).
- **Against**: the furthest from the familiar look. Main roads are hard to find at z11 to z13, and
  they are both orientation and a warning. Like A, the surface is only in the dash. The pale forest
  gives up some of the "where is the wood" reading.

## D · Bands

Every way a gravel bike rolls on is a road-like band, and the fill darkens with roughness: white
tarmac, cream compacted, ochre gravel. Soft ground loses the band and breaks up into a dashed dark
line. Roads keep the familiar tiers, in a lemon yellow that stays apart from the ochre.

| | light | dark | shape |
|---|---|---|---|
| main road | `#ffe45e`, casing `#9c8514` | `#b9a033` | band |
| secondary | `#fff1a1`, casing `#9c8514` | `#8f8347` | band |
| tertiary, minor road, street, service | `#ffffff`, casing `#857f73` | `#7b8082`, `#686d70` | band |
| grade 1 (paved track) | `#ffffff`, rim brown `#5e3b1b` | `#c9ced1` | band |
| grade 2 (compacted) | `#fbeecb`, rim `#5e3b1b` | `#dcc793` | band, 30 % wider than A's track, fine rim (1.0 px at z13) |
| grade 3 (gravel) | `#e2a85a`, rim `#5e3b1b` | `#c48f45` | band |
| grade 4 / 5 (soft) | `#6f4320` | `#d98f58` | short dashes / dots |
| unknown | `#e6e2da`, rim `#9a9186` | `#4c4f50` | pale band |
| unpaved road | the band of its grade at the road's width | | |
| path | `#5f4732` dashed, paved `#93897a` | `#c9ad8d` / `#8b8f91` | thin line |

- **For it**: tier *and* surface read without the key: the more a way looks like a road, the better
  it rolls. The ramp is ordered in lightness (it survives colour blindness and grey scale) and the
  worst grades change shape as well. Closest to "thicker lines with a casing".
- **Against**: more colour in the forest than A or C; ochre is again a neighbour of the route's hue
  (the route's white rim keeps it apart, see the route sheet). At z13 cream against ochre is clear,
  cream against a white paved lane is subtle. In the dark theme a band's rim is black on dark land, so
  the bands read as plain coloured lines there.

## Recommendation

**D**, with **A** as the fallback if D proves too colourful outdoors.

- D is the only variant that shows both things the user asked for on the default map: the tier (width
  and the road colours they know) and the surface (the fill). A and C need the "Surface" layer for the
  surface, B gives up the tier and the grade.
- It keeps the map calm enough: one hue family (cream, ochre, brown) for everything unpaved, and the
  route, the explored band and the information band stay readable on it (see their sheets).
- Two things to settle when building it: take C's quieter land cover and relief if the forest feels
  busy under the bands, and check the ochre against the route on a phone outdoors.

Whatever is picked, the shared parts above are worth building: they fix the thin lines, the missing
bridges, the tracks before z13 (as far as the data allows) and the dark relief.

## Missing data

- **Bridges and tunnels are not in the overlay.** `edges.parquet` has `on_bridge` and `in_tunnel`,
  the overlay tiles do not export them. The prototype takes the flags from the base tiles and draws
  rails over everything, which cannot lift a bridge above the road it crosses nor really hide a tunnel.
  Needed: both flags in the overlay (and the OSM `layer`, to order crossings).
- **No tracks below z13 in the overlay** (`MINZOOM` in `pipeline/tiles.py`: track and path 13). The
  base tiles have tracks from z12 without grade or surface and nothing at z11, so z12 shows one
  plain line and z11 only the tracks that carry a signed cycle route. Needed: tracks from z11 in the
  overlay (perhaps grades 1 to 3 only), with the tile sizes checked.
- **The kind of a service road** (`service=parking_aisle`, `driveway`) is a string in `edges.parquet`
  and not in the overlay: car parks draw as combs of service roads at z15.
- **Ferry lines** are edges with `highway=ferry`. The variants no longer draw them as ways, but the
  information band and the explored band still do (a ring on the lake).
- **The demo graph does not load in this branch** (the build is format version 3, the engine here
  reads 2; #35), so the route in the screenshots is a stand-in: a shortest path over the demo edges
  (`design/map-round-2/mock-route.py`), drawn with the planner's route style.

Not done in the prototype: the key as a part of the app (the mock-up is a page of its own), tapping a
way in a variant (it works through an invisible layer but is untested), the e2e.
