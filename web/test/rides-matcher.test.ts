import { describe, expect, test } from "bun:test";
import type { RideMatchResult } from "../src/engine/protocol";
import {
  type MatchEngine,
  type MatchProgress,
  type MatchRides,
  matchInfo,
  OUTSIDE_SHARE,
  RideMatcher,
  type RideMatchInfo,
} from "../src/rides/matcher";
import type { MatchInput, MatchStatus } from "../src/rides/types";

const result = (build: string, trackM = 1000, matchedM = trackM, arcs = [2, 4]): RideMatchResult => ({
  graphBuild: build,
  arcs: Uint32Array.from(arcs),
  coverage: new Uint8Array(arcs.length).fill(255),
  firstPoint: new Uint32Array(arcs.length),
  unmatched: new Float64Array(0),
  trackM,
  matchedM,
  pathM: matchedM,
  breaks: 0,
  tilesLoaded: 0,
});

/** A ride store in memory: ids newest first, saved matches by ride. */
function fakeRides(ids: string[]) {
  const rides = [...ids];
  const saved = new Map<string, MatchInput>();
  const api: MatchRides = {
    list: async () => rides.map((id) => ({ id })),
    matched: async (build) =>
      [...saved]
        .filter(([, m]) => m.graphBuild === build)
        .map(
          ([rideId, m]): MatchStatus => ({
            rideId,
            trackM: m.trackM ?? null,
            matchedM: m.matchedM ?? null,
            arcs: m.arcs.length,
          }),
        ),
    points: async (id) => (rides.includes(id) ? { lat: Float64Array.of(1), lon: Float64Array.of(2) } : null),
    save: async (id, match) => {
      if (!rides.includes(id)) throw new Error(`no ride ${id}`);
      saved.set(id, match);
    },
  };
  return { api, rides, saved };
}

function setup(ids: string[], engine: MatchEngine, build = "b1") {
  const store = fakeRides(ids);
  const progress: MatchProgress[] = [];
  const batches: number[] = [];
  let matches: ReadonlyMap<string, RideMatchInfo> = new Map();
  const matcher = new RideMatcher({
    rides: store.api,
    engine,
    onProgress: (p) => progress.push(p),
    onMatches: (m) => {
      matches = m;
    },
    onBatch: () => batches.push(store.saved.size),
    batchMs: 0,
  });
  matcher.setBuild(build);
  return { ...store, matcher, progress, batches, matches: () => matches };
}

describe("matchInfo", () => {
  test("the matched share, and a low share is outside the region", () => {
    expect(matchInfo({ trackM: 1000, matchedM: 990 })).toEqual({ share: 0.99, outside: false });
    expect(matchInfo({ trackM: 1000, matchedM: 0 })).toEqual({ share: 0, outside: true });
    expect(matchInfo({ trackM: 1000, matchedM: 1000 * OUTSIDE_SHARE }).outside).toBe(false);
    expect(matchInfo({ trackM: 1000, matchedM: 1000 * OUTSIDE_SHARE - 1 }).outside).toBe(true);
    // a match without lengths (an older one) is not judged
    expect(matchInfo({ trackM: null, matchedM: null })).toEqual({ share: null, outside: false });
    expect(matchInfo({ trackM: 0, matchedM: 0 }).outside).toBe(false);
  });
});

