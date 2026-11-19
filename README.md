# Kompass

A preference-aware route planner and ride companion for cycling (gravel first). Early stage.

A static PWA with no backend: a Rust routing engine compiled to WebAssembly runs in a Web Worker,
the map is MapLibre GL, and a Python pipeline builds the region data offline.

- [VISION.md](VISION.md): what this is about (bootstrap document)
- [ARCHITECTURE.md](ARCHITECTURE.md): the starting architecture (bootstrap document, retired into `docs/` as things get built)
- [docs/](docs/README.md): how it is built; [AGENTS.md](AGENTS.md): commands, layout, conventions

## Quick start

With [nix](https://nixos.org) (flakes enabled), which provides the whole toolchain:

```sh
nix develop          # Rust + wasm32, wasm-bindgen, uv, bun, tippecanoe, pmtiles, osmium, gdal, Chromium
bun install
bun run check        # the gate: engine, web, pipeline
bun run dev          # http://127.0.0.1:7950
bun run e2e          # Playwright at phone and desktop viewports
```

Without nix: install Rust (rustup picks up `engine/rust-toolchain.toml`), `wasm-bindgen-cli`
0.2.127, [uv](https://docs.astral.sh/uv/) and [bun](https://bun.sh) 1.4, then the same commands
(`bunx playwright install chromium` once for the e2e).
