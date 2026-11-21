// The cost layer's runtime: asks the engine for the factors of the edges in view (`edgeCosts` by
// bbox) and writes them into the overlay's `feature-state` (`ct` position on the scale, `ck` kind,
// `cd` chevron), in chunks like the explored layer (explored-layer.ts).
//
// - Recoloured on every map move (`moveend`) and every profile change, latest wins: the caller's fetch
//   runs on its own engine lane, so the route never waits behind it for more than one small query.
// - Only what changed is written. A pan with the same profile keeps the edges it already coloured (no
//   flicker at the edges of the view); a new profile clears the ones the new answer does not cover.
// - A new style (theme change) drops feature state: everything is applied again on `style.load`.
import type { Map as MapLibreMap } from "maplibre-gl";
import { isSuperseded, type Superseded } from "@/engine/client";
import type { ClosedBy, Profile } from "@/engine/generated/types";
import type { EdgeCostsResult } from "@/engine/protocol";
import { COST_MINZOOM, classifyEdge, type EdgeCost, KIND } from "./cost";
import { yieldToMain } from "./explored-layer";
import { OVERLAY_SOURCE } from "./style";

export const COST_CHUNK = 4000;
/** The query box is the view grown by this share on every side (a short pan needs no new colours). */
export const BBOX_PAD = 0.25;
/** Kept states beyond this many are dropped when they are out of the last answer. */
const KEEP_MAX = 60_000;

export type CostFetch = (params: {
  profile: Profile;
  bbox: [number, number, number, number];
}) => Promise<EdgeCostsResult | Superseded>;

export type CostStatus = {
  state: "off" | "zoom" | "loading" | "ready" | "error";
  minFactor: number;
  maxFactor: number;
  /** edges in the last answer, and how many of them sit at the lower clamp */
  edges: number;
  atMin: number;
  /** what closes the closed edges in the last answer, most first */
  closed: { by: ClosedBy; edges: number }[];
  /** the engine's answer (round trip) and writing the feature state, ms */
  queryMs: number;
  applyMs: number;
  error?: string;
};

const OFF: CostStatus = {
  state: "off",
  minFactor: 0.5,
  maxFactor: 20,
  edges: 0,
  atMin: 0,
  closed: [],
  queryMs: 0,
  applyMs: 0,
};

type Target = Pick<MapLibreMap, "setFeatureState" | "getBounds" | "getZoom" | "on" | "off">;

/** One edge's state as a number, to see what changed: kind, chevron, position (1/1000). */
const encode = (c: EdgeCost) => c.kind * 100_000 + c.dir * 10_000 + Math.round((c.t + 1) * 1000);

/** What an answer means for the key: counts by kind and closure. */
export function summarise(result: EdgeCostsResult): Pick<CostStatus, "edges" | "atMin" | "closed"> {
  const n = result.edges.length;
  let atMin = 0;
  const closed = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const code = result.closed[i] ?? 0;
    if (code !== 0) closed.set(code, (closed.get(code) ?? 0) + 1);
    else {
      const c = classifyEdge(
        result.factor[2 * i] ?? 0,
        result.factor[2 * i + 1] ?? 0,
        0,
        result.minFactor,
        result.maxFactor,
      );
      if (c.kind === KIND.atMin) atMin++;
    }
  }
  return {
    edges: n,
    atMin,
    closed: [...closed]
      .map(([code, edges]) => ({ by: result.codes[code - 1] as ClosedBy, edges }))
      .filter((c) => c.by !== undefined)
      .sort((a, b) => b.edges - a.edges),
  };
}

export class CostLayer {
  readonly #map: Target;
  readonly #sourceLayer: string;
  readonly #fetch: CostFetch;
  readonly #listeners = new Set<() => void>();
  #status: CostStatus = OFF;
  #profile: Profile | null = null;
  #profileKey = "";
  /** edge → encoded state on the map, and the profile it was computed for */
  #applied = new Map<number, number>();
  #appliedKey = "";
  #last: EdgeCostsResult | null = null;
  #run = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #onMove = () => this.#schedule(0);
  readonly #onStyle = () => {
    // the new style has no feature state: write the last answer again
    this.#applied = new Map();
    if (this.#last && this.#profile) void this.#apply(this.#last, ++this.#run, 0);
  };

