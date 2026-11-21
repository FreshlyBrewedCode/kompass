"""Tile sizes of a PMTiles archive per zoom: `python -m kompass_pipeline.tilestats <file.pmtiles>...`.

Sizes are the stored (gzip) bytes of the tiles. Used to check the overlay's tile sizes after a build
(docs/pipeline.md): the largest tile per zoom is what a phone downloads in the worst case.
"""

from __future__ import annotations

import gzip
import struct
import sys
from collections import defaultdict
from pathlib import Path

HEADER = 127


def _varint(buf: bytes, i: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        byte = buf[i]
        i += 1
        value |= (byte & 127) << shift
        shift += 7
        if byte < 128:
            return value, i


def _entries(buf: bytes) -> list[tuple[int, int, int, int]]:
    """(tile id, run length, length, offset) of a directory (PMTiles v3, offsets are explicit)."""
    n, i = _varint(buf, 0)
    ids, last = [], 0
    for _ in range(n):
        d, i = _varint(buf, i)
        last += d
        ids.append(last)
    runs, lens, offs = [], [], []
    for out in (runs, lens, offs):
        for _ in range(n):
            v, i = _varint(buf, i)
            out.append(v)
    # an offset of 0 means "right after the previous entry"
    pos = 0
    for k in range(n):
        offs[k] = pos if offs[k] == 0 and k > 0 else offs[k] - 1
        pos = offs[k] + lens[k]
    return list(zip(ids, runs, lens, offs, strict=True))


def _zoom(tile_id: int) -> int:
    z = 0
    while tile_id >= (4 ** (z + 1) - 1) // 3:
        z += 1
    return z


def tile_sizes(path: Path) -> dict[int, list[int]]:
    """Per zoom the stored byte size of each tile."""
    with path.open("rb") as f:
        head = f.read(HEADER)
        if head[:7] != b"PMTiles" or head[7] != 3:
            raise ValueError(f"{path} is not a PMTiles v3 archive")
        root_off, root_len, _, _, leaf_off, _ = struct.unpack_from("<6Q", head, 8)
        gz = head[97] == 2  # internal compression

        def read(off: int, length: int) -> bytes:
            f.seek(off)
            data = f.read(length)
            return gzip.decompress(data) if gz else data

        sizes: dict[int, list[int]] = defaultdict(list)

        def walk(off: int, length: int) -> None:
            for tile_id, run, ln, o in _entries(read(off, length)):
                if run == 0:
                    walk(leaf_off + o, ln)
                else:
                    sizes[_zoom(tile_id)].extend([ln] * run)

        walk(root_off, root_len)
    return dict(sorted(sizes.items()))


def report(path: Path) -> str:
    rows = ["zoom  tiles  max KB  mean KB  total KB"]
    for z, s in tile_sizes(path).items():
        mean = sum(s) / len(s)
        rows.append(f"{z:>4} {len(s):>6} {max(s) / 1024:7.1f} {mean / 1024:8.1f} {sum(s) / 1024:9.0f}")
    rows.append(f"file: {path.stat().st_size / 1024 / 1024:.2f} MB")
    return "\n".join(rows)


if __name__ == "__main__":
    for p in sys.argv[1:]:
        print(p)
        print(report(Path(p)))
