import { describe, expect, test } from "bun:test";
import type { EdgeRun, RouteRequest } from "@/engine/generated/types";
import {
  makeOverride,
  overrideOn,
  overridesWire,
  overrideText,
  parseOverrides,
  withOverride,
} from "@/planner/overrides";
import { PlannerStore } from "@/planner/store";
import { fakeEngine, memoryStorage, result, settle } from "./planner-fake";

// This plan's exceptions (docs/planner.md, "This plan's exceptions"): the list, what the engine gets,
// the saved form per build, and the store's wiring (every lane, undo, persistence).

const run = (edges: number[], m = 420): EdgeRun => ({
  edges,
  index: 0,
  length_m: m,
  coordinates: [
    [0, 0],
    [0.001, 0.001],
  ],
});

describe("the exceptions", () => {
  test("one per edge: a new one replaces any that shares an edge; the wire has each edge once", () => {
    const a = makeOverride("avoid", run([1, 2, 3]), "Track");
    const b = makeOverride("prefer", run([7, 8]), "Path");
    let list = withOverride(withOverride([], a), b);
    expect(list.map((o) => o.kind)).toEqual(["avoid", "prefer"]);
    expect(overrideOn(list, 2)?.id).toBe(a.id);
    expect(overrideOn(list, 5)).toBeUndefined();
    // the same run, now preferred: the avoid goes
    const c = makeOverride("prefer", run([3, 4]), "Track");
    list = withOverride(list, c);
    expect(list.map((o) => o.id)).toEqual([b.id, c.id]);
    expect(overridesWire(list)).toEqual([
      { edge: 7, kind: "prefer" },
      { edge: 8, kind: "prefer" },
      { edge: 3, kind: "prefer" },
      { edge: 4, kind: "prefer" },
    ]);
    expect(overrideText(a)).toBe("Avoided · Track · 420 m");
  });

  test("are kept for the build they were made on, dropped on another, and checked", () => {
    const a = makeOverride("allow", run([5]), "Track", "paved_only");
    expect(parseOverrides({ build: "b1", list: [a] }, "b1")).toEqual({ kept: [a], dropped: 0 });
    expect(parseOverrides({ build: "b1", list: [a] }, "b2")).toEqual({ kept: [], dropped: 1 });
    expect(parseOverrides({ build: "b1", list: [a] }, undefined).kept).toEqual([]);
    // garbage goes, an old plan without any has none
    const bad = [{ ...a, kind: "teleport" }, { ...a, edges: [-1] }, { ...a, line: "x" }, null];
    expect(parseOverrides({ build: "b1", list: bad }, "b1")).toEqual({ kept: [], dropped: 0 });
    expect(parseOverrides(undefined, "b1")).toEqual({ kept: [], dropped: 0 });
  });
});

const schedule = (run: () => void) => setTimeout(run, 0);
const answer = (request: RouteRequest) => ({
  ok: true as const,
  result: result({ km: 10 + (request.overrides?.length ?? 0), arcs: [1, 2, 3] }),
});

async function planned(storage = memoryStorage(), build = "b1") {
  const { engine, calls, compares } = fakeEngine(answer);
  const explains: unknown[] = [];
  engine.explainEdge = async (request) => {
    explains.push(request);
    throw new Error("not in the fake");
  };
  const store = new PlannerStore(engine, { storage, schedule, now: () => 0, build });
  await store.init();
  store.setEngineReady(true);
  store.addWaypointAt(0, 0);
  store.addWaypointAt(0.01, 0);
  await settle();
  return { store, calls, compares, explains, storage };
}

describe("the store's exceptions", () => {
  test("go to every lane, follow the run of the inspected way, and undo", async () => {
    const { store, calls, explains } = await planned();
    // the inspected way's run first: the action applies to all of it
    store.loadRun(4);
    await settle();
    expect(store.getSnapshot().run?.result.edges).toEqual([4, 5]);
    calls.length = 0;
    store.addOverride("avoid", 4, "Track");
    await settle();
    const s = store.getSnapshot();
    expect(s.overrides).toHaveLength(1);
    expect(s.overrides[0]?.edges).toEqual([4, 5]);
    expect(s.overrideUndo?.text).toBe("Avoided · Track · 420 m");
    const route = calls.filter((c) => c.lane === "route").at(-1)?.request;
    expect(route?.overrides).toEqual([
      { edge: 4, kind: "avoid" },
      { edge: 5, kind: "avoid" },
    ]);
    // a profile change: the ghost (the base preset) honours them too
    store.setWeight("unpaved", 20);
    await settle();
    expect(calls.find((c) => c.lane === "ghost")?.request.overrides).toHaveLength(2);
    // the inspector's explanation is under them; the probe of what could match is not
    void store.explainEdge(4).catch(() => undefined);
    void store.explainEdge(4, { weights: {}, limits: {} }, "explain-probe").catch(() => undefined);
    await settle();
    expect(explains).toEqual([
      expect.objectContaining({ edge: 4, overrides: [expect.anything(), expect.anything()] }),
      expect.not.objectContaining({ overrides: expect.anything() }),
    ]);
    // undo: none again, the route without them
    calls.length = 0;
    store.undoOverride();
    await settle();
    expect(store.getSnapshot().overrides).toEqual([]);
    expect(store.getSnapshot().overrideUndo).toBeNull();
    expect(calls.filter((c) => c.lane === "route").at(-1)?.request.overrides).toBeUndefined();
  });

  test("a removed one can be undone; why-not compares under them", async () => {
    const { store, compares } = await planned();
    store.loadRun(9);
    await settle();
    store.addOverride("prefer", 9, "Path");
    await settle();
    const id = store.getSnapshot().overrides[0]?.id ?? "";
    store.startWhyNot(0.005, 0.001);
    await settle();
    await settle();
    expect(compares.at(-1)?.overrides).toEqual([
      { edge: 9, kind: "prefer" },
      { edge: 10, kind: "prefer" },
    ]);
    store.endWhyNot();
    store.removeOverride(id);
    expect(store.getSnapshot().overrides).toEqual([]);
    expect(store.getSnapshot().overrideUndo?.text).toBe("Removed: preferred · path · 420 m");
    store.undoOverride();
    expect(store.getSnapshot().overrides.map((o) => o.id)).toEqual([id]);
  });

  test("are saved with the plan and its build; another build drops them and says so", async () => {
    const storage = memoryStorage();
    const { store } = await planned(storage);
    store.loadRun(4);
    await settle();
    store.addOverride("allow", 4, "Track", "paved_only");
    store.flush();
    const saved = JSON.parse(storage.data.get("kompass.plan.v1") ?? "{}");
    expect(saved.overrides.build).toBe("b1");
    expect(saved.overrides.list[0].limit).toBe("paved_only");
    const same = await planned(storage, "b1");
    expect(same.store.getSnapshot().overrides).toHaveLength(1);
    const other = await planned(storage, "b2");
    expect(other.store.getSnapshot().overrides).toEqual([]);
    expect(other.store.getSnapshot().overridesDropped).toBe(1);
    // a plan saved before there were exceptions opens with none
    storage.data.set("kompass.plan.v1", JSON.stringify({ ...saved, overrides: undefined }));
    expect((await planned(storage, "b1")).store.getSnapshot().overrides).toEqual([]);
  });
});
