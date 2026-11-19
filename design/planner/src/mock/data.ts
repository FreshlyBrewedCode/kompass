import raw from "./routes.json";

export type SurfaceKey = "paved" | "gravel" | "dirt" | "unknown";
export type RoadKey = "path" | "track" | "cycleway" | "quiet" | "minor" | "main";
export type LngLat = [number, number];

export interface Seg {
  i0: number;
  i1: number;
  from: number;
  to: number;
  surface: SurfaceKey;
  road: RoadKey;
  novel: boolean;
}

export interface RouteData {
  id: string;
  coords: LngLat[];
  cum: number[];
  profile: [number, number][];
  segs: Seg[];
  km: number;
  climb: number;
  descent: number;
  minutes: number;
  surface: Partial<Record<SurfaceKey, number>>;
  road: Partial<Record<RoadKey, number>>;
  newKm: number;
}

const data = raw as unknown as {
  routes: Record<string, Omit<RouteData, "id">>;
  history: { count: number; coords: LngLat[] }[];
};

export const ROUTES: Record<string, RouteData> = Object.fromEntries(
  Object.entries(data.routes).map(([id, r]) => [id, { id, ...r }]),
);
export const HISTORY = data.history;

/** Shared data encodings: the same colours mean the same thing in every direction. */
export const SURFACES: { key: SurfaceKey; label: string; color: string }[] = [
  { key: "paved", label: "Paved", color: "#6f7f96" },
  { key: "gravel", label: "Gravel", color: "#e2a12b" },
  { key: "dirt", label: "Dirt & grass", color: "#a2683a" },
  { key: "unknown", label: "Unknown", color: "#b9b4aa" },
];
export const ROADS: { key: RoadKey; label: string; color: string }[] = [
  { key: "path", label: "Path", color: "#2f9e62" },
  { key: "track", label: "Forest track", color: "#8fb93a" },
  { key: "cycleway", label: "Bike path", color: "#1fa3c4" },
  { key: "quiet", label: "Quiet street", color: "#98a2ae" },
  { key: "minor", label: "Minor road", color: "#f0a020" },
  { key: "main", label: "Main road", color: "#e0483a" },
];
export const surfaceColor = (k: SurfaceKey) => SURFACES.find((s) => s.key === k)?.color ?? "#999";
export const roadColor = (k: RoadKey) => ROADS.find((s) => s.key === k)?.color ?? "#999";
export const NOVEL_COLOR = { novel: "#c2409a", ridden: "#8d98a5" };

export type SoftKey = "gravel" | "bikepath" | "quiet" | "forest" | "edge" | "water" | "climb" | "novelty";
export type HardKey = "noMain" | "pavedOnly" | "maxGrade" | "noUnknown" | "noStairs";

export const SOFT: { key: SoftKey; label: string; short: string; lo: string; hi: string; phrase: string }[] = [
  { key: "gravel", label: "Gravel & forest tracks", short: "Gravel", lo: "avoid", hi: "seek", phrase: "gravel and forest tracks" },
  { key: "bikepath", label: "Paved bike paths off the road", short: "Bikeway", lo: "avoid", hi: "seek", phrase: "paved bike paths away from the road" },
  { key: "quiet", label: "Low traffic", short: "Quiet", lo: "don't care", hi: "must be calm", phrase: "quiet roads" },
  { key: "forest", label: "Through forest", short: "Forest", lo: "avoid", hi: "seek", phrase: "deep forest" },
  { key: "edge", label: "Forest edges", short: "Edges", lo: "avoid", hi: "seek", phrase: "forest edges" },
  { key: "water", label: "Rivers & lakes", short: "Water", lo: "avoid", hi: "seek", phrase: "rivers and lakes" },
  { key: "climb", label: "Climbing", short: "Climb", lo: "keep it flat", hi: "bring it on", phrase: "climbing" },
  { key: "novelty", label: "Never ridden", short: "New", lo: "familiar", hi: "explore", phrase: "segments I have never ridden" },
];
export const HARD: { key: HardKey; label: string; short: string }[] = [
  { key: "noMain", label: "No main roads", short: "No main rd" },
  { key: "pavedOnly", label: "Paved only", short: "Paved only" },
  { key: "maxGrade", label: "Nothing steeper than 12 %", short: "Max 12 %" },
  { key: "noUnknown", label: "No unknown surface", short: "No unknown" },
  { key: "noStairs", label: "No stairs or carrying", short: "No stairs" },
];

export interface Profile {
  id: string;
  name: string;
  blurb: string;
  routeId: string;
  color: string;
  soft: Record<SoftKey, number>; // -100 (avoid) … 0 (neutral) … +100 (seek)
  hard: Record<HardKey, boolean>;
}

