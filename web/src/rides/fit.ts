// A minimal FIT decoder for rides: the `record` messages (position, altitude, timestamp) and the
// `session` message's sport. FIT is Garmin's binary activity format: a header, then definition
// messages (which describe the fields of the following data messages) and the data messages
// themselves, optionally chained in one file. Everything else (laps, events, developer data, device
// info, …) is skipped by size. Checksums are not verified: a file that was cut short still yields its
// points. Written against the public FIT protocol description; no real recording is needed to test it
// (web/test/synthetic.ts has a tiny encoder).
import type { RawTrack } from "./types";

/** 1989-12-31T00:00:00Z in ms since the Unix epoch: FIT timestamps count seconds from there. */
const FIT_EPOCH_MS = 631_065_600_000;

const MSG_SESSION = 18;
const MSG_RECORD = 20;

const SPORTS: Record<number, string> = {
  1: "running",
  2: "cycling",
  4: "fitness_equipment",
  5: "swimming",
  11: "walking",
  17: "hiking",
  19: "paddling",
  21: "e_biking",
};

/** semicircles → degrees */
const SEMICIRCLE = 180 / 2 ** 31;

type FieldDef = { num: number; size: number; baseType: number };
type Definition = { little: boolean; global: number; fields: FieldDef[]; devSize: number; size: number };

/** Does this look like a FIT file (the ".FIT" signature at byte 8)? */
export function isFit(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 && bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54
  );
}

export function parseFit(bytes: Uint8Array): RawTrack {
  if (!isFit(bytes)) throw new Error("not a FIT file (no .FIT signature)");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const track: RawTrack = { lat: [], lon: [], time: [], ele: [], name: null, sport: null };

  let offset = 0;
  // chained files: header + data + CRC, repeated
  while (offset + 12 <= bytes.length && isFit(bytes.subarray(offset))) {
    const headerSize = view.getUint8(offset);
    if (headerSize < 12) throw new Error("corrupt FIT header");
    const dataSize = view.getUint32(offset + 4, true);
    const dataStart = offset + headerSize;
    const dataEnd = Math.min(bytes.length, dataStart + dataSize);
    readMessages(view, dataStart, dataEnd, track);
    offset = dataStart + dataSize + 2;
  }
  if (track.lat.length === 0) throw new Error("no GPS records in this FIT file");
  return track;
}

function readMessages(view: DataView, start: number, end: number, track: RawTrack) {
  const definitions = new Map<number, Definition>();
  let pos = start;
  let lastTimestamp = 0; // FIT seconds, for compressed-timestamp headers

  while (pos < end) {
    const header = view.getUint8(pos++);
    let local: number;
    let compressedOffset = -1;

    if (header & 0x80) {
      // compressed timestamp header: 2 bits local type, 5 bits time offset
      local = (header >> 5) & 0x03;
      compressedOffset = header & 0x1f;
    } else if (header & 0x40) {
      // definition message
      const hasDev = (header & 0x20) !== 0;
      local = header & 0x0f;
      if (pos + 5 > end) return;
      const little = view.getUint8(pos + 1) === 0;
      const global = view.getUint16(pos + 2, little);
      const count = view.getUint8(pos + 4);
      pos += 5;
      const fields: FieldDef[] = [];
      let size = 0;
      for (let i = 0; i < count; i++) {
        if (pos + 3 > end) return;
        const field = {
          num: view.getUint8(pos),
          size: view.getUint8(pos + 1),
          baseType: view.getUint8(pos + 2),
        };
        fields.push(field);
        size += field.size;
        pos += 3;
      }
      let devSize = 0;
      if (hasDev) {
        if (pos >= end) return;
        const devCount = view.getUint8(pos++);
        for (let i = 0; i < devCount; i++) {
          if (pos + 3 > end) return;
          devSize += view.getUint8(pos + 1);
          pos += 3;
        }
      }
      definitions.set(local, { little, global, fields, devSize, size: size + devSize });
      continue;
    } else {
      local = header & 0x0f;
    }

    const def = definitions.get(local);
    if (!def) throw new Error("corrupt FIT file (data message without a definition)");
    if (pos + def.size > end) return;

    if (compressedOffset >= 0) {
      let ts = (lastTimestamp & ~0x1f) + compressedOffset;
      if (compressedOffset < (lastTimestamp & 0x1f)) ts += 0x20;
      lastTimestamp = ts;
    }

    if (def.global === MSG_RECORD || def.global === MSG_SESSION) {
      readData(view, pos, def, compressedOffset >= 0 ? lastTimestamp : null, track, (ts) => {
        lastTimestamp = ts;
      });
    } else {
      // other messages can carry a timestamp too (compressed headers refer to the last one)
      for (const f of def.fields) {
        if (f.num === 253 && f.size === 4) {
          const ts = view.getUint32(fieldPos(def, f, pos), def.little);
          if (ts !== 0xffffffff) lastTimestamp = ts;
        }
      }
    }
    pos += def.size;
  }
}

function fieldPos(def: Definition, field: FieldDef, base: number): number {
  let p = base;
  for (const f of def.fields) {
    if (f === field) return p;
    p += f.size;
  }
  return p;
}

function readData(
  view: DataView,
  base: number,
  def: Definition,
  compressedTs: number | null,
  track: RawTrack,
  setTimestamp: (ts: number) => void,
) {
  let lat = Number.NaN;
  let lon = Number.NaN;
  let ele = Number.NaN;
  let timestamp = compressedTs;
  let sport: number | null = null;
  let p = base;
  for (const f of def.fields) {
    const at = p;
    p += f.size;
    if (def.global === MSG_RECORD) {
      switch (f.num) {
        case 0:
        case 1: {
          if (f.size !== 4) break;
          const v = view.getInt32(at, def.little);
          if (v === 0x7fffffff) break;
          if (f.num === 0) lat = v * SEMICIRCLE;
          else lon = v * SEMICIRCLE;
          break;
        }
        case 2: {
          // altitude: u16, (value / 5) - 500 m; the enhanced field (78) wins
          if (f.size !== 2 || !Number.isNaN(ele)) break;
          const v = view.getUint16(at, def.little);
          if (v !== 0xffff) ele = v / 5 - 500;
          break;
        }
        case 78: {
          if (f.size !== 4) break;
          const v = view.getUint32(at, def.little);
          if (v !== 0xffffffff) ele = v / 5 - 500;
          break;
        }
        case 253: {
          if (f.size !== 4) break;
          const v = view.getUint32(at, def.little);
          if (v !== 0xffffffff) timestamp = v;
          break;
        }
      }
    } else if (f.num === 5 && f.size === 1) {
      const v = view.getUint8(at);
      if (v !== 0xff) sport = v;
    }
  }
  if (timestamp !== null) setTimestamp(timestamp);
  if (def.global === MSG_SESSION) {
    if (sport !== null && track.sport === null) track.sport = SPORTS[sport] ?? `sport ${sport}`;
    return;
  }
  // a record without a position (e.g. indoors, or before the first fix) is not a point
  if (Number.isNaN(lat) || Number.isNaN(lon)) return;
  track.lat.push(lat);
  track.lon.push(lon);
  track.ele.push(ele);
  track.time.push(timestamp === null ? Number.NaN : FIT_EPOCH_MS + timestamp * 1000);
}
