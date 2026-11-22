// The overlay edges drawn as the map's own roads, tracks and paths: the line system of the outdoor
// style (docs/map.md; design rounds 2 and 3). Pure builders (manifest → layers), no MapLibre runtime.
//
//   roads ............. cased bands in their familiar tiers: main roads lemon yellow, secondary pale
//                       yellow, the rest white; the width is the tier
//   tracks ............ one cased band for every grade, so a track reads as one line: the fill is the
//                       grade (white paved, cream compacted, ochre gravel, pale tan soft; all white in
//                       the "simple" track style), the rim paved or not (solid, or dashed from z15);
//                       an unpaved road is the band of its grade at the road's width
//   not mapped ........ a pale band with a grey dashed rim (neither surface nor grade: a fact, not a guess)
//   paths ............. thin solid lines: dark when unpaved, grey when paved, paler when nothing is
//                       mapped; violet is cycling (separate cycle paths, and the soft band of signed
//                       cycle routes under whatever carries them)
//   faint ............. private or no bicycle access; in a tunnel
//   ferry ............. a blue dashed line, never a band
//
// Every look is one row of `looks()`; the layers and the key (`KEY_ROWS`) are both generated from it,
// so they cannot drift apart. The classes come from the manifest's enum labels, never from codes; the
// drawing properties (`bridge`, `tunnel`, `layer`, `service_kind`) may be missing (older overlays).
import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";
import type { Carto } from "./carto";
import type { OverlayAttribute } from "./manifest";

type Expr = ExpressionSpecification;

export const ROUTES_MINZOOM = 9;
/** Paved paths along a road (`road_near_share` from `SIDEPATH_SHARE` percent on) appear from here. */
export const SIDEPATH_MINZOOM = 15;
export const SIDEPATH_SHARE = 60;
/** Driveways and car-park aisles (`service_kind`) appear from these zooms, thinner than service roads. */
export const DRIVEWAY_MINZOOM = 14;
export const PARKING_AISLE_MINZOOM = 15;
/** Tracks and paths are drawn at `TRACK_FADE` opacity up to `FADE_FROM`, fully from `FADE_TO`. */
export const TRACK_FADE = 0.5;
const FADE_FROM = 11;
const FADE_TO = 12.5;
/** Bridges get their rails from here (below, a bridge is just its way). */
export const BRIDGE_MINZOOM = 13;

export const WAY_ROUTE = "way-route";
export const WAY_HALO = "way-halo";
export const WAY_CASING = "way-casing";
export const WAY_CASING_DASHED = "way-casing-dashed";
export const WAY_SELECTED = "way-selected";
export const WAY_SOLID = "way-solid";
export const WAY_BAND = "way-band";
export const WAY_BRIDGE = "way-bridge";
export const WAY_FERRY = "way-ferry";
/** Every edge is in exactly one of these: what a tap can hit. */
export const WAY_PICK_LAYERS = [WAY_CASING, WAY_HALO, WAY_FERRY] as const;

/** The ferry's dash and gap, in line widths. */
export const FERRY_DASH = [3, 2.5] as const;
/** The rim of an unpaved band: dash and gap in casing widths; dashed from `RIM_DASH_MINZOOM`, plain below. */
export const RIM_DASH = [1.1, 0.7] as const;
export const RIM_DASH_MINZOOM = 15;

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
const pick = (by: Expr, arms: readonly (readonly [number | number[], unknown])[], fallback: unknown) =>
  ["match", by, ...arms.flat(), fallback] as unknown as Expr;
const all = (...parts: Expr[]): Expr => ["all", ...parts] as Expr;
const any = (...parts: Expr[]): Expr => ["any", ...parts] as Expr;
const not = (e: Expr): Expr => ["!", e];
const oneOf = (e: Expr, values: readonly number[]): Expr => ["in", e, ["literal", [...values]]] as Expr;

/**
 * The tier of a way, the width channel: 8 main road (trunk, primary) · 7 secondary · 6 tertiary ·
 * 5 minor road · 4 street · 3 service · 2 track · 1 cycle path · 0 path, footway and the rest;
 * 9: a driveway or car-park aisle (a service road drawn thinner).
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
  aisle: 9,
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

/** What an edge looks like: one row of `LOOKS` each. */
export const LOOK = {
  major: 1,
  secondary: 2,
  tertiary: 3,
  road: 4,
  /** grade 1: a paved track */
  lane: 5,
  compacted: 6,
  gravel: 7,
  unknown: 8,
  /** grade 4 and 5 */
  soft: 10,
  cycle: 11,
  pathPaved: 12,
  /** an unpaved path */
  path: 13,
  pathUnknown: 15,
  ferry: 16,
} as const;
export type LookId = keyof typeof LOOK;

