# Steering widgets: tier boards and a hills curve

Design rounds for subtask #66 of epic #58 ([steering.md](steering.md), section 3). The model the
controls sit on is the verdict of spike #60
([hills and saturation](../reports/2026-11-22-hills-and-saturation.md)): tiers relative to each other
(love 1, like 1.15, fine 1.35, dislike 2 times the length, avoid the limit) and a hills curve at
fixed handles (−15, −8, 0 pinned, +3, +6, +10, +15 %) as an additive cost.

**Status: round 1 drawn, nothing chosen yet.** The rider picks on the phone; a prototype behind a
switch follows.

## Round 1: four directions (mock-ups)

Static mock-ups with the app's tokens, at 390×844: the panel with the widgets collapsed, the
road-type board open (the harder board: eight rows, the longest names, one way on avoid), the hills
curve open. The surface board is the same control with six rows. Sources and the render script:
[steering-widgets/round-1/](steering-widgets/round-1/) (`nix develop -c bun
docs/design/steering-widgets/round-1/render.mjs [outDir]`; PNGs are not committed). The content is
made up: a gravel rider's settings and a 41.6 km route.

Common to all four:

- The widgets are the bodies of their groups (Surface, Way type, Terrain) in the grouped panel of
  #61, and collapse to the group's one line; the other groups stay sliders.
- Tiers run avoid → love from left to right, as the sliders do. Tiers are chrome, so they are ink;
  the only colours are data (the way's colour, the route's vermilion for "this route's km").
- Every row says how much of the route it is. Rates are in a rider's words ("1 km counts as
  1.35 km", "a metre at 10 % counts as 2.5 m"), with one sentence for the exchange ("to stay on ways
  you love, the route may be up to 1.35× longer than on ways that are fine").
- Avoid is hatched, carries the lock (a hard limit, everywhere) and the word "never".
- Hills: four presets, the loose-ground stepper ("8 % on gravel is read as 9.6 %"), and the hills
  of this route as one number ("+7.8 km on top of its 41.6 km"), which the additive term makes
  honest.

### A · Lanes

A tier list: one lane per tier, love on top, the ways as chips; drag a chip to another lane, or tap
it and pick from five buttons. The hills curve is a chart on a true grade axis with seven handles
to drag and the route's grade histogram behind it; a selected handle also has steppers.

- For: the ranking reads fastest of all four (grouping is the ranking); "never" is a lane of its
  own; the chart is the real curve, and the histogram sits exactly where the handles are.
- Against: dragging between lanes inside a scrolling sheet fights the scroll, so the real phone
  interaction is tap, then pick: two taps and a floating picker. Lanes change height as chips move,
  and the layout jumps. It is the tallest board with the least per row. On the chart the handles at
  0, +3 and +6 % are 24 px apart at this width: under any thumb. The steppers rescue it, but then
  the chart is mostly a read-out.

### B · Matrix

Ways × tiers in a grid, rows in a fixed order (by the size of the road): one tap on a cell moves a
way. The avoid column stands apart as a hatched band. The hills curve is an equalizer: one vertical
slider per handle, evenly spaced, so each handle is its own 47 px column; the dashed line through
the thumbs is the curve, and each column carries the route's kilometres in that grade band.

- For: one tap per change, every option visible, nothing moves when a value changes (rows never
  reorder), so a second look finds everything where it was. The dots form a pattern that reads as a
  ranking after the first use. 44 px cells. The equalizer solves the handle spacing by giving up
  the proportional axis, and keeps both: handles you can hit and the route's distribution.
- Against: the ranking has to be read like a chart (dot positions), slower than A's lanes or C's
  order at first sight. The names get the narrow column: two cycle paths need a second line. The
  vertical sliders need the same care as the app's sliders (move from the knob only, hold-to-clear),
  with the directions swapped: a vertical drag must not scroll the sheet. The band axis is not to
  scale; the labels have to carry that.

### C · Ladder

One ordered list from love down to the "never" line; tier headings between the rows carry the
rates; a row moves a tier up or down by its arrows (or its grip). Hills: four preset cards with
their curve as a thumbnail, two ordinary sliders ("climbing costs", "steep begins at"), and the
curve with the histogram only as a read-out.

- For: reads top to bottom like a sentence, and collapses to one ("tracks › paths › streets ›
  roads · never main roads") without a glyph. "Below this line: never" is the clearest avoid of the
  four. The hills are the easiest to use: two sliders the rider already knows.
- Against: moving a way from fine to love is two taps, and the row jumps away from under the thumb.
  The order inside a tier looks meaningful and is not. It is the longest board. The two dials
  cannot express what the agreed handles can (a descent that costs, a climb that is welcome up to
  6 %): the curve becomes the engine's, not the rider's, and the profile would need a mapping from
  two numbers to seven.

### D · Route first

The board is the route's own make-up, biggest share first, each way with its kilometres as a bar
and its tier as pips; tap one or several rows, then pick the tier in a bar docked at the bottom of
the sheet, under the thumb. The hills use the same rows: one per handle, with words ("steep", "a
wall"), the route's kilometres there and what they count as, and a stepper.

- For: the best thumb reach (the five buttons sit at the bottom, rows are whole-width targets),
  several ways at once, and the strongest answer to "what does this touch": the list starts with
  what the route is made of. The hills rows put the exchange on every line ("1.8 km → 4.5 km").
- Against: the ranking is the weakest: sorted by kilometres, the tiers are scattered and must be
  read row by row from the pips. The order changes with every reroute. A way that is not on the
  route sinks to the bottom, exactly where "avoid" lives. Hills as seven steppers lose the shape:
  no curve to see, many small taps.

## Recommendation

**B · Matrix, with two things borrowed.**

The playtest's complaint was that the profile was hard to grasp and the sliders were pushed to
extremes to feel anything. B answers both on the phone better than the others: the whole board is
visible and stable, a change is one tap with no drag and no row jumping away, and five steps leave
no extreme to push to. Its equalizer is the only curve in this round whose handles can all be hit
with a thumb while the route's grades stay in view; A's chart is the truer picture but not usable
at 390 px, C's dials are not the agreed curve, D's steppers are not a curve at all.

What B lacks is the instant ranking, so borrow:

- from **C**, the collapsed line as an ordered sentence ("tracks › paths › streets › roads · never
  main roads") instead of the dot glyph, which is too small to read;
- from **D**, the route's share by tier as one bar above the board ("23.5 km loved · 8.0 km
  disliked"): the cheapest answer to "is this route what I asked for".

Open for the prototype, whichever is chosen: whether rows may sort by tier (ranking) or must stay
put (stability; B assumes they stay), what the vertical sliders do to sheet scrolling and
hold-to-clear, and whether "never" on the last uphill handle should be the `max_grade` limit.

On the desk (1440×900) the same parts sit in the profile card with pointer-sized rows; board and
curve fit open together.
