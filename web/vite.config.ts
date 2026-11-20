import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { dataDirPlugin } from "./vite-data-dir.ts";

// Ports: dev 7950 (HMR 7951); the e2e serves the build on 7959 (playwright.config.ts).
// `base` is relative, so the build works from any sub-path (GitHub Pages: /kompass/).
// KOMPASS_BASE overrides it with an absolute one if a host ever needs that.
// Dev serves a region build at /data/ (the app's default data URL): KOMPASS_DATA_DIR, default
// data/build/region in the repo root; without that directory the app shows its empty state.
// KOMPASS_DEV_PORT moves the dev server (its HMR websocket takes the next port).
const port = Number(process.env.KOMPASS_DEV_PORT ?? 7950);
const dataDir = resolve(import.meta.dirname, "..", process.env.KOMPASS_DATA_DIR ?? "data/build/region");
export default defineConfig({
  base: process.env.KOMPASS_BASE ?? "./",
  plugins: [react(), tailwindcss(), dataDirPlugin(dataDir)],
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  worker: { format: "es" },
  // MapLibre alone is ~1.2 MB minified; it is split into its own chunk (see App)
  build: { target: "es2023", chunkSizeWarningLimit: 1600 },
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    hmr: { port: port + 1 },
    // tailscale serve forwards the tailnet hostname
    allowedHosts: [".ts.net", "localhost"],
  },
  preview: { host: "127.0.0.1", port, strictPort: true },
});
