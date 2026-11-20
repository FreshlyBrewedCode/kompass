"""The engine's end-to-end fixture: the village as `edges.parquet`, committed at
`engine/compile/tests/fixtures/village/edges.parquet` and compiled by the engine's tests. This test
fails when the pipeline would write something else, so the two cannot drift apart. Regenerate:

    cd pipeline && KOMPASS_WRITE_FIXTURES=1 uv run pytest tests/test_engine_fixture.py
"""

import os
import shutil
from pathlib import Path

import pyarrow.parquet as pq
from test_finalize import build_village_file

FIXTURE = Path(__file__).resolve().parents[2] / "engine/compile/tests/fixtures/village/edges.parquet"


def test_the_engine_fixture_is_what_the_pipeline_writes(village, tmp_path):
    out, _ = build_village_file(village, tmp_path)
    if os.environ.get("KOMPASS_WRITE_FIXTURES"):
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(out, FIXTURE)
    fresh, committed = pq.read_table(out), pq.read_table(FIXTURE)
    assert committed.schema.equals(fresh.schema, check_metadata=True), "regenerate the engine fixture"
    assert committed.equals(fresh), "regenerate the engine fixture (see the module docstring)"
