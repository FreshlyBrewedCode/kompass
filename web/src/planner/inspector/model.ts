// The segment inspector in words (docs/planner.md, "The segment inspector"): why the route uses a way,
// why it does not, and what could apply there. Pure functions over `explainEdge` and `compare`, no React:
// the headline as an exchange rate, the three groups of lines, the verdict of "why not this", and the
// little geometry the map needs (where on the way "through here" goes).
import type {
  AdditiveKind,
  ArcCostExplanation,
  Catalogue,
  EdgeExplanation,
  LimitId,
  PrefId,
  PrefPart,
  RouteComparison,
} from "@/engine/generated/types";
import { formatFactor } from "@/map/cost";
import { isOpen, metresText, NEUTRAL } from "../cost/model";
import type { Weights } from "../model";

/** A preference whose factor is this close to 1 has no effect worth a line. */
const NO_EFFECT = 0.005;
/** Memberships are fifteenths: anything below half of one is none. */
const NO_MATCH = 1 / 30;

const signed = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0");
const pct = (x: number) => `${Math.round(Math.abs(x) * 100)} %`;

/** The way the inspector shows: its edge, where it was pressed, and the point halfway along it. */
export type InspectTarget = {
  id: number;
  /** where the press was, `[lon, lat]` */
  at: [number, number];
  /** on the way (halfway along the piece pressed): what "why not this" routes through */
  point: [number, number];
};

/** A multiplier in words: "0.63×", "1.6×", "12×". */
export function times(f: number): string {
  if (f >= 9.95) return `${Math.round(f)}×`;
  if (f >= 0.995) return `${f.toFixed(1)}×`;
  return `${f.toFixed(2)}×`;
}

/** What a factor is worth to a rider: the detour a bonus buys, or how far the router goes to avoid it. */
export function exchange(rate: number): string {
  if (rate < 1 - NEUTRAL) return `worth a detour of up to ${times(1 / rate)}`;
  if (rate > 1 + NEUTRAL) return `a way up to ${times(rate)} as long would win against it`;
  return "neutral: it counts as long as it is";
}

// ---------------------------------------------------------------- the headline

export type Headline = {
  /** "Counts as 0.63× its length" (closed: "Closed: …") */
  title: string;
  /** "420 m count as 265 m: worth a detour of up to 1.6×." */
  rate: string;
  /** what the router pays per metre, the additive terms included (`null`: closed) */
  perM: number | null;
};

/** One direction of a way as an exchange rate (the additive terms are in the rate). */
export function headline(x: EdgeExplanation, arc: ArcCostExplanation): Headline {
  if (!isOpen(arc) || arc.cost === undefined) return { title: "Closed", rate: "", perM: null };
  const length = x.length_m;
  const perM = length > 0 ? arc.cost / length : arc.factor;
  return {
    title: `Counts as ${times(perM)} its length`,
    rate: `${metresText(length)} count as ${metresText(arc.cost)}: ${exchange(perM)}.`,
    perM,
  };
}

/** The direction to explain: the one the route rides (`arcs` of the plan), else the cheaper open one. */
export function focusArc(x: EdgeExplanation, routeArcs: readonly number[] | null): ArcCostExplanation {
  const ridden = routeArcs?.find((a) => a >> 1 === x.edge);
  if (ridden !== undefined) return ridden === x.along.arc ? x.along : x.against;
  const open = [x.along, x.against].filter(isOpen);
  if (open.length === 0) return x.along;
  return open.reduce((a, b) => (b.factor < a.factor ? b : a));
}

/** Whether the plan's route rides this edge (either way, in part at a waypoint too). */
export const onRoute = (edge: number, routeArcs: readonly number[] | null | undefined) =>
  !!routeArcs?.some((a) => a >> 1 === edge);

// ---------------------------------------------------------------- the three groups

export type Group = "lowers" | "raises" | "neutral";

