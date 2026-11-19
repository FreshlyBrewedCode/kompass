import numpy as np

from kompass_pipeline import graph


def test_components_and_pruning(village):
    comp, km = graph.components(
        village.node_from.to_numpy(), village.node_to.to_numpy(), village.length_m.to_numpy().astype(float)
    )
    isolated = village.way_id.to_numpy() == 23
    assert len(set(comp[isolated])) == 1
    assert comp[isolated][0] not in set(comp[~isolated])
    assert len(set(comp[~isolated])) == 1  # everything else hangs together
    assert km[comp[isolated][0]] < 0.2 and km[comp[~isolated][0]] > 3


def test_run_marks_tiny_components_for_removal(village, tmp_path):
    import pandas as pd
    import pyarrow as pa
    import pyarrow.parquet as pq

    raw = tmp_path / "raw.parquet"
    pq.write_table(pa.Table.from_pandas(village[["node_from", "node_to", "length_m"]]), raw)
    out = tmp_path / "graph.parquet"
    graph.run(raw, out, min_km=1.0, log=lambda *_: None)
    keep = pd.read_parquet(out)["keep"].to_numpy()
    assert keep.sum() == len(village) - 1
    assert not keep[np.flatnonzero(village.way_id.to_numpy() == 23)[0]]
