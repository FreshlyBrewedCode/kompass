// The cost layer (cost debug view, docs/map.md): the visible edges coloured by the current profile's
// factor, from the engine's `edgeCosts`. Pure parts here (the scale, how one edge is classified, the
// layers, the key's ticks); the runtime that queries and writes `feature-state` is cost-layer.ts.
//
// - The scale is diverging and logarithmic, centred on factor 1: −1 is the profile's `minFactor`
//   (preferred as far as the clamp allows), +1 its `maxFactor`. Each side is scaled to its own bound,
//   so the colours are symmetric while the factors are not (0.5 … 1 … 20).
// - Per edge the better of the two directions is shown; a chevron points along the cheaper (or the only)
//   direction where they differ.
// - Edges at the clamp are drawn wider: there a stronger slider changes nothing. Closed edges (both
//   directions) are a dashed ink line.
import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";
import type { Manifest } from "./manifest";
import { COST_CLOSED, COST_STOPS, mixHex, SELECTED, type Theme } from "./palette";
import { underlayWidth, wayClasses } from "./ways";

type Expr = ExpressionSpecification;

/** style.ts' `OVERLAY_SOURCE` (not imported: style.ts imports this file). */
const SOURCE = "overlay";

/** Below this zoom the overlay does not carry every edge (ways.ts' `WAYS_MINZOOM`): no cost layer there. */
export const COST_MINZOOM = 13;
/** From here the one-way chevrons show (below they would only be noise). */
export const COST_ARROW_MINZOOM = 15;

export const COST_LINE = "cost-line";
export const COST_CLOSED_LINE = "cost-closed";
export const COST_SELECTED = "cost-selected";
export const COST_ARROW_ALONG = "cost-arrow-along";
export const COST_ARROW_AGAINST = "cost-arrow-against";
/** The band layers (under the ways' lines) and the chevrons (above them). */
export const COST_BAND_LAYERS = [COST_LINE, COST_CLOSED_LINE, COST_SELECTED] as const;
export const COST_ARROW_LAYERS = [COST_ARROW_ALONG, COST_ARROW_AGAINST] as const;

/** What an edge is on the layer (feature-state `ck`). */
export const KIND = { none: 0, open: 1, atMin: 2, atMax: 3, closed: 4 } as const;
export type Kind = (typeof KIND)[keyof typeof KIND];
/** Which direction the chevron points (feature-state `cd`). */
export const DIR = { same: 0, along: 1, against: 2 } as const;
export type Dir = (typeof DIR)[keyof typeof DIR];

/** Directions whose factors differ by less than this ratio count as the same. */
export const DIR_RATIO = 1.1;
const CLAMP_EPS = 1e-4;

/** Position on the scale: −1 at `min`, 0 at factor 1, +1 at `max` (log on each side, clamped). */
export function costPosition(factor: number, min: number, max: number): number {
  if (!(factor > 0)) return 0;
  if (factor < 1) return min < 1 ? -Math.min(1, Math.log(factor) / Math.log(min)) : 0;
  return max > 1 ? Math.min(1, Math.log(factor) / Math.log(max)) : 0;
}

/** The factor at a position of the scale (the inverse of `costPosition`). */
export function factorAt(t: number, min: number, max: number): number {
  return t < 0 ? min ** -t : max ** t;
}

export type EdgeCost = { t: number; kind: Kind; dir: Dir };

/**
 * One edge from `edgeCosts`' two factors (along, against; 0 = that way may not be ridden) and its
 * `closed` code (non-zero only when both are closed).
 */
export function classifyEdge(along: number, against: number, closed: number, min: number, max: number) {
  if (closed !== 0 || (along <= 0 && against <= 0)) return { t: 0, kind: KIND.closed, dir: DIR.same };
  const best = along <= 0 ? against : against <= 0 ? along : Math.min(along, against);
  let dir: Dir = DIR.same;
  if (along <= 0) dir = DIR.against;
  else if (against <= 0) dir = DIR.along;
  else if (Math.max(along, against) / best > DIR_RATIO) dir = along < against ? DIR.along : DIR.against;
  const kind: Kind =
    best <= min * (1 + CLAMP_EPS) ? KIND.atMin : best >= max * (1 - CLAMP_EPS) ? KIND.atMax : KIND.open;
  return { t: costPosition(best, min, max), kind, dir } satisfies EdgeCost;
}

/** A factor as text: `×0.50`, `×1.0`, `×2.4`, `×20`. */
export function formatFactor(factor: number): string {
  if (factor >= 9.95) return `×${Math.round(factor)}`;
  if (factor >= 0.995) return `×${factor.toFixed(1)}`;
  return `×${factor.toFixed(2)}`;
}

/** The colour at a position of the scale (the key's swatches; the map interpolates the same stops). */
export function costColorAt(t: number, theme: Theme): string {
  const stops = COST_STOPS[theme];
  const x = ((Math.max(-1, Math.min(1, t)) + 1) / 2) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return mixHex(stops[i] as string, stops[i + 1] as string, x - i);
}

