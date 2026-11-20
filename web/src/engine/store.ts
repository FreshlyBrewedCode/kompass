// The engine's state for the UI (docs/engine-web.md "States"): one engine worker per app, the region
// graph it has loaded, and whether a request runs. Plain TS with subscribe / getSnapshot (for
// `useSyncExternalStore`, see use-engine.ts); the client is injectable for tests.
//
//   idle ──load──▶ downloading(progress) ──▶ loading(progress) ──▶ ready
//                         └───────────────────────┴──────────────▶ error   (load again: retries)
//   + `busy` while any request is in the worker

import type { GraphFiles } from "@/map/manifest";
import { type EngineClient, type Superseded, startEngine } from "./client";
import type { RouteRequest } from "./generated/types";
import type { EngineMethod, GeometryMode, LoadStats, Params, Result, RouteOutcome } from "./protocol";

export type EngineStatus =
  | { status: "idle" }
  /** bytes over the wire, of the files not on the device yet */
  | { status: "downloading"; done: number; total: number }
  /** bytes read from the device into the engine */
  | { status: "loading"; done: number; total: number }
  | { status: "ready"; buildId: string; stats: LoadStats }
  | { status: "error"; message: string };

export type EngineSnapshot = EngineStatus & { busy: boolean; version: string | null };

type Args<M extends EngineMethod> = Params<M> extends undefined ? [] : [Params<M>];

export class EngineStore {
  readonly #client: EngineClient;
  #snapshot: EngineSnapshot = { status: "idle", busy: false, version: null };
  readonly #listeners = new Set<() => void>();
  #loading: { key: string; promise: Promise<LoadStats> } | null = null;
  #requests = 0;

  constructor(client: EngineClient) {
    this.#client = client;
    client.onEvent(({ progress }) => {
      if (this.#snapshot.status !== "downloading" && this.#snapshot.status !== "loading") return;
      const status = progress.phase === "download" ? "downloading" : "loading";
      this.#set({ status, done: progress.done, total: progress.total });
    });
    void client.call("version").then(
      (version) => this.#update({ version }),
      () => undefined,
    );
  }

  get client(): EngineClient {
    return this.#client;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): EngineSnapshot => this.#snapshot;

  #update(patch: Partial<EngineSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch } as EngineSnapshot;
    for (const listener of [...this.#listeners]) listener();
  }

  #set(status: EngineStatus) {
    const { busy, version } = this.#snapshot;
    this.#snapshot = { ...status, busy, version };
    for (const listener of [...this.#listeners]) listener();
  }

  /**
   * Loads a region's graph (downloads what the device lacks). Loading the same build again while it
   * loads or once it is ready is a no-op; another build replaces it; after an error it retries.
   */
  load(dataUrl: string, graph: GraphFiles, geometry: GeometryMode = "eager"): Promise<LoadStats> {
    const key = `${dataUrl}|${graph.formatVersion}|${graph.buildId}|${geometry}`;
    if (this.#loading?.key === key && this.#snapshot.status !== "error") return this.#loading.promise;
    // the worker says whether anything has to be downloaded first
    this.#set({ status: "loading", done: 0, total: 0 });
    const promise = this.#client.call("load", { dataUrl, graph, geometry }).then(
      (stats) => {
        if (this.#loading?.key === key) this.#set({ status: "ready", buildId: stats.buildId, stats });
        // ~100 MB on the device: ask the browser not to evict it under storage pressure
        if (stats.cached) void globalThis.navigator?.storage?.persist?.().catch(() => false);
        return stats;
      },
      (error: unknown) => {
        if (this.#loading?.key === key) {
          this.#set({ status: "error", message: error instanceof Error ? error.message : String(error) });
        }
        throw error;
      },
    );
    this.#loading = { key, promise };
    return promise;
  }

  async #track<T>(work: Promise<T>): Promise<T> {
    if (this.#requests++ === 0) this.#update({ busy: true });
    try {
      return await work;
    } finally {
      if (--this.#requests === 0) this.#update({ busy: false });
    }
  }

  /** Any engine request, with `busy` set while it runs. */
  call<M extends EngineMethod>(method: M, ...params: Args<M>): Promise<Result<M>> {
    return this.#track(this.#client.call(method, ...params));
  }

  /** A route, latest wins per lane (see `EngineClient.latest`): one lane per line on the map. */
  routeLatest(request: RouteRequest, lane = "route"): Promise<RouteOutcome | Superseded> {
    return this.#track(this.#client.latest(lane, "route", request));
  }
}

let shared: EngineStore | null = null;

/** The app's one engine (its worker starts on first use). */
export function engineStore(): EngineStore {
  shared ??= new EngineStore(startEngine());
  return shared;
}
