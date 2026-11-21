import { describe, expect, test } from "bun:test";
import type { RouteRequest } from "@/engine/generated/types";
import { PlannerStore } from "@/planner/store";
import { fakeEngine, memoryStorage, result, settle } from "./planner-fake";

const now = (s: number) => () => s;
const schedule = (run: () => void) => setTimeout(run, 0);

/** Routes get longer with `unpaved` and fail with `paved_only` (a blocking limit). */
const answer = (request: RouteRequest) => {
  if (request.profile.limits.paved_only === true)
    return {
      ok: false as const,
      error: { code: "no_route" as const, message: "no route between these waypoints" },
    };
  const km = 10 + (request.profile.weights.unpaved ?? 0) / 10 + request.waypoints.length;
  return { ok: true as const, result: result({ km, arcs: [km], legs: request.waypoints.length - 1 }) };
};

async function started(storage = memoryStorage()) {
  const { engine, calls } = fakeEngine(answer);
  const store = new PlannerStore(engine, { storage, schedule, now: now(0) });
  await store.init();
  store.setEngineReady(true);
  return { store, calls, storage };
}

describe("the planner store", () => {
  test("starts on the default preset, no route until start and destination", async () => {
    const { store, calls } = await started();
    const s = store.getSnapshot();
    expect(s.baseId).toBe("gravel_explorer");
    expect(s.weights.unpaved).toBe(85);
    expect(s.prefIds.slice(0, 4)).toEqual(["unpaved", "quiet", "climb", "novel"]);
    store.addWaypointAt(0, 0);
    await settle();
    expect(calls).toEqual([]);
    store.addWaypointAt(0.01, 0);
    await settle();
    expect(calls.map((c) => c.lane)).toEqual(["route"]);
    expect(store.getSnapshot().main.result?.summary.distance_m).toBe(20_500);
  });

  test("a slider step reroutes the main lane only; the ghost is the base and is sent once", async () => {
    const { store, calls } = await started();
    store.addWaypointAt(0, 0);
    store.addWaypointAt(0.01, 0);
    await settle();
    calls.length = 0;
    store.setWeight("unpaved", 40);
    await settle();
    expect(calls.map((c) => c.lane).sort()).toEqual(["ghost", "route"]);
    expect(store.getSnapshot().changes.map((c) => c.id)).toEqual(["unpaved"]);
    expect(store.getSnapshot().ghost.result?.summary.distance_m).toBe(20_500);
    calls.length = 0;
    store.setWeight("unpaved", 30);
    store.setWeight("unpaved", 20); // two steps in one frame: one request
    await settle();
    expect(calls.map((c) => c.lane)).toEqual(["route"]);
    expect(store.getSnapshot().main.result?.summary.distance_m).toBe(14_000);
    // back to the base: no changes, no ghost
    store.reset();
    await settle();
    expect(store.getSnapshot().changes).toEqual([]);
    expect(store.getSnapshot().ghost.result).toBeNull();
  });

  test("a blocking limit is found by lifting one at a time, and can be lifted", async () => {
    const { store } = await started();
    store.addWaypointAt(0, 0);
    store.addWaypointAt(0.01, 0);
    store.addLimit("paved_only");
    await settle();
    await settle();
    const s = store.getSnapshot();
    expect(s.main.error?.code).toBe("no_route");
    expect(s.blame?.limit).toBe("paved_only");
    expect(s.blame?.result).not.toBeNull();
    store.liftLimit("paved_only");
    await settle();
    expect(store.getSnapshot().main.error).toBeNull();
    expect(store.getSnapshot().blame).toBeNull();
  });

  test("waypoints: insert, move, reorder, reverse, remove, clear", async () => {
    const { store } = await started();
    store.addWaypointAt(0, 0);
    store.addWaypointAt(0.2, 0);
    store.addWaypointAt(0.1, 0.01);
    const ids = store.getSnapshot().waypoints.map((w) => w.lon);
    expect(ids).toEqual([0, 0.1, 0.2]);
    const mid = store.getSnapshot().waypoints[1]?.id as string;
    store.moveWaypoint(mid, 0.12, 0.02, "Village");
    expect(store.getSnapshot().waypoints[1]).toMatchObject({ lon: 0.12, lat: 0.02, place: "Village" });
    store.reverse();
    expect(store.getSnapshot().waypoints.map((w) => w.lon)).toEqual([0.2, 0.12, 0]);
    store.reorderWaypoint(0, 2);
    expect(store.getSnapshot().waypoints.map((w) => w.lon)).toEqual([0.12, 0, 0.2]);
    store.removeWaypoint(mid);
    expect(store.getSnapshot().waypoints).toHaveLength(2);
    store.clearWaypoints();
    expect(store.getSnapshot().waypoints).toEqual([]);
  });

  test("save as preset, rename, delete; presets and the plan survive a reload", async () => {
    const storage = memoryStorage();
    const { store } = await started(storage);
    store.addWaypointAt(0, 0);
    store.addWaypointAt(0.01, 0);
    store.addPref("water");
    store.setCompare("paved_quiet");
    store.savePreset("Wet gravel");
    const own = store.getSnapshot().base;
    expect(own?.own).toBe(true);
    expect(store.getSnapshot().changes).toEqual([]);
    store.renamePreset(own?.id as string, "Riverside gravel");
    store.flush();

    const again = new PlannerStore(fakeEngine(answer).engine, { storage, schedule, now: now(0) });
    await again.init();
    const s = again.getSnapshot();
    expect(s.base?.profile.name).toBe("Riverside gravel");
    expect(s.weights.water).toBe(60);
    expect(s.waypoints).toHaveLength(2);
    expect(s.compareId).toBe("paved_quiet");
    expect(s.presets.map((p) => p.id)).toEqual(["gravel_explorer", "paved_quiet", own?.id as string]);

    again.deletePreset(own?.id as string);
    expect(again.getSnapshot().baseId).toBe("gravel_explorer");
    expect(again.getSnapshot().presets).toHaveLength(2);
  });

  test("compare: a second lane, and riding it makes it the base", async () => {
    const { store, calls } = await started();
    store.addWaypointAt(0, 0);
    store.addWaypointAt(0.01, 0);
    store.setCompare("paved_quiet");
    await settle();
    expect(calls.map((c) => c.lane)).toContain("compare");
    expect(store.getSnapshot().compare.error?.code).toBe("no_route"); // paved only, in this fake
    store.rideCompare();
    expect(store.getSnapshot().baseId).toBe("paved_quiet");
    expect(store.getSnapshot().compareId).toBeNull();
  });
});

