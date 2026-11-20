import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { ExploredStore } from "../src/history/explored-store";
import { createRidesClient, type RidesWorkerLike } from "../src/rides/client";
import { RideLibrary } from "../src/rides/library";
import { foldMatches } from "../src/rides/match";
import type { RideMatchInfo } from "../src/rides/matcher";
import { dayOf, personalLayer } from "../src/rides/personal";
import {
  handleRideRequest,
  type RideHandlers,
  type RideRequest,
  type RideResponse,
} from "../src/rides/protocol";
import { type RegionEngine, RidesState } from "../src/rides/state";
import { formatKm, formatShare, summarize } from "../src/rides/summary";
import { gridLoop, syntheticTrack, toGpx } from "./synthetic";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 4, 2, 8, 0, 0);

describe("the personal layer", () => {
  test("the fold as flat arrays sized to the graph: count, last-ridden day, today", () => {
    const explored = new Map([
      [0, { count: 3, lastRidden: T0 }],
      [4, { count: 70_000, lastRidden: 0 }], // saturates; only untimed rides: day 0
      [9, { count: 1, lastRidden: T0 }], // beyond the graph: dropped
    ]);
    const layer = personalLayer(explored, 6, T0 + 10 * DAY);
    expect(layer.rides).toEqual(Uint16Array.from([3, 0, 0, 0, 65535, 0]));
    expect(layer.lastRidden).toEqual(Uint32Array.from([dayOf(T0), 0, 0, 0, 0, 0]));
    expect(layer.today).toBe(dayOf(T0) + 10);
    expect(dayOf(T0)).toBe(Math.floor(T0 / DAY));
    expect(personalLayer(new Map(), 3).rides).toEqual(new Uint16Array(3));
  });

  test("it comes from the saved matches: edges ridden twice count twice, the last ride's day wins", async () => {
    const lib = await RideLibrary.open(new IDBFactory());
    const bytes = (start: number) =>
      new TextEncoder().encode(toGpx(syntheticTrack({ path: gridLoop(0, 0), start })));
    await lib.importFile("a.gpx", bytes(T0));
    await lib.importFile("b.gpx", bytes(T0 + 3 * DAY));
    const [newer, older] = lib.listRides();
    await lib.saveMatch(older?.id as string, {
      graphBuild: "x",
      arcs: Uint32Array.from([0, 3, 4]),
      coverage: Uint8Array.from([255, 255, 100]), // the last arc is under half
    });
    await lib.saveMatch(newer?.id as string, {
      graphBuild: "x",
      arcs: Uint32Array.from([1, 8]),
      coverage: Uint8Array.from([200, 255]),
    });
    const fold = foldMatches(lib.listRides(), await lib.store.getMatches(), "x");
    const layer = personalLayer(fold, 5);
    expect([...layer.rides]).toEqual([2, 1, 0, 0, 1]); // edge 0 in both rides (arc 0 and arc 1), edge 1 (arc 3), edge 4 (arc 8)
    expect(layer.lastRidden[0]).toBe(dayOf(newer?.endTime as number));
    expect(layer.lastRidden[1]).toBe(dayOf(older?.endTime as number));
  });
});

describe("the summary", () => {
  const rides = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const matches = new Map<string, RideMatchInfo>([
    ["a", { share: 1, outside: false }],
    ["b", { share: 0, outside: true }],
    ["gone", { share: 1, outside: false }], // a deleted ride's result does not count
  ]);

  test("rides matched and outside, km and the share of the network", () => {
    expect(summarize(rides, matches, { edges: 10, km: 12.5, networkKm: 1000 })).toEqual({
      rides: 3,
      matched: 2,
      outside: 1,
      edges: 10,
      km: 12.5,
      share: 0.0125,
    });
    expect(summarize(rides, matches, { edges: 10, km: 12.5, networkKm: null }).share).toBeNull();
    expect(summarize(rides, matches, null)).toMatchObject({ km: null, share: null, edges: 0 });
  });

  test("formatting", () => {
    expect(formatKm(6.34)).toBe("6.3 km");
    expect(formatKm(84.4)).toBe("84 km");
    expect(formatKm(2593.2)).toBe("2,593 km");
    expect(formatShare(0.0341)).toBe("3.4 %");
    expect(formatShare(0.1234)).toBe("12 %");
    expect(formatShare(0.00004)).toBe("<0.1 %");
    expect(formatShare(0)).toBe("0.0 %");
  });
});

/** A ride worker backed by a real library on fake-indexeddb, for the state tests. */
async function realWorker(): Promise<{ client: ReturnType<typeof createRidesClient>; lib: RideLibrary }> {
  const lib = await RideLibrary.open(new IDBFactory());
  const handlers: Partial<RideHandlers> = {
    init: () => lib.listRides(),
    list: () => lib.listRides(),
    layer: () => ({ type: "FeatureCollection", features: [] }),
    explored: ({ graphBuild }) => lib.exploredInput(graphBuild),
    matchStatus: ({ graphBuild }) => lib.matchStatus(graphBuild),
    points: ({ id }) => lib.getPoints(id),
    saveMatch: async ({ id, ...match }) => {
      await lib.saveMatch(id, match);
    },
    importFiles: async ({ files }) => {
      const out = [];
      for (const file of files) {
        out.push({
          file: file.name,
          outcome: await lib.importFile(file.name, new Uint8Array(await file.arrayBuffer())),
        });
      }
      return out;
    },
    deleteRides: async ({ ids }) => {
      await lib.deleteRides(ids);
      return lib.listRides();
    },
  };
  let listener: ((event: MessageEvent<RideResponse>) => void) | undefined;
  const emit = (data: RideResponse) => listener?.({ data } as MessageEvent<RideResponse>);
  const worker: RidesWorkerLike = {
    postMessage(message: RideRequest) {
      void handleRideRequest(handlers as RideHandlers, message, emit).then(emit);
    },
    addEventListener(_type, l) {
      listener = l;
    },
    terminate() {},
  };
  return { client: createRidesClient(worker), lib };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(check()).toBe(true);
};

