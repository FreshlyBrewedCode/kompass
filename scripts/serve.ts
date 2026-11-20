// A static server for the built app (web/dist) and a region data directory, with HTTP Range support:
// the e2e's throwaway server and the way to playtest a build on a phone.
//   bun run serve -- --port 7950 --data data/build/region [--base /kompass/]
// The app lives at <base>; the data directory at <base>data/ (the app's default data URL).
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveInside, serveFile } from "./static-files.ts";

const { values } = parseArgs({
  options: { port: { type: "string" }, base: { type: "string" }, data: { type: "string" } },
});
const port = Number(values.port ?? 7950);
const base = values.base ?? "/";
const dist = resolve(import.meta.dirname, "../web/dist");
const data = values.data ? resolve(values.data) : undefined;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith(base)) return new Response("not found", { status: 404 });
    const rest = pathname.slice(base.length);
    if (data && rest.startsWith("data/")) {
      const path = resolveInside(data, rest.slice("data/".length));
      return path ? serveFile(request, path, { cache: "long" }) : new Response("not found", { status: 404 });
    }
    const path = resolveInside(dist, rest === "" || rest.endsWith("/") ? `${rest}index.html` : rest);
    return path ? serveFile(request, path) : new Response("not found", { status: 404 });
  },
});
console.log(
  `serving ${dist}${data ? ` and ${data} at ${base}data/` : ""} at http://127.0.0.1:${server.port}${base}`,
);
process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
process.on("SIGINT", () => {
  server.stop();
  process.exit(0);
});
