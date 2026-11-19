import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { exportBackup, importBackup, verifyBackup } from "../src/rides/backup";
import { findSameRides, isSameRide, overlapRatio, pickKeeper } from "../src/rides/dedup";
import { RideLibrary } from "../src/rides/library";
import { foldMatches } from "../src/rides/match";
import { gridLoop, syntheticTrack, toFit, toGpx } from "./synthetic";

const T0 = Date.UTC(2026, 4, 2, 8, 0, 0);
const HOUR = 3_600_000;
const bytes = (text: string) => new TextEncoder().encode(text);
const open = () => RideLibrary.open(new IDBFactory());

describe("dedup rule", () => {
  test("overlap is measured against the shorter ride", () => {
    const long = { start: 0, end: 100 };
    expect(overlapRatio(long, { start: 10, end: 60 })).toBe(1); // inside
    expect(overlapRatio(long, { start: 50, end: 150 })).toBe(0.5);
    expect(overlapRatio(long, { start: 100, end: 200 })).toBe(0);
    expect(overlapRatio(long, { start: 150, end: 200 })).toBe(0);
    expect(overlapRatio({ start: 5, end: 5 }, long)).toBe(1);
  });

  test("80 % of the shorter one is the same ride, less is not", () => {
    const a = { start: 0, end: 100 };
    expect(isSameRide(a, { start: 20, end: 120 })).toBe(true); // 80 of 100
    expect(isSameRide(a, { start: 21, end: 121 })).toBe(false); // 79
    // a short ride inside a long one: 100 % of the shorter
    expect(isSameRide(a, { start: 30, end: 70 })).toBe(true);
  });

  test("keeps the copy with more points, then the denser one, then the stored one", () => {
    const stored = { pointCount: 500, startTime: 0, endTime: 1000_000 };
    expect(pickKeeper(stored, { ...stored, pointCount: 3000 }).pointCount).toBe(3000);
    expect(pickKeeper(stored, { ...stored, pointCount: 10 })).toBe(stored);
    const denser = { pointCount: 500, startTime: 0, endTime: 500_000 };
    expect(pickKeeper(stored, denser)).toBe(denser);
    const same = { ...stored };
    expect(pickKeeper(stored, same)).toBe(stored);
  });

  test("untimed rides never match", () => {
    expect(findSameRides([{ startTime: null, endTime: null }], { start: 0, end: 1 })).toEqual([]);
  });
});

