/// <reference lib="webworker" />
// The ride worker: owns the ride library (IndexedDB), parses files, builds the map layer. A dedicated
// worker apart from the engine's wasm worker. Requests run one at a time, in order, so an import and
// a delete can never interleave.

import { transferables } from "@/engine/protocol";
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
import { baseName, countZipEntries, isZip, unzipEntries } from "./zip";

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
    // the work in items (a loose file is one, a zip as many as it lists), so progress runs over all of it
    const plan = await Promise.all(
      files.map(async (file) => {
        const zip = await isZip(file).catch(() => false);
        return { file, zip, items: zip ? Math.max(1, await countZipEntries(file).catch(() => 0)) : 1 };
      }),
    );
    const total = plan.reduce((sum, p) => sum + p.items, 0);
    let done = 0;
    const report = (file: string, result?: FileResult) => {
      if (result) results.push(result);
      progress({ done: Math.min(++done, total), total, file, ...(result ? { result } : {}) });
    };
    for (const { file, zip } of plan) {
      try {
        if (zip) {
          let rides = 0;
          for await (const entry of unzipEntries(file)) {
            rides++;
            const name = baseName(entry.path);
            if ("bytes" in entry) {
              report(name, { file: name, outcome: await lib.importFile(name, entry.bytes) });
            } else {
              report(name, { file: name, outcome: { status: "failed", reason: entry.reason } });
            }
          }
          if (rides === 0) {
            const reason = "no GPX or FIT files in the zip";
            report(file.name, { file: file.name, outcome: { status: "failed", reason } });
          }
        } else {
          const bytes = new Uint8Array(await file.arrayBuffer());
          report(file.name, { file: file.name, outcome: await lib.importFile(file.name, bytes) });
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        report(file.name, {
          file: file.name,
          outcome: { status: "failed", reason: `could not read the file: ${reason}` },
        });
      }
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
  matchStatus: async ({ graphBuild }) => (await library()).matchStatus(graphBuild),
};

let queue: Promise<unknown> = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<RideRequest>) => {
  const request = event.data;
  queue = queue.then(async () => {
    const response = await handleRideRequest(handlers, request, (response) => self.postMessage(response));
    // a ride's points move to the thread that asked (to the matcher) instead of being copied
    self.postMessage(response, "ok" in response && response.ok ? transferables(response.result) : []);
  });
});
