import { describe, expect, test } from "bun:test";
import type { RouteRequest, Tradeoff, TradeoffRequest } from "@/engine/generated/types";
import { overridesWire } from "@/planner/overrides";
import { PlannerStore } from "@/planner/store";
import {
  allowOverrides,
  closesWays,
  offered,
  tradeoffKey,
  tradeoffLimits,
  tradeoffSentence,
} from "@/planner/tradeoffs";
import { CATALOGUE, fakeEngine, memoryStorage, result, settle } from "./planner-fake";

function tradeoff(o: Partial<Tradeoff> = {}): Tradeoff {
  return {
    limits: ["paved_only"],
    runs: [
      {
        edges: [7, 8],
        length_m: 140,
        way: "track",
        coordinates: [
          [0.01, 0],
          [0.011, 0],
        ],
      },
    ],
    broken_m: 140,
    saved_m: 3800,
    at: { lon: 0.0105, lat: 0 },
    coordinates: [
      [0.009, 0],
      [0.012, 0],
    ],
    strict: { arcs: [1, 4], start_m: 900, length_m: 4200 },
    soft: { arcs: [1, 3], start_m: 900, length_m: 400 },
    ...o,
  };
}

describe("the words", () => {
  test("in a rider's terms, per limit", () => {
    expect(tradeoffSentence(tradeoff())).toBe("140 m unpaved here would save 3.8 km.");
    expect(tradeoffSentence(tradeoff({ limits: ["no_main_roads"], broken_m: 60, saved_m: 1200 }))).toBe(
      "60 m on a main road here would save 1.2 km.",
    );
    expect(tradeoffSentence(tradeoff({ limits: ["paved_only", "legal_only"] }))).toBe(
      "140 m unpaved and with private or farm-only access here would save 3.8 km.",
    );
    expect(tradeoffSentence(tradeoff({ limits: ["no_stairs"], broken_m: 25 }))).toBe(
      "25 m of steps here would save 3.8 km.",
    );
    expect(tradeoffLimits(tradeoff(), CATALOGUE)).toBe("Paved only");
    expect(tradeoffLimits(tradeoff({ limits: ["avoided_surface"] }), CATALOGUE)).toBe("a surface on Avoid");
  });

  test("allowing makes one allowed exception per run, with the limit; kept ones are not offered", () => {
    const [o] = allowOverrides(tradeoff());
    expect(o).toMatchObject({
      kind: "allow",
      edges: [7, 8],
      lengthM: 140,
      way: "Track",
      limit: "paved_only",
    });
    expect(overridesWire(o ? [o] : [])).toEqual([
      { edge: 7, kind: "allow" },
      { edge: 8, kind: "allow" },
    ]);
    const other = tradeoff({ runs: [{ edges: [9], length_m: 30, way: "path", coordinates: [] }] });
    expect(offered([tradeoff(), other], new Set([tradeoffKey(other)]))).toEqual([tradeoff()]);
    expect(closesWays({ weights: {}, limits: {} })).toBe(false);
    expect(closesWays({ weights: {}, limits: { no_stairs: false } })).toBe(false);
    expect(closesWays({ weights: {}, limits: { paved_only: true } })).toBe(true);
    // the structured model: a board row on Avoid closes ways like a limit
    const surface = {
      paved: "love",
      rough_paved: "fine",
      compacted: "like",
      gravel: "fine",
      soft: "dislike",
      unknown: "fine",
    } as const;
    expect(closesWays({ weights: {}, limits: {}, boards: { surface } })).toBe(false);
    expect(closesWays({ weights: {}, limits: {}, boards: { surface: { ...surface, soft: "avoid" } } })).toBe(
      true,
    );
  });
});

describe("the trade-offs lane", () => {
  const answer = (request: RouteRequest) => {
    const allowed = (request.overrides ?? []).some((o) => o.kind === "allow");
    const km = allowed ? 8 : 12;
    return { ok: true as const, result: result({ km, arcs: [km] }) };
  };

  async function started() {
    const asked: TradeoffRequest[] = [];
    const { engine, calls } = fakeEngine(answer, (request) => {
      asked.push(request);
      const allowed = (request.route.overrides ?? []).length > 0;
      return {
        tradeoffs: allowed ? [] : [tradeoff()],
        candidates: allowed ? 0 : 1,
        searched: true,
        settled: 10,
      };
    });
    const store = new PlannerStore(engine, {
      storage: memoryStorage(),
      schedule: (run) => setTimeout(run, 0),
      now: () => 0,
      tradeoffDelayMs: 20,
    });
    await store.init();
    store.setEngineReady(true);
    store.setBase("paved_quiet");
    return { store, calls, asked };
  }

  test("asks once the route stays put, on its own lane, with the route's arcs", async () => {
    const { store, asked } = await started();
    store.addWaypointAt(0, 0);
    store.addWaypointAt(0.01, 0);
    await settle();
    expect(asked).toEqual([]); // not yet: the route must stay put a moment
    await new Promise((r) => setTimeout(r, 40));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.strict).toEqual([12]);
    expect(asked[0]?.route.profile.limits.paved_only).toBe(true);
    expect(store.getSnapshot().tradeoffs).toHaveLength(1);
    // a slider drag: the markers go at once, and nothing is asked while it moves
    store.setWeight("quiet", 10);
    await settle();
    store.setWeight("quiet", 20);
    await settle();
    expect(store.getSnapshot().tradeoffs).toEqual([]);
    expect(asked).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(asked).toHaveLength(2);
  });

  test("Allow here adds allowed exceptions (undo restores them); Keep the limit stops offering it", async () => {
    const { store, calls } = await started();
    store.addWaypointAt(0, 0);
    store.addWaypointAt(0.01, 0);
    await new Promise((r) => setTimeout(r, 40));
    const key = tradeoffKey(tradeoff());
    store.openTradeoff(key);
    expect(store.getSnapshot().tradeoffOpen).toBe(key);
    store.allowTradeoff(key);
    await settle();
    const s = store.getSnapshot();
    expect(s.tradeoffOpen).toBeNull();
    expect(s.overrides.map((o) => [o.kind, o.edges])).toEqual([["allow", [7, 8]]]);
    expect(s.overrideUndo?.text).toBe("Allowed: 140 m unpaved");
    expect(calls.at(-1)?.request.overrides).toEqual([
      { edge: 7, kind: "allow" },
      { edge: 8, kind: "allow" },
    ]);
    expect(s.main.result?.summary.distance_m).toBe(8000);
    await new Promise((r) => setTimeout(r, 40));
    expect(store.getSnapshot().tradeoffs).toEqual([]); // the allowed bit is no longer offered
    store.undoOverride();
    await new Promise((r) => setTimeout(r, 40));
    expect(store.getSnapshot().overrides).toEqual([]);
    expect(store.getSnapshot().tradeoffs).toHaveLength(1);
    store.openTradeoff(key);
    store.keepTradeoff(key);
    expect(store.getSnapshot().tradeoffs).toEqual([]);
    expect(store.getSnapshot().tradeoffOpen).toBeNull();
    store.setWeight("quiet", 10);
    await new Promise((r) => setTimeout(r, 40));
    expect(store.getSnapshot().tradeoffs).toEqual([]); // kept for this session
  });

  test("a profile without limits asks nothing", async () => {
    const { store, asked } = await started();
    store.setLimit("paved_only", null);
    store.setLimit("no_stairs", null);
    store.addWaypointAt(0, 0);
    store.addWaypointAt(0.01, 0);
    await new Promise((r) => setTimeout(r, 40));
    expect(asked).toEqual([]);
  });
});
