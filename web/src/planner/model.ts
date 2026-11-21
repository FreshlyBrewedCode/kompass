// The planner's pure logic (no React, no MapLibre, no engine): waypoint editing, the profile as a base
// plus this plan's changes, the words for them, the comparison of two routes, plan and preset
// persistence. `bun test` covers it (web/test/planner-*.test.ts).
import type {
  Catalogue,
  Limit,
  LimitId,
  LimitValue,
  Preference,
  PrefId,
  Preset,
  Profile,
  RouteDiff,
  RouteResult,
  SurfaceKind,
  WayKind,
} from "@/engine/generated/types";

// ---------------------------------------------------------------- waypoints

export type Waypoint = {
  id: string;
  lon: number;
  lat: number;
  /** a place name near it, from the map's labels (never geocoded over the network) */
  place?: string;
};

let nextId = 0;
export const waypointId = () => `w${Date.now().toString(36)}${(nextId++).toString(36)}`;

/** Metres between two points (equirectangular: plenty for choosing a leg). */
export function metres(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const dx = (b.lon - a.lon) * k * 111_320;
  const dy = (b.lat - a.lat) * 110_540;
  return Math.hypot(dx, dy);
}

/**
 * Where a tapped point goes: the first tap is the start, the second the destination; after that it
 * joins the leg it costs the least detour to pass through, or extends the route past the destination
 * when that is cheaper (a tap beyond the end moves the end). The start never moves by a tap.
 */
export function insertIndex(
  waypoints: readonly { lon: number; lat: number }[],
  p: { lon: number; lat: number },
) {
  const n = waypoints.length;
  if (n < 2) return n;
  let best = n;
  let bestCost = metres(waypoints[n - 1] as Waypoint, p);
  for (let i = 0; i < n - 1; i++) {
    const a = waypoints[i] as Waypoint;
    const b = waypoints[i + 1] as Waypoint;
    const cost = metres(a, p) + metres(p, b) - metres(a, b);
    if (cost <= bestCost) {
      best = i + 1;
      bestCost = cost;
    }
  }
  return best;
}

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const out = [...items];
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item as T);
  return out;
}

/** "Start", "Waypoint 2", "Destination"; a nearby place name when the map gave one. */
export function waypointLabel(w: Waypoint | undefined, index: number, count: number): string {
  if (w?.place) return w.place;
  if (index === 0) return "Start";
  if (index === count - 1 && count > 1) return "Destination";
  return `Waypoint ${index}`;
}

/** The marker's letter: A, 1, 2 …, B. */
export const markerText = (index: number, count: number) =>
  index === 0 ? "A" : index === count - 1 ? "B" : String(index);

// ---------------------------------------------------------------- profile

export type Weights = Partial<Record<PrefId, number>>;
export type Limits = Partial<Record<LimitId, LimitValue>>;

/** A preset as the planner keeps it: shipped by the engine, or saved on this device. */
export type PlanPreset = Preset & { own?: boolean };

export const presetName = (p: PlanPreset | undefined) => p?.profile.name ?? p?.id ?? "Profile";

/** Slider steps of 5; within ±5 of the centre it snaps to "no opinion". */
export function snapWeight(v: number): number {
  const s = Math.round(Math.max(-100, Math.min(100, v)) / 5) * 5;
  return Math.abs(s) <= 5 ? 0 : s;
}

/** A limit's value as the UI shows it: `null` off, `true` a switch, or its number. */
export function limitState(limit: Limit | undefined, v: LimitValue | undefined): number | true | null {
  if (v === undefined || v === false) return null;
  if (limit?.number) return typeof v === "number" ? v : limit.number.default;
  return true;
}

/** The base's limits with `true` on a number limit made explicit (so the stepper has a number). */
export function normaliseLimits(limits: Limits, catalogue: Catalogue | null): Limits {
  const out: Limits = {};
  for (const [id, v] of Object.entries(limits) as [LimitId, LimitValue][]) {
    const def = catalogue?.limits.find((l) => l.id === id);
    const s = limitState(def, v);
    out[id] = s === null ? false : s;
  }
  return out;
}

