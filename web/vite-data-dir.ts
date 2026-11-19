// Vite dev plugin: serves a local directory (a region build) at `/data/`, with Range support, so the
// app's default data URL (`./data/`) works in `bun run dev`. `KOMPASS_DATA_DIR` picks the directory.
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Plugin } from "vite";
import { resolveInside, serveFile } from "../scripts/static-files.ts";

export function dataDirPlugin(dir: string): Plugin {
  const present = existsSync(dir);
  return {
    name: "kompass-data-dir",
    configureServer(server) {
      server.config.logger.info(
        present
          ? `  region data: ${dir} at /data/`
          : `  region data: none (${dir} does not exist), the app shows its empty state`,
      );
      server.middlewares.use("/data/", async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = present ? resolveInside(dir, url.pathname) : null;
        const request = new Request(url, {
          method: req.method ?? "GET",
          headers: Object.entries(req.headers).flatMap(([k, v]) =>
            v === undefined ? [] : [[k, String(v)] as [string, string]],
          ),
        });
        const response = path
          ? await serveFile(request, path, { cache: "revalidate" })
          : new Response("not found", { status: 404 });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (!response.body) return res.end();
        await pipeline(Readable.fromWeb(response.body as never), res).catch(() => {});
      });
    },
  };
}
