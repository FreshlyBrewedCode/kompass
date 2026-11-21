// The cost debug view in words (docs/planner.md, "Cost"): what `explainEdge` and `compare` mean for a
// rider. Pure functions, no React: the tap panel's verdict and rows, the "why not through here?"
// headline, its diagnosis and the stretch summaries.
import type {
  AdditiveKind,
  ArcCostExplanation,
  Catalogue,
  ClosedBy,
  Closure,
  EdgeExplanation,
  PrefId,
  PrefPart,
  Reason,
  RouteComparison,
  RouteResult,
  StretchComparison,
  StretchCost,
  WayKind,
} from "@/engine/generated/types";
import { DIR_RATIO, formatFactor } from "@/map/cost";
import { noun } from "../model";

/** Factors this close to 1 are "neutral" in words (the colour is the grey of the scale's middle). */
export const NEUTRAL = 0.03;
/** A preference whose factor is this close to 1 has no effect worth a row. */
const NO_EFFECT = 0.005;

export type Tone = "preferred" | "neutral" | "avoided" | "closed";

export type Verdict = {
  tone: Tone;
  /** the factor of the better direction (`null`: closed both ways) */
  factor: number | null;
  /** the verdict in plain words, first */
  title: string;
  /** what the clamp, the additive terms or the other direction add (empty: nothing) */
  notes: string[];
};

const WAY_NAME: Record<WayKind, string> = {
  main_road: "Main road",
  country_road: "Country road",
  residential: "Residential street",
  service: "Service road",
  track: "Track",
  path: "Path",
  bike_path: "Bike path",
  bike_path_roadside: "Bike path beside a road",
  steps: "Steps",
  ferry: "Ferry",
  other: "Way",
};
export const wayName = (w: WayKind) => WAY_NAME[w];

