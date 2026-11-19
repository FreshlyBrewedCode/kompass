"""Stage `graph`: connected components of the edge graph; tiny ones are pruned.

The graph is all edges, undirected, with no access filtering (legal access is a profile decision).
Components smaller than `min_km` (fragments at the clip's rim, isolated private or service bits)
are marked for removal. Dead ends (bridges, pockets) depend on the profile's hard constraints, so
the engine finds them, not the pipeline.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

MIN_COMPONENT_KM = 1.0


def components(
    node_from: np.ndarray, node_to: np.ndarray, length_m: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """(component id per edge, total length in km per component)."""
    nodes, inv = np.unique(np.concatenate([node_from, node_to]), return_inverse=True)
    m = len(node_from)
    u, v = inv[:m], inv[m:]
    g = coo_matrix((np.ones(m), (u, v)), shape=(len(nodes), len(nodes)))
    ncomp, comp_node = connected_components(g, directed=False)
    comp = comp_node[u]
    km = np.bincount(comp, weights=length_m, minlength=ncomp) / 1000
    return comp, km


def run(raw: Path, out: Path, min_km: float = MIN_COMPONENT_KM, log=print) -> None:
    e = pd.read_parquet(raw, columns=["node_from", "node_to", "length_m"])
    comp, km = components(
        e.node_from.to_numpy(), e.node_to.to_numpy(), e.length_m.to_numpy().astype(np.float64)
    )
    keep = km[comp] >= min_km
    big = int(np.argmax(km))
    log(
        f"  {len(km)} components; largest {km[big]:.0f} km = {km[big] / km.sum():.2%}; "
        f"pruned {(km < min_km).sum()} components < {min_km} km "
        f"({(~keep).sum()} edges, {km[km < min_km].sum():.0f} km)"
    )
    pd.DataFrame({"component": comp.astype(np.int32), "keep": keep}).to_parquet(out, compression="zstd")
