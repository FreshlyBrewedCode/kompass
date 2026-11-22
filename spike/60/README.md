# Spike #60 (never merged)

Hills curve data and the saturated clamp. The report: `docs/reports/2026-11-22-hills-and-saturation.md`
(on its own PR). Everything here reads the region builds and rides read-only and writes to `/tmp/spike60`.

- `grades.py` (run with `uv run --project pipeline python`): per edge, the DEM re-sampled as the pipeline
  does (checked against `edges.parquet`), grade histograms, arc lengths, the canopy noise on paved roads,
  a sample hills curve evaluated from what an arc carries against the histogram. `grades2.py`: the
  "split + steepest 50 m" evaluation by forest / open.
- `kompass spike60` (`engine/cli/src/spike60.rs`): seeded pairs, length at the floor, slider
  sensitivity (−100 / w − 25 / w + 25 / +100), `--personal` (an explored map), `--dump`/`--against`,
  `--time`.
- The cost model variants (`engine/core/src/cost.rs`): `KOMPASS_SPIKE_MODEL=groups|soft|groups_soft|norm`,
  `KOMPASS_SPIKE_MIN=<floor>`, `KOMPASS_SPIKE_HILLS="pts=g:c,...;loose=N"` (replaces climb, steep, ramps);
  `KOMPASS_SPIKE_PERSONAL=<explored.json>` for `kompass replay`.
- `batch*.sh`: the runs of the report; `summ.py`: the slider tables.
