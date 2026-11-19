"""The schema module: round trip through parquet, metadata, overlay attributes, docs in sync."""

import json

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from kompass_pipeline import docs, schema


def test_columns_are_unique_and_documented():
    names = [c.name for c in schema.COLUMNS]
    assert len(names) == len(set(names))
    assert all(c.doc for c in schema.COLUMNS)
    assert names[0] == "edge_id" and names[-1] == "geometry"


def test_enum_codes_are_unique_and_fit_the_dtype():
    for c in schema.COLUMNS:
        if c.enum:
            codes = [code for code, _ in c.enum]
            labels = [label for _, label in c.enum]
            assert len(set(codes)) == len(codes) and len(set(labels)) == len(labels), c.name
            lo, hi = (-128, 127) if c.dtype == pa.int8() else (0, 255)
            assert lo <= min(codes) and max(codes) <= hi, c.name


def test_only_simple_dtypes():
    allowed = {
        pa.uint8(),
        pa.uint16(),
        pa.uint32(),
        pa.int8(),
        pa.int64(),
        pa.float32(),
        pa.bool_(),
        pa.string(),
        pa.binary(),
    }
    assert {c.dtype for c in schema.COLUMNS} <= allowed


def test_schema_round_trips_through_parquet_with_metadata(tmp_path):
    sch = schema.arrow_schema()
    arrays = []
    for field in sch:
        if field.type == pa.string():
            arrays.append(pa.array(["a", None], field.type))
        elif field.type == pa.binary():
            arrays.append(pa.array([b"\x01", b"\x02"], field.type))
        elif field.type == pa.bool_():
            arrays.append(pa.array([True, False]))
        else:
            arrays.append(pa.array(np.array([1, 0]), pa.int64()).cast(field.type))
    table = pa.Table.from_arrays(arrays, schema=sch.with_metadata(schema.file_metadata("abc123")))
    path = tmp_path / "e.parquet"
    pq.write_table(table, path, use_dictionary=[c.name for c in schema.COLUMNS if c.dictionary])

    back = pq.read_table(path)
    assert back.schema.equals(sch)  # types, names and nullability (metadata aside)
    meta = {k.decode(): v.decode() for k, v in pq.read_schema(path).metadata.items()}
    assert meta[schema.META_SCHEMA_VERSION] == str(schema.SCHEMA_VERSION)
    assert meta[schema.META_BUILD_ID] == "abc123"
    enums = json.loads(meta[schema.META_ENUMS])
    assert enums["surface_class"]["3"] == "compacted"
    assert enums["oneway_bike"]["-1"] == "against"


def test_overlay_attributes_point_at_real_columns():
    for a in schema.OVERLAY:
        assert all(s in schema.BY_NAME for s in a.source), a.key
        if a.kind == "enum":
            assert schema.BY_NAME[a.column].enum, a.key
        else:
            assert a.max is not None and a.min is not None, a.key
        assert a.kind in {"enum", "share", "number"}
    assert len({a.key for a in schema.OVERLAY}) == len(schema.OVERLAY)


def test_docs_page_is_in_sync_with_the_schema():
    assert docs.main(write=False) == 0, "run `kompass-pipeline docs --write`"


def test_docs_render_replaces_only_the_generated_block():
    page = f"intro\n{docs.BEGIN}\nold\n{docs.END}\noutro\n"
    new = docs.render(page)
    assert new.startswith("intro\n") and new.endswith("\noutro\n")
    assert "| `edge_id` |" in new and "old" not in new
    assert docs.render(new) == new
