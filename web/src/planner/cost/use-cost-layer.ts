// Wires the cost layer (src/map/cost-layer.ts) to the planner: while the "Cost" information layer is
// on and the engine has the region, it colours the visible edges by the plan's profile and follows
// every profile change (a slider step) as well as every map move.
import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useState, useSyncExternalStore } from "react";
import { CostLayer, type CostStatus } from "@/map/cost-layer";
import { devEnabled } from "@/map/dev";
import type { PlannerStore, PlanState } from "../store";

const profileOf = (s: PlanState) => [s.base, s.weights, s.limits, s.minFactor] as const;

export function useCostLayer(
  map: MapLibreMap | null,
  store: PlannerStore,
  sourceLayer: string,
  on: boolean,
  ready: boolean,
): CostLayer | null {
  const [layer, setLayer] = useState<CostLayer | null>(null);
  useEffect(() => {
    if (!map) return;
    const l = new CostLayer(map, sourceLayer, (params) => store.edgeCosts(params));
    setLayer(l);
    if (devEnabled(location.search)) {
      const win = window as unknown as { __kompass?: object };
      win.__kompass = Object.assign(win.__kompass ?? {}, { cost: l });
    }
    return () => {
      l.destroy();
      setLayer(null);
    };
  }, [map, store, sourceLayer]);

  useEffect(() => {
    if (!layer) return;
    if (!on || !ready) {
      layer.setProfile(null);
      return;
    }
    let last = profileOf(store.getSnapshot());
    layer.setProfile(store.profile());
    return store.subscribe(() => {
      const next = profileOf(store.getSnapshot());
      if (next.every((v, i) => v === last[i])) return;
      last = next;
      layer.setProfile(store.profile());
    });
  }, [layer, on, ready, store]);
  return layer;
}

const OFF_STATUS: CostStatus = {
  state: "off",
  minFactor: 0.5,
  maxFactor: 20,
  edges: 0,
  atMin: 0,
  closed: [],
  queryMs: 0,
  applyMs: 0,
};

/** The layer's status for the key (re-renders when an answer is applied). */
export function useCostStatus(layer: CostLayer | null): CostStatus {
  return useSyncExternalStore(
    (cb) => layer?.subscribe(cb) ?? (() => undefined),
    () => layer?.getStatus() ?? OFF_STATUS,
  );
}
