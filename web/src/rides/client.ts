// The typed client for the ride worker (same idea as src/engine/client.ts, plus progress callbacks).
import type { RideMethod, RideParams, RideProgress, RideRequest, RideResponse, RideResult } from "./protocol";

export interface RidesWorkerLike {
  postMessage(message: RideRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent<RideResponse>) => void): void;
  terminate(): void;
}

export interface RidesClient {
  call<M extends RideMethod>(
    method: M,
    params: RideParams<M>,
    onProgress?: (progress: RideProgress) => void,
  ): Promise<RideResult<M>>;
  terminate(): void;
}

export function createRidesClient(worker: RidesWorkerLike): RidesClient {
  let nextId = 1;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      onProgress: ((p: RideProgress) => void) | undefined;
    }
  >();

  worker.addEventListener("message", ({ data }) => {
    const entry = pending.get(data.id);
    if (!entry) return;
    if ("progress" in data) {
      entry.onProgress?.(data.progress);
      return;
    }
    pending.delete(data.id);
    if (data.ok) entry.resolve(data.result);
    else entry.reject(new Error(data.error));
  });

  return {
    call(method, params, onProgress) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onProgress });
        worker.postMessage({ id, method, params } as RideRequest);
      });
    },
    terminate() {
      worker.terminate();
      for (const entry of pending.values()) entry.reject(new Error("ride worker terminated"));
      pending.clear();
    },
  };
}

/** The ride worker (worker.ts). */
export function startRides(): RidesClient {
  return createRidesClient(new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }));
}
