// Reading a .zip of rides (the Komoot download folder zipped, docs/rides.md): a streaming unzip, so a
// zip of a whole history never sits in memory unpacked. The file is read in 1 MB slices and fed to
// fflate's `Unzip`; every finished entry is handed over as it completes. No DOM, runs in the ride worker
// and under `bun test`.
import { Unzip, UnzipInflate } from "fflate";

const SLICE = 1024 * 1024;
/** one unpacked entry may not exceed this (a GPX of a 12 h ride is ~1 MB): bombs and junk are refused */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export type ZipEntry = { path: string; bytes: Uint8Array };
export type ZipProblem = { path: string; reason: string };

/** Whether the file starts like a zip (a local file header, or the end record of an empty one). */
export async function isZip(file: Blob): Promise<boolean> {
  if (file.size < 4) return false;
  const b = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6));
}

/**
 * How many entries the zip lists (from its end-of-central-directory record, which sits in the last
 * 64 kB + 22 bytes); 0 when it cannot be found. Only for progress: the unzip itself does not use it.
 */
export async function countZipEntries(file: Blob): Promise<number> {
  const tail = Math.min(file.size, 65_557);
  const bytes = new Uint8Array(await file.slice(file.size - tail).arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return view.getUint16(i + 10, true);
  }
  return 0;
}

/** The file name of a path inside a zip: after the last slash. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The entries worth importing: a GPX or FIT by extension; folders, macOS resource forks and the rest are skipped. */
export function isRideEntry(path: string): boolean {
  if (path.endsWith("/") || path.startsWith("__MACOSX/") || path.includes("/__MACOSX/")) return false;
  const name = baseName(path);
  if (name.startsWith("._") || name.startsWith(".")) return false;
  return /\.(gpx|fit)$/i.test(name);
}

/**
 * Unpacks a zip one entry at a time, in archive order. Yields every entry that `wanted` accepts as
 * bytes, and the ones that cannot be read (corrupt, too big, encrypted) as problems; entries `wanted`
 * rejects are skipped without being inflated. A zip that is broken as a whole throws, after the entries
 * before the break were yielded.
 */
export async function* unzipEntries(
  file: Blob,
  wanted: (path: string) => boolean = isRideEntry,
): AsyncGenerator<ZipEntry | ZipProblem, void, undefined> {
  const ready: (ZipEntry | ZipProblem)[] = [];
  let failure: Error | null = null;

  const unzip = new Unzip((entry) => {
    const path = entry.name;
    if (!wanted(path)) return; // never started: its bytes are skipped without inflating
    const chunks: Uint8Array[] = [];
    let size = 0;
    entry.ondata = (error, chunk, final) => {
      if (error) {
        ready.push({ path, reason: error.message });
        return;
      }
      size += chunk.length;
      if (size > MAX_ENTRY_BYTES) {
        if (size - chunk.length <= MAX_ENTRY_BYTES) {
          chunks.length = 0;
          ready.push({ path, reason: "too big to be a ride" });
          entry.terminate();
        }
        return;
      }
      chunks.push(chunk);
      if (final) {
        const bytes = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) {
          bytes.set(c, at);
          at += c.length;
        }
        ready.push({ path, bytes });
      }
    };
    try {
      entry.start();
    } catch (error) {
      ready.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  });
  unzip.register(UnzipInflate);

  try {
    for (let at = 0; at < file.size; at += SLICE) {
      const chunk = new Uint8Array(await file.slice(at, at + SLICE).arrayBuffer());
      unzip.push(chunk, at + SLICE >= file.size);
      yield* ready.splice(0);
    }
    if (file.size === 0) unzip.push(new Uint8Array(0), true);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }
  yield* ready.splice(0);
  if (failure) throw failure;
}