/** What closes a way, by name (the catalogue's limit labels, plus the rules that hold always). */
export function closureName(by: ClosedBy, catalogue: Catalogue | null): string {
  if (by === "no_bikes") return "no bicycles allowed";
  if (by === "oneway") return "one-way";
  const label = catalogue?.limits.find((l) => l.id === by)?.label ?? by.replace(/_/g, " ");
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** The tag behind a closure as OSM-ish text: `access=agricultural`, `grade=16 %`. */
export function closureTag(c: Closure): string {
  const key =
    {
      bike_access: "access",
      motor_access: "motor access",
      oneway_bike: "oneway",
      tamed_grade_pct: "grade",
      surface_guess: "surface (guessed)",
      surface_class: "surface",
      highway: "highway",
    }[c.attribute] ?? c.attribute.replace(/_/g, " ");
  const value =
    typeof c.value === "number"
      ? `${Math.round(c.value * 10) / 10}${c.attribute.endsWith("_pct") ? " %" : ""}`
      : String(c.value).replace(/_/g, " ");
  return `${key}=${value}`;
}

/**
 * A preference as a word in a sentence: what it rewards or punishes here. `alongside`: the edge's
 * traffic is the road's beside it (a path along a busy road), not its own.
 */
export function prefNoun(id: PrefId, factor: number, alongside = false): string {
  if (id === "quiet") return factor > 1 ? (alongside ? "traffic alongside" : "traffic") : "quiet";
  if (id === "climb") return "climbing";
  if (id === "built") return "built-up";
  return noun(id);
}

export const isOpen = (arc: ArcCostExplanation) => arc.closed_by.length === 0;

/** How strongly a preference acts on this arc (a gated bonus only through the gate). */
export function effect(p: PrefPart, gate: number): number {
  const strength = Math.abs(Math.log(p.factor));
  return p.role === "gated_bonus" && p.factor < 1 ? strength * gate : strength;
}

/** The arc a rider would take: the open one with the lower factor (along on a tie). */
export function betterArc(x: EdgeExplanation): ArcCostExplanation | null {
  const open = [x.along, x.against].filter(isOpen);
  if (open.length === 0) return null;
  return open.reduce((a, b) => (b.factor < a.factor ? b : a));
}

/** The preferences that act on an arc, strongest first, and those that have no effect here. */
export function prefRowsOf(arc: ArcCostExplanation): { active: PrefPart[]; idle: PrefPart[] } {
  const acting = (p: PrefPart) => Math.abs(p.factor - 1) > NO_EFFECT;
  return {
    active: arc.preferences.filter(acting).sort((a, b) => effect(b, arc.gate) - effect(a, arc.gate)),
    idle: arc.preferences.filter((p) => !acting(p)),
  };
}

const list = (words: string[]) =>
  words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

const ADDITIVE: Record<AdditiveKind, string> = {
  climb: "climbing",
  barriers: "barriers",
  steps: "carrying up steps",
  dismount: "walking",
  ferry: "waiting for the ferry",
};

export const metresText = (m: number) =>
  m >= 995 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(0, Math.round(m))} m`;

/** The verdict of one edge, in plain words: why the router likes it, avoids it or never takes it. */
export function edgeVerdict(x: EdgeExplanation, catalogue: Catalogue | null): Verdict {
  const best = betterArc(x);
  if (!best) {
    // closed both ways: the first closure in check order names it, the rest follow
    const all = dedupe([...x.along.closed_by, ...x.against.closed_by]);
    const [first, ...rest] = all;
    const named = (c: Closure) => `${closureName(c.by, catalogue)} (${closureTag(c)})`;
    return {
      tone: "closed",
      factor: null,
      title: first ? `Closed: ${named(first)}` : "Closed",
      notes: rest.length > 0 ? [`Also closed by ${list(rest.map(named))}.`] : [],
    };
  }
  const f = best.factor;
  const { active } = prefRowsOf(best);
  const notes: string[] = [];
  const alongside = x.traffic_from === "alongside";
  const noun = (p: PrefPart) => prefNoun(p.id, p.factor, alongside);
  const words = (sign: 1 | -1, n = 2) =>
    active
      .filter((p) => (sign < 0 ? p.factor < 1 : p.factor > 1))
      .slice(0, n)
      .map(noun);
  let tone: Tone;
  let title: string;
  if (best.clamp === "min") {
    tone = "preferred";
    title = `Preferred ${formatFactor(f)}, held by the detour limit`;
    notes.push(
      `Without the limit it would be ${formatFactor(best.raw_factor)}: seeking more of ${list(words(-1)) || "this"} changes nothing here.`,
    );
  } else if (best.clamp === "max") {
    tone = "avoided";
    title = `Avoided ${formatFactor(f)}, at the profile's ceiling`;
    notes.push(`${formatFactor(best.raw_factor)} before the ceiling: ${list(words(1)) || "its penalties"}.`);
  } else if (f < 1 - NEUTRAL) {
    tone = "preferred";
    title = `Preferred ${formatFactor(f)}: ${list(words(-1)) || "its bonuses"}`;
  } else if (f > 1 + NEUTRAL) {
    tone = "avoided";
    title = `Avoided ${formatFactor(f)}: ${list(words(1)) || "its penalties"}`;
  } else {
    tone = "neutral";
    title =
      active.length === 0
        ? `Neutral ${formatFactor(f)}: nothing in this profile applies`
        : `Neutral ${formatFactor(f)}: ${list(active.slice(0, 2).map(noun))} about cancel out`;
  }
  const quiet = best.preferences.find((p) => p.id === "quiet");
  if (alongside && quiet && quiet.factor > 1 + NO_EFFECT)
    notes.push(
      `Traffic from the motor road alongside (within 20 m): level ${Math.round(x.traffic * 100)} %.`,
    );
  if (best.gate < 0.999 && best.bonus < 0.999)
    notes.push(
      `The landscape bonuses count only ${Math.round(best.gate * 100)} %: the way itself is not good enough for them.`,
    );
  if (best.extra_m > 0.5)
    notes.push(
      `Plus ${metresText(best.extra_m)} on top for ${list(best.additive.map((a) => ADDITIVE[a.kind]))}.`,
    );
  const other = best === x.along ? x.against : x.along;
  if (!isOpen(other)) {
    const c = other.closed_by[0];
    notes.push(
      c?.by === "oneway"
        ? "One-way: only this direction may be ridden."
        : `Only one direction: the other is closed (${c ? closureName(c.by, catalogue) : "closed"}).`,
    );
  } else if (other.factor / f > DIR_RATIO) {
    notes.push(
      `The other direction costs ${formatFactor(other.factor)}${other.ascent_m > best.ascent_m + 1 ? " (uphill)" : ""}.`,
    );
  }
  return { tone, factor: f, title, notes };
}

function dedupe(closures: Closure[]): Closure[] {
  const seen = new Set<ClosedBy>();
  return closures.filter((c) => {
    if (seen.has(c.by)) return false;
    seen.add(c.by);
    return true;
  });
}

/**
 * How a preference row reads its role: "bonus, counts 60 %" for a gated bonus through a part gate;
 * "road alongside" for traffic that comes from the road beside the way.
 */
