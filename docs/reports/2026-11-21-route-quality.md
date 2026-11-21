# Route quality against the rider's own rides (2026-11-21)

Part of #40 (epic #36). Are the Gravel explorer's routes at least as good as BRouter's gravel profile on
the rider's typical rides, measured against the lines the rider actually rode? And what does tuning the
preset on that show? Everything ran on this machine: Kompass natively, BRouter 1.7.10 locally (its
shipped `gravel.brf` and `trekking.brf`, the public 5° segment tiles, a server on localhost only). No
ride, leg or route left the machine; this report has aggregates only.

## Method

- **Rides.** From the history, the rides tagged as gravel rides, 25–80 km, inside the region, distinct
  (a coarse grid signature, newest kept), one per compass direction from home plus two one-way rides:
  10 rides, 35–66 km, about 480 km.
- **Legs.** `kompass replay` (new, [routing.md](../routing.md#route-quality-against-the-riders-rides))
  map-matches each ride and cuts it into legs of about 14 km, node to node. Legs with a chain break in
  the match (2) or whose end points are closer than 0.55 × the ridden length (8: a loop within the leg,
  which no A→B router reproduces) are skipped: **24 legs, 348 km ridden**, straightness 0.55–0.89.
  The brief asked for legs of 10–40 km; at 20 km, loops cut in halves have a straightness near 0.5 and
  every router took a line a quarter shorter than the rider's, so overlap measured the rider's
  meandering more than the routing. A cut at 10 km (32 legs) was the robustness check.
- **Lines.** Per leg: the ridden line (matched), Kompass's routes (Gravel explorer before and after,
  Paved & quiet), BRouter gravel and trekking (their GPX map-matched onto the same graph). All are arc
  lists measured alike. The personal layer is off (`novel` does nothing): novelty would push routes off
  the ridden lines by design.
- **Measures.** *Reproduced*: share of the ridden length the line also rides (edges; a road and its
  sidepath count as different, so this is a strict lower bound). *On ridden*: share of the line that
  was ridden. Then length, ascent, unpaved, main roads, roadside cycle paths, km beside busy roads, the
  length at the clamp and closures under the old Gravel explorer, turns (≥ 45° at a junction) per km and
  zigzags (a turn back the other way within 300 m).
- **Reasons.** Every stretch of ≥ 300 m where Gravel explorer leaves the ridden line (the `compare`
  stretches, 54 before, 51 after) with both sides' factors and way types, grouped automatically and
  checked by hand; `route --why-not` on single cases; the stretches with closures by access tag.

## Result

| line | km / ridden | reproduced (all / median leg) | on ridden | ascent m / 100 km | unpaved | paved tracks | main road km | roadside cycle path km | beside busy road km | at clamp | turns / km | zigzags |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ridden | 1.00 | 100 % | 100 % | 1276 | 17 % | 26 % | 20.8 | 54.6 | 48.4 | 6 % | 1.53 | 215 |
| **Kompass Gravel explorer before** | 0.98 | **26 % / 27 %** | 27 % | 1843 | 57 % | 13 % | 1.3 | 26.0 | 22.9 | 26 % | 1.92 | 253 |
| **Kompass Gravel explorer after** | 0.96 | **36 % / 34 %** | 38 % | 1700 | 47 % | 19 % | 1.3 | 26.2 | 20.8 | 21 % | 1.72 | 202 |
| Kompass Paved & quiet (unchanged) | 1.10 | 37 % / 26 % | 34 % | 1115 | 0 % | 18 % | 23.6 | 100.4 | 82.0 | 0 % | 1.56 | 244 |
| **BRouter gravel** | 1.02 | **41 % / 34 %** | 41 % | 1395 | 28 % | 36 % | 4.1 | 46.7 | 40.1 | 12 % | 1.33 | 145 |
| BRouter trekking | 0.98 | 43 % / 43 % | 44 % | 1018 | 7 % | 19 % | 40.9 | 83.0 | 68.6 | 2 % | 1.15 | 141 |

(Sums over the 24 legs; "at clamp" is under the old Gravel explorer for every line. With 10 km legs:
Gravel explorer 23 % → 32 % reproduced, same picture.)

Way mix (share of length):

| line | main | country | residential | service | track | path | cycle path away | roadside cycle path |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ridden | 6 % | 8 % | 14 % | 2 % | 41 % | 4 % | 9 % | 16 % |
| Gravel explorer before | 0 % | 5 % | 8 % | 2 % | 64 % | 7 % | 5 % | 8 % |
| Gravel explorer after | 0 % | 4 % | 10 % | 3 % | 61 % | 6 % | 8 % | 8 % |
| BRouter gravel | 1 % | 3 % | 13 % | 1 % | 63 % | 2 % | 3 % | 14 % |

**Verdict.** Before: no. The Gravel explorer reproduced a quarter of what the rider rode, BRouter's gravel
profile four tenths. After: close on the median leg (34 % both), 5 points behind on the total; BRouter
trekking is still a little closer to the rider than either (43 %). This is a soft bar met only in part:
the rider's "gravel" rides are mostly paved (17 % unpaved), so any profile that seeks gravel parts from
them, and BRouter gravel gets its overlap mostly by riding the same paved farm tracks. A good share of
the remaining gap is the rider's own choices that no profile should copy (main roads, roadside paths),
and the rest is of the order a router reaches at all: two well-tuned BRouter profiles agree with the
rider on 41–43 %.

## Where Kompass left the ridden line, and why

Grouped from the divergent stretches (hand-checked groups of the automatic ones; a stretch counts in
one group, by the way types and factors of both sides):

| reason | before: stretches / ridden km | after |
|---|---:|---:|
| **Paved farm track vs. gravel track.** The rider takes a car-free asphalt track (`highway=track`, grade 1); Kompass a parallel gravel track. Under the old weights a compacted track was 0.50 (the clamp) against 0.87 for the paved one: gravel was worth a 1.7× detour. | 13 / 52 | 10 / 28 |
| **The rider takes a roadside cycle path, a main road or a country road**, Kompass a track (`quiet`, `main`, the unpaved bonus). By the profile's own values Kompass's line is the better one; the rider rode them for directness. Not a tuning target. | 9 / 45 | 11 / 45 |
| **A closure on the ridden line** (≥ 100 m or a tenth of the stretch): `legal_only` 9, against a one-way 2, `bicycle=no` 4. In length it is little: `legal_only` closes 5.5 km of the 348 km ridden, in 46 pieces: `use_sidepath` 3.2 km / 18 (the rider on the road beside a mandatory cycle path, which Kompass offers instead), `foot_only` 1.3 km / 26 (short footway links, ~50 m each), `agri_forestry` 0.7 km / 2; `bicycle=no` 1.6 km, one-way 0.4 km. | 15 / 126 | 15 / 110 |
| **Villages**: the rider through on residential streets, Kompass around (`built` −30) or on other streets. | 8 / 15 | 8 / 17 |
| **The rider's line as good per metre but longer** (a chosen detour). | 6 / 6 | 5 / 11 |
| Other small way choices (path vs. cycle path). | 3 / 4 | 2 / 3 |
| **Climbs**: not a reason. Dropping `climb` +20 changed nothing (reproduced 26 → 24 %, ascent −2 %). | | |
| total | 54 | 51 |

The roadside-path case of #36 (the rider takes a quieter line further from the road, Kompass the cycle
path beside it) appeared in one leg: the old preset rode 5.8 km of roadside cycle path there, 4.9 km of it
beside a busy road, on a line 0.81× the rider's; the rider's line was about 1.4× longer through the
stretch, mostly on cycle paths away from roads and tracks, with 0.24 km closed by `legal_only`. What it
takes to flip it (overlap with the ridden line on that leg):

