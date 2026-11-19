// From a parsed file to what the store keeps: cleaned points, their summary, the encoded point
// blob and the simplified map line.
import { decodePoints, encodePoints } from "./codec";
import { boundsOf, cleanTrack, pathLength, simplifyLine } from "./geo";
import type { RawTrack, RidePoints, RideSummary } from "./types";

export type BuiltRide = {
  summary: RideSummary;
  /** `encodePoints(points)` */
  points: Uint8Array;
  /** `encodePoints(simplified line)` */
  line: Uint8Array;
};

export function describeDropped(invalid: number, jumps: number): string[] {
  const notes: string[] = [];
  if (invalid > 0)
    notes.push(`${invalid} invalid point${invalid === 1 ? "" : "s"} dropped ((0, 0) or out of range)`);
  if (jumps > 0) notes.push(`${jumps} point${jumps === 1 ? "" : "s"} dropped (GPS jumps)`);
  return notes;
}

function random12(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newRideId(): string {
  return random12();
}

/** Summary of already clean points; the caller supplies the source facts. */
export function summarize(
  points: RidePoints,
  facts: {
    id?: string;
    name: string | null;
    sport: string | null;
    source: string;
    hashes: string[];
    notes: string[];
    now: number;
  },
): RideSummary {
  let startTime: number | null = null;
  let endTime: number | null = null;
  if (points.time && points.count > 0) {
    startTime = Number.POSITIVE_INFINITY;
    endTime = Number.NEGATIVE_INFINITY;
    for (const t of points.time) {
      if (t < startTime) startTime = t;
      if (t > endTime) endTime = t;
    }
  }
  return {
    id: facts.id ?? newRideId(),
    name: facts.name,
    sport: facts.sport,
    startTime,
    endTime,
    distanceM: pathLength(points.lat, points.lon),
    pointCount: points.count,
    hasTime: points.time !== null,
    hasElevation: points.ele !== null,
    bounds: boundsOf(points.lat, points.lon),
    source: facts.source,
    alsoSeenAs: [],
    hashes: facts.hashes,
    notes: facts.notes,
    importedAt: facts.now,
    bytes: 0,
  };
}

/** Throws when nothing usable is left after cleaning. */
export function buildRide(raw: RawTrack, source: string, hash: string, now: number): BuiltRide {
  const { points, report } = cleanTrack(raw);
  if (points.count < 2) throw new Error("fewer than two usable points");
  return finish(
    points,
    summarize(points, {
      name: raw.name,
      sport: raw.sport,
      source,
      hashes: [hash],
      notes: describeDropped(report.invalid, report.jumps),
      now,
    }),
  );
}

/** Encodes points and the map line, and records their size in the summary. */
export function finish(points: RidePoints, summary: RideSummary): BuiltRide {
  const encoded = encodePoints(points);
  const line = encodePoints(simplifyLine(points));
  summary.bytes = encoded.length + line.length;
  return { summary, points: encoded, line };
}

/** Builds a ride from stored/backup bytes (the summary is trusted, the line is recomputed). */
export function rebuild(summary: RideSummary, pointBytes: Uint8Array): BuiltRide {
  const points = decodePoints(pointBytes);
  const line = encodePoints(simplifyLine(points));
  const copy = { ...summary, bytes: pointBytes.length + line.length };
  return { summary: copy, points: pointBytes, line };
}
