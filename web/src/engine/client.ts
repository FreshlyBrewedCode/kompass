import type { EngineMethod, EngineRequest, EngineResponse, Params, Result } from "./protocol";

/** The part of a Worker the client needs (a fake in tests). */
export interface WorkerLike {
  postMessage(message: EngineRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent<EngineResponse>) => void): void;
  terminate(): void;
}

export interface EngineClient {
  call<M extends EngineMethod>(
    method: M,
    ...params: Params<M> extends undefined ? [] : [Params<M>]
  ): Promise<Result<M>>;
  terminate(): void;
}

/** A typed request/response wrapper around the engine worker. */
export function createEngineClient(worker: WorkerLike): EngineClient {
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  worker.addEventListener("message", ({ data }) => {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) entry.resolve(data.result);
    else entry.reject(new Error(data.error));
  });

  return {
    call(method, ...params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        worker.postMessage({ id, method, params: params[0] } as EngineRequest);
      });
    },
    terminate() {
      worker.terminate();
      for (const entry of pending.values()) entry.reject(new Error("engine terminated"));
      pending.clear();
    },
  };
}

/** The engine in its own Web Worker (worker.ts), so the UI never waits on a query. */
export function startEngine(): EngineClient {
  return createEngineClient(new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }));
}