/** The rows of the profile: the core set first (always), then what the base or this plan added. */
export function prefRows(weights: Weights, core: readonly PrefId[]): PrefId[] {
  const rest = (Object.keys(weights) as PrefId[]).filter((id) => !core.includes(id));
  return [...core, ...rest];
}

/** The limits on screen: those of the base (also when switched off: the change stays visible) and the added ones. */
export function limitRows(base: Limits, limits: Limits): LimitId[] {
  return [...new Set([...(Object.keys(base) as LimitId[]), ...(Object.keys(limits) as LimitId[])])];
}

export type Change = {
  id: PrefId | LimitId | typeof DETOURS_ID;
  kind: "pref" | "limit" | "detours";
  /** not part of the base at all */
  added: boolean;
  removed: boolean;
  text: string;
};

/** How the summary names a preference: "more gravel", "less climbing". */
const NOUNS: Partial<Record<PrefId, string>> = {
  unpaved: "gravel",
  paved_smooth: "smooth tarmac",
  paved_rough: "cobbles",
  fine_gravel: "fine gravel",
  soft_ground: "soft ground",
  unknown_surface: "unknown surface",
  tracktype: "firm tracks",
  smoothness: "smooth ways",
  track: "tracks",
  path: "narrow paths",
  cycleway_sep: "bike paths away from roads",
  cycleway_road: "roadside bike paths",
  residential: "residential streets",
  service: "service roads",
  minor: "small country roads",
  main: "main roads",
  quiet: "quiet",
  speed: "fast roads",
  lanes: "multi-lane roads",
  near_road: "road noise",
  forest: "forest",
  forest_edge: "forest edge",
  water: "water",
  open: "open land",
  built: "built-up areas",
  climb: "climbing",
  steep: "steep ramps",
  ramps_over_6: "ramps over 6 %",
  ramps_over_8: "ramps over 8 %",
  ramps_over_10: "ramps over 10 %",
  ramps_over_12: "ramps over 12 %",
  ramps_over_15: "ramps over 15 %",
  bike_routes: "signed bike routes",
  mtb_routes: "MTB routes",
  access: "doubtful access",
  sketchy: "sketchy trails",
  mtb: "technical trails",
  visibility: "faint trails",
  novel: "new ground",
  stale: "long-lost ways",
  familiar: "old favourites",
};
/** After "never": "never main roads". */
const NEVER: Partial<Record<LimitId, string>> = {
  no_main_roads: "main roads",
  paved_only: "unpaved ways",
  no_unknown_surface: "unknown surface",
  max_grade: "anything steeper than",
  max_mtb_scale: "trails harder than",
  no_stairs: "stairs",
  legal_only: "doubtful access",
  no_ferries: "ferries",
};

export const noun = (id: PrefId) => NOUNS[id] ?? id.replace(/_/g, " ");

/** A limit's number as text: "15 %", "S2". */
export function limitNumber(limit: Limit | undefined, n: number): string {
  const unit = limit?.number?.unit ?? "";
  if (unit === "S") return `S${n}`;
  return unit === "%" ? `${n} %` : `${n} ${unit}`.trim();
}

// ---------------------------------------------------------------- detours

/** The id of the detours row among the changes. */
export const DETOURS_ID = "detours";
/** `bounds.min_factor` as the engine allows it (docs/profile.md): 1.0 only avoids, 0.3 goes far for good ways. */
export const MIN_FACTOR_RANGE = { min: 0.3, max: 1.0, step: 0.05, default: 0.5 } as const;

/** A min_factor on the slider's grid, within the engine's range (0.05 steps, no float dust). */
export function snapMinFactor(v: number): number {
  const { min, max, step } = MIN_FACTOR_RANGE;
  const c = Math.max(min, Math.min(max, v));
  return Number((Math.round(c / step) * step).toFixed(2));
}

/** The base preset's `min_factor` (the engine's default where it says nothing). */
export function baseMinFactor(base: PlanPreset | undefined): number {
  return base?.profile.bounds?.min_factor ?? MIN_FACTOR_RANGE.default;
}

