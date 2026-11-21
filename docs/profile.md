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
  "weights": { "unpaved": 85, "quiet": 50, "climb": 20, "forest_edge": 0 },
  "limits": { "legal_only": true, "max_grade": 14, "paved_only": false },
  "bounds": { "min_factor": 0.5, "max_factor": 20 } }
```

- **weights**: preference id → −100 … +100: −100 avoid, +100 seek. An absent id has no opinion; an
  explicit 0 routes the same but stays on screen (the UI's "added, not set yet"). Unknown ids and
  values outside the range are errors, so a typo from the agent is never silently ignored.
- **limits**: limit id → `true` / `false` (off, as if absent), or a number for the number limits
  (`true` there means the catalogue default).
- **bounds**: the clamp of the factor product, `min_factor` 0.3 … 1.0 (default 0.5) and `max_factor`
  2 … 100 (default 20). Every allowed way costs between the two times its length, plus additive
  terms; `min_factor` is what keeps the A* bound valid whatever the sliders do. The app exposes it as the
  **Detours** slider ([planner.md](planner.md#detours)); 1 / `min_factor` is how much longer a ride may be
  for a way you like. The range 0.3 is validation only (the A* bound is the smallest factor a compile
  actually produced, valid for any positive value); on the demo region the Gravel explorer's smallest
  factor at 0.3 is 0.40, so a lower floor would change nothing there.
- **name**, **base**: for the UI (presets have a name; a plan names the preset it came from, and the
  diff against it is computed, not stored). Routing ignores both: two profiles that differ only there
  share one compiled cost.

A **preset** is `{ id, blurb, profile }`; the shipped ones are in `engine/presets/`, user presets have
the same shape. The **catalogue** (`kompass profile catalogue`, `catalogue()`) lists every preference
and limit with its group, label, one-line hint, kind (`soft`, `limit_flag`, `limit_number` with
min/max/step/default/unit), the value it starts at when added, whether it is in the **core set**
(`unpaved`, `quiet`, `climb`, `novel`: on screen in every profile), its strength (below), and for
the sparse ones the attribute behind it with a note; `catalogue_for(graph)` adds the share of the
loaded region where that attribute is mapped.

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

**Seeing it.** Every step of this, per arc, is what the cost debug queries return (`edgeCosts` for a
map layer, `explainEdge` for one edge, `compare` for two routes; [routing.md](routing.md#explaining-the-cost)),
computed by the same code as the compile. On a 24 km demo-region route the Gravel explorer has 41 %
of the length at exactly `min_factor`: a compacted track is 0.65 (unpaved) × 0.87 (track) × 0.89
(fine gravel) ≈ 0.50 already, and any climb or forest-edge bonus takes it below. There a slider
pushed further changes nothing, and a gravel detour more than twice as long loses against a way at
factor 1; `clamp` (one edge) and `clamped_min_m` (a stretch) show it.

**Additive terms** (all ≥ 0): avoiding climbs costs `−w × 25` m per metre of ascent beyond the
deadband (25 m at −100, 10 m at −40); 15 m per barrier (gate, bollard); steps 5 m per metre plus 20 m
(carrying); `bicycle=dismount` 2 m per metre (walking); a ferry 1000 m (waiting).

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
  `steep` and `max_grade` use this tamed grade.
- With noisy data a hard grade limit cuts forest networks into pieces: on the real region a 10 %
  limit left 5 of 12 random routes without a way and made one 10× longer, so no shipped preset uses
  `max_grade`; "River valley" avoids ramps and climbing softly instead. A DTM (DGM1) would change
  this.

### Personal layer

`novel`, `stale` and `familiar` read the personal layer: per edge the number of rides and the day
of the last one, passed in by the caller (derived from the ride library by map-matching, re-derived
on every build since edge ids change). Without it they do nothing, and the result has no ridden
state. Membership: never ridden 1; not ridden for 180 days → 0, rising to 1 at two years; ridden 1×
0.25, 2× 0.45, 3–4× 0.7, 5+ 1.

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

| preset | weights | limits |
|---|---|---|
| Gravel explorer | unpaved 85, track 40, fine gravel 40, quiet 50, forest edge 50, novel 60, climb 20, main −80, soft ground −40, sketchy −50, built-up −30 | no stairs, legal only |
| Paved & quiet | unpaved −70, quiet 60, cycle paths away from roads 60, main −60, cobbles −50, climb −30, novel 0 | paved only, no stairs, legal only |

`quiet` and "cycle paths away from roads" (`cycleway_sep`) do not count the same thing twice: the
first is how loud it is (a path beside a quiet street is quiet), the second the kind of way (a path
of its own through the land, whatever road is near). On a path beside a busy road `quiet` penalises
and `cycleway_sep` withholds its bonus; on one away from roads `quiet` is 1 and the bonus counts.
| River valley | water 90, climb −60, ramps −70, quiet 40, novel −10, unpaved 0 | no stairs |
| Blank slate | the core set at 0 | none: the shortest way |

How they ride on the real region (12 random pairs of 30–60 km, no coordinates kept; the PR of #18 has
the tables): Gravel explorer about 61 % unpaved (shortest way: 26 %), 0.1 km of main road per route
(shortest: 11 km), detour 1.19 median / 1.32 max; Paved & quiet 0 % unpaved and 4.6 km of main road
at a 1.31 median detour (paved only on its own: 20 km of main road at 1.12, so most of the detour is
spent leaving main roads); River valley a quarter less climbing and three times the water share of
the shortest way at a 1.10 median detour.
