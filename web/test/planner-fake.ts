// Test helpers for the planner: a small catalogue, presets, route results and a fake engine.
import type {
  BoardRow,
  Catalogue,
  CompareRequest,
  Hills,
  PrefId,
  Preset,
  Profile,
  RouteRequest,
  RouteResult,
  StretchCost,
  StructuredInfo,
} from "@/engine/generated/types";
import type { RouteOutcome } from "@/engine/protocol";
import type { PlannerEngine } from "@/planner/store";

const row = (id: BoardRow, label: string) => ({ id, label, hint: `${label}.`, ways: `${label}.` });
const curve = (id: string, label: string, up: number[], down: number[], loose: number) => ({
  id,
  label,
  blurb: `${label}.`,
  hills: {
    up: { "3": up[0] ?? 1, "6": up[1] ?? 1, "10": up[2] ?? 1, "15": up[3] ?? 1 },
    down: { "8": down[0] ?? 1, "15": down[1] ?? 1 },
    loose_pct: loose,
  } satisfies Hills,
});

/** The structured controls of the catalogue (#66), as the engine has them. */
export const STRUCTURED: StructuredInfo = {
  boards: [
    {
      id: "surface",
      label: "Surface",
      hint: "What you roll on, ranked.",
      rows: [
        row("paved", "Smooth paved"),
        row("rough_paved", "Rough paved"),
        row("compacted", "Compacted"),
        row("gravel", "Gravel"),
        row("soft", "Soft ground"),
        row("unknown", "Unknown"),
      ],
      replaces: ["unpaved"],
      replaces_limits: ["paved_only"],
    },
    {
      id: "way",
      label: "Way type",
      hint: "Roads, tracks and paths, ranked.",
      rows: [
        row("main", "Main roads"),
        row("country_road", "Country roads"),
        row("residential", "Residential"),
        row("service", "Service roads"),
        row("track", "Tracks"),
        row("path", "Paths"),
        row("cycle_path", "Cycle paths"),
        row("cycle_path_roadside", "Roadside cycle paths"),
      ],
      replaces: [],
      replaces_limits: [],
    },
  ],
  tiers: [
    { id: "love", label: "Love", hint: "", factor: 1 },
    { id: "like", label: "Like", hint: "", factor: 1.15 },
    { id: "fine", label: "Fine", hint: "", factor: 1.35 },
    { id: "dislike", label: "Dislike", hint: "", factor: 2 },
    { id: "avoid", label: "Avoid", hint: "" },
  ],
  hills: {
    label: "Hills",
    hint: "",
    handles: [
      { grade_pct: -15, min: 1, max: 10, step: 0.05 },
      { grade_pct: -8, min: 1, max: 10, step: 0.05 },
      { grade_pct: 3, min: 0.5, max: 10, step: 0.05 },
      { grade_pct: 6, min: 0.5, max: 10, step: 0.05 },
      { grade_pct: 10, min: 0.5, max: 10, step: 0.05 },
      { grade_pct: 15, min: 0.5, max: 10, step: 0.05 },
    ],
    flat_beyond_pct: 15,
    loose_pct: { min: 0, max: 50, default: 20 },
    loose_label: "On loose ground, grades count this much steeper",
    curves: [
      curve("flat_please", "Flat please", [1.3, 1.9, 3, 5], [1.1, 1.6], 20),
      curve("dont_mind", "Don't mind", [1, 1.1, 1.4, 2], [1, 1.2], 0),
      curve("climber", "Climber", [0.9, 0.8, 0.85, 1.5], [1, 1.3], 0),
      curve("no_walls", "No walls", [1, 1.15, 2.5, 6], [1.1, 2], 20),
    ],
    replaces: ["climb"],
  },
  detours: { min: 0.5, max: 2, default: 1 },
  detours_hint: "How far the ranking pulls.",
};

const FINE_SURFACE = {
  paved: "fine",
  rough_paved: "fine",
  compacted: "fine",
  gravel: "fine",
  soft: "fine",
  unknown: "fine",
} as const;
const FINE_WAY = {
  main: "fine",
  country_road: "fine",
  residential: "fine",
  service: "fine",
  track: "fine",
  path: "fine",
  cycle_path: "fine",
  cycle_path_roadside: "fine",
} as const;

/** The fake conversion: `unpaved` > 0 loves gravel, < 0 dislikes it; `paved_only` avoids it; `climb` a curve. */
export function fakeToStructured(p: Profile): Profile {
  if (p.boards || p.hills || p.detours !== undefined) return p;
  const { unpaved, climb, ...weights } = p.weights;
  const { paved_only, ...limits } = p.limits;
  const tier = paved_only ? "avoid" : (unpaved ?? 0) > 0 ? "love" : (unpaved ?? 0) < 0 ? "dislike" : "fine";
  const up = 1 + Math.max(0, -(climb ?? 0)) / 50;
  return {
    ...p,
    weights,
    limits,
    turn_m: 40,
    boards: {
      surface: { ...FINE_SURFACE, compacted: tier, gravel: tier, soft: tier, unknown: tier },
      way: { ...FINE_WAY },
    },
    hills: { up: { "3": up, "6": up, "10": up, "15": up }, down: { "8": 1, "15": 1 }, loose_pct: 0 },
    detours: 1,
  };
}

/** The twins of `PRESETS` (the conversion of each). */
export const STRUCTURED_PRESETS = (): Preset[] =>
  PRESETS.map((p) => ({ ...p, id: `${p.id}_structured`, profile: fakeToStructured(p.profile) }));

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
  turn_m: { min: 0, max: 500, default: 20 },
  structured: STRUCTURED,
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
      turns: 0,
      turn_cost: 0,
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
      turns: 0,
      turn_cost: 0,
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
    turns: 0,
    turn_cost: 0,
  };
}

/** A fake engine: answers routes from `answer` (synchronously resolved promises), records the calls. */
export function fakeEngine(answer: (request: RouteRequest, lane: string) => RouteOutcome) {
  const calls: Call[] = [];
  const compares: CompareRequest[] = [];
  const engine: PlannerEngine = {
    presets: async () => PRESETS,
    structuredPresets: async () => STRUCTURED_PRESETS(),
    toStructured: async (profile) => fakeToStructured(profile),
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
