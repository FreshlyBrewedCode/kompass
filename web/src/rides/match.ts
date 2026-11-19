// Folding saved matches into the explored map's input (docs/rides.md "the matching seam").
import type { RideInfo } from "@/history/explored-store";
import type { RideMatch, RideSummary } from "./types";

/**
 * Per edge id: in how many rides it was ridden and when last (the ride's end, 0 = unknown, i.e. only
 * untimed rides). Only matches of `graphBuild` count: edge ids of another build mean other edges.
 * An edge a ride passes several times counts once for that ride.
 */
export function foldMatches(
  rides: readonly Pick<RideSummary, "id" | "startTime" | "endTime">[],
  matches: readonly RideMatch[],
  graphBuild: string,
): Map<number, RideInfo> {
  const byId = new Map(rides.map((r) => [r.id, r]));
  const out = new Map<number, RideInfo>();
  for (const match of matches) {
    const ride = byId.get(match.rideId);
    if (!ride || match.graphBuild !== graphBuild) continue;
    const when = ride.endTime ?? ride.startTime ?? 0;
    for (const edge of new Set(match.edgeIds)) {
      const info = out.get(edge);
      if (info) {
        info.count++;
        if (when > info.lastRidden) info.lastRidden = when;
      } else {
        out.set(edge, { count: 1, lastRidden: when });
      }
    }
  }
  return out;
}
