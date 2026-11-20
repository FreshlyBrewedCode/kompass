// Throwaway static server for the spike #5 browser bench (ports 7960-7969 only).
//   bun engine/spike5/web/serve.ts --port 7960 --data <build dir> --pts <dir of <id>.bin>
// Serves this directory, the wasm-bindgen output (web/src/engine/pkg) under /pkg/, the build under
// /data/ and the track points under /pts/. Binds to 127.0.0.1 only.
import { join, normalize, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { port: { type: "string" }, data: { type: "string" }, pts: { type: "string" } },
});
const port = Number(values.port ?? 7960);
const here = import.meta.dirname;
const roots: Record<string, string> = {
  pkg: resolve(here, "../../../web/src/engine/pkg"),
  data: resolve(values.data ?? "."),
  pts: resolve(values.pts ?? "."),
};
const types: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  wasm: "application/wasm",
  json: "application/json",
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const rel = normalize(decodeURIComponent(pathname)).replace(/^\/+/, "") || "bench.html";
    if (rel.startsWith("..")) return new Response("not found", { status: 404 });
    const [head, ...rest] = rel.split("/");
    const root = roots[head ?? ""];
    const path = root ? join(root, rest.join("/")) : join(here, rel);
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    const type = types[path.split(".").pop() ?? ""] ?? "application/octet-stream";
    return new Response(file, { headers: { "content-type": type } });
  },
});
console.log(`spike 5 bench at http://127.0.0.1:${server.port}/ (pid ${process.pid})`);
process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