/** The expressions every way layer is built from (overlay properties; codes looked up by label). */
export function wayClasses(attributes: readonly OverlayAttribute[]) {
  const codes = enumCodes(attributes);
  const hw = (...labels: string[]) => codes("highway", ...labels);
  const sc = (...labels: string[]) => codes("surface_class", ...labels);
  const tt = (...labels: string[]) => codes("tracktype", ...labels);
  const separate = match("cycleway_kind", [[codes("cycleway_kind", "separate_path"), true]], false);
  const serviceKind: Expr = ["to-number", ["get", "service_kind"], 0];
  const minorService = all(match("highway", [[hw("service"), true]], false), oneOf(serviceKind, [1, 2]));

  /** see `TIER` (without the aisles: they are service roads) */
  const tier: Expr = [
    "case",
    // a path signed as a separate cycle path is one
    all(separate, match("highway", [[hw("path", "footway", "bridleway"), true]], false)),
    TIER.cycle,
    match(
      "highway",
      Object.entries(HIGHWAY).map(([t, labels]) => [hw(...labels), Number(t)] as const),
      TIER.path,
    ),
  ];
  /** the tier for the widths: `tier`, the driveways and aisles thinner */
  const width: Expr = ["case", minorService, TIER.aisle, tier];

  /**
   * The grade 1 to 5 (0: nothing mapped): 1 paved, 2 compacted, 3 gravel, 4 mostly soft, 5 soft. The
   * track grade where it is mapped (a paved surface always makes it 1), else read off the surface;
   * roads, cycle paths and footways with nothing mapped count as paved, tracks and paths as unknown.
   */
  const grade: Expr = match(
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
  const ferry = match("highway", [[hw("ferry"), true]], false);
  const byGrade = (paved: number, unknown: number): Expr =>
    pick(
      grade,
      [
        [1, paved],
        [2, LOOK.compacted],
        [3, LOOK.gravel],
        [[4, 5], LOOK.soft],
      ],
      unknown,
    );
  /** see `LOOK` */
  const look: Expr = [
    "case",
    ferry,
    LOOK.ferry,
    ["==", tier, TIER.major],
    LOOK.major,
    ["==", tier, TIER.secondary],
    LOOK.secondary,
    ["==", tier, TIER.tertiary],
    byGrade(LOOK.tertiary, LOOK.tertiary),
    [">=", tier, TIER.service],
    byGrade(LOOK.road, LOOK.road),
    ["==", tier, TIER.track],
    byGrade(LOOK.lane, LOOK.unknown),
    ["==", tier, TIER.cycle],
    LOOK.cycle,
    pick(
      grade,
      [
        [1, LOOK.pathPaved],
        [[2, 3, 4, 5], LOOK.path],
      ],
      LOOK.pathUnknown,
    ),
  ];
  const restricted = match("bike_access", [[codes("bike_access", "private", "no"), true]], false);
  const bridge: Expr = ["==", ["get", "bridge"], 1];
  const tunnel: Expr = ["==", ["get", "tunnel"], 1];
  /** the crossing level: OSM `layer`, a bridge at least 1, a tunnel at most −1 */
  const level: Expr = [
    "case",
    bridge,
    ["max", 1, ["to-number", ["get", "layer"], 0]],
    tunnel,
    ["min", -1, ["to-number", ["get", "layer"], 0]],
    ["to-number", ["get", "layer"], 0],
  ];
  /** draw order of the bands: by crossing level, then tier (a road over the track it meets) */
  const sort: Expr = ["+", ["*", level, 16], ["case", ["==", tier, TIER.track], 2.5, tier]];
  /** a paved path along a road (pavements, roadside cycle tracks): a line of its own only close up */
  const sidepath = all(
    ["<=", tier, TIER.cycle],
    ["==", grade, 1],
    [">=", ["to-number", ["get", "road_near_share"], 0], SIDEPATH_SHARE],
  );
  /** what the way layers draw (the ferries have a layer of their own) */
  const shown = all(
    not(ferry),
    any([">=", ["zoom"], SIDEPATH_MINZOOM], not(sidepath)),
    any([">=", ["zoom"], DRIVEWAY_MINZOOM], ["!=", serviceKind, 2]),
    any([">=", ["zoom"], PARKING_AISLE_MINZOOM], ["!=", serviceKind, 1]),
  );
  const routeLevels = {
    local: codes("route_level", "lcn"),
    regional: codes("route_level", "rcn"),
    national: codes("route_level", "ncn", "icn"),
  };
  return { tier, width, grade, look, restricted, bridge, tunnel, sort, sidepath, ferry, shown, routeLevels };
}
export type WayClasses = ReturnType<typeof wayClasses>;

// ---- widths ----------------------------------------------------------------------------------------

/** The zooms of the width tables. */
export const ZOOMS = [8, 10, 12, 13, 14, 15, 16, 18] as const;
type W = readonly [number, number, number, number, number, number, number, number];

/** Fill width of a band (px), by `TIER`. A track band is wider than a street from z13 on. */
export const BAND_WIDTHS: Record<number, W> = {
  8: [1.4, 2.2, 3.6, 4.6, 6.2, 8.4, 11.5, 22],
  7: [0.9, 1.7, 3.1, 4.0, 5.4, 7.4, 10.2, 19],
  6: [0.5, 1.1, 2.4, 3.3, 4.6, 6.4, 8.8, 17],
  5: [0.4, 0.7, 1.7, 2.6, 3.7, 5.2, 7.4, 14],
  4: [0.3, 0.6, 1.4, 2.2, 3.2, 4.6, 6.6, 13],
  3: [0.3, 0.4, 0.8, 1.3, 2.0, 2.8, 4.2, 8.5],
  2: [0.3, 0.45, 1.25, 2.6, 3.6, 4.7, 6.2, 10.8],
  9: [0.2, 0.3, 0.5, 0.8, 1.3, 1.9, 2.8, 6],
};
/** What a band's casing adds (both sides together), by `TIER`: the roads' casing, the tracks' rim. */
export const CASING_WIDTHS: Record<number, W> = {
  8: [0.8, 1.0, 1.4, 1.6, 1.8, 2.0, 2.3, 3],
  2: [0, 0, 1.0, 1.6, 1.9, 2.2, 2.6, 3.4],
};
const CASING_DEFAULT = 8;
/** Width of a single line (px), by `TIER`: cycle paths and paths (thin: a forest is full of them). */
export const LINE_WIDTHS: Record<number, W> = {
  1: [0.4, 0.7, 1.2, 1.5, 1.8, 2.2, 2.7, 4],
  0: [0.3, 0.45, 0.75, 0.85, 1.0, 1.2, 1.5, 2.3],
};
/** What the light rim under a cycle path adds. */
export const HALO_WIDTHS: W = [0.6, 0.8, 1.2, 1.6, 1.9, 2.2, 2.6, 3.4];

const TIERS = [8, 7, 6, 5, 4, 3, 2, 1, 0, 9] as const;
const bandAt = (tier: number, i: number) => (BAND_WIDTHS[tier] ?? (BAND_WIDTHS[2] as W))[i] as number;
const casingAt = (tier: number, i: number) =>
  ((CASING_WIDTHS[tier === TIER.track ? 2 : CASING_DEFAULT] as W)[i] as number) *
  (tier === TIER.aisle ? 0.7 : 1);
const lineAt = (tier: number, i: number) => (LINE_WIDTHS[tier === TIER.cycle ? 1 : 0] as W)[i] as number;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** `interpolate` over the zoom; `at(i)` gives the width at `ZOOMS[i]` (a number or a data expression). */
function zoomed(at: (i: number) => unknown): Expr {
  return ["interpolate", ["exponential", 1.4], ["zoom"], ...ZOOMS.flatMap((z, i) => [z, at(i)])] as Expr;
}
/** A `match` on the width tier with one number per tier. */
function byTier(by: Expr, value: (tier: number) => number): Expr {
  return pick(
    by,
    TIERS.map((t) => [t, round2(value(t))] as const),
    round2(value(TIER.path)),
  );
}

/** The same interpolation in TypeScript (for the key): the width at `zoom` from per-stop values. */
export function widthAt(zoom: number, at: (i: number) => number): number {
  const base = 1.4;
  if (zoom <= ZOOMS[0]) return at(0);
  for (let i = 1; i < ZOOMS.length; i++) {
    const z1 = ZOOMS[i] as number;
    if (zoom > z1) continue;
    const z0 = ZOOMS[i - 1] as number;
    const t = (base ** (zoom - z0) - 1) / (base ** (z1 - z0) - 1);
    return at(i - 1) + (at(i) - at(i - 1)) * t;
  }
  return at(ZOOMS.length - 1);
}

/** The widths of an edge's drawing, per stop: fill (band) or line, and its outer edge (casing or halo). */
export const WIDTHS = {
  band: (tier: number, i: number) => bandAt(tier, i),
  casing: (tier: number, i: number) => bandAt(tier, i) + casingAt(tier, i),
  line: (tier: number, i: number) => lineAt(tier, i),
  halo: (tier: number, i: number) => lineAt(tier, i) + (HALO_WIDTHS[i] as number),
};

// ---- looks -----------------------------------------------------------------------------------------

type Shape = "band" | "line";
export type Look = {
  shape: Shape | "ferry";
  fill: string;
  /** a band's casing */
  casing?: string;
  /** an unpaved band: its rim is dashed (from `RIM_DASH_MINZOOM`) */
  rim?: "dashed";
};

/** Every look, with the colours of a theme and track style (`cartoFor` in carto.ts). */
export function looks(c: Carto): Record<LookId, Look> {
  const band = (fill: string, casing: string): Look => ({ shape: "band", fill, casing });
  const unpaved = (fill: string, casing = c.trackRimUnpaved): Look => ({
    ...band(fill, casing),
    rim: "dashed",
  });
  const line = (fill: string): Look => ({ shape: "line", fill });
  return {
    major: band(c.major, c.majorCasing),
    secondary: band(c.secondary, c.secondaryCasing),
    tertiary: band(c.tertiary, c.tertiaryCasing),
    road: band(c.road, c.roadCasing),
    lane: band(c.lane, c.trackCasing),
    compacted: unpaved(c.compacted),
    gravel: unpaved(c.gravel),
    unknown: unpaved(c.unknown, c.unknownCasing),
    soft: unpaved(c.soft),
    cycle: line(c.cycle),
    pathPaved: line(c.pathPaved),
    path: line(c.path),
    pathUnknown: line(c.pathUnknown),
    ferry: { shape: "ferry", fill: c.ferry },
  };
}
const ids = (table: Record<LookId, Look>, test: (l: Look) => boolean) =>
  (Object.keys(table) as LookId[]).filter((id) => test(table[id])).map((id) => LOOK[id]);

export type WayOptions = {
  source: string;
  sourceLayer: string;
  colors: Carto;
  routes: boolean;
  /** every width times this (the "Bold" line weight); default 1 */
  weight?: number;
};

/** Widths of the soft band of signed cycle routes (px at z9, 13, 17; local, regional, national). */
export const ROUTE_WIDTHS = { 9: [1, 1.4, 2], 13: [6, 7.5, 9], 17: [14, 17, 20] } as const;
export const ROUTE_OPACITY = { 9: 0.3, 13: 0.24, 17: 0.18 } as const;

/** The band of signed cycle routes: under the ways (it shows from the overview zooms on). */
export function routeLayer(attributes: readonly OverlayAttribute[], o: WayOptions): LayerSpecification {
  const { routeLevels: r, ferry } = wayClasses(attributes);
  const anyLevel = [...r.local, ...r.regional, ...r.national];
  const width = ([local, regional, national]: readonly number[]) =>
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
    filter: all(match("route_level", [[anyLevel, true]], false), not(ferry)) as never,
    layout: { "line-cap": "round", "line-join": "round", visibility: o.routes ? "visible" : "none" },
    paint: {
      "line-color": o.colors.cycleRoute,
      "line-opacity": [
        "interpolate",
        ["linear"],
        ["zoom"],
        ...Object.entries(ROUTE_OPACITY).flatMap(([z, v]) => [Number(z), v]),
      ] as never,
      "line-width": [
        "interpolate",
        ["exponential", 1.4],
        ["zoom"],
        ...Object.entries(ROUTE_WIDTHS).flatMap(([z, w]) => [Number(z), width(w)]),
      ] as Expr,
      "line-blur": 0.8,
    },
  };
}

