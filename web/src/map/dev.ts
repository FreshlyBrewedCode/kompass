// Dev hooks (`bun run dev`, or any build with `?dev` / `?fakeRidden=<n>`): fake some ridden edges so the
// explored map can be tried before the history import exists.
import type { Map as MapLibreMap } from "maplibre-gl";
import type { RideInfo } from "@/history/explored-store";
import { OVERLAY_SOURCE } from "./style";

export function devEnabled(search: string): boolean {
  const params = new URLSearchParams(search);
  return import.meta.env.DEV || params.has("dev") || params.has("fakeRidden");
}

/** `?fakeRidden=<n>`: how many edges to fake (0 or absent: none). */
export function fakeRiddenCount(search: string): number {
  const n = Number(new URLSearchParams(search).get("fakeRidden"));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Up to `limit` edges of the tiles loaded right now (every other one, so the picture is patchy), with a made-up history. */
export function fakeRiddenFromRendered(
  map: MapLibreMap,
  sourceLayer: string,
  limit: number,
): Map<number, RideInfo> {
  const out = new Map<number, RideInfo>();
  const now = Date.now();
  for (const feature of map.querySourceFeatures(OVERLAY_SOURCE, { sourceLayer })) {
    const id = feature.id;
    if (typeof id !== "number" || id % 2 !== 0 || out.has(id)) continue;
    out.set(id, { count: 1 + (id % 5), lastRidden: now - (id % 365) * 86_400_000 });
    if (out.size >= limit) break;
  }
  return out;
}

/** `n` consecutive edge ids from `start`: for measuring how fast a big history applies. */
export function fakeRiddenRange(start: number, n: number): Map<number, RideInfo> {
  const out = new Map<number, RideInfo>();
  for (let id = start; id < start + n; id++) out.set(id, { count: 1, lastRidden: 0 });
  return out;
}
