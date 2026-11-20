# pipeline

Python (uv): the region build, from the local region config to `edges.parquet`, the map tiles and
`manifest.json`. Run locally and offline (downloads are cached under the gitignored `data/`).
Concepts: [docs/pipeline.md](../docs/pipeline.md) and [docs/edges-parquet.md](../docs/edges-parquet.md).

```sh
uv run kompass-pipeline build --region data/region.local.json --out data/build/<name>
uv run kompass-pipeline <stage> --region … --out …   # clip edges context elevation graph finalize overlay basemap manifest
uv run kompass-pipeline docs --write                 # regenerate the column tables in docs/edges-parquet.md
```

`bun run check:pipeline` runs ruff and pytest (no network; tests that need tippecanoe skip without it).