/** How much longer a ride may get for a way you like: 1 / min_factor, as "2×" or "1.7×". */
export function detourTimes(minFactor: number): string {
  const x = Math.round((1 / minFactor) * 10) / 10;
  return `${Number.isInteger(x) ? x : x.toFixed(1)}×`;
}

/** The word beside the detours slider. */
export function detourWord(minFactor: number): string {
  if (minFactor >= 0.99) return "Direct";
  if (minFactor >= 0.8) return "A little off the way";
  if (minFactor >= 0.6) return "Some detours";
  if (minFactor >= 0.45) return "Detours for good ways";
  return "Go far for good ways";
}

/** What the current value means, in a sentence. */
export function detourHint(minFactor: number): string {
  if (minFactor >= 0.99) return "Preferences only avoid; they never pull the route out of its way.";
  return `Up to ${detourTimes(minFactor)} longer for a way you like.`;
}

/** What this plan changed against its base, in words. Core preferences absent from a profile count as 0. */
export function changes(
  base: { weights: Weights; limits: Limits },
  weights: Weights,
  limits: Limits,
  catalogue: Catalogue | null,
  minFactors?: { base: number; plan: number },
): Change[] {
  const core = catalogue?.core ?? [];
  const out: Change[] = [];
  const prefIds = new Set([
    ...(Object.keys(base.weights) as PrefId[]),
    ...(Object.keys(weights) as PrefId[]),
  ]);
  for (const id of prefIds) {
    const isCore = core.includes(id);
    const b = base.weights[id] ?? (isCore ? 0 : undefined);
    const c = weights[id] ?? (isCore ? 0 : undefined);
    if (b === c) continue;
    if (b === undefined && c === 0) {
      out.push({ id, kind: "pref", added: true, removed: false, text: `${noun(id)} (no opinion yet)` });
      continue;
    }
    if (c === undefined) {
      out.push({ id, kind: "pref", added: false, removed: true, text: `no opinion on ${noun(id)}` });
      continue;
    }
    const d = c - (b ?? 0);
    out.push({
      id,
      kind: "pref",
      added: b === undefined,
      removed: false,
      text: `${d > 0 ? "more" : "less"} ${noun(id)}`,
    });
  }
  for (const id of limitRows(base.limits, limits)) {
    const def = catalogue?.limits.find((l) => l.id === id);
    const b = limitState(def, base.limits[id]);
    const c = limitState(def, limits[id]);
    if (b === c) continue;
    const never = NEVER[id] ?? (def?.label ?? id).toLowerCase();
    const n = typeof c === "number" ? ` ${limitNumber(def, c)}` : "";
    out.push({
      id,
      kind: "limit",
      added: b === null && base.limits[id] === undefined,
      removed: c === null,
      text: c === null ? `${never} allowed again` : `never ${never}${n}`,
    });
  }
  if (minFactors && Math.abs(minFactors.base - minFactors.plan) > 1e-6) {
    out.push({
      id: DETOURS_ID,
      kind: "detours",
      added: false,
      removed: false,
      text: minFactors.plan > minFactors.base ? "fewer detours" : "more detours",
    });
  }
  return out;
}

/** The one line under the profile's name: the changes, not the profile. */
export function changeSentence(baseName: string, list: readonly Change[]): string {
  if (list.length === 0) return `${baseName}, as it comes.`;
  const t = list.map((c) => c.text);
  const joined = t.length === 1 ? t[0] : `${t.slice(0, -1).join(", ")} and ${t[t.length - 1]}`;
  return `${baseName}, but ${joined}.`;
}

/** The word beside a slider: avoid ↔ seek told in words, never by colour. */
export function weightWord(
  pref: Pick<Preference, "low_label" | "high_label"> | undefined,
  v: number,
): string {
  if (Math.abs(v) < 8) return "no opinion";
  if (v <= -70) return pref?.low_label ?? "avoid strongly";
  if (v >= 70) return pref?.high_label ?? "seek out";
  if (v < -35) return "avoid";
  if (v < 0) return "rather not";
  if (v < 35) return "nice to have";
  return "prefer";
}

