import { type LngLat, ROUTES, type RoadKey, type RouteData, type Seg, type SurfaceKey } from "@/mock/data";

/**
 * Round 2: the profile model and a toy engine.
 *
 * A profile is a base (a preset) plus the tweaks of this plan. Soft preferences are weights from
 * -100 (avoid) over 0 (no opinion) to +100 (seek); hard limits exclude ways and may carry a number.
 * The toy engine splices the three fixed mock routes at the nodes they share, so dragging a slider
 * flips single sections of the route, the way live rerouting would.
 */

// ---------------------------------------------------------------- catalogue

export type GroupId = "surface" | "ways" | "traffic" | "landscape" | "terrain" | "signs" | "trail" | "history";
export const GROUPS: { id: GroupId; label: string; blurb: string }[] = [
  { id: "surface", label: "Surface", blurb: "What you roll on" },
  { id: "ways", label: "Way type", blurb: "Tracks, paths, roads" },
  { id: "traffic", label: "Traffic", blurb: "Cars, speed, noise" },
  { id: "landscape", label: "Landscape", blurb: "Forest, water, open land" },
  { id: "terrain", label: "Terrain", blurb: "Climbing and ramps" },
  { id: "signs", label: "Routes & access", blurb: "Signed routes, legal access" },
  { id: "trail", label: "Trail difficulty", blurb: "How sketchy it gets" },
  { id: "history", label: "My rides", blurb: "New ground or old favourites" },
];

/** What the toy engine knows about one section of one candidate. */
interface Feat {
  km: number;
  climb: number;
  surface: Partial<Record<SurfaceKey, number>>;
  road: Partial<Record<RoadKey, number>>;
  newKm: number;
  syn: Record<string, number>;
}

export interface Attr {
  id: string;
  group: GroupId;
  label: string;
  /** Short label for chips. */
  short: string;
  /** How the summary names it: "more gravel", "less climbing". */
  noun: string;
  hint: string;
  /** Value it starts with when added from the picker. */
  start: number;
  lo?: string;
  hi?: string;
  /** Share of ways that carry the tag at all, when that is low enough to matter. */
  coverage?: number;
  share: (f: Feat) => number;
}

const s = (f: Feat, ...keys: SurfaceKey[]) => keys.reduce((a, k) => a + (f.surface[k] ?? 0), 0) / f.km;
const r = (f: Feat, ...keys: RoadKey[]) => keys.reduce((a, k) => a + (f.road[k] ?? 0), 0) / f.km;
const syn = (k: string) => (f: Feat) => f.syn[k] ?? 0.2;