describe("the library", () => {
  const komoot = (start: number, interval = 5) =>
    toGpx(
      syntheticTrack({
        path: gridLoop(0, 0),
        start,
        interval,
        noise: 2,
        seed: 1,
        name: "Komoot ride",
        sport: "mtb_easy",
      }),
    );

  test("imports a ride and lists its summary", async () => {
    const lib = await open();
    const out = await lib.importFile("2026-05-02_1.gpx", bytes(komoot(T0)));
    expect(out.status).toBe("imported");
    const [ride] = lib.listRides();
    expect(ride?.source).toBe("2026-05-02_1.gpx");
    expect(ride?.sport).toBe("mtb_easy");
    expect(ride?.startTime).toBe(T0);
    expect(ride?.distanceM).toBeGreaterThan(3500); // a 2 × 2 grid loop: 4 × ~1 km
    expect(ride?.distanceM).toBeLessThan(4600);
    expect(ride?.bounds[0]).toBeLessThan(ride?.bounds[2] as number);
    const points = await lib.getPoints(ride?.id as string);
    expect(points?.count).toBe(ride?.pointCount as number);
    expect(points?.time?.[0]).toBe(T0);
    expect((await lib.lines()).get(ride?.id as string)?.length).toBeGreaterThanOrEqual(5);
  });

  test("re-importing the same file is a no-op, even under another name", async () => {
    const lib = await open();
    const gpx = bytes(komoot(T0));
    await lib.importFile("a.gpx", gpx);
    expect((await lib.importFile("a.gpx", gpx)).status).toBe("known");
    expect((await lib.importFile("copy of a.gpx", gpx)).status).toBe("known");
    expect(lib.listRides().length).toBe(1);
  });

  test("a denser copy of the same ride replaces the sparse one and remembers its name", async () => {
    const lib = await open();
    await lib.importFile("komoot.gpx", bytes(komoot(T0, 10)));
    const sparse = lib.listRides()[0];
    const garmin = toFit(
      syntheticTrack({ path: gridLoop(0, 0), start: T0 + 30_000, interval: 1, noise: 2, seed: 2 }),
      { sport: 2 },
    );
    const out = await lib.importFile("garmin.fit", garmin);
    expect(out.status).toBe("imported");
    expect(out.status === "imported" && out.replaced).toBe(1);
    const rides = lib.listRides();
    expect(rides.length).toBe(1);
    expect(rides[0]?.source).toBe("garmin.fit");
    expect(rides[0]?.alsoSeenAs).toEqual(["komoot.gpx"]);
    expect(rides[0]?.pointCount).toBeGreaterThan(sparse?.pointCount as number);
    expect(await lib.store.getPoints(sparse?.id as string)).toBeNull();
    // the replaced copy's file is still known
    expect((await lib.importFile("komoot.gpx", bytes(komoot(T0, 10)))).status).toBe("known");
  });

  test("a sparser copy of a stored ride is a duplicate: not stored, its name remembered", async () => {
    const lib = await open();
    await lib.importFile(
      "garmin.fit",
      toFit(syntheticTrack({ path: gridLoop(0, 0), start: T0, interval: 1, seed: 2 })),
    );
    const out = await lib.importFile("komoot.gpx", bytes(komoot(T0 + 20_000, 10)));
    expect(out).toEqual({
      status: "duplicate",
      keptId: lib.listRides()[0]?.id as string,
      keptSource: "garmin.fit",
    });
    expect(lib.listRides().length).toBe(1);
    expect(lib.listRides()[0]?.alsoSeenAs).toEqual(["komoot.gpx"]);
    expect((await lib.importFile("komoot.gpx", bytes(komoot(T0 + 20_000, 10)))).status).toBe("known");
    // another ride on another day is its own ride
    expect((await lib.importFile("next.gpx", bytes(komoot(T0 + 24 * HOUR)))).status).toBe("imported");
    expect(lib.listRides().length).toBe(2);
  });

  test("tracks without timestamps are imported, flagged and never deduplicated", async () => {
    const lib = await open();
    const untimed = toGpx(syntheticTrack({ path: gridLoop(0, 0), start: null }));
    const other = toGpx(syntheticTrack({ path: gridLoop(1, 1), start: null }));
    expect((await lib.importFile("one.gpx", bytes(untimed))).status).toBe("imported");
    expect((await lib.importFile("two.gpx", bytes(other))).status).toBe("imported");
    const rides = lib.listRides();
    expect(rides.length).toBe(2);
    expect(rides.every((r) => !r.hasTime && r.startTime === null)).toBe(true);
  });

  test("garbage points are dropped with a note; hopeless files fail with a reason", async () => {
    const lib = await open();
    const track = syntheticTrack({ path: gridLoop(0, 0), start: T0 });
    track.lat.splice(5, 0, 0);
    track.lon.splice(5, 0, 0);
    track.time.splice(5, 0, T0 + 1);
    track.ele.splice(5, 0, 1);
    const out = await lib.importFile("noisy.gpx", bytes(toGpx(track)));
    expect(out.status === "imported" && out.ride.notes[0]).toMatch(/1 invalid point/);
    expect(await lib.importFile("x.gpx", bytes("<gpx></gpx>"))).toEqual({
      status: "failed",
      reason: expect.stringMatching(/no track points/),
    });
    expect((await lib.importFile("y.fit", bytes("garbage"))).status).toBe("failed");
    expect(lib.listRides().length).toBe(1);
  });

  test("delete removes the ride and forgets its file, so it can be imported again", async () => {
    const lib = await open();
    const gpx = bytes(komoot(T0));
    await lib.importFile("a.gpx", gpx);
    const id = lib.listRides()[0]?.id as string;
    await lib.deleteRides([id]);
    expect(lib.listRides()).toEqual([]);
    expect(await lib.getPoints(id)).toBeNull();
    expect((await lib.lines()).size).toBe(0);
    expect((await lib.importFile("a.gpx", gpx)).status).toBe("imported");
    await lib.deleteAll();
    expect(lib.listRides()).toEqual([]);
  });

  test("the library survives a restart (same database)", async () => {
    const factory = new IDBFactory();
    const lib = await RideLibrary.open(factory);
    await lib.importFile("a.gpx", bytes(komoot(T0)));
    lib.close();
    const again = await RideLibrary.open(factory);
    expect(again.listRides().length).toBe(1);
    expect((await again.lines()).size).toBe(1);
  });
});