/**
 * Width of what lies under the ways (the information band, the explored band, the cost layer): wider
 * than the way's casing or halo by `extra` px, so it shows as a coloured rim around the way's fill.
 */
export function underlayWidth(
  attributes: readonly OverlayAttribute[],
  scale = 1,
  /** a factor per feature (e.g. by feature state) */
  factor?: Expr,
  /** the line weight (`WayOptions.weight`): the ways it lies under are this much wider */
  weight = 1,
): Expr {
  const k = wayClasses(attributes);
  const bandLooks = ids(looks(PLAIN), (l) => l.shape === "band");
  return zoomed((i) => {
    const e = UNDERLAY_EXTRA[i] as number;
    const w: Expr = [
      "case",
      oneOf(k.look, bandLooks),
      byTier(k.width, (t) => (WIDTHS.casing(t, i) * weight + e) * scale),
      byTier(k.width, (t) => (WIDTHS.halo(t, i) * weight + e) * scale),
    ];
    return factor === undefined ? w : ["*", w, factor];
  });
}
/** How much wider than a way's casing or halo the bands under it are (px, at `ZOOMS`). */
export const UNDERLAY_EXTRA: W = [1.2, 1.6, 2.2, 2.6, 3, 3.4, 4, 6];
/** Colours do not matter where only the shapes are asked for. */
const PLAIN = new Proxy({} as Carto, { get: () => "#000000" });

