// Information on demand: one layer at a time that highlights edges *on top of* the readable map.
// An attribute layer does not paint every edge: each attribute has a default for what is worth
// showing (`RULES`), everything else stays the normal map. Pure builders (attribute + theme →
// filter, colours, legend); no MapLibre runtime, so `bun test` covers it.
import type { ExpressionSpecification } from "maplibre-gl";
import type { EnumAttribute, OverlayAttribute } from "./manifest";
import { categoryColor, sequential, type Theme, UNKNOWN } from "./palette";

type Expr = ExpressionSpecification;

/** What the map shows on top of the base style. */
export type InfoLayer =
  | { kind: "none" }
  /** ridden edges highlighted (the explored map) */
  | { kind: "explored" }
  /** every visible edge coloured by the profile's cost factor (cost.ts) */
  | { kind: "cost" }
  | { kind: "attribute"; attribute: OverlayAttribute };

export type MapLayers = {
  info: InfoLayer;
  /** hillshade and contour lines (when the region has terrain) */
  terrain: boolean;
  /** the halo of signed cycle routes */
  routes: boolean;
};

/** An enum value that means "no information" (OSM gaps are information here: they get the neutral colour). */
export function isUnknownLabel(label: string): boolean {
  return label.trim().toLowerCase() === "unknown";
}

/** An enum label as text: the schema's `paved_rough` reads "paved rough". */
export const pretty = (label: string) => label.replace(/_/g, " ");
const normalise = (label: string) =>
  label
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

/** The default of one attribute: what its layer leaves out, and from which zoom it draws. */
type Rule = {
  /** enum labels not highlighted (the ordinary case: "paved", "none", "yes") */
  hide?: readonly string[];
  /** the enum's values are a scale (best to worst): a sequential ramp instead of categorical hues */
  ordered?: boolean;
  /** enum: a colour per label, where the hues should mean something (else categorical or the ramp) */
  colors?: Readonly<Record<string, string>>;
  /** share / number: only values from here on are drawn (a share: fraction of its maximum) */
  from?: number;
  minzoom?: number;
};

/**
 * Per attribute key (the pipeline's `schema.OVERLAY`). An attribute without a rule shows every value
 * (an enum) or every non-zero value (a share or number).
 */
export const RULES: Record<string, Rule> = {
  // the gravel question: where is it not smooth asphalt, and where does nobody know
  // the warmer, the rougher; cobbles are their own (blue) thing
  surface_class: {
    hide: ["paved_smooth"],
    colors: {
      paved_rough: "#5a7fc4",
      compacted: "#e9c46a",
      gravel: "#f2a25c",
      soft: "#de7558",
      other: "#a583d6",
    },
  },
  tracktype: { hide: ["unknown"], ordered: true },
  smoothness: { hide: ["unknown"], ordered: true },
  // the doubtful ones; ordinary access is the normal map
  bike_access: { hide: ["implicit", "yes"] },
  motor_access: { hide: ["unknown", "yes"] },
  cycleway_kind: { hide: ["none"] },
  route_level: { hide: ["none"], ordered: true, minzoom: 9 },
  oneway_bike: { hide: ["both"] },
  mtb_scale: { hide: ["unknown"], ordered: true },
  trail_visibility: { hide: ["unknown"], ordered: true },
  forest_share: { from: 0.5 },
  forest_edge_share: { from: 0.3 },
  water_share: { from: 0.2 },
  builtup_share: { from: 0.5 },
  road_near_share: { from: 0.2, minzoom: 12 },
  grade_max: { from: 6 },
};
const DEFAULT_MINZOOM = 11;

export type LegendEntry = { color: string; label: string; neutral?: boolean };
export type Legend = { title: string; note: string } & (
  | { kind: "categories"; entries: LegendEntry[] }
  | { kind: "ramp"; stops: string[]; min: string; max: string }
);

export type InfoSpec = {
  /** the edges the layer draws */
  filter: Expr;
  color: Expr | string;
  minzoom: number;
  legend: Legend;
};

