// The ride library's IndexedDB store.
//
//   rides    key id   → RideSummary (small: the list, dedup and the map's fit read only this)
//   points   key id   → ArrayBuffer, the binary form of codec.ts (the source of truth)
//   lines    key id   → ArrayBuffer, the simplified map line (same codec, positions only)
//   hashes   key hash → { hash, rideId }, content hashes of every imported file (index: rideId)
//   matches  key rideId → RideMatch, the map-matching seam (derived, re-computable)
//
// Binary blobs are plain ArrayBuffers (not Blobs: older iOS Safari is unreliable with Blobs in
// IndexedDB). Writes of one ride are one transaction, so a ride is complete or absent.
// Runs in the ride worker; the factory is injectable for tests.

import type { BuiltRide } from "./build";
import { decodePoints, toBuffer } from "./codec";
import type { MatchInput, RideMatch, RidePoints, RideSummary } from "./types";

export const DB_NAME = "kompass-rides";
/** 2: matches became arcs + coverage (version 1 stored edge ids; those are dropped, rides stay). */
const DB_VERSION = 2;
const STORES = ["rides", "points", "lines", "hashes", "matches"] as const;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export class RideStore {
  readonly #db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.#db = db;
    db.onversionchange = () => db.close();
  }

  static open(factory: IDBFactory = indexedDB, name: string = DB_NAME): Promise<RideStore> {
    return new Promise((resolve, reject) => {
      const open = factory.open(name, DB_VERSION);
      open.onupgradeneeded = (event) => {
        const db = open.result;
        if (event.oldVersion < 1) {
          db.createObjectStore("rides", { keyPath: "id" });
          db.createObjectStore("points");
          db.createObjectStore("lines");
          db.createObjectStore("hashes", { keyPath: "hash" }).createIndex("rideId", "rideId");
          db.createObjectStore("matches", { keyPath: "rideId" });
        } else if (event.oldVersion < 2) {
          // matches are derived: the old edge-id format is simply re-derived by the next matching
          open.transaction?.objectStore("matches").clear();
        }
      };
      open.onsuccess = () => resolve(new RideStore(open.result));
      open.onerror = () => reject(open.error ?? new Error("could not open the ride database"));
      open.onblocked = () => reject(new Error("the ride database is blocked by another tab"));
    });
  }

  close() {
    this.#db.close();
  }

  // ---- reading

  /** All summaries (never touches the point blobs). Unordered. */
  async listRides(): Promise<RideSummary[]> {
    const tx = this.#db.transaction("rides", "readonly");
    return request(tx.objectStore("rides").getAll());
  }

  async getRide(id: string): Promise<RideSummary | null> {
    const tx = this.#db.transaction("rides", "readonly");
    return ((await request(tx.objectStore("rides").get(id))) as RideSummary | undefined) ?? null;
  }

  /** The stored binary points of a ride, as they are (for the backup). */
  async getPointBytes(id: string): Promise<Uint8Array | null> {
    const tx = this.#db.transaction("points", "readonly");
    const buffer = (await request(tx.objectStore("points").get(id))) as ArrayBuffer | undefined;
    return buffer ? new Uint8Array(buffer) : null;
  }

  /** The stored points of several rides in one transaction (same order as `ids`; `null` where missing). */
  async getPointBytesMany(ids: readonly string[]): Promise<(Uint8Array | null)[]> {
    const tx = this.#db.transaction("points", "readonly");
    const store = tx.objectStore("points");
    const found = await Promise.all(ids.map((id) => request(store.get(id))));
    return found.map((b) => (b ? new Uint8Array(b as ArrayBuffer) : null));
  }

  /** A ride's decoded points: the seam for map-matching. */
  async getPoints(id: string): Promise<RidePoints | null> {
    const bytes = await this.getPointBytes(id);
    return bytes ? decodePoints(bytes) : null;
  }

  /** Every ride's simplified map line (still encoded). */
  async getLines(): Promise<{ id: string; bytes: Uint8Array }[]> {
    const tx = this.#db.transaction("lines", "readonly");
    const store = tx.objectStore("lines");
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    return keys.map((key, i) => ({ id: String(key), bytes: new Uint8Array(values[i] as ArrayBuffer) }));
  }

  /** The ride a file with this content hash was folded into, if any. */
  async findHash(hash: string): Promise<string | null> {
    const tx = this.#db.transaction("hashes", "readonly");
    const row = (await request(tx.objectStore("hashes").get(hash))) as { rideId: string } | undefined;
    return row?.rideId ?? null;
  }

  // ---- writing

  /**
   * Adds a ride (its summary already carries every hash of the copies folded into it) and removes the
   * rides it replaces, in one transaction. The removed rides' matches go too: they described other points.
   */
  async addRide(built: BuiltRide, replace: readonly string[] = []): Promise<void> {
    const tx = this.#db.transaction([...STORES], "readwrite");
    const done = finished(tx);
    for (const id of replace) {
      for (const name of ["rides", "points", "lines", "matches"] as const) tx.objectStore(name).delete(id);
    }
    const { summary } = built;
    tx.objectStore("rides").put(summary);
    tx.objectStore("points").put(toBuffer(built.points), summary.id);
    tx.objectStore("lines").put(toBuffer(built.line), summary.id);
    const hashes = tx.objectStore("hashes");
    for (const hash of summary.hashes) hashes.put({ hash, rideId: summary.id });
    await done;
  }

  /** Replaces a summary (a duplicate was folded in: more names and hashes) and indexes its hashes. */
  async updateSummary(summary: RideSummary): Promise<void> {
    const tx = this.#db.transaction(["rides", "hashes"], "readwrite");
    const done = finished(tx);
    tx.objectStore("rides").put(summary);
    const hashes = tx.objectStore("hashes");
    for (const hash of summary.hashes) hashes.put({ hash, rideId: summary.id });
    await done;
  }

  /** Remembers a file's hash as "already seen, folded into `rideId`". */
  async addHash(hash: string, rideId: string): Promise<void> {
    const tx = this.#db.transaction("hashes", "readwrite");
    const done = finished(tx);
    tx.objectStore("hashes").put({ hash, rideId });
    await done;
  }

  async deleteRides(ids: readonly string[]): Promise<void> {
    const tx = this.#db.transaction([...STORES], "readwrite");
    const done = finished(tx);
    const hashes = tx.objectStore("hashes").index("rideId");
    for (const id of ids) {
      for (const name of ["rides", "points", "lines", "matches"] as const) tx.objectStore(name).delete(id);
      const keys = request(hashes.getAllKeys(id));
      void keys.then((found) => {
        for (const key of found) tx.objectStore("hashes").delete(key);
      });
    }
    await done;
  }

  async deleteAll(): Promise<void> {
    const tx = this.#db.transaction([...STORES], "readwrite");
    const done = finished(tx);
    for (const name of STORES) tx.objectStore(name).clear();
    await done;
  }

  // ---- the map-matching seam (docs/rides.md)

  /** Saves what map-matching found for a ride (replaces an earlier match). */
  async saveMatch(rideId: string, input: MatchInput): Promise<void> {
    if (input.coverage.length !== input.arcs.length) throw new Error("coverage must have one entry per arc");
    if (input.firstPoint && input.firstPoint.length !== input.arcs.length) {
      throw new Error("firstPoint must have one entry per arc");
    }
    const match: RideMatch = {
      rideId,
      graphBuild: input.graphBuild,
      arcs: input.arcs,
      coverage: input.coverage,
      ...(input.firstPoint ? { firstPoint: input.firstPoint } : {}),
      ...(input.trackM !== undefined ? { trackM: input.trackM } : {}),
      ...(input.matchedM !== undefined ? { matchedM: input.matchedM } : {}),
      matchedAt: Date.now(),
    };
    const tx = this.#db.transaction(["rides", "matches"], "readwrite");
    const done = finished(tx);
    // a match for a ride that is not there would be orphaned
    const exists = (await request(tx.objectStore("rides").count(rideId))) > 0;
    if (!exists) {
      tx.abort();
      await done.catch(() => undefined);
      throw new Error(`no ride ${rideId}`);
    }
    tx.objectStore("matches").put(match);
    await done;
  }

  async getMatches(): Promise<RideMatch[]> {
    const tx = this.#db.transaction("matches", "readonly");
    const all = (await request(tx.objectStore("matches").getAll())) as Partial<RideMatch>[];
    // anything not in the current shape is stale (it is re-derived by matching again)
    return all.filter(
      (m): m is RideMatch => m.arcs instanceof Uint32Array && m.coverage instanceof Uint8Array,
    );
  }

  /** Forgets every match (rides stay): the graph changed, or matching is to be redone. */
  async clearMatches(): Promise<void> {
    const tx = this.#db.transaction("matches", "readwrite");
    const done = finished(tx);
    tx.objectStore("matches").clear();
    await done;
  }
}
