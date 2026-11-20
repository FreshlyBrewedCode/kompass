// Map style round 2 (issue #37): what the four variants share. PROTOTYPE for the design round, not the
// shipped style: `?mapstyle=a|b|c|d` switches a variant in, without it the app draws `ways.ts` as before.
//
// A variant is a `Spec`: which ways are cased bands, which are single lines, and their colours, widths
// and dashes. `specLayers` turns it into MapLibre layers the same way for all four, so the variants
// differ in design decisions only.
import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";
import type { OverlayAttribute } from "../manifest";
import { enumCodes, SIDEPATH_MINZOOM, SIDEPATH_SHARE, WAY_CASING, WAY_HALO, WAY_SELECTED } from "../ways";

export type Expr = ExpressionSpecification;
export type Color = string | Expr;

/** Width stops: px at these zooms. */
export const Z = [9, 11, 13, 15, 17, 19] as const;
export type W = readonly [number, number, number, number, number, number];

/**
 * The tiers of the network, the first channel of every variant:
 * 8 main road (trunk, primary) · 7 secondary · 6 tertiary · 5 minor road (unclassified) ·
 * 4 street (residential) · 3 service · 2 track · 1 cycle path · 0 path, footway and the rest.
 */
export const TIER = {
  major: 8,
  secondary: 7,
  tertiary: 6,
  minor: 5,
  street: 4,
  service: 3,
  track: 2,
  cycle: 1,
  path: 0,
} as const;

const HIGHWAY: Record<number, string[]> = {
  8: ["trunk", "trunk_link", "primary", "primary_link"],
  7: ["secondary", "secondary_link"],
  6: ["tertiary", "tertiary_link"],
  5: ["unclassified", "road"],
  4: ["residential", "living_street", "pedestrian"],
  3: ["service"],
  2: ["track"],
  1: ["cycleway"],
};

/** A `match` on an integer property; arms without codes are dropped. */
function match(key: string, arms: readonly (readonly [number[], unknown])[], fallback: unknown): Expr {
  const used = arms.filter(([codes]) => codes.length > 0);
  if (used.length === 0) return (Array.isArray(fallback) ? fallback : ["literal", fallback]) as Expr;
  return ["match", ["get", key], ...used.flat(), fallback] as unknown as Expr;
}

export const all = (...parts: Expr[]): Expr => ["all", ...parts] as Expr;
export const any = (...parts: Expr[]): Expr => ["any", ...parts] as Expr;
export const not = (e: Expr): Expr => ["!", e];
export const eq = (e: Expr, v: number): Expr => ["==", e, v];
export const oneOf = (e: Expr, ...values: number[]): Expr => ["match", e, values, true, false] as Expr;
/** `["match", by, v1, out1, …, fallback]` from pairs. */
export const pick = (by: Expr, arms: readonly (readonly [number | number[], unknown])[], fallback: unknown) =>
  ["match", by, ...arms.flat(), fallback] as unknown as Expr;

