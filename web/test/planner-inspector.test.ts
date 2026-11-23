import { describe, expect, test } from "bun:test";
import type {
  ArcCostExplanation,
  EdgeExplanation,
  PrefPart,
  RouteComparison,
  StretchCost,
} from "@/engine/generated/types";
import { LongPress } from "@/planner/inspector/gesture";
import {
  arrange,
  coordsText,
  exchange,
  focusArc,
  headline,
  layoutOf,
  lines,
  matchText,
  midpoint,
  nearestPiece,
  onRoute,
  times,
  whyNotVerdict,
} from "@/planner/inspector/model";
import { CATALOGUE, stretchCost } from "./planner-fake";

// The segment inspector's words (docs/planner.md, "The segment inspector").

function arc(o: Partial<ArcCostExplanation> = {}): ArcCostExplanation {
  return {
    lifted: [],
    arc: 14,
    preferences: [],
    quality: 1,
    bonus: 1,
    gate: 1,
    raw_factor: 1,
    factor: 1,
    ascent_m: 0,
    grade_up_pct: 0,
    grade_down_pct: 0,
    additive: [],
    extra_m: 0,
    cost: 420,
    cost_per_m: 1,
    closed_by: [],
    ...o,
  };
}
const pref = (
  id: PrefPart["id"],
  weight: number,
  factor: number,
  membership = 1,
  role: PrefPart["role"] = "quality",
): PrefPart => ({ id, weight, membership, factor, role });
function edge(
  along: ArcCostExplanation,
  against: ArcCostExplanation = { ...along, arc: 15 },
): EdgeExplanation {
  return {
    edge: 7,
    length_m: 420,
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

describe("exchange rates", () => {
  test("a factor as a detour worth taking, or how far the router goes to avoid it", () => {
    expect(times(0.63)).toBe("0.63×");
    expect(times(2.44)).toBe("2.4×");
    expect(times(12.4)).toBe("12×");
    expect(exchange(0.63)).toBe("worth a detour of up to 1.6×");
    expect(exchange(2.4)).toBe("a way up to 2.4× as long would win against it");
    expect(exchange(1.01)).toBe("neutral: it counts as long as it is");
  });

  test("the headline: what the router counts the way as, the additive terms included", () => {
    const x = edge(arc({ factor: 0.63, cost: 264.6 }));
    expect(headline(x, x.along)).toEqual({
      title: "Counts as 0.63× its length",
      rate: "420 m count as 265 m: worth a detour of up to 1.6×.",
      perM: 0.63,
    });
    // a neutral way with 60 m of climbing on top is dearer than its length
    const up = edge(arc({ factor: 1, extra_m: 60, cost: 480 }));
    expect(headline(up, up.along).title).toBe("Counts as 1.1× its length");
    expect(headline(up, up.along).rate).toContain("a way up to 1.1× as long would win against it");
    const closed = edge(arc({ cost: undefined, closed_by: [{ by: "no_bikes", attribute: "x", value: 1 }] }));
    expect(headline(closed, closed.along).perM).toBeNull();
  });

  test("the direction: the one the route rides, else the cheaper open one", () => {
    const x = edge(arc({ arc: 14, factor: 0.8 }), arc({ arc: 15, factor: 0.6 }));
    expect(focusArc(x, [3, 15, 9]).arc).toBe(15);
    expect(focusArc(x, [14]).arc).toBe(14);
    expect(focusArc(x, null).arc).toBe(15);
    expect(onRoute(7, [3, 15, 9])).toBe(true);
    expect(onRoute(7, [3, 9])).toBe(false);
    expect(onRoute(7, null)).toBe(false);
  });
});

describe("the three groups", () => {
  const along = arc({
    factor: 0.7,
    gate: 0.6,
    ascent_m: 18,
    additive: [
      { kind: "climb", metres: 40 },
      { kind: "barriers", metres: 15 },
    ],
    preferences: [
      pref("unpaved", 50, 0.78),
      pref("quiet", 50, 1.4, -0.45),
      pref("forest_edge", 60, 1, 0, "gated_bonus"),
      pref("water", 60, 0.75, 0.8, "gated_bonus"),
      pref("climb", -40, 1, 0.2, "additive"),
    ],
  });
  const probe = arc({
    preferences: [
      pref("unpaved", 100, 0.6),
      pref("quiet", 100, 1.4, -0.45),
      pref("climb", 100, 0.9, 0.2),
      pref("novel", 100, 0.7, 1),
      pref("forest_edge", 100, 1, 0),
      pref("water", 100, 0.75, 0.8),
    ],
  });

  test("what lowers, what raises, what could apply: in a rider's words", () => {
    const l = lines(
      edge(along),
      along,
      probe,
      { unpaved: 50, quiet: 50, forest_edge: 60, water: 60, climb: -40, novel: 0 },
      CATALOGUE,
    );
    expect(l.lowers.map((x) => x.key)).toEqual(["unpaved", "water"]);
    expect(l.lowers[0]).toMatchObject({
      label: "Gravel & unpaved",
      match: "matches fully",
      value: "×0.78",
      effect: "worth a 1.3× detour",
      weight: 50,
    });
    // a gated bonus counts only through the gate: 1 − 0.25 × 0.6 = ×0.85
    expect(l.lowers[1]?.value).toBe("×0.85");
    expect(l.lowers[1]?.effect).toContain("the bonus counts 60 %");
    expect(l.raises.map((x) => x.key)).toEqual(["quiet", "climb", "fixed:barriers"]);
    expect(l.raises[0]).toMatchObject({
      match: "traffic 45 %",
      value: "×1.4",
      effect: "counts 1.4× as long",
    });
    expect(l.raises[1]).toMatchObject({ value: "+40 m", match: "18 m up" });
    expect(l.raises[2]).toMatchObject({
      pref: null,
      value: "+15 m",
      effect: "a fixed cost: no slider changes it",
    });
    // neutral: matching but at 0 in the plan first; in the plan and not matching last
    expect(l.neutral.map((x) => x.key)).toEqual(["novel", "forest_edge"]);
    expect(l.neutral[0]).toMatchObject({ weight: 0, effect: "in this plan at 0: no say yet" });
    expect(l.neutral[1]).toMatchObject({ match: "no match here", weight: 60 });
  });

  test("a preference not in the plan that would match: what it would do at its usual weight", () => {
    const l = lines(
      edge(along),
      along,
      probe,
      { unpaved: 50, quiet: 50, forest_edge: 60, water: 60, climb: -40 },
      CATALOGUE,
    );
    const novel = l.neutral.find((x) => x.key === "novel");
    // max_bonus 0.7 in the fake catalogue: 0.7 ^ (0.5 × 1) = ×0.84
    expect(novel).toMatchObject({
      weight: null,
      match: "matches fully",
      effect: "not in this plan: at its usual +50 it would count ×0.84 here",
    });
    expect(matchText("tracktype", -0.6)).toBe("the opposite here (60 %)");
    expect(matchText("quiet", 0)).toBe("no traffic here");
  });

  test("while a slider is open, lines keep their group and place", () => {
    const x = edge(along);
    const w = { unpaved: 50, quiet: 50, forest_edge: 60, water: 60, climb: -40 };
    const before = lines(x, along, null, w, CATALOGUE);
    const frozen = layoutOf(before);
    // gravel pushed to −50: it would move to "dearer" and change the order
    const moved = arc({ ...along, preferences: [pref("unpaved", -50, 1.6), ...along.preferences.slice(1)] });
    const after = lines(edge(moved), moved, null, { ...w, unpaved: -50 }, CATALOGUE);
    expect(after.raises.map((l) => l.key)).toContain("unpaved");
    const shown = arrange(after, frozen);
    expect(shown.lowers.map((l) => l.key)).toEqual(["unpaved", "water"]);
    expect(shown.lowers[0]?.value).toBe("×1.6");
    expect(shown.raises.map((l) => l.key)).toEqual(["quiet", "climb", "fixed:barriers"]);
    expect(arrange(after, null)).toBe(after);
  });
});

describe("why not this", () => {
  const side = (o: Parameters<typeof stretchCost>[0] & { why?: StretchCost["why"] }) => ({
    ...stretchCost(o),
    why: o.why ?? [],
  });
  function comparison(a: StretchCost, b: StretchCost): RouteComparison {
    return {
      a: stretchCost({ m: 10_000, cost: 8000 }),
      b: stretchCost({ m: 10_000 + b.span.length_m - a.span.length_m, cost: 8000 + b.cost - a.cost }),
      stretches: [{ a, b, cost_delta: b.cost - a.cost, length_delta_m: b.span.length_m - a.span.length_m }],
      shared_m: 8000,
    };
  }

  test("the extra cost in kilometres, the preference to blame", () => {
    const v = whyNotVerdict(
      comparison(
        side({ m: 1500, cost: 1000, why: [{ id: "unpaved", factor: 0.65 }] }),
        side({ m: 1300, cost: 2800, why: [{ id: "quiet", factor: 2.1 }] }),
      ),
      0.5,
      CATALOGUE,
    );
    expect(v.state).toBe("dearer");
    expect(v.title).toBe("Not used: through here counts 1.8 km more");
    expect(v.blame).toEqual({
      kind: "pref",
      id: "quiet",
      text: "“Low traffic” counts it dearer: ×2.1 through here against ×1.0 planned",
    });
    expect(v.noSlider).toBeNull();
    expect(v.detail).toBe(
      "200 m shorter; where the routes part it counts as 2.8 km against the planned 1.0 km.",
    );
    // the planned side's bonus can be the reason too
    const fav = whyNotVerdict(
      comparison(
        side({ m: 1500, cost: 900, why: [{ id: "unpaved", factor: 0.6 }] }),
        side({ m: 1500, cost: 1500 }),
      ),
      0.5,
      CATALOGUE,
    );
    expect(fav.blame?.text).toBe(
      "“Gravel & unpaved” favours the planned way: ×0.60 there against ×1.0 through here",
    );
  });

  test("no slider can change a way that costs more even at the detour limit; distance to blame", () => {
    const v = whyNotVerdict(
      comparison(side({ m: 1000, cost: 1000 }), side({ m: 2400, cost: 2400 })),
      0.5,
      CATALOGUE,
    );
    expect(v.blame).toEqual({ kind: "distance", text: "Mostly the distance: through here is 1.4 km longer" });
    expect(v.noSlider).toContain("No slider can change this");
    expect(v.noSlider).toContain("1.2 km against the planned 1.0 km");
  });

  test("closed: a limit to lift, or a rule nothing lifts", () => {
    const closedBy = (by: "legal_only" | "no_bikes") => {
      const b = side({ m: 800, cost: 9000 });
      b.closed = [{ by, length_m: 300 }];
      return b;
    };
    const cat = {
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
    const limit = whyNotVerdict(comparison(side({ m: 700, cost: 500 }), closedBy("legal_only")), 0.5, cat);
    expect(limit.blame).toEqual({
      kind: "limit",
      id: "legal_only",
      text: "“Legal access only” closes 300 m of it",
    });
    expect(limit.noSlider).toBe("No slider can change this: only lifting “Legal access only” opens it.");
    const rule = whyNotVerdict(comparison(side({ m: 700, cost: 500 }), closedBy("no_bikes")), 0.5, cat);
    expect(rule.blame).toEqual({ kind: "rule", text: "300 m of it allows no bicycles" });
  });

  test("the same route, about the same cost", () => {
    const same = side({ m: 1000, cost: 1000 });
    expect(whyNotVerdict({ ...comparison(same, same), stretches: [] }, 0.5, null).state).toBe("same");
    const tie = whyNotVerdict(comparison(same, side({ m: 1010, cost: 1010 })), 0.5, null);
    expect(tie.state).toBe("tie");
    expect(tie.title).toContain("about the same");
  });
});

describe("where on the way", () => {
  test("halfway along the piece that was pressed", () => {
    const line: [number, number][] = [
      [0, 0],
      [0.001, 0],
      [0.003, 0],
    ];
    const m = midpoint(line) as [number, number];
    expect(m[0]).toBeCloseTo(0.0015, 6);
    expect(m[1]).toBe(0);
    expect(midpoint([])).toBeNull();
    const far: [number, number][] = [
      [1, 1],
      [1.001, 1],
    ];
    expect(nearestPiece([far, line], [0.002, 0.0001])).toBe(line);
  });
});

describe("the long press", () => {
  function fake() {
    let t = 0;
    const timers = new Map<number, { at: number; run: () => void }>();
    let id = 0;
    return {
      timers: {
        set: (run: () => void, ms: number) => {
          timers.set(++id, { at: t + ms, run });
          return id;
        },
        clear: (i: unknown) => timers.delete(i as number),
        now: () => t,
      },
      advance(ms: number) {
        t += ms;
        for (const [i, x] of [...timers]) {
          if (x.at > t) continue;
          timers.delete(i);
          x.run();
        }
      },
    };
  }

  test("one finger held still fires once; its click echo is swallowed", () => {
    const f = fake();
    const fired: { x: number; y: number }[] = [];
    const p = new LongPress((at) => fired.push(at), { timers: f.timers });
    p.down([{ x: 100, y: 200 }]);
    p.move([{ x: 104, y: 203 }]); // a finger wobbles
    f.advance(499);
    expect(fired).toHaveLength(0);
    f.advance(1);
    expect(fired).toEqual([{ x: 100, y: 200 }]);
    p.up();
    expect(p.swallows()).toBe(true);
    f.advance(1000);
    expect(p.swallows()).toBe(false);
  });

  test("a pan, a pinch or an early lift is not a long press", () => {
    const f = fake();
    let n = 0;
    const p = new LongPress(() => n++, { timers: f.timers });
    p.down([{ x: 0, y: 0 }]);
    p.move([{ x: 30, y: 0 }]);
    f.advance(600);
    p.down([
      { x: 0, y: 0 },
      { x: 50, y: 50 },
    ]);
    f.advance(600);
    p.down([{ x: 0, y: 0 }]);
    f.advance(200);
    p.up();
    f.advance(600);
    expect(n).toBe(0);
    expect(p.swallows()).toBe(false);
  });
});

describe("the pressed point's coordinates", () => {
  test("lat, lon with 5 decimals, from [lon, lat]", () => {
    expect(coordsText([8.123454, 47.123456])).toBe("47.12346, 8.12345");
    expect(coordsText([-0.5, -12.000004])).toBe("-12.00000, -0.50000");
    expect(coordsText([0, 0])).toBe("0.00000, 0.00000");
    // no "-0.00000" for a point a hair west or south of zero
    expect(coordsText([-0.000001, -0.000004])).toBe("0.00000, 0.00000");
  });
});