describe("why not through here", () => {
  test("routes through the point as well, compares, and leaves the plan untouched", async () => {
    const { engine, calls, compares } = fakeEngine(answer);
    const store = new PlannerStore(engine, { storage: memoryStorage(), schedule, now: now(0) });
    await store.init();
    store.setEngineReady(true);
    store.addWaypointAt(0, 0);
    store.addWaypointAt(0.02, 0);
    await settle();
    const main = store.getSnapshot().main.result;
    store.startWhyNot(0.01, 0.005);
    await settle();
    const through = calls.filter((c) => c.lane === "whynot");
    expect(through).toHaveLength(1);
    // the via sits between start and destination, the plan keeps two waypoints
    expect(through[0]?.request.waypoints).toEqual([
      { lon: 0, lat: 0 },
      { lon: 0.01, lat: 0.005 },
      { lon: 0.02, lat: 0 },
    ]);
    const s = store.getSnapshot();
    expect(s.waypoints).toHaveLength(2);
    expect(s.main.result).toBe(main);
    expect(compares).toHaveLength(1);
    expect(s.whyNot?.comparison?.stretches).toHaveLength(1);
    // a slider move: both routes again, compared again
    store.setWeight("unpaved", 40);
    await settle();
    expect(calls.filter((c) => c.lane === "whynot")).toHaveLength(2);
    expect(compares).toHaveLength(2);
    // back: nothing of it stays
    store.endWhyNot();
    expect(store.getSnapshot().whyNot).toBeNull();
    expect(store.getSnapshot().waypoints).toHaveLength(2);
    // "use this route" makes the point a stop
    store.startWhyNot(0.01, 0.005);
    await settle();
    store.acceptWhyNot();
    await settle();
    expect(store.getSnapshot().whyNot).toBeNull();
    expect(store.getSnapshot().waypoints.map((w) => [w.lon, w.lat])).toEqual([
      [0, 0],
      [0.01, 0.005],
      [0.02, 0],
    ]);
  });
});