/** The expressions every variant is built from (overlay properties; codes looked up by label). */
export function classes(attributes: readonly OverlayAttribute[]) {
  const codes = enumCodes(attributes);
  const hw = (...labels: string[]) => codes("highway", ...labels);
  const tierArms = Object.entries(HIGHWAY).map(([tier, labels]) => [hw(...labels), Number(tier)] as const);
  const separate = match("cycleway_kind", [[codes("cycleway_kind", "separate_path"), true]], false);
  /** see `TIER` */
  const tier: Expr = [
    "case",
    // a path signed as a cycle path is one
    all(separate, match("highway", [[hw("path", "footway", "bridleway"), true]], false)),
    TIER.cycle,
    match("highway", tierArms, TIER.path),
  ];

  const sc = (...labels: string[]) => codes("surface_class", ...labels);
  const tt = (...labels: string[]) => codes("tracktype", ...labels);
  /**
   * The surface in three classes, the gravel rider's first question: 0 paved, 1 gravel (compacted or
   * loose), 2 ground (earth, grass, sand), 3 not mapped. From `surface_class`, else the track grade;
   * roads, cycle paths and footways without either are taken for paved.
   */
  const surface = match(
    "surface_class",
    [
      [sc("paved_smooth", "paved_rough"), 0],
      [sc("compacted", "gravel", "other"), 1],
      [sc("soft"), 2],
    ],
    match(
      "tracktype",
      [
        [tt("grade1"), 0],
        [tt("grade2", "grade3"), 1],
        [tt("grade4", "grade5"), 2],
      ],
      match("highway", [[hw("track", "path", "bridleway"), 3]], 0),
    ),
  );
  /**
   * The grade 1 to 5 (0: not mapped): 1 paved, 2 compacted, 3 gravel, 4 mostly soft, 5 soft. The track
   * grade where it is mapped, else read off the surface. A paved surface is always 1.
   */
  const grade = match(
    "surface_class",
    [[sc("paved_smooth", "paved_rough"), 1]],
    match(
      "tracktype",
      [
        [tt("grade1"), match("surface_class", [[sc("compacted", "gravel", "soft", "other"), 2]], 1)],
        [tt("grade2"), 2],
        [tt("grade3"), 3],
        [tt("grade4"), 4],
        [tt("grade5"), 5],
      ],
      match(
        "surface_class",
        [
          [sc("compacted"), 2],
          [sc("gravel", "other"), 3],
          [sc("soft"), 4],
        ],
        match("highway", [[hw("track", "path", "bridleway"), 0]], 1),
      ),
    ),
  );
  const restricted = match("bike_access", [[codes("bike_access", "private", "no"), true]], false);
  /** a paved path along a road (pavements, roadside cycle tracks): a line of its own only close up */
  const sidepath = all(["<=", tier, TIER.cycle], eq(surface, 0), [
    ">=",
    ["to-number", ["get", "road_near_share"], 0],
    SIDEPATH_SHARE,
  ]);
  // a ferry line is not a way to ride: left to the base map
  const ferry = match("highway", [[hw("ferry"), true]], false);
  const shown = all(not(ferry), any([">=", ["zoom"], SIDEPATH_MINZOOM], not(sidepath)));
  const steps = match("highway", [[hw("steps"), true]], false);
  return { tier, surface, grade, restricted, shown, steps };
}
export type Classes = ReturnType<typeof classes>;

/** `interpolate` over the zoom with one width per class at every stop (`scale` × table + `extra`). */
export function widths(
  by: Expr,
  table: Record<number, W>,
  fallback: number,
  extra: W = [0, 0, 0, 0, 0, 0],
  scale = 1,
): Expr {
  const stops: unknown[] = [];
  for (const [i, zoom] of Z.entries()) {
    const at = (w: W) => Math.round(((w[i] as number) * scale + (extra[i] as number)) * 100) / 100;
    const arms = Object.entries(table).flatMap(([cls, w]) => [Number(cls), at(w)]);
    stops.push(zoom, ["match", by, ...arms, at(table[fallback] as W)]);
  }
  return ["interpolate", ["exponential", 1.4], ["zoom"], ...stops] as Expr;
}

/** Widths of a cased band (the fill), by tier. */
export const BAND: Record<number, W> = {
  8: [1.7, 2.7, 4.6, 8.4, 16, 30],
  7: [1.3, 2.2, 4.0, 7.4, 14, 27],
  6: [0.9, 1.6, 3.3, 6.4, 12.5, 24],
  5: [0.6, 1.1, 2.6, 5.2, 10.5, 20],
  4: [0.5, 0.9, 2.2, 4.6, 9.5, 18],
  3: [0.3, 0.6, 1.3, 2.8, 6, 12],
  2: [0.4, 0.9, 1.7, 3.0, 5.4, 9],
  1: [0.3, 0.7, 1.3, 2.2, 3.6, 6],
  0: [0.3, 0.6, 1.0, 1.7, 2.8, 4.6],
};
/** What a casing adds to a band (both sides together). */
export const CASE: W = [0.7, 1.0, 1.6, 2.0, 2.6, 3.2];
/** Widths of a single line, by tier (an unpaved road is a little wider than a track). */
export const LINE: Record<number, W> = {
  8: [0.6, 1.1, 2.2, 3.3, 5, 8],
  7: [0.6, 1.1, 2.2, 3.3, 5, 8],
  6: [0.6, 1.1, 2.2, 3.3, 5, 8],
  5: [0.6, 1.1, 2.2, 3.3, 5, 8],
  4: [0.6, 1.0, 2.0, 3.0, 4.6, 7],
  3: [0.5, 0.9, 1.7, 2.5, 3.8, 6],
  2: [0.5, 0.9, 1.7, 2.5, 3.8, 6],
  1: [0.4, 0.8, 1.5, 2.2, 3.3, 5],
  0: [0.3, 0.6, 1.1, 1.6, 2.5, 4],
};
/** What the light rim under a single line adds. */
export const HALO: W = [0.8, 1.2, 1.9, 2.4, 3, 3.6];

