# 0001: Toolchain: a nix dev shell locally, setup actions in CI

Status: accepted (scaffold, #2)

## Context

The dev machine runs NixOS: no cargo, uv or geo tools installed, and FHS binaries (Playwright's
browsers, uv's Python downloads) don't run. CI runs on GitHub's Ubuntu runners.

## Decision

- **Locally:** `flake.nix` (nixpkgs and rust-overlay pinned in `flake.lock`) provides the whole
  toolchain: Rust from `engine/rust-toolchain.toml` with the wasm32 target, `wasm-bindgen-cli`
  matching the crate, binaryen, uv with the nix Python, tippecanoe, pmtiles, osmium-tool, gdal and a
  Chromium for Playwright. PyPI's native wheels (pyarrow, shapely, later pyosmium and rasterio)
  find libstdc++ and zlib through `LD_LIBRARY_PATH` set by the shell hook; no nix-ld needed.
- **CI:** no nix. The usual actions (`dtolnay/rust-toolchain`, `Swatinem/rust-cache`,
  `taiki-e/install-action` for wasm-bindgen, `astral-sh/setup-uv`, `oven-sh/setup-bun`,
  `playwright install --with-deps`), pinned to the same versions.
- **wasm:** plain `cargo build --target wasm32-unknown-unknown` + `wasm-bindgen --target web`
  (+ `wasm-opt` when available) in `scripts/build-wasm.ts`; no wasm-pack. The output is built,
  never committed.

## Consequences

Versions live in three places that move together: `engine/rust-toolchain.toml` / `flake.lock`, the
`wasm-bindgen` pin (`engine/Cargo.toml`, `flake.nix`, `ci.yml`), and bun's version (`ci.yml` vs the
nixpkgs bun). CI doesn't run `wasm-opt`, so its wasm is larger; behaviour is the same.
