// Map style round 2 (issue #37): the four variants. PROTOTYPE, see docs/design/map-round-2.md.
//
//   A  classic   the outdoor-map convention: white-to-yellow cased roads, brown tracks whose dash is the grade
//   B  surface   the colour is the surface (slate paved, amber gravel, brown ground), the width the tier
//   C  quiet     a pale base; ink for what a gravel rider rides, main roads present but receding
//   D  bands     every way a road-like band: the fill darkens with roughness, the worst grades break up
import { CARTO, type Carto } from "../carto";
import type { Theme } from "../palette";
import {
  all,
  any,
  BAND,
  type BaseSpec,
  CASE,
  type Classes,
  type Color,
  type Expr,
  eq,
  HALO,
  LINE,
  type Line,
  not,
  oneOf,
  outerWidth,
  pick,
  type Spec,
  TIER,
  widths,
} from "./shared";

export const VARIANTS = ["a", "b", "c", "d"] as const;
export type VariantId = (typeof VARIANTS)[number];
export type Variant = { id: VariantId; name: string; carto: Carto; spec: (k: Classes) => Spec };

/** `?mapstyle=a|b|c|d`; anything else: the shipped style. */
export function variantFromSearch(search: string): VariantId | null {
  const v = new URLSearchParams(search).get("mapstyle")?.toLowerCase();
  return (VARIANTS as readonly string[]).includes(v ?? "") ? (v as VariantId) : null;
}

/** Dashes by grade, in line widths: the longer the dash, the firmer the way. */
const DASH = {
  g3: [6, 1.7],
  g4: [2.6, 1.6],
  g5: [0.9, 1.5],
  unknown: [4, 2.2],
  path: [3, 1.7],
} as const;

const CYCLE = { light: "#5b54d6", dark: "#a59cff" };
const VIOLET_ROUTE = { light: "#6f5df0", dark: "#8f84ff" };

/** The shared shape: paved roads (and paved tracks) are bands, the rest single lines. */
function shapes(k: Classes) {
  const road = any([">=", k.tier, TIER.secondary], all([">=", k.tier, TIER.track], eq(k.surface, 0)));
  const trackish = all([">=", k.tier, TIER.track], ["<", k.tier, TIER.secondary], not(eq(k.surface, 0)));
  const pathish = ["<=", k.tier, TIER.cycle] as Expr;
  const path = all(eq(k.tier, TIER.path), k.shown);
  const cycle = all(eq(k.tier, TIER.cycle), k.shown);
  return { road, trackish, pathish, path, cycle };
}

const byTier = (k: Classes, arms: readonly (readonly [number | number[], string])[], other: string) =>
  pick(k.tier, arms, other);