export type Line = {
  /** the preference id, or `fixed:<kind>` for a fixed additive term */
  key: string;
  /** the preference behind it (`null`: a fixed cost, no slider) */
  pref: PrefId | null;
  group: Group;
  label: string;
  /** its weight in the plan (`null`: not in the plan) */
  weight: number | null;
  /** how much the way is what it names: "matches fully", "traffic 45 %", "no match here" */
  match: string;
  /** the value on the right: "×0.78", "+120 m" (empty: none) */
  value: string;
  /** the effect in a rider's words */
  effect: string;
  /** how strongly it acts here, for the order */
  strength: number;
};

export type Lines = Record<Group, Line[]>;

const FIXED: Record<Exclude<AdditiveKind, "climb">, string> = {
  barriers: "Barriers (gates, bollards)",
  steps: "Carrying up steps",
  dismount: "Walking (dismount)",
  ferry: "Waiting for the ferry",
};

/** How much a way is what a preference names, in words. */
export function matchText(id: PrefId, m: number): string {
  if (Math.abs(m) < NO_MATCH) return id === "quiet" ? "no traffic here" : "no match here";
  if (id === "quiet") return `traffic ${pct(m)}`;
  if (m < 0) return `the opposite here (${pct(m)})`;
  return m >= 0.97 ? "matches fully" : `matches ${pct(m)}`;
}

/** A preference's factor through the gate (a gated bonus counts only as far as the gate lets it). */
export function effective(p: PrefPart, gate: number): number {
  return p.role === "gated_bonus" && p.factor < 1 ? 1 + (p.factor - 1) * gate : p.factor;
}

/** "worth a 1.3× detour" / "counts 1.8× as long" for one preference's factor. */
export function effectText(f: number): string {
  if (f < 1) return `worth a ${times(1 / f)} detour`;
  return `counts ${times(f)} as long`;
}

/** The factor a preference not in the plan would have here at weight `w` (its catalogue strengths). */
export function wouldBe(def: { max_bonus: number; max_penalty: number }, w: number, m: number): number {
  const x = (w / 100) * m;
  return x > 0 ? def.max_bonus ** x : x < 0 ? def.max_penalty ** -x : 1;
}

/**
 * The lines of one direction of a way, in three groups: what lowers its cost, what raises it, and what
 * could apply but is neutral here (an active preference that does not match, one at 0, or one not in
 * the plan that would match: from `probe`, the same direction explained with every preference on).
 */
