// Mirrors the explored store into the overlay's `feature-state` (`ridden`, `count`), so the explored
// mode can colour edges by edge id without personal data ever becoming tiles.
//
// - MapLibre keeps feature state per source, keyed by feature id, and applies it to tiles as they load:
//   setting it for ids that are not on screen yet is fine. What it does *not* survive is a new style
//   (theme change): `reapply()` runs after every `style.load`.
// - Applying ~100k ids in one go would freeze the UI, so it runs in chunks and yields to the main
//   thread in between. A change during an apply restarts it from the new state.
import type { Map as MapLibreMap } from "maplibre-gl";
import type { ExploredStore, RideInfo } from "@/history/explored-store";
import { OVERLAY_SOURCE } from "./style";

export const APPLY_CHUNK = 5000;

export type ApplyReport = { edges: number; ms: number };

type Target = Pick<MapLibreMap, "setFeatureState" | "removeFeatureState">;

/** Gives the main thread back (before the next chunk): a macrotask, so input and paint run in between. */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class ExploredLayer {
  readonly #map: Target;
  readonly #store: ExploredStore;
  readonly #sourceLayer: string;
  readonly #unsubscribe: () => void;
  /** what the map currently carries */
  #applied: ReadonlyMap<number, RideInfo> = new Map();
  #run = 0;
  #pending: Promise<void> = Promise.resolve();
  #enabled = false;
  onApplied: ((report: ApplyReport) => void) | undefined;

  constructor(map: Target, store: ExploredStore, sourceLayer: string) {
    this.#map = map;
    this.#store = store;
    this.#sourceLayer = sourceLayer;
    this.#unsubscribe = store.subscribe(() => void this.sync());
  }

  /** The map's source was recreated (new style): its feature state is gone, apply everything again. */
  reapply(): Promise<void> {
    this.#applied = new Map();
    this.#enabled = true;
    return this.sync();
  }

  /** While the style is being replaced there is no source to set state on: stop until `reapply()`. */
  suspend() {
    this.#enabled = false;
    this.#run++;
  }

  /** Resolves when the map carries the store's state (or a newer change took over). */
  sync(): Promise<void> {
    const run = ++this.#run;
    this.#pending = this.#pending.then(() => this.#apply(run));
    return this.#pending;
  }

  destroy() {
    this.#run++;
    this.#unsubscribe();
  }

  async #apply(run: number) {
    if (run !== this.#run || !this.#enabled) return;
    const target = this.#store.edges;
    const started = performance.now();
    const id = (edge: number) => ({ source: OVERLAY_SOURCE, sourceLayer: this.#sourceLayer, id: edge });

    if (target.size === 0) {
      // one call drops all state of the layer
      if (this.#applied.size > 0) {
        this.#map.removeFeatureState({ source: OVERLAY_SOURCE, sourceLayer: this.#sourceLayer });
      }
      this.#applied = new Map();
      this.onApplied?.({ edges: 0, ms: performance.now() - started });
      return;
    }

    const applied = new Map(this.#applied);
    const removals = [...applied.keys()].filter((edge) => !target.has(edge));
    // only the count is in the feature state: a refold with the same counts changes nothing on the map
    const additions = [...target].filter(([edge, info]) => applied.get(edge)?.count !== info.count);
    const work: (() => void)[] = [];
    for (const edge of removals) {
      work.push(() => {
        this.#map.removeFeatureState(id(edge));
        applied.delete(edge);
      });
    }
    for (const [edge, info] of additions) {
      work.push(() => {
        this.#map.setFeatureState(id(edge), { ridden: true, count: info.count });
        applied.set(edge, info);
      });
    }

    for (let i = 0; i < work.length; i += APPLY_CHUNK) {
      for (const step of work.slice(i, i + APPLY_CHUNK)) step();
      // a newer change restarts from what has been applied so far
      this.#applied = applied;
      if (i + APPLY_CHUNK < work.length) {
        await yieldToMain();
        if (run !== this.#run) return;
      }
    }
    this.#applied = applied;
    this.onApplied?.({ edges: target.size, ms: performance.now() - started });
  }
}
