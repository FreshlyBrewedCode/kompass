# Kompass

A preference-aware route planner for cycling (gravel first): a static PWA with no backend. A Rust
engine compiled to WebAssembly runs in a Web Worker; a Python pipeline builds the region data
offline. What it wants to be: [VISION.md](VISION.md). How it is built: [docs/](docs/README.md), plus
the parts of [ARCHITECTURE.md](ARCHITECTURE.md) not built yet (both bootstrap documents). Never
modify a sibling project under `~/src`: copy and adapt, no shared libraries.

## Commands

Everything runs inside the nix dev shell (`flake.nix`: Rust with the wasm32 target, wasm-bindgen,
binaryen, uv, Python, tippecanoe, pmtiles, osmium, gdal, Chromium). Enter it with `nix develop`, or
prefix one command with `nix develop -c`.

```sh
bun install
bun run check            # the gate, must pass before every commit (also CI):
  bun run check:engine   #   cargo fmt --check, clippy --all-targets -D warnings, cargo test
  bun run check:web      #   build:wasm, biome, strict tsc (web + e2e), bun test
  bun run check:pipeline #   ruff check, ruff format --check, pytest (uv)
  bun run check:tools    #   the same for tools/komoot
bun run build:wasm       # kompass-wasm → web/src/engine/pkg (generated, gitignored; `--dev` for a debug build)
bun run dev              # build:wasm, then Vite with HMR: http://127.0.0.1:7950 (HMR websocket 7951);
                         # serves a region build at /data/: KOMPASS_DATA_DIR=<dir> (default data/build/region;
                         # without it the app shows its empty state), e.g. KOMPASS_DATA_DIR=e2e/fixtures/region
bun run build            # build:wasm + the web app, into web/dist (relative base: works from any sub-path)
bun run serve -- --port 7950 --data <dir>   # static server for the built app + a region data dir (HTTP
                         # Range, long cache for PMTiles): the way to playtest a build on a phone
bun run e2e              # build, then Playwright (phone 390×844 + desktop 1440×900) against that server on
                         # 7959 under /kompass/ with the synthetic fixture region (KOMPASS_E2E_PORT=…)
nix develop -c bun e2e/fixtures/build-region.ts   # rebuild the fixture region (tippecanoe, edges.parquet
                         # via the pipeline, graph via `kompass compile`) after changing it
bun run format           # biome --write, cargo fmt, ruff format + fix
uv run --project pipeline kompass-pipeline build --region data/region.local.json --out data/build/<name>
                         # the region build: edges.parquet, overlay + base map PMTiles, manifest.json (docs/pipeline.md).
                         # Resumable, stages runnable alone (`kompass-pipeline <stage>`), `--force` redoes.
                         # A heavy job: about 9 min and 5.5 GB peak for a 100 km radius, plus the
                         # downloads on a first run (extracts ~1.5 GB, DEM 0.4 GB, base map 0.5 GB). Run one at a time.
cd engine && cargo run -p kompass-cli -- --version     # the native engine: `kompass`
cd engine && cargo run --release -p kompass-cli -- compile --build ../data/build/<name>
                         # edges.parquet → <dir>/graph/ (tiled binary graph, docs/graph-format.md) + the
                         # manifest's `graph` key; ~2 s and 0.3 GB for a 100 km region
cd engine && cargo run --release -p kompass-cli -- info --build ../data/build/<name>
                         # load the graph: counts, load times, memory, snap timings (no coordinates)
uv run --project tools/komoot kompass-komoot --help    # Komoot download (run by the user, see tools/komoot/README.md)
```

- Ports: dev 7950, Vite HMR 7951, e2e 7959. Other projects on this host own other ports (3456,
  3773, 4327, 4517, 4518, 7446, 7890, 7930, …) and their own `tailscale serve` entries: never touch
  those. Agents don't set up `tailscale serve`; the driver does.
- NixOS: `uv` uses the nix Python (`UV_PYTHON`, no Python downloads) and finds libstdc++/zlib/expat for the
  PyPI wheels through `LD_LIBRARY_PATH` from the shell hook. Playwright uses the nix Chromium
  (`KOMPASS_E2E_CHROMIUM`, set by the shell); in CI, `bunx playwright install` provides one.
- The e2e screenshots land in `test-results/screenshots` (`KOMPASS_E2E_SCREENSHOT_DIR=…` moves them).
  The e2e needs no network: the map runs on the committed synthetic fixture (`e2e/fixtures/region`) and
  the vendored glyphs and sprites (`web/public/map`).
