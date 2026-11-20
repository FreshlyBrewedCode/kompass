// The overlay edges drawn as the map's own roads, tracks and paths: the line vocabulary of the outdoor
// style. Pure builders (manifest → layers), no MapLibre runtime.
//
//   paved road ............. a cased band, white to yellow by class (the classic road)
//   paved track ............ the same, narrow, with a brown rim: "a lane you can ride on anything"
//   everything unpaved ..... one brown line whose dash says how firm it is:
//                            solid = paved path, long dashes = compacted, short dashes = gravel,
//                            dots = soft ground
//   width ................... the kind of way: unpaved road > track > cycle path > path
//   violet .................. cycling: a separate cycle path is a violet line, a signed cycle route a
//                            soft violet band under whatever carries it
//   grey .................... private or no bicycle access
//   a lighter brown ......... neither surface nor track grade is mapped (a guess is drawn, not a fact)
//
// The classes come from the manifest's enum labels, so the codes of a build are never assumed.
import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";
import type { Carto } from "./carto";
import type { OverlayAttribute } from "./manifest";

type Expr = ExpressionSpecification;

/** From this zoom on the overlay carries every edge, and draws the roads instead of the base map. */
export const WAYS_MINZOOM = 13;
export const ROUTES_MINZOOM = 9;
/** Paved paths along a road (`road_near_share` from `SIDEPATH_SHARE` percent on) appear from here. */
export const SIDEPATH_MINZOOM = 15;
export const SIDEPATH_SHARE = 60;

export const WAY_ROUTE = "way-route";
export const WAY_CASING = "way-casing";
export const WAY_HALO = "way-halo";
export const WAY_SELECTED = "way-selected";
export const WAY_ROAD = "way-road";
export const WAY_SOLID = "way-solid";
export const WAY_FIRM = "way-firm";
export const WAY_LOOSE = "way-loose";
export const WAY_SOFT = "way-soft";
/** How many of `wayLayers` are rims (casing, halo, selection): the bands of `style.ts` go right above them. */
export const WAY_UNDERLAY = 3;
/** Every edge is in exactly one of these: what a tap can hit. */
export const WAY_PICK_LAYERS = [WAY_CASING, WAY_HALO] as const;

/** Dash and gap in line widths, per firmness (`null`: a solid line). */
export const DASHES = { firm: [5.5, 1.6], loose: [2.6, 1.7], soft: [0.9, 1.5] } as const;

const normalise = (label: string) =>
  label
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

/** Looks up enum codes by label: `codes("highway", "track", "path")`. Unknown labels and keys give nothing. */
export function enumCodes(attributes: readonly OverlayAttribute[]) {
  const tables = new Map<string, Map<string, number>>();
  for (const a of attributes) {
    if (a.kind === "enum") tables.set(a.key, new Map(a.values.map((v) => [normalise(v.label), v.value])));
  }
  return (key: string, ...labels: string[]): number[] => {
    const table = tables.get(key);
    return labels.flatMap((label) => table?.get(normalise(label)) ?? []);
  };
}

/**
 * A `match` on an integer property; arms without codes are dropped (an empty `match` is invalid). With
 * no arm left it is the fallback as a literal: still an expression, so a filter around it stays one.
 */
function match(key: string, arms: readonly (readonly [number[], unknown])[], fallback: unknown): Expr {
  const used = arms.filter(([codes]) => codes.length > 0);
  if (used.length === 0) return (Array.isArray(fallback) ? fallback : ["literal", fallback]) as Expr;
  return ["match", ["get", key], ...used.flat(), fallback] as unknown as Expr;
}

const HIGHWAY = {
  major: ["trunk", "trunk_link", "primary", "primary_link"],
  secondary: ["secondary", "secondary_link"],
  tertiary: ["tertiary", "tertiary_link"],
  minor: ["unclassified", "residential", "living_street", "road"],
  service: ["service"],
  track: ["track"],
  cycleway: ["cycleway"],
  /** assumed soft when nothing is mapped; footways and the rest are assumed paved */
  path: ["path", "bridleway"],
} as const;

