import { run } from "./run.js";

self.onmessage = async (m) => {
  try {
    const result = await run(m.data, (log) => self.postMessage({ log }));
    self.postMessage({ result });
  } catch (e) {
    self.postMessage({ error: String(e?.stack ?? e) });
  }
};
