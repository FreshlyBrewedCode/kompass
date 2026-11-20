// Messages between the app and the ride worker (worker.ts), the dedicated worker that owns the
// IndexedDB store: parsing, hashing, dedup, storing, the map layer and the backup all happen there,
// so the UI thread never touches track data. Same request/response shape as the engine's protocol,
// plus progress events for long jobs.
import type { RideInfo } from "@/history/explored-store";
import type { FileResult, MatchInput, MatchStatus, RidePoints, RideSummary } from "./types";

/** A GeoJSON line layer, one feature per ride (`properties.id`). */
export type RidesGeoJson = {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    properties: { id: string };
    geometry: { type: "LineString"; coordinates: [number, number][] };
  }[];
};

/**
 * The layer as the worker hands it over: a `blob:` URL of the GeoJSON where the browser allows (the map
 * parses it in its own worker, so the UI thread never touches the coordinates), else the object itself.
 */
export type RidesLayerData = RidesGeoJson | string;

export type BackupResult = {
  total: number;
  imported: number;
  duplicates: number;
  known: number;
  failed: number;
};

export interface RideMethods {
  /** open the store; the summaries, newest first */
  init: { params: undefined; result: RideSummary[] };
  list: { params: undefined; result: RideSummary[] };
  /** import files one after another (progress events carry each file's result) */
  importFiles: { params: { files: File[] }; result: FileResult[] };
  deleteRides: { params: { ids: string[] }; result: RideSummary[] };
  deleteAll: { params: undefined; result: RideSummary[] };
  /** the "My rides" map layer, simplified lines built from the stored ones */
  layer: { params: undefined; result: RidesLayerData };
  exportBackup: { params: undefined; result: Blob };
  importBackup: { params: { file: Blob }; result: BackupResult };
  // the map-matching seam (docs/rides.md)
  points: { params: { id: string }; result: RidePoints | null };
  saveMatch: { params: { id: string } & MatchInput; result: undefined };
  clearMatches: { params: undefined; result: undefined };
  explored: { params: { graphBuild: string }; result: Map<number, RideInfo> };
  /** the saved matches of this graph build, without their arcs (which rides are done, how well) */
  matchStatus: { params: { graphBuild: string }; result: MatchStatus[] };
}

export type RideMethod = keyof RideMethods;
export type RideParams<M extends RideMethod> = RideMethods[M]["params"];
export type RideResult<M extends RideMethod> = RideMethods[M]["result"];

export interface RideRequest<M extends RideMethod = RideMethod> {
  id: number;
  method: M;
  params: RideParams<M>;
}

/** What a long job reports along the way. */
export type RideProgress = {
  done: number;
  total: number;
  /** the file or ride just finished */
  file?: string;
  result?: FileResult;
};

export type RideResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  | { id: number; progress: RideProgress };

export type RideHandlers = {
  [M in RideMethod]: (
    params: RideParams<M>,
    progress: (p: RideProgress) => void,
  ) => RideResult<M> | Promise<RideResult<M>>;
};

/** Runs one request against the handlers; a thrown error becomes an error response. */
export async function handleRideRequest(
  handlers: RideHandlers,
  request: RideRequest,
  progress: (response: RideResponse) => void,
): Promise<RideResponse> {
  try {
    const handler = handlers[request.method] as (
      params: unknown,
      progress: (p: RideProgress) => void,
    ) => unknown;
    const result = await handler(request.params, (p) => progress({ id: request.id, progress: p }));
    return { id: request.id, ok: true, result };
  } catch (error) {
    return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