export function lines(
  x: EdgeExplanation,
  arc: ArcCostExplanation,
  probe: ArcCostExplanation | null,
  weights: Weights,
  catalogue: Catalogue | null,
): Lines {
  const out: Lines = { lowers: [], raises: [], neutral: [] };
  const def = (id: PrefId) => catalogue?.preferences.find((p) => p.id === id);
  const labelOf = (id: PrefId) => def(id)?.label ?? id;
  const alongside = x.traffic_from === "alongside";
  const active = new Set<PrefId>();
  for (const p of arc.preferences) {
    active.add(p.id);
    const base = {
      key: p.id,
      pref: p.id,
      label: labelOf(p.id),
      weight: weights[p.id] ?? p.weight,
      match: matchText(p.id, p.membership),
    };
    if (p.role === "additive") {
      // avoiding climbs: metres on top, no factor
      const m = arc.additive.find((a) => a.kind === "climb")?.metres ?? 0;
      if (m > 0.5)
        out.raises.push({
          ...base,
          group: "raises",
          match: `${Math.round(arc.ascent_m)} m up`,
          value: `+${metresText(m)}`,
          effect: `counts ${metresText(m)} on top for the climbing`,
          strength: m / Math.max(1, x.length_m),
        });
      else
        out.neutral.push({
          ...base,
          group: "neutral",
          match: "no climbing to speak of",
          value: "",
          effect: "",
          strength: 0,
        });
      continue;
    }
    const f = effective(p, arc.gate);
    if (Math.abs(f - 1) <= NO_EFFECT) {
      const matches = Math.abs(p.membership) >= NO_MATCH;
      out.neutral.push({
        ...base,
        group: "neutral",
        value: "",
        effect:
          matches && p.role === "gated_bonus"
            ? "the way is not good enough for its bonus"
            : matches
              ? "about no effect here"
              : "",
        strength: 0,
      });
      continue;
    }
    const partGate = p.role === "gated_bonus" && p.factor < 1 && arc.gate < 0.999;
    out[f < 1 ? "lowers" : "raises"].push({
      ...base,
      group: f < 1 ? "lowers" : "raises",
      match: p.id === "quiet" && alongside ? `${base.match}, from the road alongside` : base.match,
      value: formatFactor(f),
      effect: `${effectText(f)}${partGate ? `; the bonus counts ${pct(arc.gate)}, the way is not good enough for all of it` : ""}`,
      strength: Math.abs(Math.log(f)),
    });
  }
  // fixed additive terms: no slider
  for (const a of arc.additive) {
    if (a.kind === "climb" || a.metres <= 0.5) continue;
    out.raises.push({
      key: `fixed:${a.kind}`,
      pref: null,
      group: "raises",
      label: FIXED[a.kind],
      weight: null,
      match: "fixed",
      value: `+${metresText(a.metres)}`,
      effect: "a fixed cost: no slider changes it",
      strength: a.metres / Math.max(1, x.length_m),
    });
  }
  // what is not active but would match: weight 0 in the plan, or not in it
  for (const p of probe?.preferences ?? []) {
    if (active.has(p.id) || Math.abs(p.membership) < NO_MATCH) continue;
    const d = def(p.id);
    const inPlan = p.id in weights;
    let effect = inPlan ? "in this plan at 0: no say yet" : "not in this plan";
    if (!inPlan && d && !(p.id === "climb" && d.default < 0)) {
      const raw = wouldBe(d, d.default, p.membership);
      const f = d.gated && raw < 1 ? 1 + (raw - 1) * arc.gate : raw;
      if (Math.abs(f - 1) > NO_EFFECT)
        effect = `not in this plan: at its usual ${signed(d.default)} it would count ${formatFactor(f)} here`;
    }
    out.neutral.push({
      key: p.id,
      pref: p.id,
      group: "neutral",
      label: labelOf(p.id),
      weight: inPlan ? (weights[p.id] ?? 0) : null,
      match: matchText(p.id, p.membership),
      value: "",
      effect,
      strength: Math.abs(p.membership),
    });
  }
  out.lowers.sort((a, b) => b.strength - a.strength);
  out.raises.sort((a, b) => b.strength - a.strength);
  // the neutral ones: the best matches first (those in the plan first among equals), the misses last
  const rank = (l: Line) => (l.weight !== null ? 0 : 1);
  out.neutral.sort((a, b) => b.strength - a.strength || rank(a) - rank(b));
  return out;
}

/** The order of the lines as shown: keys per group. */
export type Layout = Record<Group, string[]>;

export const layoutOf = (l: Lines): Layout => ({
  lowers: l.lowers.map((x) => x.key),
  raises: l.raises.map((x) => x.key),
  neutral: l.neutral.map((x) => x.key),
});

/**
 * The lines in a frozen layout: while a slider is open, a line keeps its group and place even when its
 * value moves it elsewhere (no row jumps away under the finger); lines new since are added at the end
 * of their group, lines gone are dropped.
 */
export function arrange(l: Lines, frozen: Layout | null): Lines {
  if (!frozen) return l;
  const all = new Map([...l.lowers, ...l.raises, ...l.neutral].map((x) => [x.key, x]));
  const placed = new Set<string>();
  const out: Lines = { lowers: [], raises: [], neutral: [] };
  for (const g of ["lowers", "raises", "neutral"] as const)
    for (const key of frozen[g]) {
      const line = all.get(key);
      if (!line) continue;
      out[g].push(line);
      placed.add(key);
    }
  for (const g of ["lowers", "raises", "neutral"] as const)
    for (const line of l[g]) if (!placed.has(line.key)) out[g].push(line);
  return out;
}

