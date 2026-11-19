"""Shared helper: edge geometries -> metric vertex arrays and evenly spaced samples along edges.

All context and elevation joins work on samples (every `step` metres, endpoints included), so
they are plain array lookups instead of polygon/line intersections.
"""
import numpy as np
import shapely
from pyproj import Transformer

CRS = "EPSG:25832"  # ETRS89 / UTM 32N: metric, good across Germany west of ~13 deg E


def vertices(wkb):
    geoms = shapely.from_wkb(wkb)
    coords, part = shapely.get_coordinates(geoms, return_index=True)
    x, y = Transformer.from_crs("EPSG:4326", CRS, always_xy=True).transform(coords[:, 0], coords[:, 1])
    return x, y, part


def sample(x, y, part, n_edges, step=10.0):
    """Returns (sx, sy, sedge, sd, w): sample coords, edge index, distance along the edge, and a
    trapezoid weight (endpoints count half) so weighted means are length shares."""
    seg = np.hypot(np.diff(x), np.diff(y))
    seg[part[1:] != part[:-1]] = 0.0
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    first = np.searchsorted(part, np.arange(n_edges))
    last = np.concatenate([first[1:], [len(part)]]) - 1
    length = cum[last] - cum[first]
    n = np.maximum(1, np.ceil(length / step).astype(np.int64))  # intervals per edge
    sedge = np.repeat(np.arange(n_edges), n + 1)
    k = np.arange(sedge.size) - np.repeat(np.concatenate([[0], np.cumsum(n + 1)[:-1]]), n + 1)
    frac = k / n[sedge]
    sd = frac * length[sedge]
    # Global monotone distance: each edge occupies [cum[first], cum[last]]; edges are separated
    # because the zeroed boundary segment repeats a value, so nudge vertices by edge index.
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


def weighted_share(flag, sedge, w, n_edges):
    num = np.bincount(sedge, weights=w * flag, minlength=n_edges)
    den = np.bincount(sedge, weights=w, minlength=n_edges)
    return num / np.maximum(den, 1e-9)