| profile | roadside km | beside busy road km | reproduced |
|---|---:|---:|---:|
| old preset | 5.8 | 4.9 | 33 % |
| old preset, `min_factor` 0.3 | 5.8 | 4.9 | 33 % |
| old preset, `quiet` 100 | 1.6 | 0.6 | 49 % |
| old preset, `quiet` 100, `near_road` −100, `min_factor` 0.3 | 1.3 | 0.7 | 67 % |
| old preset, `legal_only` off, `quiet` 100 | 1.1 | 0.8 | 63 % |
| **tuned preset** (`quiet` 70) | **1.6** | **0.6** | **49 %** |

So since #49 `quiet` is what moves it; the Detours slider (`min_factor`) does nothing here, because the
roadside line is not cheap by bonuses but by length. The rest of the rider's line there needs
`near_road` or `legal_only` off, and then only by small margins.

**`legal_only` and the German practice.** On these rides the limit closes little: agricultural/forestry
access 0.7 km in 2 places in 348 km; the rest is the mandatory sidepath (where Kompass rides the path)
and short footway links. Turning the limit off did not bring the routes closer to the rider (26 → 25 %)
but made them worse to ride: turns 1.92 → 2.12 per km, zigzags 253 → 311, from footway shortcuts. The
default stays; a softer limit (short `foot_only` links at a walking cost, agricultural access as a
penalty) is worth a look when another rider's region shows more of it.

