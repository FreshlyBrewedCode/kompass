/// <reference lib="webworker" />
// The engine worker: loads kompass-wasm once, downloads and caches the region graph, then answers
// requests (protocol.ts, docs/engine-web.md). Requests run one at a time, in order: the wasm engine is
// one object and a request may wait for files (geometry) halfway through.
import type { DataFile, GraphFiles } from "@/map/manifest";
import type { Catalogue, Preset, RouteError, RouteResult } from "./generated/types";
import { type CacheStorageLike, GraphStore, graphFileList, wireBytes } from "./graph-cache";
import init, {
  Engine,
  catalogue as plainCatalogue,
  presets as presetList,
  version,
} from "./pkg/kompass_wasm.js";
import {
  type EngineEvent,
  type EngineHandlers,
  type EngineInfo,
  type EngineRequest,
  type GeometryMode,
  handleRequest,
  type LoadPhase,
  type RouteOutcome,
  transferables,
} from "./protocol";

/** What `Engine.route` answers (JSON). */
type WasmRoute = { result: RouteResult; missingGeometry: number[] } | { error: RouteError };

const wasm = init();

type Region = {
  engine: Engine;
  store: GraphStore;
  graph: GraphFiles;
  mode: GeometryMode;
  /** engine tile number → its geometry file */
  geometry: DataFile[];
};

let region: Region | null = null;
let presetsCache: Preset[] | null = null;

function ready(): Region {
  if (!region) throw new Error("no region graph loaded");
  return region;
}

function post(event: EngineEvent) {
  self.postMessage(event);
}

/** Progress events, at most every 50 ms (and always the last one). */
function progress(phase: LoadPhase, total: number) {
  let done = 0;
  let files = 0;
  let last = 0;
  const send = () => post({ event: "progress", progress: { phase, done, total, files } });
  send();
  return {
    add(bytes: number) {
      done += bytes;
      files++;
      const now = performance.now();
      if (now - last > 50 || done >= total) {
        last = now;
        send();
      }
    },
  };
}

/** The geometry of `tiles` (engine tile numbers), from the device cache or the network. */
async function addGeometry(r: Region, tiles: Iterable<number>): Promise<number> {
  const todo = [...new Set(tiles)].filter((t) => !r.engine.geometryLoaded(t));
  const files = todo.map((t) => {
    const file = r.geometry[t];
    if (!file) throw new Error(`no geometry file for tile ${t}`);
    return file;
  });
  const bytes = new Map<DataFile, Uint8Array>();
  await r.store.forEach(files, async (f) => {
    bytes.set(f, await r.store.read(f));
  });
  for (const f of files) r.engine.addGeometry(bytes.get(f) as Uint8Array);
  return files.length;
}

async function wasmBytes(): Promise<number> {
  return (await wasm).memory.buffer.byteLength;
}

async function info(): Promise<EngineInfo> {
  const r = ready();
  return { ...(JSON.parse(r.engine.info()) as Omit<EngineInfo, "wasmBytes">), wasmBytes: await wasmBytes() };
}

