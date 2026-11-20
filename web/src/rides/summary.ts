// The numbers the rides panel shows about the explored map. Pure: from the state's snapshot fields.
import type { RideMatchInfo } from "./matcher";

/** What the last fold of the matches said (state.ts): distinct ways ridden, their length, the network's. */
export type ExploredStats = {
  /** edges ridden at least once (the 50 % rule) */
  edges: number;
  /** their summed length, km; `null` while the engine could not say */
  km: number | null;
  /** the whole graph's length, km */
  networkKm: number | null;
};

export type ExploredSummary = {
  /** rides stored */
  rides: number;
  /** rides with a match for the current graph build */
  matched: number;
  /** of those, mostly outside the region */
  outside: number;
  edges: number;
  km: number | null;
  /** km ridden / km of the network, 0..1 */
  share: number | null;
};

export function summarize(
  rides: readonly { id: string }[],
  matches: ReadonlyMap<string, RideMatchInfo>,
  stats: ExploredStats | null,
): ExploredSummary {
  let matched = 0;
  let outside = 0;
  for (const ride of rides) {
    const info = matches.get(ride.id);
    if (!info) continue;
    matched++;
    if (info.outside) outside++;
  }
  const km = stats?.km ?? null;
  const networkKm = stats?.networkKm ?? null;
  return {
    rides: rides.length,
    matched,
    outside,
    edges: stats?.edges ?? 0,
    km,
    share: km !== null && networkKm !== null && networkKm > 0 ? Math.min(1, km / networkKm) : null,
  };
}

/** "2,593 km", "84 km", "6.3 km": the distance of ways, whole km from 100. */
export function formatKm(km: number): string {
  return km >= 100 ? `${Math.round(km).toLocaleString("en")} km` : `${km.toFixed(km < 10 ? 1 : 0)} km`;
}

/** "3.4 %", "12 %", "<0.1 %" for a share 0..1. */
export function formatShare(share: number): string {
  const percent = share * 100;
  if (percent > 0 && percent < 0.1) return "<0.1 %";
  return percent < 10 ? `${percent.toFixed(1)} %` : `${Math.round(percent)} %`;
}
