# Kompass: vision

> **Bootstrap document.** This captures the initial brainstorm so the project can start. It is
> a rough outline, not a spec. As the project grows, the lasting parts move into `docs/` and
> this file shrinks or goes away.

Kompass is a route planner and ride companion for **cycling first** (gravel in particular),
with running, hiking and walks as a later afterthought. It starts as a personal tool, single
user, and may be shared later.

The motivation: Komoot is great for planning, tracking and navigation, but it offers very
little control over *how* a route between waypoints is chosen. You pick a preset (gravel,
road, ...) and maybe "quieter", and that's it. OpenStreetMap holds far more information than
that, and a rider's own history holds even more. Kompass wants routes built around personal
preferences, and it wants to support riding without a fixed plan.

There are three directions, all on top of one routing engine.

## 1. Planning with fine-grained preferences

Sitting down before a ride and planning it on the map, but with real control over how each
leg is routed.

- **Preferences from map data.** Examples: prefer gravel and small tracks, avoid roads, but
  sometimes prefer *paved* bike paths that run away from the main road. Ride along forest
  edges. Prefer routes along a river. Surface, road class, traffic proxies, landscape context
  and terrain are all derivable from OSM and elevation data.
- **Hard constraints vs. soft preferences.** "Paved only" excludes edges; "prefer quiet" only
  weighs them.
- **Per-leg profiles.** Gravel to the lake, then the paved bike path home. Komoot can't do this.
- **Personal history.** After years of riding the same area, finding something new is hard.
  Options: explore segments never ridden; prefer segments not ridden for a long time; ride
  familiar segments in the reverse direction.
  - Caveat: unridden segments are often unridden for a reason. Novelty is a bonus *within* an
    acceptable quality, never a reason to ride something bad.
- **Explored map.** Show where I have and haven't been. Useful from day one.
- **Steering.** Waypoints are first class. Via-zones ("somewhere through here") and
  avoid-zones too. They also keep the search space small.
- **Sketch routing.** Roughly draw a loop with a finger; the engine fits a route to that shape
  using my preferences.
- **Loops** are the common case: "a 40 km loop to the north-west".
- **Learn my profile from my history.** Compare what I actually rode with what the router would
  have picked, and fit the weights.
- **Explainability.** A cost breakdown per segment, and a debug map coloured by any attribute.
  Needed to tune weights and for the agent to explain its choices.
- **Personal corrections.** "This was sketchy" or "this is actually fine", recorded after a
  ride, feeds back into routing.

## 2. Ride mode: decisions at the junction

Some of the best rides aren't planned at all: you start riding and decide at every junction,
based on vibes. It feels like exploring, and it finds segments that planned routes never pick.
The cost: at every junction you stop, look at the map and trace where each option leads. Is it
a dead end? Does the path turn into an overgrown trail? That gets tedious, and it's the reason
I avoid this style when riding with others.

Ride mode is a decision aid for that style:

- When approaching a junction, each outgoing branch gets a few glanceable indicators about
  what it **opens up** over the next few km, not just the first segment: dead end or connects
  back to the network, breaks a hard constraint (greyed out), surface mix, climb, km on roads,
  sketchy (with a confidence level: "surface unknown" isn't "bad"), and how much of it is new to me.
- **The leash.** A loose goal such as "home by 17:30" or "about 60 km". Each branch shows
  whether it keeps me inside it, and as it gets tight ride mode turns into normal navigation
  home. Free exploring, with a limit.
- **Dice mode.** Suggests the next turn with weighted randomness, tilted towards the unknown.
- **Glanceable**, so it works on group rides: the preview appears before the junction, there
  are only a few icons, and there's an optional audio cue.
- **Live trail and a full map.** Ride mode always offers a plain full map view with the line
  of where I've been on this ride, for orientation and for when I don't want to trust the
  recommendations. "Ridden today" also feeds into the lookahead.
- **Not a tracker.** Recording rides stays with Komoot or the Garmin Edge. Rides come into
  Kompass afterwards through an import.

## 3. Semantic / agentic route planning

An LLM agent on top of the engine, with the engine's queries as its tools.

- **Planning in natural language.** "Today I want a 40 km loop going north-west, mainly quiet
  gravel roads, not through forests."
- **Replanning on the go.** "Find a supermarket in the next 15 km and get me back onto the
  route." "Can we take a shortcut, but still avoid main roads?" This matters especially on
  bikepacking trips, where a whole day often has to be replanned.
- **Trade-offs, not just answers.** The agent generates candidates, analyses them and comes
  back with the trade-off: "The shortcut saves 11 km but has 6 km on the B-road; this
  alternative is only +4 km and quiet."
- **The LLM never routes itself.** It edits an explicit preference profile, picks waypoints,
  calls engine queries and explains the results. Sliders and natural language are two editors
  of the same profile, so I can always see what "quiet, no forests" turned into.

## Principles

- **Personal first.** Single user. Personal data (tracks, history, profiles) stays on my
  devices. The repo is public, so no personal data or home location goes into it.
- **One engine, several faces.** Planner, ride mode and agent are views on the same engine and
  the same profile.
- **Narrow scope.** Not a Komoot clone: no social features, collections or recording. The
  focus is a planner, a ride decision aid, and GPX export to the bike computer.
- **Web first.** A responsive PWA that works on desktop and phone (mainly iOS, with Android
  for prototyping). A Garmin Edge companion through Connect IQ may come later.

## Order (rough)

1. Foundation: the region graph with its attributes, history import with the explored map,
   and basic routing.
2. Planner: waypoints, preference profiles, per-leg profiles, analysis, GPX export.
3. Loops and novelty, including sketch routing.
4. Ride mode with junction preview.
5. Agent: planning first, then voice replanning while riding.
6. Garmin companion, and bikepacking across larger regions.
