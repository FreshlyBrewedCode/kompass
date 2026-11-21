import { describe, expect, test } from "bun:test";
import type {
  ArcCostExplanation,
  EdgeExplanation,
  PrefPart,
  RouteComparison,
} from "@/engine/generated/types";
import type { EdgeCostsResult } from "@/engine/protocol";
import {
  classifyEdge,
  costColorAt,
  costPosition,
  costTicks,
  DIR,
  factorAt,
  formatFactor,
  KIND,
} from "@/map/cost";
import { CostLayer, summarise } from "@/map/cost-layer";
import { COST_STOPS } from "@/map/palette";
import { edgeVerdict, partedBounds, prefRowsOf, roleText, whyNot } from "@/planner/cost/model";
import { CATALOGUE, result, stretchCost } from "./planner-fake";

describe("the cost scale", () => {
  test("diverges at factor 1, log on each side, clamped to the bounds", () => {
    expect(costPosition(1, 0.5, 20)).toBe(0);
    expect(costPosition(0.5, 0.5, 20)).toBeCloseTo(-1);
    expect(costPosition(20, 0.5, 20)).toBeCloseTo(1);
    expect(costPosition(Math.SQRT1_2, 0.5, 20)).toBeCloseTo(-0.5);
    expect(costPosition(Math.sqrt(20), 0.5, 20)).toBeCloseTo(0.5);
    expect(costPosition(0.3, 0.5, 20)).toBe(-1);
    expect(costPosition(50, 0.5, 20)).toBe(1);
    for (const t of [-1, -0.3, 0, 0.4, 1]) expect(costPosition(factorAt(t, 0.5, 20), 0.5, 20)).toBeCloseTo(t);
  });

  test("the ends and the middle are the palette's stops", () => {
    expect(costColorAt(-1, "light")).toBe(COST_STOPS.light[0] as string);
    expect(costColorAt(0, "dark")).toBe(COST_STOPS.dark[3] as string);
    expect(costColorAt(1, "light")).toBe(COST_STOPS.light[6] as string);
  });

  test("factors as text and the key's ticks", () => {
    expect(formatFactor(0.5)).toBe("×0.50");
    expect(formatFactor(1)).toBe("×1.0");
    expect(formatFactor(2.44)).toBe("×2.4");
    expect(formatFactor(20)).toBe("×20");
    expect(costTicks(0.5, 20).map((t) => t.label)).toEqual(["×0.50", "×0.70", "×1", "×4.5", "×20"]);
    expect(costTicks(0.5, 20).map((t) => t.t)[0]).toBe(-1);
  });
});

describe("classifying an edge", () => {
  test("the better direction counts; the clamp and closures are their own kinds", () => {
    expect(classifyEdge(1, 1, 0, 0.5, 20)).toEqual({ t: 0, kind: KIND.open, dir: DIR.same });
    expect(classifyEdge(0.5, 0.8, 0, 0.5, 20)).toMatchObject({ t: -1, kind: KIND.atMin, dir: DIR.along });
    expect(classifyEdge(20, 20, 0, 0.5, 20)).toMatchObject({ kind: KIND.atMax, dir: DIR.same });
    expect(classifyEdge(0, 0, 3, 0.5, 20)).toMatchObject({ kind: KIND.closed });
    // a one-way: only the open direction, the chevron points along it
    expect(classifyEdge(0, 1.2, 0, 0.5, 20)).toMatchObject({ kind: KIND.open, dir: DIR.against });
    // close enough is the same
    expect(classifyEdge(1.0, 1.05, 0, 0.5, 20).dir).toBe(DIR.same);
  });
});

function costs(rows: [edge: number, along: number, against: number, closed: number][]): EdgeCostsResult {
  return {
    edges: Uint32Array.from(rows.map((r) => r[0])),
    factor: Float32Array.from(rows.flatMap((r) => [r[1], r[2]])),
    costPerM: Float32Array.from(rows.flatMap((r) => [r[1], r[2]])),
    closed: Uint8Array.from(rows.map((r) => r[3])),
    codes: ["legal_only", "no_bikes"],
    minFactor: 0.5,
    maxFactor: 20,
    bound: 0.5,
  };
}

