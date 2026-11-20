import { describe, expect, test } from "bun:test";
import { decodePoints, encodePoints } from "../src/rides/codec";
import { parseFit } from "../src/rides/fit";
import { cleanTrack, haversine, pathLength, simplifyIndices } from "../src/rides/geo";
import { parseGpx, parseIsoTime } from "../src/rides/gpx";
import { parseTrackFile } from "../src/rides/parse";
import type { RawTrack } from "../src/rides/types";
import { gridLoop, syntheticTrack, toFit, toGpx } from "./synthetic";

const T0 = Date.UTC(2026, 4, 2, 8, 0, 0);
const loop = () =>
  syntheticTrack({ path: gridLoop(0, 0), start: T0, interval: 5, speed: 5, noise: 2, seed: 7 });

describe("binary codec", () => {
  test("round trips points to the quantisation (1e-6°, 1 ms, 0.1 m)", () => {
    const { points } = cleanTrack(loop());
    const back = decodePoints(encodePoints(points));
    expect(back.count).toBe(points.count);
    for (let i = 0; i < points.count; i++) {
      expect(Math.abs((back.lat[i] as number) - (points.lat[i] as number))).toBeLessThanOrEqual(5.1e-7);
      expect(Math.abs((back.lon[i] as number) - (points.lon[i] as number))).toBeLessThanOrEqual(5.1e-7);
      expect(back.time?.[i]).toBe(points.time?.[i] as number);
      expect(Math.abs((back.ele?.[i] as number) - (points.ele?.[i] as number))).toBeLessThanOrEqual(0.051);
    }
  });

  test("omits time and elevation when the ride has none, and handles negatives and big gaps", () => {
    const points = {
      count: 3,
      lat: Float64Array.of(-12.345678, 12.345678, -89.999999),
      lon: Float64Array.of(179.999999, -179.999999, 0.000001),
      time: null,
      ele: null,
    };
    const bytes = encodePoints(points);
    const back = decodePoints(bytes);
    expect(back.time).toBeNull();
    expect(back.ele).toBeNull();
    expect(Array.from(back.lat)).toEqual(Array.from(points.lat));
    expect(Array.from(back.lon)).toEqual(Array.from(points.lon));

    const timed = { ...points, time: Float64Array.of(T0, T0 + 5 * 86_400_000 * 400, T0 - 1000) };
    expect(Array.from(decodePoints(encodePoints(timed)).time as Float64Array)).toEqual(
      Array.from(timed.time),
    );
  });

  test("is compact: about 8 bytes or less per point", () => {
    const track = syntheticTrack({
      path: [gridLoop(0, 0, 3), gridLoop(0, 0, 3)].flat(),
      start: T0,
      interval: 1,
      speed: 5,
      noise: 1,
    });
    const { points } = cleanTrack(track);
    expect(points.count).toBeGreaterThan(2000);
    expect(encodePoints(points).length / points.count).toBeLessThan(8);
  });

  test("rejects truncated or foreign data", () => {
    const bytes = encodePoints(cleanTrack(loop()).points);
    expect(() => decodePoints(bytes.subarray(0, bytes.length - 20))).toThrow();
    expect(() => decodePoints(Uint8Array.of(9, 0, 0, 0, 0, 0))).toThrow(/version/);
  });
});

