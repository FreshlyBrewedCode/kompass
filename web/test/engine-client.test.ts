import { describe, expect, test } from "bun:test";
import { createEngineClient, isSuperseded, SUPERSEDED, type WorkerLike } from "../src/engine/client";
import type { RouteRequest } from "../src/engine/generated/types";
import {
  type EngineHandlers,
  type EngineRequest,
  handleRequest,
  transferables,
  type WorkerMessage,
} from "../src/engine/protocol";

const handlers: Partial<EngineHandlers> = {
  version: () => "0.0.0-test",
  snap: ({ lon, lat }) => ({ edge: 1, fraction: 0.5, distanceM: Math.hypot(lon, lat), lon, lat }),
};

type Fake = WorkerLike & {
  terminated: boolean;
  sent: EngineRequest[];
  emit(message: WorkerMessage): void;
};

/** A worker that answers in a microtask, like the real one answers asynchronously. */
function fakeWorker(h: Partial<EngineHandlers> = handlers): Fake {
  let listener: ((event: MessageEvent<WorkerMessage>) => void) | undefined;
  const fake: Fake = {
    terminated: false,
    sent: [],
    postMessage(message: EngineRequest) {
      fake.sent.push(message);
      void handleRequest(h, message).then((data) => listener?.({ data } as MessageEvent<WorkerMessage>));
    },
    addEventListener(_type, l) {
      listener = l;
    },
    terminate() {
      fake.terminated = true;
    },
    emit(data) {
      listener?.({ data } as MessageEvent<WorkerMessage>);
    },
  };
  return fake;
}

/** A worker that answers only when told to (`answer(id, result)`), to test the latest-wins lane. */
function manualWorker() {
  const fake = fakeWorker();
  fake.postMessage = (message: EngineRequest) => {
    fake.sent.push(message);
  };
  return {
    fake,
    answer(id: number, result: unknown) {
      fake.emit({ id, ok: true, result, ms: 1 });
    },
    fail(id: number, error: string) {
      fake.emit({ id, ok: false, error, ms: 1 });
    },
  };
}

const request = (name: string): RouteRequest => ({
  waypoints: [
    { lon: 0, lat: 0, name },
    { lon: 1, lat: 1 },
  ],
  profile: { weights: {}, limits: {} },
  options: { snap_radius_m: 250, geometry: true },
});
const nameOf = (r: EngineRequest | undefined) => (r?.params as RouteRequest | undefined)?.waypoints[0]?.name;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("engine client", () => {
  test("matches answers to concurrent requests, with the worker's time", async () => {
    const engine = createEngineClient(fakeWorker());
    const [version, hit] = await Promise.all([
      engine.call("version"),
      engine.call("snap", { lon: 3, lat: 4 }),
    ]);
    expect(version).toBe("0.0.0-test");
    expect(hit?.distanceM).toBe(5);
    const timed = await engine.timed("version");
    expect(timed.result).toBe("0.0.0-test");
    expect(timed.ms).toBeGreaterThanOrEqual(0);
  });

  test("rejects with the engine's error", async () => {
    const engine = createEngineClient(
      fakeWorker({
        version: () => {
          throw new Error("boom");
        },
      }),
    );
    await expect(engine.call("version")).rejects.toThrow("boom");
  });

  test("terminate rejects what is still pending", async () => {
    const { fake } = manualWorker();
    const engine = createEngineClient(fake);
    const pending = engine.call("version");
    expect(engine.inFlight).toBe(1);
    engine.terminate();
    await expect(pending).rejects.toThrow("engine terminated");
    expect(fake.terminated).toBe(true);
    await expect(engine.call("version")).rejects.toThrow("engine terminated");
  });

  test("forwards worker events", () => {
    const fake = fakeWorker();
    const engine = createEngineClient(fake);
    const seen: number[] = [];
    const off = engine.onEvent((e) => seen.push(e.progress.done));
    fake.emit({ event: "progress", progress: { phase: "download", done: 5, total: 10, files: 1 } });
    off();
    fake.emit({ event: "progress", progress: { phase: "download", done: 10, total: 10, files: 2 } });
    expect(seen).toEqual([5]);
  });

  test("moves typed arrays in the params instead of copying them", () => {
    const w = manualWorker();
    let transfer: Transferable[] | undefined;
    w.fake.postMessage = (_m, t) => {
      transfer = t;
    };
    const engine = createEngineClient(w.fake);
    const lat = Float64Array.of(1, 2);
    const lon = Float64Array.of(3, 4);
    void engine.call("matchRide", { lat, lon });
    expect(transfer).toEqual([lat.buffer, lon.buffer]);
  });
});

