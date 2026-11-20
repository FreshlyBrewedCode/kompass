// The engine benchmark (docs/engine-web.md "Bench page"): seeded random routes at ~10 / 50 / 100 km
// for the two main presets, in the worker, on whatever region is loaded; profile compiles; matching
// rides made from the routes; the wasm heap along the way. The pairs are generated on the device from
// the loaded graph and only ever held in memory: never shown, logged or stored.
import type { Profile, RouteResult } from "@/engine/generated/types";
import type { EngineInfo, LoadStats } from "@/engine/protocol";

/** What the bench needs of the engine (the store's client in the app, a fake in tests). */
export interface BenchEngine {
  timed(
    method: "route" | "prepare" | "matchRide" | "benchPairs" | "info",
    params?: unknown,
  ): Promise<{
    result: unknown;
    ms: number;
  }>;
}

export type Stat = { n: number; median: number; p95: number; max: number };

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] as number;
}

export function stat(values: readonly number[]): Stat {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    median: percentile(s, 50),
    p95: percentile(s, 95),
    max: s[s.length - 1] ?? Number.NaN,
  };
}

/** Straight-line ranges of the pairs: routes of about 10, 50 and 100 km (the native bench's). */
export const BUCKETS = [
  { label: "~10 km", minKm: 7, maxKm: 9 },
  { label: "~50 km", minKm: 37, maxKm: 43 },
  { label: "~100 km", minKm: 75, maxKm: 85 },
] as const;

export const PRESETS = ["gravel_explorer", "paved_quiet"] as const;

export type RouteRow = {
  bucket: string;
  preset: string;
  /** worker time (search, assembly, JSON) */
  engine: Stat;
  /** what the UI waits: request → result on the main thread */
  roundTrip: Stat;
  km: number;
  resultKb: number;
  failed: number;
};

export type BenchReport = {
  userAgent: string;
  load: LoadStats;
  firstRouteMs: number;
  routes: RouteRow[];
  compile: { preset: string; ms: Stat }[];
  match: { rides: number; ms: Stat; matchedShare: number; km: number } | null;
  heap: { label: string; wasmBytes: number; engineBytes: number }[];
};

/** A small deterministic PRNG for the GPS noise (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fake recorded ride along a route line: a point every `stepM` metres, ±`noiseM` of GPS noise. */
export function rideAlong(
  coords: readonly (readonly number[])[],
  stepM: number,
  noiseM: number,
  random: () => number,
): { lat: Float64Array; lon: Float64Array } {
  const lat: number[] = [];
  const lon: number[] = [];
  const M = 111_195;
  let carry = 0;
  for (let i = 0; i + 1 < coords.length; i++) {
    const [x0, y0] = coords[i] as [number, number];
    const [x1, y1] = coords[i + 1] as [number, number];
    const k = Math.cos((y0 * Math.PI) / 180);
    const len = Math.hypot((x1 - x0) * k, y1 - y0) * M;
    let at = carry;
    for (; at < len; at += stepM) {
      const t = len > 0 ? at / len : 0;
      const n = () => ((random() * 2 - 1) * noiseM) / M;
      lat.push(y0 + (y1 - y0) * t + n());
      lon.push(x0 + (x1 - x0) * t + n() / k);
    }
    carry = at - len;
  }
  return { lat: Float64Array.from(lat), lon: Float64Array.from(lon) };
}

const engineBytes = (info: EngineInfo) => Object.values(info.heap).reduce((a, b) => a + b, 0);

export type BenchOptions = {
  seed: number;
  /** pairs per bucket (each routed with both presets) */
  pairs: number;
  /** rides to match (made from the ~50 km routes) */
  rides: number;
  onStatus?: (text: string) => void;
};