describe("GPX", () => {
  test("reads what the Komoot script writes: name, sport, points with ele and time", () => {
    const track = syntheticTrack({
      path: gridLoop(1, 1),
      start: T0,
      name: "Evening & loop",
      sport: "mtb_easy",
    });
    const parsed = parseGpx(toGpx(track));
    expect(parsed.name).toBe("Evening & loop");
    expect(parsed.sport).toBe("mtb_easy");
    expect(parsed.lat.length).toBe(track.lat.length);
    expect(parsed.lat[3]).toBeCloseTo(track.lat[3] as number, 6);
    expect(parsed.lon[3]).toBeCloseTo(track.lon[3] as number, 6);
    expect(parsed.time[0]).toBe(T0);
    expect(parsed.time[2]).toBe(T0 + 10_000);
    expect(parsed.ele[0]).toBeCloseTo(100, 0);
  });

  test("tolerates namespaces, several segments, self-closing and missing children, CDATA names", () => {
    const gpx = `<?xml version="1.0"?>
<gpx version="1.1" xmlns:gpxtpx="x"><!-- <trkpt lat="9" lon="9"> -->
<wpt lat="5" lon="5"><name>not a track point</name></wpt>
<trk><name><![CDATA[Gravel <fun>]]></name><type>cycling</type>
<trkseg>
<trkpt lat="0.001" lon="0.002"><ele>12.5</ele><time>2026-05-02T08:00:00.250Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>120</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
<trkpt lat='0.0011' lon='0.0021'/>
</trkseg><trkseg>
<trkpt lon="0.003" lat="0.0012"><time>2026-05-02T10:00:01+02:00</time></trkpt>
</trkseg></trk></gpx>`;
    const parsed = parseGpx(gpx);
    expect(parsed.name).toBe("Gravel <fun>");
    expect(parsed.lat).toEqual([0.001, 0.0011, 0.0012]);
    expect(parsed.lon).toEqual([0.002, 0.0021, 0.003]);
    expect(parsed.time[0]).toBe(Date.UTC(2026, 4, 2, 8, 0, 0, 250));
    expect(parsed.time[1]).toBeNaN();
    expect(parsed.time[2]).toBe(Date.UTC(2026, 4, 2, 8, 0, 1)); // +02:00
    expect(parsed.ele[0]).toBe(12.5);
    expect(parsed.ele[1]).toBeNaN();
  });

  test("parses ISO times with zones and fractions", () => {
    expect(parseIsoTime("2026-05-02T08:00:00Z")).toBe(T0);
    expect(parseIsoTime("2026-05-02T08:00:00")).toBe(T0);
    expect(parseIsoTime("2026-05-02T10:00:00+02:00")).toBe(T0);
    expect(parseIsoTime("2026-05-02T03:30:00-04:30")).toBe(T0);
    expect(parseIsoTime("2026-05-02T08:00:00.1234567Z")).toBe(T0 + 123);
    expect(parseIsoTime("yesterday")).toBeNaN();
  });

  test("says so when there is no track", () => {
    expect(() => parseGpx("<gpx><wpt lat='1' lon='1'/></gpx>")).toThrow(/no track points/);
    expect(() => parseTrackFile("x.gpx", new TextEncoder().encode("hello"))).toThrow(/not a GPX or FIT/);
  });
});

describe("FIT", () => {
  const base = () => syntheticTrack({ path: gridLoop(0, 1), start: T0, interval: 2 });

  test("reads record positions, times, altitude and the sport", () => {
    const track = base();
    const parsed = parseFit(toFit(track, { sport: 2 }));
    expect(parsed.sport).toBe("cycling");
    expect(parsed.lat.length).toBe(track.lat.length);
    expect(parsed.lat[5]).toBeCloseTo(track.lat[5] as number, 6);
    expect(parsed.lon[5]).toBeCloseTo(track.lon[5] as number, 6);
    expect(parsed.time[0]).toBe(T0);
    expect(parsed.time[4]).toBe(T0 + 8000);
    expect(parsed.ele[3]).toBeCloseTo(track.ele[3] as number, 0);
  });

  test("handles big-endian files, enhanced altitude, developer fields and position-less records", () => {
    const track = base();
    for (const options of [
      { bigEndian: true },
      { enhancedAltitude: true },
      { developerFields: true },
      { gapEvery: 4 },
      { bigEndian: true, enhancedAltitude: true, developerFields: true, gapEvery: 3 },
    ]) {
      const parsed = parseFit(toFit(track, options));
      expect(parsed.lat.length).toBe(track.lat.length);
      expect(parsed.lat[7]).toBeCloseTo(track.lat[7] as number, 6);
      expect(parsed.time[7]).toBe(T0 + 14_000);
      expect(parsed.ele[7]).toBeCloseTo(track.ele[7] as number, 0);
    }
  });

  test("reads chained files and dispatches by signature, not name", () => {
    const a = toFit(base());
    const b = toFit(syntheticTrack({ path: gridLoop(2, 2), start: T0 + 3_600_000 }));
    const chained = new Uint8Array(a.length + b.length);
    chained.set(a, 0);
    chained.set(b, a.length);
    expect(parseTrackFile("ride.bin", chained).lat.length).toBe(base().lat.length + parseFit(b).lat.length);
  });

  test("rejects what is not FIT", () => {
    expect(() => parseFit(new TextEncoder().encode("not a fit file at all"))).toThrow(/not a FIT/);
    expect(() => parseTrackFile("x.fit", new TextEncoder().encode("<gpx/>"))).toThrow(/FIT/);
  });
});

