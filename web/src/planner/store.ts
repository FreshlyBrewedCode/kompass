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
  BoardRow,
  Catalogue,
  CompareRequest,
  EdgeExplanation,
  EdgeRun,
  ExplainEdgeRequest,
  Hills,
  LimitId,
  LimitValue,
  OverrideKind,
  PrefId,
  Preset,
  Profile,
  RouteComparison,
  RouteDiff,
  RouteError,
  RouteRequest,
  RouteResult,
  Tier,
} from "@/engine/generated/types";
import type { EdgeCostsParams, EdgeCostsResult, RouteOutcome } from "@/engine/protocol";
import type { EngineStore } from "@/engine/store";
import {
  baseMinFactor,
  type Change,
  changeSentence,
  changes,
  dropFormerCoreZeros,
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
import {
  makeOverride,
  overridesWire,
  overrideText,
  type PlanOverride,
  parseOverrides,
  type SavedOverrides,
  withOverride,
} from "./overrides";
import {
  boardOf,
  cleanHills,
  setHandle as curveWithHandle,
  fromSliders,
  isStructured,
  moveRow,
  parseStructured,
  partsOf,
  replaced,
  type SavedStructured,
  type StructuredParts,
  sameParts,
  snapSpread,
  structuredChanges,
  structuredProfile,
  twinId,
} from "./structured/model";

/** Which controls edit the profile (#66): today's sliders, or the structured prototype behind a switch. */
export type Controls = "sliders" | "structured";
/** The plan of the mode not on screen: kept so the rider can flip back and forth and compare. */
type ModePlan = {
  baseId: string;
  weights: Weights;
  limits: Limits;
  detours: number | null;
  parts: StructuredParts | null;
  edited: boolean;
};

/** What the store needs of the engine (an adapter over `EngineStore`; a fake in tests). */
export interface PlannerEngine {
  presets(): Promise<Preset[]>;
  /** the structured twins of the shipped presets (#66) */
  structuredPresets(): Promise<Preset[]>;
  /** a slider profile in the structured form (#66) */
  toStructured(profile: Profile): Promise<Profile>;
  catalogue(): Promise<Catalogue>;
  route(request: RouteRequest, lane: string): Promise<RouteOutcome | Superseded>;
  diff(a: number[], b: number[], lane: string): Promise<RouteDiff | Superseded>;
  /** the cost debug view (docs/planner.md, "Cost") */
  edgeCosts(params: EdgeCostsParams, lane: string): Promise<EdgeCostsResult | Superseded>;
  explainEdge(request: ExplainEdgeRequest, lane: string): Promise<EdgeExplanation | Superseded>;
  compare(request: CompareRequest, lane: string): Promise<RouteComparison | Superseded>;
  /** "this segment": the edge's run between junctions (docs/planner.md, "This plan's exceptions") */
  edgeRun(edge: number, lane: string): Promise<EdgeRun | Superseded>;
  cancel(lane: string): void;
}

export function engineAdapter(engine: EngineStore): PlannerEngine {
  return {
    presets: () => engine.call("presets"),
    structuredPresets: () => engine.call("structuredPresets"),
    toStructured: (profile) => engine.call("toStructured", profile),
    catalogue: () => engine.call("catalogue"),
    route: (request, lane) => engine.routeLatest(request, lane),
    diff: (a, b, lane) => engine.client.latest(lane, "diff", { a, b }),
    edgeCosts: (params, lane) => engine.client.latest(lane, "edgeCosts", params),
    explainEdge: (request, lane) => engine.client.latest(lane, "explainEdge", request),
    compare: (request, lane) => engine.client.latest(lane, "compare", request),
    edgeRun: (edge, lane) => engine.client.latest(lane, "edgeRun", { edge }),
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
  /** this plan's exceptions: stretches it avoids, prefers or allows (docs/planner.md) */
  overrides: PlanOverride[];
  /** exceptions of a saved plan dropped on load: they were made on another build of the region */
  overridesDropped: number;
  /** the last change to the exceptions, to undo it (`seq` tells changes apart) */
  overrideUndo: { text: string; before: PlanOverride[]; seq: number } | null;
  /** the inspected way's run of edges between junctions: what an exception would apply to */
  run: { edge: number; result: EdgeRun } | null;
  /** which controls edit the profile (an app setting, saved on the device; #66) */
  controls: Controls;
  /** switching to the structured controls: the engine converts the slider profile */
  converting: boolean;
  /** structured controls: the boards, the curve, the spread (`null` with the sliders) */
  structured: StructuredParts | null;
  /** the structured profile was edited since it was converted (it no longer follows the sliders) */
  structuredEdited: boolean;
  // derived from the above (kept in the snapshot so selectors stay cheap and stable)
  base: PlanPreset | undefined;
  baseWeights: Weights;
  baseLimits: Limits;
  /** structured controls: the base preset's boards, curve and spread */
  baseParts: StructuredParts | null;
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
/** the structured controls switch (#66): "structured" or absent */
export const CONTROLS_KEY = "kompass.controls.v1";
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
  /** the region build's id: exceptions (edge ids) are saved with it and dropped on another one */
  build?: string;
  /** the controls asked for in the URL (`?controls=structured`): saved like the switch */
  controls?: Controls;
  schedule?: Schedule;
  now?: () => number;
};

export class PlannerStore {
  readonly #engine: PlannerEngine;
  readonly #storage: Pick<Storage, "getItem" | "setItem"> | null;
  readonly #schedule: Schedule;
  readonly #now: () => number;
  readonly #build: string | undefined;
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
  /** every preset: the shipped ones, their structured twins and the own (of both kinds) */
  #all: { shipped: PlanPreset[]; twins: PlanPreset[]; own: PlanPreset[] } = {
    shipped: [],
    twins: [],
    own: [],
  };
  /** the plan of the other controls (the sliders' while structured is on, and the other way round) */
  #other: ModePlan | null = null;
  /** the controls asked for (storage or URL); applied by `init` */
  #wantControls: Controls;
  /** bumped per switch: an older conversion answering late is dropped */
  #switchSeq = 0;

  constructor(engine: PlannerEngine, options: StoreOptions = {}) {
    this.#engine = engine;
    this.#storage = options.storage === undefined ? safeStorage() : options.storage;
    this.#schedule = options.schedule ?? frame;
    this.#now = options.now ?? (() => performance.now());
    this.#build = options.build;
    this.#restored = parsePlan(this.#read(PLAN_KEY), options.bounds);
    const own = parsePresets(this.#read(PRESETS_KEY));
    this.#all.own = own;
    const r = this.#restored;
    const saved = parseOverrides(r?.overrides, this.#build);
    const st = parseStructured(r?.structured);
    if (st) this.#other = modePlanOf(st);
    this.#wantControls =
      options.controls ?? (this.#read(CONTROLS_KEY) === "structured" ? "structured" : "sliders");
    if (options.controls) this.#saveControls(options.controls);
    this.#state = derive({
      catalogue: null,
      presets: own.filter((p) => !isStructured(p.profile)),
      waypoints: r?.waypoints ?? [],
      baseId: r?.baseId ?? DEFAULT_BASE,
      weights: r?.weights ?? {},
      limits: r?.limits ?? {},
      detours: r?.detours ?? null,
      compareId: r?.compareId ?? null,
      overrides: saved.kept,
      overridesDropped: saved.dropped,
      overrideUndo: null,
      run: null,
      controls: "sliders",
      converting: false,
      structured: null,
      structuredEdited: false,
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

  #set(patch: Partial<PlanState>, opts: { route?: boolean; save?: boolean; converted?: boolean } = {}) {
    const next = { ...this.#state, ...patch };
    const edit = "weights" in patch || "limits" in patch || "baseId" in patch || "structured" in patch;
    if (next.controls === "structured" && edit && !opts.converted && !("controls" in patch))
      next.structuredEdited = true;
    const plan =
      edit || "detours" in patch || "presets" in patch || "controls" in patch || "catalogue" in patch;
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
    // the sliders' plan stays where it always was; the structured one beside it
    const here = this.#modePlan();
    const sliders = s.controls === "sliders" ? here : this.#other;
    const structured = s.controls === "structured" ? here : this.#other;
    const st: SavedStructured | null =
      structured?.parts && structured !== sliders
        ? {
            baseId: structured.baseId,
            weights: structured.weights,
            limits: structured.limits,
            boards: structured.parts.boards,
            hills: structured.parts.hills,
            spread: structured.parts.spread,
            edited: structured.edited,
          }
        : null;
    const compareId =
      s.controls === "structured" && s.compareId ? s.compareId.replace(/_structured$/, "") : s.compareId;
    const plan: SavedPlan = {
      v: 1,
      waypoints: s.waypoints,
      baseId: sliders?.baseId ?? s.baseId,
      weights: sliders?.weights ?? s.weights,
      limits: sliders?.limits ?? s.limits,
      ...((sliders?.detours ?? null) !== null ? { detours: sliders?.detours as number } : {}),
      compareId,
      lineBy: s.lineBy,
      ...(s.overrides.length > 0 && this.#build !== undefined
        ? { overrides: { build: this.#build, list: s.overrides } satisfies SavedOverrides }
        : {}),
      ...(st ? { structured: st } : {}),
    };
    this.#write(PLAN_KEY, JSON.stringify(plan));
  }

  #saveOwn() {
    const own = this.#all.own.map(({ own: _, ...p }) => p);
    this.#write(PRESETS_KEY, JSON.stringify(own));
  }

  #saveControls(controls: Controls) {
    if (controls === "structured") this.#write(CONTROLS_KEY, "structured");
    else
      try {
        this.#storage?.setItem(CONTROLS_KEY, "sliders");
      } catch {
        // storage blocked: the switch holds for this session
      }
  }

  /** The presets the picker offers under these controls: the shipped (or their twins) and the own of that kind. */
  #presetsFor(controls: Controls): PlanPreset[] {
    const structured = controls === "structured";
    return [
      ...(structured ? this.#all.twins : this.#all.shipped),
      ...this.#all.own.filter((p) => isStructured(p.profile) === structured),
    ];
  }

  /** The plan on screen, as one mode's part. */
  #modePlan(): ModePlan {
    const s = this.#state;
    return {
      baseId: s.baseId,
      weights: s.weights,
      limits: s.limits,
      detours: s.detours,
      parts: s.structured,
      edited: s.structuredEdited,
    };
  }

  // ---------------------------------------------------------------- start

  /** Fetches the presets and the catalogue (they do not need the region graph). */
  async init() {
    const [shipped, catalogue, twins] = await Promise.all([
      this.#engine.presets(),
      this.#engine.catalogue(),
      this.#engine.structuredPresets().catch(() => [] as Preset[]),
    ]);
    this.#all.shipped = shipped;
    this.#all.twins = twins;
    const presets = this.#presetsFor("sliders");
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
    } else {
      // a plan saved while there was a core set: its stray zeros go (docs/planner.md, Persistence)
      const base = presets.find((p) => p.id === this.#state.baseId);
      patch.weights = dropFormerCoreZeros(this.#state.weights, base?.profile.weights);
    }
    if (this.#state.compareId && !presets.some((p) => p.id === this.#state.compareId)) patch.compareId = null;
    if (restored && restored.waypoints.length >= 2) patch.fitSeq = this.#state.fitSeq + 1;
    if (this.#wantControls === "structured") {
      // no slider route first: the structured one follows at once
      this.#set(patch);
      await this.#switchOn();
      return;
    }
    this.#set(patch, { route: true });
  }

  // ---------------------------------------------------------------- the controls (#66)

  /**
   * The structured controls on or off (an app setting, saved on the device). On: the plan's slider
   * profile converted by the engine, or the structured profile edited before; off: the slider profile
   * as it was. Both stay in the plan, so the rider can flip between them and compare routes.
   */
  async setControls(controls: Controls) {
    this.#wantControls = controls;
    this.#saveControls(controls);
    if (controls === this.#state.controls) return;
    if (controls === "structured") await this.#switchOn();
    else this.#switchOff();
  }

  async #switchOn() {
    const seq = ++this.#switchSeq;
    const s = this.#state;
    const sliders = this.#modePlan();
    const twins = this.#all.twins;
    const twin =
      twins.find((p) => p.id === twinId(s.baseId)) ??
      twins.find((p) => p.id === twinId(DEFAULT_BASE)) ??
      twins[0];
    let next: ModePlan | null = this.#other?.parts && this.#other.edited ? this.#other : null;
    // a saved structured profile on an own preset that is gone falls back to the twin
    if (next && !this.#presetsFor("structured").some((p) => p.id === next?.baseId)) next = null;
    if (!next && twin) {
      const exact = twin.id === twinId(s.baseId) && !s.changed;
      if (exact) {
        next = {
          baseId: twin.id,
          weights: { ...twin.profile.weights },
          limits: normaliseLimits(twin.profile.limits, s.catalogue),
          detours: null,
          parts: partsOf(twin.profile),
          edited: false,
        };
      } else {
        this.#set({ converting: true });
        let converted: Profile;
        try {
          converted = await this.#engine.toStructured(this.profile());
        } catch {
          if (seq === this.#switchSeq) this.#set({ converting: false });
          return;
        }
        if (seq !== this.#switchSeq) return;
        const now = this.#state;
        const r = fromSliders({
          converted,
          twin: twin.id === twinId(now.baseId) ? twin : undefined,
          plan: { weights: now.weights, limits: now.limits },
          base: { weights: now.baseWeights, limits: now.baseLimits },
          catalogue: now.catalogue,
        });
        next = {
          baseId: twin.id,
          weights: r.weights,
          limits: normaliseLimits(r.limits, now.catalogue),
          detours: null,
          parts: r.parts,
          edited: false,
        };
      }
    }
    if (!next?.parts) {
      this.#set({ converting: false });
      return;
    }
    this.#other = { ...this.#modePlan(), ...sliders, parts: null };
    const compareId = s.compareId ? twinId(s.compareId) : null;
    const presets = this.#presetsFor("structured");
    this.#set(
      {
        controls: "structured",
        converting: false,
        presets,
        baseId: next.baseId,
        weights: next.weights,
        limits: next.limits,
        detours: null,
        structured: next.parts,
        structuredEdited: next.edited,
        compareId: compareId && presets.some((p) => p.id === compareId) ? compareId : null,
        chip: null,
      },
      { route: true, save: true, converted: true },
    );
  }

  #switchOff() {
    this.#switchSeq++;
    const s = this.#state;
    const here = this.#modePlan();
    const back = this.#other;
    this.#other = here.parts ? here : this.#other;
    const presets = this.#presetsFor("sliders");
    const baseId =
      back && presets.some((p) => p.id === back.baseId)
        ? back.baseId
        : presets.some((p) => p.id === DEFAULT_BASE)
          ? DEFAULT_BASE
          : (presets[0]?.id ?? DEFAULT_BASE);
    const base = presets.find((p) => p.id === baseId);
    const compareId = s.compareId?.replace(/_structured$/, "") ?? null;
    this.#set(
      {
        controls: "sliders",
        converting: false,
        presets,
        baseId,
        weights: back?.weights ?? { ...(base?.profile.weights ?? {}) },
        limits: back?.limits ?? normaliseLimits(base?.profile.limits ?? {}, s.catalogue),
        detours: back?.detours ?? null,
        structured: null,
        structuredEdited: false,
        compareId: compareId && presets.some((p) => p.id === compareId) ? compareId : null,
        chip: null,
      },
      { route: true, save: true },
    );
  }

  // ---------------------------------------------------------------- the structured controls

  /** A board row to another tier (tap a chip, pick a tier). */
  setRow(row: BoardRow, tier: Tier) {
    const p = this.#state.structured;
    if (!p) return;
    this.#set({ structured: { ...p, boards: moveRow(p.boards, row, tier) } }, { route: true, save: true });
  }

  /** The change dot of a row: back to the base preset's tier. */
  resetRow(row: BoardRow) {
    const b = this.#state.baseParts;
    const board = (b?.boards[boardOf(row)] ?? {}) as Partial<Record<BoardRow, Tier>>;
    const tier = board[row];
    if (tier) this.setRow(row, tier);
  }

  /** One handle of the hills curve (0 % stays pinned). */
  setHandle(grade: number, value: number) {
    const p = this.#state.structured;
    if (!p) return;
    const hills = curveWithHandle(p.hills, grade, value, this.#state.catalogue?.structured);
    this.#set({ structured: { ...p, hills } }, { route: true, save: true });
  }

  /** A whole curve: a named one from the catalogue, or the loose-ground step. */
  setHills(hills: Hills) {
    const p = this.#state.structured;
    if (!p) return;
    this.#set({ structured: { ...p, hills: cleanHills(hills) } }, { route: true, save: true });
  }

  resetHills() {
    const b = this.#state.baseParts;
    if (b) this.setHills(b.hills);
  }

  /** Detours under the structured controls: the spread of the tiers, 0.5 … 2. */
  setSpread(value: number) {
    const p = this.#state.structured;
    if (!p) return;
    const spread = snapSpread(value);
    if (spread === p.spread) return;
    this.#set({ structured: { ...p, spread } }, { route: true, save: true });
  }

  resetSpread() {
    const b = this.#state.baseParts;
    if (b) this.setSpread(b.spread);
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
        ...(this.#state.controls === "structured" ? { structured: partsOf(base.profile) } : {}),
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
    const { [id]: _, ...rest } = this.#state.weights;
    this.#set(
      { weights: rest, chip: this.#state.chip === id ? null : this.#state.chip },
      { route: true, save: true },
    );
  }

  /** The change dot: back to the base's value (a row the base lacks goes away). */
  resetPref(id: PrefId) {
    const b = this.#state.baseWeights[id];
    if (b === undefined) return this.removePref(id);
    const weights = { ...this.#state.weights, [id]: b };
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
    if (s.controls === "structured") {
      const { base: _, ...profile } = this.profile();
      const preset: PlanPreset = {
        id: `own-${Date.now().toString(36)}`,
        blurb: s.base ? `Made from ${presetName(s.base)}` : "Your own",
        profile: { ...profile, name: name.trim() || `${presetName(s.base)} +` },
        own: true,
      };
      this.#all.own = [...this.#all.own, preset];
      this.#set({ presets: [...s.presets, preset], baseId: preset.id }, { save: true });
      this.#saveOwn();
      return;
    }
    const preset = ownPreset(
      name.trim() || `${presetName(s.base)} +`,
      s.base,
      s.weights,
      s.limits,
      undefined,
      planProfile(s.base, s.weights, s.limits, s.minFactor).bounds,
    );
    this.#all.own = [...this.#all.own, preset];
    this.#set({ presets: [...s.presets, preset], baseId: preset.id }, { save: true });
    this.#saveOwn();
  }

  renamePreset(id: string, name: string) {
    const rename = (p: PlanPreset) =>
      p.id === id && p.own ? { ...p, profile: { ...p.profile, name: name.trim() || presetName(p) } } : p;
    this.#all.own = this.#all.own.map(rename);
    const presets = this.#state.presets.map(rename);
    this.#set({ presets });
    this.#saveOwn();
  }

  /** Deletes an own preset; a plan based on it keeps its values on the default base. */
  deletePreset(id: string) {
    const s = this.#state;
    const presets = s.presets.filter((p) => !(p.id === id && p.own));
    this.#all.own = this.#all.own.filter((p) => p.id !== id);
    const patch: Partial<PlanState> = { presets, compareId: s.compareId === id ? null : s.compareId };
    const fallback = s.controls === "structured" ? twinId(DEFAULT_BASE) : DEFAULT_BASE;
    if (s.baseId === id)
      patch.baseId = presets.some((p) => p.id === fallback) ? fallback : (presets[0]?.id ?? DEFAULT_BASE);
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

  /** The profile the plan routes with, the detours included (the cost layer and the inspector use the same). */
  profile(): Profile {
    return this.#profileWith(this.#state.limits);
  }

  /** The plan's profile with other limits (the probe lifts them one at a time). */
  #profileWith(limits: Limits): Profile {
    const s = this.#state;
    if (s.controls === "structured" && s.structured)
      return structuredProfile(s.base, s.weights, limits, s.structured, s.catalogue);
    return planProfile(s.base, s.weights, limits, s.minFactor);
  }

  /** A preset's own profile under the controls on screen (the ghost, a compared preset). */
  #presetProfile(p: PlanPreset, weights: Weights, limits: Limits, minFactor?: number): Profile {
    const s = this.#state;
    if (s.controls === "structured")
      return structuredProfile(p, weights, limits, partsOf(p.profile), s.catalogue);
    return planProfile(p, weights, limits, minFactor);
  }

  /**
   * One edge's cost, explained under the plan's profile and exceptions (or under another profile
   * alone, on its own lane; latest wins).
   */
  explainEdge(edge: number, profile?: Profile, lane = "explain"): Promise<EdgeExplanation | Superseded> {
    const overrides = profile ? [] : this.#wire();
    return this.#engine.explainEdge(
      { profile: profile ?? this.profile(), edge, ...(overrides.length > 0 ? { overrides } : {}) },
      lane,
    );
  }

  // ---------------------------------------------------------------- this plan's exceptions

  /** The plan's exceptions as the engine takes them (one per edge). */
  #wire() {
    return overridesWire(this.#state.overrides);
  }

  /** The inspected way's run of edges between junctions (`run`), what an exception applies to. */
  loadRun(edge: number) {
    if (this.#state.run?.edge === edge) return;
    void this.#engine.edgeRun(edge, "edge-run").then(
      (result) => {
        if (isSuperseded(result)) return;
        this.#set({ run: { edge, result } });
      },
      () => undefined,
    );
  }

  clearRun() {
    this.#engine.cancel("edge-run");
    if (this.#state.run) this.#set({ run: null });
  }

  #setOverrides(overrides: PlanOverride[], text: string) {
    const s = this.#state;
    this.#set(
      {
        overrides,
        overridesDropped: 0,
        overrideUndo: { text, before: s.overrides, seq: (s.overrideUndo?.seq ?? 0) + 1 },
      },
      { route: true, save: true },
    );
  }

  /** "Avoid this segment", "Prefer this way", "Allow here": the run of `edge` (loaded by `loadRun`). */
  addOverride(kind: OverrideKind, edge: number, way: string, limit?: LimitId) {
    const run = this.#state.run?.edge === edge ? this.#state.run.result : null;
    const o = makeOverride(
      kind,
      run ?? { edges: [edge], index: 0, length_m: 0, coordinates: [] },
      way,
      limit,
    );
    this.#setOverrides(withOverride(this.#state.overrides, o), overrideText(o));
  }

  removeOverride(id: string) {
    const o = this.#state.overrides.find((x) => x.id === id);
    if (!o) return;
    this.#setOverrides(
      this.#state.overrides.filter((x) => x.id !== id),
      `Removed: ${overrideText(o).toLowerCase()}`,
    );
  }

  /** Back to the exceptions before the last change. */
  undoOverride() {
    const u = this.#state.overrideUndo;
    if (!u) return;
    this.#set({ overrides: u.before, overrideUndo: null }, { route: true, save: true });
  }

  dismissUndo() {
    if (this.#state.overrideUndo) this.#set({ overrideUndo: null });
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

  /** A route request for the plan's stops: every lane honours the plan's exceptions (docs/planner.md). */
  #request(profile: Profile): RouteRequest {
    const overrides = this.#wire();
    return {
      waypoints: this.#state.waypoints.map((w) => ({ lon: w.lon, lat: w.lat })),
      profile,
      options: OPTIONS,
      ...(overrides.length > 0 ? { overrides } : {}),
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
      request.overrides ?? [],
      request.profile.boards,
      request.profile.hills,
      request.profile.detours,
      request.profile.turn_m,
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
    const profile = this.profile();
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
        ? this.#request(this.#presetProfile(base, s.baseWeights, s.baseLimits, s.baseMinFactor))
        : null;
    this.#send("ghost", ghost, (line) => {
      this.#set({ ghost: line });
      this.#diffMoved();
    });
    const other = s.presets.find((p) => p.id === s.compareId);
    const compare = other
      ? this.#request(
          this.#presetProfile(
            other,
            other.profile.weights,
            normaliseLimits(other.profile.limits, s.catalogue),
          ),
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
    const overrides = this.#wire();
    const request = {
      profile: this.profile(),
      a: a.arcs,
      b: b.arcs,
      ...(overrides.length > 0 ? { overrides } : {}),
    };
    void this.#engine.compare(request, "whynot-compare").then(
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
      const outcome = await this.#engine.route(this.#request(this.#profileWith(limits)), "probe");
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
  if (s.controls === "structured" && s.structured) {
    // the structured controls (#66): the boards, the curve and the spread are changes too
    const baseParts = partsOf(base?.profile);
    const hidden = replaced(s.catalogue);
    const list: Change[] = [
      ...changes({ weights: baseWeights, limits: baseLimits }, s.weights, s.limits, s.catalogue),
      ...structuredChanges(baseParts, s.structured, s.catalogue?.structured).map((c) => ({
        id: c.id as Change["id"],
        kind: c.kind,
        added: false,
        removed: false,
        text: c.text,
      })),
    ];
    return {
      ...s,
      base,
      baseWeights,
      baseLimits,
      baseParts,
      minFactor: baseMin,
      baseMinFactor: baseMin,
      changes: list,
      sentence: changeSentence(presetName(base), list),
      prefIds: prefRows(s.weights).filter((id) => !hidden.prefs.has(id)),
      limitIds: limitRows(baseLimits, s.limits).filter((id) => !hidden.limits.has(id)),
      changed:
        !sameCost({ weights: baseWeights, limits: baseLimits }, { weights: s.weights, limits: s.limits }) ||
        !sameParts(baseParts, s.structured),
    };
  }
  const list = changes({ weights: baseWeights, limits: baseLimits }, s.weights, s.limits, s.catalogue, {
    base: baseMin,
    plan: minFactor,
  });
  return {
    ...s,
    base,
    baseWeights,
    baseLimits,
    baseParts: null,
    minFactor,
    baseMinFactor: baseMin,
    changes: list,
    sentence: changeSentence(presetName(base), list),
    prefIds: prefRows(s.weights),
    limitIds: limitRows(baseLimits, s.limits),
    changed: !sameCost(
      { weights: baseWeights, limits: baseLimits, minFactor: baseMin },
      { weights: s.weights, limits: s.limits, minFactor },
    ),
  };
}

/** A saved structured profile as the plan of its mode. */
function modePlanOf(st: SavedStructured): ModePlan {
  return {
    baseId: st.baseId,
    weights: st.weights,
    limits: st.limits,
    detours: null,
    parts: { boards: st.boards, hills: st.hills, spread: st.spread },
    edited: st.edited,
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
