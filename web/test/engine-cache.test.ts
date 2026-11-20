import { describe, expect, test } from "bun:test";
import {
  type CacheLike,
  type CacheStorageLike,
  cacheName,
  GraphStore,
  graphFileList,
  wireBytes,
} from "../src/engine/graph-cache";
import type { GraphFiles } from "../src/map/manifest";

const DATA = "https://example.test/app/data/";

/** An in-memory Cache API. */
function fakeCaches(): CacheStorageLike & { stores: Map<string, Map<string, Uint8Array>> } {
  const stores = new Map<string, Map<string, Uint8Array>>();
  const cache = (entries: Map<string, Uint8Array>): CacheLike => ({
    async match(url) {
      const b = entries.get(url);
      return b ? new Response(b as BodyInit) : undefined;
    },
    async put(url, response) {
      entries.set(url, new Uint8Array(await response.arrayBuffer()));
    },
    async delete(url) {
      return entries.delete(url);
    },
    async keys() {
      return [...entries.keys()].map((url) => ({ url }));
    },
  });
  return {
    stores,
    async open(name) {
      let entries = stores.get(name);
      if (!entries) {
        entries = new Map();
        stores.set(name, entries);
      }
      return cache(entries);
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
  };
}

/** Bytes of a given size with a recognisable content (never starting like gzip). */
const content = (name: string, n: number) =>
  Uint8Array.from({ length: n }, (_, i) => (name.length * 7 + i) % 251);

/** A two-tile graph whose files are served raw and as gzip siblings. */
function region(buildId = "b1") {
  const files = new Map<string, Uint8Array>();
  const entry = (file: string, n: number) => {
    const raw = content(file, n);
    const gz = Bun.gzipSync(raw);
    files.set(file, raw);
    files.set(`${file}.gz`, gz);
    return { file, bytes: n, gzip: gz.byteLength };
  };
  const graph: GraphFiles = {
    formatVersion: 2,
    buildId,
    tileZoom: 11,
    nodes: 10,
    edges: 10,
    bytes: 0,
    index: entry("graph/index.kmpg", 64),
    tiles: [0, 1].map((x) => ({
      x,
      y: 0,
      edges: 5,
      graph: entry(`graph/tiles/11-${x}-0.kmpg`, 3000 + x),
      geometry: entry(`graph/geometry/11-${x}-0.kmpg`, 2000 + x),
    })),
  };
  const log: string[] = [];
  const failures = new Map<string, number>();
  const fetch = async (url: string, init?: RequestInit) => {
    const rel = url.slice(DATA.length);
    log.push(rel);
    expect(init?.cache).toBe("no-store");
    const left = failures.get(rel) ?? 0;
    if (left > 0) {
      failures.set(rel, left - 1);
      return new Response("busy", { status: 503 });
    }
    const body = files.get(rel);
    return body ? new Response(body as BodyInit) : new Response("nope", { status: 404 });
  };
  return { graph, files, log, fetch, failures };
}

const noSleep = async () => {};

describe("graph cache", () => {
  test("downloads the gzip siblings once, stores the raw bytes, resumes after a stop", async () => {
    const r = region();
    const caches = fakeCaches();
    const store = new GraphStore({ dataUrl: DATA, graph: r.graph, caches, fetch: r.fetch, sleep: noSleep });
    const all = graphFileList(r.graph);
    expect(all.length).toBe(5);
    expect(await store.missing(all)).toEqual(all);

    // a first visit stops after two files (the tab closes)
    await store.download(all.slice(0, 2), () => {});
    expect(r.log).toEqual(["graph/index.kmpg.gz", "graph/tiles/11-0-0.kmpg.gz"]);
    // the next start fetches only the rest
    const again = new GraphStore({ dataUrl: DATA, graph: r.graph, caches, fetch: r.fetch, sleep: noSleep });
    const missing = await again.missing(all);
    expect(missing.map((f) => f.file)).toEqual(all.slice(2).map((f) => f.file));
    let wire = 0;
    await again.download(missing, (f) => {
      wire += wireBytes(f);
    });
    expect(wire).toBe(missing.reduce((s, f) => s + (f.gzip ?? 0), 0));
    expect(await again.missing(all)).toEqual([]);
    r.log.length = 0;

    // reading comes from the device, decompressed, byte for byte
    for (const f of all) expect(await again.read(f)).toEqual(r.files.get(f.file) as Uint8Array);
    expect(r.log).toEqual([]);
    expect([...caches.stores.keys()]).toEqual([cacheName(r.graph)]);
    expect(cacheName(r.graph)).toBe("kompass-graph-v2-b1");
  });

  test("a damaged cache entry is fetched again; a wrong size is an error after the retries", async () => {
    const r = region();
    const caches = fakeCaches();
    const store = new GraphStore({ dataUrl: DATA, graph: r.graph, caches, fetch: r.fetch, sleep: noSleep });
    const index = r.graph.index;
    await store.download([index], () => {});
    caches.stores.get(store.name)?.set(store.url(index), Uint8Array.of(1, 2, 3));
    r.log.length = 0;
    expect((await store.read(index)).byteLength).toBe(index.bytes);
    expect(r.log).toEqual(["graph/index.kmpg.gz"]);

    const lying = { ...index, bytes: index.bytes + 1 };
    r.log.length = 0;
    await expect(store.fetchFile(lying)).rejects.toThrow(/bytes, the manifest says/);
    expect(r.log.length).toBe(3); // three attempts
  });

  test("retries a flaky file; without a gzip sibling fetches the raw file", async () => {
    const r = region();
    r.failures.set("graph/index.kmpg.gz", 2);
    const store = new GraphStore({
      dataUrl: DATA,
      graph: r.graph,
      caches: fakeCaches(),
      fetch: r.fetch,
      sleep: noSleep,
    });
    expect((await store.fetchFile(r.graph.index)).byteLength).toBe(r.graph.index.bytes);
    expect(r.log).toEqual(["graph/index.kmpg.gz", "graph/index.kmpg.gz", "graph/index.kmpg.gz"]);
    const plain = { file: r.graph.index.file, bytes: r.graph.index.bytes };
    r.log.length = 0;
    await store.fetchFile(plain);
    expect(r.log).toEqual(["graph/index.kmpg"]);
  });

  test("a host that decompresses on the way (Content-Encoding) still works", async () => {
    const r = region();
    const fetch = async (url: string) =>
      new Response(r.files.get(url.slice(DATA.length).replace(/\.gz$/, "")) as BodyInit);
    const store = new GraphStore({ dataUrl: DATA, graph: r.graph, caches: null, fetch, sleep: noSleep });
    expect(await store.fetchFile(r.graph.index)).toEqual(r.files.get(r.graph.index.file) as Uint8Array);
  });

  test("a new build evicts the caches of older builds, never other caches", async () => {
    const caches = fakeCaches();
    await caches.open("kompass-graph-v2-old");
    await caches.open("kompass-app-v1");
    const r = region("new");
    const store = new GraphStore({ dataUrl: DATA, graph: r.graph, caches, fetch: r.fetch, sleep: noSleep });
    await store.download(graphFileList(r.graph), () => {});
    expect(await store.evictOthers()).toEqual(["kompass-graph-v2-old"]);
    expect((await caches.keys()).sort()).toEqual(["kompass-app-v1", "kompass-graph-v2-new"]);
  });

  test("without the Cache API every read goes to the network", async () => {
    const r = region();
    const store = new GraphStore({
      dataUrl: DATA,
      graph: r.graph,
      caches: null,
      fetch: r.fetch,
      sleep: noSleep,
    });
    expect(store.cached).toBe(false);
    expect((await store.missing([r.graph.index])).length).toBe(1);
    await store.read(r.graph.index);
    await store.read(r.graph.index);
    expect(r.log).toEqual(["graph/index.kmpg.gz", "graph/index.kmpg.gz"]);
    await expect(store.download([r.graph.index], () => {})).rejects.toThrow(/no cache/);
  });

  test("forEach runs a few at a time and stops at the first failure", async () => {
    const r = region();
    const store = new GraphStore({
      dataUrl: DATA,
      graph: r.graph,
      caches: null,
      fetch: r.fetch,
      concurrency: 2,
    });
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await store.forEach([1, 2, 3, 4, 5], async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      done.push(n);
    });
    expect(peak).toBe(2);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
    const seen: number[] = [];
    await expect(
      store.forEach([1, 2, 3, 4, 5, 6], async (n) => {
        seen.push(n);
        if (n === 2) throw new Error("two");
      }),
    ).rejects.toThrow("two");
    expect(seen.length).toBeLessThan(6);
  });
});
