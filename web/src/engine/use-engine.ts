import { useSyncExternalStore } from "react";
import { type EngineSnapshot, type EngineStore, engineStore } from "./store";

/** The engine's state (idle, downloading, loading, ready, error; busy), re-rendering on change. */
export function useEngine(store: EngineStore = engineStore()): EngineSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
