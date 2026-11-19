// A throwaway static server for the e2e: serves web/dist under a sub-path (as GitHub Pages will).
//   bun e2e/serve.ts --port 7959 --base /kompass/
import { join, normalize, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { port: { type: "string" }, base: { type: "string" } } });
const port = Number(values.port ?? 7959);
const base = values.base ?? "/";
const dist = resolve(import.meta.dirname, "../web/dist");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith(base)) return new Response("not found", { status: 404 });
    const rel = normalize(decodeURIComponent(pathname.slice(base.length)) || "index.html");
    if (rel.startsWith("..")) return new Response("not found", { status: 404 });
    const file = Bun.file(join(dist, rel));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
console.log(`serving ${dist} at http://127.0.0.1:${server.port}${base}`);
process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
