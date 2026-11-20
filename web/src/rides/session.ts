// The app's one ride library session: the ride worker, started on first use, and its state. The state
// follows the engine: when it has a graph loaded, the rides are matched onto it in the background.

import { type EngineStore, engineStore } from "@/engine/store";
import { startRides } from "./client";
import { type RegionEngine, RidesState } from "./state";

/** The engine store as the library drives it. Matching is background work: it does not mark the engine busy. */
export function regionEngine(store: EngineStore): RegionEngine {
  const { client } = store;
  return {
    matchRide: (lat, lon) => client.call("matchRide", { lat, lon }),
    setPersonal: (layer) => client.call("setPersonal", layer),
    edgesLength: (edges) => client.call("edgesLength", { edges }),
  };
}

/** Attaches `state` to the engine whenever it has a graph (and detaches while it reloads). */
export function followEngine(state: RidesState, store: EngineStore): () => void {
  const engine = regionEngine(store);
  let attachedBuild: string | null = null;
  const update = () => {
    const snapshot = store.getSnapshot();
    if (snapshot.status === "ready") {
      if (attachedBuild === snapshot.buildId) return;
      attachedBuild = snapshot.buildId;
      const { info } = snapshot.stats;
      state.attachEngine(engine, {
        graphBuild: snapshot.buildId,
        edgeCount: info.edges,
        networkM: info.networkM,
      });
    } else if (snapshot.status === "loading" || snapshot.status === "downloading") {
      if (attachedBuild !== null) {
        attachedBuild = null;
        state.detachEngine();
      }
    }
  };
  const unsubscribe = store.subscribe(update);
  update();
  return unsubscribe;
}

let state: RidesState | null = null;

export function ridesState(): RidesState {
  if (!state) {
    state = new RidesState(startRides());
    followEngine(state, engineStore());
  }
  return state;
}
