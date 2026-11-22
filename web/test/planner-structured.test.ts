import { describe, expect, test } from "bun:test";
import type { GradeHistogram, Hills, RouteRequest } from "@/engine/generated/types";
import { CONTROLS_KEY, PlannerStore } from "@/planner/store";
import {
  bandAround,
  boardSummary,
  curveAt,
  exchangeSentence,
  fromSliders,
  handleSentence,
  handleValue,
  hillsSummary,
  looseSentence,
  moveRow,
  namedCurve,
  parseStructured,
  partsOf,
  setHandle,
  stepValue,
  structuredChanges,
  tierChangeText,
  tierRate,
} from "@/planner/structured/model";
import {
  CATALOGUE,
  fakeEngine,
  fakeToStructured,
  memoryStorage,
  PRESETS,
  result,
  STRUCTURED,
  settle,
} from "./planner-fake";

const schedule = (run: () => void) => setTimeout(run, 0);
const answer = (request: RouteRequest) => {
  const km = 10 + (request.profile.boards?.way?.path === "love" ? 3 : 0) + request.waypoints.length;
  return { ok: true as const, result: result({ km, arcs: [km] }) };
};

async function started(storage = memoryStorage(), controls?: "sliders" | "structured") {
  const { engine, calls } = fakeEngine(answer);
  const store = new PlannerStore(engine, {
    storage,
    schedule,
    now: () => 0,
    ...(controls ? { controls } : {}),
  });
  await store.init();
  store.setEngineReady(true);
  store.addWaypointAt(0, 0);
  store.addWaypointAt(0.01, 0);
  await settle();
  return { store, calls, storage };
}

const lastRoute = (calls: { lane: string; request: RouteRequest }[]) =>
  calls.filter((c) => c.lane === "route").at(-1)?.request;

describe("the tier boards", () => {
  const way = partsOf(fakeToStructured(PRESETS[0]?.profile ?? { weights: {}, limits: {} })).boards.way ?? {};

  test("say the ranking in a rider's words", () => {
    const board = {
      ...way,
      track: "love",
      cycle_path: "love",
      main: "avoid",
      country_road: "dislike",
    } as const;
    expect(boardSummary(board, "way")).toBe(
      "love tracks, cycle paths · never main roads, dislike country roads",
    );
    expect(boardSummary({ ...way }, "way")).toBe("all fine: no ranking yet");
    expect(boardSummary({ ...way, path: "like" }, "way")).toBe("like paths");
  });

  test("a tier move changes one row, and says so against the preset", () => {
    const base = partsOf(fakeToStructured(PRESETS[0]?.profile ?? { weights: {}, limits: {} }));
    const boards = moveRow(base.boards, "path", "like");
    expect(boards.way?.path).toBe("like");
    expect(boards.way?.track).toBe(base.boards.way?.track as never);
    expect(base.boards.way?.path).toBe("fine");
    const list = structuredChanges(base, { ...base, boards }, STRUCTURED);
    expect(list).toEqual([{ id: "row:path", kind: "row", text: "paths a tier up" }]);
    expect(tierChangeText("main", "dislike", "avoid")).toBe("never main roads");
    expect(tierChangeText("soft", "avoid", "fine")).toBe("soft ground allowed again");
    expect(tierChangeText("track", "love", "fine")).toBe("tracks 2 tiers down");
  });

  test("lanes say what a kilometre counts as, under the spread", () => {
    expect(tierRate("love")).toBe("1 km is 1 km");
    expect(tierRate("fine")).toBe("1 km → 1.35 km");
    expect(tierRate("dislike", 2)).toBe("1 km → 4 km");
    expect(tierRate("avoid")).toBe("never");
    const s = exchangeSentence(1);
    expect(`${s.lead}${s.strong}${s.tail}`).toBe(
      "To stay on ways you love, the route may be up to 1.35× longer than on ways that are fine.",
    );
  });
});

