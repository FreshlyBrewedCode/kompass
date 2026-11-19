"""External command line tools (from the nix dev shell): find them or fail with a clear message."""

from __future__ import annotations

import shutil
import subprocess
from collections.abc import Sequence

HINTS = {
    "osmium": "osmium-tool",
    "tippecanoe": "tippecanoe",
    "pmtiles": "pmtiles",
    "gdalwarp": "gdal",
    "gdalbuildvrt": "gdal",
}


class MissingTool(RuntimeError):
    pass


def have(name: str) -> bool:
    return shutil.which(name) is not None


def require(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        raise MissingTool(
            f"`{name}` not found on PATH. It comes from the nix dev shell (package "
            f"`{HINTS.get(name, name)}`): run inside `nix develop`."
        )
    return path


def run(cmd: Sequence[str], **kw) -> subprocess.CompletedProcess:
    """Runs a tool (looked up first), raising on a non-zero exit."""
    require(cmd[0])
    return subprocess.run([str(c) for c in cmd], check=True, **kw)
