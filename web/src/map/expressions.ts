// Pure builders: manifest attribute + mode + theme → MapLibre style expressions and the legend.
// No MapLibre runtime here (types only), so `bun test` covers it.
import type { ExpressionSpecification } from "maplibre-gl";
import type { OverlayAttribute } from "./manifest";
import { CASING, categoryColor, EXPLORED, sequential, type Theme, UNKNOWN } from "./palette";

export type MapMode = "plain" | "attribute" | "explored";
export const MAP_MODES: readonly MapMode[] = ["plain", "attribute", "explored"];

type Color = ExpressionSpecification | string;

/** An enum value that means "no information" (OSM gaps are information here: they get the neutral colour). */
export function isUnknownLabel(label: string): boolean {
  return label.trim().toLowerCase() === "unknown";
}

// ---------------------------------------------------------------- attribute colours

/** The data-driven `line-color` for one attribute. Unknown and missing values get the neutral colour. */
export function attributeColor(attribute: OverlayAttribute, theme: Theme): ExpressionSpecification {
  const unknown = UNKNOWN[theme];
  const get: ExpressionSpecification = ["get", attribute.key];
  if (attribute.kind === "enum") {
    const colors = enumColors(attribute);
    const arms: (number | string)[] = [];
    for (const { value, color } of colors) arms.push(value, color);
    // `match` needs at least one arm; an enum without any known value is all-unknown anyway
    if (arms.length === 0) return ["literal", unknown] as unknown as ExpressionSpecification;
    return ["match", get, ...arms, unknown] as ExpressionSpecification;
  }
  const [min, max] = rampDomain(attribute);
  const ramp = sequential(theme);
  const stops: (number | string)[] = [];
  for (const [i, color] of ramp.entries()) stops.push(min + ((max - min) * i) / (ramp.length - 1), color);
  return [
    "case",
    ["==", ["typeof", get], "number"],
    ["interpolate", ["linear"], get, ...stops],
    unknown,
  ] as ExpressionSpecification;
}

function rampDomain(attribute: Exclude<OverlayAttribute, { kind: "enum" }>): [number, number] {
  return attribute.kind === "share" ? [0, attribute.max] : [attribute.min, attribute.max];
}

/** Value → colour for an enum, the unknown codes excluded (they fall through to the neutral colour). */
function enumColors(attribute: Extract<OverlayAttribute, { kind: "enum" }>) {
  const out: { value: number; label: string; color: string }[] = [];
  let hue = 0;
  for (const { value, label } of attribute.values) {
    if (isUnknownLabel(label)) continue;
    out.push({ value, label, color: categoryColor(hue++) });
  }
  return out;
}

// ---------------------------------------------------------------- legend

export type LegendEntry = { color: string; label: string; neutral?: boolean };
export type Legend =
  | { kind: "categories"; title: string; entries: LegendEntry[] }
  | { kind: "ramp"; title: string; stops: string[]; min: string; max: string; unknown: LegendEntry };

export function legendFor(attribute: OverlayAttribute, theme: Theme): Legend {
  const unknown = { color: UNKNOWN[theme], label: "Unknown", neutral: true };
  if (attribute.kind === "enum") {
    const colored = new Map(enumColors(attribute).map((e) => [e.value, e]));
    const entries: LegendEntry[] = [];
    let hasUnknown = false;
    for (const { value, label } of attribute.values) {
      const known = colored.get(value);
      if (known) entries.push({ color: known.color, label });
      else {
        hasUnknown = true;
      }
    }
    // unknown codes collapse into one entry, last; an attribute can also lack a value on an edge
    entries.push(hasUnknown ? { ...unknown, label: "Unknown" } : { ...unknown, label: "No value" });
    return { kind: "categories", title: attribute.label, entries };
  }
  const [min, max] = rampDomain(attribute);
  return {
    kind: "ramp",
    title: attribute.label,
    stops: sequential(theme),
    min: attribute.kind === "share" ? "0%" : formatNumber(min, attribute.unit),
    max: attribute.kind === "share" ? "100%" : formatNumber(max, attribute.unit),
    unknown: { ...unknown, label: "No value" },
  };
}

function formatNumber(value: number, unit?: string): string {
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
  if (unit === undefined) return text;
  return unit === "%" ? `${text}%` : `${text} ${unit}`;
}

/** A raw tile property as text, for the inspect panel: enum codes by label, shares as a percentage. */
export function formatAttribute(attribute: OverlayAttribute, raw: unknown): string {
  if (raw === null || raw === undefined) return "no value";
  if (typeof raw !== "number") return String(raw);
  switch (attribute.kind) {
    case "enum":
      return attribute.values.find((v) => v.value === raw)?.label ?? `code ${raw}`;
    case "share":
      return `${Math.round((raw / attribute.max) * 100)}%`;
    case "number":
      return formatNumber(raw, attribute.unit);
  }
}

// ---------------------------------------------------------------- overlay paint

/** Line width by zoom, z8 … z18 (the overlay stops at z14 and overzooms; lines keep growing). */
export const WIDTH_STOPS: readonly (readonly [zoom: number, width: number])[] = [
  [8, 0.5],
  [10, 0.8],
  [12, 1.4],
  [14, 2.4],
  [16, 4.2],
  [18, 7],
];
/** The casing is this much wider than the line (total, both sides). */
const CASING_EXTRA = 1.4;

const RIDDEN: ExpressionSpecification = ["boolean", ["feature-state", "ridden"], false];

function zoomInterpolate(width: (base: number) => number | ExpressionSpecification): ExpressionSpecification {
  const stops: (number | ExpressionSpecification)[] = [];
  for (const [zoom, base] of WIDTH_STOPS) stops.push(zoom, width(base));
  return ["interpolate", ["linear"], ["zoom"], ...stops] as ExpressionSpecification;
}

export type OverlayPaint = {
  visible: boolean;
  lineColor: Color;
  lineOpacity: number | ExpressionSpecification;
  lineWidth: number | ExpressionSpecification;
  casingColor: string;
  casingOpacity: number | ExpressionSpecification;
  casingWidth: number | ExpressionSpecification;
};

export type OverlayState = { mode: MapMode; attribute?: OverlayAttribute | undefined };

/** The paint of the overlay layers for a mode. `plain` hides the overlay. */
export function overlayPaint(state: OverlayState, theme: Theme): OverlayPaint {
  const casingColor = CASING[theme];
  const base = {
    casingColor,
    lineOpacity: 1,
    lineWidth: zoomInterpolate((w) => w),
    casingOpacity: 0.7,
    casingWidth: zoomInterpolate((w) => w + CASING_EXTRA),
  };
  if (state.mode === "attribute" && state.attribute) {
    return { ...base, visible: true, lineColor: attributeColor(state.attribute, theme) };
  }
  if (state.mode === "explored") {
    const colors = EXPLORED[theme];
    return {
      visible: true,
      lineColor: ["case", RIDDEN, colors.ridden, colors.never],
      // never ridden recedes: thinner, translucent, no halo; ridden is wider and opaque
      lineOpacity: ["case", RIDDEN, 1, 0.55],
      lineWidth: zoomInterpolate((w) => ["case", RIDDEN, w * 1.5, w * 0.75] as ExpressionSpecification),
      casingColor,
      casingOpacity: ["case", RIDDEN, 0.7, 0],
      casingWidth: zoomInterpolate(
        (w) => ["case", RIDDEN, w * 1.5 + CASING_EXTRA, w * 0.75] as ExpressionSpecification,
      ),
    };
  }
  return { ...base, visible: false, lineColor: UNKNOWN[theme] };
}
