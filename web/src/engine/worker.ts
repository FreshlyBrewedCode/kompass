/// <reference lib="webworker" />
// The engine worker: loads kompass-wasm once, then answers requests (protocol.ts).
import init, { distanceM, version } from "./pkg/kompass_wasm.js";
import { type EngineHandlers, type EngineRequest, handleRequest } from "./protocol";

const ready = init();

const handlers: EngineHandlers = {
  version: async () => {
    await ready;
    return version();
  },
  distance: async ({ from, to }) => {
    await ready;
    return distanceM(from.lng, from.lat, to.lng, to.lat);
  },
};

self.addEventListener("message", async (event: MessageEvent<EngineRequest>) => {
  self.postMessage(await handleRequest(handlers, event.data));
});