export const ATTRS: Attr[] = [
  { id: "unpaved", group: "surface", label: "Gravel & unpaved", short: "Gravel", noun: "gravel", hint: "Anything not sealed: gravel, forest tracks, dirt.", start: 50, share: (f) => s(f, "gravel", "dirt", "unknown") },
  { id: "paved_smooth", group: "surface", label: "Smooth tarmac", short: "Tarmac", noun: "smooth tarmac", hint: "Asphalt and concrete in good shape.", start: 50, share: (f) => s(f, "paved") },
  { id: "paved_rough", group: "surface", label: "Cobbles & rough paving", short: "Cobbles", noun: "cobbles", hint: "Sett, cobblestone and broken tarmac.", start: -60, share: syn("cobbles") },
  { id: "fine_gravel", group: "surface", label: "Compacted fine gravel", short: "Fine gravel", noun: "fine gravel", hint: "Hard-packed, rolls almost like tarmac.", start: 60, share: (f) => s(f, "gravel") },
  { id: "soft_ground", group: "surface", label: "Soft ground, grass, sand", short: "Soft ground", noun: "soft ground", hint: "Slow when dry, a mess when wet.", start: -50, share: (f) => s(f, "dirt") },
  { id: "unknown_surface", group: "surface", label: "Unknown surface", short: "Unknown", noun: "unknown surface", hint: "No surface tag. Unknown is not bad, only unknown.", start: -30, share: (f) => s(f, "unknown") },
  { id: "tracktype", group: "surface", label: "Firm tracks (grade 1–2)", short: "Firm tracks", noun: "firm tracks", hint: "Track grade: 1 is solid, 5 is soft and overgrown.", start: 50, share: (f) => s(f, "gravel") * 0.8 },
  { id: "smoothness", group: "surface", label: "Smoothness", short: "Smooth", noun: "smooth ways", hint: "The smoothness tag, where someone mapped it.", start: 40, coverage: 9, share: (f) => s(f, "paved") * 0.7 },

  { id: "track", group: "ways", label: "Farm & forest tracks", short: "Tracks", noun: "tracks", hint: "Two-lane tracks for tractors and forestry.", start: 60, share: (f) => r(f, "track") },
  { id: "path", group: "ways", label: "Narrow paths", short: "Paths", noun: "narrow paths", hint: "Footpaths and singletrack.", start: 40, share: (f) => r(f, "path") },
  { id: "cycleway_sep", group: "ways", label: "Bike paths away from the road", short: "Bike paths", noun: "bike paths away from roads", hint: "Their own line through the land, no cars in sight.", start: 60, share: (f) => r(f, "cycleway") * 0.7 },
  { id: "cycleway_road", group: "ways", label: "Bike paths beside a road", short: "Roadside paths", noun: "roadside bike paths", hint: "Separate, but you hear and see the traffic.", start: -30, share: (f) => r(f, "cycleway") * 0.3 },
  { id: "residential", group: "ways", label: "Residential streets", short: "Residential", noun: "residential streets", hint: "Slow streets through villages and estates.", start: 30, share: (f) => r(f, "quiet") * 0.7 },
  { id: "service", group: "ways", label: "Service & access roads", short: "Service", noun: "service roads", hint: "Driveways, farm access, industrial yards.", start: -20, share: (f) => r(f, "quiet") * 0.3 },
  { id: "minor", group: "ways", label: "Small country roads", short: "Country roads", noun: "small country roads", hint: "Unclassified and tertiary roads.", start: 30, share: (f) => r(f, "minor") },
  { id: "main", group: "ways", label: "Main roads", short: "Main roads", noun: "main roads", hint: "Secondary and primary roads.", start: -80, share: (f) => r(f, "main") },

  { id: "quiet", group: "traffic", label: "Low traffic", short: "Quiet", noun: "quiet", hint: "Guessed from road class, speed limit and lanes.", start: 50, lo: "don't care", hi: "must be calm", share: (f) => 1 - r(f, "main") - r(f, "minor") * 0.5 },
  { id: "speed", group: "traffic", label: "Fast roads (70 km/h and up)", short: "Fast roads", noun: "fast roads", hint: "By speed limit, whatever the road class.", start: -60, share: (f) => r(f, "main") * 0.8 },
  { id: "lanes", group: "traffic", label: "Multi-lane roads", short: "Multi-lane", noun: "multi-lane roads", hint: "More than one lane each way.", start: -70, share: (f) => r(f, "main") * 0.3 },
  { id: "near_road", group: "traffic", label: "Within earshot of a motor road", short: "Road noise", noun: "road noise", hint: "Ways that run close to a busy road.", start: -40, share: syn("near_road") },

  { id: "forest", group: "landscape", label: "Through forest", short: "Forest", noun: "forest", hint: "Share of the way under trees.", start: 50, share: syn("forest") },
  { id: "forest_edge", group: "landscape", label: "Along a forest edge", short: "Forest edge", noun: "forest edge", hint: "Trees on one side, a view on the other.", start: 60, share: syn("edge") },
  { id: "water", group: "landscape", label: "Along rivers & lakes", short: "Water", noun: "water", hint: "Ways that follow a river or a shore.", start: 60, share: syn("water") },
  { id: "open", group: "landscape", label: "Open land", short: "Open land", noun: "open land", hint: "Fields and meadows, wind included.", start: 40, share: syn("open") },
  { id: "built", group: "landscape", label: "Built-up areas", short: "Built-up", noun: "built-up areas", hint: "Towns and villages.", start: -40, share: syn("built") },

  { id: "climb", group: "terrain", label: "Climbing", short: "Climb", noun: "climbing", hint: "Total ascent along the way.", start: -40, lo: "keep it flat", hi: "bring it on", share: (f) => f.climb / f.km / 45 },
  { id: "steep", group: "terrain", label: "Steep ramps", short: "Ramps", noun: "steep ramps", hint: "Short stretches over 10 %.", start: -50, share: syn("steep") },

  { id: "route_local", group: "signs", label: "Signed local bike routes", short: "Local routes", noun: "local bike routes", hint: "Signposted by the town or district.", start: 40, share: syn("signed") },
  { id: "route_regional", group: "signs", label: "Regional bike routes", short: "Regional routes", noun: "regional routes", hint: "The signed regional network.", start: 40, share: syn("signed") },
  { id: "route_national", group: "signs", label: "Long-distance routes", short: "Long-distance", noun: "long-distance routes", hint: "National and international routes.", start: 40, share: syn("signed") },
  { id: "access", group: "signs", label: "Doubtful access", short: "Doubtful access", noun: "doubtful access", hint: "Bikes are tolerated here, not clearly allowed.", start: -70, share: syn("doubt") },

  { id: "mtb", group: "trail", label: "Technical trails", short: "Technical", noun: "technical trails", hint: "MTB scale: roots, rocks, steps.", start: -50, coverage: 22, share: (f) => r(f, "path") * 0.6 },
  { id: "visibility", group: "trail", label: "Faint trails", short: "Faint trails", noun: "faint trails", hint: "Trail visibility: paths that are hard to see on the ground.", start: -50, coverage: 14, share: (f) => r(f, "path") * 0.4 },

  { id: "novel", group: "history", label: "Never ridden", short: "New", noun: "new ground", hint: "Ways none of your imported rides touch.", start: 50, lo: "stay familiar", hi: "explore", share: (f) => f.newKm / f.km },
  { id: "stale", group: "history", label: "Not ridden for a long time", short: "Long ago", noun: "long-lost ways", hint: "Ridden before, but not in the last year.", start: 40, share: (f) => (1 - f.newKm / f.km) * 0.4 },
  { id: "familiar", group: "history", label: "Ridden often", short: "Favourites", noun: "old favourites", hint: "The ways you keep coming back to.", start: 40, share: (f) => (1 - f.newKm / f.km) * 0.6 },
];
export const attr = (id: string) => ATTRS.find((a) => a.id === id) as Attr;
/** Always on screen, whatever the base profile. */
export const CORE = ["unpaved", "quiet", "climb", "novel"];

