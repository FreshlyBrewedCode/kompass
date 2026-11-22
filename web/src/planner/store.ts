// The planner's one state model (docs/planner.md): the plan (waypoints, base preset, this plan's
// changes, the compared preset), the routes the engine made of it, and which part of the shell is
// open. A plain TS store with subscribe / getSnapshot like engine/store.ts; components read slices
// with `usePlan(selector)` so a slider step re-renders only what shows its value or the route, and
// the map layer subscribes directly (no React in between).
//
// Routing: every change schedules one pass per animation frame; each line on the map has its own
// latest-wins lane (`route`, `ghost`, `compare`), and a request whose input did not change is not
// sent again. So a slider drag sends the main route only; the base profile's ghost stays.
import { createContext, useContext, useSyncExternalStore } from "react";
import { isSuperseded, type Superseded } from "@/engine/client";
import type {
  Catalogue,
  CompareRequest,
  EdgeExplanation,
  ExplainEdgeRequest,
  LimitId,
  LimitValue,
  PrefId,
  Preset,
  Profile,
  RouteComparison,
  RouteDiff,
  RouteError,
  RouteRequest,
  RouteResult,
} from "@/engine/generated/types";
import type { EdgeCostsParams, EdgeCostsResult, RouteOutcome } from "@/engine/protocol";
import type { EngineStore } from "@/engine/store";
import {
  baseMinFactor,
  type Change,
  changeSentence,
  changes,
  insertIndex,
  type Limits,
  type LineBy,
  limitInMessage,
  limitRows,
  moveItem,
  normaliseLimits,
  ownPreset,
  type PlanPreset,
  parsePlan,
  parsePresets,
  planProfile,
  prefRows,
  presetName,
  probeOrder,
  type SavedPlan,
  sameCost,
  snapMinFactor,
  snapWeight,
  type Waypoint,
  type Weights,
  waypointId,
} from "./model";

/** What the store needs of the engine (an adapter over `EngineStore`; a fake in tests). */
export interface PlannerEngine {
  presets(): Promise<Preset[]>;
  catalogue(): Promise<Catalogue>;
  route(request: RouteRequest, lane: string): Promise<RouteOutcome | Superseded>;
  diff(a: number[], b: number[], lane: string): Promise<RouteDiff | Superseded>;
  /** the cost debug view (docs/planner.md, "Cost") */
  edgeCosts(params: EdgeCostsParams, lane: string): Promise<EdgeCostsResult | Superseded>;
  explainEdge(request: ExplainEdgeRequest, lane: string): Promise<EdgeExplanation | Superseded>;
  compare(request: CompareRequest, lane: string): Promise<RouteComparison | Superseded>;
  cancel(lane: string): void;
}

export function engineAdapter(engine: EngineStore): PlannerEngine {
  return {
    presets: () => engine.call("presets"),
    catalogue: () => engine.call("catalogue"),
    route: (request, lane) => engine.routeLatest(request, lane),
    diff: (a, b, lane) => engine.client.latest(lane, "diff", { a, b }),
    edgeCosts: (params, lane) => engine.client.latest(lane, "edgeCosts", params),
    explainEdge: (request, lane) => engine.client.latest(lane, "explainEdge", request),
    compare: (request, lane) => engine.client.latest(lane, "compare", request),
    cancel: (lane) => engine.client.cancel(lane),
  };
}

/** One line on the map: the last answer of its lane. */
export type Line = { result: RouteResult | null; error: RouteError | null; ms: number | null };
const NO_LINE: Line = { result: null, error: null, ms: null };

export type SheetId = "route" | "profile" | "layers" | null;

/** After a route failed: the limit that blocks it (`null`: no single one) and the route without it. */
export type Blame = { limit: LimitId | null; result: RouteResult | null; searching: boolean };

/**
 * "Why not through here?": the plan's route against one forced through `at` (a via inserted where it
 * detours least), under the same profile, stretch by stretch. The plan itself is untouched until
 * "use this route".
 */