export type Band = {
  filter: Expr;
  fill: Color;
  casing: Color;
  width: Expr;
  casingWidth: Expr;
  /** draw order among the bands (the tier, as a rule) */
  sort: Expr;
};
export type Line = {
  id: string;
  filter: Expr;
  color: Color;
  /** dash and gap in line widths; none: solid */
  dash?: readonly number[];
  width?: Expr;
  opacity?: number | Expr;
};
export type Spec = {
  band: Band;
  /** a second kind of band drawn under the first (variant D's tracks under the roads) */
  band2?: Band;
  /** the rim under the single lines */
  halo: { filter: Expr; color: Color; width: Expr; opacity: number };
  lineWidth: Expr;
  lines: Line[];
  /** what the base tiles add: tracks at z12, bridges, tunnels */
  base: BaseSpec;
};

export type WayOptions = { source: string; sourceLayer?: string; minzoom?: number };

/** `under` goes below the information and explored bands, `over` above them. */
export function specLayers(spec: Spec, k: Classes, o: WayOptions) {
  const base = {
    type: "line",
    source: o.source,
    ...(o.sourceLayer ? { "source-layer": o.sourceLayer } : {}),
    ...(o.minzoom ? { minzoom: o.minzoom } : {}),
  } as const;
  const round = { "line-cap": "round", "line-join": "round" } as const;
  const bands = [spec.band2, spec.band].filter((b) => b !== undefined);
  const bandCasing = (b: Band, id: string): LayerSpecification => ({
    ...base,
    id,
    filter: b.filter as never,
    layout: { ...round, "line-sort-key": b.sort as never },
    paint: { "line-color": b.casing as never, "line-width": b.casingWidth as never },
  });
  const bandFill = (b: Band, id: string): LayerSpecification => ({
    ...base,
    id,
    filter: b.filter as never,
    layout: { ...round, "line-sort-key": b.sort as never },
    paint: { "line-color": b.fill as never, "line-width": b.width as never },
  });
  const under: LayerSpecification[] = [
    {
      ...base,
      id: "r2-halo",
      filter: spec.halo.filter as never,
      layout: round,
      paint: {
        "line-color": spec.halo.color as never,
        "line-opacity": spec.halo.opacity,
        "line-width": spec.halo.width as never,
      },
    },
    ...bands.map((b, i) => bandCasing(b, i === bands.length - 1 ? "r2-band-casing" : "r2-band2-casing")),
    {
      // the edge the inspect panel shows, by feature-state (as in ways.ts)
      ...base,
      id: WAY_SELECTED,
      layout: round,
      paint: {
        "line-color": "#888888",
        "line-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.9, 0],
        "line-width": ["interpolate", ["linear"], ["zoom"], 13, 7, 16, 12, 19, 30],
      },
    },
  ];
  const over: LayerSpecification[] = [
    ...spec.lines.map(
      (l): LayerSpecification => ({
        ...base,
        id: `r2-${l.id}`,
        filter: l.filter as never,
        layout: l.dash ? { "line-cap": "butt", "line-join": "round" } : round,
        paint: {
          "line-color": l.color as never,
          "line-width": (l.width ?? spec.lineWidth) as never,
          ...(l.opacity === undefined ? {} : { "line-opacity": l.opacity as never }),
          ...(l.dash ? { "line-dasharray": [...l.dash] } : {}),
        },
      }),
    ),
    ...bands.map((b, i) => bandFill(b, i === bands.length - 1 ? "r2-band" : "r2-band2")),
    // what a tap can hit: every edge once, invisible (the ids `controller.ts` queries)
    {
      ...base,
      id: WAY_CASING,
      layout: round,
      paint: { "line-color": "#000000", "line-opacity": 0, "line-width": spec.lineWidth as never },
    },
    {
      ...base,
      id: WAY_HALO,
      filter: ["literal", false] as never,
      paint: { "line-opacity": 0 },
    },
  ];
  // the restricted ways are drawn like the others but fainter: one rule for every variant
  for (const layer of [...under.filter((l) => l.id.includes("band")), ...over]) {
    if (layer.type !== "line" || !layer.id.startsWith("r2-") || layer.paint?.["line-opacity"] !== undefined)
      continue;
    layer.paint = { ...layer.paint, "line-opacity": ["case", k.restricted, 0.45, 1] };
  }
  return { under, over };
}

