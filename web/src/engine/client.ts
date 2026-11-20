import type { RouteRequest } from "./generated/types";
import {
  type EngineEvent,
  type EngineMethod,
  type EngineRequest,
  isEvent,
  type Params,
  type Result,
  type RouteOutcome,
  transferables,
  type WorkerMessage,
} from "./protocol";

/** The part of a Worker the client needs (a fake in tests). */
export interface WorkerLike {
  postMessage(message: EngineRequest, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerMessage>) => void): void;
  terminate(): void;
}

/** What a superseded latest-wins request resolves to: a newer one took its place. */
export const SUPERSEDED = Object.freeze({ superseded: true as const });
export type Superseded = typeof SUPERSEDED;

export function isSuperseded(value: unknown): value is Superseded {
  return value === SUPERSEDED;
}

type Args<M extends EngineMethod> = Params<M> extends undefined ? [] : [Params<M>];

export interface EngineClient {
  call<M extends EngineMethod>(method: M, ...params: Args<M>): Promise<Result<M>>;
  /** Like `call`, with the time the worker spent on it. */
  timed<M extends EngineMethod>(method: M, ...params: Args<M>): Promise<{ result: Result<M>; ms: number }>;
  /**
   * Latest wins, per lane: at most one request of the lane is in the worker; a request made while
   * one runs waits, and a newer one replaces it (the replaced one resolves `SUPERSEDED`). The one
   * that runs always delivers its result, so dragging a slider on a slow phone still shows a route
   * every round trip. `cancel(lane)` drops what waits and makes the running one resolve `SUPERSEDED`.
   */
  latest<M extends EngineMethod>(
    lane: string,
    method: M,
    ...params: Args<M>
  ): Promise<Result<M> | Superseded>;
  /** `latest("route", "route", request)`. */
  routeLatest(request: RouteRequest): Promise<RouteOutcome | Superseded>;
  cancel(lane: string): void;
  /** Worker events (load progress); returns the unsubscribe function. */
  onEvent(listener: (event: EngineEvent) => void): () => void;
  /** Requests sent and not answered yet. */
  readonly inFlight: number;
  terminate(): void;
}

type Pending = { resolve: (value: { result: unknown; ms: number }) => void; reject: (error: Error) => void };

type Waiting = {
  method: EngineMethod;
  params: unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type Lane = { running: { generation: number } | null; waiting: Waiting | null; generation: number };

/** A typed request/response wrapper around the engine worker. */
export function createEngineClient(worker: WorkerLike): EngineClient {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const listeners = new Set<(event: EngineEvent) => void>();
  const lanes = new Map<string, Lane>();
  let terminated = false;

  worker.addEventListener("message", ({ data }) => {
    if (isEvent(data)) {
      for (const listener of [...listeners]) listener(data);
      return;
    }
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) entry.resolve({ result: data.result, ms: data.ms });
    else entry.reject(new Error(data.error));
  });

  function send(method: EngineMethod, params: unknown): Promise<{ result: unknown; ms: number }> {
    if (terminated) return Promise.reject(new Error("engine terminated"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const message = { id, method, params } as EngineRequest;
      // big inputs (track points) move instead of being copied
      worker.postMessage(message, transferables(params));
    });
  }

  function lane(name: string): Lane {
    let l = lanes.get(name);
    if (!l) {
      l = { running: null, waiting: null, generation: 0 };
      lanes.set(name, l);
    }
    return l;
  }

  function run(l: Lane, job: Waiting) {
    const ticket = { generation: l.generation };
    l.running = ticket;
    send(job.method, job.params).then(
      ({ result }) => {
        finish(l, ticket);
        job.resolve(ticket.generation === l.generation ? result : SUPERSEDED);
      },
      (error: Error) => {
        finish(l, ticket);
        if (ticket.generation === l.generation) job.reject(error);
        else job.resolve(SUPERSEDED);
      },
    );
  }

  function finish(l: Lane, ticket: { generation: number }) {
    if (l.running === ticket) l.running = null;
    const next = l.waiting;
    if (next && !l.running) {
      l.waiting = null;
      run(l, next);
    }
  }

  const client: EngineClient = {
    async call(method, ...params) {
      return (await send(method, params[0])).result as never;
    },
    async timed(method, ...params) {
      return (await send(method, params[0])) as never;
    },
    latest(name, method, ...params) {
      const l = lane(name);
      return new Promise((resolve, reject) => {
        const job: Waiting = { method, params: params[0], resolve: resolve as (v: unknown) => void, reject };
        if (!l.running) {
          run(l, job);
          return;
        }
        l.waiting?.resolve(SUPERSEDED);
        l.waiting = job;
      });
    },
    routeLatest(request) {
      return client.latest("route", "route", request);
    },
    cancel(name) {
      const l = lanes.get(name);
      if (!l) return;
      l.generation++;
      l.waiting?.resolve(SUPERSEDED);
      l.waiting = null;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get inFlight() {
      return pending.size;
    },
    terminate() {
      terminated = true;
      worker.terminate();
      for (const entry of pending.values()) entry.reject(new Error("engine terminated"));
      pending.clear();
      for (const l of lanes.values()) {
        l.waiting?.reject(new Error("engine terminated"));
        l.waiting = null;
      }
    },
  };
  return client;
}

/** The engine in its own Web Worker (worker.ts), so the UI never waits on a query. */
export function startEngine(): EngineClient {
  return createEngineClient(new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }));
}
