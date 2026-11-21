import { describe, expect, test } from "bun:test";
import { routeToGpx } from "@/planner/gpx";
import {
  changeSentence,
  changes,
  deltas,
  detourHint,
  detourTimes,
  detourWord,
  insertIndex,
  limitInMessage,
  moveItem,
  normaliseLimits,
  parsePlan,
  parsePresets,
  planProfile,
  probeOrder,
  sameCost,
  snapMinFactor,
  snapWeight,
  tradeoff,
  tradeoffText,
  waypointLabel,
  weightWord,
} from "@/planner/model";
import { CATALOGUE, result } from "./planner-fake";

const p = (lon: number, lat: number) => ({ lon, lat });

describe("waypoints", () => {
  test("the first tap is the start, the second the destination", () => {
    expect(insertIndex([], p(0, 0))).toBe(0);
    expect(insertIndex([p(0, 0)], p(0.1, 0))).toBe(1);
  });

  test("a later tap joins the leg it detours least from", () => {
    const route = [p(0, 0), p(0.1, 0), p(0.2, 0)];
    expect(insertIndex(route, p(0.05, 0.01))).toBe(1); // beside the first leg
    expect(insertIndex(route, p(0.15, 0.01))).toBe(2); // beside the second
  });

  test("a tap beyond the destination extends the route; the start never moves", () => {
    const route = [p(0, 0), p(0.1, 0)];
    expect(insertIndex(route, p(0.15, 0.005))).toBe(2);
    expect(insertIndex(route, p(-0.05, 0))).toBe(1);
  });

  test("reorder and the coordinate-free names", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    const w = { id: "x", lon: 0, lat: 0 };
    expect([0, 1, 2].map((i) => waypointLabel(w, i, 3))).toEqual(["Start", "Waypoint 1", "Destination"]);
    expect(waypointLabel({ ...w, place: "St. Peter" }, 1, 3)).toBe("St. Peter");
  });
});

describe("the profile against its base", () => {
  const base = { weights: { unpaved: 85, quiet: 50, forest_edge: 50 }, limits: { no_stairs: true } as const };

  test("weights snap to steps of 5 with a dead zone around no opinion", () => {
    expect(snapWeight(43)).toBe(45);
    expect(snapWeight(4)).toBe(0);
    expect(snapWeight(-6)).toBe(0);
    expect(snapWeight(-8)).toBe(-10);
    expect(snapWeight(-130)).toBe(-100);
  });

  test("no changes: the base as it comes", () => {
    const list = changes(base, { ...base.weights }, { ...base.limits }, CATALOGUE);
    expect(list).toEqual([]);
    expect(changeSentence("Gravel explorer", list)).toBe("Gravel explorer, as it comes.");
  });

  test("changed, added, removed and limits, said in one sentence", () => {
    const list = changes(
      base,
      { unpaved: 40, quiet: 50, water: 60 },
      { no_stairs: false, max_grade: 15 },
      CATALOGUE,
    );
    expect(list.map((c) => [c.id, c.added, c.removed])).toEqual([
      ["unpaved", false, false],
      ["forest_edge", false, true],
      ["water", true, false],
      ["no_stairs", false, true],
      ["max_grade", true, false],
    ]);
    expect(changeSentence("Gravel explorer", list)).toBe(
      "Gravel explorer, but less gravel, no opinion on forest edge, more water, stairs allowed again and never anything steeper than 15 %.",
    );
  });

  test("explicit 0 is not absent: an added row at 0 is a change, a core row missing from both is not", () => {
    expect(changes(base, { ...base.weights, water: 0 }, base.limits, CATALOGUE)[0]?.text).toBe(
      "water (no opinion yet)",
    );
    // `climb` is core: absent in the base and set to 0 now is no change
    expect(changes(base, { ...base.weights, climb: 0 }, base.limits, CATALOGUE)).toEqual([]);
  });

  test("a number limit switched on with `true` means its default", () => {
    expect(normaliseLimits({ max_grade: true, paved_only: false }, CATALOGUE)).toEqual({
      max_grade: 12,
      paved_only: false,
    });
    expect(changes({ weights: {}, limits: { max_grade: 12 } }, {}, { max_grade: 12 }, CATALOGUE)).toEqual([]);
  });

  test("routing-equal profiles", () => {
    expect(
      sameCost({ weights: { unpaved: 0 }, limits: { paved_only: false } }, { weights: {}, limits: {} }),
    ).toBe(true);
    expect(sameCost({ weights: { unpaved: 5 }, limits: {} }, { weights: {}, limits: {} })).toBe(false);
  });

  test("words beside the slider, the catalogue's own words at the ends", () => {
    expect(weightWord(undefined, 0)).toBe("no opinion");
    expect(weightWord(undefined, 50)).toBe("prefer");
    expect(weightWord(undefined, -20)).toBe("rather not");
    expect(weightWord({ low_label: "keep it flat" }, -80)).toBe("keep it flat");
  });
});