export interface LimitDef {
  id: string;
  group: GroupId;
  label: string;
  /** How the summary names it after "never". */
  never: string;
  hint: string;
  param?: { min: number; max: number; step: number; start: number; fmt: (n: number) => string };
  /** km of this section the limit forbids. */
  breaks: (f: Feat, n: number) => number;
}
export const LIMITS: LimitDef[] = [
  { id: "noMain", group: "ways", label: "No main roads", never: "main roads", hint: "Secondary and primary roads are out, however short.", breaks: (f) => f.road.main ?? 0 },
  { id: "pavedOnly", group: "surface", label: "Paved only", never: "unpaved ways", hint: "For the road bike: sealed surface or nothing.", breaks: (f) => (f.surface.gravel ?? 0) + (f.surface.dirt ?? 0) + (f.surface.unknown ?? 0) },
  { id: "maxGrade", group: "terrain", label: "Max grade", never: "anything steeper than", hint: "Nothing steeper than this, up or down.", param: { min: 6, max: 20, step: 1, start: 12, fmt: (n) => `${n} %` }, breaks: (f, n) => ((f.syn.maxGrade ?? 0) > n ? 1 : 0) },
  { id: "noUnknown", group: "surface", label: "No unknown surface", never: "unknown surface", hint: "Only ways whose surface is mapped.", breaks: (f) => f.surface.unknown ?? 0 },
  { id: "noStairs", group: "trail", label: "No stairs or carrying", never: "stairs", hint: "Nothing where the bike goes on the shoulder.", breaks: () => 0 },
  { id: "legalOnly", group: "signs", label: "Legal access only", never: "doubtful access", hint: "Only where bikes are clearly allowed.", breaks: () => 0 },
  { id: "maxMtb", group: "trail", label: "Max trail difficulty", never: "trails harder than", hint: "MTB scale: S0 is a smooth path, S3 is for experts.", param: { min: 0, max: 3, step: 1, start: 1, fmt: (n) => `S${n}` }, breaks: (f, n) => (n < 1 ? (f.road.path ?? 0) * 0.5 : 0) },
];
export const limitDef = (id: string) => LIMITS.find((l) => l.id === id) as LimitDef;

// ---------------------------------------------------------------- profiles

export type Prefs = Record<string, number>;
/** `true` for a plain limit, a number for one with a parameter. */
export type Limits = Record<string, number | true>;
export interface Base {
  id: string;
  name: string;
  blurb: string;
  prefs: Prefs;
  limits: Limits;
  /** Saved by the user (a preset), not shipped. */
  own?: boolean;
}

