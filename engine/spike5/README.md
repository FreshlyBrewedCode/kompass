# Spike #5: map-matching recorded rides onto the graph

Measuring code for issue #5. The verdict is the closing comment of the issue; this branch is tagged
`spike/5`. The matcher itself is core-quality and the starting point for the real one:
`kompass-core::matching` (HMM after Newson & Krumm, unit-tested on synthetic grids).

- `kompass match --build <dir> [options] <gpx…>` (`engine/cli/src/matchcmd.rs`, GPX reader in
  `gpx.rs`): matches tracks and prints aggregates. `--out <dir>` writes one JSON per track (pieces,
  unmatched stretches, counters), `--svg <dir>` debug pictures (`--svg-at <json>` for chosen
  windows), `--unmatched-out <file>` the unmatched stretches' points, `--points-out <dir>` the points
  as f64 pairs for the browser bench. Parameters: `--radius --candidates --sigma --beta --step --skip
  --gap --detour-factor --detour-slack --oneway-penalty --spur`; `--no-geometry`, `--reverse`,
  `--offset <n>` (drop the first n points: a different thinning phase).
- `analyze.py` (stdlib only): `summary`, `compare` (two runs: edge/arc agreement), `explored`
  (fold into per-edge count and last ridden, optionally writing `explored.json`); with
  `KOMPASS_SPIKE_METRICS=1` one line of metrics for a run and its reversed run.
- `osm_check.py`: what lies under the unmatched stretches in the region's OSM extract (a kept way,
  a dropped one, nothing).
- `render.ts`, `sheet.ts`: debug SVGs to PNGs and contact sheets (headless Chromium).
- `web/` + `kompass-wasm::spike5::MatchEngine`: the matcher in Chromium, in a Web Worker and on the
  main thread under DevTools CPU throttling (which does not reach workers).

**Privacy.** Every output above except the printed aggregates holds the user's real tracks (edge ids,
coordinates, file names). Write them only to the gitignored `data/` or a temporary directory.

```sh
nix develop
cd engine && cargo build --release -p kompass-cli && cd ..
B=data/build/region; S=data/build/spike5   # gitignored
engine/target/release/kompass match --build $B --out $S/main --unmatched-out /tmp/kompass-5/unmatched.jsonl data/tracks/komoot/*.gpx
engine/target/release/kompass match --build $B --out $S/rev --reverse data/tracks/komoot/*.gpx
python3 engine/spike5/analyze.py summary $S/main
python3 engine/spike5/analyze.py compare $S/main $S/rev --reversed
python3 engine/spike5/analyze.py explored $S/main --out $S/explored.json --build-id <graph build id>
uv run --project pipeline python engine/spike5/osm_check.py /tmp/kompass-5/unmatched.jsonl $B/work/region.osm.pbf
bun run build:wasm
engine/target/release/kompass match --build $B --points-out /tmp/kompass-5/pts <a few gpx>
bun engine/spike5/web/serve.ts --port 7960 --data $B --pts /tmp/kompass-5/pts &   # stop it by PID
bun engine/spike5/web/drive.ts --port 7960 --tracks 0,1,2 --repeat 3
bun engine/spike5/web/drive.ts --port 7960 --tracks 0,1,2 --where main --rate 6
```
