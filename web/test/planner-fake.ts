// Test helpers for the planner: a small catalogue, presets, route results and a fake engine.
import type {
  Catalogue,
  CompareRequest,
  PrefId,
  Preset,
  RouteRequest,
  RouteResult,
  StretchCost,
} from "@/engine/generated/types";
import type { RouteOutcome } from "@/engine/protocol";
import type { PlannerEngine } from "@/planner/store";

export const CATALOGUE: Catalogue = {
  version: 1,
  groups: [
    { id: "surface", label: "Surface", blurb: "What you roll on" },
    { id: "landscape", label: "Landscape", blurb: "Forest, water, open land" },
    { id: "terrain", label: "Terrain", blurb: "Climbing and ramps" },
  ],
  preferences: (
    [
      ["unpaved", "surface", "Gravel & unpaved", "Gravel", 50],
      ["quiet", "surface", "Low traffic", "Quiet", 50],
      ["climb", "terrain", "Climbing", "Climb", -40],
      ["novel", "landscape", "Never ridden", "New", 50],
      ["water", "landscape", "Along rivers & lakes", "Water", 60],
      ["forest_edge", "landscape", "Along a forest edge", "Forest edge", 60],
    ] as const
  ).map(([id, group, label, short, def]) => ({
    id,
    kind: "soft",
    group,
    label,
    short,
    hint: `${label}.`,
    default: def,
    max_bonus: 0.7,
    max_penalty: 2,
    gated: false,
    personal: id === "novel",
  })),
  limits: [
    {
      id: "paved_only",
      kind: "limit_flag",
      group: "surface",
      label: "Paved only",
      hint: "Sealed or nothing.",
    },
    {
      id: "no_stairs",
      kind: "limit_flag",
      group: "terrain",
      label: "No stairs or carrying",
      hint: "No steps.",
    },
    {
      id: "max_grade",
      kind: "limit_number",
      group: "terrain",
      label: "Max grade",
      hint: "Nothing steeper.",
      number: { min: 4, max: 30, step: 1, default: 12, unit: "%" },
    },
  ],
  bounds: { min_factor: { min: 0.3, max: 1, default: 0.5 }, max_factor: { min: 2, max: 100, default: 20 } },
};

export const PRESETS: Preset[] = [
  {
    id: "gravel_explorer",
    blurb: "Tracks, forest edges, something new",
    profile: {
      name: "Gravel explorer",
      weights: { unpaved: 85, quiet: 50, climb: 20, novel: 60, forest_edge: 50 },
      limits: { no_stairs: true },
    },
  },
  {
    id: "paved_quiet",
    blurb: "Bike paths and small roads",
    profile: {
      name: "Paved & quiet",
      weights: { unpaved: -70, quiet: 60 },
      limits: { paved_only: true, no_stairs: true },
    },
  },
];

/** A straight route with the given totals; `arcs` tell routes apart. */
export function result(o: {
  km: number;
  climb?: number;
  minutes?: number;
  unpaved?: number;
  mainKm?: number;
  arcs?: number[];
  legs?: number;
  /** metres per preference the route touches (`breakdown.touched`) */
  touched?: Partial<Record<PrefId, number>>;
}): RouteResult {
  const d = o.km * 1000;
  const legs = o.legs ?? 1;
  return {
    summary: {
      distance_m: d,
      ascent_m: o.climb ?? 100,
      descent_m: o.climb ?? 100,
      duration_s: (o.minutes ?? o.km * 3) * 60,
      cost: d,
      reused_m: 0,
      shape_cost: 0,
      override_cost: 0,
      unpaved_share: o.unpaved ?? 0.5,
      unknown_surface_share: 0,
      main_road_m: (o.mainKm ?? 0) * 1000,
    },
    breakdown: {
      surface: [
        { key: "gravel", length_m: d * (o.unpaved ?? 0.5), share: o.unpaved ?? 0.5 },
        { key: "paved", length_m: d * (1 - (o.unpaved ?? 0.5)), share: 1 - (o.unpaved ?? 0.5) },
      ],
      way: [{ key: "track", length_m: d, share: 1 }],
      touched: Object.entries(o.touched ?? {}).map(([key, m]) => ({
        key: key as PrefId,
        length_m: m,
        share: m / d,
      })),
    },
    waypoints: [],
    legs: Array.from({ length: legs }, (_, i) => ({
      distance_m: d / legs,
      ascent_m: 0,
      descent_m: 0,
      duration_s: 0,
      cost: 0,
      reused_m: 0,
      shape_cost: 0,
      override_cost: 0,
      arcs: [i, i + 1],
      segments: [0, 1],
      settled: 0,
    })),
    segments: [
      {
        start_m: 0,
        length_m: d,
        arcs: [0, 1],
        vertices: [0, 2],
        surface: "gravel",
        way: "track",
        factor: 0.7,
        extra_m: 0,
        why: [{ id: "unpaved", factor: 0.6 }],
      },
    ],
    arcs: o.arcs ?? [1, 2, 3],
    arc_vertex: [0],
    geometry: {
      coordinates: [
        [0, 0],
        [0.01, 0],
        [0.02, 0],
      ],
      distance_m: [0, d / 2, d],
      elevation_m: [300, 350, 320],
    },
    notes: [],
    overrides: [],
  };
}

export type Call = { lane: string; request: RouteRequest };

/** A costed stretch for `compare` answers. */
export function stretchCost(o: {
  m: number;
  cost: number;
  factor?: number;
  atMin?: number;
  start?: number;
}): StretchCost {
  return {
    span: { arcs: [0, 1], start_m: o.start ?? 0, length_m: o.m },
    cost: o.cost,
    factor: o.factor ?? o.cost / Math.max(1, o.m),
    extra_m: 0,
    clamped_min_m: o.atMin ?? 0,
    clamped_max_m: 0,
    why: [],
    ways: [{ key: "track", length_m: o.m, share: 1 }],
    closed: [],
    overrides: [],
  };
}

/** A fake engine: answers routes from `answer` (synchronously resolved promises), records the calls. */
export function fakeEngine(answer: (request: RouteRequest, lane: string) => RouteOutcome) {
  const calls: Call[] = [];
  const compares: CompareRequest[] = [];
  const engine: PlannerEngine = {
    presets: async () => PRESETS,
    catalogue: async () => CATALOGUE,
    route: async (request, lane) => {
      calls.push({ lane, request });
      return answer(request, lane);
    },
    diff: async (a, b) => ({
      stretches: [],
      shared_m: Math.min(a.length, b.length) * 100,
      a_only_m: 0,
      b_only_m: 0,
    }),
    edgeCosts: async () => {
      throw new Error("not in the fake");
    },
    explainEdge: async () => {
      throw new Error("not in the fake");
    },
    edgeRun: async (edge) => ({
      edges: [edge, edge + 1],
      index: 0,
      length_m: 420,
      coordinates: [
        [0, 0],
        [0.002, 0],
        [0.004, 0.001],
      ],
    }),
    compare: async (request) => {
      compares.push(request);
      const a = stretchCost({ m: request.a.length * 100, cost: request.a.length * 80 });
      const b = stretchCost({ m: request.b.length * 100, cost: request.b.length * 100 });
      return {
        a,
        b,
        stretches: [{ a, b, cost_delta: b.cost - a.cost, length_delta_m: b.span.length_m - a.span.length_m }],
        shared_m: 0,
      };
    },
    cancel: () => undefined,
  };
  return { engine, calls, compares };
}

export function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

/** Lets the store's scheduled passes and the fake engine's promises run. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