function enumSpec(attribute: EnumAttribute, theme: Theme, rule: Rule): InfoSpec {
  const hidden = new Set((rule.hide ?? []).map(normalise));
  const shown = attribute.values.filter((v) => !hidden.has(normalise(v.label)));
  const known = shown.filter((v) => !isUnknownLabel(v.label));
  const ramp = sequential(theme);
  const colorOf = (index: number) =>
    rule.colors?.[normalise((known[index] as { label: string }).label)] ??
    (rule.ordered
      ? (ramp[Math.round((index * (ramp.length - 1)) / Math.max(1, known.length - 1))] as string)
      : categoryColor(index));
  const entries: LegendEntry[] = known.map((v, i) => ({ color: colorOf(i), label: pretty(v.label) }));
  const arms = known.flatMap((v, i) => [v.value, colorOf(i)]);
  if (shown.length > known.length) entries.push({ color: UNKNOWN[theme], label: "Unknown", neutral: true });
  const get: Expr = ["get", attribute.key];
  const left = attribute.values.filter((v) => hidden.has(normalise(v.label))).map((v) => v.label);
  return {
    filter:
      shown.length > 0 ? ["in", get, ["literal", shown.map((v) => v.value)]] : (["literal", false] as Expr),
    color: arms.length > 0 ? (["match", get, ...arms, UNKNOWN[theme]] as Expr) : UNKNOWN[theme],
    minzoom: rule.minzoom ?? DEFAULT_MINZOOM,
    legend: {
      kind: "categories",
      title: attribute.label,
      entries,
      note: left.length > 0 ? `Not highlighted: ${left.map(pretty).join(", ")}` : "",
    },
  };
}

function rampSpec(attribute: Exclude<OverlayAttribute, EnumAttribute>, theme: Theme, rule: Rule): InfoSpec {
  const share = attribute.kind === "share";
  const max = attribute.max;
  const min = share ? 0 : attribute.min;
  const from = rule.from === undefined ? undefined : share ? rule.from * max : rule.from;
  const low = from ?? min;
  const ramp = sequential(theme);
  const stops = ramp.flatMap((color, i) => [low + ((max - low) * i) / (ramp.length - 1), color]);
  const get: Expr = ["get", attribute.key];
  const value: Expr = ["to-number", get, min];
  const text = (v: number) =>
    share ? `${Math.round((v / max) * 100)}%` : formatNumber(v, (attribute as { unit?: string }).unit);
  return {
    // missing values are never drawn: the layer shows where something *is*
    filter: ["all", ["has", attribute.key], from === undefined ? [">", value, min] : [">=", value, from]],
    color: ["interpolate", ["linear"], value, ...stops] as Expr,
    minzoom: rule.minzoom ?? DEFAULT_MINZOOM,
    legend: {
      kind: "ramp",
      title: attribute.label,
      stops: ramp,
      min: from === undefined ? `> ${text(min)}` : text(from),
      max: text(max),
      note: from === undefined ? "" : `Only from ${text(from)} on`,
    },
  };
}

/** The defaults of an attribute's information layer: which edges, which colours, the legend. */
export function infoSpec(attribute: OverlayAttribute, theme: Theme): InfoSpec {
  const rule = RULES[attribute.key] ?? {};
  return attribute.kind === "enum" ? enumSpec(attribute, theme, rule) : rampSpec(attribute, theme, rule);
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
      return pretty(attribute.values.find((v) => v.value === raw)?.label ?? `code ${raw}`);
    case "share":
      return `${Math.round((raw / attribute.max) * 100)}%`;
    case "number":
      return formatNumber(raw, attribute.unit);
  }
}

/** The query-string name of a layer (`?layer=`): `none`, `explored`, `cost` or an attribute key. */
export function infoLayerName(info: InfoLayer): string {
  return info.kind === "attribute" ? info.attribute.key : info.kind;
}

export function infoLayerFromName(name: string | null, attributes: readonly OverlayAttribute[]): InfoLayer {
  if (name === "explored") return { kind: "explored" };
  if (name === "cost") return { kind: "cost" };
  const attribute = attributes.find((a) => a.key === name);
  return attribute ? { kind: "attribute", attribute } : { kind: "none" };
}