describe("backup", () => {
  const ride = (i: number, start: number | null) =>
    bytes(
      toGpx(syntheticTrack({ path: gridLoop(i % 3, i % 2), start, interval: 5, seed: i, name: `Ride ${i}` })),
    );

  async function filled() {
    const lib = await open();
    await lib.importFile("1.gpx", ride(1, T0));
    await lib.importFile("2.gpx", ride(2, T0 + 24 * HOUR));
    await lib.importFile("3.gpx", ride(3, null));
    await lib.importFile(
      "1-fit.fit",
      toFit(syntheticTrack({ path: gridLoop(1, 1), start: T0 + 60_000, interval: 1 })),
    );
    return lib;
  }

  test("exports everything and restores it into a fresh profile, points intact", async () => {
    const lib = await filled();
    const blob = await exportBackup(lib);
    expect((await verifyBackup(blob)).rides).toBe(3);

    const fresh = await open();
    const result = await importBackup(fresh, blob);
    expect(result.outcomes.map((o) => o.status)).toEqual(["imported", "imported", "imported"]);
    const before = lib.listRides();
    const after = fresh.listRides();
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => r.alsoSeenAs)).toEqual(before.map((r) => r.alsoSeenAs));
    for (const r of before) {
      expect(Array.from((await fresh.getPoints(r.id))?.lat ?? [])).toEqual(
        Array.from((await lib.getPoints(r.id))?.lat ?? []),
      );
    }
    expect((await fresh.lines()).size).toBe(3);
    // the original files are still recognised
    expect((await fresh.importFile("2.gpx", ride(2, T0 + 24 * HOUR))).status).toBe("known");
  });

  test("importing the same backup again changes nothing; a different profile's rides merge by the rule", async () => {
    const lib = await filled();
    const blob = await exportBackup(lib);
    expect((await importBackup(lib, blob)).outcomes.every((o) => o.status === "known")).toBe(true);
    expect(lib.listRides().length).toBe(3);

    // a phone that has the same ride 2 from the Garmin (another id, same time) plus its own ride
    const phone = await open();
    await phone.importFile(
      "g2.fit",
      toFit(syntheticTrack({ path: gridLoop(2, 0), start: T0 + 24 * HOUR + 10_000, interval: 1 })),
    );
    await phone.importFile("own.gpx", ride(9, T0 + 48 * HOUR));
    const merged = await importBackup(phone, blob);
    expect(merged.outcomes.map((o) => o.status).sort()).toEqual(["duplicate", "imported", "imported"]);
    expect(phone.listRides().length).toBe(4); // g2 kept for ride 2, own, and ride 1 + 3 from the backup
  });

  test("a damaged or foreign file is refused before anything is imported", async () => {
    const lib = await filled();
    const blob = await exportBackup(lib);
    const raw = new Uint8Array(await blob.arrayBuffer());
    const fresh = await open();
    const flipped = raw.slice();
    const at = Math.floor(raw.length / 2);
    flipped[at] = (flipped[at] as number) ^ 0xff;
    await expect(importBackup(fresh, new Blob([flipped]))).rejects.toThrow(/damaged|cut off|checksum/);
    await expect(importBackup(fresh, new Blob([raw.subarray(0, raw.length - 30)]))).rejects.toThrow();
    await expect(importBackup(fresh, new Blob([bytes("hello there, not a backup")]))).rejects.toThrow(
      /not a Kompass/,
    );
    expect(fresh.listRides().length).toBe(0);
  });

  test("a backup of an empty library is valid", async () => {
    const empty = await open();
    const blob = await exportBackup(empty);
    expect((await verifyBackup(blob)).rides).toBe(0);
    expect((await importBackup(await open(), blob)).outcomes).toEqual([]);
  });
});

