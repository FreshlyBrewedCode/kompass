/// <reference lib="webworker" />
// The ride worker: owns the ride library (IndexedDB), parses files, builds the map layer. A dedicated
// worker apart from the engine's wasm worker. Requests run one at a time, in order, so an import and
// a delete can never interleave.
import { exportBackup, importBackup } from "./backup";
import { RideLibrary } from "./library";
import {
  type BackupResult,
  handleRideRequest,
  type RideHandlers,
  type RideRequest,
  type RidesGeoJson,
  type RidesLayerData,
} from "./protocol";
import type { FileResult } from "./types";

let opened: Promise<RideLibrary> | null = null;
const library = () => {
  opened ??= RideLibrary.open();
  return opened;
};

async function layer(lib: RideLibrary): Promise<RidesLayerData> {
  const lines = await lib.lines();
  const features: RidesGeoJson["features"] = [];
  for (const [id, coordinates] of lines) {
    features.push({ type: "Feature", properties: { id }, geometry: { type: "LineString", coordinates } });
  }
  const collection: RidesGeoJson = { type: "FeatureCollection", features };
  if (typeof URL.createObjectURL !== "function") return collection;
  return URL.createObjectURL(new Blob([JSON.stringify(collection)], { type: "application/geo+json" }));
}

const handlers: RideHandlers = {
  init: async () => (await library()).listRides(),
  list: async () => (await library()).listRides(),

  importFiles: async ({ files }, progress) => {
    const lib = await library();
    const results: FileResult[] = [];
    for (const file of files) {
      let result: FileResult;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        result = { file: file.name, outcome: await lib.importFile(file.name, bytes) };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        result = {
          file: file.name,
          outcome: { status: "failed", reason: `could not read the file: ${reason}` },
        };
      }
      results.push(result);
      progress({ done: results.length, total: files.length, file: file.name, result });
    }
    return results;
  },

  deleteRides: async ({ ids }) => {
    const lib = await library();
    await lib.deleteRides(ids);
    return lib.listRides();
  },
  deleteAll: async () => {
    const lib = await library();
    await lib.deleteAll();
    return lib.listRides();
  },

  layer: async () => layer(await library()),

  exportBackup: async (_params, progress) =>
    exportBackup(await library(), ({ done, total }) => progress({ done, total })),
  importBackup: async ({ file }, progress) => {
    const lib = await library();
    const { total, outcomes } = await importBackup(lib, file, ({ done, total: all }) =>
      progress({ done, total: all }),
    );
    const count = (status: string) => outcomes.filter((o) => o.status === status).length;
    const result: BackupResult = {
      total,
      imported: count("imported"),
      duplicates: count("duplicate"),
      known: count("known"),
      failed: count("failed"),
    };
    return result;
  },

  points: async ({ id }) => (await library()).getPoints(id),
  saveMatch: async ({ id, ...match }) => {
    await (await library()).saveMatch(id, match);
  },
  clearMatches: async () => {
    await (await library()).clearMatches();
  },
  explored: async ({ graphBuild }) => (await library()).exploredInput(graphBuild),
};

let queue: Promise<unknown> = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<RideRequest>) => {
  const request = event.data;
  queue = queue.then(async () => {
    self.postMessage(await handleRideRequest(handlers, request, (response) => self.postMessage(response)));
  });
});
