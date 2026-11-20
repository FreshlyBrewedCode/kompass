// Test helpers for the planner: a small catalogue, presets, route results and a fake engine.
import type { Catalogue, Preset, RouteRequest, RouteResult } from "@/engine/generated/types";
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
      ["unpaved", "surface", "Gravel & unpaved", "Gravel", 50, true],
      ["quiet", "surface", "Low traffic", "Quiet", 50, true],
      ["climb", "terrain", "Climbing", "Climb", -40, true],
      ["novel", "landscape", "Never ridden", "New", 50, true],
      ["water", "landscape", "Along rivers & lakes", "Water", 60, false],
      ["forest_edge", "landscape", "Along a forest edge", "Forest edge", 60, false],
    ] as const
  ).map(([id, group, label, short, def, core]) => ({
    id,
    kind: "soft",
    group,
    label,
    short,
    hint: `${label}.`,
    default: def,
    core,
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
  core: ["unpaved", "quiet", "climb", "novel"],
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
    },
    waypoints: [],
    legs: Array.from({ length: legs }, (_, i) => ({
      distance_m: d / legs,
      ascent_m: 0,
      descent_m: 0,
      duration_s: 0,
      cost: 0,
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
  };
}

export type Call = { lane: string; request: RouteRequest };

/** A fake engine: answers routes from `answer` (synchronously resolved promises), records the calls. */
export function fakeEngine(answer: (request: RouteRequest, lane: string) => RouteOutcome) {
  const calls: Call[] = [];
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
    cancel: () => undefined,
  };
  return { engine, calls };
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
