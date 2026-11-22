# Hills and saturation (2026-11-22)

Spike #60 of epic #58, for the structured controls of #66 (tier boards for surfaces and road types, a
hills curve with a loose-ground modifier). Two questions:

1. **The hills curve.** What does an arc carry about grade, how noisy is it, and can a cost-against-grade
   curve (−20…+20 %) be evaluated honestly from it, or does an arc need more (a grade histogram)?
2. **Saturation.** How much of the routes sits at the `min_factor` clamp, how far one slider moves a
   route, and which change to the cost model keeps the sliders meaningful without hurting route quality?
   One scalar cost per arc stays.

Everything ran on this machine, read-only on the region builds, the DEM tiles and the rides; private
output stayed in a temporary directory. This report has aggregates only. The spike code (never merged) is
on the branch `spike/60-hills-saturation`: the cost model variants behind environment switches in
`engine/core/src/cost.rs`, the measurements in `kompass spike60` (`engine/cli/src/spike60.rs`), the
grade analysis in `spike/60/grades.py`.

## Method

- **Regions.** The demo region (50 925 edges, 6 664 km of ways, 58 % of the length in forest) and the
  real region (2 340 341 edges, 225 959 km, 28 % in forest), as built (format 4).
- **Grades.** The DEM (Copernicus GLO-30, a surface model) re-sampled along every edge exactly as the
  pipeline does (10 m steps, 50 m moving average; the re-derived ascent and steepest 50 m match
  `edges.parquet` to 0.05 m and 0.05 points at p99), plus what the pipeline does not keep: a histogram
  per edge of the 10 m step grades (metres per 1 % bin, signed along the geometry). A sample hills curve
  (1 up to 3 %, 1.3 at 6, 2 at 10, 4 at 15 %, descents at half the grade) evaluated per arc from the
  histogram is the reference for "honest"; the same curve evaluated from what the graph carries today is
  compared with it.
- **Routes.** 30 seeded random pairs at 15–35 km straight line (routes of 35–40 km on average), the
  three shipped presets, with and without a **personal layer** (the rider's explored map, all imported
  rides: 2 593 km, about 1 % of the network's length, so `novel` matches 99 % of it). The cost model is
  switched per run (`KOMPASS_SPIKE_MODEL`, `KOMPASS_SPIKE_MIN`, `KOMPASS_SPIKE_HILLS`).
- **Slider sensitivity.** For every active preference of a preset (not the personal ones), the weight
  set to −100, w − 25, w + 25 and +100 in turn: the share of the route's length that changes against the
  preset's own route (edges, either direction), averaged over the pairs, and the length at the floor with
  that slider at +100.
- **Replay.** `kompass replay` on the rider's 10 rides as in [the route-quality
  report](2026-11-21-route-quality.md) (24 legs, 348 km ridden), the Gravel explorer as the judge, per
  model: without a personal layer (as that report), and with the history *minus the 10 replayed rides*
  (the condition of the playtest: `novel` on, the ride itself unknown).

## 1. The grade data

### What an arc carries

Per edge the graph has the node elevations (decimetres), the ascent along and against the geometry
(decimetres, from the 50 m-smoothed profile), the steepest 50 m along and against (whole percent) and
the forest share. The cost derives two things from them: the **effective ascent** (beyond a deadband
of 4 + 10 × forest share m/km) and the **tamed steepest grade** (capped at 2.5 × the arc's average
climb + 5 and lowered by 5 points in full forest). `climb` reads the first, `steep`, `ramps_over_*`
and `max_grade` the second. Ascent and descent per arc, plus one steepest window per direction, is the
whole description.

### Arc lengths and the grade within an arc

