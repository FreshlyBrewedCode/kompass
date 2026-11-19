"""Edge geometries as metric vertex arrays and evenly spaced samples along the edges.

The context and elevation joins work on samples (every `step` metres, endpoints included), so they
are plain array lookups instead of polygon or line intersections.
"""

from __future__ import annotations

import numpy as np
import shapely
from pyproj import Transformer


def vertices(wkb, crs: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(x, y, part): the vertices of WGS84 WKB line strings in the metric `crs`, and the index of the
    edge each vertex belongs to."""
    geoms = shapely.from_wkb(wkb)
    coords, part = shapely.get_coordinates(geoms, return_index=True)
    x, y = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform(coords[:, 0], coords[:, 1])
    return np.asarray(x), np.asarray(y), part


def sample(x, y, part, n_edges: int, step: float = 10.0):
    """Returns (sx, sy, sedge, sd, w, length): sample coordinates, edge index, distance along the
    edge, a trapezoid weight (endpoints count half, so weighted means are length shares), and the
    metric length of every edge."""
    seg = np.hypot(np.diff(x), np.diff(y))
    seg[part[1:] != part[:-1]] = 0.0
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    first = np.searchsorted(part, np.arange(n_edges))
    last = np.concatenate([first[1:], [len(part)]]) - 1
    length = cum[last] - cum[first]
    n = np.maximum(1, np.ceil(length / step).astype(np.int64))  # intervals per edge
    sedge = np.repeat(np.arange(n_edges), n + 1)
    k = np.arange(sedge.size) - np.repeat(np.concatenate([[0], np.cumsum(n + 1)[:-1]]), n + 1)
    sd = k / n[sedge] * length[sedge]
    # One global monotone distance for np.interp: edges are separated by nudging by edge index.
    eps = 1e-6
    g = cum + part * eps
    sg = cum[first][sedge] + sd + sedge * eps
    sg = np.minimum(sg, cum[last][sedge] + sedge * eps)
    sx = np.interp(sg, g, x)
    sy = np.interp(sg, g, y)
    w = np.ones(sedge.size)
    w[k == 0] = 0.5
    w[k == n[sedge]] = 0.5
    return sx, sy, sedge, sd, w, length


def weighted_share(flag, sedge, w, n_edges: int) -> np.ndarray:
    num = np.bincount(sedge, weights=w * flag, minlength=n_edges)
    den = np.bincount(sedge, weights=w, minlength=n_edges)
    return num / np.maximum(den, 1e-9)
