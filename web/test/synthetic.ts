// Made-up rides for tests and the e2e: an invented place (the e2e fixture's grid around 0°N 0°E), a
// Komoot-style GPX writer (the format tools/komoot writes) and a tiny FIT encoder. No real tracks.
import type { RawTrack } from "../src/rides/types";

/** The fixture region's grid nodes (docs/map.md): 6 × 6 around 0°N 0°E, ~500 m apart. */
export const GRID_STEP = 0.0045;
export const GRID_ORIGIN = -2.5 * GRID_STEP;
export const node = (i: number, j: number): [number, number] => [
  GRID_ORIGIN + i * GRID_STEP,
  GRID_ORIGIN + j * GRID_STEP,
];

/** Deterministic pseudo-random numbers (mulberry32). */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SyntheticOptions = {
  /** `[lon, lat]` corners the ride follows */
  path: [number, number][];
  /** ms since the epoch of the first point; `null` = no timestamps */
  start: number | null;
  /** seconds between points */
  interval?: number;
  /** metres per second */
  speed?: number;
  /** position noise, metres (deterministic per seed) */
  noise?: number;
  seed?: number;
  elevation?: boolean;
  name?: string;
  sport?: string;
};

const M_PER_DEG = 111_195;

/** A ride along `path`: points every `interval` seconds at `speed`. */
export function syntheticTrack(o: SyntheticOptions): RawTrack {
  const interval = o.interval ?? 5;
  const speed = o.speed ?? 5;
  const noise = o.noise ?? 0;
  const rand = prng(o.seed ?? 1);
  const lat: number[] = [];
  const lon: number[] = [];
  const time: number[] = [];
  const ele: number[] = [];
  const [first] = o.path;
  if (!first) throw new Error("empty path");
  const stride = speed * interval;
  let carry = 0;
  let n = 0;
  const emit = (x: number, y: number) => {
    lon.push(x + ((rand() - 0.5) * 2 * noise) / M_PER_DEG);
    lat.push(y + ((rand() - 0.5) * 2 * noise) / M_PER_DEG);
    time.push(o.start === null ? Number.NaN : o.start + n * interval * 1000);
    ele.push(o.elevation === false ? Number.NaN : 100 + 10 * Math.sin(n / 20));
    n++;
  };
  emit(first[0], first[1]);
  for (let s = 1; s < o.path.length; s++) {
    const [x0, y0] = o.path[s - 1] as [number, number];
    const [x1, y1] = o.path[s] as [number, number];
    const length = Math.hypot((x1 - x0) * M_PER_DEG, (y1 - y0) * M_PER_DEG);
    for (let d = stride - carry; d <= length; d += stride) {
      emit(x0 + ((x1 - x0) * d) / length, y0 + ((y1 - y0) * d) / length);
      carry = length - d;
    }
    if (length < stride - carry) carry += length;
  }
  return { lat, lon, time, ele, name: o.name ?? null, sport: o.sport ?? null };
}

