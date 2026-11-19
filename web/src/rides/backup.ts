// The backup file: every ride in one file, to move the library to another device. Format and
// reasoning in docs/rides.md. All numbers little-endian.
//
//   "KMPSRIDE" (8 bytes) · u32 format version (1) · u32 header length · header JSON (UTF-8)
//   records, each:  u32 summary length (> 0) · u32 points length · summary JSON · points bytes (codec.ts)
//   trailer:        u32 0 · u32 0 · u32 ride count · u32 CRC-32 of every byte before the CRC
//
// Writing builds the file as a chain of Blobs (the browser keeps big ones off the JS heap); reading
// streams it twice (verify the CRC, then import), so memory stays at about one ride, not the file.
import type { RideLibrary } from "./library";
import type { FileOutcome, RideSummary } from "./types";

export const BACKUP_MAGIC = "KMPSRIDE";
export const BACKUP_VERSION = 1;
/** ~8 MB: how much is gathered before it is handed to a Blob */
const CHUNK_BYTES = 8 * 1024 * 1024;
/** rides read from the store per transaction (~1 MB) */
const READ_BATCH = 50;
const MAX_SUMMARY_BYTES = 1 << 20;
const MAX_POINTS_BYTES = 1 << 28;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (the zip/PNG one), incremental: start with 0 and feed the result back in. */
export function crc32(bytes: Uint8Array, previous = 0): number {
  let c = ~previous >>> 0;
  for (let i = 0; i < bytes.length; i++)
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return ~c >>> 0;
}

function u32(a: number, b?: number, c?: number, d?: number): Uint8Array {
  const values = [a, b, c, d].filter((v): v is number => v !== undefined);
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (const [i, v] of values.entries()) view.setUint32(i * 4, v, true);
  return out;
}

export type BackupProgress = { done: number; total: number };

/** Builds the backup of every ride in the library. */
export async function exportBackup(
  library: RideLibrary,
  onProgress?: (p: BackupProgress) => void,
): Promise<Blob> {
  const rides = library.listRides().reverse(); // oldest first: a stable, readable order
  const encoder = new TextEncoder();
  const blobs: Blob[] = [];
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let crc = 0;

  const push = (bytes: Uint8Array) => {
    crc = crc32(bytes, crc);
    pending.push(bytes);
    pendingBytes += bytes.length;
    if (pendingBytes >= CHUNK_BYTES) flush();
  };
  const flush = () => {
    if (pending.length === 0) return;
    blobs.push(new Blob(pending as BlobPart[]));
    pending = [];
    pendingBytes = 0;
  };

  const header = encoder.encode(
    JSON.stringify({
      format: BACKUP_VERSION,
      app: "kompass",
      createdAt: new Date().toISOString(),
      rides: rides.length,
    }),
  );
  push(encoder.encode(BACKUP_MAGIC));
  push(u32(BACKUP_VERSION, header.length));
  push(header);

  let written = 0;
  let seen = 0;
  for (let i = 0; i < rides.length; i += READ_BATCH) {
    const batch = rides.slice(i, i + READ_BATCH);
    const stored = await library.store.getPointBytesMany(batch.map((r) => r.id));
    for (const [k, ride] of batch.entries()) {
      const points = stored[k];
      seen++;
      if (!points) continue; // a summary without points cannot be restored
      const summary = encoder.encode(JSON.stringify(ride));
      push(u32(summary.length, points.length));
      push(summary);
      push(points);
      written++;
    }
    onProgress?.({ done: seen, total: rides.length });
  }
  push(u32(0, 0, written));
  const trailerCrc = u32(crc);
  pending.push(trailerCrc);
  flush();
  return new Blob(blobs, { type: "application/octet-stream" });
}

/** Pulls exact byte counts out of a stream of chunks. */
class StreamReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #chunk: Uint8Array = new Uint8Array(0);
  #pos = 0;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  /** Exactly `n` bytes (a fresh array), or `null` at a clean end; throws on a cut-off. */
  async read(n: number): Promise<Uint8Array | null> {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      if (this.#pos >= this.#chunk.length) {
        const next = await this.#reader.read();
        if (next.done) {
          if (filled === 0) return null;
          throw new Error("the backup file is cut off");
        }
        this.#chunk = next.value;
        this.#pos = 0;
        continue;
      }
      const take = Math.min(n - filled, this.#chunk.length - this.#pos);
      out.set(this.#chunk.subarray(this.#pos, this.#pos + take), filled);
      filled += take;
      this.#pos += take;
    }
    return out;
  }

  release() {
    void this.#reader.cancel().catch(() => undefined);
  }
}

export type BackupInfo = { version: number; createdAt: string; rides: number };