/** Runs the bench on a loaded engine. */
export async function runBench(
  engine: BenchEngine,
  load: LoadStats,
  presets: { id: string; profile: Profile }[],
  { seed, pairs, rides, onStatus }: BenchOptions,
): Promise<BenchReport> {
  const call = engine.timed.bind(engine);
  const info = async () => (await call("info")).result as EngineInfo;
  const heap: BenchReport["heap"] = [];
  const snapshot = async (label: string) => {
    const i = await info();
    heap.push({ label, wasmBytes: i.wasmBytes, engineBytes: engineBytes(i) });
  };
  await snapshot("after load");

  const byId = new Map(presets.map((p) => [p.id, p.profile]));
  const profiles = PRESETS.map((id) => ({ id, profile: byId.get(id) })).filter(
    (p): p is { id: (typeof PRESETS)[number]; profile: Profile } => p.profile !== undefined,
  );
  const routes: RouteRow[] = [];
  let firstRouteMs = Number.NaN;
  let routed = 0;
  const lines: (readonly (readonly number[])[])[] = [];

  for (const [b, bucket] of BUCKETS.entries()) {
    const flat = (
      await call("benchPairs", { seed: seed + b, minKm: bucket.minKm, maxKm: bucket.maxKm, n: pairs })
    ).result as Float64Array;
    for (const { id, profile } of profiles) {
      onStatus?.(`routing ${bucket.label}, ${id}`);
      const engineMs: number[] = [];
      const trip: number[] = [];
      const km: number[] = [];
      const kb: number[] = [];
      let failed = 0;
      for (let i = 0; i + 3 < flat.length; i += 4) {
        const waypoints = [
          { lon: flat[i] as number, lat: flat[i + 1] as number },
          { lon: flat[i + 2] as number, lat: flat[i + 3] as number },
        ];
        const t = performance.now();
        const { result, ms } = await call("route", {
          waypoints,
          profile,
          options: { snap_radius_m: 50, geometry: true },
        });
        const roundTrip = performance.now() - t;
        if (Number.isNaN(firstRouteMs)) firstRouteMs = roundTrip;
        routed++;
        const outcome = result as { ok: true; result: RouteResult } | { ok: false };
        if (!outcome.ok) {
          failed++;
          continue;
        }
        engineMs.push(ms);
        trip.push(roundTrip);
        km.push(outcome.result.summary.distance_m / 1000);
        kb.push(JSON.stringify(outcome.result).length / 1024);
        const coords = outcome.result.geometry?.coordinates;
        if (b === 1 && id === profiles[0]?.id && coords) lines.push(coords);
      }
      routes.push({
        bucket: bucket.label,
        preset: id,
        engine: stat(engineMs),
        roundTrip: stat(trip),
        km: stat(km).median,
        resultKb: stat(kb).median,
        failed,
      });
    }
  }
  await snapshot(`after ${routed} routes`);

  // compiles: a profile the planner has not seen yet (a tiny weight change makes a new cost key)
  const compile: BenchReport["compile"] = [];
  for (const { id, profile } of profiles) {
    onStatus?.(`compiling ${id}`);
    const ms: number[] = [];
    for (let k = 1; k <= 5; k++) {
      const variant = { ...profile, weights: { ...profile.weights, unpaved: 40 + k } } as Profile;
      ms.push((await call("prepare", variant)).ms);
    }
    compile.push({ preset: id, ms: stat(ms) });
  }

  let match: BenchReport["match"] = null;
  if (rides > 0 && lines.length > 0) {
    const random = rng(seed);
    const ms: number[] = [];
    let track = 0;
    let matched = 0;
    for (let r = 0; r < rides; r++) {
      onStatus?.(`matching ride ${r + 1} of ${rides}`);
      const ride = rideAlong(lines[r % lines.length] as readonly (readonly number[])[], 5, 3, random);
      const { result, ms: t } = await call("matchRide", ride);
      const m = result as { trackM: number; matchedM: number };
      ms.push(t);
      track += m.trackM;
      matched += m.matchedM;
    }
    match = { rides, ms: stat(ms), matchedShare: track > 0 ? matched / track : 0, km: track / 1000 };
    await snapshot(`after matching ${rides} rides`);
  }
  onStatus?.("done");
  return {
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    load,
    firstRouteMs,
    routes,
    compile,
    match,
    heap,
  };
}

const f = (n: number, digits = 1) => (Number.isFinite(n) ? n.toFixed(digits) : "–");
const mb = (bytes: number) => `${f(bytes / 1024 / 1024)} MB`;
const s3 = (s: Stat) => `${f(s.median)} / ${f(s.p95)} / ${f(s.max)}`;

/** The report as plain text (Markdown tables), to copy off a phone. */
export function reportText(r: BenchReport): string {
  const l = r.load;
  const out = [
    `Kompass engine bench — ${r.userAgent}`,
    "",
    `region: ${l.info.edges.toLocaleString("en")} edges, ${l.info.tiles} tiles, geometry ${l.geometry} (${l.info.geometryTiles} tiles loaded)`,
    `download: ${l.downloadedFiles} files, ${mb(l.downloadedBytes)} in ${f(l.downloadMs, 0)} ms${l.cached ? "" : " (no device cache)"}`,
    `load: ${f(l.loadMs, 0)} ms (planner build ${f(l.finishMs, 0)} ms); first route ${f(r.firstRouteMs, 0)} ms`,
    "",
    "| route | preset | n | engine ms p50 / p95 / max | round trip ms p50 / p95 / max | km p50 | result KB | failed |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
    ...r.routes.map(
      (x) =>
        `| ${x.bucket} | ${x.preset} | ${x.engine.n} | ${s3(x.engine)} | ${s3(x.roundTrip)} | ${f(x.km)} | ${f(x.resultKb, 0)} | ${x.failed} |`,
    ),
    "",
    "| profile compile | ms p50 / p95 / max |",
    "|---|---:|",
    ...r.compile.map((c) => `| ${c.preset} | ${s3(c.ms)} |`),
  ];
  if (r.match) {
    out.push(
      "",
      `matching: ${r.match.rides} rides, ${f(r.match.km, 0)} km, ms per ride p50 / p95 / max ${s3(r.match.ms)}, matched ${f(r.match.matchedShare * 100)} %`,
    );
  }
  out.push(
    "",
    "| wasm heap | linear memory | engine accounts for |",
    "|---|---:|---:|",
    ...r.heap.map((h) => `| ${h.label} | ${mb(h.wasmBytes)} | ${mb(h.engineBytes)} |`),
  );
  return out.join("\n");
}