describe("latest wins", () => {
  test("one request in flight; a newer one replaces the waiting one; the running one delivers", async () => {
    const w = manualWorker();
    const engine = createEngineClient(w.fake);
    const r1 = engine.routeLatest(request("r1"));
    const r2 = engine.routeLatest(request("r2"));
    const r3 = engine.routeLatest(request("r3"));
    // only r1 went to the worker; r2 was replaced by r3 before it could start
    expect(w.fake.sent.map(nameOf)).toEqual(["r1"]);
    expect(await r2).toBe(SUPERSEDED);

    w.answer(w.fake.sent[0]?.id as number, { ok: true, result: "first" });
    expect(await r1).toEqual({ ok: true, result: "first" } as never);
    // r1 done: the newest waiting one goes
    expect(w.fake.sent.map(nameOf)).toEqual(["r1", "r3"]);
    w.answer(w.fake.sent[1]?.id as number, { ok: true, result: "third" });
    expect(await r3).toEqual({ ok: true, result: "third" } as never);
  });

  test("a slider drag: many steps, the worker sees few, the last step always runs", async () => {
    const w = manualWorker();
    const engine = createEngineClient(w.fake);
    const results: unknown[] = [];
    const steps = Array.from({ length: 30 }, (_, i) =>
      engine.routeLatest(request(`s${i}`)).then((r) => {
        if (!isSuperseded(r)) results.push(r);
      }),
    );
    for (let round = 0; w.fake.sent.length > round; round++) {
      w.answer(w.fake.sent[round]?.id as number, nameOf(w.fake.sent[round]));
      await tick();
    }
    await Promise.all(steps);
    expect(w.fake.sent.map(nameOf)).toEqual(["s0", "s29"]);
    expect(results).toEqual(["s0", "s29"]);
  });

  test("cancel: what waits and what runs resolve superseded; stale results are dropped", async () => {
    const w = manualWorker();
    const engine = createEngineClient(w.fake);
    const r1 = engine.routeLatest(request("r1"));
    const r2 = engine.routeLatest(request("r2"));
    engine.cancel("route");
    expect(await r2).toBe(SUPERSEDED);
    w.answer(w.fake.sent[0]?.id as number, "stale");
    expect(await r1).toBe(SUPERSEDED);
    expect(w.fake.sent.length).toBe(1);
    // the lane works again
    const r3 = engine.routeLatest(request("r3"));
    w.answer(w.fake.sent[1]?.id as number, "fresh");
    expect(await r3).toBe("fresh" as never);
  });

  test("lanes are independent; an error rejects only its own request", async () => {
    const w = manualWorker();
    const engine = createEngineClient(w.fake);
    const a = engine.latest("a", "route", request("a"));
    const b = engine.latest("b", "route", request("b"));
    expect(w.fake.sent.map(nameOf)).toEqual(["a", "b"]);
    w.fail(w.fake.sent[0]?.id as number, "no graph");
    w.answer(w.fake.sent[1]?.id as number, "b done");
    await expect(a).rejects.toThrow("no graph");
    expect(await b).toBe("b done" as never);
  });
});

describe("protocol", () => {
  test("handleRequest answers unknown methods with an error instead of throwing", async () => {
    const response = await handleRequest(
      handlers,
      { id: 7, method: "nope" as "version", params: undefined },
      () => 0,
    );
    expect(response).toEqual({ id: 7, ok: false, error: "unknown engine method: nope", ms: 0 });
  });

  test("transferables finds the typed arrays of a result", () => {
    const arcs = Uint32Array.of(1);
    const coverage = Uint8Array.of(2);
    expect(transferables({ arcs, coverage, trackM: 3 })).toEqual([arcs.buffer, coverage.buffer]);
    expect(transferables(arcs)).toEqual([arcs.buffer]);
    expect(transferables("text")).toEqual([]);
  });
});