/** The plan's profile, as the engine takes it. */
export function planProfile(
  base: PlanPreset | undefined,
  weights: Weights,
  limits: Limits,
  minFactor?: number,
): Profile {
  const bounds =
    minFactor !== undefined && Math.abs(minFactor - baseMinFactor(base)) > 1e-6
      ? { ...(base?.profile.bounds ?? { max_factor: 20 }), min_factor: minFactor }
      : base?.profile.bounds;
  return {
    ...(base?.profile.name ? { name: base.profile.name } : {}),
    ...(base ? { base: base.id } : {}),
    weights: { ...weights },
    limits: { ...limits },
    ...(bounds ? { bounds } : {}),
  };
}

/** Whether two profiles route the same (name and base aside). */
export function sameCost(
  a: { weights: Weights; limits: Limits; minFactor?: number },
  b: { weights: Weights; limits: Limits; minFactor?: number },
) {
  const norm = (w: Weights) =>
    JSON.stringify(
      Object.entries(w)
        .filter(([, v]) => v !== 0)
        .sort(),
    );
  const normL = (l: Limits) =>
    JSON.stringify(
      Object.entries(l)
        .filter(([, v]) => v !== false)
        .sort(),
    );
  return (
    norm(a.weights) === norm(b.weights) &&
    normL(a.limits) === normL(b.limits) &&
    Math.abs((a.minFactor ?? 0) - (b.minFactor ?? 0)) < 1e-6
  );
}

// ---------------------------------------------------------------- route read-outs

export const km = (m: number) => m / 1000;
export const fmtKm = (m: number) => {
  const k = m / 1000;
  return k >= 100 ? k.toFixed(0) : k.toFixed(1);
};
export const fmtTime = (s: number) => {
  const min = Math.round(s / 60);
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
};

/** The surface classes of the result, grouped the way lanes and legends colour them. */
export type SurfaceGroup = "paved" | "gravel" | "dirt" | "unknown";
export const SURFACE_GROUP: Record<SurfaceKind, SurfaceGroup> = {
  paved: "paved",
  paved_rough: "paved",
  compacted: "gravel",
  gravel: "gravel",
  soft: "dirt",
  other: "dirt",
  unknown: "unknown",
};
export type WayGroup = "path" | "track" | "cycleway" | "quiet" | "minor" | "main";
export const WAY_GROUP: Record<WayKind, WayGroup> = {
  path: "path",
  steps: "path",
  track: "track",
  bike_path: "cycleway",
  bike_path_roadside: "cycleway",
  residential: "quiet",
  service: "quiet",
  other: "quiet",
  ferry: "quiet",
  country_road: "minor",
  main_road: "main",
};

export function surfaceShares(r: RouteResult): Record<SurfaceGroup, number> {
  const out: Record<SurfaceGroup, number> = { paved: 0, gravel: 0, dirt: 0, unknown: 0 };
  for (const p of r.breakdown.surface) out[SURFACE_GROUP[p.key]] += p.length_m;
  return out;
}
export function wayShares(r: RouteResult): Record<WayGroup, number> {
  const out: Record<WayGroup, number> = { path: 0, track: 0, cycleway: 0, quiet: 0, minor: 0, main: 0 };
  for (const p of r.breakdown.way) out[WAY_GROUP[p.key]] += p.length_m;
  return out;
}
export const unpavedM = (r: RouteResult) => r.summary.unpaved_share * r.summary.distance_m;
export const newM = (r: RouteResult) => r.breakdown.ridden?.new_m ?? null;

const signedNum = (v: number, f: (n: number) => string) => `${v > 0 ? "+" : "−"}${f(Math.abs(v))}`;