describe("the cost layer", () => {
  test("the key's counts: at the clamp, closures by name", () => {
    const s = summarise(
      costs([
        [1, 0.5, 0.5, 0],
        [2, 1, 1, 0],
        [3, 0, 0, 1],
        [4, 0, 0, 1],
        [5, 0, 0, 2],
      ]),
    );
    expect(s).toEqual({
      edges: 5,
      atMin: 1,
      closed: [
        { by: "legal_only", edges: 2 },
        { by: "no_bikes", edges: 1 },
      ],
    });
  });

  class FakeMap {
    zoom = 14;
    state = new Map<number, Record<string, unknown>>();
    writes = 0;
    handlers = new Map<string, () => void>();
    setFeatureState(target: { id?: string | number }, state: Record<string, unknown>) {
      this.writes++;
      this.state.set(target.id as number, { ...this.state.get(target.id as number), ...state });
    }
    getZoom() {
      return this.zoom;
    }
    getBounds() {
      return { getWest: () => 0, getSouth: () => 0, getEast: () => 1, getNorth: () => 1 };
    }
    on(type: string, fn: () => void) {
      this.handlers.set(type, fn);
    }
    off() {}
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const profile = (unpaved: number) => ({ weights: { unpaved }, limits: {} });

  test("colours the answer, writes only what changed, clears stale edges on a new profile", async () => {
    const map = new FakeMap();
    let answer = costs([
      [1, 0.5, 0.5, 0],
      [2, 1, 1.5, 0],
    ]);
    const asked: unknown[] = [];
    const layer = new CostLayer(map as never, "edges", async (p) => {
      asked.push(p.bbox);
      return answer;
    });
    layer.setProfile(profile(50));
    await tick();
    expect(layer.getStatus().state).toBe("ready");
    expect(map.state.get(1)).toMatchObject({ ck: KIND.atMin, ct: -1 });
    expect(map.state.get(2)).toMatchObject({ ck: KIND.open, cd: DIR.along });
    // the box is the view grown by a quarter on every side
    expect(asked[0]).toEqual([-0.25, -0.25, 1.25, 1.25]);
    // a pan, same profile: edge 1 and 2 unchanged, only edge 3 is written
    const before = map.writes;
    answer = costs([
      [2, 1, 1.5, 0],
      [3, 0, 0, 1],
    ]);
    map.handlers.get("moveend")?.();
    await tick();
    expect(map.writes - before).toBe(1);
    expect(map.state.get(1)?.ck).toBe(KIND.atMin);
    expect(map.state.get(3)?.ck).toBe(KIND.closed);
    // a new profile: what the answer does not cover is hidden (kind 0)
    answer = costs([[3, 0, 0, 1]]);
    layer.setProfile(profile(90));
    await new Promise((r) => setTimeout(r, 80));
    expect(map.state.get(1)?.ck).toBe(KIND.none);
    expect(map.state.get(2)?.ck).toBe(KIND.none);
    // below the zoom where the overlay has every edge: no query, a hint
    map.zoom = 11;
    map.handlers.get("moveend")?.();
    await tick();
    expect(layer.getStatus().state).toBe("zoom");
    // off: everything hidden
    layer.setProfile(null);
    expect(map.state.get(3)?.ck).toBe(KIND.none);
    expect(layer.getStatus().state).toBe("off");
  });
});

// ------------------------------------------------------------------ the words

function arc(o: Partial<ArcCostExplanation> & { preferences?: PrefPart[] }): ArcCostExplanation {
  return {
    arc: 0,
    preferences: [],
    quality: 1,
    bonus: 1,
    gate: 1,
    raw_factor: o.factor ?? 1,
    factor: 1,
    ascent_m: 0,
    grade_up_pct: 0,
    grade_down_pct: 0,
    additive: [],
    extra_m: 0,
    cost: 100,
    cost_per_m: 1,
    closed_by: [],
    ...o,
  };
}
const pref = (id: PrefPart["id"], weight: number, factor: number, role: PrefPart["role"] = "quality") => ({
  id,
  weight,
  membership: 1,
  factor,
  role,
});
function edge(along: ArcCostExplanation, against: ArcCostExplanation = along): EdgeExplanation {
  return {
    edge: 7,
    length_m: 100,
    way: "track",
    surface: "gravel",
    cost_surface: "gravel",
    surface_source: "tagged",
    traffic: 0,
    traffic_from: "way",
    attributes: [],
    bounds: { min_factor: 0.5, max_factor: 20 },
    along,
    against,
  };
}

const CAT = {
  ...CATALOGUE,
  limits: [
    ...CATALOGUE.limits,
    {
      id: "legal_only" as const,
      kind: "limit_flag" as const,
      group: "surface" as const,
      label: "Legal access only",
      hint: "",
    },
  ],
};

describe("the verdict of one edge", () => {
  test("held by the detour limit", () => {
    const a = arc({
      preferences: [pref("unpaved", 85, 0.65), pref("track", 40, 0.87), pref("quiet", 50, 1)],
      raw_factor: 0.43,
      factor: 0.5,
      clamp: "min",
    });
    const v = edgeVerdict(edge(a), CATALOGUE);
    expect(v.tone).toBe("preferred");
    expect(v.title).toBe("Preferred ×0.50, held by the detour limit");
    expect(v.notes[0]).toContain("×0.43");
    expect(v.notes[0]).toContain("gravel and tracks");
    // the rows: strongest first, the idle ones apart
    const rows = prefRowsOf(a);
    expect(rows.active.map((p) => p.id)).toEqual(["unpaved", "track"]);
    expect(rows.idle.map((p) => p.id)).toEqual(["quiet"]);
  });

  test("closed, by the limit and the tag behind it", () => {
    const closed = arc({
      factor: 0,
      cost: undefined,
      closed_by: [
        { by: "legal_only", attribute: "bike_access", value: "agricultural" },
        { by: "paved_only", attribute: "surface_class", value: "gravel" },
      ],
    });
    const v = edgeVerdict(edge(closed), CAT);
    expect(v.tone).toBe("closed");
    expect(v.factor).toBeNull();
    expect(v.title).toBe("Closed: legal access only (access=agricultural)");
    expect(v.notes[0]).toBe("Also closed by paved only (surface=gravel).");
  });

  test("neutral when nothing applies; avoided with its reasons; one-way and climbing", () => {
    expect(edgeVerdict(edge(arc({ preferences: [pref("quiet", 50, 1)] })), CATALOGUE).title).toBe(
      "Neutral ×1.0: nothing in this profile applies",
    );
    const main = arc({ preferences: [pref("main", -80, 3.6), pref("quiet", 50, 1.4)], factor: 5.04 });
    const oneway = arc({
      factor: 0,
      closed_by: [{ by: "oneway", attribute: "oneway_bike", value: "forward" }],
    });
    const v = edgeVerdict(edge(main, oneway), CATALOGUE);
    expect(v.title).toBe("Avoided ×5.0: main roads and traffic");
    expect(v.notes).toContain("One-way: only this direction may be ridden.");
    // a path beside a busy road: its traffic is the road's alongside
    const roadside = { ...edge(arc({ preferences: [pref("quiet", 50, 1.25)], factor: 1.25 })) };
    roadside.traffic = 0.27;
    roadside.traffic_from = "alongside";
    const r = edgeVerdict(roadside, CATALOGUE);
    expect(r.title).toBe("Avoided ×1.3: traffic alongside");
    expect(r.notes).toContain("Traffic from the motor road alongside (within 20 m): level 27 %.");
    expect(roleText(pref("quiet", 50, 1.25), 1, true)).toBe("road alongside");
    const up = arc({ factor: 1, ascent_m: 20, extra_m: 40, additive: [{ kind: "climb", metres: 40 }] });
    const down = arc({ factor: 0.8, preferences: [pref("unpaved", 85, 0.8)] });
    const w = edgeVerdict(edge(up, down), CATALOGUE);
    expect(w.factor).toBe(0.8);
    expect(w.notes).toContain("The other direction costs ×1.0 (uphill).");
  });
});

describe("why not through here", () => {
  const comparison = (o: { a: ReturnType<typeof stretchCost>; b: ReturnType<typeof stretchCost> }) =>
    ({
      a: stretchCost({ m: 10_000, cost: 8000 }),
      b: stretchCost({ m: 10_000 + o.b.span.length_m - o.a.span.length_m, cost: 8000 + o.b.cost - o.a.cost }),
      stretches: [
        {
          a: o.a,
          b: o.b,
          cost_delta: o.b.cost - o.a.cost,
          length_delta_m: o.b.span.length_m - o.a.span.length_m,
        },
      ],
      shared_m: 8000,
    }) satisfies RouteComparison;

  test("a longer way at the detour limit: no slider can win it", () => {
    // the planned 1 km at factor 1 (a neutral cycle path); through here 2.4 km at the limit
    const c = comparison({
      a: stretchCost({ m: 1000, cost: 1000, factor: 1 }),
      b: stretchCost({ m: 2400, cost: 1200, factor: 0.5, atMin: 2400 }),
    });
    const w = whyNot(c, 0.5, CATALOGUE);
    expect(w.headline).toBe(
      "Through here is 1.4 km longer, costs 3 % more: the router keeps the planned line.",
    );
    expect(w.hints[0]).toContain("No slider can change this");
    expect(w.hints).toContain(
      "The planned stretch is neutral ×1.0: nothing in the profile counts against it.",
    );
    expect(w.stretches[0]?.through).toMatchObject({ length: "2.4 km", factor: "×0.50", atMin: 1 });
    expect(w.stretches[0]?.delta).toBe("1.4 km longer, costs 20 % more here");
  });

  test("closed parts, both sides at the clamp, no difference at all", () => {
    const closed = stretchCost({ m: 800, cost: 900 });
    closed.closed = [{ by: "legal_only", length_m: 300 }];
    const w = whyNot(comparison({ a: stretchCost({ m: 700, cost: 400 }), b: closed }), 0.5, CAT);
    expect(w.hints[0]).toBe(
      "300 m of the way through here is closed (legal access only): the router never takes it on its own.",
    );
    const both = whyNot(
      comparison({
        a: stretchCost({ m: 1000, cost: 600, atMin: 600 }),
        b: stretchCost({ m: 1100, cost: 700, atMin: 900 }),
      }),
      0.5,
      CATALOGUE,
    );
    expect(both.hints[0]).toContain("Both sides sit largely at the detour limit");
    // a spur: the planned route has nothing where through here detours
    const spur = whyNot(
      comparison({ a: stretchCost({ m: 0, cost: 0 }), b: stretchCost({ m: 1000, cost: 900 }) }),
      0.5,
      CAT,
    );
    expect(spur.hints[0]).toContain("a detour off the planned line");
    expect(spur.stretches[0]?.planned.empty).toBe(true);
    expect(spur.stretches[0]?.delta).toBe("1.0 km longer, adds 900 m of cost here");
    expect(whyNot({ ...comparison({ a: closed, b: closed }), stretches: [] }, 0.5, null).headline).toBe(
      "Through here is the planned route already.",
    );
  });

  test("the box around where the routes part", () => {
    const a = result({ km: 3, arcs: [1, 2, 3] });
    a.arc_vertex = [0, 1, 2];
    const b = result({ km: 3, arcs: [1, 5, 3] });
    b.arc_vertex = [0, 1, 2];
    const c = comparison({ a: stretchCost({ m: 1, cost: 1 }), b: stretchCost({ m: 1, cost: 1 }) });
    const s = c.stretches[0] as RouteComparison["stretches"][number];
    s.a.span.arcs = [1, 2];
    s.b.span.arcs = [1, 2];
    expect(partedBounds(c, a, b)).toEqual([0.01, 0, 0.02, 0]);
  });
});
