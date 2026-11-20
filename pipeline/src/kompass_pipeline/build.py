"""The stage list, its inputs and outputs, and resumable execution.

A stage is skipped when all its outputs exist and are newer than all its inputs (`--force` redoes
it). A stage that follows a re-run one sees newer inputs and re-runs too, so a plain `build` after a
change only redoes what the change touches. Intermediates live in `<out>/work/`.
"""

from __future__ import annotations

import resource
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from . import clip, context, dem_glo30, elevation, finalize, graph, manifest, terrain, tiles, ways
from .config import Region
from .elevation import ElevationFn


@dataclass
class Build:
    region: Region
    config_path: Path
    out: Path
    data_dir: Path
    force: bool = False
    protomaps_build: str | None = None
    #: the DEM to use; the default opens Copernicus GLO-30 (tests and other DEMs pass their own)
    elevation_source: Callable[[Build], ElevationFn] | None = None

    @property
    def work(self) -> Path:
        return self.out / "work"

    def w(self, name: str) -> Path:
        return self.work / name

    def raster_bounds(self) -> tuple[float, float, float, float]:
        r = self.region.radius_km * 1000 + 500  # the metric CRS is centred on the region
        return (-r, -r, r, r)


@dataclass(frozen=True)
class Stage:
    name: str
    doc: str
    inputs: Callable[[Build], list[Path]]
    outputs: Callable[[Build], list[Path]]
    run: Callable[[Build], None]


def _clip(b: Build) -> None:
    clip.run(b.region, b.data_dir / "osm", b.work)


def _edges(b: Build) -> None:
    ways.run(b.w("region.osm.pbf"), b.region.crs, b.w("edges_raw.parquet"))


def _context(b: Build) -> None:
    features = context.prepare(b.w("region.osm.pbf"), b.work)
    context.run(b.w("edges_raw.parquet"), features, b.region.crs, b.raster_bounds(), b.w("context.parquet"))
    for f in (features, b.w("context.osm.pbf")):
        f.unlink(missing_ok=True)


def _elevation(b: Build) -> None:
    source = (b.elevation_source or _glo30)(b)
    elevation.run(b.w("edges_raw.parquet"), b.region.crs, source, b.w("elevation.parquet"))


def _glo30(b: Build) -> ElevationFn:
    return dem_glo30.open_glo30(b.region, b.data_dir / "dem" / "glo30", b.work)


def _terrain(b: Build) -> None:
    source = (b.elevation_source or _glo30)(b)
    terrain.run(b.region, source, b.work, b.out / "terrain.pmtiles", b.out / "contours.pmtiles")


def _graph(b: Build) -> None:
    graph.run(b.w("edges_raw.parquet"), b.w("graph.parquet"))


def _finalize(b: Build) -> None:
    finalize.run(
        b.w("edges_raw.parquet"),
        b.w("context.parquet"),
        b.w("elevation.parquet"),
        b.w("graph.parquet"),
        b.out / "edges.parquet",
    )


STAGES: tuple[Stage, ...] = (
    Stage(
        "clip",
        "merge the covering Geofabrik extracts and clip them to the region disk",
        lambda b: [b.config_path],
        lambda b: [b.w("region.osm.pbf"), b.w("region.geojson")],
        _clip,
    ),
    Stage(
        "edges",
        "ways to edges: filter, split at junctions, geometry, raw tags",
        lambda b: [b.w("region.osm.pbf")],
        lambda b: [b.w("edges_raw.parquet")],
        _edges,
    ),
    Stage(
        "context",
        "forest / water / built-up / motor-road shares per edge",
        lambda b: [b.w("region.osm.pbf"), b.w("edges_raw.parquet")],
        lambda b: [b.w("context.parquet")],
        _context,
    ),
    Stage(
        "elevation",
        "elevation profiles per edge (Copernicus GLO-30)",
        lambda b: [b.w("edges_raw.parquet")],
        lambda b: [b.w("elevation.parquet")],
        _elevation,
    ),
    Stage(
        "graph",
        "connected components; tiny ones are pruned",
        lambda b: [b.w("edges_raw.parquet")],
        lambda b: [b.w("graph.parquet")],
        _graph,
    ),
    Stage(
        "finalize",
        "join everything, Hilbert sort, write edges.parquet",
        lambda b: [
            b.w(n) for n in ("edges_raw.parquet", "context.parquet", "elevation.parquet", "graph.parquet")
        ],
        lambda b: [b.out / "edges.parquet"],
        _finalize,
    ),
    Stage(
        "overlay",
        "overlay.pmtiles: the edges as vector tiles with ids and attributes",
        lambda b: [b.out / "edges.parquet"],
        lambda b: [b.out / "overlay.pmtiles"],
        lambda b: tiles.overlay(b.out / "edges.parquet", b.work, b.out / "overlay.pmtiles"),
    ),
    Stage(
        "basemap",
        "basemap.pmtiles: the Protomaps build cut to the region (needs network)",
        lambda b: [b.w("region.geojson")],
        lambda b: [b.out / "basemap.pmtiles"],
        lambda b: tiles.basemap(b.w("region.geojson"), b.out / "basemap.pmtiles", b.protomaps_build),
    ),
    Stage(
        "terrain",
        "terrain.pmtiles (raster DEM for the hillshade) and contours.pmtiles",
        lambda b: [b.config_path],
        lambda b: [b.out / "terrain.pmtiles", b.out / "contours.pmtiles"],
        _terrain,
    ),
    Stage(
        "manifest",
        "manifest.json for the web app",
        # the terrain is optional: the manifest lists it when it is there
        lambda b: [
            b.config_path,
            b.out / "edges.parquet",
            b.out / "terrain.pmtiles",
            b.out / "contours.pmtiles",
        ],
        lambda b: [b.out / "manifest.json"],
        lambda b: manifest.run(b.region, b.out, b.out / "manifest.json"),
    ),
)
BY_NAME = {s.name: s for s in STAGES}


def up_to_date(inputs: list[Path], outputs: list[Path]) -> bool:
    if not all(p.exists() for p in outputs):
        return False
    newest_input = max((p.stat().st_mtime_ns for p in inputs if p.exists()), default=0)
    return min(p.stat().st_mtime_ns for p in outputs) >= newest_input


def peak_rss_gb() -> float:
    """Peak resident memory of this process and its tool children so far."""
    mine = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    kids = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    return max(mine, kids) / 1024 / 1024  # kB on Linux


def run_stage(b: Build, stage: Stage) -> bool:
    """Runs one stage unless it is up to date; returns whether it ran."""
    b.work.mkdir(parents=True, exist_ok=True)
    if not b.force and up_to_date(stage.inputs(b), stage.outputs(b)):
        print(f"== {stage.name}: up to date", flush=True)
        return False
    print(f"== {stage.name}: {stage.doc}", flush=True)
    t0 = time.time()
    stage.run(b)
    print(f"   done in {time.time() - t0:.0f}s, peak RSS so far {peak_rss_gb():.1f} GB", flush=True)
    return True


def run_stages(b: Build, names: list[str] | None = None) -> None:
    for stage in STAGES:
        if names is None or stage.name in names:
            run_stage(b, stage)