/** The roads, tracks and paths: `under` goes below the information bands, `over` above them. */
export function wayLayers(
  attributes: readonly OverlayAttribute[],
  o: WayOptions,
): { under: LayerSpecification[]; over: LayerSpecification[] } {
  const k = wayClasses(attributes);
  const table = looks(o.colors);
  const entries = Object.entries(table) as [LookId, Look][];
  const base = { type: "line", source: o.source, "source-layer": o.sourceLayer } as const;
  const round = { "line-cap": "round", "line-join": "round" } as const;
  const colour = (part: "fill" | "casing" | "underDash") =>
    pick(
      k.look,
      entries.flatMap(([id, l]) => {
        // under a dashed rim the casing is the fill: the gaps keep the band's width
        const v = part === "underDash" ? (l.rim === "dashed" ? l.fill : l.casing) : l[part];
        return v ? [[LOOK[id], v] as const] : [];
      }),
      o.colors.road,
    );
  const bands = all(
    k.shown,
    oneOf(
      k.look,
      ids(table, (l) => l.shape === "band"),
    ),
  );
  const lines = all(
    k.shown,
    oneOf(
      k.look,
      ids(table, (l) => l.shape === "line"),
    ),
  );
  /**
   * Restricted ways and tunnels are drawn fainter; tracks and paths fade in over the overview zooms,
   * so the roads stay the skeleton there.
   */
  const opacity = (full: number | Expr): Expr => {
    const at = (fade: number): Expr => [
      "*",
      full,
      ["case", k.restricted, 0.45, 1],
      ["case", k.tunnel, 0.4, 1],
      ["case", ["<=", k.tier, TIER.track], fade, 1],
    ];
    return ["interpolate", ["linear"], ["zoom"], FADE_FROM, at(TRACK_FADE), FADE_TO, at(1)];
  };
  const s = o.weight ?? 1;
  const bandWidth = zoomed((i) => byTier(k.width, (t) => WIDTHS.band(t, i) * s));
  const casingWidth = zoomed((i) => byTier(k.width, (t) => WIDTHS.casing(t, i) * s));
  const lineWidth = zoomed((i) => byTier(k.width, (t) => WIDTHS.line(t, i) * s));
  const haloWidth = zoomed((i) => byTier(k.width, (t) => WIDTHS.halo(t, i) * s));

  const under: LayerSpecification[] = [
    {
      ...base,
      id: WAY_HALO,
      filter: lines as never,
      layout: round,
      paint: {
        "line-color": o.colors.wayHalo,
        // only a cycle path has one; the other lines keep the layer (transparent) so a tap finds them
        "line-opacity": opacity(["case", ["==", k.look, LOOK.cycle], 0.85, 0]),
        "line-width": haloWidth,
        "line-blur": 0.4,
      },
    },
    {
      ...base,
      id: WAY_CASING,
      filter: bands as never,
      layout: { ...round, "line-sort-key": k.sort as never },
      paint: {
        // an unpaved band's rim is plain (and light) below RIM_DASH_MINZOOM; from there this is the
        // band's own fill and the dashes lie on top of it, so the gaps keep the band's width
        "line-color": ["step", ["zoom"], colour("casing"), RIM_DASH_MINZOOM, colour("underDash")] as Expr,
        "line-width": casingWidth,
        "line-opacity": opacity(1),
      },
    },
    {
      ...base,
      id: WAY_CASING_DASHED,
      minzoom: RIM_DASH_MINZOOM,
      filter: all(
        k.shown,
        oneOf(
          k.look,
          ids(table, (l) => l.rim === "dashed"),
        ),
      ) as never,
      layout: { "line-cap": "butt", "line-join": "round", "line-sort-key": k.sort as never },
      paint: {
        "line-color": colour("casing"),
        "line-width": casingWidth,
        "line-opacity": opacity(1),
        "line-dasharray": [...RIM_DASH],
      },
    },
    {
      // the edge the inspect panel shows: a halo under the way (its style stays readable), by feature-state
      ...base,
      id: WAY_SELECTED,
      layout: round,
      paint: {
        "line-color": o.colors.label,
        "line-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.9, 0],
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 6, 16, 14, 19, 32],
      },
    },
  ];
  const over: LayerSpecification[] = [
    {
      ...base,
      id: WAY_SOLID,
      filter: lines as never,
      layout: round,
      paint: { "line-color": colour("fill"), "line-width": lineWidth, "line-opacity": opacity(1) },
    },
    {
      ...base,
      id: WAY_BAND,
      filter: bands as never,
      layout: { ...round, "line-sort-key": k.sort as never },
      paint: { "line-color": colour("fill"), "line-width": bandWidth, "line-opacity": opacity(1) },
    },
    {
      // a bridge: two rails just outside the way, above whatever passes underneath
      ...base,
      id: WAY_BRIDGE,
      minzoom: BRIDGE_MINZOOM,
      filter: all(k.shown, k.bridge) as never,
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": o.colors.bridge,
        "line-opacity": ["case", k.restricted, 0.5, 0.9],
        "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.8, 16, 1.4, 18, 2],
        "line-gap-width": zoomed((i) => [
          "case",
          oneOf(
            k.look,
            ids(table, (l) => l.shape === "band"),
          ),
          byTier(k.width, (t) => WIDTHS.casing(t, i) * s + 0.6),
          byTier(k.width, (t) => WIDTHS.halo(t, i) * s + 0.6),
        ]),
      },
    },
    {
      ...base,
      id: WAY_FERRY,
      filter: k.ferry as never,
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": table.ferry.fill,
        "line-opacity": 0.85,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.8, 13, 1.4, 17, 2.4],
        "line-dasharray": [...FERRY_DASH],
      },
    },
  ];
  return { under, over };
}

