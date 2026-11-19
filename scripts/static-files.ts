// Static file serving with HTTP Range support, for the PMTiles. Web-standard Request/Response in and
// out, so the same code runs under `Bun.serve` (scripts/serve.ts) and inside the Vite dev server
// (web/vite-data-dir.ts). Files are streamed in slices, never read whole: a 460 MB PMTiles file
// costs the same memory as a 1 KB one.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".pbf": "application/x-protobuf",
  ".pmtiles": "application/octet-stream",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

export type ServeOptions = {
  /**
   * `long`: `max-age` a year for the PMTiles (a new build gets a new file name or URL), revalidate for the rest.
   * `revalidate`: everything revalidates by ETag (the dev server: a rebuilt region shows up on reload).
   */
  cache?: "long" | "revalidate";
};

/** The file a URL path names below `root`, or `null` when it would leave `root`. */
export function resolveInside(root: string, urlPath: string): string | null {
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(urlPath)).replace(/^[/\\]+/, "");
  } catch {
    return null;
  }
  const path = join(root, rel);
  return path === resolve(root) || path.startsWith(resolve(root) + sep) ? path : null;
}

/** `bytes=a-b`, `bytes=a-`, `bytes=-n` against a file of `size` bytes; `null` when it cannot be satisfied. */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start >= size || start > end ? null : { start, end };
}

/** Answers GET/HEAD for one file: 200, 206 (a range), 304, 404 or 416. */
export async function serveFile(
  request: Request,
  path: string,
  options: ServeOptions = {},
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return new Response("not found", { status: 404 });

  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const immutable = options.cache === "long" && path.endsWith(".pmtiles");
  const headers = new Headers({
    "content-type": TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
    "accept-ranges": "bytes",
    etag,
    "last-modified": info.mtime.toUTCString(),
    "cache-control": immutable ? "public, max-age=31536000" : "no-cache",
  });
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  let status = 200;
  let start = 0;
  let end = info.size - 1;
  const rangeHeader = request.headers.get("range");
  // a Range is only honoured while the validator still matches (If-Range), else the whole file
  const ifRange = request.headers.get("if-range");
  if (rangeHeader && (!ifRange || ifRange === etag)) {
    const range = parseRange(rangeHeader, info.size);
    if (!range) {
      headers.set("content-range", `bytes */${info.size}`);
      return new Response("range not satisfiable", { status: 416, headers });
    }
    ({ start, end } = range);
    status = 206;
    headers.set("content-range", `bytes ${start}-${end}/${info.size}`);
  }
  const length = info.size === 0 ? 0 : end - start + 1;
  headers.set("content-length", String(length));
  if (request.method === "HEAD" || length === 0) return new Response(null, { status, headers });

  const stream = createReadStream(path, { start, end });
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status, headers });
}
