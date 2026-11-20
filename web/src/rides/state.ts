// The ride library as the UI sees it: one external store (subscribe / snapshot, for
// `useSyncExternalStore`) in front of the ride worker. No React, no layout: the components in
// src/components/ read it and call its actions, and a redesign can replace them freely.
import type { PersonalParams } from "@/engine/protocol";
import type { ExploredStore } from "@/history/explored-store";
import type { RidesClient } from "./client";
import { describeSummary, summarizeImport } from "./format";
import { IDLE, type MatchEngine, type MatchProgress, RideMatcher, type RideMatchInfo } from "./matcher";
import { personalLayer } from "./personal";
import type { BackupResult, RidesLayerData } from "./protocol";
import type { ExploredStats } from "./summary";
import { BACKUP_MAGIC, type FileResult, type ImportSummary, type RideSummary } from "./types";

/** The engine as the library drives it: matching, the personal layer for routing, the length of edges. */
export interface RegionEngine extends MatchEngine {
  setPersonal(layer: PersonalParams | null): Promise<void>;
  /** the summed length in metres of these edges */
  edgesLength(edges: Uint32Array): Promise<number>;
}

/** What the loaded graph is: its build (matches belong to it), the edge count (the personal layer's size), its length. */
export type EngineGraph = { graphBuild: string; edgeCount: number; networkM: number };

export type StorageStatus = {
  /** `null` while unknown or unsupported */
  persisted: boolean | null;
  /** bytes the browser says this origin uses / may use */
  usage: number | null;
  quota: number | null;
};

export type Report =
  | { kind: "files"; summary: ImportSummary; results: FileResult[]; text: string }
  | { kind: "backup"; result: BackupResult; text: string }
  | { kind: "error"; text: string };

export type RidesSnapshot = {
  phase: "loading" | "ready" | "error";
  error: string | null;
  rides: RideSummary[];
  /** a long job in progress */
  busy: { label: string; done: number; total: number } | null;
  report: Report | null;
  storage: StorageStatus;
  /** the "My rides" lines; replaced after every change of the library */
  layer: RidesLayerData | null;
  /** matching the rides onto the graph, in the background (docs/rides.md) */
  matching: MatchProgress;
  /** whether an engine with a graph is attached: without one nothing can be matched */
  engineReady: boolean;
  /** per ride with a match of the current build: the matched share and whether it is outside the region */
  matches: ReadonlyMap<string, RideMatchInfo>;
  /** the last fold of the matches; `null` until there was one */
  explored: ExploredStats | null;
};

const EMPTY_LAYER: RidesLayerData = { type: "FeatureCollection", features: [] };

type StorageApi = Pick<StorageManager, "persisted" | "persist" | "estimate">;