- Leave nothing running: stop dev servers with Ctrl+C or SIGTERM by PID, not `pkill -f`.

## Layout

- `engine/`: Rust workspace. `core` (`kompass-core`: graph, cost, queries; platform-free; tiny test
  graphs in `kompass_core::testing`), `wasm` (`kompass-wasm`: wasm-bindgen face for the browser),
  `compile` (`kompass-compile`: edges.parquet → graph files; native only, keeps parquet out of the
  wasm), `cli` (`kompass-cli`, binary `kompass`).
  Toolchain pinned in `engine/rust-toolchain.toml`.
- `web/`: `@kompass/web`, bun + Vite + React + Tailwind v4 + shadcn/ui + MapLibre GL. The engine
  client lives in `web/src/engine/` (`protocol.ts` the messages, `client.ts` the typed wrapper,
  `worker.ts` the Web Worker that loads the wasm). Unit tests in `web/test`.
- `pipeline/`: Python (uv): OSM extract → `edges.parquet`, the contract with the engine.
- `tools/`: local scripts the user runs themselves (e.g. the Komoot download).
- `e2e/`: Playwright specs and the synthetic fixture region. `scripts/`: repo build scripts and the static
  server (`serve.ts`, with Range support).
- `docs/`: high-level concepts ([index](docs/README.md)), `adr/`, `design/`, `reports/`.
- `data/`: region config, builds, tracks. Gitignored, never committed.

## Conventions

- **Privacy (the repo is public).** Never put a home location (town, coordinates, bounding box),
  real names, tokens or hostnames (no `*.ts.net` names) into code, tests, fixtures, docs, issues,
  PR text or screenshots. Fixtures use a synthetic area or a clearly unrelated small one (the demo
  map shows central Zurich). The region config (`data/region.local.json`), builds and tracks live
  only under the gitignored `data/`; the region config is read only by the pipeline at run time, its
  contents never go into the repo.
- TypeScript strict with `noUncheckedIndexedAccess`; Biome (2 spaces, double quotes, 110 cols).
  Rust: rustfmt (110 cols), clippy pedantic as warnings, `-D warnings` in the gate, no `unsafe`.
  Python: ruff (110 cols), pytest.
- Pin exact dependency versions (bun `exact = true`, `=` in Cargo for wasm-bindgen, `==` in
  pyproject). Check the installed package's types or docs rather than assuming an API. The
  `wasm-bindgen` crate, the nix `wasm-bindgen-cli_*` package and CI's `wasm-bindgen@…` move together.
- Package scope `@kompass/*`; crates `kompass-*`; env vars `KOMPASS_*`.
- The engine stays in Rust; the web app talks to it only through the worker client
  (`startEngine()` / `call(method, params)`). A new query: a `kompass-core` function, a
  `kompass-wasm` export, a method in `EngineMethods`, a handler in `worker.ts`.
- Web: colours only via the theme tokens in `web/src/index.css`; the theme follows the system
  setting. Add shadcn components with `bunx shadcn@4.23.0 add <name>` in `web/`. Mobile first:
  check every screen at 390×844. The app must keep working from a sub-path (relative URLs only).
- Tests: light and purposeful. Logic gets unit tests next to its code (`cargo test`, `bun test`,
  pytest); each main flow one Playwright spec at both viewports.
- **Docs stay lightweight.** The code is the source of truth; `docs/` holds only high-level
  concepts that are tedious to derive from code (plus ADRs, design rounds, reports). Whoever builds
  a part updates `docs/` in the same PR and deletes the matching section of `ARCHITECTURE.md` (a
  bootstrap document being retired).

## Workflow

- How a feature goes from idea to merged PRs: the `playbook` skill. Issues, epics, subtasks and
  iterations (milestones): the `issue-tracker` skill.
- One branch and PR per change, against `main`, in the iteration's milestone. PRs are
  squash-merged, so the PR title must be a Conventional Commit (`feat(web): …`, `fix(engine): …`,
  `docs: …`; checked by `pr-title.yml`). Commit in logical steps; never secrets.
- Every change lands with evidence: the gate, an e2e for main flows, and for anything visible a
  screenshot at 390×844 in the PR (privacy rules apply to screenshots too).
- The git identity is already set; don't change it. Commits by agents end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