describe("the map-matching seam", () => {
  test("saved matches fold into count and last-ridden per edge, with a fake matcher", async () => {
    const lib = await open();
    await lib.importFile("a.gpx", bytes(toGpx(syntheticTrack({ path: gridLoop(0, 0), start: T0 }))));
    await lib.importFile(
      "b.gpx",
      bytes(toGpx(syntheticTrack({ path: gridLoop(1, 1), start: T0 + 24 * HOUR }))),
    );
    await lib.importFile("c.gpx", bytes(toGpx(syntheticTrack({ path: gridLoop(2, 2), start: null }))));
    const [b, a, c] = lib.listRides(); // newest first, the untimed one last

    // the "matcher": walks the ride's points and invents an edge id per ~500 m
    const fakeMatch = async (id: string, build: string) => {
      const pts = await lib.getPoints(id);
      expect(pts).not.toBeNull();
      const edges = Uint32Array.from(
        { length: Math.floor((pts?.count ?? 0) / 20) },
        (_, i) => Math.floor(i / 2) + (id === b?.id ? 1 : 0),
      );
      await lib.saveMatch(id, {
        graphBuild: build,
        edgeIds: edges,
        directions: new Uint8Array(edges.length),
      });
    };
    await fakeMatch(a?.id as string, "build-1");
    await fakeMatch(b?.id as string, "build-1");
    await fakeMatch(c?.id as string, "build-1");

    const explored = await lib.exploredInput("build-1");
    expect(explored.size).toBe(5); // edges 0..4
    // edges 1.. are in a and b (and c): count 3 or 2; edge 0 only in a (and c)
    const e0 = explored.get(0);
    const e1 = explored.get(1);
    expect(e0?.count).toBe(2); // a and c (c is untimed)
    expect(e0?.lastRidden).toBe(a?.endTime as number); // untimed c does not count as "last ridden"
    expect(e1?.count).toBe(3);
    expect(e1?.lastRidden).toBe(b?.endTime as number);

    // matches of another graph build are stale and ignored
    expect((await lib.exploredInput("build-2")).size).toBe(0);
    await fakeMatch(a?.id as string, "build-2");
    expect((await lib.exploredInput("build-2")).size).toBeGreaterThan(0);
    expect((await lib.exploredInput("build-1")).get(0)?.count).toBe(1); // a was re-matched with build 2

    await lib.clearMatches();
    expect((await lib.exploredInput("build-1")).size).toBe(0);
    expect(lib.listRides().length).toBe(3);
  });

  test("deleting a ride deletes its match; a match for a missing ride is refused", async () => {
    const lib = await open();
    await lib.importFile("a.gpx", bytes(toGpx(syntheticTrack({ path: gridLoop(0, 0), start: T0 }))));
    const id = lib.listRides()[0]?.id as string;
    await lib.saveMatch(id, { graphBuild: "x", edgeIds: Uint32Array.of(1, 2, 3) });
    await expect(lib.saveMatch("nope", { graphBuild: "x", edgeIds: Uint32Array.of(1) })).rejects.toThrow(
      /no ride/,
    );
    await expect(
      lib.saveMatch(id, { graphBuild: "x", edgeIds: Uint32Array.of(1, 2), directions: Uint8Array.of(0) }),
    ).rejects.toThrow(/one entry per edge/);
    expect((await lib.exploredInput("x")).size).toBe(3);
    await lib.deleteRides([id]);
    expect((await lib.store.getMatches()).length).toBe(0);
  });

  test("foldMatches counts an edge once per ride and keeps the latest time", () => {
    const rides = [
      { id: "a", startTime: 1000, endTime: 2000 },
      { id: "b", startTime: 5000, endTime: 6000 },
    ];
    const matches = [
      { rideId: "a", graphBuild: "g", edgeIds: Uint32Array.of(1, 1, 2, 1), matchedAt: 0 },
      { rideId: "b", graphBuild: "g", edgeIds: Uint32Array.of(2), matchedAt: 0 },
      { rideId: "gone", graphBuild: "g", edgeIds: Uint32Array.of(9), matchedAt: 0 },
    ];
    const out = foldMatches(rides, matches, "g");
    expect(out.get(1)).toEqual({ count: 1, lastRidden: 2000 });
    expect(out.get(2)).toEqual({ count: 2, lastRidden: 6000 });
    expect(out.has(9)).toBe(false);
  });
});