  constructor(map: Target, sourceLayer: string, fetch: CostFetch) {
    this.#map = map;
    this.#sourceLayer = sourceLayer;
    this.#fetch = fetch;
    map.on("moveend", this.#onMove);
    map.on("style.load", this.#onStyle);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  readonly getStatus = (): CostStatus => this.#status;

  #setStatus(patch: Partial<CostStatus>) {
    this.#status = { ...this.#status, ...patch };
    for (const l of [...this.#listeners]) l();
  }

  /** The profile to colour by; `null` switches the layer off (and clears what it wrote). */
  setProfile(profile: Profile | null) {
    const key = profile ? JSON.stringify([profile.weights, profile.limits, profile.bounds ?? null]) : "";
    if (key === this.#profileKey) return;
    this.#profile = profile;
    this.#profileKey = key;
    if (!profile) {
      this.#run++;
      if (this.#timer) clearTimeout(this.#timer);
      this.#clear(new Set());
      this.#last = null;
      this.#setStatus(OFF);
      return;
    }
    // a slider drag sends a step per frame: colour the latest one, a little behind
    this.#schedule(this.#status.state === "off" ? 0 : 60);
  }

  /** Query again now (e.g. the engine became ready). */
  refresh() {
    this.#schedule(0);
  }

  #schedule(ms: number) {
    if (!this.#profile) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#query();
    }, ms);
  }

  async #query() {
    const profile = this.#profile;
    if (!profile) return;
    const run = ++this.#run;
    if (this.#map.getZoom() < COST_MINZOOM) {
      this.#setStatus({ state: "zoom" });
      return;
    }
    const b = this.#map.getBounds();
    const [w, s, e, n] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const dx = (e - w) * BBOX_PAD;
    const dy = (n - s) * BBOX_PAD;
    if (this.#status.state !== "ready") this.#setStatus({ state: "loading" });
    const started = performance.now();
    let result: EdgeCostsResult | Superseded;
    try {
      result = await this.#fetch({ profile, bbox: [w - dx, s - dy, e + dx, n + dy] });
    } catch (error) {
      if (run === this.#run)
        this.#setStatus({ state: "error", error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (isSuperseded(result) || run !== this.#run) return;
    await this.#apply(result, run, performance.now() - started);
  }

  async #apply(result: EdgeCostsResult, run: number, queryMs: number) {
    const started = performance.now();
    const key = this.#profileKey;
    if (this.#appliedKey !== key) {
      // another profile: what the new answer does not cover is stale
      this.#clear(new Set(result.edges));
      this.#appliedKey = key;
    } else if (this.#applied.size > KEEP_MAX) this.#clear(new Set(result.edges));
    this.#last = result;
    const { edges, factor, closed, minFactor, maxFactor } = result;
    const target = (id: number) => ({ source: OVERLAY_SOURCE, sourceLayer: this.#sourceLayer, id });
    for (let start = 0; start < edges.length; start += COST_CHUNK) {
      const end = Math.min(edges.length, start + COST_CHUNK);
      for (let i = start; i < end; i++) {
        const id = edges[i] as number;
        const c = classifyEdge(
          factor[2 * i] ?? 0,
          factor[2 * i + 1] ?? 0,
          closed[i] ?? 0,
          minFactor,
          maxFactor,
        );
        const code = encode(c);
        if (this.#applied.get(id) === code) continue;
        this.#map.setFeatureState(target(id), { ct: c.t, ck: c.kind, cd: c.dir });
        this.#applied.set(id, code);
      }
      if (end < edges.length) {
        await yieldToMain();
        if (run !== this.#run) return;
      }
    }
    this.#setStatus({
      state: "ready",
      minFactor,
      maxFactor,
      ...summarise(result),
      queryMs,
      applyMs: performance.now() - started,
    });
  }

  /** Hides every coloured edge not in `keep` (kind 0 is not drawn). */
  #clear(keep: Set<number>) {
    for (const id of [...this.#applied.keys()]) {
      if (keep.has(id)) continue;
      this.#map.setFeatureState(
        { source: OVERLAY_SOURCE, sourceLayer: this.#sourceLayer, id },
        { ck: KIND.none },
      );
      this.#applied.delete(id);
    }
  }

  destroy() {
    this.#run++;
    if (this.#timer) clearTimeout(this.#timer);
    this.#map.off("moveend", this.#onMove);
    this.#map.off("style.load", this.#onStyle);
    this.#listeners.clear();
  }
}