/** A loop on the grid starting at node (i, j): out along a row, down a column, back. */
export function gridLoop(i: number, j: number, size = 2): [number, number][] {
  return [node(i, j), node(i + size, j), node(i + size, j + size), node(i, j + size), node(i, j)];
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** GPX 1.1 in the shape tools/komoot writes: one track, one segment, `<ele>` and `<time>` per point. */
export function toGpx(track: RawTrack): string {
  const first = track.time.find((t) => Number.isFinite(t));
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="kompass-komoot">',
    `<metadata><name>${esc(track.name ?? "Ride")}</name>${first === undefined ? "" : `<time>${iso(first)}</time>`}</metadata>`,
    `<trk><name>${esc(track.name ?? "Ride")}</name>${track.sport ? `<type>${track.sport}</type>` : ""}<trkseg>`,
  ];
  for (let i = 0; i < track.lat.length; i++) {
    const ele = track.ele[i] as number;
    const t = track.time[i] as number;
    lines.push(
      `<trkpt lat="${(track.lat[i] as number).toFixed(7)}" lon="${(track.lon[i] as number).toFixed(7)}">` +
        `${Number.isFinite(ele) ? `<ele>${ele.toFixed(1)}</ele>` : ""}` +
        `${Number.isFinite(t) ? `<time>${iso(t)}</time>` : ""}</trkpt>`,
    );
  }
  lines.push("</trkseg></trk></gpx>");
  return lines.join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- a tiny FIT encoder (the record and session messages the decoder reads)

const FIT_EPOCH_MS = 631_065_600_000;

function fitCrc(bytes: Uint8Array): number {
  const table = [
    0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000,
    0x9c01, 0x8801, 0x4400,
  ];
  let crc = 0;
  for (const byte of bytes) {
    let tmp = table[crc & 0xf] as number;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ (table[byte & 0xf] as number);
    tmp = table[crc & 0xf] as number;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ (table[(byte >> 4) & 0xf] as number);
  }
  return crc;
}

export type FitOptions = {
  bigEndian?: boolean;
  /** FIT sport enum written in a session message (2 = cycling) */
  sport?: number;
  /** write the altitude as the enhanced 32-bit field instead of the 16-bit one */
  enhancedAltitude?: boolean;
  /** a record with no position (indoors) written after every n-th point */
  gapEvery?: number;
  /** developer fields on the definition (must be skipped) */
  developerFields?: boolean;
};

/** A FIT activity file with one record message per point of `track` (needs times). */
export function toFit(track: RawTrack, options: FitOptions = {}): Uint8Array {
  const little = !options.bigEndian;
  const body: number[] = [];
  const push = (...bytes: number[]) => body.push(...bytes);
  const u16 = (v: number) => (little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const u32 = (v: number) => {
    const b = [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    return little ? b : b.reverse();
  };
  const arch = little ? 0 : 1;

  // file_id (global 0), local 0: type (u8)
  push(0x40, 0, arch, ...u16(0), 1, 0, 1, 0x00);
  push(0x00, 4);

  const enhanced = options.enhancedAltitude === true;
  const dev = options.developerFields === true;
  // record (global 20), local 1: timestamp u32, lat s32, lon s32, altitude (u16 or u32), + a developer field
  push(0x40 | (dev ? 0x20 : 0) | 1, 0, arch, ...u16(20), 4);
  push(253, 4, 0x86, 0, 4, 0x85, 1, 4, 0x85, enhanced ? 78 : 2, enhanced ? 4 : 2, enhanced ? 0x86 : 0x84);
  if (dev) push(1, 0, 7, 0); // one developer field: number 0, 7 bytes, developer data index 0
  const semicircles = (deg: number) => Math.round((deg * 2 ** 31) / 180);

  for (let i = 0; i < track.lat.length; i++) {
    const t = track.time[i] as number;
    const ts = Math.round((t - FIT_EPOCH_MS) / 1000);
    const ele = track.ele[i] as number;
    const raw = Number.isFinite(ele) ? Math.round((ele + 500) * 5) : enhanced ? 0xffffffff : 0xffff;
    push(
      1,
      ...u32(ts),
      ...u32(semicircles(track.lat[i] as number) >>> 0),
      ...u32(semicircles(track.lon[i] as number) >>> 0),
    );
    push(...(enhanced ? u32(raw) : u16(raw)));
    if (dev) push(1, 2, 3, 4, 5, 6, 7);
    if (options.gapEvery && (i + 1) % options.gapEvery === 0) {
      // a record without position: lat/lon invalid
      push(1, ...u32(ts), ...u32(0x7fffffff), ...u32(0x7fffffff));
      push(...(enhanced ? u32(0xffffffff) : u16(0xffff)));
      if (dev) push(1, 2, 3, 4, 5, 6, 7);
    }
  }

  if (options.sport !== undefined) {
    // session (global 18), local 2: sport (field 5, u8)
    push(0x42, 0, arch, ...u16(18), 1, 5, 1, 0x00);
    push(0x02, options.sport);
  }

  const header = [
    14,
    0x20,
    ...(little ? [0x3c, 0x08] : [0x08, 0x3c]),
    ...[body.length, body.length >> 8, body.length >> 16, body.length >> 24],
    0x2e,
    0x46,
    0x49,
    0x54,
  ];
  const headerBytes = Uint8Array.from(header);
  const headerCrc = fitCrc(headerBytes);
  const out = new Uint8Array(14 + body.length + 2);
  out.set(headerBytes, 0);
  out[12] = headerCrc & 0xff;
  out[13] = headerCrc >> 8;
  out.set(body, 14);
  const crc = fitCrc(out.subarray(0, 14 + body.length));
  out[14 + body.length] = crc & 0xff;
  out[15 + body.length] = crc >> 8;
  return out;
}