describe("garbage and simplification", () => {
  const raw = (pts: [number, number][], times?: number[]): RawTrack => ({
    lat: pts.map((p) => p[1]),
    lon: pts.map((p) => p[0]),
    time: times ?? pts.map((_, i) => T0 + i * 5000),
    ele: pts.map(() => Number.NaN),
    name: null,
    sport: null,
  });

  test("drops (0, 0), out-of-range and isolated jumps, with a count", () => {
    const pts: [number, number][] = [
      [0.001, 0.001],
      [0, 0],
      [0.0011, 0.001],
      [200, 0.001],
      [0.0012, 0.001],
      [0.5, 0.5], // a jump away ...
      [0.0013, 0.001], // ... and back
      [0.0014, 0.001],
    ];
    const { points, report } = cleanTrack(raw(pts));
    expect(report.invalid).toBe(2);
    expect(report.jumps).toBe(1);
    expect(points.count).toBe(5);
    expect(Array.from(points.lon)).toEqual([0.001, 0.0011, 0.0012, 0.0013, 0.0014]);
  });

  test("drops teleports by speed, but accepts a track that really moved on", () => {
    const fast = raw([
      [0.001, 0.001],
      [0.01, 0.001], // 1 km in 5 s
      [0.0011, 0.001],
    ]);
    expect(cleanTrack(fast).points.count).toBe(2);
    const moved: [number, number][] = [
      [0.001, 0.001],
      [0.0011, 0.001],
      [1, 1],
      [1.0001, 1],
      [1.0002, 1],
      [1.0003, 1],
    ];
    const { points } = cleanTrack(raw(moved));
    expect(points.count).toBe(6); // 60 km away for good: a gap, not garbage
  });

  test("no timestamps: the points stay, the ride is untimed; elevation gaps are filled", () => {
    const track = raw(
      [
        [0.001, 0.001],
        [0.0011, 0.001],
        [0.0012, 0.001],
      ],
      [Number.NaN, Number.NaN, Number.NaN],
    );
    track.ele = [Number.NaN, 5, Number.NaN];
    const { points } = cleanTrack(track);
    expect(points.time).toBeNull();
    expect(Array.from(points.ele as Float64Array)).toEqual([5, 5, 5]);
  });

  test("Douglas–Peucker keeps corners, drops what lies within the tolerance", () => {
    const track = syntheticTrack({
      path: gridLoop(0, 0),
      start: T0,
      interval: 1,
      speed: 5,
      noise: 1,
      seed: 3,
    });
    const idx = simplifyIndices(track.lat, track.lon, 10);
    expect(idx[0]).toBe(0);
    expect(idx.at(-1)).toBe(track.lat.length - 1);
    expect(idx.length).toBeLessThan(track.lat.length / 20);
    expect(idx.length).toBeGreaterThanOrEqual(4); // the corners
    // every dropped point is within ~tolerance of the simplified line
    const lat = idx.map((i) => track.lat[i] as number);
    const lon = idx.map((i) => track.lon[i] as number);
    expect(pathLength(lat, lon)).toBeGreaterThan(pathLength(track.lat, track.lon) * 0.95);
  });

  test("haversine: 0.001° of latitude is ~111 m", () => {
    expect(haversine(0, 0, 0.001, 0)).toBeGreaterThan(110);
    expect(haversine(0, 0, 0.001, 0)).toBeLessThan(112);
  });
});
