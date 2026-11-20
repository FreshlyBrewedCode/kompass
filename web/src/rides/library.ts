// The ride library: the store plus the rules around it (content hash, dedup, which copy wins) and
// the derived views (the map line, the explored input). Runs in the ride worker; the same class runs
// under `bun test` against fake-indexeddb.
import type { RideInfo } from "@/history/explored-store";
import { type BuiltRide, buildRide, rebuild } from "./build";
import { decodePoints } from "./codec";
import { findSameRides, pickKeeper } from "./dedup";
import { foldMatches } from "./match";
import { parseTrackFile } from "./parse";
import { RideStore } from "./store";
import type { FileOutcome, MatchInput, MatchStatus, RidePoints, RideSummary } from "./types";

/** SHA-256 hex of the bytes; where Web Crypto is missing (insecure contexts) a 64-bit FNV-style fallback. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i] as number;
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `fallback-${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
}

function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

export class RideLibrary {
  readonly store: RideStore;
  readonly #rides: Map<string, RideSummary>;
  /** decoded map lines, filled lazily and kept in step with the store */
  #lines: Map<string, [number, number][]> | null = null;

  private constructor(store: RideStore, rides: RideSummary[]) {
    this.store = store;
    this.#rides = new Map(rides.map((r) => [r.id, r]));
  }

  static async open(factory?: IDBFactory, name?: string): Promise<RideLibrary> {
    const store = await RideStore.open(factory, name);
    return new RideLibrary(store, await store.listRides());
  }

  // ---- reads (the seam, plus the list)

  /** All rides, newest first (untimed ones last, by import time). */
  listRides(): RideSummary[] {
    return [...this.#rides.values()].sort((a, b) => {
      if (a.startTime !== null && b.startTime !== null) return b.startTime - a.startTime;
      if (a.startTime !== null) return -1;
      if (b.startTime !== null) return 1;
      return b.importedAt - a.importedAt;
    });
  }

  getPoints(rideId: string): Promise<RidePoints | null> {
    return this.store.getPoints(rideId);
  }

  // ---- importing

  /** Imports one file: known by content, parsed, deduplicated, stored. Never throws: a failure is the outcome. */
  async importFile(name: string, bytes: Uint8Array, now: number = Date.now()): Promise<FileOutcome> {
    try {
      const hash = await hashBytes(bytes);
      const known = await this.store.findHash(hash);
      if (known !== null) return { status: "known" };
      const built = buildRide(parseTrackFile(name, bytes), name, hash, now);
      return await this.add(built);
    } catch (error) {
      return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Adds a ride from a backup: its summary is kept, the point bytes validated, the map line recomputed. */
  async importBackedUp(summary: RideSummary, pointBytes: Uint8Array): Promise<FileOutcome> {
    try {
      decodePoints(pointBytes); // validates
      if (this.#rides.has(summary.id)) return { status: "known" };
      for (const hash of summary.hashes) {
        if ((await this.store.findHash(hash)) !== null) return { status: "known" };
      }
      return await this.add(rebuild(summary, pointBytes));
    } catch (error) {
      return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Dedup against the stored rides, then store (docs/rides.md: the rule and which copy wins). */
  async add(built: BuiltRide): Promise<FileOutcome> {
    const incoming = built.summary;
    const same =
      incoming.startTime !== null && incoming.endTime !== null
        ? findSameRides(this.listRides(), { start: incoming.startTime, end: incoming.endTime })
        : [];
    if (same.length === 0) {
      await this.store.addRide(built);
      this.#rides.set(incoming.id, incoming);
      this.#setLine(incoming.id, built.line);
      return { status: "imported", ride: incoming, replaced: 0 };
    }

    const stored = same.reduce((best, r) => pickKeeper(best, r));
    const winner = pickKeeper(stored, incoming);
    const group = [...same, incoming];
    const names = unique(group.flatMap((r) => [r.source, ...r.alsoSeenAs])).filter(
      (n) => n !== winner.source,
    );
    const hashes = unique(group.flatMap((r) => r.hashes));
    const notes = winner.notes;

    if (winner === incoming) {
      const summary: RideSummary = { ...incoming, alsoSeenAs: names, hashes, notes };
      const ids = same.map((r) => r.id);
      await this.store.addRide({ ...built, summary }, ids);
      for (const id of ids) {
        this.#rides.delete(id);
        this.#lines?.delete(id);
      }
      this.#rides.set(summary.id, summary);
      this.#setLine(summary.id, built.line);
      return { status: "imported", ride: summary, replaced: ids.length };
    }

    const kept: RideSummary = {
      ...stored,
      alsoSeenAs: names,
      hashes: unique([...stored.hashes, ...incoming.hashes]),
    };
    await this.store.updateSummary(kept);
    this.#rides.set(kept.id, kept);
    return { status: "duplicate", keptId: kept.id, keptSource: kept.source };
  }

  // ---- deleting

  async deleteRides(ids: readonly string[]): Promise<void> {
    await this.store.deleteRides(ids);
    for (const id of ids) {
      this.#rides.delete(id);
      this.#lines?.delete(id);
    }
  }

  async deleteAll(): Promise<void> {
    await this.store.deleteAll();
    this.#rides.clear();
    this.#lines = null;
  }

  // ---- the matching seam

  saveMatch(rideId: string, input: MatchInput): Promise<void> {
    return this.store.saveMatch(rideId, input);
  }

  clearMatches(): Promise<void> {
    return this.store.clearMatches();
  }

  /** The explored map's input: per edge count and last-ridden, from the matches of `graphBuild`. */
  async exploredInput(graphBuild: string): Promise<Map<number, RideInfo>> {
    return foldMatches(this.listRides(), await this.store.getMatches(), graphBuild);
  }

  /** The saved matches of `graphBuild` (rides still stored), arcs left out: which rides are matched and how well. */
  async matchStatus(graphBuild: string): Promise<MatchStatus[]> {
    const out: MatchStatus[] = [];
    for (const m of await this.store.getMatches()) {
      if (m.graphBuild !== graphBuild || !this.#rides.has(m.rideId)) continue;
      out.push({
        rideId: m.rideId,
        trackM: m.trackM ?? null,
        matchedM: m.matchedM ?? null,
        arcs: m.arcs.length,
      });
    }
    return out;
  }

  // ---- the map line

  /** Every ride's simplified line, `[lon, lat]` positions, by ride id. */
  async lines(): Promise<ReadonlyMap<string, [number, number][]>> {
    if (!this.#lines) {
      this.#lines = new Map();
      for (const { id, bytes } of await this.store.getLines()) {
        if (this.#rides.has(id)) this.#setLine(id, bytes);
      }
    }
    return this.#lines;
  }

  #setLine(id: string, bytes: Uint8Array) {
    if (!this.#lines) return;
    const p = decodePoints(bytes);
    this.#lines.set(
      id,
      Array.from(p.lat, (lat, i) => [p.lon[i] as number, lat]),
    );
  }

  close() {
    this.store.close();
  }
}
