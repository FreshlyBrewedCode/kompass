"""Stage 6: graph-level attributes: connected components (tiny ones pruned) and bridges.

Usage: python graph.py <build_dir> [min_component_km]
Graph = all edges in edges_raw.parquet, undirected (no access filtering: legal access is a
profile decision, so a profile that excludes private ways sees more dead ends than reported here).
Output graph.parquet (same order): component id, keep flag, bridge flag, pocket_km/pocket_dir:
for a bridge, the edge-km of the smaller side once the bridge is cut (a dead-end pocket), and on
which end of the edge that side hangs (+1 beyond node_to, -1 beyond node_from).
"""
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components


def bridges(n_nodes, u, v, w):
    """Iterative Tarjan bridge finding on an undirected multigraph. Returns (is_bridge,
    child_node_of_tree_edge or -1, subtree_weight per node) where subtree_weight sums `w` of the
    edges hanging below each node in the DFS tree (each edge counted at its deeper endpoint)."""
    m = len(u)
    deg = np.bincount(np.concatenate([u, v]), minlength=n_nodes)
    start = np.concatenate([[0], np.cumsum(deg)])
    adj_node = np.empty(2 * m, np.int64)
    adj_edge = np.empty(2 * m, np.int64)
    order = np.argsort(np.concatenate([u, v]), kind="stable")
    adj_node[:] = np.concatenate([v, u])[order]
    adj_edge[:] = np.concatenate([np.arange(m), np.arange(m)])[order]
    start, adj_node, adj_edge = start.tolist(), adj_node.tolist(), adj_edge.tolist()
    wl = w.tolist()

    disc = [-1] * n_nodes
    low = [0] * n_nodes
    sub = [0.0] * n_nodes
    is_bridge = [False] * m
    child_of = [-1] * m
    t = 0
    for root in range(n_nodes):
        if disc[root] != -1:
            continue
        disc[root] = low[root] = t
        t += 1
        stack = [(root, -1, start[root])]
        while stack:
            node, pedge, i = stack[-1]
            if i < start[node + 1]:
                stack[-1] = (node, pedge, i + 1)
                nb, e = adj_node[i], adj_edge[i]
                if e == pedge:
                    continue
                if disc[nb] == -1:
                    disc[nb] = low[nb] = t
                    t += 1
                    child_of[e] = nb
                    sub[nb] += wl[e]
                    stack.append((nb, e, start[nb]))
                elif disc[nb] < disc[node]:  # back edge to an ancestor, count it at `node`
                    sub[node] += wl[e]
                    if disc[nb] < low[node]:
                        low[node] = disc[nb]
            else:
                stack.pop()
                if stack:
                    parent = stack[-1][0]
                    sub[parent] += sub[node]
                    if low[node] < low[parent]:
                        low[parent] = low[node]
                    if low[node] > disc[parent]:
                        is_bridge[pedge] = True
    return np.array(is_bridge), np.array(child_of), np.array(sub)


def main(build, min_km=1.0):
    build = Path(build)
    t0 = time.time()
    e = pd.read_parquet(build / "edges_raw.parquet", columns=["node_from", "node_to", "length_m"])
    nodes, inv = np.unique(np.concatenate([e.node_from.values, e.node_to.values]), return_inverse=True)
    m = len(e)
    u, v = inv[:m], inv[m:]
    n = len(nodes)
    g = coo_matrix((np.ones(m), (u, v)), shape=(n, n))
    ncomp, comp_node = connected_components(g, directed=False)
    comp = comp_node[u]
    comp_km = np.bincount(comp, weights=e.length_m.values, minlength=ncomp) / 1000
    keep = comp_km[comp] >= min_km
    t1 = time.time()
    big = np.argmax(comp_km)
    print(f"{n} nodes, {m} edges, {ncomp} components ({t1 - t0:.1f}s); largest {comp_km[big]:.0f} km "
          f"= {comp_km[big] / comp_km.sum():.3%}; components < {min_km} km: {(comp_km < min_km).sum()} "
          f"holding {(~keep).sum()} edges / {comp_km[comp_km < min_km].sum():.0f} km", flush=True)

    w = e.length_m.values.astype(np.float64)
    is_bridge, child, sub = bridges(n, u, v, w)
    t2 = time.time()
    total = comp_km[comp] * 1000
    below = np.where(child >= 0, sub[np.maximum(child, 0)] - w, 0.0)  # side beyond the child
    other = total - below - w
    pocket = np.where(is_bridge, np.minimum(below, other), np.nan)
    beyond_child = below <= other
    child_is_to = child == v
    pocket_dir = np.where(is_bridge, np.where(beyond_child == child_is_to, 1, -1), 0)
    out = pd.DataFrame({
        "component": comp.astype(np.int32),
        "keep": keep,
        "bridge": is_bridge,
        "pocket_km": (pocket / 1000).astype(np.float32),
        "pocket_dir": pocket_dir.astype(np.int8),
    })
    out.to_parquet(build / "graph.parquet", compression="zstd")
    t3 = time.time()
    br = is_bridge & keep
    pk = pocket[br] / 1000
    print(f"bridges: {br.sum()} ({br.mean():.1%} of edges) in {t2 - t1:.1f}s; pocket size quantiles km "
          f"p50 {np.median(pk):.2f} p90 {np.quantile(pk, .9):.2f} p99 {np.quantile(pk, .99):.2f}; "
          f"edges hanging in pockets < 0.5 km: {(pk < 0.5).mean():.1%} of bridges", flush=True)
    print(f"total {t3 - t0:.1f}s", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], *(float(a) for a in sys.argv[2:3]))