/** The ticks of the key: the bounds, 1, and a round value in between on each side. */
export function costTicks(min: number, max: number): { t: number; label: string }[] {
  const ticks = [{ t: -1, label: formatFactor(min) }];
  const mid = (f: number) => ({ t: costPosition(f, min, max), label: formatFactor(f) });
  if (min < 0.85) ticks.push(mid(roundNice(Math.sqrt(min))));
  ticks.push({ t: 0, label: "×1" });
  if (max > 3) ticks.push(mid(roundNice(Math.sqrt(max))));
  ticks.push({ t: 1, label: formatFactor(max) });
  return ticks;
}

function roundNice(f: number): number {
  if (f < 1) return Math.round(f * 20) / 20;
  return f < 10 ? Math.round(f * 2) / 2 : Math.round(f);
}

const state = (key: string, fallback: number): Expr => ["to-number", ["feature-state", key], fallback];
const kindIs = (...kinds: Kind[]): Expr => ["in", state("ck", 0), ["literal", kinds]];

/**
 * Width of the band: as wide as the information band (ways.ts' `underlayWidth`), so it shows as a
 * coloured rim around the ways' own fills; edges at the clamp `atClamp` times that.
 */
const width = (manifest: Manifest, weight: number, scale: number, atClamp = scale): Expr =>
  underlayWidth(
    manifest.overlay.attributes,
    atClamp === scale ? scale : 1,
    atClamp === scale ? undefined : ["case", kindIs(KIND.atMin, KIND.atMax), atClamp, scale],
    weight,
  );

/** The colour by feature state: the stops spread evenly over −1 … +1. */
export function costColor(theme: Theme): Expr {
  const stops = COST_STOPS[theme];
  return [
    "interpolate",
    ["linear"],
    state("ct", 0),
    ...stops.flatMap((c, i) => [-1 + (2 * i) / (stops.length - 1), c]),
  ] as Expr;
}

/**
 * The bands (under the ways' lines, like the information layer): every open edge coloured by its
 * factor, those at the clamp wider; the closed ones dashed in ink. Without feature state an edge is
 * not drawn (it is not in the last answer yet).
 */
export function costLayers(
  manifest: Manifest,
  theme: Theme,
  on: boolean,
  /** the line weight (`WEIGHT_SCALE`) */
  weight = 1,
): LayerSpecification[] {
  const source = {
    source: SOURCE,
    "source-layer": manifest.overlay.layer,
    // only what the ways draw: no ferry (a band would draw a ring on the lake), no hidden aisle
    filter: wayClasses(manifest.overlay.attributes).shown as never,
  } as const;
  const visibility = on ? "visible" : "none";
  return [
    {
      id: COST_LINE,
      type: "line",
      ...source,
      minzoom: COST_MINZOOM,
      layout: { "line-cap": "round", "line-join": "round", visibility },
      paint: {
        "line-color": costColor(theme),
        "line-opacity": ["case", kindIs(KIND.open, KIND.atMin, KIND.atMax), 0.92, 0],
        "line-width": width(manifest, weight, 1, 1.55),
      },
    },
    {
      id: COST_CLOSED_LINE,
      type: "line",
      ...source,
      minzoom: COST_MINZOOM,
      layout: { "line-join": "round", visibility },
      paint: {
        "line-color": COST_CLOSED[theme],
        "line-opacity": ["case", kindIs(KIND.closed), 0.85, 0],
        "line-width": width(manifest, weight, 0.7),
        "line-dasharray": [1.2, 0.9],
      },
    },
    {
      // the tapped edge (the region map's `selected` state): an ink outline around its band
      id: COST_SELECTED,
      type: "line",
      ...source,
      minzoom: COST_MINZOOM,
      layout: { "line-cap": "round", "line-join": "round", visibility },
      paint: {
        "line-color": SELECTED[theme],
        "line-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 1, 0],
        "line-width": 2.5,
        "line-gap-width": width(manifest, weight, 1, 1.55),
      },
    },
  ];
}

/**
 * The one-way chevrons above the ways' lines: `›` along the geometry, `‹` against it (general
 * punctuation, in the vendored glyph ranges). Feature state cannot pick a layout's text, hence two
 * layers whose opacity follows `cd`.
 */
export function costArrowLayers(manifest: Manifest, theme: Theme, on: boolean): LayerSpecification[] {
  const make = (id: string, glyph: string, dir: Dir): LayerSpecification => ({
    id,
    type: "symbol",
    source: SOURCE,
    "source-layer": manifest.overlay.layer,
    minzoom: COST_ARROW_MINZOOM,
    layout: {
      visibility: on ? "visible" : "none",
      "symbol-placement": "line",
      "symbol-spacing": 70,
      "text-field": glyph,
      "text-font": ["Noto Sans Medium"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 15, 15, 18, 22],
      "text-keep-upright": false,
      "text-rotation-alignment": "map",
      "text-allow-overlap": true,
      "text-ignore-placement": true,
      "text-padding": 0,
    },
    paint: {
      "text-color": COST_CLOSED[theme],
      "text-halo-color": theme === "light" ? "#ffffff" : "#0a0a0a",
      "text-halo-width": 1.4,
      "text-opacity": [
        "case",
        ["all", ["==", state("cd", 0), dir], kindIs(KIND.open, KIND.atMin, KIND.atMax)],
        0.95,
        0,
      ],
    },
  });
  return [make(COST_ARROW_ALONG, "›", DIR.along), make(COST_ARROW_AGAINST, "‹", DIR.against)];
}