/** The expressions every way layer is built from. */
export function wayClasses(attributes: readonly OverlayAttribute[]) {
  const codes = enumCodes(attributes);
  const hw = (...groups: (keyof typeof HIGHWAY)[]) => codes("highway", ...groups.flatMap((g) => HIGHWAY[g]));

  /** 7 major … 2 track; 0 for paths and everything else */
  const rank = match(
    "highway",
    [
      [hw("major"), 7],
      [hw("secondary"), 6],
      [hw("tertiary"), 5],
      [hw("minor"), 4],
      [hw("service"), 3],
      [hw("track"), 2],
    ],
    0,
  );

  const surface = (...labels: string[]) => codes("surface_class", ...labels);
  const grade = (...labels: string[]) => codes("tracktype", ...labels);
  /** 0 paved, 1 compacted, 2 gravel, 3 soft: from the surface, else the track grade, else the kind of way */
  const firmness = match(
    "surface_class",
    [
      [surface("paved_smooth", "paved_rough"), 0],
      [surface("compacted"), 1],
      [surface("gravel", "other"), 2],
      [surface("soft"), 3],
    ],
    match(
      "tracktype",
      [
        [grade("grade1"), 0],
        [grade("grade2"), 1],
        [grade("grade3"), 2],
        [grade("grade4", "grade5"), 3],
      ],
      match(
        "highway",
        [
          [hw("track"), 2],
          [hw("path"), 3],
        ],
        0,
      ),
    ),
  );
  const known = (key: string, unknown: string) => {
    const all = attributes.find((a) => a.key === key);
    const values = all?.kind === "enum" ? all.values.map((v) => v.value) : [];
    const unknownCodes = new Set(codes(key, unknown));
    return match(key, [[values.filter((v) => !unknownCodes.has(v)), true]], false);
  };
  /** a track or path with neither surface nor grade: the dash is a guess */
  const guessed: Expr = [
    "all",
    ["!", known("surface_class", "unknown")],
    ["!", known("tracktype", "unknown")],
    match("highway", [[hw("track", "path"), true]], false),
  ];

  /** drawn as a cased road: the big roads always, the small ones and tracks when paved */
  const road: Expr = [
    "any",
    match("highway", [[hw("major", "secondary"), true]], false),
    [
      "all",
      match("highway", [[hw("tertiary", "minor", "service", "track"), true]], false),
      ["==", firmness, 0],
    ],
  ];
  const cycle: Expr = [
    "any",
    match("highway", [[hw("cycleway"), true]], false),
    match("cycleway_kind", [[codes("cycleway_kind", "separate_path"), true]], false),
  ];
  /** line width class of the unpaved ways: 3 unpaved road, 2 track, 1 cycle path, 0 path */
  const kind: Expr = [
    "case",
    match("highway", [[hw("tertiary", "minor", "service"), true]], false),
    3,
    match("highway", [[hw("track"), true]], false),
    2,
    cycle,
    1,
    0,
  ];
  /**
   * A paved path or cycle path that runs along a road (pavements, roadside cycle tracks): part of the
   * road at planning zooms, a line of its own only from `SIDEPATH_MINZOOM` on. A town is full of them.
   */
  const sidepath: Expr = [
    "all",
    ["<", kind, 2],
    ["==", firmness, 0],
    [">=", ["to-number", ["get", "road_near_share"], 0], SIDEPATH_SHARE],
  ];
  const restricted = match("bike_access", [[codes("bike_access", "private", "no"), true]], false);
  const routeLevels = {
    local: codes("route_level", "lcn"),
    regional: codes("route_level", "rcn"),
    national: codes("route_level", "ncn", "icn"),
  };
  return { rank, firmness, guessed, road, cycle, kind, sidepath, restricted, routeLevels };
}

const ZOOMS = [13, 15, 17, 19] as const;
type Widths = readonly [number, number, number, number];

/** Road widths in px at z13, 15, 17, 19, by rank. */
export const ROAD_WIDTHS: Record<number, Widths> = {
  7: [2.8, 5.2, 11, 24],
  6: [2.4, 4.6, 10, 22],
  5: [2.1, 4.0, 9, 20],
  4: [1.8, 3.4, 7.5, 17],
  3: [1.0, 1.8, 4.5, 10],
  2: [1.3, 2.1, 4.2, 9],
};
/** Line widths of the unpaved ways, by kind (3 road, 2 track, 1 cycle path, 0 path). */
export const LINE_WIDTHS: Record<number, Widths> = {
  3: [1.5, 2.1, 3.2, 5],
  2: [1.15, 1.8, 2.8, 4.4],
  1: [1.1, 1.65, 2.5, 4],
  0: [0.75, 1.15, 1.9, 3],
};

/** `interpolate` over the zoom with a per-class width at every stop, plus `extra` px (a casing). */
function widths(table: Record<number, Widths>, by: Expr, fallback: number, extra: Widths = [0, 0, 0, 0]) {
  const stops: unknown[] = [];
  for (const [i, zoom] of ZOOMS.entries()) {
    const arms = Object.entries(table).flatMap(([cls, w]) => [
      Number(cls),
      (w[i] as number) + (extra[i] as number),
    ]);
    const other = (table[fallback]?.[i] as number) + (extra[i] as number);
    stops.push(zoom, ["match", by, ...arms, other]);
  }
  return ["interpolate", ["exponential", 1.4], ["zoom"], ...stops] as Expr;
}

export type WayOptions = { source: string; sourceLayer: string; colors: Carto; routes: boolean };