/** Streams the file once and checks magic, version, structure and CRC; returns what the header says. */
export async function verifyBackup(blob: Blob): Promise<BackupInfo> {
  const reader = new StreamReader(blob.stream() as ReadableStream<Uint8Array>);
  try {
    let crc = 0;
    const take = async (n: number) => {
      const bytes = await reader.read(n);
      if (!bytes) throw new Error("the backup file is cut off");
      crc = crc32(bytes, crc);
      return bytes;
    };
    const info = await readHeader(take);
    let count = 0;
    for (;;) {
      const lengths = new DataView((await take(8)).buffer);
      const summaryLen = lengths.getUint32(0, true);
      const pointsLen = lengths.getUint32(4, true);
      if (summaryLen === 0 && pointsLen === 0) break;
      checkLengths(summaryLen, pointsLen);
      await take(summaryLen);
      await take(pointsLen);
      count++;
    }
    const trailer = new DataView((await take(4)).buffer);
    const expectedCount = trailer.getUint32(0, true);
    const expectedCrc = crc;
    const stored = await reader.read(4);
    if (!stored) throw new Error("the backup file is cut off");
    if (new DataView(stored.buffer).getUint32(0, true) !== expectedCrc) {
      throw new Error("the backup file is damaged (checksum mismatch)");
    }
    if (expectedCount !== count) throw new Error("the backup file is damaged (ride count mismatch)");
    return { ...info, rides: count };
  } finally {
    reader.release();
  }
}

function checkLengths(summaryLen: number, pointsLen: number) {
  if (summaryLen === 0 || summaryLen > MAX_SUMMARY_BYTES || pointsLen > MAX_POINTS_BYTES) {
    throw new Error("the backup file is damaged (bad record)");
  }
}

async function readHeader(take: (n: number) => Promise<Uint8Array>): Promise<BackupInfo> {
  const magic = new TextDecoder().decode(await take(BACKUP_MAGIC.length));
  if (magic !== BACKUP_MAGIC) throw new Error("not a Kompass ride backup");
  const view = new DataView((await take(8)).buffer);
  const version = view.getUint32(0, true);
  if (version > BACKUP_VERSION) {
    throw new Error(`this backup was made by a newer Kompass (format ${version}); update the app first`);
  }
  const headerLen = view.getUint32(4, true);
  if (headerLen > MAX_SUMMARY_BYTES) throw new Error("the backup file is damaged (bad header)");
  const header = JSON.parse(new TextDecoder().decode(await take(headerLen))) as {
    createdAt?: string;
    rides?: number;
  };
  return { version, createdAt: String(header.createdAt ?? ""), rides: Number(header.rides ?? 0) };
}

function isSummary(value: unknown): value is RideSummary {
  const v = value as Partial<RideSummary> | null;
  return (
    !!v &&
    typeof v.id === "string" &&
    typeof v.source === "string" &&
    typeof v.pointCount === "number" &&
    typeof v.distanceM === "number" &&
    Array.isArray(v.bounds) &&
    v.bounds.length === 4 &&
    (v.startTime === null || typeof v.startTime === "number") &&
    (v.endTime === null || typeof v.endTime === "number")
  );
}

/** Merges the backup into the library with the dedup rule. Throws (before importing anything) if the file is bad. */
export async function importBackup(
  library: RideLibrary,
  blob: Blob,
  onProgress?: (p: BackupProgress, outcome: FileOutcome) => void,
): Promise<{ total: number; outcomes: FileOutcome[] }> {
  const info = await verifyBackup(blob);
  const reader = new StreamReader(blob.stream() as ReadableStream<Uint8Array>);
  const outcomes: FileOutcome[] = [];
  try {
    const decoder = new TextDecoder();
    const take = async (n: number) => {
      const bytes = await reader.read(n);
      if (!bytes) throw new Error("the backup file is cut off");
      return bytes;
    };
    await readHeader(take);
    for (;;) {
      const lengths = new DataView((await take(8)).buffer);
      const summaryLen = lengths.getUint32(0, true);
      const pointsLen = lengths.getUint32(4, true);
      if (summaryLen === 0 && pointsLen === 0) break;
      const summary = JSON.parse(decoder.decode(await take(summaryLen))) as unknown;
      const points = await take(pointsLen);
      let outcome: FileOutcome;
      if (!isSummary(summary)) {
        outcome = { status: "failed", reason: "a ride record is malformed" };
      } else {
        outcome = await library.importBackedUp(
          {
            ...summary,
            alsoSeenAs: summary.alsoSeenAs ?? [],
            hashes: summary.hashes ?? [],
            notes: summary.notes ?? [],
          },
          points,
        );
      }
      outcomes.push(outcome);
      onProgress?.({ done: outcomes.length, total: info.rides }, outcome);
    }
  } finally {
    reader.release();
  }
  return { total: info.rides, outcomes };
}