// ---- the key ---------------------------------------------------------------------------------------

/** One stroke of a key's sample line, bottom to top. */
export type KeyStroke = {
  color: string;
  width: number;
  opacity: number;
  /** dash and gap in px; none: solid */
  dash?: [number, number];
  cap: "round" | "butt";
  blur?: boolean;
};
export type KeyRow = {
  group: "Roads" | "Tracks" | "Paths" | "Also";
  label: string;
  note?: string;
  look: LookId;
  tier: number;
  /** the labels of an edge drawn like this (the unit tests check it classifies as `look` and `tier`) */
  sample: Record<string, string>;
  restricted?: boolean;
  route?: boolean;
};

/** The key's zoom: what the key shows is the map at this zoom (where the unpaved rims are dashed). */
export const KEY_ZOOM = 15;
const paved = { surface_class: "paved_smooth" };
export const KEY_ROWS: readonly KeyRow[] = [
  { group: "Roads", label: "Main road", look: "major", tier: 8, sample: { highway: "primary", ...paved } },
  { group: "Roads", label: "Secondary", look: "secondary", tier: 7, sample: { highway: "secondary" } },
  { group: "Roads", label: "Tertiary", look: "tertiary", tier: 6, sample: { highway: "tertiary" } },
  { group: "Roads", label: "Minor road", look: "road", tier: 5, sample: { highway: "unclassified" } },
  { group: "Roads", label: "Street", look: "road", tier: 4, sample: { highway: "residential" } },
  { group: "Roads", label: "Service", look: "road", tier: 3, sample: { highway: "service" } },
  {
    group: "Roads",
    label: "Unpaved road",
    note: "gravel",
    look: "gravel",
    tier: 5,
    sample: { highway: "unclassified", surface_class: "gravel" },
  },
  {
    group: "Tracks",
    label: "Paved",
    note: "grade 1",
    look: "lane",
    tier: 2,
    sample: { highway: "track", tracktype: "grade1" },
  },
  {
    group: "Tracks",
    label: "Compacted",
    note: "grade 2",
    look: "compacted",
    tier: 2,
    sample: { highway: "track", tracktype: "grade2" },
  },
  {
    group: "Tracks",
    label: "Gravel",
    note: "grade 3",
    look: "gravel",
    tier: 2,
    sample: { highway: "track", tracktype: "grade3" },
  },
  {
    group: "Tracks",
    label: "Soft",
    note: "grade 4–5",
    look: "soft",
    tier: 2,
    sample: { highway: "track", tracktype: "grade4" },
  },
  {
    group: "Tracks",
    label: "Not mapped",
    look: "unknown",
    tier: 2,
    sample: { highway: "track" },
  },
  { group: "Paths", label: "Cycle path", look: "cycle", tier: 1, sample: { highway: "cycleway" } },
  { group: "Paths", label: "Paved", look: "pathPaved", tier: 0, sample: { highway: "path", ...paved } },
  {
    group: "Paths",
    label: "Unpaved",
    look: "path",
    tier: 0,
    sample: { highway: "path", surface_class: "gravel" },
  },
  { group: "Paths", label: "Not mapped", look: "pathUnknown", tier: 0, sample: { highway: "path" } },
  {
    group: "Also",
    label: "No bike access",
    look: "compacted",
    tier: 2,
    sample: { highway: "track", tracktype: "grade2", bike_access: "private" },
    restricted: true,
  },
  {
    group: "Also",
    label: "Cycle route",
    note: "signed",
    look: "compacted",
    tier: 2,
    sample: { highway: "track", tracktype: "grade2", route_level: "rcn" },
    route: true,
  },
  { group: "Also", label: "Ferry", look: "ferry", tier: 0, sample: { highway: "ferry" } },
];