export function roleText(p: PrefPart, gate: number, alongside = false): string {
  if (p.id === "quiet" && alongside && p.factor > 1) return "road alongside";
  if (p.role === "gated_bonus") return gate < 0.999 ? `bonus, counts ${Math.round(gate * 100)} %` : "bonus";
  if (p.role === "gated_penalty") return "penalty";
  if (p.role === "additive") return "metres on top";
  return "";
}

// ---------------------------------------------------------------- "why not through here?"

export type Side = {
  /** this route has nothing here (the other one makes a spur) */
  empty: boolean;
  length: string;
  /** what the router counts it as: "counts as 1.4 km" */
  cost: string;
  factor: string;
  /** the strongest preferences, with their factors: "gravel ×0.69, tracks ×0.90" */
  reasons: string;
  /** the main kind of way: "mostly track" */
  ways: string;
  /** share of the length at the lower clamp, 0..1 */
  atMin: number;
  /** "0.3 km closed: legal access only" (empty: none) */
  closed: string;
};

export type StretchSummary = {
  planned: Side;
  through: Side;
  /** "320 m longer, costs 18 % more here" */
  delta: string;
  costDelta: number;
};

export type WhyNot = {
  /** one line on top */
  headline: string;
  /** the diagnosis: why no slider can change it, closures, the clamp (empty: none stands out) */
  hints: string[];
  /** the stretches where the routes part, the most expensive difference first */
  stretches: StretchSummary[];
};

const pct = (x: number) => `${Math.round(Math.abs(x) * 100)} %`;

function reasonsText(why: Reason[], n = 2): string {
  return why
    .filter((r) => Math.abs(r.factor - 1) > 0.01)
    .slice(0, n)
    .map((r) => `${prefNoun(r.id, r.factor)} ${formatFactor(r.factor)}`)
    .join(", ");
}

function waysText(s: StretchCost): string {
  const top = s.ways[0];
  if (!top || s.span.length_m <= 0) return "";
  const name = WAY_NAME[top.key].toLowerCase();
  return top.share >= 0.6 ? `mostly ${name}` : `${name} and more`;
}

export function side(s: StretchCost, catalogue: Catalogue | null): Side {
  const closedM = s.closed.reduce((a, c) => a + c.length_m, 0);
  return {
    empty: s.span.length_m <= 0,
    length: metresText(s.span.length_m),
    cost: `counts as ${metresText(s.cost)}`,
    factor: formatFactor(s.factor),
    reasons: reasonsText(s.why),
    ways: waysText(s),
    atMin: s.span.length_m > 0 ? s.clamped_min_m / s.span.length_m : 0,
    closed:
      closedM > 0
        ? `${metresText(closedM)} closed: ${list(s.closed.map((c) => closureName(c.by, catalogue)))}`
        : "",
  };
}

function deltaText(lengthDelta: number, costDelta: number, base: number, where: string): string {
  const length =
    Math.abs(lengthDelta) < 50
      ? "about as long"
      : `${metresText(Math.abs(lengthDelta))} ${lengthDelta > 0 ? "longer" : "shorter"}`;
  // the planned side may be empty (through here is a spur off the planned line): metres, not a share
  const rel = base > 0 ? costDelta / base : null;
  const cost =
    rel === null
      ? `adds ${metresText(costDelta)} of cost${where}`
      : Math.abs(rel) < 0.005
        ? "costs about the same"
        : `costs ${pct(rel)} ${costDelta > 0 ? "more" : "less"}${where}`;
  return `${length}, ${cost}`;
}

/** One side as a clause: "1.4 km, mostly track, at ×0.81 (gravel ×0.69, soft ground ×1.2)". */
export function sideClause(s: Side): string {
  return `${s.length}${s.ways ? `, ${s.ways},` : ""} at ${s.factor}${s.reasons ? ` (${s.reasons})` : ""}`;
}

/**
 * "Why not through here?" in words. `minFactor`: the profile's lower bound, for the diagnosis: a
 * stretch that would still cost more if every metre of it were at the bound cannot be won by sliders.
 */