export type WhyNotState = {
  at: { lon: number; lat: number };
  /** the route through `at` */
  line: Line;
  comparison: RouteComparison | null;
};

export type PlanState = {
  catalogue: Catalogue | null;
  presets: PlanPreset[];
  waypoints: Waypoint[];
  baseId: string;
  weights: Weights;
  limits: Limits;
  /** the detours slider (`bounds.min_factor`) when moved away from the base's; `null`: the base's */
  detours: number | null;
  compareId: string | null;
  // derived from the above (kept in the snapshot so selectors stay cheap and stable)
  base: PlanPreset | undefined;
  baseWeights: Weights;
  baseLimits: Limits;
  /** the `min_factor` in force and the base's */
  minFactor: number;
  baseMinFactor: number;
  changes: Change[];
  sentence: string;
  prefIds: PrefId[];
  limitIds: LimitId[];
  /** the changes route differently from the base */
  changed: boolean;
  // the routes
  engineReady: boolean;
  main: Line;
  ghost: Line;
  compare: Line;
  /** stretches of the main route that differ from the ghost: metres along the main route */
  moved: { startM: number; lengthM: number }[] | null;
  compareDiff: RouteDiff | null;
  blame: Blame | null;
  whyNot: WhyNotState | null;
  /** the main route has been on its way for a while (a subtle "Routing…") */
  routing: boolean;
  // the shell
  sheet: SheetId;
  chip: string | null;
  picker: boolean;
  lineBy: LineBy;
  inspect: boolean;
  /** the route lines are hidden so the map under them reads (the shell's toggle, `H`; not saved) */
  routeHidden: boolean;
  /** a row that was just added (flashes, opens as a chip) */
  fresh: string | null;
  /** metres along the main route under the timeline's cursor */
  cursorM: number | null;
  /** bumped when the map should fit the route (a restored plan, a comparison) */
  fitSeq: number;
};

const PLAN_KEY = "kompass.plan.v1";
const PRESETS_KEY = "kompass.presets.v1";
export const DEFAULT_BASE = "gravel_explorer";
const OPTIONS = { snap_radius_m: 250, geometry: true, avoid_reuse: true };
/** how long the main route may take before the shell says "Routing…" */
const BUSY_AFTER_MS = 250;

type Schedule = (run: () => void) => void;
const frame: Schedule =
  typeof requestAnimationFrame === "function"
    ? (run) => requestAnimationFrame(run)
    : (run) => setTimeout(run, 0);

export type StoreOptions = {
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  bounds?: readonly [number, number, number, number];
  schedule?: Schedule;
  now?: () => number;
};

export class PlannerStore {
  readonly #engine: PlannerEngine;
  readonly #storage: Pick<Storage, "getItem" | "setItem"> | null;
  readonly #schedule: Schedule;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();
  #state: PlanState;
  #pending = false;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #busyTimer: ReturnType<typeof setTimeout> | null = null;
  /** the input each lane last sent (a request is not repeated) */
  readonly #sent = new Map<string, string>();
  #restored: SavedPlan | null;
  /** a lane of "why not" whose answer is on its way: comparing now would pair stale routes */
  #mainPending = false;
  #throughPending = false;

