// The ride library as the UI sees it: one external store (subscribe / snapshot, for
// `useSyncExternalStore`) in front of the ride worker. No React, no layout: the components in
// src/components/ read it and call its actions, and a redesign can replace them freely.
import type { ExploredStore } from "@/history/explored-store";
import type { RidesClient } from "./client";
import { describeSummary, summarizeImport } from "./format";
import type { BackupResult, RidesLayerData } from "./protocol";
import type { FileResult, ImportSummary, RideSummary } from "./types";

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
  };
  readonly #listeners = new Set<() => void>();
  #explored: { store: ExploredStore; graphBuild: string } | null = null;
  #exploredNonEmpty = false;
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
      await Promise.all([this.#refreshLayer(), this.refreshStorage(), this.#syncExplored()]);
    } catch (error) {
      this.#set({ phase: "error", error: message(error) });
    }
  }

  /** The explored map follows the saved matches (of `graphBuild`); applied now and after every change. */
  attachExplored(store: ExploredStore, graphBuild: string) {
    this.#explored = { store, graphBuild };
    void this.#syncExplored();
  }

  async #syncExplored() {
    const target = this.#explored;
    if (!target || this.#snapshot.phase !== "ready") return;
    const folded = await this.client.call("explored", { graphBuild: target.graphBuild });
    // leave a hand-made (dev) ridden set alone as long as there are no matches at all
    if (folded.size === 0 && !this.#exploredNonEmpty) return;
    this.#exploredNonEmpty = folded.size > 0;
    target.store.setRidden(folded);
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
    await Promise.all([this.#refreshLayer(), this.refreshStorage(), this.#syncExplored()]);
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

  async importFiles(files: File[]): Promise<void> {
    if (files.length === 0 || this.#snapshot.busy) return;
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