/** The strokes of a key row, as the map draws that way at `KEY_ZOOM`: same tables, same colours. */
export function keyStrokes(row: KeyRow, c: Carto, weight = 1): KeyStroke[] {
  const look = looks(c)[row.look];
  const z = KEY_ZOOM;
  const w = (f: (tier: number, i: number) => number) => round2(widthAt(z, (i) => f(row.tier, i)) * weight);
  const opacity = row.restricted ? 0.45 : 1;
  const strokes: KeyStroke[] = [];
  if (row.route) {
    const lerp = (a: number, b: number) => a + ((b - a) * (z - 13)) / 4;
    strokes.push({
      color: c.cycleRoute,
      width: round2(lerp(ROUTE_WIDTHS[13][1], ROUTE_WIDTHS[17][1])),
      opacity: lerp(ROUTE_OPACITY[13], ROUTE_OPACITY[17]),
      cap: "round",
      blur: true,
    });
  }
  if (look.shape === "band") {
    const casing = w(WIDTHS.casing);
    const rim = look.casing ?? look.fill;
    if (look.rim === "dashed") {
      // at KEY_ZOOM (≥ RIM_DASH_MINZOOM) the rim is dashed on the band's own fill
      strokes.push({ color: look.fill, width: casing, opacity, cap: "round" });
      strokes.push({
        color: rim,
        width: casing,
        opacity,
        cap: "butt",
        dash: [round2(RIM_DASH[0] * casing), round2(RIM_DASH[1] * casing)],
      });
    } else strokes.push({ color: rim, width: casing, opacity, cap: "round" });
    strokes.push({ color: look.fill, width: w(WIDTHS.band), opacity, cap: "round" });
  } else if (look.shape === "line") {
    if (row.look === "cycle")
      strokes.push({ color: c.wayHalo, width: w(WIDTHS.halo), opacity: 0.85 * opacity, cap: "round" });
    strokes.push({ color: look.fill, width: w(WIDTHS.line), opacity, cap: "round" });
  } else {
    const width = round2(1.4 + ((2.4 - 1.4) * (z - 13)) / 4);
    strokes.push({
      color: look.fill,
      width,
      opacity: 0.85,
      cap: "butt",
      dash: [round2(FERRY_DASH[0] * width), round2(FERRY_DASH[1] * width)],
    });
  }
  return strokes;
}
