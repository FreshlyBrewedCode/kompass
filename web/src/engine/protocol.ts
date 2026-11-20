// The messages between the app and the engine worker. Every method is a request/response pair;
// the client (client.ts) numbers requests and matches the answers.

export interface LngLat {
  lng: number;
  lat: number;
}

/** What the engine answers to: params in, result out. */
export interface EngineMethods {
  version: { params: undefined; result: string };
  distance: { params: { from: LngLat; to: LngLat }; result: number };
}

export type EngineMethod = keyof EngineMethods;
export type Params<M extends EngineMethod> = EngineMethods[M]["params"];
export type Result<M extends EngineMethod> = EngineMethods[M]["result"];

export interface EngineRequest<M extends EngineMethod = EngineMethod> {
  id: number;
  method: M;
  params: Params<M>;
}

export type EngineResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

/** The worker side: one handler per method. */
export type EngineHandlers = { [M in EngineMethod]: (params: Params<M>) => Result<M> | Promise<Result<M>> };

/** Runs one request against the handlers and never throws: errors become `ok: false`. */
export async function handleRequest(
  handlers: EngineHandlers,
  request: EngineRequest,
): Promise<EngineResponse> {
  try {
    const handler = handlers[request.method] as ((params: unknown) => unknown) | undefined;
    if (!handler) throw new Error(`unknown engine method: ${String(request.method)}`);
    return { id: request.id, ok: true, result: await handler(request.params) };
  } catch (error) {
    return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
