"""Stage `manifest`: `manifest.json`, the web app's entry point into a build.

Bounds and centre come from the gitignored region config; the manifest lives in the gitignored
build directory, never in the repo.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from . import schema, tiles
from .config import Region

MANIFEST_VERSION = 1


def build(region: Region, build_id: str | None, built_at: datetime | None = None) -> dict:
    west, south, east, north = region.bounds()
    return {
        "schemaVersion": MANIFEST_VERSION,
        "buildId": build_id,
        "builtAt": (built_at or datetime.now(UTC)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bounds": [round(west, 5), round(south, 5), round(east, 5), round(north, 5)],
        "center": [region.lon, region.lat],
        "basemap": {"file": "basemap.pmtiles", "maxzoom": tiles.BASEMAP_MAXZOOM},
        "overlay": {
            "file": "overlay.pmtiles",
            "layer": tiles.LAYER,
            "minzoom": tiles.OVERLAY_MINZOOM,
            "maxzoom": tiles.OVERLAY_MAXZOOM,
            "attributes": schema.overlay_manifest(),
        },
    }


def run(region: Region, edges: Path, out: Path) -> None:
    manifest = build(region, tiles.build_id_of(edges))
    tmp = out.with_name(out.name + ".part")
    tmp.write_text(json.dumps(manifest, indent=2) + "\n")
    tmp.replace(out)
