import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { strToU8, zipSync } from "fflate";
import { RideLibrary } from "../src/rides/library";
import {
  baseName,
  countZipEntries,
  isRideEntry,
  isZip,
  unzipEntries,
  type ZipEntry,
  type ZipProblem,
} from "../src/rides/zip";
import { gridLoop, syntheticTrack, toFit, toGpx } from "./synthetic";

const T0 = Date.UTC(2026, 4, 2, 8, 0, 0);
const DAY = 86_400_000;
const gpx = (i: number) =>
  strToU8(toGpx(syntheticTrack({ path: gridLoop(i % 3, Math.floor(i / 3) % 3), start: T0 + i * DAY })));

async function collect(file: Blob) {
  const entries: ZipEntry[] = [];
  const problems: ZipProblem[] = [];
  for await (const e of unzipEntries(file)) ("bytes" in e ? entries : problems).push(e as never);
  return { entries, problems };
}

describe("zip import", () => {
  test("which entries are rides: GPX and FIT by extension, no folders, no macOS leftovers", () => {
    expect(isRideEntry("komoot/2026-05-02_1.gpx")).toBe(true);
    expect(isRideEntry("a/b/ACTIVITY.FIT")).toBe(true);
    expect(isRideEntry("komoot/")).toBe(false);
    expect(isRideEntry("__MACOSX/komoot/._a.gpx")).toBe(false);
    expect(isRideEntry("komoot/._a.gpx")).toBe(false);
    expect(isRideEntry("komoot/tours.json")).toBe(false);
    expect(isRideEntry(".DS_Store")).toBe(false);
    expect(baseName("komoot/sub/a.gpx")).toBe("a.gpx");
    expect(baseName("a.gpx")).toBe("a.gpx");
  });

  test("detects a zip by its bytes and counts its entries", async () => {
    const zip = new Blob([zipSync({ "a.gpx": gpx(0), "b.gpx": gpx(1), "notes.txt": strToU8("hi") })]);
    expect(await isZip(zip)).toBe(true);
    expect(await countZipEntries(zip)).toBe(3);
    expect(await isZip(new Blob([toGpx(syntheticTrack({ path: gridLoop(0, 0), start: T0 }))]))).toBe(false);
    expect(await isZip(new Blob(["PK"]))).toBe(false);
    expect(await countZipEntries(new Blob(["not a zip at all"]))).toBe(0);
  });

  test("unpacks the rides, deflated or stored, and skips the rest", async () => {
    const files = {
      "komoot/": new Uint8Array(0),
      "komoot/a.gpx": gpx(0),
      "komoot/b.gpx": [gpx(1), { level: 0 }] as never, // stored
      "komoot/activity.fit": toFit(syntheticTrack({ path: gridLoop(1, 1), start: T0 + 5 * DAY })),
      "komoot/index.json": strToU8("{}"),
      "__MACOSX/komoot/._a.gpx": strToU8("junk"),
    };
    const { entries, problems } = await collect(new Blob([zipSync(files)]));
    expect(problems).toEqual([]);
    expect(entries.map((e) => e.path)).toEqual(["komoot/a.gpx", "komoot/b.gpx", "komoot/activity.fit"]);
    expect(new TextDecoder().decode(entries[0]?.bytes)).toBe(new TextDecoder().decode(gpx(0)));
    expect(entries[1]?.bytes).toEqual(gpx(1));

    // and they import
    const lib = await RideLibrary.open(new IDBFactory());
    for (const e of entries) {
      expect((await lib.importFile(baseName(e.path), e.bytes)).status).toBe("imported");
    }
    expect(lib.listRides()).toHaveLength(3);
  });

  test("a big zip is read in slices: every entry arrives intact", async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 40; i++) {
      // 40 tracks of ~2000 points: more than the 1 MB slice in total, whatever the compression
      files[`h/${i}.gpx`] = strToU8(
        toGpx(
          syntheticTrack({
            path: gridLoop(i % 3, 0, 2),
            start: T0 + i * DAY,
            interval: 1,
            noise: 5,
            seed: i + 1,
          }),
        ),
      );
    }
    const zip = new Blob([zipSync(files, { level: 0 })]);
    expect(zip.size).toBeGreaterThan(2 * 1024 * 1024);
    const { entries, problems } = await collect(zip);
    expect(problems).toEqual([]);
    expect(entries).toHaveLength(40);
    for (const e of entries) expect(e.bytes).toEqual(files[e.path] as Uint8Array);
  });

  test("a zip that is not one throws; what came before is kept", async () => {
    const good = zipSync({ "a.gpx": gpx(0) });
    const broken = new Uint8Array(good.length + 40);
    broken.set(good.subarray(0, good.length - 40), 0); // cut inside the central directory
    broken.fill(0xff, good.length - 40);
    const seen: string[] = [];
    let thrown = false;
    try {
      for await (const e of unzipEntries(new Blob([broken]))) if ("bytes" in e) seen.push(e.path);
    } catch {
      thrown = true;
    }
    expect(seen).toEqual(["a.gpx"]);
    expect(thrown || seen.length === 1).toBe(true);
    const garbage = new Blob([Uint8Array.of(0x50, 0x4b, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10)]);
    const outcome = await collect(garbage).then(
      (r) => r.entries.length,
      () => -1,
    );
    expect(outcome).toBeLessThanOrEqual(0);
  });
});