/** What the changes did against the base profile's route, in numbers ("+1.9 km", "−147 m"). */
export function deltas(a: RouteResult, ref: RouteResult): string[] {
  const out: string[] = [];
  const add = (v: number, min: number, f: (n: number) => string) => {
    if (Math.abs(v) >= min) out.push(signedNum(v, f));
  };
  add(a.summary.distance_m - ref.summary.distance_m, 100, (n) => `${fmtKm(n)} km`);
  add(a.summary.ascent_m - ref.summary.ascent_m, 5, (n) => `${Math.round(n)} m`);
  add(a.summary.duration_s - ref.summary.duration_s, 60, (n) => `${Math.round(n / 60)} min`);
  add(unpavedM(a) - unpavedM(ref), 300, (n) => `${fmtKm(n)} km gravel`);
  add(a.summary.main_road_m - ref.summary.main_road_m, 300, (n) => `${fmtKm(n)} km main road`);
  const na = newM(a);
  const nr = newM(ref);
  if (na !== null && nr !== null) add(na - nr, 300, (n) => `${fmtKm(n)} km new to you`);
  return out;
}

export type CompareRow = { label: string; a: string; b: string };
/** The six metrics of a comparison, "a → b". */
export function compareRows(a: RouteResult, b: RouteResult): CompareRow[] {
  const k = (m: number) => `${fmtKm(m)}`;
  const rows: CompareRow[] = [
    { label: "Distance", a: k(a.summary.distance_m), b: `${k(b.summary.distance_m)} km` },
    { label: "Climb", a: String(Math.round(a.summary.ascent_m)), b: `${Math.round(b.summary.ascent_m)} m` },
    { label: "Time", a: fmtTime(a.summary.duration_s), b: fmtTime(b.summary.duration_s) },
    { label: "Unpaved", a: k(unpavedM(a)), b: `${k(unpavedM(b))} km` },
    { label: "Main road", a: k(a.summary.main_road_m), b: `${k(b.summary.main_road_m)} km` },
  ];
  const na = newM(a);
  const nb = newM(b);
  if (na !== null && nb !== null) rows.push({ label: "New to me", a: k(na), b: `${k(nb)} km` });
  else {
    const pathsA = wayShares(a).path + wayShares(a).track;
    const pathsB = wayShares(b).path + wayShares(b).track;
    rows.push({ label: "Tracks & paths", a: k(pathsA), b: `${k(pathsB)} km` });
  }
  return rows;
}

/** The second sentence in pieces: the striking part (main roads) is set in bold. */
export type Tradeoff = { first: string; second: { text: string; strong?: boolean }[] };
/**
 * The comparison in words, from `b`'s side: "Paved & quiet is 6.3 km longer but 62 min faster, with
 * 445 m less climbing. It gives up 26.7 km of gravel and puts you on main roads for 11.8 km; the two
 * share 40 % of the way."
 */
export function tradeoff(a: RouteResult, b: RouteResult, diff: RouteDiff | null): Tradeoff {
  const dKm = b.summary.distance_m - a.summary.distance_m;
  const dMin = Math.round((b.summary.duration_s - a.summary.duration_s) / 60);
  const dClimb = Math.round(b.summary.ascent_m - a.summary.ascent_m);
  const len =
    Math.abs(dKm) < 100 ? "about as long" : `${fmtKm(Math.abs(dKm))} km ${dKm > 0 ? "longer" : "shorter"}`;
  const time =
    Math.abs(dMin) < 1 ? "takes as long" : `${Math.abs(dMin)} min ${dMin > 0 ? "slower" : "faster"}`;
  const joiner = Math.abs(dKm) < 100 || Math.abs(dMin) < 1 || dKm > 0 === dMin > 0 ? "and" : "but";
  const climb =
    Math.abs(dClimb) < 5
      ? "the same climbing"
      : `${Math.abs(dClimb)} m ${dClimb > 0 ? "more" : "less"} climbing`;
  const first = `is ${len} ${joiner} ${time}, with ${climb}.`;
  const dUnp = unpavedM(b) - unpavedM(a);
  const gravel =
    Math.abs(dUnp) < 300
      ? "It has about as much gravel"
      : `It ${dUnp < 0 ? "gives up" : "adds"} ${fmtKm(Math.abs(dUnp))} km of gravel`;
  const mainB = b.summary.main_road_m;
  const dMain = mainB - a.summary.main_road_m;
  const strong =
    dMain > 300
      ? `puts you on main roads for ${fmtKm(mainB)} km`
      : dMain < -300
        ? `takes ${fmtKm(-dMain)} km off main roads`
        : undefined;
  const total = diff ? diff.shared_m + diff.a_only_m : 0;
  const shared =
    diff && total > 0 ? `; the two share ${Math.round((diff.shared_m / total) * 100)}\u00a0% of the way` : "";
  const nb = newM(b);
  const fresh = nb !== null ? `; ${fmtKm(nb)} km of it would be new to you` : "";
  const second: Tradeoff["second"] = strong
    ? [{ text: `${gravel} and ` }, { text: strong, strong: true }, { text: `${shared}${fresh}.` }]
    : [{ text: `${gravel}${shared}${fresh}.` }];
  return { first, second };
}

