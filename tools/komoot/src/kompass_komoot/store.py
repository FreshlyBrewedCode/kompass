"""The output directory: one GPX per tour plus `index.json`."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

INDEX_NAME = "index.json"
INDEX_VERSION = 1


def find_repo_root(start: Path) -> Path:
    """The nearest ancestor with a `.git` (a directory, or a file in a worktree); `start` if none."""
    start = start.resolve()
    for candidate in (start, *start.parents):
        if (candidate / ".git").exists():
            return candidate
    return start


def default_out_dir(start: Path) -> Path:
    return find_repo_root(start) / "data" / "tracks" / "komoot"


def gpx_name(date: str, tour_id: str | int) -> str:
    """`<YYYY-MM-DD>_<tour id>.gpx`; the date is the tour's own (local) date."""
    return f"{date[:10]}_{tour_id}.gpx"


def _write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".part")
    tmp.write_bytes(data)
    os.replace(tmp, path)


class Store:
    def __init__(self, out_dir: Path) -> None:
        self.out_dir = out_dir
        self._index_path = out_dir / INDEX_NAME
        self.entries: dict[str, dict[str, Any]] = {}
        if self._index_path.exists():
            data = json.loads(self._index_path.read_text(encoding="utf-8"))
            self.entries = {str(e["id"]): e for e in data.get("tours", [])}

    def has(self, tour_id: str | int) -> bool:
        """Already downloaded: in the index and its file still exists."""
        entry = self.entries.get(str(tour_id))
        return entry is not None and (self.out_dir / entry["file"]).is_file()

    def add(self, entry: dict[str, Any], gpx: bytes) -> None:
        """Write the GPX, then record it in the index (both atomically, so an interrupt loses nothing)."""
        self.out_dir.mkdir(parents=True, exist_ok=True)
        _write_atomic(self.out_dir / entry["file"], gpx)
        self.entries[str(entry["id"])] = entry
        tours = sorted(self.entries.values(), key=lambda e: (e["date"], str(e["id"])))
        payload = {"version": INDEX_VERSION, "tours": tours}
        _write_atomic(self._index_path, (json.dumps(payload, indent=2, ensure_ascii=False) + "\n").encode())
