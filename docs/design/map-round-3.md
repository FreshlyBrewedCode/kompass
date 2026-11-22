# Map style round 3: one line per track, a ground to sit on

Design round for epic #36, after round 2 ([map-round-2.md](map-round-2.md), "Bands") was built and
playtested on the phone. The verdict: Komoot's map still reads better, and it is the reason to keep
going back to it. This note records why, what was tried and what was chosen. The built style is in
[map.md](../map.md#the-outdoor-style).

## Why the other map read better

Three pairs of phone screenshots of the same places (a village with fields and a small forest at
about z14–15, open farmland at z15–16, a town edge with a dense forest path network at z15) were
compared side by side (private: they show the rider's home region). Ranked by how much each cost
"Bands" its readability:

1. **Bands as light as the ground.** The readable map works in three tones: a mid-light ground, the
   band as the lightest thing on the map, a mid-tone rim. Our land was near-white, our band cream:
   about the same lightness, so only the thin dark rims showed and a track read as two ink lines, not
   a road. This is also why the bands looked thin on the phone although they were barely narrower.
2. **The loudest marks were the ways a gravel rider wants least.** The darkest, highest-contrast
   strokes were the dashes and dots of soft tracks and paths (their light halo made them louder still).
3. **One track changed shape five times.** White band, cream band, ochre band, dashes, dots along one
   farm track: the eye could not follow it. The other map draws every track as the same band; being
   unpaved is a small modifier (a dashed rim) that keeps the shape.
4. **Dashed paths turned into noise where they are dense**; thin solid dark lines stay a legible
   network, and the few tracks stand out from it.
5. **Low contrast between forest and field**, and a faint relief: forest edges, a key orientation
   cue, vanished. The contour lines were louder than the relief.
6. **The rim was the wrong weight**: a fine dark ink line instead of a softer, slightly wider tone.
   Their bands were only about 20 % wider: contrast mattered more than width.

What the rider looks for first: the white field and forest tracks, and paved or not (the dashed rim).
Whether the grade on the map is worth having was an open question; hence the options below.

## Variants

All on the demo region at 390×844, device pixel ratio 3, z14, z15 and z15.5, plus a dense forest
network; and privately on the three compared places.

- **Common to all**: a straw ground (open land and fields apart in *hue* from the green forest, not
  only lighter), a warm relief shadow (a green one turned every shaded field into forest), relief 0.3,
  fainter contours; every track one cased band, wider from z13 (×1.2) with a wider, softer rim;
  unpaved: a dashed rim from z15, a plain lighter rim below (at z14 the dashes were only texture, every
  track a white zipper); paths thin solid dark lines without a halo.
- **A · Simple**: every track white; the rim alone tells paved from unpaved.
- **B · Graded**: the fill keeps the grade: white paved, cream compacted, ochre gravel, a pale tan for
  soft (grades 4 and 5 together) and a pale grey for not mapped.
- **C · Simple + quiet soft**: white bands, the tan only for soft and unknown tracks.

What the renders showed: A is closest to the readable map; B keeps a hierarchy at z14 (the gravel
tracks stand out in ochre, the rest is quiet); C (and the first B) hid soft field tracks: a tan
*darker* than the straw ground sank into the field.

## Decision (2026-11-21)

**B · Graded is the default**, on the straw ground, with the fix that every band fill but the ochre is
*lighter* than the open land (soft is a pale tan now). C is dropped. The rest is a choice in the map
settings, to play with: Tracks (graded, simple), Lines (normal, bold), Ground (straw, meadow, pale),
Relief (soft, normal, strong), Contour lines (on, off). A small tracks legend sits on top of the Map
tab, the full key folded below it.

The principles, for the next round:

- The ground is mid-light, the bands the lightest thing on it, the rims a mid tone: never a light band
  on a light ground.
- Forest and field differ in hue, and the relief shadow is neutral, so shading never turns a field
  into forest.
- One way, one line: what changes along a track is a modifier (fill tint, rim), never the shape.
- The ways a gravel rider wants least are never the loudest marks; paths stay thin and quiet.
- Dashes only where they read (z15 and closer); below, a plain lighter rim.

## Playtest (2026-11-22)

On the phone the map is held around z14 (13.8 in practice). There the new style hid two things the
other map keeps without looking busier: the dashed rims (they started at z15) and small streams
(drawn from z14 only, as a 0.5 px hairline, though the tiles carry them from z13). Now the rim is
dashed from z13, with a finer dash below z15, and our own waterway lines draw streams from z13 (about
1 px at z14), canals with the rivers, and ditches and drains from z15. At z14 the dashes read as a
broken edge, not as a zipper, because the dash is short and lies on the band's own fill.
