// Matching the stored rides in the background (docs/rides.md "Matching"): one ride at a time, points from
// the ride store → the engine's `matchRide` → the store's matching seam. Logic only: the ride store and
// the engine are passed in as small interfaces, so the order, resuming, pausing and rematching are tested
// with fakes. Nothing here touches the UI thread for longer than a message: both stores are workers.
//
//   - Which rides are pending is derived, never remembered: a ride is pending while it has no saved match
//     for the current graph build. A reload therefore resumes where the last run stopped, and a new build
//     (every saved match is "stale") rematches everything, newest ride first.
//   - A ride that is mostly outside the region, or that matches badly, is a result ("outside"), not an error.
//   - A ride the engine fails on is skipped for this session and counted; it is tried again next start.
import type { RideMatchResult } from "@/engine/protocol";
import type { MatchInput, MatchStatus } from "./types";

/** A match that explains less than this share of the track marks the ride as outside the region. */
export const OUTSIDE_SHARE = 0.5;

export type RideMatchInfo = {
  /** the matched share of the track (0..1), `null` when the match did not record the lengths */
  share: number | null;
  /** mostly outside the region, or too little of it matched */
  outside: boolean;
};

export type MatchProgress = {
  phase: "idle" | "running" | "paused";
  /** rides matched in this run */
  done: number;
  /** done + still pending (grows when rides are imported during a run) */
  total: number;
  /** rides the engine failed on in this run */
  failed: number;
};

export const IDLE: MatchProgress = { phase: "idle", done: 0, total: 0, failed: 0 };

export function matchInfo(status: Pick<MatchStatus, "trackM" | "matchedM">): RideMatchInfo {
  const { trackM, matchedM } = status;
  const share = trackM !== null && matchedM !== null && trackM > 0 ? Math.min(1, matchedM / trackM) : null;
  return { share, outside: share !== null && share < OUTSIDE_SHARE };
}

/** The ride store, as the matcher uses it (the ride worker's methods). */
export interface MatchRides {
  /** every ride, newest first */
  list(): Promise<{ id: string }[]>;
  /** the saved matches of this graph build */
  matched(graphBuild: string): Promise<MatchStatus[]>;
  points(id: string): Promise<{ lat: Float64Array; lon: Float64Array } | null>;
  save(id: string, match: MatchInput): Promise<void>;
}

/** The engine, as the matcher uses it. */
export interface MatchEngine {
  matchRide(lat: Float64Array, lon: Float64Array): Promise<RideMatchResult>;
}

export type MatcherOptions = {
  rides: MatchRides;
  engine: MatchEngine;
  /** after every ride (and when the run starts and ends) */
  onProgress: (progress: MatchProgress) => void;
  /** the per-ride results changed (a ride finished, or the set was reloaded) */
  onMatches: (matches: ReadonlyMap<string, RideMatchInfo>) => void;
  /** matches were saved and the explored map should follow: at most every `batchMs` during a run, and once when it ends */
  onBatch: () => void;
  /** how often `onBatch` may fire during a run (default 2 s) */
  batchMs?: number;
  now?: () => number;
};

export class RideMatcher {
  readonly #o: MatcherOptions;
  #build: string | null = null;
  #token = 0;
  #paused = false;
  /** the token of the run that is the current one, `null` when none is */
  #active: number | null = null;
  /** rides changed while a run was going: it looks at the list once more before it ends */
  #again = false;
  readonly #runs = new Set<Promise<void>>();
  #infos = new Map<string, RideMatchInfo>();
  #lastBatch = 0;

  constructor(options: MatcherOptions) {
    this.#o = options;
  }

  /** The graph build the engine has loaded. A different build discards what was matched and matches again. */
  setBuild(build: string | null) {
    if (build === this.#build) return;
    this.#build = build;
    this.#token++; // the run of the old build stops after the ride it is on
    this.#infos = new Map();
    this.#o.onMatches(this.#infos);
    if (build === null) this.#o.onProgress(IDLE);
    else this.kick();
  }

  /** Rides were added or removed (or matching was asked for): runs if nothing runs. */
  kick() {
    if (this.#build === null || this.#paused) return;
    if (this.#active === this.#token) {
      this.#again = true; // the running loop reads the list again before it ends
      return;
    }
    const token = ++this.#token;
    this.#active = token;
    this.#again = false;
    const run: Promise<void> = this.#run(this.#build, token).finally(() => this.#runs.delete(run));
    this.#runs.add(run);
  }

  pause() {
    if (this.#paused) return;
    this.#paused = true;
    this.#token++; // the running loop stops after the ride it is on
    this.#o.onProgress({ ...IDLE, phase: "paused" });
  }

  resume() {
    if (!this.#paused) return;
    this.#paused = false;
    this.#o.onProgress(IDLE);
    this.kick();
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** Resolves when the current run (and any started meanwhile) has ended. */
  async idle(): Promise<void> {
    while (this.#runs.size > 0) await Promise.all([...this.#runs]);
  }

  async #run(build: string, token: number) {
    const o = this.#o;
    const now = o.now ?? Date.now;
    const batchMs = o.batchMs ?? 2000;
    const current = () => token === this.#token;
    const skip = new Set<string>();
    let done = 0;
    let failed = 0;
    let saved = false;
    try {
      const status = await o.rides.matched(build);
      if (!current()) return;
      this.#infos = new Map(status.map((s) => [s.rideId, matchInfo(s)]));
      o.onMatches(this.#infos);
      this.#lastBatch = now();

      for (;;) {
        const pending = (await o.rides.list()).filter((r) => !this.#infos.has(r.id) && !skip.has(r.id));
        if (!current()) return;
        const ride = pending[0];
        if (!ride) {
          if (!this.#again) break;
          this.#again = false;
          continue;
        }
        o.onProgress({ phase: "running", done, total: done + pending.length, failed });
        try {
          const points = await o.rides.points(ride.id);
          if (!current()) return;
          if (!points) {
            skip.add(ride.id);
            continue;
          }
          const result = await o.engine.matchRide(points.lat, points.lon);
          // a newer build or a pause arrived while the engine worked: the result is not wanted
          if (!current() || result.graphBuild !== build) return;
          const input: MatchInput = {
            graphBuild: result.graphBuild,
            arcs: result.arcs,
            coverage: result.coverage,
            firstPoint: result.firstPoint,
            trackM: result.trackM,
            matchedM: result.matchedM,
          };
          await o.rides.save(ride.id, input);
          this.#infos = new Map(this.#infos).set(
            ride.id,
            matchInfo({ trackM: result.trackM, matchedM: result.matchedM }),
          );
          o.onMatches(this.#infos);
          done++;
          saved = true;
        } catch (error) {
          skip.add(ride.id);
          // deleted while it was being matched: not a failure
          if (!/no ride/.test(error instanceof Error ? error.message : String(error))) failed++;
        }
        if (now() - this.#lastBatch >= batchMs) {
          this.#lastBatch = now();
          o.onBatch();
        }
      }
    } finally {
      if (current()) {
        this.#active = null;
        o.onProgress({ phase: "idle", done, total: done, failed });
        if (saved) o.onBatch();
      }
    }
  }
}