export class RidesState {
  #snapshot: RidesSnapshot = {
    phase: "loading",
    error: null,
    rides: [],
    busy: null,
    report: null,
    storage: { persisted: null, usage: null, quota: null },
    layer: null,
    matching: IDLE,
    engineReady: false,
    matches: new Map(),
    explored: null,
  };
  readonly #listeners = new Set<() => void>();
  #explored: { store: ExploredStore; graphBuild: string } | null = null;
  #exploredNonEmpty = false;
  #engine: { engine: RegionEngine; graph: EngineGraph } | null = null;
  #matcher: RideMatcher | null = null;
  /** the engine's personal layer is set (so it must be cleared when the last match goes) */
  #personalSet = false;
  #syncing: Promise<void> | null = null;
  #syncAgain = false;
  #progressAt = 0;
  #progressTimer: ReturnType<typeof setTimeout> | null = null;
  /** how long the last layer fetch took (ms), for the measurements in docs */
  lastLayerMs = 0;

  constructor(
    private readonly client: RidesClient,
    private readonly storage: StorageApi | undefined = typeof navigator === "undefined"
      ? undefined
      : navigator.storage,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getSnapshot = (): RidesSnapshot => this.#snapshot;

  #set(patch: Partial<RidesSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of [...this.#listeners]) listener();
  }

  /** Opens the store and loads the list, the layer and the storage status. Safe to call twice. */
  async init(): Promise<void> {
    if (this.#snapshot.phase === "ready") return;
    try {
      const rides = await this.client.call("init", undefined);
      this.#set({ phase: "ready", rides });
      // an engine that was ready before the library was starts matching now
      if (this.#engine) this.#matcher?.setBuild(this.#engine.graph.graphBuild);
      await Promise.all([this.#refreshLayer(), this.refreshStorage(), this.#sync()]);
    } catch (error) {
      this.#set({ phase: "error", error: message(error) });
    }
  }

  /** The explored map follows the saved matches (of `graphBuild`); applied now and after every change. */
  attachExplored(store: ExploredStore, graphBuild: string) {
    this.#explored = { store, graphBuild };
    void this.#sync();
  }

  /**
   * An engine with a graph is ready: from now on the rides without a match for `graph.graphBuild` are
   * matched in the background, the folded matches go to the engine as the personal layer, and the
   * explored map follows the build (a build the matches are not of shows nothing until they are redone).
   */
  attachEngine(engine: RegionEngine, graph: EngineGraph) {
    const same = this.#engine?.graph.graphBuild === graph.graphBuild && this.#engine.engine === engine;
    this.#engine = { engine, graph };
    if (same) return;
    this.#personalSet = false; // a new graph has a new planner: no personal layer yet
    this.#matcher ??= this.#createMatcher();
    this.#set({ engineReady: true });
    void this.#sync();
    this.#matcher.setBuild(this.#snapshot.phase === "ready" ? graph.graphBuild : null);
  }

  /** The engine is gone (reloading another graph): matching waits. */
  detachEngine() {
    if (!this.#engine) return;
    this.#engine = null;
    this.#matcher?.setBuild(null);
    this.#set({ engineReady: false });
  }

  /** Stops matching after the ride in progress; `resumeMatching` carries on. */
  pauseMatching() {
    this.#matcher?.pause();
  }

  resumeMatching() {
    this.#matcher?.resume();
  }

  #createMatcher(): RideMatcher {
    const client = this.client;
    return new RideMatcher({
      rides: {
        list: () => client.call("list", undefined),
        matched: (graphBuild) => client.call("matchStatus", { graphBuild }),
        points: (id) => client.call("points", { id }),
        save: (id, match) => client.call("saveMatch", { id, ...match }),
      },
      engine: {
        matchRide: (lat, lon) => {
          const target = this.#engine;
          if (!target) return Promise.reject(new Error("the engine is not ready"));
          return target.engine.matchRide(lat, lon);
        },
      },
      onProgress: (progress) => this.#setMatching(progress),
      onMatches: (matches) => this.#set({ matches }),
      onBatch: () => void this.#sync(),
    });
  }

  /** Progress changes at most ~4 times a second (a ride can match in 20 ms); a phase change is immediate. */
  #setMatching(progress: MatchProgress) {
    const now = Date.now();
    const phaseChanged = progress.phase !== this.#snapshot.matching.phase;
    if (this.#progressTimer) clearTimeout(this.#progressTimer);
    this.#progressTimer = null;
    if (phaseChanged || now - this.#progressAt >= 250) {
      this.#progressAt = now;
      this.#set({ matching: progress });
    } else {
      this.#progressTimer = setTimeout(() => {
        this.#progressAt = Date.now();
        this.#set({ matching: progress });
      }, 250);
    }
  }

  /** Folds the saved matches into the explored store and the engine's personal layer (coalesced). */
  #sync(): Promise<void> {
    if (this.#syncing) {
      this.#syncAgain = true;
      return this.#syncing;
    }
    const run = (async () => {
      try {
        do {
          this.#syncAgain = false;
          await this.#syncOnce();
        } while (this.#syncAgain);
      } finally {
        this.#syncing = null;
      }
    })();
    this.#syncing = run;
    return run;
  }

  async #syncOnce() {
    const graphBuild = this.#engine?.graph.graphBuild ?? this.#explored?.graphBuild;
    if (!graphBuild || this.#snapshot.phase !== "ready") return;
    const folded = await this.client.call("explored", { graphBuild });
    const target = this.#explored;
    // leave a hand-made (dev) ridden set alone as long as there are no matches at all
    if (target && (folded.size > 0 || this.#exploredNonEmpty)) target.store.setRidden(folded);
    this.#exploredNonEmpty = folded.size > 0;

    const attached = this.#engine;
    if (!attached) {
      this.#set({ explored: { edges: folded.size, km: null, networkKm: null } });
      return;
    }
    const { engine, graph } = attached;
    let km: number | null = 0;
    try {
      if (folded.size > 0) {
        await engine.setPersonal(personalLayer(folded, graph.edgeCount));
        this.#personalSet = true;
        km = (await engine.edgesLength(Uint32Array.from(folded.keys()))) / 1000;
      } else if (this.#personalSet) {
        await engine.setPersonal(null);
        this.#personalSet = false;
      }
    } catch {
      km = null; // the engine reloaded under us: the next sync (after its attach) says
    }
    this.#set({ explored: { edges: folded.size, km, networkKm: graph.networkM / 1000 } });
  }

  async #refreshLayer() {
    const started = performance.now();
    const layer = await this.client.call("layer", undefined);
    this.lastLayerMs = performance.now() - started;
    const previous = this.#snapshot.layer;
    this.#set({ layer });
    // the map may still be reading the old blob: release it later
    if (typeof previous === "string") setTimeout(() => URL.revokeObjectURL(previous), 60_000);
  }

  async #afterChange(rides: RideSummary[]) {
    this.#set({ rides });
    this.#matcher?.kick(); // new rides are matched, removed ones are gone from the fold
    await Promise.all([this.#refreshLayer(), this.refreshStorage(), this.#sync()]);
  }

  async refreshStorage(): Promise<void> {
    const api = this.storage;
    if (!api) return;
    const [persisted, estimate] = await Promise.all([
      api.persisted?.().catch(() => null) ?? null,
      api.estimate?.().catch(() => null) ?? null,
    ]);
    this.#set({
      storage: {
        persisted: persisted ?? null,
        usage: estimate?.usage ?? null,
        quota: estimate?.quota ?? null,
      },
    });
  }

  /** Asks the browser not to evict the library (`navigator.storage.persist()`); returns whether it is persistent. */
  async requestPersistence(): Promise<boolean> {
    let granted = false;
    try {
      granted = (await this.storage?.persist?.()) ?? false;
    } catch {
      granted = false;
    }
    await this.refreshStorage();
    return granted;
  }

  /**
   * Imports what the picker or a drop delivered: GPX and FIT files and zips of them (read by the ride
   * worker), and `.kompassrides` backups (told by their first bytes, restored after the tracks).
   */
  async importFiles(all: File[]): Promise<void> {
    if (all.length === 0 || this.#snapshot.busy) return;
    const files: File[] = [];
    const backups: File[] = [];
    for (const file of all) ((await isBackup(file)) ? backups : files).push(file);
    if (files.length > 0) await this.#importTracks(files);
    for (const backup of backups) await this.importBackup(backup);
  }

  async #importTracks(files: File[]): Promise<void> {
    this.#set({ busy: { label: "Importing", done: 0, total: files.length }, report: null });
    try {
      const results = await this.client.call("importFiles", { files }, (p) =>
        this.#set({ busy: { label: "Importing", done: p.done, total: p.total } }),
      );
      const summary = summarizeImport(results);
      this.#set({ busy: null, report: { kind: "files", summary, results, text: describeSummary(summary) } });
      await this.#afterChange(await this.client.call("list", undefined));
      // the first import is the moment to ask the browser to keep the data
      if (summary.imported > 0 && this.#snapshot.storage.persisted === false) void this.requestPersistence();
    } catch (error) {
      this.#set({ busy: null, report: { kind: "error", text: `Import failed: ${message(error)}` } });
    }
  }

  async deleteRide(id: string): Promise<void> {
    await this.#afterChange(await this.client.call("deleteRides", { ids: [id] }));
  }

  async deleteAll(): Promise<void> {
    await this.#afterChange(await this.client.call("deleteAll", undefined));
    this.#set({ report: null });
  }

  /** The backup file (a Blob); the caller saves it. */
  async exportBackup(): Promise<Blob | null> {
    if (this.#snapshot.busy) return null;
    this.#set({ busy: { label: "Exporting", done: 0, total: this.#snapshot.rides.length }, report: null });
    try {
      const blob = await this.client.call("exportBackup", undefined, (p) =>
        this.#set({ busy: { label: "Exporting", done: p.done, total: p.total } }),
      );
      this.#set({ busy: null });
      return blob;
    } catch (error) {
      this.#set({ busy: null, report: { kind: "error", text: `Export failed: ${message(error)}` } });
      return null;
    }
  }

  async importBackup(file: Blob): Promise<void> {
    if (this.#snapshot.busy) return;
    this.#set({ busy: { label: "Restoring", done: 0, total: 0 }, report: null });
    try {
      const result = await this.client.call("importBackup", { file }, (p) =>
        this.#set({ busy: { label: "Restoring", done: p.done, total: p.total } }),
      );
      const text = `Backup restored: ${describeBackup(result)}`;
      this.#set({ busy: null, report: { kind: "backup", result, text } });
      await this.#afterChange(await this.client.call("list", undefined));
      if (result.imported > 0 && this.#snapshot.storage.persisted === false) void this.requestPersistence();
    } catch (error) {
      this.#set({ busy: null, report: { kind: "error", text: message(error) } });
    }
  }

  dismissReport() {
    this.#set({ report: null });
  }

  /** Calls the worker directly (dev hook: the matching seam has no UI yet). */
  call: RidesClient["call"] = (method, params, onProgress) => this.client.call(method, params, onProgress);

  /** The empty layer, for a map that is created before the worker answered. */
  static readonly emptyLayer = EMPTY_LAYER;
}

async function isBackup(file: Blob): Promise<boolean> {
  try {
    return (await file.slice(0, BACKUP_MAGIC.length).text()) === BACKUP_MAGIC;
  } catch {
    return false;
  }
}

function describeBackup(r: BackupResult): string {
  const parts = [`${r.imported} added`];
  if (r.known) parts.push(`${r.known} already here`);
  if (r.duplicates) parts.push(`${r.duplicates} duplicate${r.duplicates === 1 ? "" : "s"} skipped`);
  if (r.failed) parts.push(`${r.failed} failed`);
  return parts.join(", ");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
