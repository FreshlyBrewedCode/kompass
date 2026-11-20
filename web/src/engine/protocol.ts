// The messages between the app and the engine worker (docs/engine-web.md). Every method is a
// request/response pair; the client (client.ts) numbers requests and matches the answers. The worker
// also sends events without an id (load progress).

import type { GraphFiles } from "@/map/manifest";
import type {
  ArcExplanation,
  Catalogue,
  DiffRequest,
  Preset,
  Profile,
  RouteDiff,
  RouteError,
  RouteRequest,
  RouteResult,
} from "./generated/types";

/**
 * How geometry tiles reach the engine. `eager`: all of them before the planner is built (the snapping
 * grid follows the real ways). `lazy`: none up front; a route or a match loads the tiles it touches
 * (the snapping grid then uses straight segments). All files are cached on the device either way.
 */
export type GeometryMode = "eager" | "lazy";

export type LoadParams = {
  /** the region's data URL (absolute, ending in a slash): the graph files are relative to it */
  dataUrl: string;
  graph: GraphFiles;
  geometry?: GeometryMode;
};

export type LoadPhase = "download" | "load";

/** Bytes of the phase done / to do. Downloads count what goes over the wire (gzip). */
export type LoadProgress = { phase: LoadPhase; done: number; total: number; files: number };

export type HeapStats = {
  graph: number;
  planner: number;
  snapGrid: number;
  matchGrids: number;
  matcher: number;
};

export type EngineInfo = {
  buildId: string;
  nodes: number;
  edges: number;
  tiles: number;
  geometryTiles: number;
  missingTiles: number;
  /** heap bytes the engine accounts for, by part */
  heap: HeapStats;
  /** the wasm linear memory (it only grows): what the engine costs the tab */
  wasmBytes: number;
};

export type LoadStats = {
  buildId: string;
  /** whether the device cache was used (false: no Cache API, e.g. not a secure context) */
  cached: boolean;
  /** files and bytes fetched over the network (0 when everything was cached) */
  downloadedFiles: number;
  downloadedBytes: number;
  downloadMs: number;
  /** reading the files and adding them to the engine, then building the planner */
  loadMs: number;
  finishMs: number;
  geometry: GeometryMode;
  info: EngineInfo;
};

/** `route` never throws for a route that cannot be made: that is an answer too. */
export type RouteOutcome = { ok: true; result: RouteResult } | { ok: false; error: RouteError };

export type SnapHit = { edge: number; fraction: number; distanceM: number; lon: number; lat: number };

/** A map-matched ride (docs/matching.md), for the ride store's matching seam. */
export type RideMatchResult = {
  /** the graph build the arcs belong to */
  graphBuild: string;
  /** `edge << 1 | reverse`, riding order */
  arcs: Uint32Array;
  /** per arc: the covered share of the edge × 255 */
  coverage: Uint8Array;
  /** per arc: the first track point on it */
  firstPoint: Uint32Array;
  /** per unmatched stretch: first point, last point, metres */
  unmatched: Float64Array;
  trackM: number;
  matchedM: number;
  pathM: number;
  breaks: number;
  /** geometry tiles that had to be loaded for it */
  tilesLoaded: number;
};

export type PersonalParams = { rides: Uint16Array; lastRidden: Uint32Array; today: number };

/** What the engine answers to: params in, result out. */
export interface EngineMethods {
  version: { params: undefined; result: string };
  presets: { params: undefined; result: Preset[] };
  /** with the loaded region's coverage, else the plain catalogue */
  catalogue: { params: undefined; result: Catalogue };
  load: { params: LoadParams; result: LoadStats };
  info: { params: undefined; result: EngineInfo };
  route: { params: RouteRequest; result: RouteOutcome };
  prepare: { params: Profile; result: undefined };
  diff: { params: DiffRequest; result: RouteDiff };
  explain: { params: { profile: Profile; arcs: number[] }; result: ArcExplanation[] };
  arcCosts: { params: Profile; result: Float32Array };
  setPersonal: { params: PersonalParams | null; result: undefined };
  snap: { params: { lon: number; lat: number; radiusM?: number }; result: SnapHit | null };
  matchRide: { params: { lat: Float64Array; lon: Float64Array }; result: RideMatchResult };
  /** seeded random pairs `[lon, lat, lon, lat]*` of the loaded graph (the bench page; never stored) */
  benchPairs: { params: { seed: number; minKm: number; maxKm: number; n: number }; result: Float64Array };
}

export type EngineMethod = keyof EngineMethods;
export type Params<M extends EngineMethod> = EngineMethods[M]["params"];
export type Result<M extends EngineMethod> = EngineMethods[M]["result"];

export interface EngineRequest<M extends EngineMethod = EngineMethod> {
  id: number;
  method: M;
  params: Params<M>;
}

/** `ms`: the time the worker spent on the request (excluding the queue and the message passing). */
export type EngineResponse =
  | { id: number; ok: true; result: unknown; ms: number }
  | { id: number; ok: false; error: string; ms: number };

export type EngineEvent = { event: "progress"; progress: LoadProgress };

export type WorkerMessage = EngineResponse | EngineEvent;

export function isEvent(message: WorkerMessage): message is EngineEvent {
  return "event" in message;
}

/** The worker side: one handler per method. */
export type EngineHandlers = { [M in EngineMethod]: (params: Params<M>) => Result<M> | Promise<Result<M>> };

/** Runs one request against the handlers and never throws: errors become `ok: false`. */
export async function handleRequest(
  handlers: Partial<EngineHandlers>,
  request: EngineRequest,
  now: () => number = () => performance.now(),
): Promise<EngineResponse> {
  const start = now();
  try {
    const handler = handlers[request.method] as ((params: unknown) => unknown) | undefined;
    if (!handler) throw new Error(`unknown engine method: ${String(request.method)}`);
    const result = await handler(request.params);
    return { id: request.id, ok: true, result, ms: now() - start };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ms: now() - start,
    };
  }
}

/** The buffers of the typed arrays in a result (top level or one level down), to transfer them. */
export function transferables(value: unknown): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (v: unknown) => {
    if (ArrayBuffer.isView(v) && v.buffer instanceof ArrayBuffer) out.add(v.buffer);
  };
  add(value);
  if (value && typeof value === "object" && !ArrayBuffer.isView(value)) {
    for (const v of Object.values(value)) add(v);
  }
  return [...out];
}
