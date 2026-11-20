// The ride library's data types. Pure data: no IndexedDB, no DOM, so every module here runs in the
// ride worker, in the main thread and under `bun test`.

/** `[west, south, east, north]`, degrees. */
export type Bounds = [number, number, number, number];

/**
 * A ride's points as typed arrays (struct of arrays). Latitude and longitude are degrees; `time` is ms
 * since the epoch and `ele` metres, each `null` when the track has none.
 */
export type RidePoints = {
  count: number;
  lat: Float64Array;
  lon: Float64Array;
  time: Float64Array | null;
  ele: Float64Array | null;
};

/** What a parser hands over: raw, uncleaned; a missing time or elevation is `NaN`. */
export type RawTrack = {
  lat: number[];
  lon: number[];
  time: number[];
  ele: number[];
  name: string | null;
  sport: string | null;
};

/** The small record the list, the dedup and the map need: loaded without touching the point blobs. */
export type RideSummary = {
  id: string;
  name: string | null;
  /** the activity as the source names it (`cycling`, a Komoot sport id, …) */
  sport: string | null;
  /** ms since the epoch; `null` for a track without timestamps (never deduplicated, no "last ridden") */
  startTime: number | null;
  endTime: number | null;
  distanceM: number;
  pointCount: number;
  hasTime: boolean;
  hasElevation: boolean;
  bounds: Bounds;
  /** the file the kept copy came from */
  source: string;
  /** file names of duplicates folded into this ride */
  alsoSeenAs: string[];
  /** SHA-256 (hex) of every source file folded into this ride: a re-import of one is a no-op */
  hashes: string[];
  /** points that were dropped on import ("12 points at (0, 0)") */
  notes: string[];
  importedAt: number;
  /** bytes this ride occupies in the store (points + map line) */
  bytes: number;
};

export type FileOutcome =
  | { status: "imported"; ride: RideSummary; replaced: number }
  | { status: "duplicate"; keptId: string; keptSource: string }
  | { status: "known" }
  | { status: "failed"; reason: string };

export type FileResult = { file: string; outcome: FileOutcome };

export type ImportSummary = {
  imported: number;
  replaced: number;
  duplicates: number;
  known: number;
  failed: number;
  withoutTime: number;
};

/** A ride map-matched onto the graph: the seam for map-matching (docs/rides.md, docs/matching.md). */
export type RideMatch = {
  rideId: string;
  /** the graph build the arcs belong to; a match of another build is stale */
  graphBuild: string;
  /** the arcs the ride rode (`edge << 1 | reverse`), in riding order (repeats allowed) */
  arcs: Uint32Array;
  /** per arc: the covered share of the edge × 255 (same length) */
  coverage: Uint8Array;
  /** per arc: the first track point on it (optional, same length) */
  firstPoint?: Uint32Array;
  /** track and matched length in metres (optional: the matched share) */
  trackM?: number;
  matchedM?: number;
  matchedAt: number;
};

export type MatchInput = {
  graphBuild: string;
  arcs: Uint32Array;
  coverage: Uint8Array;
  firstPoint?: Uint32Array;
  trackM?: number;
  matchedM?: number;
};
