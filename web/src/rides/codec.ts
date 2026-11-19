// The compact binary form of a ride's points (what IndexedDB stores, and the backup carries).
//
//   u8 version (1) · u8 flags (bit 0 time, bit 1 elevation) · u32 count (LE) · f64 first time (ms, LE; only with time)
//   then one section per channel, each `u32 byte length` + zigzag-varint deltas of the previous value:
//     latitude and longitude in 1e-6° (about 11 cm), time in ms, elevation in 0.1 m
//
// A 3000-point ride with times and elevation comes to roughly 15 to 20 kB (against ~100 kB as JSON).
// Quantising to 1e-6° and 0.1 m is lossless for this purpose: GPS noise is far bigger.
import type { RidePoints } from "./types";

const VERSION = 1;
const HAS_TIME = 1;
const HAS_ELE = 2;
const LAT_LON_SCALE = 1e6;
const ELE_SCALE = 10;

/** Growable byte buffer for varints. */
class ByteSink {
  bytes = new Uint8Array(1024);
  length = 0;

  #ensure(extra: number) {
    if (this.length + extra <= this.bytes.length) return;
    const next = new Uint8Array(Math.max(this.bytes.length * 2, this.length + extra));
    next.set(this.bytes);
    this.bytes = next;
  }

  /** zigzag + LEB128 varint of an integer (|n| < 2^52) */
  signed(n: number) {
    this.#ensure(10);
    let z = n >= 0 ? n * 2 : -n * 2 - 1;
    if (z <= 0x7fffffff) {
      let v = z | 0;
      while (v > 0x7f) {
        this.bytes[this.length++] = (v & 0x7f) | 0x80;
        v >>>= 7;
      }
      this.bytes[this.length++] = v;
      return;
    }
    while (z >= 0x80) {
      this.bytes[this.length++] = (z % 128) | 0x80;
      z = Math.floor(z / 128);
    }
    this.bytes[this.length++] = z;
  }

  result(): Uint8Array {
    return this.bytes.subarray(0, this.length);
  }
}

/** Reads varints from a byte range. */
class ByteSource {
  pos: number;
  constructor(
    readonly bytes: Uint8Array,
    start: number,
    readonly end: number,
  ) {
    this.pos = start;
  }

  signed(): number {
    let z = 0;
    let scale = 1;
    for (;;) {
      if (this.pos >= this.end) throw new Error("ride data is truncated");
      const b = this.bytes[this.pos++] as number;
      z += (b & 0x7f) * scale;
      if (b < 0x80) break;
      scale *= 128;
    }
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }
}

function writeChannel(out: ByteSink[], values: ArrayLike<number>, scale: number) {
  const sink = new ByteSink();
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    const q = Math.round((values[i] as number) * scale);
    sink.signed(q - prev);
    prev = q;
  }
  out.push(sink);
}

/** Encodes `points` (see the layout above). Time and elevation are written only when present. */
export function encodePoints(points: RidePoints): Uint8Array {
  const channels: ByteSink[] = [];
  writeChannel(channels, points.lat, LAT_LON_SCALE);
  writeChannel(channels, points.lon, LAT_LON_SCALE);
  const time = points.time;
  if (time) writeChannel(channels, time, 1);
  const ele = points.ele;
  if (ele) writeChannel(channels, ele, ELE_SCALE);

  const headerSize = 6 + (time ? 8 : 0);
  let total = headerSize;
  for (const c of channels) total += 4 + c.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint8(0, VERSION);
  view.setUint8(1, (time ? HAS_TIME : 0) | (ele ? HAS_ELE : 0));
  view.setUint32(2, points.count, true);
  let pos = 6;
  if (time) {
    view.setFloat64(pos, points.count > 0 ? (time[0] as number) : 0, true);
    pos += 8;
  }
  for (const c of channels) {
    view.setUint32(pos, c.length, true);
    out.set(c.result(), pos + 4);
    pos += 4 + c.length;
  }
  return out;
}

function readChannel(
  bytes: Uint8Array,
  view: DataView,
  pos: number,
  count: number,
  scale: number,
): [Float64Array, number] {
  const length = view.getUint32(pos, true);
  const start = pos + 4;
  if (start + length > bytes.length) throw new Error("ride data is truncated");
  const source = new ByteSource(bytes, start, start + length);
  const out = new Float64Array(count);
  let acc = 0;
  for (let i = 0; i < count; i++) {
    acc += source.signed();
    out[i] = acc / scale;
  }
  return [out, start + length];
}

/** The inverse of `encodePoints`; throws on data that is not a ride. */
export function decodePoints(bytes: Uint8Array): RidePoints {
  if (bytes.length < 6) throw new Error("ride data is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== VERSION) throw new Error(`unknown ride data version ${view.getUint8(0)}`);
  const flags = view.getUint8(1);
  const count = view.getUint32(2, true);
  let pos = 6;
  if (flags & HAS_TIME) pos += 8;
  const [lat, afterLat] = readChannel(bytes, view, pos, count, LAT_LON_SCALE);
  const [lon, afterLon] = readChannel(bytes, view, afterLat, count, LAT_LON_SCALE);
  pos = afterLon;
  let time: Float64Array | null = null;
  let ele: Float64Array | null = null;
  if (flags & HAS_TIME) [time, pos] = readChannel(bytes, view, pos, count, 1);
  if (flags & HAS_ELE) [ele, pos] = readChannel(bytes, view, pos, count, ELE_SCALE);
  return { count, lat, lon, time, ele };
}

/** A copy of the bytes as a standalone `ArrayBuffer` (what IndexedDB stores). */
export function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