## What was tuned, and why

`engine/presets/gravel-explorer.json`, three weights (nothing else; the cost tables are unchanged):

- **`unpaved` 85 → 50 and `fine_gravel` 40 → 20.** Three bonuses (`unpaved`, `fine_gravel`, `track`)
  rewarded the same compacted track and put it at the clamp (26 % of the route length): gravel was worth
  a 1.7× detour over a car-free paved track, and the sliders had no room below. Now a compacted track is
  0.78 × 0.87 × 0.94 ≈ 0.63 against 0.87: gravel is worth a detour of about 1.35× (a test pins 1.25×
  yes, 1.45× no). A small grid over `unpaved` (85/70/55/40) × `track` (40/70) × `min_factor` (0.5/0.6)
  showed the surface weight as the one lever; `track` and `min_factor` moved overlap by 0–4 points.
- **`quiet` 50 → 70.** The roadside case above, and fewer km beside busy roads overall (29.0 → 20.8 km
  with the milder surface bonuses, which on their own let the route onto more paved roadside paths).

Before → after, against the rides: reproduced 26 → 36 % (median leg 27 → 34 %), unpaved 57 → 47 %
(still well above BRouter's 28 %), paved tracks 13 → 19 %, ascent 1843 → 1700 m per 100 km, at the clamp
26 → 21 %, turns 1.92 → 1.72 per km, zigzags 253 → 202, beside busy roads 22.9 → 20.8 km, main roads
unchanged (1.3 km).

On the region's seeded random pairs (`kompass compare`, 12 pairs of 30–60 km, same seed):

| profile | detour p50 / p90 / max | unpaved | main road km mean / max | tracks | ascent |
|---|---:|---:|---:|---:|---:|
| Gravel explorer before | 1.21 / 1.31 / 1.31 | 62 % | 0.1 / 0.2 | 71 % | 883 m |
| Gravel explorer after | 1.19 / 1.21 / 1.31 | 55 % | 0.1 / 0.2 | 68 % | 816 m |
| Paved & quiet (unchanged, same numbers before and after) | 1.31 / 1.50 / 1.54 | 0 % | 4.7 / 16.3 | 15 % | 630 m |

## Turns: is a turn penalty needed?

Not now. Before the tuning the Gravel explorer turned more than the rider (1.92 against 1.53 per km)
and zigzagged more (253 against 215); after it zigzags less than the rider (202) and turns 12 % more.
The zigzag came from the stacked surface bonuses (chasing short gravel pieces between paved ones), and
it does not come back with cheap detours: at `min_factor` 0.3 and 0.4 the tuned preset routes exactly
the same lines here. BRouter turns least (1.33 per km, 145 zigzags) because its gravel profile charges
65 m per 90° turn (trekking 90 m, scaled by the angle's cosine). If a later round wants that: a turn
cost of that kind (metres × (1 − cos angle) at junctions, none on roundabouts), needing a turn-aware
search (arc-based labels instead of node labels) — a bigger change than its gain on this data.

## What is left

- Overlap of 36 % is a strict measure: a road against its own sidepath, and the matcher's choice
  between parallel ways, count as misses. A buffer-based overlap would read higher for every line.
- The rider rides 6 % on main roads and 16 % on roadside cycle paths; Kompass avoids both by design.
  If the user wants "the routes I ride", that is a different preset (closer to BRouter trekking).
- Ascent: Kompass still climbs a third more than the rider (gravel lives on the hillsides here, and the
  DEM sees the canopy, #12). BRouter's gravel profile ignores elevation by default.
- `legal_only`: a softer variant for short footway links, if other regions show more closures.
- The comparison is one rider's 24 legs; `kompass replay` re-runs it on any history in a few seconds.