// ---------------------------------------------------------------------------------------------------
// A: classic
// ---------------------------------------------------------------------------------------------------
function classic(theme: Theme): Variant {
  const L = theme === "light";
  const c = {
    major: L ? "#f8c467" : "#9a742c",
    majorCasing: L ? "#b3822b" : "#0c0e0d",
    secondary: L ? "#fde488" : "#8d7c44",
    secondaryCasing: L ? "#b09a45" : "#0c0e0d",
    tertiary: L ? "#fff5c0" : "#77704f",
    road: L ? "#ffffff" : "#62676a",
    roadCasing: L ? "#8c8578" : "#0c0e0d",
    laneCasing: L ? "#7a5632" : "#0c0e0d",
    track: L ? "#6b4423" : "#ead3ac",
    trackUnknown: L ? "#a38a70" : "#93806a",
    path: L ? "#5b4633" : "#c7ae92",
    pathPaved: L ? "#93897a" : "#8b8072",
    halo: L ? "#fffdf6" : "#0f1110",
  };
  const carto: Carto = {
    ...CARTO[theme],
    ...(L
      ? { forest: "#cbe2b7", meadow: "#e5eed0", buildings: "#d5ccbf", water: "#a6d2ee", waterway: "#74b3de" }
      : RELIEF_DARK),
  };
  return {
    id: "a",
    name: "Classic",
    carto,
    spec: (k) => {
      const s = shapes(k);
      const base: BaseSpec = {
        track: { color: c.track, halo: c.halo, opacity: 0.85 },
        bridge: L ? "#4a4339" : "#d8d2c6",
        tunnel: { veil: carto.land, rail: L ? "#8c8578" : "#7d7f7c" },
        outer: outerWidth(TIER.service),
      };
      const track = (id: string, grade: number, dash?: readonly number[]): Line => ({
        id,
        filter: all(s.trackish, eq(k.grade, grade)),
        color: c.track,
        ...(dash ? { dash } : {}),
      });
      return {
        band: {
          filter: s.road,
          fill: byTier(
            k,
            [
              [8, c.major],
              [7, c.secondary],
              [6, c.tertiary],
            ],
            c.road,
          ),
          casing: byTier(
            k,
            [
              [8, c.majorCasing],
              [7, c.secondaryCasing],
              [2, c.laneCasing],
            ],
            c.roadCasing,
          ),
          width: widths(k.tier, BAND, 4),
          casingWidth: widths(k.tier, BAND, 4, CASE),
          sort: k.tier,
        },
        halo: {
          filter: all(not(s.road), k.shown),
          color: c.halo,
          width: widths(k.tier, LINE, 0, HALO),
          opacity: 0.85,
        },
        lineWidth: widths(k.tier, LINE, 0),
        lines: [
          { id: "path-paved", filter: all(s.path, eq(k.surface, 0)), color: c.pathPaved },
          {
            id: "path",
            filter: all(s.path, not(eq(k.surface, 0))),
            color: ["case", eq(k.surface, 3), c.trackUnknown, c.path],
            dash: DASH.path,
          },
          { id: "cycle", filter: s.cycle, color: CYCLE[theme] },
          {
            id: "track-unknown",
            filter: all(s.trackish, eq(k.grade, 0)),
            color: c.trackUnknown,
            dash: DASH.unknown,
          },
          track("track-5", 5, DASH.g5),
          track("track-4", 4, DASH.g4),
          track("track-3", 3, DASH.g3),
          track("track-2", 2),
        ],
        base,
      };
    },
  };
}

/** The dark relief, less muddy: shadows barely darker than the land, the lit slopes carry the form. */
const RELIEF_DARK = {
  shade: "#050706",
  highlight: "#5c6e5f",
  hillshadeStrength: 0.3,
  forest: "#1d3222",
  contour: "#8f7658",
} as const;