describe("RideMatcher", () => {
  test("matches the rides one at a time, newest first, and reports progress", async () => {
    const order: string[] = [];
    const t = setup(["c", "b", "a"], {
      matchRide: async () => {
        order.push("engine");
        return result("b1");
      },
    });
    await t.matcher.idle();
    expect([...t.saved.keys()]).toEqual(["c", "b", "a"]);
    expect(order).toHaveLength(3);
    const running = t.progress.filter((p) => p.phase === "running");
    expect(running.map((p) => [p.done, p.total])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
    expect(t.progress.at(-1)).toEqual({ phase: "idle", done: 3, total: 3, failed: 0 });
    expect(t.saved.get("a")?.graphBuild).toBe("b1");
    expect(t.batches.at(-1)).toBe(3); // the explored map is refolded when the run ends
  });

  test("only one ride is in the engine at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const t = setup(["a", "b", "c", "d"], {
      matchRide: async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return result("b1");
      },
    });
    await t.matcher.idle();
    expect(peak).toBe(1);
    expect(t.saved.size).toBe(4);
  });

  test("resumes after a reload: rides with a match for this build are not matched again", async () => {
    const calls: number[] = [];
    const store = fakeRides(["c", "b", "a"]);
    store.saved.set("c", { ...result("b1"), trackM: 1000, matchedM: 1000 });
    const matcher = new RideMatcher({
      rides: store.api,
      engine: {
        matchRide: async () => {
          calls.push(1);
          return result("b1");
        },
      },
      onProgress: () => {},
      onMatches: () => {},
      onBatch: () => {},
    });
    matcher.setBuild("b1");
    await matcher.idle();
    expect(calls).toHaveLength(2);
    expect(store.saved.size).toBe(3);
  });

  test("a new graph build rematches everything", async () => {
    const t = setup(["b", "a"], { matchRide: async () => result("b1") });
    await t.matcher.idle();
    expect(t.saved.get("a")?.graphBuild).toBe("b1");
    // the engine loads another build: its matches are of that build
    const engine2: MatchEngine = { matchRide: async () => result("b2") };
    const store = { saved: t.saved };
    const matcher2 = new RideMatcher({
      rides: t.api,
      engine: engine2,
      onProgress: () => {},
      onMatches: () => {},
      onBatch: () => {},
    });
    matcher2.setBuild("b2");
    await matcher2.idle();
    expect([...store.saved.values()].map((m) => m.graphBuild)).toEqual(["b2", "b2"]);
  });

  test("setBuild while running drops the old run's result and starts over", async () => {
    let build = "b1";
    const release: (() => void)[] = [];
    const t = setup(["b", "a"], {
      matchRide: () =>
        new Promise<RideMatchResult>((resolve) => {
          const mine = build;
          release.push(() => resolve(result(mine)));
        }),
    });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 1));
    expect(release).toHaveLength(1); // ride "b" is in the engine
    build = "b2";
    t.matcher.setBuild("b2");
    release[0]?.(); // the engine answers with the old build's result
    await new Promise((r) => setTimeout(r, 1));
    expect(t.saved.size).toBe(0); // it was dropped
    // the new run asks the engine again (ride "b", then "a")
    while (t.saved.size < 2) {
      for (const r of release.splice(0)) r();
      await new Promise((r) => setTimeout(r, 1));
    }
    await t.matcher.idle();
    expect([...t.saved.values()].every((m) => m.graphBuild === "b2")).toBe(true);
  });

  test("a ride outside the region is marked, not an error", async () => {
    const t = setup(["b", "a"], {
      matchRide: async () => result("b1", 5000, 0, []),
    });
    await t.matcher.idle();
    expect(t.matches().get("a")).toEqual({ share: 0, outside: true });
    expect(t.saved.get("a")?.arcs).toHaveLength(0); // saved all the same: it is not pending again
    expect(t.progress.at(-1)).toMatchObject({ phase: "idle", failed: 0 });
  });

  test("a ride the engine fails on is skipped and counted; the others go on", async () => {
    let n = 0;
    const t = setup(["c", "b", "a"], {
      matchRide: async () => {
        if (++n === 2) throw new Error("boom");
        return result("b1");
      },
    });
    await t.matcher.idle();
    expect([...t.saved.keys()]).toEqual(["c", "a"]);
    expect(t.progress.at(-1)).toEqual({ phase: "idle", done: 2, total: 2, failed: 1 });
    expect(n).toBe(3); // not retried in the same run
  });

  test("pause stops after the ride in progress; resume carries on with the rest", async () => {
    const release: (() => void)[] = [];
    const t = setup(["c", "b", "a"], {
      matchRide: () => new Promise<RideMatchResult>((resolve) => release.push(() => resolve(result("b1")))),
    });
    await new Promise((r) => setTimeout(r, 1));
    t.matcher.pause();
    expect(t.progress.at(-1)?.phase).toBe("paused");
    release.shift()?.();
    await new Promise((r) => setTimeout(r, 1));
    expect(t.saved.size).toBe(0); // the ride that was in the engine is not saved after the pause
    t.matcher.kick(); // does nothing while paused
    await new Promise((r) => setTimeout(r, 1));
    expect(release).toHaveLength(0);
    t.matcher.resume();
    while (t.saved.size < 3) {
      for (const r of release.splice(0)) r();
      await new Promise((r) => setTimeout(r, 1));
    }
    await t.matcher.idle();
    expect(t.progress.at(-1)).toMatchObject({ phase: "idle", done: 3 });
  });

  test("rides imported during a run are matched by it; kick restarts an idle matcher", async () => {
    const t = setup(["a"], { matchRide: async () => result("b1") });
    t.rides.unshift("b"); // imported while "a" is being matched
    t.matcher.kick();
    await t.matcher.idle();
    expect(t.saved.size).toBe(2);
    t.rides.unshift("c");
    t.matcher.kick();
    await t.matcher.idle();
    expect([...t.saved.keys()].sort()).toEqual(["a", "b", "c"]);
  });

  test("a ride deleted while it is being matched is not a failure", async () => {
    const t = setup(["b", "a"], {
      matchRide: async () => {
        t.rides.splice(0); // everything is deleted under the matcher
        return result("b1");
      },
    });
    await t.matcher.idle();
    expect(t.saved.size).toBe(0);
    expect(t.progress.at(-1)?.failed).toBe(0);
  });

  test("without a build nothing runs", async () => {
    const t = setup(["a"], { matchRide: async () => result("b1") });
    await t.matcher.idle();
    t.matcher.setBuild(null);
    t.rides.push("z");
    t.matcher.kick();
    await t.matcher.idle();
    expect(t.saved.has("z")).toBe(false);
    expect(t.progress.at(-1)?.phase).toBe("idle");
  });
});