const handlers: EngineHandlers = {
  version: async () => {
    await wasm;
    return version();
  },
  presets: async () => {
    await wasm;
    presetsCache ??= JSON.parse(presetList()) as Preset[];
    return presetsCache;
  },
  catalogue: async () => {
    await wasm;
    return JSON.parse(region ? region.engine.regionCatalogue() : plainCatalogue()) as Catalogue;
  },

  load: async ({ dataUrl, graph, geometry = "eager" }) => {
    await wasm;
    if (region) {
      region.engine.free();
      region = null;
    }
    const caches = (self as { caches?: CacheStorage }).caches;
    const store = new GraphStore({
      dataUrl,
      graph,
      caches: caches ? (caches as unknown as CacheStorageLike) : null,
      fetch: (url, init) => fetch(url, init),
    });
    const all = graphFileList(graph);

    // 1. everything onto the device (the lazy mode needs the geometry offline too)
    const t0 = performance.now();
    let downloadedFiles = 0;
    let downloadedBytes = 0;
    if (store.cached) {
      const missing = await store.missing(all);
      if (missing.length > 0) {
        const p = progress(
          "download",
          missing.reduce((sum, f) => sum + wireBytes(f), 0),
        );
        await store.download(missing, (f) => {
          downloadedFiles++;
          downloadedBytes += wireBytes(f);
          p.add(wireBytes(f));
        });
      }
    }
    const downloadMs = performance.now() - t0;

    // 2. into the engine: the index, the graph tiles, the geometry (eager), then the planner
    const t1 = performance.now();
    const tiles = graph.tiles.map((t) => ({ file: t.graph, kind: "graph" as const }));
    const geo =
      geometry === "eager" ? graph.tiles.map((t) => ({ file: t.geometry, kind: "geometry" as const })) : [];
    const items = [...tiles, ...geo];
    const fromNetwork = !store.cached;
    const size = (f: DataFile) => (fromNetwork ? wireBytes(f) : f.bytes);
    const p = progress(
      fromNetwork ? "download" : "load",
      size(graph.index) + items.reduce((sum, i) => sum + size(i.file), 0),
    );
    const engine = new Engine(await store.read(graph.index));
    p.add(size(graph.index));
    try {
      if (engine.buildId !== graph.buildId) {
        throw new Error(`the graph files are of build ${engine.buildId}, the manifest of ${graph.buildId}`);
      }
      await store.forEach(items, async ({ file, kind }) => {
        const bytes = await store.read(file);
        if (kind === "graph") engine.addTile(bytes);
        else engine.addGeometry(bytes);
        if (fromNetwork) {
          downloadedFiles++;
          downloadedBytes += wireBytes(file);
        }
        p.add(size(file));
      });
      const t2 = performance.now();
      engine.finish();
      const finishMs = performance.now() - t2;
      const loadMs = performance.now() - t1;

      // engine tile numbers → files (the index order; the manifest lists the same tiles)
      const byXY = new Map(graph.tiles.map((t) => [`${t.x}/${t.y}`, t.geometry]));
      const xy = engine.tiles();
      const geometryFiles: DataFile[] = [];
      for (let i = 0; i + 1 < xy.length; i += 2) {
        const file = byXY.get(`${xy[i]}/${xy[i + 1]}`);
        if (!file) throw new Error(`tile ${xy[i]}/${xy[i + 1]} is not in the manifest`);
        geometryFiles.push(file);
      }
      region = { engine, store, graph, mode: geometry, geometry: geometryFiles };
      await store.evictOthers();
      return {
        buildId: engine.buildId,
        cached: store.cached,
        downloadedFiles,
        downloadedBytes,
        downloadMs: fromNetwork ? loadMs : downloadMs,
        loadMs,
        finishMs,
        geometry,
        info: await info(),
      };
    } catch (error) {
      engine.free();
      throw error;
    }
  },

  info,

  route: async (request): Promise<RouteOutcome> => {
    const r = ready();
    const text = JSON.stringify(request);
    let out = JSON.parse(r.engine.route(text)) as WasmRoute;
    // lazy geometry: load what the route crosses, then assemble it again (the search is the same)
    if (
      "result" in out &&
      out.missingGeometry.length > 0 &&
      (await addGeometry(r, out.missingGeometry)) > 0
    ) {
      out = JSON.parse(r.engine.route(text)) as WasmRoute;
    }
    return "result" in out ? { ok: true, result: out.result } : { ok: false, error: out.error };
  },
  prepare: (profile) => {
    ready().engine.prepare(JSON.stringify(profile));
    return undefined;
  },
  diff: (request) => JSON.parse(ready().engine.diff(JSON.stringify(request))),
  explain: (request) => JSON.parse(ready().engine.explain(JSON.stringify(request))),
  arcCosts: (profile) => ready().engine.arcCosts(JSON.stringify(profile)),
  setPersonal: (layer) => {
    const e = ready().engine;
    if (layer) e.setPersonal(layer.rides, layer.lastRidden, layer.today);
    else e.clearPersonal();
    return undefined;
  },
  snap: ({ lon, lat, radiusM = 250 }) => JSON.parse(ready().engine.snap(lon, lat, radiusM)),
  matchRide: async ({ lat, lon }) => {
    const r = ready();
    const tilesLoaded = await addGeometry(r, r.engine.matchTiles(lat, lon));
    const m = r.engine.matchRide(lat, lon);
    try {
      return {
        graphBuild: r.engine.buildId,
        arcs: m.arcs,
        coverage: m.coverage,
        firstPoint: m.firstPoint,
        unmatched: m.unmatched,
        trackM: m.trackM,
        matchedM: m.matchedM,
        pathM: m.pathM,
        breaks: m.breaks,
        tilesLoaded,
      };
    } finally {
      m.free();
    }
  },
  benchPairs: ({ seed, minKm, maxKm, n }) => ready().engine.benchPairs(seed, minKm, maxKm, n),
};

// one request at a time, in arrival order
let queue: Promise<unknown> = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<EngineRequest>) => {
  queue = queue.then(async () => {
    const response = await handleRequest(handlers, event.data);
    self.postMessage(response, response.ok ? transferables(response.result) : []);
  });
});
