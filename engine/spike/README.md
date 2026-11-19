# Spike #4: engine route speed, native and WebAssembly

Throwaway measuring code for issue #4. The verdict is the closing comment of the issue; this branch
is tagged `spike/4`. The reusable parts live in `kompass-core` (`graph`, `profile`, `search`,
`spatial`, `bench`) and are the starting point for the real engine.

- `kompass-spike` (this crate, native only, reads parquet):
  - `compile <edges.parquet> <out>`: binary graph `graph.kmpg`, `geometry.kmpg`, tiles `tiles-z{10,11,12}/`,
    sizes raw / gzip / brotli per file, per column and per tile set
  - `bench <out> [pairs]`: profile compile, landmarks (`landmarks8.u16`), the route benchmark, the
    `min_factor` sweep
  - `tiles <out>`: tiles a 50 / 100 km route touches, corridor preload
  - `spatial <out>`: nearest-edge grid build, memory, query time
- `kompass-wasm::spike::SpikeEngine` + `web/`: the same benchmark in headless Chromium, in a Web
  Worker, and on the main thread under DevTools CPU throttling (which doesn't reach workers).

```sh
nix develop
cd engine && cargo build --release -p kompass-spike
D=../data/build/spike4   # gitignored
./target/release/kompass-spike compile ../data/build/spike3/edges.parquet $D
./target/release/kompass-spike bench $D 100
./target/release/kompass-spike tiles $D
./target/release/kompass-spike spatial $D
cd .. && bun run build:wasm
gzip -6 -k $D/graph.kmpg $D/landmarks8.u16 $D/tiles-z10/*.kmpg
bun engine/spike/web/serve.ts --port 7960 --data $D &   # stop it by PID afterwards
bun engine/spike/web/drive.ts --mode spin                    # does throttling reach the worker?
bun engine/spike/web/drive.ts --mode bench --where worker --out $D/wasm-worker-x1.json
bun engine/spike/web/drive.ts --mode load --source tiles-z10 --out $D/wasm-load-tiles-z10.json
bun engine/spike/web/drive.ts --mode bench --where main --rate 4 --algos astar,bidi,alt-bidi,astar-lazy --out $D/wasm-main-x4.json
```

Benchmark pairs are seeded random node pairs filtered by straight-line distance, generated at run
time; no coordinates are written anywhere.
