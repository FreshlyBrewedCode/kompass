# Vendored map assets

Self-hosted so the app contacts no third-party server for its map at run time. Both come from
[protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets) (the assets the
`@protomaps/basemaps` styles refer to).

- `fonts/`: the PBF glyphs of Noto Sans Regular, Medium and Italic (the three stacks the Protomaps
  styles use), only the ranges 0–255, 256–511 and 8192–8447 (Latin and general punctuation).
  Noto Sans is licensed under the SIL Open Font License 1.1: see `fonts/OFL.txt`. Other scripts need
  more ranges from the same repository (`fonts/<stack>/<from>-<to>.pbf`).
- `sprites/v4/`: the `light` and `dark` spritesheets (1× and 2×, PNG + JSON) of the Protomaps basemap
  styles, derived from [tangrams/icons](https://github.com/tangrams/icons) (MIT licence).

About 940 KB in total.
