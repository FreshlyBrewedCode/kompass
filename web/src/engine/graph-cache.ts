// The region graph's files on the device (docs/engine-web.md "Download and cache"). Runs in the
// engine worker. One Cache API cache per graph build (`kompass-graph-v<format>-<buildId>`), one entry
// per file under its URL, holding the raw (decompressed) bytes: a download that stops halfway
// resumes with the files it lacks, a new build downloads into a new cache and the old ones are
// evicted once it is complete. Files are fetched as their gzip siblings when the manifest lists them
// and decompressed here (`DecompressionStream`), so the host needs no compression setup.

import type { DataFile, GraphFiles } from "@/map/manifest";

export const CACHE_PREFIX = "kompass-graph-";

/** The parts of the Cache API used here (fakes in tests). */
export interface CacheLike {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
  delete(url: string): Promise<boolean>;
  keys(): Promise<readonly { url: string }[]>;
}

export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function cacheName(graph: Pick<GraphFiles, "formatVersion" | "buildId">): string {
  return `${CACHE_PREFIX}v${graph.formatVersion}-${graph.buildId}`;
}

/** Every file of a graph: the index, then the graph tiles, then the geometry tiles. */
export function graphFileList(graph: GraphFiles): DataFile[] {
  return [graph.index, ...graph.tiles.map((t) => t.graph), ...graph.tiles.map((t) => t.geometry)];
}

/** What goes over the wire for a file. */
export function wireBytes(file: DataFile): number {
  return file.gzip ?? file.bytes;
}

const isGzip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class GraphFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphFileError";
  }
}

export type GraphStoreOptions = {
  dataUrl: string;
  graph: GraphFiles;
  /** `null`: no Cache API (not a secure context): every start fetches from the network */
  caches: CacheStorageLike | null;
  fetch: FetchLike;
  /** attempts per file before the download fails (it resumes on the next start) */
  attempts?: number;
  /** files fetched at the same time */
  concurrency?: number;
  /** waits between attempts (tests pass a no-op) */
  sleep?: (ms: number) => Promise<void>;
};

export class GraphStore {
  readonly dataUrl: string;
  readonly graph: GraphFiles;
  readonly name: string;
  readonly #caches: CacheStorageLike | null;
  readonly #fetch: FetchLike;
  readonly #attempts: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly concurrency: number;
  #cache: Promise<CacheLike | null> | null = null;

  constructor(options: GraphStoreOptions) {
    this.dataUrl = options.dataUrl;
    this.graph = options.graph;
    this.name = cacheName(options.graph);
    this.#caches = options.caches;
    this.#fetch = options.fetch;
    this.#attempts = options.attempts ?? 3;
    this.concurrency = options.concurrency ?? 6;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get cached(): boolean {
    return this.#caches !== null;
  }

  url(file: DataFile): string {
    return new URL(file.file, this.dataUrl).href;
  }

  #open(): Promise<CacheLike | null> {
    this.#cache ??= this.#caches ? this.#caches.open(this.name) : Promise.resolve(null);
    return this.#cache;
  }

  /** The files of `files` that are not on the device yet (all of them without a cache). */
  async missing(files: readonly DataFile[]): Promise<DataFile[]> {
    const cache = await this.#open();
    if (!cache) return [...files];
    const have = new Set((await cache.keys()).map((r) => r.url));
    return files.filter((f) => !have.has(this.url(f)));
  }

  /** Fetches one file from the network (its gzip sibling if listed), checks its size, returns the raw bytes. */
  async fetchFile(file: DataFile): Promise<Uint8Array> {
    const url = this.url(file) + (file.gzip !== undefined ? ".gz" : "");
    let last: unknown;
    for (let attempt = 1; attempt <= this.#attempts; attempt++) {
      try {
        // our own cache is the cache: skip the HTTP one (a rebuilt region keeps its file names)
        const response = await this.#fetch(url, { cache: "no-store" });
        if (!response.ok) throw new GraphFileError(`${file.file}: HTTP ${response.status}`);
        let bytes: Uint8Array = new Uint8Array(await response.arrayBuffer());
        // a host that sets Content-Encoding: gzip has the browser decompress it already
        if (isGzip(bytes)) bytes = await gunzip(bytes);
        if (bytes.byteLength !== file.bytes) {
          throw new GraphFileError(
            `${file.file}: ${bytes.byteLength} bytes, the manifest says ${file.bytes}`,
          );
        }
        return bytes;
      } catch (error) {
        last = error;
        if (attempt < this.#attempts) await this.#sleep(300 * 2 ** (attempt - 1));
      }
    }
    throw last instanceof Error ? last : new GraphFileError(String(last));
  }

  /**
   * Downloads `files` into the cache, `concurrency` at a time. `onFile` is called after each with
   * its wire bytes. A failure stops it (what was stored stays: the next start resumes).
   */
  async download(files: readonly DataFile[], onFile: (file: DataFile) => void): Promise<void> {
    const cache = await this.#open();
    if (!cache) throw new GraphFileError("no cache to download into");
    await this.forEach(files, async (file) => {
      const bytes = await this.fetchFile(file);
      await cache.put(
        this.url(file),
        new Response(bytes as BodyInit, {
          headers: { "content-type": "application/octet-stream", "content-length": String(bytes.byteLength) },
        }),
      );
      onFile(file);
    });
  }

  /** The raw bytes of a file: from the cache (re-fetched if missing or damaged), else the network. */
  async read(file: DataFile): Promise<Uint8Array> {
    const cache = await this.#open();
    if (cache) {
      const hit = await cache.match(this.url(file));
      if (hit) {
        const bytes = new Uint8Array(await hit.arrayBuffer());
        if (bytes.byteLength === file.bytes) return bytes;
        await cache.delete(this.url(file));
      }
      const bytes = await this.fetchFile(file);
      await cache.put(this.url(file), new Response(bytes as BodyInit));
      return bytes;
    }
    return this.fetchFile(file);
  }

  /** Runs `job` over `items`, `concurrency` at a time; the first failure rejects (the rest stop). */
  async forEach<T>(items: readonly T[], job: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    let failed: unknown = null;
    const lane = async () => {
      while (failed === null && next < items.length) {
        const item = items[next++] as T;
        try {
          await job(item);
        } catch (error) {
          failed ??= error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, items.length) }, lane));
    if (failed !== null) throw failed;
  }

  /** Deletes the caches of other graph builds (after this one is complete). */
  async evictOthers(): Promise<string[]> {
    if (!this.#caches) return [];
    const names = (await this.#caches.keys()).filter((n) => n.startsWith(CACHE_PREFIX) && n !== this.name);
    await Promise.all(names.map((n) => this.#caches?.delete(n)));
    return names;
  }
}