describe("RidesState with an engine", () => {
  /** An engine that "matches" a ride into one arc per 20 points, edge ids from the ride's first latitude. */
  function fakeEngine(build = "g1") {
    const personal: ({ rides: Uint16Array; lastRidden: Uint32Array; today: number } | null)[] = [];
    const engine: RegionEngine = {
      matchRide: async (lat) => {
        if (lat.length < 2) throw new Error("too short");
        const n = Math.floor(lat.length / 20);
        const first = Math.round(((lat[0] as number) + 0.02) / 0.0045) * 10;
        const edges = Uint32Array.from({ length: n }, (_, i) => first + i);
        return {
          graphBuild: build,
          arcs: edges.map((e) => e * 2),
          coverage: new Uint8Array(n).fill(255),
          firstPoint: new Uint32Array(n),
          unmatched: new Float64Array(0),
          trackM: 1000,
          matchedM: 1000,
          pathM: 1000,
          breaks: 0,
          tilesLoaded: 0,
        };
      },
      setPersonal: async (layer) => {
        personal.push(layer);
      },
      edgesLength: async (edges) => edges.length * 250,
    };
    return { engine, personal };
  }

  const gpx = (path: [number, number][], start: number) =>
    new File([toGpx(syntheticTrack({ path, start }))], `${start}.gpx`);

  test("imported rides are matched, the explored store and the personal layer follow, the summary counts", async () => {
    const { client } = await realWorker();
    const state = new RidesState(client, undefined);
    const store = new ExploredStore();
    state.attachExplored(store, "g1");
    await state.init();
    const { engine, personal } = fakeEngine();
    state.attachEngine(engine, { graphBuild: "g1", edgeCount: 400, networkM: 100_000 });
    expect(state.getSnapshot().engineReady).toBe(true);

    await state.importFiles([gpx(gridLoop(1, 1), T0), gpx(gridLoop(2, 2), T0 + DAY)]);
    await until(
      () => state.getSnapshot().matching.phase === "idle" && state.getSnapshot().matches.size === 2,
    );
    await until(() => (state.getSnapshot().explored?.edges ?? 0) > 0 && personal.length > 0);
    const snap = state.getSnapshot();
    expect(store.size).toBe(snap.explored?.edges as number);
    const layer = personal.at(-1);
    expect(layer?.rides.length).toBe(400);
    expect(layer?.rides.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(store.size);
    expect(snap.explored?.km).toBe(store.size * 0.25);
    expect(snap.explored?.networkKm).toBe(100);

    // deleting a ride refolds: the explored map and the personal layer shrink
    const before = store.size;
    const [newest] = snap.rides;
    await state.deleteRide(newest?.id as string);
    expect(store.size).toBeLessThanOrEqual(before);
    await state.deleteRide(state.getSnapshot().rides[0]?.id as string);
    expect(store.size).toBe(0);
    expect(personal.at(-1)).toBeNull(); // no matches: the personal layer is cleared
    expect(state.getSnapshot().explored?.edges).toBe(0);
  });

  test("an engine that is ready before the library opens starts matching once it has", async () => {
    const { client, lib } = await realWorker();
    await lib.importFile(
      "a.gpx",
      new TextEncoder().encode(toGpx(syntheticTrack({ path: gridLoop(1, 1), start: T0 }))),
    );
    const state = new RidesState(client, undefined);
    const { engine } = fakeEngine();
    state.attachEngine(engine, { graphBuild: "g1", edgeCount: 400, networkM: 1 });
    expect(state.getSnapshot().matches.size).toBe(0);
    await state.init();
    await until(() => state.getSnapshot().matches.size === 1);
    // a reload: a new state over the same store does not match the ride again
    let calls = 0;
    const counting: RegionEngine = {
      ...engine,
      matchRide: (lat, lon) => {
        calls++;
        return engine.matchRide(lat, lon);
      },
    };
    const again = new RidesState(client, undefined);
    again.attachEngine(counting, { graphBuild: "g1", edgeCount: 400, networkM: 1 });
    await again.init();
    await until(() => again.getSnapshot().matches.size === 1);
    expect(calls).toBe(0);
    // another graph build: everything is matched again
    const second = fakeEngine("g2").engine;
    let rematched = 0;
    const rebuilt = new RidesState(client, undefined);
    rebuilt.attachEngine(
      {
        ...second,
        matchRide: (lat, lon) => {
          rematched++;
          return second.matchRide(lat, lon);
        },
      },
      { graphBuild: "g2", edgeCount: 400, networkM: 1 },
    );
    await rebuilt.init();
    await until(() => rebuilt.getSnapshot().matches.size === 1);
    expect(rematched).toBe(1); // the saved match is of g1: stale
  });
});