/** The route halo: goes under the base map's roads (it shows from the overview zooms on). */
export function routeLayer(attributes: readonly OverlayAttribute[], o: WayOptions): LayerSpecification {
  const { routeLevels: r } = wayClasses(attributes);
  const any = [...r.local, ...r.regional, ...r.national];
  const width = (local: number, regional: number, national: number) =>
    match(
      "route_level",
      [
        [r.national, national],
        [r.regional, regional],
      ],
      local,
    );
  return {
    id: WAY_ROUTE,
    type: "line",
    source: o.source,
    "source-layer": o.sourceLayer,
    minzoom: ROUTES_MINZOOM,
    filter: match("route_level", [[any, true]], false) as never,
    layout: { "line-cap": "round", "line-join": "round", visibility: o.routes ? "visible" : "none" },
    paint: {
      "line-color": o.colors.cycleRoute,
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 9, 0.3, 13, 0.24, 17, 0.18],
      "line-width": [
        "interpolate",
        ["exponential", 1.4],
        ["zoom"],
        9,
        width(1, 1.4, 2),
        13,
        width(5, 6.5, 8),
        17,
        width(13, 16, 19),
      ] as Expr,
      "line-blur": 0.8,
    },
  };
}

/** The roads, tracks and paths, bottom to top. */
export function wayLayers(attributes: readonly OverlayAttribute[], o: WayOptions): LayerSpecification[] {
  const c = o.colors;
  const k = wayClasses(attributes);
  const base = {
    type: "line",
    source: o.source,
    "source-layer": o.sourceLayer,
    minzoom: WAYS_MINZOOM,
  } as const;
  const round = { "line-cap": "round", "line-join": "round" } as const;
  const line: Expr = ["all", ["!", k.road], ["any", [">=", ["zoom"], SIDEPATH_MINZOOM], ["!", k.sidepath]]];

  const lineColor: Expr = [
    "case",
    k.restricted,
    c.restricted,
    k.cycle,
    c.cycle,
    k.guessed,
    c.trackUnknown,
    ["all", ["==", k.kind, 0], ["==", k.firmness, 0]],
    c.pathPaved,
    ["==", k.kind, 0],
    c.path,
    c.track,
  ];
  const lineWidth = widths(LINE_WIDTHS, k.kind, 0);
  const dashed = (id: string, firmness: number, dash: readonly number[] | null): LayerSpecification => ({
    ...base,
    id,
    filter: ["all", line, ["==", k.firmness, firmness]] as never,
    // a dash keeps its length with butt caps; the solid line joins its neighbours with round ones
    layout: dash ? { "line-cap": "butt", "line-join": "round" } : round,
    paint: {
      "line-color": lineColor,
      "line-width": lineWidth,
      "line-opacity": ["case", k.restricted, 0.75, 1] as Expr,
      ...(dash ? { "line-dasharray": [...dash] } : {}),
    },
  });

  return [
    {
      ...base,
      id: WAY_CASING,
      filter: k.road as never,
      layout: round,
      paint: {
        "line-color": [
          "match",
          k.rank,
          7,
          c.primaryCasing,
          6,
          c.secondaryCasing,
          2,
          c.laneCasing,
          c.roadCasing,
        ] as Expr,
        "line-width": widths(ROAD_WIDTHS, k.rank, 4, [1.3, 1.6, 2, 2.4]),
      },
    },
    {
      ...base,
      id: WAY_HALO,
      filter: line as never,
      layout: round,
      paint: {
        "line-color": c.wayHalo,
        "line-opacity": ["case", k.restricted, 0.35, 0.7] as Expr,
        "line-width": widths(LINE_WIDTHS, k.kind, 0, [2, 2.4, 3, 3.6]),
        "line-blur": 0.6,
      },
    },
    {
      // the edge the inspect panel shows: a halo under the line (its style stays readable), by feature-state
      ...base,
      id: WAY_SELECTED,
      layout: round,
      paint: {
        "line-color": c.label,
        "line-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.9, 0],
        "line-width": ["interpolate", ["linear"], ["zoom"], 13, 7, 16, 12, 19, 30],
      },
    },
    {
      ...base,
      id: WAY_ROAD,
      filter: k.road as never,
      layout: { ...round, "line-sort-key": k.rank as never },
      paint: {
        "line-color": ["match", k.rank, 7, c.primary, 6, c.secondary, 2, c.lane, c.road] as Expr,
        "line-width": widths(ROAD_WIDTHS, k.rank, 4),
      },
    },
    dashed(WAY_SOLID, 0, null),
    dashed(WAY_FIRM, 1, DASHES.firm),
    dashed(WAY_LOOSE, 2, DASHES.loose),
    dashed(WAY_SOFT, 3, DASHES.soft),
  ];
}