// ---------------------------------------------------------------- why not this

export type Blame =
  | { kind: "pref"; id: PrefId; text: string }
  | { kind: "limit"; id: LimitId; text: string }
  | { kind: "rule"; text: string }
  | { kind: "distance"; text: string };

export type WhyNotVerdict = {
  /** `same`: through here is the route already; `tie`: about the same; `cheaper`: the plan is not cheapest */
  state: "same" | "tie" | "cheaper" | "dearer";
  /** first: "Not used: through here counts 1.8 km more" */
  title: string;
  /** "1.2 km longer, and it counts as 4.3 km against the planned 2.5 km where the routes part." */
  detail: string;
  /** the preference or limit to blame (dearer only) */
  blame: Blame | null;
  /** why no slider can change this (`null`: a slider can) */
  noSlider: string | null;
};

/**
 * "Why not this way" as a verdict: the extra cost of the route through it in kilometres of cost, the
 * preference or limit to blame, and whether any slider could change it. `minFactor`: the profile's
 * lower bound (a stretch that costs more even if all of it sat there cannot be won by sliders).
 */
export function whyNotVerdict(
  c: RouteComparison,
  minFactor: number,
  catalogue: Catalogue | null,
): WhyNotVerdict {
  const parts = c.stretches.filter((s) => s.a.span.length_m > 0 || s.b.span.length_m > 0);
  if (parts.length === 0)
    return {
      state: "same",
      title: "Through here is the planned route already",
      detail: "",
      blame: null,
      noSlider: null,
    };
  const dCost = c.b.cost - c.a.cost;
  const dLength = c.b.span.length_m - c.a.span.length_m;
  const rel = c.a.cost > 0 ? dCost / c.a.cost : 0;
  const costA = parts.reduce((s, x) => s + x.a.cost, 0);
  const costB = parts.reduce((s, x) => s + x.b.cost, 0);
  const longer =
    Math.abs(dLength) < 50
      ? "About as long"
      : `${metresText(Math.abs(dLength))} ${dLength > 0 ? "longer" : "shorter"}`;
  const detail = `${longer}; where the routes part it counts as ${metresText(costB)} against the planned ${metresText(costA)}.`;
  if (rel < -0.005)
    return {
      state: "cheaper",
      title: `Through here counts ${metresText(-dCost)} less: the planned route is not the cheapest here`,
      detail,
      blame: null,
      noSlider: null,
    };
  if (rel < 0.005)
    return {
      state: "tie",
      title: "Through here counts about the same: the router could take either",
      detail,
      blame: null,
      noSlider: null,
    };

  const title = `Not used: through here counts ${metresText(dCost)} more`;
  // closed parts first: a limit (lift it) or a rule (nothing lifts it)
  const closed = new Map<string, number>();
  for (const s of parts) for (const x of s.b.closed) closed.set(x.by, (closed.get(x.by) ?? 0) + x.length_m);
  const limitIds = new Set<string>(catalogue?.limits.map((l) => l.id) ?? []);
  const rule = [...closed].find(([by]) => by === "no_bikes" || by === "oneway");
  const limit = [...closed].find(([by]) => limitIds.has(by));
  if (rule) {
    const [by, m] = rule;
    const text = `${metresText(m)} of it ${by === "oneway" ? "is one-way the other way" : "allows no bicycles"}`;
    return {
      state: "dearer",
      title,
      detail,
      blame: { kind: "rule", text },
      noSlider: `No slider can change this: ${text}.`,
    };
  }
  if (limit) {
    const [by, m] = limit;
    const name = catalogue?.limits.find((l) => l.id === by)?.label ?? by;
    return {
      state: "dearer",
      title,
      detail,
      blame: {
        kind: "limit",
        id: by as LimitId,
        text: `“${name}” closes ${metresText(m)} of it`,
      },
      noSlider: `No slider can change this: only lifting “${name}” opens it.`,
    };
  }
  // the preference that makes the difference: per metre and log factor, through here against planned
  const score = new Map<PrefId, { s: number; b: number; a: number; fb?: number; fa?: number }>();
  const at = (id: PrefId) => {
    let v = score.get(id);
    if (!v) {
      v = { s: 0, b: 0, a: 0 };
      score.set(id, v);
    }
    return v;
  };
  for (const s of parts) {
    for (const r of s.b.why) {
      const v = at(r.id);
      const d = s.b.span.length_m * Math.log(r.factor);
      v.s += d;
      v.b += d;
      v.fb = r.factor;
    }
    for (const r of s.a.why) {
      const v = at(r.id);
      const d = -s.a.span.length_m * Math.log(r.factor);
      v.s += d;
      v.a += d;
      v.fa = r.factor;
    }
  }
  const best = [...score].sort((x, y) => y[1].s - x[1].s)[0];
  let blame: Blame;
  if (best && best[1].s >= Math.max(20, 0.15 * dCost)) {
    const [id, v] = best;
    const label = catalogue?.preferences.find((p) => p.id === id)?.label ?? id;
    const fb = v.fb !== undefined ? formatFactor(v.fb) : "×1.0";
    const fa = v.fa !== undefined ? formatFactor(v.fa) : "×1.0";
    blame = {
      kind: "pref",
      id,
      text:
        v.b >= v.a
          ? `“${label}” counts it dearer: ${fb} through here against ${fa} planned`
          : `“${label}” favours the planned way: ${fa} there against ${fb} through here`,
    };
  } else if (dLength >= 50)
    blame = { kind: "distance", text: `Mostly the distance: through here is ${metresText(dLength)} longer` };
  else blame = { kind: "distance", text: "No one preference: many small differences add up" };
  // could any slider win it? not if it costs more even with all of it at the detour limit
  const floor = parts.reduce((s, x) => s + x.b.span.length_m * minFactor + x.b.extra_m, 0);
  const noSlider =
    floor >= costA
      ? `No slider can change this: even if all of it counted at the detour limit (${formatFactor(minFactor)}), through here would count ${metresText(floor)} against the planned ${metresText(costA)}.`
      : null;
  return { state: "dearer", title, detail, blame, noSlider };
}