// ---------------------------------------------------------------------------------------------------
// B: surface first
// ---------------------------------------------------------------------------------------------------
function surfaceFirst(theme: Theme): Variant {
  const L = theme === "light";
  // the planner's surface colours (planner/palette.ts): the map, the timeline and the legend agree
  const c = {
    paved: L ? "#566476" : "#0c0e0d",
    pavedMajor: L ? "#414d5e" : "#0c0e0d",
    fillMajor: L ? "#d3d5d9" : "#939ca8",
    fillSecondary: L ? "#e6e8eb" : "#838b96",
    fill: L ? "#ffffff" : "#707882",
    gravel: L ? "#c4820f" : "#edb04a",
    ground: L ? "#8a4f2a" : "#cf8a5e",
    unknown: L ? "#77777c" : "#8f8f98",
    pavedPath: L ? "#7b8794" : "#8e98a4",
    halo: L ? "#ffffff" : "#0d0f0e",
  };
  const carto: Carto = {
    ...CARTO[theme],
    ...(L
      ? {
          forest: "#d2e4c2",
          meadow: "#e8efd8",
          farmland: "#f4f1e4",
          buildings: "#d9d5cf",
          water: "#a6d2ee",
          waterway: "#74b3de",
          motorway: "#aab3c0",
          motorwayCasing: "#414d5e",
        }
      : { ...RELIEF_DARK, motorway: "#b9c2ce", motorwayCasing: "#0c0e0d" }),
  };
  return {
    id: "b",
    name: "Surface first",
    carto,
    spec: (k) => {
      const s = shapes(k);
      const bySurface = (paved: string): Expr => [
        "match",
        k.surface,
        0,
        paved,
        1,
        c.gravel,
        2,
        c.ground,
        c.unknown,
      ];
      const base: BaseSpec = {
        track: { color: c.unknown, halo: c.halo, opacity: 0.9 },
        bridge: L ? "#2f3742" : "#dfe3e8",
        tunnel: { veil: carto.land, rail: L ? "#7b8794" : "#7d7f7c" },
        outer: outerWidth(TIER.service),
      };
      const solid = oneOf(k.surface, 0, 1);
      return {
        band: {
          filter: s.road,
          fill: byTier(
            k,
            [
              [8, c.fillMajor],
              [7, c.fillSecondary],
            ],
            c.fill,
          ),
          casing: byTier(k, [[8, c.pavedMajor]], c.paved),
          width: widths(k.tier, BAND, 4),
          casingWidth: widths(k.tier, BAND, 4, CASE),
          sort: k.tier,
        },
        halo: {
          filter: all(not(s.road), k.shown),
          color: c.halo,
          width: widths(k.tier, LINE, 0, HALO, 1.12),
          opacity: 0.9,
        },
        lineWidth: widths(k.tier, LINE, 0, undefined, 1.12),
        lines: [
          { id: "path-solid", filter: all(s.path, solid), color: bySurface(c.pavedPath) },
          { id: "path-ground", filter: all(s.path, eq(k.surface, 2)), color: c.ground, dash: DASH.path },
          { id: "path-unknown", filter: all(s.path, eq(k.surface, 3)), color: c.unknown, dash: DASH.g4 },
          { id: "cycle", filter: s.cycle, color: bySurface(CYCLE[theme]) },
          { id: "track-unknown", filter: all(s.trackish, eq(k.surface, 3)), color: c.unknown, dash: DASH.g4 },
          { id: "track-ground", filter: all(s.trackish, eq(k.surface, 2)), color: c.ground, dash: DASH.g3 },
          { id: "track-gravel", filter: all(s.trackish, eq(k.surface, 1)), color: c.gravel },
        ],
        base,
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// C: quiet base, the rideable network forward
// ---------------------------------------------------------------------------------------------------
function quiet(theme: Theme): Variant {
  const L = theme === "light";
  const c = {
    main: L ? "#dbd7ce" : "#313433",
    mainCasing: L ? "#a39d91" : "#3d403f",
    road: L ? "#ffffff" : "#a3a8aa",
    /** the connecting small roads: the gravel rider's tarmac */
    roadCasing: L ? "#4a443c" : "#0a0c0b",
    street: L ? "#ffffff" : "#5d6163",
    streetCasing: L ? "#aca69b" : "#0a0c0b",
    ink: L ? "#4b3524" : "#f1dfc2",
    inkUnknown: L ? "#8f8275" : "#9a8f80",
    path: L ? "#4d3e31" : "#cdbba2",
    pathPaved: L ? "#8e8a84" : "#7c7f80",
    halo: L ? "#ffffff" : "#0d0f0e",
  };
  const carto: Carto = {
    ...CARTO[theme],
    ...(L
      ? {
          land: "#f5f4f0",
          background: "#ecebe6",
          forest: "#dbe8d1",
          scrub: "#e3ecd9",
          meadow: "#ebf0e0",
          farmland: "#f5f3ea",
          orchard: "#e4edd8",
          park: "#deebd4",
          pitch: "#d9e8cf",
          builtup: "#eeebe6",
          industrial: "#e9e8ea",
          buildings: "#dedad3",
          water: "#bcdcf0",
          waterway: "#8fc3e4",
          hillshadeStrength: 0.2,
          contour: "#b79a78",
          motorway: "#dcd8cf",
          motorwayCasing: "#b5afa3",
          rail: "#a9a9ad",
        }
      : {
          ...RELIEF_DARK,
          land: "#191c1a",
          forest: "#1c2a20",
          meadow: "#1f241d",
          farmland: "#1e1f1b",
          buildings: "#2c2b29",
          hillshadeStrength: 0.24,
          motorway: "#3a3d3c",
          motorwayCasing: "#111312",
          rail: "#55565a",
        }),
  };
  return {
    id: "c",
    name: "Quiet base",
    carto,
    spec: (k) => {
      const s = shapes(k);
      const scale = 1.15;
      const base: BaseSpec = {
        track: { color: c.ink, halo: c.halo, opacity: 0.8 },
        bridge: L ? "#3a2a1b" : "#e6e1d8",
        tunnel: { veil: carto.land, rail: L ? "#8f8275" : "#7d7f7c" },
        outer: outerWidth(TIER.service),
      };
      const track = (id: string, grade: number, dash?: readonly number[]): Line => ({
        id,
        filter: all(s.trackish, eq(k.grade, grade)),
        color: c.ink,
        ...(dash ? { dash } : {}),
      });
      return {
        band: {
          filter: s.road,
          fill: byTier(
            k,
            [
              [[8, 7], c.main],
              [[4, 3], c.street],
            ],
            c.road,
          ),
          casing: byTier(
            k,
            [
              [[8, 7], c.mainCasing],
              [[4, 3], c.streetCasing],
            ],
            c.roadCasing,
          ),
          width: widths(k.tier, BAND, 4),
          casingWidth: widths(k.tier, BAND, 4, CASE),
          // the small roads lie on top of the main roads' grey: they are the foreground here
          sort: pick(k.tier, [[[8, 7], 0]], k.tier),
        },
        halo: {
          filter: all(not(s.road), k.shown),
          color: c.halo,
          width: widths(k.tier, LINE, 0, HALO, scale),
          opacity: 0.9,
        },
        lineWidth: widths(k.tier, LINE, 0, undefined, scale),
        lines: [
          {
            id: "path-paved",
            filter: all(s.path, eq(k.surface, 0)),
            color: c.pathPaved,
            width: widths(k.tier, LINE, 0),
          },
          {
            id: "path",
            filter: all(s.path, not(eq(k.surface, 0))),
            color: ["case", eq(k.surface, 3), c.inkUnknown, c.path],
            dash: DASH.path,
            width: widths(k.tier, LINE, 0, undefined, 1.1),
          },
          { id: "cycle", filter: s.cycle, color: CYCLE[theme] },
          {
            id: "track-unknown",
            filter: all(s.trackish, eq(k.grade, 0)),
            color: c.inkUnknown,
            dash: DASH.unknown,
          },
          track("track-5", 5, DASH.g5),
          track("track-4", 4, DASH.g4),
          track("track-3", 3, DASH.g3),
          track("track-2", 2),
        ],
        base,
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// D: bands, the fill is the roughness
// ---------------------------------------------------------------------------------------------------
function bands(theme: Theme): Variant {
  const L = theme === "light";
  const c = {
    major: L ? "#ffe45e" : "#b9a033",
    majorCasing: L ? "#9c8514" : "#0c0e0d",
    secondary: L ? "#fff1a1" : "#8f8347",
    tertiary: L ? "#ffffff" : "#7b8082",
    road: L ? "#ffffff" : "#686d70",
    roadCasing: L ? "#857f73" : "#0c0e0d",
    /** the ramp: tarmac, compacted, gravel, then the dark line of soft ground */
    g1: L ? "#ffffff" : "#c9ced1",
    g2: L ? "#fbeecb" : "#dcc793",
    g3: L ? "#e2a85a" : "#c48f45",
    soft: L ? "#6f4320" : "#d98f58",
    trackCasing: L ? "#5e3b1b" : "#0c0e0d",
    unknown: L ? "#e6e2da" : "#4c4f50",
    unknownCasing: L ? "#9a9186" : "#8a8d8b",
    path: L ? "#5f4732" : "#c9ad8d",
    pathUnknown: L ? "#a08c78" : "#8d8172",
    pathPaved: L ? "#93897a" : "#8b8f91",
    halo: L ? "#fffdf6" : "#0f1110",
  };
  const carto: Carto = {
    ...CARTO[theme],
    ...(L
      ? { forest: "#cde3ba", meadow: "#e6eed2", buildings: "#d5ccbf", water: "#a6d2ee", waterway: "#74b3de" }
      : RELIEF_DARK),
  };
  return {
    id: "d",
    name: "Bands",
    carto,
    spec: (k) => {
      const s = shapes(k);
      const trackBand = all(s.trackish, oneOf(k.grade, 0, 2, 3));
      const base: BaseSpec = {
        track: { color: c.trackCasing, halo: c.halo, opacity: 0.8 },
        bridge: L ? "#3d342a" : "#d8d2c6",
        tunnel: { veil: carto.land, rail: L ? "#857f73" : "#7d7f7c" },
        outer: outerWidth(TIER.track, 1.15),
      };
      const scale = 1.3;
      // a fine rim: at 2 px the fill has to carry the colour
      const rim: typeof CASE = [0.5, 0.7, 1.0, 1.4, 1.8, 2.2];
      const trackTable = BAND;
      return {
        band: {
          filter: s.road,
          fill: byTier(
            k,
            [
              [8, c.major],
              [7, c.secondary],
              [6, c.tertiary],
              [2, c.g1],
            ],
            c.road,
          ),
          casing: byTier(
            k,
            [
              [8, c.majorCasing],
              [7, c.majorCasing],
              [2, c.trackCasing],
            ],
            c.roadCasing,
          ),
          width: widths(k.tier, BAND, 4, undefined, 1),
          casingWidth: widths(k.tier, BAND, 4, CASE),
          sort: k.tier,
        },
        band2: {
          filter: trackBand,
          fill: ["match", k.grade, 2, c.g2, 3, c.g3, c.unknown] as Color,
          casing: ["match", k.grade, 0, c.unknownCasing, c.trackCasing] as Color,
          width: widths(k.tier, trackTable, 2, undefined, scale),
          casingWidth: widths(k.tier, trackTable, 2, rim, scale),
          sort: k.tier,
        },
        halo: {
          filter: all(not(s.road), not(trackBand), k.shown),
          color: c.halo,
          width: widths(k.tier, LINE, 0, HALO, scale),
          opacity: 0.9,
        },
        lineWidth: widths(k.tier, LINE, 0, undefined, scale),
        lines: [
          {
            id: "path-paved",
            filter: all(s.path, eq(k.surface, 0)),
            color: c.pathPaved,
            width: widths(k.tier, LINE, 0),
          },
          {
            id: "path",
            filter: all(s.path, not(eq(k.surface, 0))),
            color: ["case", eq(k.surface, 3), c.pathUnknown, c.path],
            dash: DASH.path,
            width: widths(k.tier, LINE, 0),
          },
          { id: "cycle", filter: s.cycle, color: CYCLE[theme] },
          { id: "track-5", filter: all(s.trackish, eq(k.grade, 5)), color: c.soft, dash: DASH.g5 },
          { id: "track-4", filter: all(s.trackish, eq(k.grade, 4)), color: c.soft, dash: DASH.g4 },
        ],
        base,
      };
    },
  };
}

export function variant(id: VariantId, theme: Theme): Variant {
  const v = { a: classic, b: surfaceFirst, c: quiet, d: bands }[id](theme);
  return { ...v, carto: { ...v.carto, cycle: CYCLE[theme], cycleRoute: VIOLET_ROUTE[theme] } };
}