export const PROFILES: Profile[] = [
  {
    id: "gravel",
    name: "Gravel explorer",
    blurb: "Tracks, forest edges, something new",
    routeId: "gravel",
    color: "#e4572e",
    soft: { gravel: 80, bikepath: 10, quiet: 60, forest: 20, edge: 60, water: 10, climb: 20, novelty: 70 },
    hard: { noMain: true, pavedOnly: false, maxGrade: false, noUnknown: false, noStairs: true },
  },
  {
    id: "paved",
    name: "Paved & quiet",
    blurb: "Bike paths and small roads, no surprises",
    routeId: "paved",
    color: "#2b7fff",
    soft: { gravel: -70, bikepath: 80, quiet: 70, forest: 0, edge: 10, water: 30, climb: -40, novelty: 0 },
    hard: { noMain: false, pavedOnly: true, maxGrade: true, noUnknown: true, noStairs: true },
  },
  {
    id: "valley",
    name: "River valley",
    blurb: "Flat, along the water, easy legs",
    routeId: "valley",
    color: "#12a594",
    soft: { gravel: 0, bikepath: 50, quiet: 20, forest: -20, edge: 0, water: 90, climb: -80, novelty: -20 },
    hard: { noMain: false, pavedOnly: false, maxGrade: true, noUnknown: false, noStairs: true },
  },
];

export interface Waypoint {
  id: string;
  name: string;
  note: string;
  lngLat: LngLat;
}

const g = ROUTES.gravel as RouteData;
const nearest = (p: LngLat): LngLat =>
  g.coords.reduce((best, c) => (Math.hypot(c[0] - p[0], c[1] - p[1]) < Math.hypot(best[0] - p[0], best[1] - p[1]) ? c : best));

export const WAYPOINTS: Waypoint[] = [
  { id: "w-a", name: "Kirchzarten", note: "Station forecourt", lngLat: g.coords[0] as LngLat },
  { id: "w-1", name: "St. Peter", note: "Abbey square", lngLat: nearest([8.033, 48.017]) },
  { id: "w-2", name: "St. Märgen", note: "Ridge viewpoint", lngLat: nearest([8.093, 48.008]) },
  { id: "w-b", name: "Titisee", note: "Lake shore", lngLat: g.coords[g.coords.length - 1] as LngLat },
];
export const SPARE_WAYPOINTS: Waypoint[] = [
  { id: "w-x1", name: "Thurner pass", note: "Added on the map", lngLat: nearest([8.118, 47.975]) },
  { id: "w-x2", name: "Breitnau", note: "Added on the map", lngLat: nearest([8.09, 47.94]) },
  { id: "w-x3", name: "Eschbach valley", note: "Added on the map", lngLat: nearest([7.99, 47.99]) },
];

/** Hand-written "why this way" notes, placed along the gravel route by km. */
export const WHY: { km: number; title: string; short: string; text: string; delta: string }[] = [
  { km: 6.2, title: "Forest track, not the valley road", short: "Track, not the road", text: "Skips 3.1 km of the L-road. Costs 90 m of climbing.", delta: "+0.8 km" },
  { km: 24.5, title: "Along the forest edge", short: "Forest edge", text: "Edge bonus beats the shorter track through the trees.", delta: "+0.4 km" },
  { km: 31.5, title: "Never ridden", short: "New to you", text: "Compacted track, quality is fine, so novelty wins.", delta: "+1.1 km" },
];

export function pointAtKm(r: RouteData, km: number): LngLat {
  const i = r.cum.findIndex((c) => c >= km);
  return r.coords[i < 0 ? r.coords.length - 1 : i] as LngLat;
}
export function kmOf(r: RouteData, p: LngLat): number {
  let bi = 0;
  let bd = Number.POSITIVE_INFINITY;
  r.coords.forEach((c, i) => {
    const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  });
  return r.cum[bi] ?? 0;
}

export const fmtKm = (km: number) => (km >= 100 ? km.toFixed(0) : km.toFixed(1));
export const fmtTime = (min: number) => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, "0")}`;
export const pct = (part: number, whole: number) => Math.round((part / whole) * 100);
export const unpavedKm = (r: RouteData) => (r.surface.gravel ?? 0) + (r.surface.dirt ?? 0) + (r.surface.unknown ?? 0);

/** Rows for a two-route comparison. `better` says which direction is good for the metric. */
export function compareRows(a: RouteData, b: RouteData) {
  const row = (label: string, av: number, bv: number, unit: string, f: (n: number) => string = fmtKm) => ({
    label, a: `${f(av)}${unit}`, b: `${f(bv)}${unit}`, delta: bv - av, deltaText: `${bv - av >= 0 ? "+" : "−"}${f(Math.abs(bv - av))}${unit}`,
  });
  const int = (n: number) => String(Math.round(n));
  return [
    row("Distance", a.km, b.km, " km"),
    row("Climb", a.climb, b.climb, " m", int),
    { ...row("Time", a.minutes, b.minutes, "", fmtTime), deltaText: `${b.minutes - a.minutes >= 0 ? "+" : "−"}${Math.abs(b.minutes - a.minutes)} min` },
    row("Unpaved", unpavedKm(a), unpavedKm(b), " km"),
    row("Main road", a.road.main ?? 0, b.road.main ?? 0, " km"),
    row("New to me", a.newKm, b.newKm, " km"),
  ];
}

export function legs(route: RouteData, wps: Waypoint[]) {
  return wps.slice(0, -1).map((w, i) => {
    const from = kmOf(route, w.lngLat);
    const to = kmOf(route, (wps[i + 1] as Waypoint).lngLat);
    return { from: Math.min(from, to), to: Math.max(from, to), km: Math.abs(to - from) };
  });
}