describe("the hills curve", () => {
  const dontMind = STRUCTURED.hills.curves[1]?.hills as Hills;

  test("is log-linear between its handles, pinned at 0 and flat beyond 15 %", () => {
    expect(curveAt(dontMind, 0)).toBe(1);
    expect(curveAt(dontMind, 10)).toBeCloseTo(1.4);
    expect(curveAt(dontMind, 20)).toBeCloseTo(2);
    expect(curveAt(dontMind, 12.5)).toBeCloseTo(Math.sqrt(1.4 * 2));
    expect(curveAt(dontMind, -15)).toBeCloseTo(1.2);
    // without a descent: half the grade uphill, at least 1
    const { down: _, ...noDown } = dontMind;
    expect(handleValue(noDown as Hills, -15)).toBeCloseTo(curveAt(dontMind, 7.5));
  });

  test("a handle edit stays in range, steps on the ladder, and 0 % stays pinned", () => {
    const h = setHandle(dontMind, 10, 2.5, STRUCTURED);
    expect(handleValue(h, 10)).toBe(2.5);
    expect(handleValue(h, 6)).toBeCloseTo(1.1);
    expect(handleValue(setHandle(h, -8, 0.5, STRUCTURED), -8)).toBe(1);
    expect(setHandle(h, 0, 3, STRUCTURED)).toBe(h);
    expect(stepValue(2.5, 1, { min: 0.5, max: 10 })).toBe(3);
    expect(stepValue(2.45, -1, { min: 0.5, max: 10 })).toBe(2.2);
    expect(stepValue(10, 1, { min: 0.5, max: 10 })).toBe(10);
    expect(namedCurve(dontMind, STRUCTURED)?.id).toBe("dont_mind");
    expect(namedCurve(h, STRUCTURED)).toBeNull();
  });

  test("says what a handle means on this route", () => {
    const grades: GradeHistogram = {
      from_pct: -20,
      step_pct: 1,
      metres: Array.from({ length: 40 }, (_, i) => (i === 29 || i === 30 ? 900 : 0)),
    };
    const h = setHandle(dontMind, 10, 2.5, STRUCTURED);
    const band = bandAround(grades, h, 10);
    expect(band?.m).toBe(1800);
    expect(handleSentence(h, 10, grades)).toEqual({
      lead: "At 10 % uphill a metre counts as 2.5 m.",
      route: `On this route: 1.8 km around +10 % count as ${((band?.counts ?? 0) / 1000).toFixed(1)} km.`,
    });
    expect(handleSentence(h, 3, grades).route).toBe("Nothing on this route around +3 %.");
    expect(hillsSummary(dontMind, STRUCTURED)).toBe("Don't mind · a metre at 10 % counts as 1.4 m");
    expect(hillsSummary(h, STRUCTURED)).toBe("Your own curve · a metre at 10 % counts as 2.5 m");
    expect(looseSentence(20)).toBe("8 % on gravel is read as 9.6 %");
  });
});

describe("switching from the sliders", () => {
  test("keeps the twin's own part where the plan changed nothing that feeds it", () => {
    const base = PRESETS[0]?.profile ?? { weights: {}, limits: {} };
    const twin = {
      profile: { ...fakeToStructured(base), hills: STRUCTURED.hills.curves[2]?.hills as Hills },
    };
    const plan = { weights: { ...base.weights, quiet: 90 }, limits: base.limits };
    const r = fromSliders({
      converted: fakeToStructured({ ...base, ...plan }),
      twin,
      plan,
      base,
      catalogue: CATALOGUE,
    });
    expect(r.weights.quiet).toBe(90);
    expect(r.weights.unpaved).toBeUndefined();
    expect(namedCurve(r.parts.hills, STRUCTURED)?.id).toBe("climber");
    const climbed = fromSliders({
      converted: fakeToStructured({ ...base, weights: { ...base.weights, climb: -50 } }),
      twin,
      plan: { weights: { ...base.weights, climb: -50 }, limits: base.limits },
      base,
      catalogue: CATALOGUE,
    });
    expect(handleValue(climbed.parts.hills, 10)).toBe(2);
  });
});

