"""Cached downloads."""

from __future__ import annotations

import shutil
import urllib.request
from pathlib import Path


def download(url: str, dest: Path) -> Path:
    """Downloads to `dest` atomically (a `.part` file renamed at the end); skips existing files."""
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    print(f"  downloading {url}", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "kompass-pipeline"})
    with urllib.request.urlopen(req) as resp, part.open("wb") as f:
        shutil.copyfileobj(resp, f, length=1 << 20)
    part.rename(dest)
    return dest