  constructor(engine: PlannerEngine, options: StoreOptions = {}) {
    this.#engine = engine;
    this.#storage = options.storage === undefined ? safeStorage() : options.storage;
    this.#schedule = options.schedule ?? frame;
    this.#now = options.now ?? (() => performance.now());
    this.#restored = parsePlan(this.#read(PLAN_KEY), options.bounds);
    const own = parsePresets(this.#read(PRESETS_KEY));
    const r = this.#restored;
    this.#state = derive({
      catalogue: null,
      presets: own,
      waypoints: r?.waypoints ?? [],
      baseId: r?.baseId ?? DEFAULT_BASE,
      weights: r?.weights ?? {},
      limits: r?.limits ?? {},
      detours: r?.detours ?? null,
      compareId: r?.compareId ?? null,
      engineReady: false,
      main: NO_LINE,
      ghost: NO_LINE,
      compare: NO_LINE,
      moved: null,
      compareDiff: null,
      blame: null,
      whyNot: null,
      routing: false,
      sheet: null,
      chip: null,
      picker: false,
      lineBy: r?.lineBy ?? "plain",
      inspect: false,
      routeHidden: false,
      fresh: null,
      cursorM: null,
      fitSeq: 0,
    } as PlanState);
  }

  // ---------------------------------------------------------------- store plumbing

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): PlanState => this.#state;

  #set(patch: Partial<PlanState>, opts: { route?: boolean; save?: boolean } = {}) {
    const next = { ...this.#state, ...patch };
    const plan =
      "weights" in patch ||
      "limits" in patch ||
      "detours" in patch ||
      "baseId" in patch ||
      "presets" in patch ||
      "catalogue" in patch;
    this.#state = plan ? derive(next) : next;
    for (const listener of [...this.#listeners]) listener();
    if (opts.route) this.#reroute();
    if (opts.save) this.#save();
  }

  #read(key: string): string | null {
    try {
      return this.#storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  #write(key: string, value: string) {
    try {
      this.#storage?.setItem(key, value);
    } catch {
      // private mode or a full quota: the plan lives for this session only
    }
  }

  #save() {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.flush(), 250);
  }

  /** Writes the plan now (also on page hide). */
  flush() {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    const s = this.#state;
    const plan: SavedPlan = {
      v: 1,
      waypoints: s.waypoints,
      baseId: s.baseId,
      weights: s.weights,
      limits: s.limits,
      ...(s.detours !== null ? { detours: s.detours } : {}),
      compareId: s.compareId,
      lineBy: s.lineBy,
    };
    this.#write(PLAN_KEY, JSON.stringify(plan));
  }

  #saveOwn() {
    const own = this.#state.presets.filter((p) => p.own).map(({ own: _, ...p }) => p);
    this.#write(PRESETS_KEY, JSON.stringify(own));
  }

  // ---------------------------------------------------------------- start

  /** Fetches the presets and the catalogue (they do not need the region graph). */
  async init() {
    const [shipped, catalogue] = await Promise.all([this.#engine.presets(), this.#engine.catalogue()]);
    const own = this.#state.presets.filter((p) => p.own);
    const presets = [...shipped, ...own];
    const restored = this.#restored;
    const patch: Partial<PlanState> = { presets, catalogue };
    if (!presets.some((p) => p.id === this.#state.baseId)) {
      // the saved base is gone (deleted preset): start from the default
      const base = presets.find((p) => p.id === DEFAULT_BASE) ?? presets[0];
      patch.baseId = base?.id ?? DEFAULT_BASE;
      patch.weights = { ...(base?.profile.weights ?? {}) };
      patch.limits = normaliseLimits(base?.profile.limits ?? {}, catalogue);
      patch.detours = null;
    } else if (!restored) {
      const base = presets.find((p) => p.id === this.#state.baseId);
      patch.weights = { ...(base?.profile.weights ?? {}) };
      patch.limits = normaliseLimits(base?.profile.limits ?? {}, catalogue);
    }
    if (this.#state.compareId && !presets.some((p) => p.id === this.#state.compareId)) patch.compareId = null;
    if (restored && restored.waypoints.length >= 2) patch.fitSeq = this.#state.fitSeq + 1;
    this.#set(patch, { route: true });
  }

  /** The region graph is loaded (or gone): route, and refresh the catalogue's coverage. */
  setEngineReady(ready: boolean) {
    if (ready === this.#state.engineReady) return;
    this.#set({ engineReady: ready }, { route: true });
    if (ready) void this.#engine.catalogue().then((catalogue) => this.#set({ catalogue }));
  }

  /** Something the engine routes on changed (the personal layer of ridden ways): route everything again. */
  refresh() {
    this.#sent.clear();
    this.#reroute();
  }

  // ---------------------------------------------------------------- waypoints

  addWaypointAt(lon: number, lat: number, place?: string) {
    const ws = this.#state.waypoints;
    const at = insertIndex(ws, { lon, lat });
    const w: Waypoint = { id: waypointId(), lon, lat, ...(place ? { place } : {}) };
    this.#set({ waypoints: [...ws.slice(0, at), w, ...ws.slice(at)] }, { route: true, save: true });
  }

  moveWaypoint(id: string, lon: number, lat: number, place?: string | null) {
    const waypoints = this.#state.waypoints.map((w) => {
      if (w.id !== id) return w;
      const { place: old, ...rest } = w;
      const next: Waypoint = { ...rest, lon, lat };
      const p = place === undefined ? old : place;
      return p ? { ...next, place: p } : next;
    });
    this.#set({ waypoints }, { route: true, save: true });
  }

  removeWaypoint(id: string) {
    this.#set({ waypoints: this.#state.waypoints.filter((w) => w.id !== id) }, { route: true, save: true });
  }

  reorderWaypoint(from: number, to: number) {
    this.#set({ waypoints: moveItem(this.#state.waypoints, from, to) }, { route: true, save: true });
  }

  reverse() {
    this.#set({ waypoints: [...this.#state.waypoints].reverse() }, { route: true, save: true });
  }

  clearWaypoints() {
    this.#set({ waypoints: [], cursorM: null }, { route: true, save: true });
  }

  // ---------------------------------------------------------------- profile

  setBase(id: string) {
    const base = this.#state.presets.find((p) => p.id === id);
    if (!base) return;
    this.#set(
      {
        baseId: id,
        weights: { ...base.profile.weights },
        limits: normaliseLimits(base.profile.limits, this.#state.catalogue),
        detours: null,
        compareId: this.#state.compareId === id ? null : this.#state.compareId,
        chip: null,
      },
      { route: true, save: true },
    );
  }

  setWeight(id: PrefId, value: number) {
    const v = snapWeight(value);
    if (this.#state.weights[id] === v) return;
    this.#set({ weights: { ...this.#state.weights, [id]: v } }, { route: true, save: true });
  }

  /** The detours slider: `bounds.min_factor`, 1.0 (direct) … 0.3 (go far for good ways). */
  setDetours(value: number) {
    const s = this.#state;
    const v = snapMinFactor(value);
    const next = Math.abs(v - s.baseMinFactor) < 1e-6 ? null : v;
    if (next === s.detours) return;
    this.#set({ detours: next }, { route: true, save: true });
  }

  resetDetours() {
    if (this.#state.detours === null) return;
    this.#set({ detours: null }, { route: true, save: true });
  }

  addPref(id: PrefId) {
    const def = this.#state.catalogue?.preferences.find((p) => p.id === id);
    if (id in this.#state.weights) return;
    this.#set(
      { weights: { ...this.#state.weights, [id]: snapWeight(def?.default ?? 0) }, fresh: id, picker: false },
      { route: true, save: true },
    );
  }

  removePref(id: PrefId) {
    if (this.#state.catalogue?.core.includes(id)) return;
    const { [id]: _, ...rest } = this.#state.weights;
    this.#set(
      { weights: rest, chip: this.#state.chip === id ? null : this.#state.chip },
      { route: true, save: true },
    );
  }

  /** The change dot: back to the base's value (a row the base lacks goes away). */
  resetPref(id: PrefId) {
    const b = this.#state.baseWeights[id];
    if (b === undefined && !this.#state.catalogue?.core.includes(id)) return this.removePref(id);
    const weights = { ...this.#state.weights };
    if (b === undefined) delete weights[id];
    else weights[id] = b;
    this.#set({ weights }, { route: true, save: true });
  }

  /** `null` switches a limit off (kept as `false` while the base has it, so the change stays listed). */
  setLimit(id: LimitId, value: LimitValue | null) {
    const limits = { ...this.#state.limits };
    if (value === null || value === false) {
      if (id in this.#state.baseLimits) limits[id] = false;
      else delete limits[id];
    } else limits[id] = value;
    this.#set({ limits }, { route: true, save: true });
  }

  addLimit(id: LimitId) {
    const def = this.#state.catalogue?.limits.find((l) => l.id === id);
    this.#set(
      {
        limits: { ...this.#state.limits, [id]: def?.number ? def.number.default : true },
        fresh: id,
        picker: false,
      },
      { route: true, save: true },
    );
  }

  resetLimit(id: LimitId) {
    const b = this.#state.baseLimits[id];
    const limits = { ...this.#state.limits };
    if (b === undefined) delete limits[id];
    else limits[id] = b;
    this.#set({ limits }, { route: true, save: true });
  }

  reset() {
    this.setBase(this.#state.baseId);
  }

  savePreset(name: string) {
    const s = this.#state;
    const preset = ownPreset(
      name.trim() || `${presetName(s.base)} +`,
      s.base,
      s.weights,
      s.limits,
      undefined,
      planProfile(s.base, s.weights, s.limits, s.minFactor).bounds,
    );
    this.#set({ presets: [...s.presets, preset], baseId: preset.id }, { save: true });
    this.#saveOwn();
  }

  renamePreset(id: string, name: string) {
    const presets = this.#state.presets.map((p) =>
      p.id === id && p.own ? { ...p, profile: { ...p.profile, name: name.trim() || presetName(p) } } : p,
    );
    this.#set({ presets });
    this.#saveOwn();
  }

  /** Deletes an own preset; a plan based on it keeps its values on the default base. */
  deletePreset(id: string) {
    const s = this.#state;
    const presets = s.presets.filter((p) => !(p.id === id && p.own));
    const patch: Partial<PlanState> = { presets, compareId: s.compareId === id ? null : s.compareId };
    if (s.baseId === id)
      patch.baseId = presets.some((p) => p.id === DEFAULT_BASE)
        ? DEFAULT_BASE
        : (presets[0]?.id ?? DEFAULT_BASE);
    this.#set(patch, { route: true, save: true });
    this.#saveOwn();
  }

  // ---------------------------------------------------------------- compare

  setCompare(id: string | null) {
    this.#set(
      { compareId: id, compareDiff: null, fitSeq: this.#state.fitSeq + (id ? 1 : 0) },
      { route: true, save: true },
    );
  }

  /** "Ride it this way": the compared preset becomes the base. */
  rideCompare() {
    const id = this.#state.compareId;
    if (!id) return;
    this.#set({ compareId: null }, {});
    this.setBase(id);
  }

  /** "Lift …": switch the blocking limit off. */
  liftLimit(id: LimitId) {
    this.setLimit(id, null);
  }

  // ---------------------------------------------------------------- the cost debug view

  /** The profile the plan routes with (the cost layer and the tap panel use the same). */
  profile(): Profile {
    const s = this.#state;
    return planProfile(s.base, s.weights, s.limits);
  }

  /** One edge's cost, explained under the plan's profile (latest wins). */
  explainEdge(edge: number): Promise<EdgeExplanation | Superseded> {
    return this.#engine.explainEdge({ profile: this.profile(), edge }, "explain");
  }

  /** The visible edges' factors for the cost layer (latest wins, its own lane). */
  edgeCosts(params: Omit<EdgeCostsParams, "profile"> & { profile?: Profile }) {
    return this.#engine.edgeCosts({ profile: this.profile(), ...params }, "cost");
  }

  /** "Why not through here?": route through the point as well, and compare. */
  startWhyNot(lon: number, lat: number) {
    if (this.#state.waypoints.length < 2) return;
    this.#sent.delete("whynot");
    this.#set(
      { whyNot: { at: { lon, lat }, line: NO_LINE, comparison: null }, chip: null, sheet: null },
      { route: true },
    );
  }

  /** Leaves the comparison: the plan as it was. */
  endWhyNot() {
    if (!this.#state.whyNot) return;
    for (const lane of ["whynot", "whynot-compare"]) {
      this.#engine.cancel(lane);
      this.#sent.delete(lane);
    }
    this.#set({ whyNot: null });
  }

  /** "Use this route": the point becomes a stop of the plan. */
  acceptWhyNot() {
    const w = this.#state.whyNot;
    if (!w) return;
    this.endWhyNot();
    this.addWaypointAt(w.at.lon, w.at.lat);
  }

  /** Flashes a preference's row (the profile card scrolls to it). */
  flash(id: PrefId) {
    this.#set({ fresh: id });
  }

  // ---------------------------------------------------------------- the shell

  open(sheet: SheetId) {
    this.#set({ sheet, chip: null, picker: false });
  }
  setChip(chip: string | null) {
    this.#set({ chip });
  }
  setPicker(picker: boolean) {
    this.#set({ picker });
  }
  setLineBy(lineBy: LineBy) {
    this.#set({ lineBy }, { save: true });
  }
  setInspect(inspect: boolean) {
    this.#set({ inspect });
  }
  setRouteHidden(routeHidden: boolean) {
    if (routeHidden !== this.#state.routeHidden) this.#set({ routeHidden });
  }
  setCursor(cursorM: number | null) {
    if (cursorM !== this.#state.cursorM) this.#set({ cursorM });
  }
  /** The flash of a just-added row is over. */
  settle() {
    if (this.#state.fresh) this.#set({ fresh: null });
  }

  // ---------------------------------------------------------------- routing

  #reroute() {
    if (this.#pending) return;
    this.#pending = true;
    this.#schedule(() => {
      this.#pending = false;
      this.#route();
    });
  }

  #request(profile: Profile): RouteRequest {
    return {
      waypoints: this.#state.waypoints.map((w) => ({ lon: w.lon, lat: w.lat })),
      profile,
      options: OPTIONS,
    };
  }

  /** Sends a lane's request unless the same input is already on its way or answered. */
  #send(lane: string, request: RouteRequest | null, onDone: (line: Line, key: string) => void) {
    if (!request) {
      if (this.#sent.has(lane)) {
        this.#sent.delete(lane);
        this.#engine.cancel(lane);
        onDone(NO_LINE, "");
      }
      return;
    }
    const key = JSON.stringify([
      request.waypoints,
      request.profile.weights,
      request.profile.limits,
      request.profile.bounds,
    ]);
    if (this.#sent.get(lane) === key) return;
    this.#sent.set(lane, key);
    const started = this.#now();
    void this.#engine.route(request, lane).then(
      (outcome) => {
        if (isSuperseded(outcome)) return;
        const ms = this.#now() - started;
        onDone(
          outcome.ok
            ? { result: outcome.result, error: null, ms }
            : { result: null, error: outcome.error, ms },
          key,
        );
      },
      (error: unknown) => {
        this.#sent.delete(lane);
        onDone(
          {
            result: null,
            error: {
              code: "invalid_request",
              message: error instanceof Error ? error.message : String(error),
            },
            ms: null,
          },
          key,
        );
      },
    );
  }

  #route() {
    const s = this.#state;
    const can = s.engineReady && s.waypoints.length >= 2 && !!s.base;
    if (!can) {
      for (const lane of ["route", "ghost", "compare", "probe", "whynot", "whynot-compare"]) {
        this.#engine.cancel(lane);
        this.#sent.delete(lane);
      }
      this.#busy(false);
      if (s.main !== NO_LINE || s.ghost !== NO_LINE || s.compare !== NO_LINE || s.blame || s.whyNot)
        this.#set({
          main: NO_LINE,
          ghost: NO_LINE,
          compare: NO_LINE,
          moved: null,
          blame: null,
          compareDiff: null,
          whyNot: s.waypoints.length >= 2 ? s.whyNot : null,
        });
      return;
    }
    const profile = planProfile(s.base, s.weights, s.limits, s.minFactor);
    const before = this.#sent.get("route");
    if (s.whyNot) this.#mainPending = true;
    this.#send("route", this.#request(profile), (main, key) => {
      if (key !== this.#sent.get("route") && this.#sent.get("route") !== undefined) {
        // an older answer while a newer request runs: show it (the drag stays live), no follow-ups
        this.#set({ main });
        return;
      }
      this.#busy(false);
      this.#mainPending = false;
      this.#set({ main, blame: main.error ? { limit: null, result: null, searching: true } : null });
      if (main.error) void this.#probe(key);
      this.#diffMoved();
      this.#diffCompare();
      this.#compareWhyNot();
    });
    if (this.#sent.get("route") !== before) this.#busy(true);
    else this.#mainPending = false;
    // the base profile's route, while the changes route differently (not while comparing: one other line at a time)
    const base = s.base;
    const ghost =
      s.changed && !s.compareId && base
        ? this.#request(planProfile(base, s.baseWeights, s.baseLimits, s.baseMinFactor))
        : null;
    this.#send("ghost", ghost, (line) => {
      this.#set({ ghost: line });
      this.#diffMoved();
    });
    const other = s.presets.find((p) => p.id === s.compareId);
    const compare = other
      ? this.#request(
          planProfile(other, other.profile.weights, normaliseLimits(other.profile.limits, s.catalogue)),
        )
      : null;
    this.#send("compare", compare, (line) => {
      this.#set({ compare: line });
      this.#diffCompare();
    });
    if (!ghost && s.moved) this.#set({ moved: null });
    // "why not through here?": the same profile, the via inserted where it detours least
    const at = s.whyNot?.at;
    const through = at ? this.#request(profile) : null;
    if (through && at) {
      const i = insertIndex(s.waypoints, at);
      through.waypoints.splice(i, 0, { lon: at.lon, lat: at.lat });
    }
    const sentThrough = this.#sent.get("whynot");
    this.#send("whynot", through, (line) => {
      this.#throughPending = false;
      const w = this.#state.whyNot;
      if (!w) return;
      this.#set({ whyNot: { ...w, line, comparison: null } });
      this.#compareWhyNot();
    });
    if (through && this.#sent.get("whynot") !== sentThrough) this.#throughPending = true;
  }

  /** Both routes of "why not through here?" are in: cost them stretch by stretch. */
  #compareWhyNot() {
    const { main, whyNot } = this.#state;
    const a = main.result;
    const b = whyNot?.line.result;
    if (!a || !b || !whyNot || this.#mainPending || this.#throughPending) return;
    const at = whyNot.at;
    void this.#engine.compare({ profile: this.profile(), a: a.arcs, b: b.arcs }, "whynot-compare").then(
      (comparison) => {
        const w = this.#state.whyNot;
        if (isSuperseded(comparison) || !w || w.at !== at || w.line.result !== b) return;
        if (this.#state.main.result !== a) return;
        this.#set({ whyNot: { ...w, comparison } });
      },
      () => undefined,
    );
  }

  #busy(on: boolean) {
    if (this.#busyTimer) clearTimeout(this.#busyTimer);
    this.#busyTimer = null;
    if (on) this.#busyTimer = setTimeout(() => this.#set({ routing: true }), BUSY_AFTER_MS);
    else if (this.#state.routing) this.#set({ routing: false });
  }

  /** The stretches where the plan's route leaves the base profile's. */
  #diffMoved() {
    const { main, ghost } = this.#state;
    if (!main.result || !ghost.result) {
      if (this.#state.moved) this.#set({ moved: null });
      return;
    }
    const a = main.result;
    const b = ghost.result;
    if (a.arcs.length === b.arcs.length && a.arcs.every((x, i) => x === b.arcs[i])) {
      this.#set({ moved: [] });
      return;
    }
    void this.#engine.diff(a.arcs, b.arcs, "diff").then(
      (d) => {
        if (isSuperseded(d) || this.#state.main.result !== a) return;
        const moved = d.stretches
          .filter((x) => x.a.length_m > 0 || x.b.length_m > 0)
          .map((x) => ({ startM: x.a.start_m, lengthM: Math.max(x.a.length_m, 1) }));
        this.#set({ moved });
      },
      () => undefined,
    );
  }

  #diffCompare() {
    const { main, compare } = this.#state;
    if (!main.result || !compare.result) return;
    const a = main.result;
    const b = compare.result;
    void this.#engine.diff(a.arcs, b.arcs, "diff-compare").then(
      (d) => {
        if (isSuperseded(d) || this.#state.main.result !== a || this.#state.compare.result !== b) return;
        this.#set({ compareDiff: d });
      },
      () => undefined,
    );
  }

  /** A route that cannot be made: find the limit that blocks it by lifting one at a time. */
  async #probe(key: string) {
    const s = this.#state;
    const error = s.main.error;
    if (!error || (error.code !== "no_route" && error.code !== "excluded")) {
      this.#set({ blame: { limit: null, result: null, searching: false } });
      return;
    }
    const named = limitInMessage(error.message, s.catalogue);
    const order = probeOrder(s.baseLimits, s.limits);
    const tries: Limits[] = [...new Set([...(named ? [named] : []), ...order])].map((id) => ({
      ...s.limits,
      [id]: false,
    }));
    if (order.length > 1) tries.push({});
    const ids = [...new Set([...(named ? [named] : []), ...order])];
    for (let i = 0; i < tries.length; i++) {
      if (this.#sent.get("route") !== key) return;
      const limits = tries[i] as Limits;
      const outcome = await this.#engine.route(
        this.#request(planProfile(s.base, s.weights, limits, s.minFactor)),
        "probe",
      );
      if (this.#sent.get("route") !== key) return;
      if (!isSuperseded(outcome) && outcome.ok) {
        this.#set({ blame: { limit: ids[i] ?? null, result: outcome.result, searching: false } });
        return;
      }
    }
    this.#set({ blame: { limit: null, result: null, searching: false } });
  }
}

/** The derived parts of the snapshot. */
function derive(s: PlanState): PlanState {
  const base = s.presets.find((p) => p.id === s.baseId);
  const baseWeights = base?.profile.weights ?? {};
  const baseLimits = normaliseLimits(base?.profile.limits ?? {}, s.catalogue);
  const baseMin = baseMinFactor(base);
  const minFactor = s.detours ?? baseMin;
  const list = changes({ weights: baseWeights, limits: baseLimits }, s.weights, s.limits, s.catalogue, {
    base: baseMin,
    plan: minFactor,
  });
  return {
    ...s,
    base,
    baseWeights,
    baseLimits,
    minFactor,
    baseMinFactor: baseMin,
    changes: list,
    sentence: changeSentence(presetName(base), list),
    prefIds: prefRows(s.weights, s.catalogue?.core ?? []),
    limitIds: limitRows(baseLimits, s.limits),
    changed: !sameCost(
      { weights: baseWeights, limits: baseLimits, minFactor: baseMin },
      { weights: s.weights, limits: s.limits, minFactor },
    ),
  };
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- React

export const PlannerContext = createContext<PlannerStore | null>(null);

export function usePlanner(): PlannerStore {
  const store = useContext(PlannerContext);
  if (!store) throw new Error("usePlanner outside the planner");
  return store;
}

/** A slice of the plan; re-renders only when the slice changes (`Object.is`). */
export function usePlan<T>(select: (s: PlanState) => T): T {
  const store = usePlanner();
  return useSyncExternalStore(store.subscribe, () => select(store.getSnapshot()));
}
