# The profile

How a rider's wishes become a cost per arc. A profile is plain data that the sliders, the saved
presets and (later) the agent all edit; the engine compiles it into one cost per arc for the whole
graph whenever it changes, and the search ([routing.md](routing.md)) runs on that. Code:
`engine/core/src/{profile,catalogue,cost,presets,personal}.rs`; the shipped presets are
`engine/presets/*.json`; the types the web app sees are generated into `web/src/engine/generated/`
(`bun run gen:engine`, checked by `cargo test`).

## The model

```json
{ "name": "Gravel explorer", "base": "gravel_explorer",
  "weights": { "unpaved": 50, "quiet": 70, "climb": 20, "forest_edge": 0 },
  "limits": { "legal_only": true, "max_grade": 14, "paved_only": false },
  "bounds": { "min_factor": 0.5, "max_factor": 20 },
  "turn_m": 20 }
```

- **weights**: preference id → −100 … +100: −100 avoid, +100 seek. An absent id has no opinion; an
  explicit 0 routes the same but stays on screen (the UI's "added, not set yet"). Unknown ids and
  values outside the range are errors, so a typo from the agent is never silently ignored. There is
  no core set: every preference, `unpaved`, `quiet`, `climb` and `novel` included, is on screen only
  when the profile names it, and a profile without weights is valid (the Blank slate).
- **limits**: limit id → `true` / `false` (off, as if absent), or a number for the number limits
  (`true` there means the catalogue default).
- **bounds**: the clamp of the factor product, `min_factor` 0.3 … 1.0 (default 0.5) and `max_factor`
  2 … 100 (default 20). Every allowed way costs between the two times its length, plus additive
  terms; `min_factor` is what keeps the A* bound valid whatever the sliders do. The app exposes it as the
  **Detours** slider ([planner.md](planner.md#detours)); 1 / `min_factor` is how much longer a ride may be
  for a way you like. The range 0.3 is validation only (the A* bound is the smallest factor a compile
  actually produced, valid for any positive value); on the demo region the Gravel explorer's smallest
  factor at 0.3 is 0.40, so a lower floor would change nothing there.
- **turn_m**: what a right-angle turn at a junction costs, metres-equivalent, 0 … 500 (absent: the
  default **20**; 0: turns are free). Straight on is free, a sharp turn up to twice it, a U-turn twice
  it, leaving the through road at least half of it; a node with two edges is no junction. A fixed
  cost like barriers, added by the search per move, not compiled (two profiles that differ only in
  `turn_m` share one compiled cost); the catalogue gives its range and default (`turn_m`). How it is
  counted and how 20 was chosen: [routing.md](routing.md#turns).
- **name**, **base**: for the UI (presets have a name; a plan names the preset it came from, and the
  diff against it is computed, not stored). Routing ignores both: two profiles that differ only there
  share one compiled cost.

A **preset** is `{ id, blurb, profile }`; the shipped ones are in `engine/presets/`, user presets have
the same shape. The **catalogue** (`kompass profile catalogue`, `catalogue()`) lists every preference
and limit with its group, label, one-line hint, kind (`soft`, `limit_flag`, `limit_number` with
min/max/step/default/unit), the value it starts at when added, its strength (below), and for
the sparse ones the attribute behind it with a note; `catalogue_for(graph)` adds the share of the
loaded region where that attribute is mapped. Its groups (Surface, Ways, Traffic, …) are both the
picker's sections and the profile editor's (planner.md, "The preferences panel").

## The cost

```
cost(arc) = length × clamp(quality × (1 + (bonus − 1) × gate(quality)), min_factor, max_factor)
          + climbing + penalties
```

**Membership.** Each preference measures, per arc, how much the way is what it names: a number in
−1 … 1 (shares of the length for the landscape ones, hand-set grades for categories; negative means
the opposite, e.g. a rough track for "firm tracks"), quantised to fifteenths like the graph's shares.

**Factor.** With the weight `w` in −1 … 1 and `x = w × membership`, a preference's factor is

```
x > 0:  max_bonus ^ x      (cheaper; +100 on a full match costs max_bonus)
x < 0:  max_penalty ^ −x   (dearer;  −100 on a full match costs max_penalty)
```

so 0 or no match is 1, and the curve is the same at every point of the slider: +50 on a fully
matching way is `√max_bonus`. `max_bonus` and `max_penalty` are per preference in the catalogue:
bonuses are mild (0.6 … 0.9: +100 gravel makes a gravel way worth a 1.67× longer ride, never more),
penalties strong where the vision asks for it (main roads 5×, traffic 4×). Text for a slider: "at
+100, ways that are fully X count as `max_bonus` × their length; at −100 as `max_penalty` ×".

**Quality and gated bonuses.** Surface, way type, traffic, trail, access and ramps are *quality*:
their factors multiply into `quality`. Landscape (forest, edge, water, open, built-up), signed routes,
seeking climbs and the ride history are *gated*: their penalties count like quality, but their
bonuses count only where the way is acceptable to the rest of the profile, in full up to
`quality ≤ 1.3` and fading out linearly to nothing at `quality = 2.2`. This is the vision's caveat in
numbers: novelty and nice views are a bonus within acceptable quality, never a reason to ride
something bad (a never-ridden grass track the profile dislikes stays disliked).

**Clamp.** The product is clamped to the bounds. The smallest factor a compile actually produces
(≥ `min_factor`, 1.0 for a blank profile) is the A* bound per metre of straight line.

**What a preference touches.** A route says, per preference its profile names (an explicit 0
too), the length on which that preference applies at all: membership ≠ 0, whatever the weight
(`breakdown.touched`, catalogue order, 0 m where it touches nothing). It is `cost::touches` over the
route's arcs, the cost's own membership code (a test checks it against the breakdown on every arc
of random graphs): the grade ramps on the tamed grade, `climb` on the ascent beyond the deadband in
the arc's direction, the personal ones only with a personal layer. It is computed with the route
(one membership per arc and named preference, no extra query) and says nothing about the weight's
effect: a gated bonus outside the gate still "touches". The panel shows it per slider.

**Seeing it.** Every step of this, per arc, is what the cost debug queries return (`edgeCosts` for a
map layer, `explainEdge` for one edge, `compare` for two routes; [routing.md](routing.md#explaining-the-cost)),
computed by the same code as the compile. Before the route-quality round of #40, a 24 km demo-region
route under the Gravel explorer had 41 % of the length at exactly `min_factor`: a compacted track was
0.65 (unpaved 85) × 0.87 (track) × 0.89 (fine gravel 40) ≈ 0.50 already, and any climb or forest-edge
bonus took it below. There a slider pushed further changes nothing, and a gravel detour more than
twice as long loses against a way at factor 1; `clamp` (one edge) and `clamped_min_m` (a stretch) show
it. Now (unpaved 50, fine gravel 20) a compacted track is 0.78 × 0.87 × 0.94 ≈ 0.63 against 0.87 for
a paved farm track: gravel is worth a detour of about 1.35×, and the sliders have room both ways.

**Additive terms** (all ≥ 0): avoiding climbs costs `−w × 25` m per metre of ascent beyond the
deadband (25 m at −100, 10 m at −40); 15 m per barrier (gate, bollard); steps 5 m per metre plus 20 m
(carrying); `bicycle=dismount` 2 m per metre (walking); a ferry 1000 m (waiting). Turns at junctions
come on top per move (`turn_m`, above), in the route's cost but not in the per-arc cost.

**Never** (whatever the profile, except near a waypoint, [routing.md](routing.md)): `bicycle=no`
(the pipeline maps motor roads, `motorroad=yes`, to it; motorways are not in the graph at all) and
riding against a one-way.

### Inferred surface

Without a `surface` tag the cost guesses, and says how sure it is: *strong* guesses count like tags,
*weak* ones count 0.7 for the surface preferences, are "unknown" in the result, are excluded by
"No unknown surface" and by "Paved only".

| way | guess |
|---|---|
| track, unclassified, path, bridleway with a `tracktype` | grade 1 paved, 2 compacted, 3 gravel, 4–5 soft (strong) |
| track without one | gravel (weak) |
| residential, living street, tertiary and up, unclassified | paved (strong) |
| cycleway, pedestrian, service | paved (strong in built-up, else weak) |
| footway | paved in built-up (strong), else gravel (weak) |
| path, bridleway | paved in built-up, else soft (both weak) |

### Traffic

`quiet` penalises a traffic level 0 … 1 per way, the louder of two:

- **Its own**: class (trunk 1, primary 0.9, secondary 0.7, tertiary 0.45, unclassified 0.25,
  residential 0.12, service 0.05, track 0.02, paths 0) × speed (0.4 at 30 km/h up to 1 at 100 km/h;
  unknown limits guessed by class and built-up: 50 in towns, 100 outside on main roads, 70 on small
  roads) × lanes (×1.15 for 3, ×1.3 for 4+) × motor access (×0.1 closed to cars or agricultural only,
  ×0.4 destination/private) × separation on the road itself (×0.35 with a cycle track, ×0.75 a painted
  lane, ×0.4 a bicycle road), capped at 1.
- **Alongside**: the level of the motor roads within 20 m (`road_near_traffic`: the loudest one's
  level without separation, over the part of the way near them) × the share of the way near them
  (`road_near_share`) × **0.3**. A cycle path or a track right beside a primary road at 100 km/h is
  0.9 × 1 × 0.3 = 0.27: at `quiet` 50 it costs ×1.2, at 100 ×1.45, where it used to be neutral (paths
  have no traffic of their own). 0.3 is a little below the 0.35 of a cycle track tagged on the road:
  a separately mapped path in the band is often the same kerb-separated track, sometimes behind a
  verge, never louder; and a road's band, which holds the road itself, never raises its own level.
  A minor road or a service road beside a main road gets the main road's traffic the same way.

The model is defined once, in `engine/core/src/traffic.rs`; the pipeline computes `road_near_traffic`
with the same numbers (`pipeline/src/kompass_pipeline/traffic.json`, generated by `bun run gen:engine`,
checked by the tests of both sides). The cost debug view names the second case "traffic alongside".
On the demo region, 21 % of the cycle-path length now carries a level above 0.2 (0.9 % of all path,
track and footway length), and Gravel explorer rides 45 % less on paths beside busy roads (12 pairs of
10–25 km: 7.3 → 4.0 km, median detour 1.13 → 1.16; PR of #40).

### Elevation, tamed

The DEM is a surface model: under trees it sees the canopy (spike #3: ~13 m/km of spurious ascent in
forest vs ~3.5 in the open). So:

- **Ascent** counts only beyond a deadband of `(4 + 10 × forest share)` m per km along the arc; this
  is the ascent the cost, the time model and the result's totals use.
- **Grades** (steepest 50 m) are capped by what the arc's average climb allows (`2.5 × average + 5`
  %, against canopy spikes inside an otherwise flat edge) and lowered by 5 points in full forest.
  `steep`, the "steeper than X %" family and `max_grade` use this tamed grade.
- With noisy data a hard grade limit cuts forest networks into pieces: on the real region a 10 %
  limit left 5 of 12 random routes without a way and made one 10× longer, so no shipped preset uses
  `max_grade`; "River valley" avoids ramps and climbing softly instead. A DTM (DGM1) would change
  this.

### Grade thresholds

"From X % on it gets expensive" without the hard limit's cuts: `ramps_over_6`, `_8`, `_10`, `_12`
and `_15` ("Steeper than X %", group Terrain). Each is a ramp over the tamed grade of the arc,
membership 0 up to X and rising by a third per point to 1 at X + 3, so a threshold means what it
says but has no cliff (a noisy 10.4 % is not a wall). A descent counts at half the rate (0.5 at
X + 3, 1 at X + 6): steep descents on loose gravel are unpleasant too, but rideable, and the half
share makes a route climb the gentle side and come down the steep one rather than the reverse; a
separate "steep descents" family would double the entries for little gain. Penalty 4× at −100 on a
full match (bonus 0.85 when sought: quality, not gated, like `steep`).

- **They stack.** Several active at once multiply: 8 % at −40 and 12 % at −100 cost 1.7× from 11 % and
  1.7 × 4 = 7× from 15 %. With `steep` too it is one more factor. The clamp
  (`bounds.max_factor`, default 20) caps the product, so all five at −100 on a 25 % wall are 20×,
  not 1000×: a strong avoid, still routable.
- **`steep` stays**, now one ramp of the same family (8 → 16 %, descents half): the gentle, wide
  version. Its membership is pinned to the old formula by a test, and no preset names the new ids,
  so the presets route as before.
- **Cost.** One ramp and one table per active threshold, evaluated on the per-arc pass the grades
  already need (no per-arc table per threshold). Demo region (101 850 arcs): Gravel explorer
  1.1–1.2 ms, with `steep` 1.5–1.7 ms, with 8 % and 12 % 1.8–1.9 ms.
- **Effect** (demo region, 12 pairs of 10–25 km, `kompass compare --grade 10`): Gravel explorer
  vs the same with "Steeper than 10 %" at −100: length on arcs whose tamed steepest 50 m exceed
  10 % uphill 6.3 → 4.0 km per route (over 13 %: 4.9 → 2.1 km), ascent 755 → 640 m, median detour
  1.18 → 1.37. The rest is mostly unavoidable on the Black Forest's valley sides, and the surface
  model sets the floor: forest grades are lowered by 5 points against canopy noise, so a real 14 %
  forest ramp reads as 9 % and goes unpunished while a canopy step in the open can read as steep.

### Personal layer

`novel`, `stale` and `familiar` read the personal layer: per edge the number of rides and the day
of the last one, passed in by the caller (derived from the ride library by map-matching, re-derived
on every build since edge ids change). Without it they do nothing, and the result has no ridden
state. Membership: never ridden 1; not ridden for 180 days → 0, rising to 1 at two years; ridden 1×
0.25, 2× 0.45, 3–4× 0.7, 5+ 1.

## The structured model (prototype, behind a switch)

Epic #58, task #66: tier boards for surfaces and way types, a hills curve with a loose-ground
modifier, and Detours as the spread, built on the verdict of spike #60
([report](reports/2026-11-22-hills-and-saturation.md)): the clamp was not the main reason the sliders
felt dead, overlapping preferences and bonuses pushed onto the floor were. The user decides by trying
it next to today's sliders, so it is **opt-in per profile**: a profile with `boards`, `hills` or
`detours` uses this model, one without routes exactly as before (a test pins the compiled costs of the
presets and random slider profiles to checksums recorded before it existed). Code:
`engine/core/src/structured.rs` (the curve, the conversion, the catalogue part), the structured paths
of `cost.rs`; the twins in `engine/presets/structured/`.

```json
{ "name": "Gravel explorer",
  "weights": { "quiet": 70, "forest_edge": 50, "built": -30, "sketchy": -50, "novel": 60 },
  "limits": { "no_stairs": true, "legal_only": true },
  "boards": {
    "surface": { "paved": "fine", "rough_paved": "fine", "compacted": "love", "gravel": "love",
                 "soft": "dislike", "unknown": "like" },
    "way": { "main": "dislike", "country_road": "fine", "residential": "fine", "service": "fine",
             "track": "like", "path": "fine", "cycle_path": "fine", "cycle_path_roadside": "fine" } },
  "hills": { "up": { "3": 0.96, "6": 0.93, "10": 0.93, "15": 0.93 },
             "down": { "8": 1.0, "15": 1.0 }, "loose_pct": 0 },
  "detours": 1 }
```

```
cost(arc) = length × min(relative ^ detours, max_factor) + length × (hills(arc) − 1) + fixed costs
relative  = Π boards tier(row) × Π groups (strongest bonus × strongest penalty) / best
```

- **Boards.** Every way is in exactly one row of each board, the same kinds the route reports: the
  surface board by the surface the cost uses (`paved`, `rough_paved`, `compacted`, `gravel`, `soft`;
  weak guesses and unusual surfaces are `unknown`), the way board by the way type (`main`,
  `country_road`, `residential`, `service` (also ways of no known kind), `track`, `path` (steps
  included), `cycle_path`, `cycle_path_roadside`; a ferry is in no row and counts as `fine`). A board
  lists every row (no defaults). Tiers: **love 1.0, like 1.15, fine 1.35, dislike 2.0** (a metre's
  factor relative to love), **avoid** closes the row like a limit (`closed_by`: `avoided_surface`,
  `avoided_way`, the closure's attribute `board_row`); where this plan allows such a way it counts as
  dislike. Love against fine at 1.35 is the tuned Gravel explorer's exchange (a compacted track against
  a paved farm track).
- **The remaining sliders** (traffic, landscape, trail, signs, history, and modifiers such as
  `tracktype`, `smoothness`) combine **within their catalogue group**: its strongest bonus × its
  strongest penalty (gated bonuses: the strongest one, through the gate). Overlaps no longer stack;
  `explainEdge` says which counted (`counted` per preference, `groups`).
- **Relative, no floor.** Everything is divided by the profile's `best`: the boards at love and every
  group at its strongest bonus (the table's best value over the memberships the preference can reach).
  A way that is the best of everything costs 1 × its length; there is no `min_factor` (a structured
  profile keeps `bounds.min_factor` at its default, else it is rejected), `max_factor` still caps. A
  board without a loved row has no way at 1 (the Gravel explorer's twin: nothing on the way board is
  loved, its best way is 1.15 × the rest). The gate reads the **absolute** quality, the boards as
  `tier / fine` (fine is neutral), with today's thresholds: a disliked row lets 80 % of the gated
  bonuses through, a loved one all.
- **Detours** is the spread: an exponent on the relative factor, 0.5 … 2 (default 1). At 1 a loved way
  is worth a 1.35× longer ride than a fine one, at 2 a 1.82× longer one. The conversion maps
  `bounds.min_factor` onto it (`ln(min_factor) / ln(0.5)`: 0.5 is 1, 0.3 is 1.74).
- **The hills curve**: what a metre costs against its grade relative to a flat metre, handles at fixed
  grades: up 3, 6, 10, 15 % (0.5 … 10; below 1 seeks climbs), down 8, 15 % (1 … 10; absent: a descent
  counts like a climb of half its grade), 0 % pinned at 1; linear in grade and in log value between,
  flat beyond ±15 %. It enters as **metres**, `length × (curve − 1)`, outside the factor product, so it
  never saturates; below 1 it counts through the gate. The metres are metres of the best way (the
  scale where the best way costs 1 per metre): a fine way on both boards costs 1.82 per metre, so a
  curve value of 2.5 adds 1.5 m per metre to it. Per arc the curve reads **split + steepest 50 m**
  from the four grade numbers an arc has (spike #60: within 15 % of a 10 m grade histogram on 95 % of
  the length): 50 m at the steeper of the tamed steepest grades up and down (the whole arc when
  shorter), the rest split into a climbing and a descending part by the ascent and descent beyond the
  deadband. `loose_pct` (0 … 50): on gravel, soft and unusual surfaces (weak guesses included) grades
  read that much steeper. The wall is the side the curve values furthest from flat (the dearer one; for
  a curve that seeks climbs, the climb). `max_grade` stays a limit.
- **What a board or the curve replaces is rejected** (validation names the board): with the surface
  board `unpaved`, `paved_smooth`, `paved_rough`, `fine_gravel`, `soft_ground`, `unknown_surface` and
  the limits `paved_only`, `no_unknown_surface`; with the way board `track`, `path`, `cycleway_sep`,
  `cycleway_road`, `residential`, `service`, `minor`, `main` and `no_main_roads`; with the curve
  `climb`, `steep`, `ramps_over_*`. A limit set to `false` is as if absent. Without the curve the slider
  hills keep working (in the Terrain group, per arc).
- **The A* bound** is the smallest factor plus hills metres per metre any arc has (the other additive
  terms are ≥ 0); A* equals Dijkstra under random structured profiles (a test).
- **Fixed costs weigh less.** Barriers (15 m), steps, a ferry, the reuse penalty and U-turns are metres
  too, and a typical way now costs about 2.2 per metre where it cost 0.85: they count roughly 2.5×
  less against the factors than in the slider model. Not tuned yet (an open point of the prototype).

**Conversion** (`to_structured`, wasm `toStructured`, `kompass profile convert <file|preset>`): a
pure function from a slider profile. Every row of both boards gets the tier nearest (in log space, fine
= 1) to its factor today: the board's slider weights on a representative way of the row (a tagged
compacted track, an untagged track for `unknown`, a cycle path away from roads, …); limits become
`avoid` (`paved_only`: compacted, gravel, soft, unknown; `no_unknown_surface`: unknown; `no_main_roads`:
main). Soft weights never become `avoid` (a strength, not a limit): `main −80` is `dislike`, which is
weaker (1.48 × fine against 3.6 ×). The curve's handles are today's factor of `climb`, `steep` and
`ramps_over_*` at the handles' grades on a way of factor 1 (`climb −w` is additive, 1 + 0.25 w (g −
0.4) uphill; `steep` and the ramps their tables at that grade, descents half). The other weights and
limits stay; a structured profile comes back unchanged.

**Twins** (`structured_presets()`, wasm `structuredPresets`, `kompass profile presets --structured`):
each shipped preset converted, id `<id>_structured`, the same name. Tuned after replay: River valley's
climbing handles × 1.6 (2.22 / 2.94 / 4.27 / 6.62; the curve charges only the steepest 50 m where
`steep` charged the whole arc, so the converted curve climbed 14 % more). A test checks that every
twin is the conversion plus exactly these tunings.

**What a structured profile adds to the results.** `breakdown.rows`: per row of the boards present, the
route's length in it (0 m included: what each row touches); `breakdown.grades`: the route's length per
1 % grade band from −20 to +20 % as the curve reads it (the distribution behind the curve); per
segment `tiers` (its row and tier per board) and `hills_m`; per `compare` side `rows` and `hills_m`;
in `explainEdge` per direction `structured`: the boards' rows, tiers and factors (`factor` against
love, `vs_fine`), per group what counts, `best`, `relative`, `detours`, and `hills` (its metres, the
mean value, the wall's, the climbing and the descending part's grade and length, loose, the gate).
The additive term is `hills`. The `why` lists name only what counts.

**The catalogue** has `structured`: the boards with their rows (id, label, hint, which ways fall in
it) and what each replaces, the tiers with their factors, the curve's handles with ranges, the named
curves (Flat please, Don't mind, Climber, No walls) and the loose and detours ranges.

**Evidence** (the PR of #66; real region, aggregates only). Replay on the rider's 24 legs (as the
route-quality report): the Gravel explorer's twin reproduces as much as today (36 / 35 % against
36 / 34 % of the ridden length, all / median leg) at 1.67 turns per km against 1.72; with the
history minus the replayed rides 24 / 22 % against 25 / 23 %. Paved & quiet's reproduces more
(38 / 32 % against 37 / 26 %) and is shorter (1.00 against 1.10 of the ridden length) but rides 41 km
of main road against 24 (`dislike` is weaker than `main −60`; `avoid` or more detours reproduced less).
River valley's (tuned) 41 / 41 % against 42 / 42 %. Length at the floor on 30 seeded pairs with the
history: 16.5 % today (Gravel explorer), 0 % structured. One control nudged (sliders ±25, a tier one
step, a handle × or ÷ 1.25, detours ±0.25) changes on average 9.6 % of the twin's route (9.7 % today),
a tier step 12.9 %, a handle 2.1 %, Detours 17 %; bonuses and penalties move it alike (8.7 / 10.4 %;
today 7.4 / 11.9 %). Compile 91–166 ms natively (today 26–77 ms; the curve per arc is most of it),
settled nodes 0–9 % fewer.

## The catalogue

Membership per id (the code in `cost.rs` is the source; `max_bonus` / `max_penalty` from the
catalogue).

| id | matches (membership) | bonus / penalty |
|---|---|---|
| `unpaved` | compacted, gravel 1; soft 0.8; other 0.5 (× 0.7 if guessed weakly) | 0.6 / 2.5 |
| `paved_smooth` | paved 1 (0.3 if smoothness bad) | 0.75 / 2.0 |
| `paved_rough` | sett, cobbles, plates 1; paved with bad smoothness 0.6 | 0.85 / 2.5 |
| `fine_gravel` | compacted 1; gravel on a grade 1–2 track 0.6 | 0.75 / 2.0 |
| `soft_ground` | soft 1, other 0.3; grade 5 track 1, grade 4 0.7 | 0.85 / 3.0 |
| `unknown_surface` | no tag, weak guess 1; strong guess 0.3 | 0.85 / 2.0 |
| `tracktype` | grade 1–2 +1, 3 +0.2, 4 −0.6, 5 −1 | 0.75 / 1.8 |
| `smoothness` | excellent +1 … intermediate +0.2, bad −0.5 … horrible −1 | 0.8 / 1.8 |
| `track` | `highway=track` | 0.7 / 2.5 |
| `path` | path, footway, bridleway (not cycle paths) 1; pedestrian 0.5 | 0.75 / 2.5 |
| `cycleway_sep` | a cycle path of its own, 1 at ≤ 20 % near a motor road, 0 at ≥ 80 % | 0.6 / 2.0 |
| `cycleway_road` | the opposite share for cycle paths; a road with a cycle track 1 | 0.8 / 2.0 |
| `residential`, `service` | the class (residential includes living streets) | 0.8, 0.85 / 2.0 |
| `minor` | tertiary, unclassified 1; `road` 0.5 | 0.8 / 2.5 |
| `main` | trunk, primary, secondary and their links | 0.85 / 5.0 |
| `quiet` | minus the traffic level, the way's own or the roads' alongside (seeking quiet penalises traffic) | 0.85 / 4.0 |
| `speed` | motor roads, 0 at 50 km/h, 1 at 80 | 0.85 / 3.0 |
| `lanes` | 4+ lanes 1, 3 lanes (or a trunk of unknown lanes) 0.6 | 0.9 / 3.0 |
| `near_road` | share within 20 m of a motor road | 0.85 / 2.0 |
| `forest`, `forest_edge`, `water`, `built` | the share | 0.75–0.85 / 1.6–2.0 |
| `open` | 1 − forest − built-up | 0.85 / 1.5 |
| `climb` | seek: average grade after the deadband, full at 5 %; avoid: additive, above | 0.7 / 25 m per m |
| `steep` | tamed grade up, 0 at 8 %, 1 at 16 %; downhill half | 0.85 / 3.0 |
| `ramps_over_6` … `_15` | tamed grade up, 0 at X %, 1 at X + 3 %; downhill half (above) | 0.85 / 4.0 |
| `bike_routes` | lcn 0.7, rcn 0.85, ncn/icn 1 | 0.8 / 1.5 |
| `mtb_routes` | member of an MTB route | 0.8 / 1.5 |
| `access` | foot only, private, use-the-sidepath 1; agricultural 0.7; dismount 0.6; destination 0.3 | 0.9 / 3.0 |
| `sketchy` | the most of: MTB/hiking difficulty, faint trail, grade 5 (1) / 4 (0.5) track, informal 0.8 | 0.85 / 3.0 |
| `mtb` | S1 0.35, S2 0.7, S3+ 1 (or the hiking scale) | 0.85 / 3.0 |
| `visibility` | intermediate 0.35, bad 0.65, horrible 0.85, no 1 | 0.85 / 2.5 |
| `novel`, `stale`, `familiar` | the personal layer, above | 0.7–0.8 / 1.4–1.5 |

Limits (excluded both ways):

| id | excludes |
|---|---|
| `no_main_roads` | trunk, primary, secondary (+ links), unless they carry a separate cycle track |
| `paved_only` | everything not paved or paved-rough, and weak guesses |
| `no_unknown_surface` | ways without a surface tag and no strong guess |
| `max_grade` (4–30 %) | arcs whose tamed grade exceeds it, up or down |
| `max_mtb_scale` (S0–S5) | ways harder than it (MTB scale, else the hiking scale shifted by one) |
| `no_stairs` | steps, demanding mountain hiking and harder, S4+ |
| `legal_only` | foot only (the German default on footways), private, agricultural only, use-the-sidepath; `destination` and `dismount` stay (legal; dismount costs walking) |
| `no_ferries` | ferries |

## Presets

Tuned against the rider's own rides and BRouter's gravel profile (`kompass replay`,
[the route-quality report](reports/2026-11-21-route-quality.md)): the Gravel explorer's surface bonuses
are milder than they were (unpaved 85 → 50, fine gravel 40 → 20) so a car-free paved farm track is not
traded for any gravel detour, and `quiet` is stronger (50 → 70) against paths beside busy roads.

| preset | weights | limits |
|---|---|---|
| Gravel explorer | unpaved 50, track 40, fine gravel 20, quiet 70, forest edge 50, novel 60, climb 20, main −80, soft ground −40, sketchy −50, built-up −30 | no stairs, legal only |
| Paved & quiet | unpaved −70, quiet 60, cycle paths away from roads 60, main −60, cobbles −50, climb −30 | paved only, no stairs, legal only |
| River valley | water 90, climb −60, ramps −70, quiet 40, novel −10 | no stairs |

Every preset rides with the default turn cost (none sets `turn_m`; neither do saved plans, which so
pick up the default too). A shipped preset names only what it has an opinion on (no explicit 0, checked by a test): the zeros
the presets used to carry (`novel` 0, `unpaved` 0) were there for the former core set and routed the
same.
| Blank slate | none | none: the shortest way (with the default turn cost) |

`quiet` and "cycle paths away from roads" (`cycleway_sep`) do not count the same thing twice: the
first is how loud it is (a path beside a quiet street is quiet), the second the kind of way (a path
of its own through the land, whatever road is near). On a path beside a busy road `quiet` penalises
and `cycleway_sep` withholds its bonus; on one away from roads `quiet` is 1 and the bonus counts.

How they ride on the real region (12 random pairs of 30–60 km, no coordinates kept; the PR of #18 has
the tables): Gravel explorer about 55 % unpaved (shortest way: 26 %; 62 % before #40), 0.1 km of main
road per route (shortest: 11 km), detour 1.19 median / 1.31 max; Paved & quiet 0 % unpaved and 4.6 km of main road
at a 1.31 median detour (paved only on its own: 20 km of main road at 1.12, so most of the detour is
spent leaving main roads); River valley a quarter less climbing and three times the water share of
the shortest way at a 1.10 median detour.
