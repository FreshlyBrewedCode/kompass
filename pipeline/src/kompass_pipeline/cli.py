"""`kompass-pipeline`: region config -> `edges.parquet`, map tiles and manifest.

kompass-pipeline build --region data/region.local.json --out data/build/<name>
kompass-pipeline <stage> --region ... --out ...     one stage (clip, edges, context, elevation,
                                                    graph, finalize, overlay, basemap, manifest)
kompass-pipeline docs [--write]                     check / regenerate docs/edges-parquet.md tables
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import build as pipeline
from . import docs
from .config import Region
from .tools import MissingTool


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="kompass-pipeline", description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    def with_build_args(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--region", type=Path, required=True, help="region config (JSON), kept local")
        sp.add_argument("--out", type=Path, required=True, help="output directory, e.g. data/build/<name>")
        sp.add_argument(
            "--data-dir", type=Path, help="cache for OSM and DEM downloads (default: the config's folder)"
        )
        sp.add_argument(
            "--force", action="store_true", help="redo stages even if their outputs are up to date"
        )
        sp.add_argument(
            "--protomaps-build", help="Protomaps build key for the base map (default: the latest)"
        )

    with_build_args(sub.add_parser("build", help="run all stages (resumable)"))
    for stage in pipeline.STAGES:
        with_build_args(sub.add_parser(stage.name, help=stage.doc))
    d = sub.add_parser("docs", help="check docs/edges-parquet.md against the schema")
    d.add_argument("--write", action="store_true", help="rewrite the generated tables")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.cmd == "docs":
        return docs.main(write=args.write)
    b = pipeline.Build(
        region=Region.load(args.region),
        config_path=args.region,
        out=args.out,
        data_dir=args.data_dir or args.region.resolve().parent,
        force=args.force,
        protomaps_build=args.protomaps_build,
    )
    try:
        pipeline.run_stages(b, None if args.cmd == "build" else [args.cmd])
    except MissingTool as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
