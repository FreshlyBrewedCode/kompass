// This plan's exceptions (docs/planner.md, "This plan's exceptions"): a few stretches of way the plan
// avoids, prefers or allows, on top of its profile. Pure functions, no React: the list as the store
// keeps it, what goes to the engine (one override per edge), the words, and the saved form.
import type { EdgeOverride, EdgeRun, LimitId, OverrideKind } from "@/engine/generated/types";
import { metresText } from "./cost/model";

/** One exception: a run of edges between junctions ("this segment") and what the plan does with it. */
export type PlanOverride = {
  id: string;
  kind: OverrideKind;
  /** the run's edges (graph ids of the build in `PlanOverrides.build`) */
  edges: number[];
  /** the run's line, `[lon, lat]`, for the map's mark */
  line: [number, number][];
  lengthM: number;
  /** the way in words, as the inspector named it ("Track") */
  way: string;
  /** an allow: the limit it was made for (a lift would have changed the whole plan) */
  limit?: LimitId;
};

/** The exceptions as saved with the plan: edge ids hold only for the build they were made on. */
export type SavedOverrides = { build: string; list: PlanOverride[] };

let seq = 0;
export const overrideId = () => `o${Date.now().toString(36)}${(seq++).toString(36)}`;

/** A new exception from the inspector's run of edges. */
export function makeOverride(kind: OverrideKind, run: EdgeRun, way: string, limit?: LimitId): PlanOverride {
  return {
    id: overrideId(),
    kind,
    edges: [...run.edges],
    line: run.coordinates.map(([x, y]) => [x, y] as [number, number]),
    lengthM: run.length_m,
    way,
    ...(limit ? { limit } : {}),
  };
}

/** Adds an exception; one that shares an edge with it goes (a way has one exception at a time). */
export function withOverride(list: readonly PlanOverride[], next: PlanOverride): PlanOverride[] {
  const mine = new Set(next.edges);
  return [...list.filter((o) => !o.edges.some((e) => mine.has(e))), next];
}

/** The exception on an edge, if any. */
export function overrideOn(list: readonly PlanOverride[], edge: number): PlanOverride | undefined {
  return list.find((o) => o.edges.includes(edge));
}

/** What the engine gets: one override per edge (a later exception wins an edge). */
export function overridesWire(list: readonly PlanOverride[]): EdgeOverride[] {
  const by = new Map<number, OverrideKind>();
  for (const o of list) for (const e of o.edges) by.set(e, o.kind);
  return [...by].map(([edge, kind]) => ({ edge, kind }));
}

export const KIND_WORD: Record<OverrideKind, string> = {
  avoid: "Avoided",
  prefer: "Preferred",
  allow: "Allowed",
};

/** "Avoided · Track · 420 m" */
export function overrideText(o: PlanOverride): string {
  return `${KIND_WORD[o.kind]} · ${o.way} · ${metresText(o.lengthM)}`;
}

/** "2 exceptions" */
export function exceptionsCount(n: number): string {
  return n === 1 ? "1 exception" : `${n} exceptions`;
}

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const KINDS: readonly OverrideKind[] = ["avoid", "prefer", "allow"];

/**
 * The saved exceptions, for the region build now loaded: `kept` when they were made on this build,
 * else none (`dropped` says how many went: edge ids change with every build).
 */
export function parseOverrides(
  raw: unknown,
  build: string | undefined,
): { kept: PlanOverride[]; dropped: number } {
  if (!raw || typeof raw !== "object") return { kept: [], dropped: 0 };
  const r = raw as Partial<SavedOverrides>;
  const list = (Array.isArray(r.list) ? r.list : []).filter(
    (o): o is PlanOverride =>
      !!o &&
      typeof o.id === "string" &&
      KINDS.includes(o.kind) &&
      Array.isArray(o.edges) &&
      o.edges.length > 0 &&
      o.edges.every((e) => Number.isInteger(e) && e >= 0) &&
      Array.isArray(o.line) &&
      o.line.every((p) => Array.isArray(p) && num(p[0]) && num(p[1])) &&
      num(o.lengthM) &&
      typeof o.way === "string",
  );
  if (build === undefined || r.build !== build) return { kept: [], dropped: list.length };
  // one exception per edge, the later wins (as when they were made)
  let kept: PlanOverride[] = [];
  for (const o of list)
    kept = withOverride(kept, {
      id: o.id,
      kind: o.kind,
      edges: o.edges,
      line: o.line,
      lengthM: o.lengthM,
      way: o.way,
      ...(typeof o.limit === "string" ? { limit: o.limit } : {}),
    });
  return { kept, dropped: 0 };
}