| arc length | edges (real) | length (real) | grade spread within, sd p50 / p90 (real) | length (demo) | spread (demo) |
|---|---:|---:|---:|---:|---:|
| < 50 m | 56 % | 12 % | 0.0 / 0.0 pts | 8 % | 0.0 / 0.0 |
| 50–100 m | 18 % | 13 % | 0.7 / 2.5 | 10 % | 1.4 / 4.7 |
| 100–200 m | 13 % | 19 % | 1.4 / 4.8 | 17 % | 3.2 / 9.0 |
| 200–500 m | 10 % | 31 % | 2.5 / 7.2 | 36 % | 5.7 / 11.4 |
| 0.5–1 km | 3 % | 18 % | 3.6 / 8.3 | 21 % | 7.1 / 11.6 |
| 1–2 km | 0.4 % | 6 % | 4.7 / 8.6 | 7 % | 7.1 / 10.2 |
| > 2 km | 0.1 % | 1 % | 5.9 / 8.8 | 1 % | 7.4 / 11.0 |

(The spread is the standard deviation of the 50 m window grades within an arc, length-weighted. Median
edge 40 m, but half the length is on edges over 241 m on the real region and over 306 m on the demo.)
On the routes, the arcs over 300 m carry about half the length (Gravel explorer 53 %, Paved & quiet
42 %, River valley 48 %).

**Average and steepest disagree often.** On the real network the raw steepest 50 m is more than 3 points
above the arc's average climb on 33 % of the arc length, more than 5 points on 23 % (tamed: 23 % and
12 %); on the demo 56 % and 47 % (tamed 40 % and 28 %). On the presets' routes the tamed steepest is more
than 5 points above the average climb on 14 % (Gravel explorer), 9 % (Paved & quiet) and 6 % (River
valley) of the length (demo: 28 %, 16 %, 11 %). An arc flagged by its steepest 50 m is mostly not that
steep:

| X | arc length with steepest 50 m ≥ X (real) | of it, metres actually ≥ X | network metres ≥ X | demo: flagged / of it ≥ X |
|---|---:|---:|---:|---:|
| 6 % | 33.5 % | 40 % | 15.0 % | 57.5 % / 48 % |
| 8 % | 26.0 % | 34 % | 10.2 % | 51.6 % / 44 % |
| 10 % | 20.4 % | 30 % | 7.1 % | 45.9 % / 39 % |
| 12 % | 16.0 % | 26 % | 5.0 % | 40.5 % / 35 % |
| 15 % | 11.0 % | 21 % | 3.0 % | 32.5 % / 30 % |

So today's ramps, which charge the whole arc at its steepest 50 m, overcharge most arcs they touch.

### Noise: the surface model under trees

Paved roads are engineered: they rarely exceed 12 %, and their profile is smooth. The same road classes in
the open and in forest, arcs of 100 m and more:

| ways (real region) | where | km | spurious up-and-down, m/km | metres steeper than ±12 % |
|---|---|---:|---:|---:|
| main and tertiary roads, paved | open (< 10 % forest) | 12 214 | 3.8 | 1.9 % |
| | forest (> 90 %) | 630 | 11.1 | **12.4 %** |
| minor roads, paved | open | 9 408 | 3.2 | 2.7 % |
| | forest | 237 | 11.2 | **17.6 %** |
| tracks | open | 54 156 | 3.2 | 4.7 % |
| | forest | 39 952 | 12.4 | 20.7 % |

(Spurious up-and-down: (ascent + descent − |net|) / 2 per km. Demo: main roads 6.9 % in the open against
25.7 % in forest above ±12 %; tracks 26 % against 35 %.) Under trees a paved road reads steeper than 12 %
on six times as much of its length as in the open; 40 % of the forest histogram mass lies more than
5 points from the arc's own net grade (8 % in the open; demo 51 % against 20 %). In forest, the fine
structure of the profile is mostly canopy.

### A curve from what an arc carries

The sample curve evaluated per arc in several ways, against the histogram:

