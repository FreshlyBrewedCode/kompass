import { describe, expect, test } from "bun:test";
import { createEngineClient, type WorkerLike } from "../src/engine/client";
import {
  type EngineHandlers,
  type EngineRequest,
  type EngineResponse,
  handleRequest,
} from "../src/engine/protocol";

const handlers: EngineHandlers = {
  version: () => "0.0.0-test",
  distance: ({ from, to }) => Math.hypot(to.lng - from.lng, to.lat - from.lat),
};

/** A worker that answers in a microtask, like the real one answers asynchronously. */
function fakeWorker(h: EngineHandlers = handlers): WorkerLike & { terminated: boolean } {
  let listener: ((event: MessageEvent<EngineResponse>) => void) | undefined;
  return {
    terminated: false,
    postMessage(message: EngineRequest) {
      void handleRequest(h, message).then((data) => listener?.({ data } as MessageEvent<EngineResponse>));
    },
    addEventListener(_type, l) {
      listener = l;
    },
    terminate() {
      this.terminated = true;
    },
  };
}

describe("engine client", () => {
  test("matches answers to concurrent requests", async () => {
    const engine = createEngineClient(fakeWorker());
    const [version, distance] = await Promise.all([
      engine.call("version"),
      engine.call("distance", { from: { lng: 0, lat: 0 }, to: { lng: 3, lat: 4 } }),
    ]);
    expect(version).toBe("0.0.0-test");
    expect(distance).toBe(5);
  });

  test("rejects with the engine's error", async () => {
    const engine = createEngineClient(
      fakeWorker({
        ...handlers,
        version: () => {
          throw new Error("boom");
        },
      }),
    );
    await expect(engine.call("version")).rejects.toThrow("boom");
  });

  test("terminate rejects what is still pending", async () => {
    const worker = fakeWorker();
    worker.postMessage = () => {};
    const engine = createEngineClient(worker);
    const pending = engine.call("version");
    engine.terminate();
    await expect(pending).rejects.toThrow("engine terminated");
    expect(worker.terminated).toBe(true);
  });
});

describe("handleRequest", () => {
  test("answers unknown methods with an error instead of throwing", async () => {
    const response = await handleRequest(handlers, { id: 7, method: "nope" as "version", params: undefined });
    expect(response).toEqual({ id: 7, ok: false, error: "unknown engine method: nope" });
  });
});