describe("the structured controls switch", () => {
  test("is off by default; on, it routes the twin and offers the twins", async () => {
    const { store, calls } = await started();
    expect(store.getSnapshot().controls).toBe("sliders");
    expect(lastRoute(calls)?.profile.boards).toBeUndefined();
    await store.setControls("structured");
    await settle();
    const s = store.getSnapshot();
    expect(s.controls).toBe("structured");
    expect(s.baseId).toBe("gravel_explorer_structured");
    expect(s.changes).toEqual([]);
    expect(s.presets.map((p) => p.id)).toEqual(["gravel_explorer_structured", "paved_quiet_structured"]);
    const sent = lastRoute(calls)?.profile;
    expect(sent?.boards?.surface?.gravel).toBe("love");
    expect(sent?.weights.unpaved).toBeUndefined();
    expect(sent?.turn_m).toBe(40);
    // limits the boards replace are never sent
    store.setBase("paved_quiet_structured");
    await settle();
    expect(lastRoute(calls)?.profile.limits.paved_only).toBeUndefined();
    expect(store.getSnapshot().limitIds).not.toContain("paved_only");
  });

  test("converts a changed slider plan, edits it apart, and goes back to the sliders as they were", async () => {
    const { store, calls, storage } = await started();
    store.setWeight("quiet", 90);
    await store.setControls("structured");
    await settle();
    let s = store.getSnapshot();
    expect(s.weights.quiet).toBe(90);
    expect(s.changes.map((c) => c.text)).toEqual(["more quiet"]);
    store.setRow("path", "love");
    await settle();
    s = store.getSnapshot();
    expect(s.structuredEdited).toBe(true);
    expect(s.changes.map((c) => c.id)).toEqual(["quiet", "row:path"]);
    expect(lastRoute(calls)?.profile.boards?.way?.path).toBe("love");
    store.setHandle(10, 2.5);
    expect(handleValue(store.getSnapshot().structured?.hills as Hills, 10)).toBe(2.5);
    store.flush();
    expect(storage.data.get(CONTROLS_KEY)).toBe("structured");

    await store.setControls("sliders");
    await settle();
    s = store.getSnapshot();
    expect(s.controls).toBe("sliders");
    expect(s.baseId).toBe("gravel_explorer");
    expect(s.weights).toEqual({ ...PRESETS[0]?.profile.weights, quiet: 90 });
    expect(lastRoute(calls)?.profile.boards).toBeUndefined();
    // a slider move now does not reach the edited structured profile
    store.setWeight("quiet", 20);
    await store.setControls("structured");
    s = store.getSnapshot();
    expect(s.weights.quiet).toBe(90);
    expect(s.structured?.boards.way?.path).toBe("love");
  });

  test("persists both profiles and the switch, and a reload opens where it was", async () => {
    const storage = memoryStorage();
    const { store } = await started(storage);
    await store.setControls("structured");
    store.setRow("track", "love");
    store.flush();
    const saved = JSON.parse(storage.data.get("kompass.plan.v1") ?? "{}");
    expect(saved.baseId).toBe("gravel_explorer");
    expect(saved.weights.unpaved).toBe(85);
    expect(parseStructured(saved.structured)?.boards.way?.track).toBe("love");

    const again = new PlannerStore(fakeEngine(answer).engine, { storage, schedule, now: () => 0 });
    await again.init();
    const s = again.getSnapshot();
    expect(s.controls).toBe("structured");
    expect(s.structured?.boards.way?.track).toBe("love");
    expect(s.changes.map((c) => c.id)).toEqual(["row:track"]);
    await again.setControls("sliders");
    expect(storage.data.get(CONTROLS_KEY)).toBe("sliders");
    const third = new PlannerStore(fakeEngine(answer).engine, { storage, schedule, now: () => 0 });
    await third.init();
    expect(third.getSnapshot().controls).toBe("sliders");
  });

  test("the URL turns it on and is remembered", async () => {
    const storage = memoryStorage();
    const { store } = await started(storage, "structured");
    expect(store.getSnapshot().controls).toBe("structured");
    expect(storage.data.get(CONTROLS_KEY)).toBe("structured");
  });

  test("an unedited structured profile follows the sliders on the next switch", async () => {
    const { store } = await started();
    await store.setControls("structured");
    await store.setControls("sliders");
    store.setWeight("quiet", 10);
    await store.setControls("structured");
    expect(store.getSnapshot().weights.quiet).toBe(10);
    expect(store.getSnapshot().structuredEdited).toBe(false);
  });
});