// ---- what the base tiles (Protomaps `roads`) add --------------------------------------------------

const KIND = ["get", "kind"] as Expr;
const DETAIL = ["get", "kind_detail"] as Expr;
/** the tier of a base tile road, from its OSM class */
export const BASE_TIER: Expr = [
  "match",
  DETAIL,
  ...Object.entries(HIGHWAY).flatMap(([tier, labels]) => [labels, Number(tier)]),
  0,
] as Expr;

export type BaseSpec = {
  /** tracks at z12, where the overlay has none yet (no grade in the base tiles: one plain line) */
  track: { color: string; halo: string; opacity: number };
  /** the two rails of a bridge */
  bridge: string;
  /** the veil over a way in a tunnel (the land colour) and its dashed rails */
  tunnel: { veil: string; rail: string };
  /** how wide the variant draws a way of a tier, casing included: the rails go outside it */
  outer: Expr;
};

/** Total width a spec draws per tier (bands with their casing, lines with their halo): for bridge rails. */
export function outerWidth(bandFrom: number, scale = 1): Expr {
  const table: Record<number, W> = {};
  for (let tier = 0; tier <= 8; tier++) {
    const band = tier >= bandFrom;
    const w = (band ? BAND : LINE)[tier] as W;
    const extra = band ? CASE : HALO;
    table[tier] = w.map((v, i) => v * scale + (extra[i] as number) * 0.7) as unknown as W;
  }
  return widths(BASE_TIER, table, 0);
}

export function baseTrackLayers(source: string, b: BaseSpec): LayerSpecification[] {
  const base = {
    type: "line",
    source,
    "source-layer": "roads",
    minzoom: 12,
    maxzoom: 13,
    filter: ["all", ["==", KIND, "path"], ["==", DETAIL, "track"]] as never,
  } as const;
  const round = { "line-cap": "round", "line-join": "round" } as const;
  return [
    {
      ...base,
      id: "r2-base-track-halo",
      layout: round,
      paint: { "line-color": b.track.halo, "line-opacity": 0.6, "line-width": 2.4 },
    },
    {
      ...base,
      id: "r2-base-track",
      layout: round,
      paint: { "line-color": b.track.color, "line-opacity": b.track.opacity, "line-width": 1.1 },
    },
  ];
}

/** Bridges and tunnels of the roads, tracks and paths, from the base tiles' flags (the overlay has none). */
export function structureLayers(source: string, b: BaseSpec): LayerSpecification[] {
  const base = { type: "line", source, "source-layer": "roads" } as const;
  const way: Expr = ["in", KIND, ["literal", ["major_road", "minor_road", "path"]]];
  const rail: Expr = ["interpolate", ["linear"], ["zoom"], 13, 0.8, 15, 1.2, 17, 1.8];
  return [
    {
      ...base,
      id: "r2-tunnel-veil",
      minzoom: 13,
      filter: ["all", way, ["has", "is_tunnel"]],
      layout: { "line-cap": "butt" },
      paint: { "line-color": b.tunnel.veil, "line-opacity": 0.62, "line-width": b.outer as never },
    },
    {
      ...base,
      id: "r2-tunnel-rail",
      minzoom: 13,
      filter: ["all", way, ["has", "is_tunnel"]],
      layout: { "line-cap": "butt" },
      paint: {
        "line-color": b.tunnel.rail,
        "line-width": rail,
        "line-gap-width": b.outer as never,
        "line-dasharray": [2.5, 2],
      },
    },
    {
      ...base,
      id: "r2-bridge-rail",
      minzoom: 13.5,
      filter: ["all", way, ["has", "is_bridge"]],
      layout: { "line-cap": "butt" },
      paint: { "line-color": b.bridge, "line-width": rail, "line-gap-width": b.outer as never },
    },
  ];
}
