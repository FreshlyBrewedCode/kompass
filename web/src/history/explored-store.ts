// The explored map's data: which edges have been ridden. A plain in-memory store with a subscribe
// API; the ride library (src/rides/, docs/rides.md) fills it from its saved matches, the map reads it
// and mirrors it into `feature-state` (src/map/explored-layer.ts). Edge ids are the overlay's
// feature ids (= the engine's edge ids).

export type RideInfo = {
  /** how often the edge was ridden */
  count: number;
  /** when it was last ridden, ms since the epoch (0 = unknown) */
  lastRidden: number;
};

export type RiddenInput = Iterable<number> | ReadonlyMap<number, RideInfo>;

const NO_INFO: RideInfo = { count: 1, lastRidden: 0 };

export class ExploredStore {
  #edges: ReadonlyMap<number, RideInfo> = new Map();
  #version = 0;
  readonly #listeners = new Set<() => void>();

  /** Replaces the ridden set: plain edge ids (each ridden once, time unknown) or ids with their info. */
  setRidden(input: RiddenInput): void {
    const next = new Map<number, RideInfo>();
    if (input instanceof Map) {
      for (const [id, info] of input) next.set(id, info);
    } else {
      for (const id of input as Iterable<number>) next.set(id, NO_INFO);
    }
    this.#edges = next;
    this.#changed();
  }

  /** No edge is ridden any more. */
  clear(): void {
    if (this.#edges.size === 0) return;
    this.#edges = new Map();
    this.#changed();
  }

  /** The current ridden set; a new map after every change, never mutated. */
  get edges(): ReadonlyMap<number, RideInfo> {
    return this.#edges;
  }

  get size(): number {
    return this.#edges.size;
  }

  /** Bumps on every change (a cheap snapshot for `useSyncExternalStore`). */
  get version(): number {
    return this.#version;
  }

  /** Calls `listener` after every change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed() {
    this.#version++;
    for (const listener of [...this.#listeners]) listener();
  }
}

/** The app's one store. */
export const exploredStore = new ExploredStore();
