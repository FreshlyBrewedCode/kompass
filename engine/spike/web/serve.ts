// Throwaway static server for the spike's browser benchmark (ports 7960-7969 only).
//   bun engine/spike/web/serve.ts --port 7960 --data <dir with graph.kmpg, tiles-z10/, landmarks8.u16>
// Serves this directory, the wasm-bindgen output (web/src/engine/pkg) under /pkg/, and the data dir
// under /data/, using a precompressed `<file>.gz` with Content-Encoding: gzip when one exists.
import { join, normalize, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { port: { type: "string" }, data: { type: "string" } } });
const port = Number(values.port ?? 7960);
const here = import.meta.dirname;
const pkg = resolve(here, "../../../web/src/engine/pkg");
const data = resolve(values.data ?? ".");

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
    let path: string;
    if (rel.startsWith("pkg/")) path = join(pkg, rel.slice(4));
    else if (rel.startsWith("data/")) path = join(data, rel.slice(5));
    else path = join(here, rel);
    const type = types[path.split(".").pop() ?? ""] ?? "application/octet-stream";
    const gz = Bun.file(`${path}.gz`);
    if ((request.headers.get("accept-encoding") ?? "").includes("gzip") && (await gz.exists())) {
      return new Response(gz, { headers: { "content-type": type, "content-encoding": "gzip" } });
    }
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, { headers: { "content-type": type } });
  },
});
console.log(`spike bench at http://127.0.0.1:${server.port}/ (pid ${process.pid})`);
process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