| evaluated from | mean abs. log error (real) | arc length off by > 15 % | off by > 50 % | demo: off > 15 % |
|---|---:|---:|---:|---:|
| the net average grade | 0.095 | 24 % | 4.1 % | 52 % |
| the steepest 50 m, whole arc (raw) | 0.217 | 39 % | 21 % | 70 % |
| the steepest 50 m, whole arc (tamed; today's ramps) | 0.134 | 29 % | 10 % | 56 % |
| ascent and descent: the arc split into a climbing and a descending part | 0.057 | 12 % | 0.1 % | 26 % |
| **split + steepest 50 m**: 50 m at the steeper wall, the rest split by ascent and descent | **0.039** | **4.6 %** | **0.0 %** | **11 %** |
| the same, open land only | 0.026 | 2.8 % | 0.0 % | 6.7 % |
| the same, forest only | 0.069 | 8.8 % | 0.1 % | 13 % |

(The curve's mean factor over the network: 1.26 from the histogram, 1.46 from today's tamed steepest.)
**Split + steepest 50 m** uses only the four numbers the graph already has per edge (ascent and descent,
steepest up and down). It matches the histogram within 15 % on 95 % of the arc length (97 % in the open).
The rest sits in forest, where the histogram itself is mostly canopy.

### A histogram per arc: what it would cost

Nine signed bins (below −12, −12…−8, −8…−5, −5…−2, ±2, 2…5, 5…8, 8…12, above 12 %) as shares in
fifteenths, 8 nibbles stored: 9.4 MB raw (+7 % on the real region's 131 MB of graph files) and 3.9 MB
gzip (+6 % on 68 MB; 1.65 bytes per edge), 9 MB more in memory. The pipeline already samples every
10 m in its elevation stage, so the bins add a bincount there. This spike's unoptimised script did the
whole region (DEM warp, sampling, histograms) in 43 s. The graph compiler would carry one more
column. Evaluating a curve over nine bins per arc would cost about three times the lookups of split +
steepest. It would buy little: about 5 % of the length moves by more than 15 %, mostly in forest, where
the bins are canopy.

### Today's profiles on a curve

Curves fitted to the presets' `climb` / `steep` weights replace them (`KOMPASS_SPIKE_HILLS`), and the routes
are compared with today's on the 30 pairs:

| preset | its terrain weights | as a curve | route length changed: mean / median | pairs moved > 5 % |
|---|---|---|---:|---:|
| Gravel explorer | `climb` +20 | 1 at 0, 0.93 from 5 % up (gated, as today) | 1.2 % / 0.0 % | 3 / 30 |
| Paved & quiet | `climb` −30 | 1 + 0.075 × (grade − 0.4) uphill: 1.27 at 4 %, 1.72 at 10 % | 0.5 % / 0.0 % | 1 / 30 |
| River valley | `climb` −60, `steep` −70 | 1.54 at 4 %, 2.14 at 8, 2.95 at 10, 4.0 at 12, 7.2 at 16; 1.21 at −12, 1.47 at −16 | 15.4 % / 11.3 % | 23 / 30 |

The additive climb maps exactly: c(g) = 1 + 0.25 × |w| × (g − deadband). River valley moves because
today's `steep` charges the whole arc at its steepest 50 m and the curve charges only those 50 m: the
overcharge shown above. The loose-ground modifier on River valley's curve moves 6.5 % of the route
length at 15 % steeper and 8.9 % at 30 %. Compiling the curve per arc (a table at 0.1 % steps) costs
about as much as today's per-arc climb and steep pass: 40–75 ms on the real region, natively, single
thread, on the shared VM.

### Verdict 1

**Yes, the data supports a hills curve, and an arc needs nothing new.** Evaluate the curve per arc as
*split + steepest 50 m* from the ascent, descent and tamed steepest grades already in the graph. A
histogram would add 6 % to the download and mostly describe canopy. Better grades come from a bare-ground
model (DGM1, FABDEM) through the pipeline's `ElevationFn`, not from more bins of the surface model.

**Recommendation for the curve:**

- **Shape.** Signed grade −20…+20 %, the value is the cost of a metre relative to flat ("a metre at 10 %
  counts as 2.5 m"). Handles at fixed grades: −15, −8, 0 (pinned at 1), +3, +6, +10, +15. Linear in grade
  and in log value between them, flat beyond the ends (the DEM's grades beyond 20 % are mostly canopy).
- **Descents** have their own handles, defaulting to today's convention (a descent counts like a climb
  of half the grade). They stay at 1 or above: a descent bonus only offsets the climbs and weakens the
  search bound.
- **How it enters:** an additive term, `length × (curve(arc) − 1)` metres, outside the factor product,
  so it never saturates and reads in metres ("these 400 m at 10 % cost 600 m more"). Values below 1
  (seeking climbs, uphill only) count through the gate like today's climb bonus; the A* bound includes the
  curve's minimum.
- **Loose ground:** on gravel, soft and other loose surfaces (weak guesses included), grades count
  `N %` steeper both ways before the curve is read.
- **The deadband and taming stay** (forest), applied before the split.
- **Mapping today's ids:** `climb −w` gives uphill values 1 + 0.25 w (g − 0.4); `climb +w` gives 0.7^w
  from 5 % up (gated); `steep −w` multiplies from 8 % up by 3^(w (g − 8) / 8), descents at half the slope;
  `ramps_over_X −w` is a step of 4^w from X to X + 3. A pure function converts old profiles on load.
  `max_grade` stays a limit (the curve's "avoid", with #65's trade-off).

## 2. Saturation

### How much sits at the floor

Length at `min_factor` (0.5) under each preset's own model:

| | Gravel explorer | Paved & quiet | River valley |
|---|---:|---:|---:|
| seeded pairs, no personal layer | **0.0 %** | 0.0 % | 0.0 % |
| seeded pairs, with the personal layer | **16.5 %** | 0.0 % | 0.0 % |
| ride legs (replay), no personal layer | 0 % | 0 % | 0 % |
| ride legs, history minus the replayed rides | 11 % | | |
| one slider at +100, no personal layer: `unpaved` / `fine_gravel` / `track` / `climb` | 41 / 22 / 20 / 12 % | | |
| the same with the personal layer | 51 / 37 / 45 / 28 % | | |

Since #40's tuning (milder surface bonuses) the presets do not reach the floor on their own. Two things
put the Gravel explorer there:

- **`novel`.** At 60 it is a 0.81 gated bonus on 99 % of the network: a near-constant factor that
  steers almost nothing but takes a fifth of the room down to the floor.
- **Pushing a bonus to its extreme.** This is exactly what the playtest did. Once `unpaved` is at +100,
  half of the route sits at the floor, and from there no slider can make those ways any cheaper.

### How far one slider moves a route

Today, with the personal layer, share of the route length that changes:

| Gravel explorer | weight | at −100 | w − 25 | w + 25 | at +100 |
|---|---:|---:|---:|---:|---:|
| `unpaved` | 50 | 77 % | 21 % | 13 % | 19 % |
| `fine_gravel` | 20 | 49 % | 16 % | 3 % | 9 % |
| `track` | 40 | 90 % | 18 % | 11 % | 21 % |
| `quiet` | 70 | 40 % | 17 % | 10 % | 13 % |
| `forest_edge` | 50 | 35 % | 12 % | 3 % | 8 % |
| `climb` | 20 | 62 % | 15 % | 2 % | 7 % |
| `soft_ground` | −40 | 31 % | 21 % | 22 % | 39 % |
| `sketchy` | −50 | 19 % | 15 % | 16 % | 26 % |
| `built` | −30 | 37 % | 17 % | 14 % | 30 % |
| `main` | −80 | 4 % | 4 % | 12 % | 26 % |

Per preset, a ±25 nudge changes on average 13 % of the route (Gravel explorer; 43 % of the nudges move
more than 5 %), 4 % (Paved & quiet; 15 %) and 10 % (River valley; 35 %). Three patterns:

- **Bonuses are one-sided.** Strengthening a bonus moves the route about half as much as weakening it
  (mean over the three presets' bonuses 6.9 % against 14.3 %), while penalties are symmetric (8.1 %
  against 9.8 %). Part of this is the
  floor. Part of it is the network: once a route is on the preferred ways, more of the same buys only
  longer detours. With no floor at all the asymmetry is still 7.2 % against 15.4 %.
- **Overlapping preferences stack.** `unpaved`, `fine_gravel` and `track` reward the same compacted
  track: three sliders for one choice, and their product is what reaches the floor.
- **Dead sliders behind limits.** In Paved & quiet, `unpaved` −70 changes 0 % at every weight
  (`paved_only` already excludes unpaved ways), `paved_rough` 0–6 %, `cycleway_sep` 1–2 % per nudge.

### The candidates

| model | GE at floor (personal) | ±25 nudge, mean | bonuses: stronger / weaker | GE `unpaved` at +100 | settled per route | replay: reproduced (all / median leg), no personal | with history | km / ridden | unpaved | turns / km |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| today | 16.5 % | 9.8 % | 6.9 / 14.3 % | 19 % | 42.6 k | 36 / 34 % | 25 / 23 % | 0.96 | 47 % | 1.72 |
| a. groups (one factor per group: its strongest bonus × strongest penalty) | 6.8 % | 9.4 % | 8.2 / 11.4 % | | | 37 / 31 % | 25 / 20 % | 0.96 | 47 % | 1.75 |
| b. soft floor (full to half the floor in log space, then tanh) | 30 % ¹ | 8.0 % | 6.2 / 10.8 % | | | 36 / 34 % | 26 / 23 % | 0.95 | 48 % | 1.71 |
| a + b | 16.5 % ¹ | 8.3 % | 7.5 / 10.2 % | | | 38 / 31 % | 26 / 20 % | 0.95 | 46 % | 1.72 |
| b. normalised (product^γ: the graph's smallest lands on the floor) | 0.1 % | 8.8 % | 7.8 / 11.1 % | 22 % | 45.6 k | 36 / 34 % | 26 / 22 % | 0.96 | 47 % | 1.72 |
| c. no floor (`min_factor` 0.1; 0.3 routes the same) | 0 % | 10.1 % | 7.2 / 15.4 % | 29 % | 50.5 k | 36 / 34 % | 25 / 23 % | 0.96 | 47 % | 1.72 |
| **c. groups, no floor** | **0 %** | 9.8 % | **9.1 / 11.8 %** | **30 %** | 48.5 k | 37 / 31 % | 25 / 20 % | 0.96 | 47 % | 1.75 |

(¹ Saturated, not clamped: the factor follows less than half of a change in the product. Seeded pairs
with the personal layer for the first five columns; replay for the rest, where main roads stay at
1.2–1.3 km and zigzags at 200–215 without and about 250 with the history for every model. Paved & quiet
and River valley never reach the floor, so every model routes them exactly as today; their rows are
not shown. A groups preset re-tuned to make up for the lost stacking (`unpaved` 65, no `fine_gravel`)
reproduced less: 35 / 31 % and 21 / 16 %, at 56 % unpaved with the history.)

- **Route quality does not decide it.** Every model reproduces the ridden lines within 1–2 points of
  today, at the same detour, surfaces, main roads and turns. On these 24 legs the floor shapes very few
  routes even where it binds: 11 % of the length at the floor, and removing it routes the same lines.
- **The soft floor makes it worse.** It rounds the corner but keeps the pile-up near the floor (30 %
  saturated) and dampens every slider (8.0 %).
- **Normalising is unexplainable.** One slider at +100 rescales every other one through γ, and nudges
  get weaker (8.8 %).
- **Removing the floor** makes the extremes bite: `unpaved` at +100 moves 29 % of the route instead of
  19 %. It costs 18 % more settled nodes (a looser A* bound) and leaves the overlaps and the asymmetry.
- **Groups without a floor** is the only model that is both floor-free and close to symmetric (9.1 against
  11.8 %, with `fine_gravel` now redundant under `unpaved`). It also caps the stacking at one factor per
  group instead of one per preference. Settled nodes are 14 % higher.

### Verdict 2

The clamp is real but not the main reason sliders felt dead. On today's presets the floor binds only
through `novel` (16.5 % of the Gravel explorer's length) and through sliders pushed to the extremes (up
to half the route). What remains are:

- the network's own diminishing returns for bonuses;
- overlapping preferences that are three sliders for one choice;
- sliders made dead by limits.

Both the tier boards and the touches/dimming of #62 address these, and no clamp variant does. **Pick
"tiers relative to each other": one factor per group, no floor.** It ties on route quality, is the only
candidate without a floor and without one-sided bonuses, and every number in it is an exchange rate
against the best tier.

**Recommendation for the cost model behind the boards and the curve:**

```
cost(arc) = length × Π_boards tier(board, way) × Π_groups (strongest bonus × strongest penalty)
          + length × (hills(arc) − 1) + fixed costs (barriers, steps, dismount, ferry)
```

- **Boards.** The surface board has a row per surface class (paved, rough paved, compacted, gravel, soft,
  unknown). The road-type board has a row per way kind (main, country road, residential, service, track,
  path, cycle path away from roads, roadside cycle path). Each way is in exactly one row of each board.
  Each row is in a tier with a relative factor: **love 1.0, like 1.15, fine 1.35, dislike 2.0, avoid = the
  limit**. Love against fine at 1.35 is the tuned Gravel explorer's exchange (a compacted track 0.63
  against a paved farm track 0.87). The inspector says "to stay on ways you love, a route may be up to
  1.35× longer".
- **The remaining sliders** (traffic, trail, landscape, signed routes, history, and modifiers like
  `tracktype`, `smoothness`, `unknown_surface`) stay. Within a catalogue group they combine as the
  strongest bonus × the strongest penalty, so overlaps no longer stack.
- **Relative, not clamped.** Every table is divided by its best value, so the best a way can be is 1.
  This is a per-profile constant and routes exactly like the floor-free model. `novel` 60 then reads
  "ridden ways cost 1.24×" instead of eating the floor. The gate stays on the absolute quality (today's
  thresholds). The A* bound is the smallest compiled cost per metre.
- **Detours** (today `bounds.min_factor`) becomes the spread of the tiers, an exponent k on every
  relative factor (0.5…2, default 1): "Detours: more" turns love-against-fine from 1.35× into 1.82×.
  `max_factor` (20) stays the cap and the cost of closed arcs near a waypoint.
- **Avoid** is the limit: the way is closed in the strict route. `paved_only` becomes the surface board
  with every unpaved row on avoid, `no_main_roads` the main row on avoid. In #65's softened route an
  avoided way costs `max_factor` per metre, which is the price the trade-off marker quotes ("140 m
  unpaved here would save 3.8 km").
- **The profile JSON** stays the source of truth, with new keys: `tiers` (`{ "surface": { "compacted":
  "love", … }, "ways": { "track": "love", … } }`), `hills` (`{ "curve": [[-15, 1.4], [-8, 1], [3, 1.1],
  [6, 1.3], [10, 2], [15, 4]], "loose": 20 }`) and `detours`. A pure, tested conversion on load maps the
  old ids:
  - board weights (`unpaved`, `paved_smooth`, `paved_rough`, `fine_gravel`, `soft_ground`, `track`,
    `path`, `cycleway_sep`, `cycleway_road`, `residential`, `service`, `minor`, `main`): each row's
    factor today, snapped to the nearest tier;
  - terrain weights (`climb`, `steep`, `ramps_over_*`): through the mapping above;
  - `bounds.min_factor`: to `detours`.

  The presets are re-expressed in the new form and re-checked with replay (bar: within 2 points of
  today's reproduced share). Saved plans are converted on load, keep their `base` preset id, and are
  written in the new form at the next save. Old ids stay readable, so an agent's or an old plan's
  profile still routes.

## What was not verified

- **No ground truth for grades.** The histogram is the same surface model, finer. A bare-ground DEM or
  the rides' barometric elevation would measure the real error of the curve. Neither was compared.
- **Tiers are approximated.** "Groups" is the strongest bonus × the strongest penalty over today's
  preference ids, not boards with disjoint rows. The proposed ladder (1 / 1.15 / 1.35 / 2), the Detours
  exponent and the conversion of old weights were not built or replayed. The relative model was measured
  as "groups, no floor": the same routes by construction, not implemented as such.
- **Small samples.** One seed of 30 pairs at 15–35 km, the ±25 nudge and the extremes only, one rider's
  24 legs. The personal layer of the seeded runs holds every ride, and today's date drives `stale` and
  `familiar`.
- **Only the Gravel explorer was judged.** The other presets never reach the floor, so the candidates
  route them as today.
- **Timings come from a shared, loaded VM.** The curve's compile cost was measured on the per-edge path;
  its edge-class implementation and its cost in the browser were not.
- **The route-shape work (#63, #64) was not involved.** The reuse penalty and turn cost are fixed
  additive costs and are independent of this model.
- **Question 2 was not run on the demo region.**
