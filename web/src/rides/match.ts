// Folding saved matches into the explored map's input (docs/rides.md "the matching seam"), with the
// explored rule of docs/matching.md (the engine's `Explored::fold`): a ride rode an arc when its pieces
// on that arc cover at least half of the edge, summed; an edge is ridden when either arc is.
import type { RideInfo } from "@/history/explored-store";
import type { RideMatch, RideSummary } from "./types";

/** The coverage byte (share × 255) from which an arc counts as ridden: 50 %. */
export const MIN_COVERAGE = 128;

/** The edges a ride rode under the 50 % rule (either direction), unique. */
export function riddenEdges(arcs: Uint32Array, coverage: Uint8Array): Set<number> {
  const sum = new Map<number, number>();
  for (let i = 0; i < arcs.length; i++) {
    const arc = arcs[i] as number;
    sum.set(arc, (sum.get(arc) ?? 0) + (coverage[i] ?? 0));
  }
  const edges = new Set<number>();
  for (const [arc, c] of sum) if (c >= MIN_COVERAGE) edges.add(arc >>> 1);
  return edges;
}

/**
 * Per edge id: in how many rides it was ridden and when last (the ride's end, 0 = unknown, i.e. only
 * untimed rides). Only matches of `graphBuild` count: edge ids of another build mean other edges.
 * An edge a ride passes several times, or in both directions, counts once for that ride.
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
    for (const edge of riddenEdges(match.arcs, match.coverage)) {
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