export function whyNot(c: RouteComparison, minFactor: number, catalogue: Catalogue | null): WhyNot {
  const stretches = [...c.stretches]
    .filter((s) => s.a.span.length_m > 0 || s.b.span.length_m > 0)
    .sort((x, y) => y.cost_delta - x.cost_delta);
  if (stretches.length === 0)
    return { headline: "Through here is the planned route already.", hints: [], stretches: [] };
  const dCost = c.b.cost - c.a.cost;
  const dLength = c.b.span.length_m - c.a.span.length_m;
  const rel = c.a.cost > 0 ? dCost / c.a.cost : 0;
  let headline: string;
  if (rel < -0.005)
    headline = `Through here is ${metresText(Math.abs(dLength))} ${dLength > 0 ? "longer" : "shorter"} and costs ${pct(rel)} less: the planned route is not the cheapest here.`;
  else if (rel < 0.005) headline = "Through here costs about the same: the router could take either.";
  else
    headline = `Through here is ${deltaText(dLength, dCost, c.a.cost, "")}: the router keeps the planned line.`;

  const hints: string[] = [];
  const main = stretches[0] as StretchComparison;
  const closed = stretches.flatMap((s) => s.b.closed);
  if (closed.length > 0) {
    const m = closed.reduce((a, x) => a + x.length_m, 0);
    const names = [...new Set(closed.map((x) => closureName(x.by, catalogue)))];
    hints.push(
      `${metresText(m)} of the way through here is closed (${list(names)}): the router never takes it on its own.`,
    );
  }
  if (main.cost_delta > 0) {
    const b = main.b;
    const floor = b.span.length_m * minFactor + b.extra_m;
    if (main.a.span.length_m <= 0)
      hints.push(
        `No slider can change this: through here is a detour off the planned line, and even at the detour limit (${formatFactor(minFactor)}) it adds ${metresText(floor)}.`,
      );
    else if (floor >= main.a.cost)
      hints.push(
        `No slider can change this: even if all of it counted at the detour limit (${formatFactor(minFactor)}), the way through here would still cost more than the planned ${metresText(main.a.span.length_m)}.`,
      );
    else {
      const atMinA = main.a.span.length_m > 0 ? main.a.clamped_min_m / main.a.span.length_m : 0;
      const atMinB = b.span.length_m > 0 ? b.clamped_min_m / b.span.length_m : 0;
      const limit = formatFactor(minFactor);
      if (atMinA >= 0.4 && atMinB >= 0.4)
        hints.push(
          `Both sides sit largely at the detour limit (${limit}: planned ${pct(atMinA)}, through here ${pct(atMinB)}): on those parts the profile cannot tell them apart, only length counts.`,
        );
      else if (atMinB >= 0.4)
        hints.push(
          `${pct(atMinB)} of the way through here is already at the detour limit (${limit}): seeking it harder changes nothing there.`,
        );
      else if (atMinA >= 0.4)
        hints.push(
          `The planned stretch is at the detour limit on ${pct(atMinA)}: as cheap as this profile lets a way be.`,
        );
    }
    const a = main.a;
    if (a.span.length_m > 0 && Math.abs(a.factor - 1) <= NEUTRAL)
      hints.push(
        `The planned stretch is neutral ${formatFactor(a.factor)}: nothing in the profile counts against it.`,
      );
  }
  return {
    headline,
    hints,
    stretches: stretches.map((s) => ({
      planned: side(s.a, catalogue),
      through: side(s.b, catalogue),
      delta: deltaText(s.length_delta_m, s.cost_delta, s.a.cost, " here"),
      costDelta: s.cost_delta,
    })),
  };
}

/**
 * The box `[west, south, east, north]` around the stretches where two routes part (both sides), from
 * the routes' geometry: what the map shows of a comparison. `null` without geometry or stretches.
 */
export function partedBounds(
  c: RouteComparison,
  a: RouteResult,
  b: RouteResult,
): [number, number, number, number] | null {
  const box = [180, 90, -180, -90];
  let any = false;
  const add = (r: RouteResult, [first, end]: [number, number]) => {
    const coords = r.geometry?.coordinates;
    if (!coords || end <= first) return;
    const from = r.arc_vertex[first] ?? 0;
    const to = end < r.arc_vertex.length ? (r.arc_vertex[end] ?? coords.length - 1) : coords.length - 1;
    for (let i = from; i <= to && i < coords.length; i++) {
      const [x, y] = coords[i] as [number, number];
      box[0] = Math.min(box[0] as number, x);
      box[1] = Math.min(box[1] as number, y);
      box[2] = Math.max(box[2] as number, x);
      box[3] = Math.max(box[3] as number, y);
      any = true;
    }
  };
  for (const s of c.stretches) {
    add(a, s.a.span.arcs);
    add(b, s.b.span.arcs);
  }
  return any ? (box as [number, number, number, number]) : null;
}