/** The trade-off as plain text (tests, the agent later). */
export const tradeoffText = (name: string, t: Tradeoff) =>
  `${name} ${t.first} ${t.second.map((p) => p.text).join("")}`;

/** "Why this way": the few stretches where one preference clearly drew the route, longest first. */
export type Note = {
  id: PrefId;
  startM: number;
  lengthM: number;
  vertex: number;
  title: string;
  text: string;
};
export function routeNotes(r: RouteResult, catalogue: Catalogue | null, max = 3): Note[] {
  const runs: { id: PrefId; startM: number; lengthM: number; v0: number; v1: number }[] = [];
  for (const s of r.segments) {
    const top = s.why[0];
    const id = top && top.factor < 0.85 ? top.id : null;
    const last = runs[runs.length - 1];
    if (id && last && last.id === id && Math.abs(last.startM + last.lengthM - s.start_m) < 1) {
      last.lengthM += s.length_m;
      last.v1 = s.vertices[1];
    } else if (id)
      runs.push({ id, startM: s.start_m, lengthM: s.length_m, v0: s.vertices[0], v1: s.vertices[1] });
  }
  const total = r.summary.distance_m;
  const minLen = Math.max(400, total * 0.06);
  const picked = runs
    .filter((x) => x.lengthM >= minLen)
    .sort((a, b) => b.lengthM - a.lengthM)
    .filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i)
    .slice(0, max);
  return picked.map((x) => {
    const pref = catalogue?.preferences.find((p) => p.id === x.id);
    const label = pref?.label ?? x.id;
    return {
      id: x.id,
      startM: x.startM,
      lengthM: x.lengthM,
      vertex: Math.round((x.v0 + x.v1) / 2),
      title: pref?.short ?? label,
      text: `${fmtKm(x.lengthM)} km picked for ${noun(x.id)}.`,
    };
  });
}

/** The elevation profile, at most `n` points: [metres along, elevation]. */
export function elevationProfile(r: RouteResult, n = 400): [number, number][] {
  const g = r.geometry;
  if (!g?.elevation_m || g.elevation_m.length < 2) return [];
  const len = g.elevation_m.length;
  const step = Math.max(1, Math.floor(len / n));
  const out: [number, number][] = [];
  for (let i = 0; i < len; i += step) out.push([g.distance_m[i] as number, g.elevation_m[i] as number]);
  const last = len - 1;
  if ((out[out.length - 1]?.[0] ?? -1) !== g.distance_m[last])
    out.push([g.distance_m[last] as number, g.elevation_m[last] as number]);
  return out;
}

/** The vertex at a distance along the route (binary search). */
export function vertexAt(r: RouteResult, m: number): number {
  const d = r.geometry?.distance_m ?? [];
  let lo = 0;
  let hi = d.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((d[mid] as number) < m) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo);
}

/** Where each waypoint sits along the route, metres (from the legs). */
export function waypointMetres(r: RouteResult): number[] {
  const out = [0];
  let at = 0;
  for (const leg of r.legs) {
    at += leg.distance_m;
    out.push(at);
  }
  return out;
}