export const BASES: Base[] = [
  { id: "gravel", name: "Gravel explorer", blurb: "Tracks, forest edges, something new", prefs: { unpaved: 70, quiet: 50, climb: 20, novel: 60, forest_edge: 50 }, limits: { noStairs: true, legalOnly: true } },
  { id: "paved", name: "Paved & quiet", blurb: "Bike paths and small roads, no surprises", prefs: { unpaved: -70, quiet: 60, climb: -30, novel: 0, cycleway_sep: 60 }, limits: { pavedOnly: true, noStairs: true, legalOnly: true } },
  { id: "valley", name: "River valley", blurb: "Flat, along the water, easy legs", prefs: { unpaved: 0, quiet: 20, climb: -70, novel: -10, water: 80 }, limits: { maxGrade: 10, noStairs: true } },
  { id: "blank", name: "Blank slate", blurb: "The shortest way; build your own from here", prefs: { unpaved: 0, quiet: 0, climb: 0, novel: 0 }, limits: {} },
];

export interface Change {
  id: string;
  kind: "pref" | "limit";
  /** Not part of the base at all. */
  added: boolean;
  removed: boolean;
  text: string;
}
/** What this plan changed against its base, in words. */
export function diff(base: Base, prefs: Prefs, limits: Limits): Change[] {
  const out: Change[] = [];
  for (const id of new Set([...Object.keys(base.prefs), ...Object.keys(prefs)])) {
    const b = base.prefs[id];
    const c = prefs[id];
    if ((b ?? 0) === (c ?? 0) && (b === undefined) === (c === undefined)) continue;
    if (b === undefined && c === 0) {
      out.push({ id, kind: "pref", added: true, removed: false, text: `${attr(id).noun} (no opinion yet)` });
      continue;
    }
    const d = (c ?? 0) - (b ?? 0);
    out.push({ id, kind: "pref", added: b === undefined, removed: c === undefined, text: `${d > 0 ? "more" : "less"} ${attr(id).noun}` });
  }
  for (const id of new Set([...Object.keys(base.limits), ...Object.keys(limits)])) {
    const b = base.limits[id];
    const c = limits[id];
    if (b === c) continue;
    const def = limitDef(id);
    const n = typeof c === "number" ? ` ${def.param?.fmt(c)}` : "";
    out.push({ id, kind: "limit", added: b === undefined, removed: c === undefined, text: c === undefined ? `${def.never} allowed again` : `never ${def.never}${n}` });
  }
  return out;
}
/** The remains of round 1's sentence: one read-only line, as long as the list of changes. */
export function summary(base: Base, changes: Change[]): string {
  if (!changes.length) return `${base.name}, as it comes.`;
  const t = changes.map((c) => c.text);
  const list = t.length === 1 ? t[0] : `${t.slice(0, -1).join(", ")} and ${t[t.length - 1]}`;
  return `${base.name}, but ${list}.`;
}

export function word(a: Attr, v: number): string {
  if (Math.abs(v) < 8) return "no opinion";
  if (v <= -70) return a.lo ?? "avoid strongly";
  if (v >= 70) return a.hi ?? "seek out";
  if (v < -35) return "avoid";
  if (v < 0) return "rather not";
  if (v < 35) return "nice to have";
  return "prefer";
}

// ---------------------------------------------------------------- toy engine

