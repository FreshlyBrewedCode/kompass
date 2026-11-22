# Steering: a profile you can build, a route you can question

The design behind epic #58, from the brainstorm after the playtest of the cost debug view, the
sliders and the routes (epic #36). It records what was agreed and why, before anything is built;
the built shape moves into [profile.md](../profile.md), [routing.md](../routing.md) and
[planner.md](../planner.md) as each part lands, and this note is then only the record.

## What the playtest said

- **Building a profile that captures a route is hard.** Many preferences are welcome, but with many
  sliders active it is hard to grasp what is going on, or to feel what any one of them does. Moving a
  slider rarely changed the route, so the sliders got pushed to their extremes to see anything.
- **The cost view is used a lot and is awkward.** Switch to the layer, tap a segment, switch back to
  planning: tedious on the phone and at the desk, and even then it is hard to see why a segment is
  used or not.
- **The routes have shape problems.** Waypoints laid out as a loop ride back over a stretch that is
  cheap (each leg is its own search, so a second pass is free). Short detours leave a road for a
  little gravel and rejoin it at once (turning is free). A hard limit such as "paved only" causes a
  long detour around a tiny unpaved link.

Every decision below is checked against three things: routes the rider would actually ride, a profile
the rider can build and understand, and an engine that can say why it picked a route in the words a
rider thinks in (kilometres of detour, not factors).

## 1. The segment inspector

Right-click at the desk, long press on the phone, on any way, while planning. It is the hub of
steering; the cost layer stays for looking over an area.

- **On a segment of the route: "why is this used".** Three groups: what raises the cost here, what
  lowers it, and what could apply here but is neutral (a preference that is active but does not
  match, or one not in the profile that would match this way). Tapping a line opens that slider in
  place, and the route follows.
- **On a way the route avoids: "why not this".** The extra cost of going through it and the
  preference or limit to blame (the engine's `explainEdge`, `compare`, the CLI's `--why-not`).
- **Actions per plan, not per profile:** "avoid this segment", "prefer this way". A plan carries a
  small set of edge overrides on top of the profile; the profile stays what the rider wants in
  general.

## 2. The preferences panel

- The active preferences in the same categories as "add a preference", **collapsed by default**, each
  category with a one-line summary.
- **The empty preset is really empty.** There is no core set any more: gravel, unpaved, low traffic,
  climbing and never ridden are ordinary optional preferences.
- **What a slider touches.** Each slider shows how much of the current route it applies to
  ("8.2 km"); one that changes nothing on this route is dimmed.

## 3. Structured controls instead of many sliders

Widgets are views on groups of preferences; the profile JSON stays the source of truth.

- **Tier boards** for surfaces and for road types: avoid / dislike / fine / like / love. The ranking
  is visible at a glance, and "avoid" is the toggle that a limit is today.
- **A hills curve:** grade from −20 to +20 % against cost, a few handles, presets. It replaces the
  "steeper than X %" family, `steep` and `climb`. One **loose ground modifier** goes with it: "on
  loose ground, grades count N % steeper".
- **Prototype first.** A design round with mock-ups, then a build behind a switch, then a playtest:
  the rider decides by trying whether these replace the sliders. The engine side is built (#66):
  [profile.md](../profile.md#the-structured-model-prototype-behind-a-switch). Before the curve is designed, a
  spike checks what the per-edge grade data supports (#60).

## 4. Saturation

The product of a way's factors is clamped at `bounds.min_factor` (0.5 by default), so stacked bonuses
reach the floor quickly: 41 % of a demo route sat on it before the last tuning. On the floor, pushing
a slider further changes nothing, which is the likely cause of "the sliders have no effect".

- Tiers that are **relative to each other** would fix it by construction: the top tier gets the full
  range, the rest spread below it, and nothing stacks past the floor.
- Options are compared on the rider's own rides with `kompass replay` before one is chosen (#60).
- **One scalar cost stays.** The search's speed and exactness depend on it.
- Costs are **shown as exchange rates** ("worth an 800 m detour") in the inspector and on the
  sliders.

## 5. Live impact while dragging

A ghost of the route as it was when the drag began, the new route redrawn live, and the visible ways
tinted green or red by how their cost changed since the drag began.

## 6. Route shape

Both are fixed costs in metres, like barriers today, and both are checked with `replay` (which counts
turns per kilometre).

- **"Don't ride the same way twice", on by default.** Legs are routed in order; edges an earlier leg
  used are penalised in either direction, and a U-turn at a via costs extra. The penalties are finite,
  so a deliberate out-and-back still works. This is also the base for loops later: a loop is legs
  whose reuse is penalised.
- **A turn cost** against the short leave-and-rejoin detours.

## 7. Hard limits as trade-offs

With a limit active the engine routes twice: strict, and softened (the limit as a high finite
penalty). Where the softened route breaks the limit only on short bits and saves real distance, a
marker on the route says so: "140 m unpaved here would save 3.8 km. Allow?" Allowing is per plan, by
the same edge overrides as "avoid this segment".

## Order

1. Steering basics, mostly web: the inspector, the categorised panel, the empty default, dimming
   (#61, #62).
2. Route shape: the reuse penalty and the turn cost, replay-checked (#63, #64).
3. Per-plan overrides and the limit trade-offs (#59, #65).
4. Structured widgets and the saturation fix: spike, design round, prototype, playtest (#60, #66).
5. Live impact while dragging (#67).

## Not now

Loops (next, on the reuse penalty), novelty, phone hardening, sketch routing, ride mode, the agent.
The map style is its own round ([map-round-3.md](map-round-3.md)).