describe("detours", () => {
  const base = { weights: { unpaved: 85 }, limits: {} };

  test("min_factor snaps to the engine's grid and range", () => {
    expect(snapMinFactor(0.52)).toBe(0.5);
    expect(snapMinFactor(0.1)).toBe(0.3);
    expect(snapMinFactor(7)).toBe(1);
    expect(snapMinFactor(0.35)).toBe(0.35);
  });

  test("words and hint at the ends and the default", () => {
    expect(detourWord(1)).toBe("Direct");
    expect(detourWord(0.3)).toBe("Go far for good ways");
    expect(detourTimes(0.5)).toBe("2×");
    expect(detourTimes(0.3)).toBe("3.3×");
    expect(detourHint(0.5)).toBe("Up to 2× longer for a way you like.");
    expect(detourHint(1)).toContain("only avoid");
  });

  test("a moved slider is a change and routes differently; the profile carries the bounds", () => {
    const list = changes(base, base.weights, base.limits, CATALOGUE, { base: 0.5, plan: 0.3 });
    expect(list.map((c) => c.text)).toEqual(["more detours"]);
    expect(changes(base, base.weights, base.limits, CATALOGUE, { base: 0.5, plan: 0.5 })).toEqual([]);
    expect(sameCost({ ...base, minFactor: 0.5 }, { ...base, minFactor: 0.3 })).toBe(false);
    expect(planProfile(undefined, {}, {}, 0.4).bounds?.min_factor).toBe(0.4);
    expect(planProfile(undefined, {}, {}).bounds).toBeUndefined();
  });
});

describe("errors", () => {
  test("a limit named by the engine, and the order to probe the others", () => {
    expect(
      limitInMessage(
        'no route: a waypoint is on a way excluded by the limit "Paved only" and no allowed way',
        CATALOGUE,
      ),
    ).toBe("paved_only");
    expect(limitInMessage("no route between these waypoints", CATALOGUE)).toBeNull();
    // this plan's own limits first, switched-off ones never
    expect(probeOrder({ no_stairs: true }, { no_stairs: true, paved_only: true, max_grade: false })).toEqual([
      "paved_only",
      "no_stairs",
    ]);
  });
});

describe("comparing two routes", () => {
  const a = result({ km: 35.5, climb: 1160, minutes: 222, unpaved: 0.75, mainKm: 0.5, arcs: [1, 2, 3] });
  const b = result({ km: 41.8, climb: 715, minutes: 160, unpaved: 0, mainKm: 11.8, arcs: [1, 4, 5] });

  test("the trade-off sentence", () => {
    const words = tradeoff(a, b, { stretches: [], shared_m: 14_200, a_only_m: 21_300, b_only_m: 27_600 });
    expect(tradeoffText("Paved & quiet", words)).toBe(
      "Paved & quiet is 6.3 km longer but 62 min faster, with 445 m less climbing. It gives up 26.6 km of gravel and puts you on main roads for 11.8 km; the two share 40 % of the way.",
    );
    expect(words.second.find((x) => x.strong)?.text).toBe("puts you on main roads for 11.8 km");
  });

  test("deltas against the ghost", () => {
    expect(deltas(b, a)).toEqual(["+6.3 km", "−445 m", "−62 min", "−26.6 km gravel", "+11.3 km main road"]);
    expect(deltas(a, a)).toEqual([]);
  });
});

describe("persistence", () => {
  test("a stored plan comes back; garbage and waypoints outside the region do not", () => {
    const plan = {
      v: 1,
      waypoints: [
        { id: "a", lon: 0.001, lat: 0.002, place: "Somewhere" },
        { id: "b", lon: 5, lat: 5 },
      ],
      baseId: "gravel_explorer",
      weights: { unpaved: 40, nope: "x" },
      limits: { max_grade: 15 },
      compareId: "paved_quiet",
      lineBy: "surface",
    };
    const back = parsePlan(JSON.stringify(plan), [-0.02, -0.02, 0.02, 0.02]);
    expect(back?.waypoints).toEqual([{ id: "a", lon: 0.001, lat: 0.002, place: "Somewhere" }]);
    expect(back?.weights).toEqual({ unpaved: 40 });
    expect(back?.compareId).toBe("paved_quiet");
    expect(back?.lineBy).toBe("surface");
    expect(parsePlan("{nope", undefined)).toBeNull();
    expect(parsePlan(JSON.stringify({ v: 2 }), undefined)).toBeNull();
  });

  test("own presets", () => {
    const own = parsePresets(
      JSON.stringify([
        { id: "own-1", blurb: "Mine", profile: { name: "Mine", weights: {}, limits: {} } },
        { id: 3 },
      ]),
    );
    expect(own).toEqual([
      { id: "own-1", blurb: "Mine", profile: { name: "Mine", weights: {}, limits: {} }, own: true },
    ]);
    expect(parsePresets("[")).toEqual([]);
  });
});

describe("GPX", () => {
  test("one track with elevations, the stops as waypoints, names escaped", () => {
    const gpx = routeToGpx(result({ km: 2 }), "Start & <end>", [
      { lon: 0, lat: 0, name: "Start" },
      { lon: 0.02, lat: 0, name: "Destination" },
    ]);
    expect(gpx).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
    expect(gpx).toContain('<gpx version="1.1" creator="Kompass" xmlns="http://www.topografix.com/GPX/1/1">');
    expect(gpx).toContain("<name>Start &amp; &lt;end&gt;</name>");
    expect(gpx.match(/<trkpt /g)?.length).toBe(3);
    expect(gpx).toContain('<trkpt lat="0.000000" lon="0.010000"><ele>350.0</ele></trkpt>');
    expect(gpx.match(/<wpt /g)?.length).toBe(2);
    expect(gpx.trim()).toEndWith("</gpx>");
  });
});
