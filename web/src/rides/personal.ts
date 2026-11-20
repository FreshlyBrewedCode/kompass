// The personal layer for the route query (docs/engine-web.md, docs/matching.md): the explored fold as
// flat arrays by edge id, the shape `engine.call("setPersonal", …)` takes. The profile's novelty
// preferences ("never ridden", "not ridden for long", "ridden often") read them.

import type { PersonalParams } from "@/engine/protocol";
import type { RideInfo } from "@/history/explored-store";

const DAY_MS = 86_400_000;

/** A ms timestamp as days since 1970-01-01 UTC (0 for an unknown time, as the engine wants it). */
export function dayOf(ms: number): number {
  return ms > 0 ? Math.floor(ms / DAY_MS) : 0;
}

/**
 * Per edge the number of rides (saturating at 65535) and the day of the last one (0: only untimed
 * rides), sized to the graph's `edgeCount` as the engine requires; ids beyond it are dropped.
 */
export function personalLayer(
  explored: ReadonlyMap<number, RideInfo>,
  edgeCount: number,
  now: number = Date.now(),
): PersonalParams {
  const rides = new Uint16Array(edgeCount);
  const lastRidden = new Uint32Array(edgeCount);
  for (const [edge, info] of explored) {
    if (edge >= edgeCount) continue;
    rides[edge] = Math.min(info.count, 0xffff);
    lastRidden[edge] = dayOf(info.lastRidden);
  }
  return { rides, lastRidden, today: dayOf(now) };
}