const SRC = ["gravel", "paved", "valley"] as const;
type Src = (typeof SRC)[number];
/** Coordinate indices of the nodes all three mock routes share: start, four cuts, end. */
const CUTS: Record<Src, number[]> = {
  gravel: [0, 93, 376, 639, 792, 1150],
  paved: [0, 102, 483, 841, 1025, 1636],
  valley: [0, 110, 484, 842, 1026, 1550],
};
const N = 5;
/** Made-up landscape numbers per section: [gravel, paved, valley]. */
const SYN: Record<string, [number[], number[], number[]]> = {
  forest: [[0.3, 0.7, 0.6, 0.5, 0.65], [0.3, 0.25, 0.2, 0.15, 0.2], [0.3, 0.3, 0.2, 0.15, 0.1]],
  edge: [[0.1, 0.2, 0.35, 0.4, 0.25], [0.1, 0.1, 0.15, 0.2, 0.1], [0.1, 0.1, 0.15, 0.2, 0.05]],
  water: [[0.2, 0.05, 0, 0.05, 0.1], [0.2, 0.1, 0, 0.05, 0.1], [0.2, 0.3, 0, 0.05, 0.6]],
  open: [[0.2, 0.2, 0.3, 0.4, 0.2], [0.2, 0.5, 0.6, 0.6, 0.5], [0.2, 0.4, 0.6, 0.6, 0.3]],
  built: [[0.5, 0.05, 0.1, 0.05, 0.05], [0.5, 0.2, 0.2, 0.15, 0.2], [0.5, 0.25, 0.2, 0.15, 0.3]],
  near_road: [[0.3, 0.05, 0.1, 0.1, 0.05], [0.3, 0.6, 0.5, 0.5, 0.6], [0.3, 0.6, 0.5, 0.5, 0.8]],
  signed: [[0.5, 0.2, 0.3, 0.2, 0.2], [0.5, 0.6, 0.5, 0.4, 0.5], [0.5, 0.7, 0.5, 0.4, 0.8]],
  steep: [[0, 0.2, 0.1, 0.05, 0.25], [0, 0.05, 0.03, 0, 0.06], [0, 0.05, 0.03, 0, 0]],
  cobbles: [[0.02, 0, 0, 0, 0], [0.02, 0.01, 0.03, 0, 0.02], [0.02, 0.01, 0.03, 0, 0.04]],
  doubt: [[0, 0.04, 0.02, 0, 0.06], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]],
  maxGrade: [[4, 14, 11, 9, 16], [4, 9, 8, 7, 11], [4, 9, 8, 7, 7]],
};
const SPEED: Record<SurfaceKey, number> = { paved: 23, gravel: 17, dirt: 12, unknown: 13 };

interface Piece extends Feat {
  src: Src;
  coords: LngLat[];
  segs: Seg[];
  profile: [number, number][];
  minutes: number;
}

function cut(src: Src, k: number): Piece {
  const route = ROUTES[src] as RouteData;
  const a = CUTS[src][k] as number;
  const b = Math.min(CUTS[src][k + 1] as number, route.coords.length - 1);
  const km0 = route.cum[a] as number;
  const km1 = route.cum[b] as number;
  const segs: Seg[] = [];
  const surface: Feat["surface"] = {};
  const road: Feat["road"] = {};
  let newKm = 0;
  let hours = 0;
  for (const g of route.segs) {
    const i0 = Math.max(g.i0, a);
    const i1 = Math.min(g.i1, b);
    if (i1 <= i0) continue;
    const from = (route.cum[i0] as number) - km0;
    const to = (route.cum[i1] as number) - km0;
    segs.push({ ...g, i0: i0 - a, i1: i1 - a, from, to });
    surface[g.surface] = (surface[g.surface] ?? 0) + to - from;
    road[g.road] = (road[g.road] ?? 0) + to - from;
    if (g.novel) newKm += to - from;
    hours += (to - from) / SPEED[g.surface];
  }
  const profile = route.profile.filter((p) => p[0] >= km0 && p[0] <= km1).map((p) => [p[0] - km0, p[1]] as [number, number]);
  const up = (ps: [number, number][]) => ps.reduce((sum, p, i) => sum + Math.max(0, p[1] - ((ps[i - 1] ?? p)[1] as number)), 0);
  const allHours = route.segs.reduce((sum, g) => sum + (g.to - g.from) / SPEED[g.surface], 0);
  const i = SRC.indexOf(src);
  return {
    src, coords: route.coords.slice(a, b + 1), segs, profile, km: km1 - km0, surface, road, newKm,
    climb: (up(profile) / up(route.profile)) * route.climb,
    minutes: (hours / allHours) * route.minutes,
    syn: Object.fromEntries(Object.entries(SYN).map(([key, v]) => [key, (v[i] as number[])[k] as number])),
  };
}
const PIECES: Piece[][] = Array.from({ length: N }, (_, k) => SRC.map((src) => cut(src, k)));

function cost(p: Piece, prefs: Prefs, limits: Limits): number {
  let like = 0;
  for (const [id, v] of Object.entries(prefs)) like += (v / 100) * attr(id).share(p) * (id === "climb" ? 2 : 1);
  // a blend of distance and time, bent by how much the profile likes the section
  let c = (p.km * 0.45 + (p.minutes / 60) * 16) * Math.max(0.12, 1 - 0.2 * like);
  for (const [id, v] of Object.entries(limits)) c += 400 * limitDef(id).breaks(p, v === true ? 0 : v);
  return c;
}

