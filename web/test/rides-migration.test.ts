import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { DB_NAME, RideStore } from "../src/rides/store";

/** A version-1 database (matches as edge ids), as the ride library wrote it before matching existed. */
function openV1(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore("rides", { keyPath: "id" });
      db.createObjectStore("points");
      db.createObjectStore("lines");
      db.createObjectStore("hashes", { keyPath: "hash" }).createIndex("rideId", "rideId");
      db.createObjectStore("matches", { keyPath: "rideId" });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

function put(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

test("upgrading from version 1 drops the old edge-id matches and keeps the rides", async () => {
  const factory = new IDBFactory();
  const v1 = await openV1(factory);
  await put(v1, "rides", { id: "r1", name: "a ride" });
  await put(v1, "matches", { rideId: "r1", graphBuild: "old", edgeIds: Uint32Array.of(1, 2), matchedAt: 0 });
  v1.close();

  const store = await RideStore.open(factory);
  expect(await store.getMatches()).toEqual([]);
  expect((await store.listRides()).map((r) => r.id)).toEqual(["r1"]);
  // the new format goes in and comes back
  await store.saveMatch("r1", {
    graphBuild: "new",
    arcs: Uint32Array.of(4, 7),
    coverage: Uint8Array.of(255, 200),
  });
  const [match] = await store.getMatches();
  expect(match?.graphBuild).toBe("new");
  expect([...(match?.arcs ?? [])]).toEqual([4, 7]);
  store.close();
});
