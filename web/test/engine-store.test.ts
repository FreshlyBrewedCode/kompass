import { describe, expect, test } from "bun:test";
import { createEngineClient, SUPERSEDED, type WorkerLike } from "../src/engine/client";
import type { EngineRequest, LoadStats, WorkerMessage } from "../src/engine/protocol";
import { type EngineSnapshot, EngineStore } from "../src/engine/store";
import type { GraphFiles } from "../src/map/manifest";

const GRAPH: GraphFiles = {
  formatVersion: 2,
  buildId: "b1",
  tileZoom: 11,
  nodes: 1,
  edges: 1,
  bytes: 1,
  index: { file: "graph/index.kmpg", bytes: 1 },
  tiles: [],
};

const stats = (buildId: string): LoadStats =>
  ({ buildId, cached: true, downloadedFiles: 1, info: { edges: 1 } }) as unknown as LoadStats;

/** A worker the test drives: it records requests and answers when told. */
function scripted() {
  let listener: ((event: MessageEvent<WorkerMessage>) => void) | undefined;
  const sent: EngineRequest[] = [];
  const worker: WorkerLike = {
    postMessage(m) {
      sent.push(m);
      if (m.method === "version") queueMicrotask(() => emit({ id: m.id, ok: true, result: "1.2.3", ms: 0 }));
    },
    addEventListener(_t, l) {
      listener = l;
    },
    terminate() {},
  };
  const emit = (data: WorkerMessage) => listener?.({ data } as MessageEvent<WorkerMessage>);
  const last = (method: string) => [...sent].reverse().find((m) => m.method === method) as EngineRequest;
  return { worker, sent, emit, last };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("engine store", () => {
  test("idle → downloading(progress) → loading(progress) → ready, with the version", async () => {
    const w = scripted();
    const store = new EngineStore(createEngineClient(w.worker));
    const seen: EngineSnapshot[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()));
    expect(store.getSnapshot().status).toBe("idle");
    await tick();
    expect(store.getSnapshot().version).toBe("1.2.3");

    const done = store.load("https://x.test/data/", GRAPH);
    expect(store.getSnapshot().status).toBe("loading");
    w.emit({ event: "progress", progress: { phase: "download", done: 10, total: 100, files: 1 } });
    expect(store.getSnapshot()).toMatchObject({ status: "downloading", done: 10, total: 100 });
    w.emit({ event: "progress", progress: { phase: "load", done: 50, total: 200, files: 3 } });
    expect(store.getSnapshot()).toMatchObject({ status: "loading", done: 50, total: 200 });
    w.emit({ id: w.last("load").id, ok: true, result: stats("b1"), ms: 5 });
    await done;
    expect(store.getSnapshot()).toMatchObject({ status: "ready", buildId: "b1", version: "1.2.3" });
    expect(seen.map((s) => s.status)).toEqual(["idle", "loading", "downloading", "loading", "ready"]);

    // progress after ready is ignored; the same build again is not loaded twice
    w.emit({ event: "progress", progress: { phase: "load", done: 1, total: 2, files: 1 } });
    expect(store.getSnapshot().status).toBe("ready");
    const loads = w.sent.filter((m) => m.method === "load").length;
    await store.load("https://x.test/data/", GRAPH);
    expect(w.sent.filter((m) => m.method === "load").length).toBe(loads);
  });

  test("an error is a state, and loading again retries", async () => {
    const w = scripted();
    const store = new EngineStore(createEngineClient(w.worker));
    const first = store.load("https://x.test/data/", GRAPH);
    w.emit({ id: w.last("load").id, ok: false, error: "HTTP 503", ms: 1 });
    await expect(first).rejects.toThrow("HTTP 503");
    expect(store.getSnapshot()).toMatchObject({ status: "error", message: "HTTP 503" });
    const second = store.load("https://x.test/data/", GRAPH);
    expect(store.getSnapshot().status).toBe("loading");
    w.emit({ id: w.last("load").id, ok: true, result: stats("b1"), ms: 1 });
    await second;
    expect(store.getSnapshot().status).toBe("ready");
  });

  test("another build replaces the one loading; its late answer is ignored", async () => {
    const w = scripted();
    const store = new EngineStore(createEngineClient(w.worker));
    const a = store.load("https://x.test/data/", GRAPH);
    const firstId = w.last("load").id;
    const b = store.load("https://x.test/data/", { ...GRAPH, buildId: "b2" });
    w.emit({ id: w.last("load").id, ok: true, result: stats("b2"), ms: 1 });
    await b;
    w.emit({ id: firstId, ok: true, result: stats("b1"), ms: 1 });
    await a;
    expect(store.getSnapshot()).toMatchObject({ status: "ready", buildId: "b2" });
  });

  test("busy while requests run, latest-wins routes per lane", async () => {
    const w = scripted();
    const store = new EngineStore(createEngineClient(w.worker));
    const request = {
      waypoints: [],
      profile: { weights: {}, limits: {} },
      options: { snap_radius_m: 1, geometry: false },
    };
    const r1 = store.routeLatest(request);
    expect(store.getSnapshot().busy).toBe(true);
    const r2 = store.routeLatest(request);
    const r3 = store.routeLatest(request);
    const other = store.routeLatest(request, "compare");
    expect(await r2).toBe(SUPERSEDED);
    const routes = w.sent.filter((m) => m.method === "route");
    expect(routes.length).toBe(2); // r1 and the compare lane
    for (const m of routes) w.emit({ id: m.id, ok: true, result: { ok: true, result: m.id }, ms: 1 });
    await r1;
    await other;
    expect(store.getSnapshot().busy).toBe(true); // r3 runs now
    w.emit({ id: w.last("route").id, ok: true, result: { ok: true, result: "r3" }, ms: 1 });
    expect(await r3).toEqual({ ok: true, result: "r3" } as never);
    expect(store.getSnapshot().busy).toBe(false);
  });
});
