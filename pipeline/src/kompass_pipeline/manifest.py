"""Stage `manifest`: `manifest.json`, the web app's entry point into a build.

Bounds and centre come from the gitignored region config; the manifest lives in the gitignored
build directory, never in the repo.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from . import schema, terrain, tiles
from .config import Region

MANIFEST_VERSION = 1


def terrain_entry(contours: bool) -> dict:
    entry: dict = {
        "file": "terrain.pmtiles",
        "encoding": "terrarium",
        "tileSize": terrain.TILE,
        "minzoom": terrain.DEM_MINZOOM,
        "maxzoom": terrain.DEM_MAXZOOM,
    }
    if contours:
        entry["contours"] = {
            "file": "contours.pmtiles",
            "layer": terrain.CONTOUR_LAYER,
            "minzoom": terrain.CONTOUR_MINZOOM,
            "maxzoom": terrain.CONTOUR_MAXZOOM,
        }
    return entry


def build(
    region: Region,
    build_id: str | None,
    built_at: datetime | str | None = None,
    *,
    has_terrain: bool = False,
    has_contours: bool = False,
) -> dict:
    west, south, east, north = region.bounds()
    if not isinstance(built_at, str):
        built_at = (built_at or datetime.now(UTC)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "schemaVersion": MANIFEST_VERSION,
        "buildId": build_id,
        "builtAt": built_at,
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
        "terrain": terrain_entry(has_contours) if has_terrain else None,
    }


def previous_built_at(out: Path, build_id: str | None) -> str | None:
    """`builtAt` of the manifest already there, if it describes the same edges: rewriting the manifest
    (e.g. after adding the terrain) must not look like a new graph to what is matched against it."""
    try:
        old = json.loads(out.read_text())
    except (OSError, ValueError):
        return None
    same = build_id is not None and isinstance(old, dict) and old.get("buildId") == build_id
    return old.get("builtAt") if same and isinstance(old.get("builtAt"), str) else None


def run(region: Region, build_dir: Path, out: Path) -> None:
    build_id = tiles.build_id_of(build_dir / "edges.parquet")
    manifest = build(
        region,
        build_id,
        previous_built_at(out, build_id),
        has_terrain=(build_dir / "terrain.pmtiles").exists(),
        has_contours=(build_dir / "contours.pmtiles").exists(),
    )
    tmp = out.with_name(out.name + ".part")
    tmp.write_text(json.dumps(manifest, indent=2) + "\n")
    tmp.replace(out)
