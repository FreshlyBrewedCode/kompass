// The dedup rule (docs/rides.md): two rides are the same ride when their time spans overlap by at
// least 80 % of the shorter one. Pure functions, no storage: the importer applies them to the
// summaries it has.

/** Overlap, as a share of the shorter span, from which two rides count as the same ride. */
export const SAME_RIDE_OVERLAP = 0.8;

export type Span = { start: number; end: number };

/** How much of the shorter span is covered by the other, 0..1. A zero-length span counts as covered (1) if it lies inside the other. */
export function overlapRatio(a: Span, b: Span): number {
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  if (overlap < 0) return 0;
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  if (shorter <= 0) return 1; // a single instant, inside the other span
  return Math.min(1, overlap / shorter);
}

export function isSameRide(a: Span, b: Span, threshold: number = SAME_RIDE_OVERLAP): boolean {
  return overlapRatio(a, b) >= threshold;
}

export type Candidate = { pointCount: number; startTime: number | null; endTime: number | null };

/** Points per second of riding; the tie-breaker "denser sampling". */
export function density(c: Candidate): number {
  const seconds = c.startTime !== null && c.endTime !== null ? (c.endTime - c.startTime) / 1000 : 0;
  return c.pointCount / Math.max(1, seconds);
}

/**
 * Which copy to keep: the one with more points, then the denser sampled one; on a tie the first
 * (pass the stored ride first, so a re-import never swaps the copy).
 */
export function pickKeeper<T extends Candidate>(first: T, second: T): T {
  if (second.pointCount !== first.pointCount) return second.pointCount > first.pointCount ? second : first;
  return density(second) > density(first) ? second : first;
}

/** The stored rides that incoming `span` is the same ride as (timed rides only). */
export function findSameRides<T extends { startTime: number | null; endTime: number | null }>(
  stored: readonly T[],
  span: Span,
  threshold: number = SAME_RIDE_OVERLAP,
): T[] {
  const out: T[] = [];
  for (const ride of stored) {
    if (ride.startTime === null || ride.endTime === null) continue;
    if (isSameRide({ start: ride.startTime, end: ride.endTime }, span, threshold)) out.push(ride);
  }
  return out;
}