// ---------------------------------------------------------------- errors

/** The limit an error names (`… excluded by the limit "Paved only" …`), by its catalogue label. */
export function limitInMessage(message: string, catalogue: Catalogue | null): LimitId | null {
  const m = /the limit "([^"]+)"/.exec(message);
  if (!m) return null;
  return catalogue?.limits.find((l) => l.label === m[1])?.id ?? null;
}

/** Which limits to try lifting, one at a time, to find the one that blocks: this plan's own first. */
export function probeOrder(base: Limits, limits: Limits): LimitId[] {
  const on = (Object.keys(limits) as LimitId[]).filter(
    (id) => limits[id] !== false && limits[id] !== undefined,
  );
  const own = on.filter((id) => base[id] !== limits[id]);
  return [...own, ...on.filter((id) => !own.includes(id))];
}

// ---------------------------------------------------------------- persistence

export type LineBy = "plain" | "surface";
export type SavedPlan = {
  v: 1;
  waypoints: Waypoint[];
  baseId: string;
  weights: Weights;
  limits: Limits;
  /** the detours value when it differs from the base's */
  detours?: number;
  compareId: string | null;
  lineBy: LineBy;
};

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** A stored plan, or `null` when it is missing or not ours. Waypoints outside `bounds` are dropped. */
export function parsePlan(
  text: string | null,
  bounds?: readonly [number, number, number, number],
): SavedPlan | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Partial<SavedPlan>;
    if (raw.v !== 1 || typeof raw.baseId !== "string") return null;
    const inside = (w: Waypoint) =>
      !bounds || (w.lon >= bounds[0] && w.lon <= bounds[2] && w.lat >= bounds[1] && w.lat <= bounds[3]);
    const waypoints = (Array.isArray(raw.waypoints) ? raw.waypoints : [])
      .filter((w): w is Waypoint => !!w && num(w.lon) && num(w.lat))
      .map((w) => ({
        id: typeof w.id === "string" ? w.id : waypointId(),
        lon: w.lon,
        lat: w.lat,
        ...(typeof w.place === "string" ? { place: w.place } : {}),
      }))
      .filter(inside);
    const weights: Weights = {};
    for (const [k, v] of Object.entries(raw.weights ?? {}))
      if (num(v)) weights[k as PrefId] = Math.max(-100, Math.min(100, v));
    const limits: Limits = {};
    for (const [k, v] of Object.entries(raw.limits ?? {}))
      if (typeof v === "boolean" || num(v)) limits[k as LimitId] = v;
    return {
      v: 1,
      waypoints,
      baseId: raw.baseId,
      weights,
      limits,
      ...(num(raw.detours) ? { detours: snapMinFactor(raw.detours) } : {}),
      compareId: typeof raw.compareId === "string" ? raw.compareId : null,
      lineBy: raw.lineBy === "surface" ? "surface" : "plain",
    };
  } catch {
    return null;
  }
}

/** The user's own presets, as stored. */
export function parsePresets(text: string | null): PlanPreset[] {
  if (!text) return [];
  try {
    const raw = JSON.parse(text) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (p): p is Preset =>
          !!p &&
          typeof p.id === "string" &&
          !!p.profile &&
          typeof p.profile.weights === "object" &&
          typeof p.profile.limits === "object",
      )
      .map((p) => ({
        id: p.id,
        blurb: typeof p.blurb === "string" ? p.blurb : "",
        profile: p.profile,
        own: true,
      }));
  } catch {
    return [];
  }
}

export function ownPreset(
  name: string,
  base: PlanPreset | undefined,
  weights: Weights,
  limits: Limits,
  now = Date.now(),
  bounds?: Profile["bounds"],
): PlanPreset {
  return {
    id: `own-${now.toString(36)}`,
    blurb: base ? `Made from ${presetName(base)}` : "Your own",
    profile: { name, weights: { ...weights }, limits: { ...limits }, ...(bounds ? { bounds } : {}) },
    own: true,
  };
}