// ---------------------------------------------------------------- where on the way

type LngLat = [number, number];

/** Planar metres between two points (good enough at the scale of a way). */
function metres(a: LngLat, b: LngLat): number {
  const k = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  return Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * 111_320;
}

/** The point halfway along a line (`null`: no line). */
export function midpoint(line: readonly LngLat[]): LngLat | null {
  if (line.length === 0) return null;
  if (line.length === 1) return line[0] as LngLat;
  const steps = line.slice(1).map((p, i) => metres(line[i] as LngLat, p));
  let left = steps.reduce((s, d) => s + d, 0) / 2;
  for (let i = 0; i < steps.length; i++) {
    const d = steps[i] as number;
    const a = line[i] as LngLat;
    const b = line[i + 1] as LngLat;
    if (left <= d || i === steps.length - 1) {
      const t = d > 0 ? Math.min(1, left / d) : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    left -= d;
  }
  return line.at(-1) as LngLat;
}

/** Of a way's pieces (tile-clipped lines), the one passing nearest to a point. */
export function nearestPiece(pieces: readonly (readonly LngLat[])[], at: LngLat): readonly LngLat[] | null {
  let best: { line: readonly LngLat[]; d: number } | null = null;
  for (const line of pieces) {
    for (const p of line) {
      const d = metres(p, at);
      if (!best || d < best.d) best = { line, d };
    }
  }
  return best?.line ?? null;
}
