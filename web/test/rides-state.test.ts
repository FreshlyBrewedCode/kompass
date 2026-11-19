import { describe, expect, test } from "bun:test";
import { ExploredStore } from "../src/history/explored-store";
import { createRidesClient, type RidesWorkerLike } from "../src/rides/client";
import { describeSummary, formatBytes, formatDistance, summarizeImport } from "../src/rides/format";
import type { RideHandlers, RideRequest, RideResponse } from "../src/rides/protocol";
import { handleRideRequest } from "../src/rides/protocol";
import { RidesState } from "../src/rides/state";
import type { FileResult, RideSummary } from "../src/rides/types";

const ride = (over: Partial<RideSummary> = {}): RideSummary => ({
  id: "r1",
  name: null,
  sport: null,
  startTime: 1000,
  endTime: 2000,
  distanceM: 5000,
  pointCount: 10,
  hasTime: true,
  hasElevation: false,
  bounds: [0, 0, 1, 1],
  source: "a.gpx",
  alsoSeenAs: [],
  hashes: [],
  notes: [],
  importedAt: 0,
  bytes: 100,
  ...over,
});

/** A ride worker that answers from handlers in a microtask. */
function fakeWorker(handlers: Partial<RideHandlers>): RidesWorkerLike {
  let listener: ((event: MessageEvent<RideResponse>) => void) | undefined;
  const emit = (data: RideResponse) => listener?.({ data } as MessageEvent<RideResponse>);
  return {
    postMessage(message: RideRequest) {
      void handleRideRequest(handlers as RideHandlers, message, emit).then(emit);
    },
    addEventListener(_type, l) {
      listener = l;
    },
    terminate() {},
  };
}

describe("format", () => {
  test("distances, sizes and the import summary read well", () => {
    expect(formatDistance(4200)).toBe("4.2 km");
    expect(formatDistance(42_300)).toBe("42 km");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(20_500)).toBe("20 kB");
    expect(formatBytes(10.3 * 1024 ** 2)).toBe("10 MB");
    const results: FileResult[] = [
      { file: "a", outcome: { status: "imported", ride: ride(), replaced: 0 } },
      { file: "b", outcome: { status: "imported", ride: ride({ hasTime: false }), replaced: 1 } },
      { file: "c", outcome: { status: "duplicate", keptId: "r1", keptSource: "a" } },
      { file: "d", outcome: { status: "known" } },
      { file: "e", outcome: { status: "failed", reason: "nope" } },
    ];
    const summary = summarizeImport(results);
    expect(summary).toEqual({ imported: 2, replaced: 1, duplicates: 1, known: 1, failed: 1, withoutTime: 1 });
    expect(describeSummary(summary)).toBe("2 imported, 1 duplicate skipped, 1 already imported, 1 failed");
    expect(describeSummary(summarizeImport([]))).toBe("Nothing to import");
  });
});

describe("ride client and state", () => {
  test("progress events reach the caller before the result", async () => {
    const client = createRidesClient(
      fakeWorker({
        importFiles: async ({ files }, progress) => {
          progress({ done: 1, total: files.length });
          progress({ done: 2, total: files.length });
          return [];
        },
      }),
    );
    const seen: number[] = [];
    await client.call("importFiles", { files: [new File([""], "a"), new File([""], "b")] }, (p) =>
      seen.push(p.done),
    );
    expect(seen).toEqual([1, 2]);
  });

  test("an error in the worker rejects the call", async () => {
    const client = createRidesClient(
      fakeWorker({
        list: () => {
          throw new Error("disk full");
        },
      }),
    );
    await expect(client.call("list", undefined)).rejects.toThrow("disk full");
  });

  test("loads the list, runs an import with progress and reports the result", async () => {
    const rides = [ride()];
    const state = new RidesState(
      createRidesClient(
        fakeWorker({
          init: () => rides,
          list: () => rides,
          layer: () => ({ type: "FeatureCollection", features: [] }),
          explored: () => new Map(),
          importFiles: async ({ files }, progress) => {
            progress({ done: 1, total: files.length });
            return [{ file: "a.gpx", outcome: { status: "known" as const } }];
          },
        }),
      ),
      undefined,
    );
    expect(state.getSnapshot().phase).toBe("loading");
    await state.init();
    expect(state.getSnapshot().phase).toBe("ready");
    expect(state.getSnapshot().rides).toHaveLength(1);
    await state.importFiles([new File(["x"], "a.gpx")]);
    const { report, busy } = state.getSnapshot();
    expect(busy).toBeNull();
    expect(report).toMatchObject({ kind: "files", text: "1 already imported" });
  });

  test("a worker that cannot open the store is an error state, not a crash", async () => {
    const state = new RidesState(
      createRidesClient(
        fakeWorker({
          init: () => {
            throw new Error("IndexedDB is not available");
          },
        }),
      ),
      undefined,
    );
    await state.init();
    expect(state.getSnapshot()).toMatchObject({ phase: "error", error: "IndexedDB is not available" });
  });

  test("the explored store follows the folded matches; with none it keeps a hand-made set", async () => {
    let folded = new Map<number, { count: number; lastRidden: number }>();
    const state = new RidesState(
      createRidesClient(
        fakeWorker({
          init: () => [],
          list: () => [],
          layer: () => ({ type: "FeatureCollection", features: [] }),
          explored: () => folded,
          deleteRides: () => [],
        }),
      ),
      undefined,
    );
    const store = new ExploredStore();
    store.setRidden([7, 8]); // the ?fakeRidden dev hook
    state.attachExplored(store, "build-1");
    await state.init();
    expect(store.size).toBe(2);

    folded = new Map([[1, { count: 2, lastRidden: 5 }]]);
    await state.deleteRide("x"); // any change refolds
    expect([...store.edges.keys()]).toEqual([1]);
    folded = new Map();
    await state.deleteRide("x");
    expect(store.size).toBe(0); // the last match is gone: cleared
  });
});