const cache = new Map<string, RouteData>();
function join(pick: Piece[]): RouteData {
  const id = pick.map((p) => p.src[0]).join("");
  const hit = cache.get(id);
  if (hit) return hit;
  const out: RouteData = { id, coords: [], cum: [], profile: [], segs: [], km: 0, climb: 0, descent: 0, minutes: 0, surface: {}, road: {}, newKm: 0 };
  for (const p of pick) {
    const i = Math.max(0, out.coords.length - 1);
    const km = out.km;
    const pc = out.coords.length ? p.coords.slice(1) : p.coords;
    out.coords.push(...pc);
    for (const g of p.segs) out.segs.push({ ...g, i0: g.i0 + i, i1: g.i1 + i, from: g.from + km, to: g.to + km });
    for (const q of p.profile) out.profile.push([q[0] + km, q[1]]);
    for (const [key, v] of Object.entries(p.surface)) out.surface[key as SurfaceKey] = (out.surface[key as SurfaceKey] ?? 0) + (v ?? 0);
    for (const [key, v] of Object.entries(p.road)) out.road[key as RoadKey] = (out.road[key as RoadKey] ?? 0) + (v ?? 0);
    out.km += p.km;
    out.climb += p.climb;
    out.minutes += p.minutes;
    out.newKm += p.newKm;
  }
  // distance along the joined line, scaled so it ends on the summed km
  let d = 0;
  const raw = out.coords.map((c, i) => {
    const q = out.coords[i - 1];
    if (q) d += Math.hypot((c[0] - q[0]) * 74.5, (c[1] - q[1]) * 111.2);
    return d;
  });
  out.cum = raw.map((x) => (x / d) * out.km);
  out.climb = Math.round(out.climb);
  out.minutes = Math.round(out.minutes);
  cache.set(id, out);
  return out;
}

/** The toy engine: per section, the cheapest of the three candidates under this profile. */
export function solve(prefs: Prefs, limits: Limits): RouteData {
  return join(PIECES.map((opts) => opts.reduce((best, p) => (cost(p, prefs, limits) < cost(best, prefs, limits) - 1e-9 ? p : best))));
}
/** Where the sections start, in km along a route, and which candidate each one took. */
export function sections(route: RouteData): { from: number; to: number; src: Src }[] {
  let km = 0;
  return [...route.id].map((ch, k) => {
    const p = (PIECES[k] as Piece[]).find((x) => x.src[0] === ch) as Piece;
    km += p.km;
    return { from: km - p.km, to: km, src: p.src };
  });
}

/** "Why this way" notes: one per section and candidate, shown where the route takes that candidate. */
const NOTES: Partial<Record<string, { at: number; title: string; short: string; text: string }>> = {
  "1g": { at: 0.5, title: "Forest track, not the valley road", short: "Track, not the road", text: "Skips 3 km of country road. Costs 90 m of climbing." },
  "1p": { at: 0.45, title: "The valley road", short: "Valley road", text: "The track above tops out at 14 %." },
  "1v": { at: 0.45, title: "The valley road", short: "Valley road", text: "The track above tops out at 14 %." },
  "2g": { at: 0.55, title: "Along the forest edge", short: "Forest edge", text: "The edge beats the shorter line through the trees." },
  "2p": { at: 0.5, title: "Ridge road", short: "Ridge road", text: "Smooth and open; the track beside it is rough." },
  "2v": { at: 0.5, title: "Ridge road", short: "Ridge road", text: "Smooth and open; the track beside it is rough." },
  "4g": { at: 0.55, title: "Never ridden", short: "New to you", text: "Compacted track, fine quality, so new ground wins." },
  "4p": { at: 0.5, title: "Bike path beside the road", short: "Roadside path", text: "Paved all the way, but you hear the traffic." },
  "4v": { at: 0.6, title: "Down the river", short: "Along the river", text: "9 km on the valley floor, hardly a climb." },
};
export function notes(route: RouteData) {
  return sections(route).flatMap((sec, k) => {
    const n = NOTES[`${k}${sec.src[0]}`];
    return n ? [{ ...n, km: sec.from + (sec.to - sec.from) * n.at }] : [];
  });
}
