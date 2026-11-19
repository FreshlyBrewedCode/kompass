"""Build a GPX 1.1 track from a Komoot coordinates response.

Komoot returns the track as `items`: `{lat, lng, alt, t}` per point, `t` in milliseconds. For recorded
tours `t` is the offset from the tour start (the first point has `t == 0`); some responses carry
absolute epoch times instead. Both forms (and epoch seconds) are accepted. The app needs a timestamp on
every point (it deduplicates rides by overlapping time and derives "last ridden"), so a track without
usable times is rejected rather than written without them.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from xml.etree import ElementTree as ET

GPX_NS = "http://www.topografix.com/GPX/1/1"
CREATOR = "kompass-komoot"

# t values: below 1e9 an offset in ms from the start (1e9 ms is 11 days, no single ride), from 1e9 epoch
# seconds, from 1e11 epoch milliseconds
_EPOCH_SECONDS_MIN = 1e9
_EPOCH_MILLIS_MIN = 1e11


class TrackError(ValueError):
    """The coordinates cannot become a timed GPX track."""


def parse_komoot_date(value: str) -> datetime:
    """`2024-05-04T09:12:33.000+02:00` (or `...Z`) as an aware datetime."""
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def extract_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """The coordinate items of `/tours/<id>/coordinates` or of a tour with `_embedded=coordinates`."""
    items = payload.get("items")
    if items is None:
        items = payload.get("_embedded", {}).get("coordinates", {}).get("items")
    if not isinstance(items, list):
        raise TrackError("response has no coordinate items")
    return items


def point_times(items: list[dict[str, Any]], start: datetime) -> list[datetime]:
    try:
        raw = [float(item["t"]) for item in items]
    except (KeyError, TypeError, ValueError) as exc:
        raise TrackError("points without timestamps") from exc
    if not raw:
        raise TrackError("no points")
    first = raw[0]
    if first >= _EPOCH_MILLIS_MIN:
        return [datetime.fromtimestamp(t / 1000, UTC) for t in raw]
    if first >= _EPOCH_SECONDS_MIN:
        return [datetime.fromtimestamp(t, UTC) for t in raw]
    start_utc = start.astimezone(UTC)
    return [start_utc + timedelta(milliseconds=t) for t in raw]


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def build_gpx(items: list[dict[str, Any]], *, name: str, sport: str, start: datetime) -> bytes:
    """A GPX 1.1 document (UTF-8 bytes) with one track and one segment; `<ele>` where Komoot has `alt`."""
    times = point_times(items, start)
    ET.register_namespace("", GPX_NS)
    root = ET.Element(f"{{{GPX_NS}}}gpx", {"version": "1.1", "creator": CREATOR})
    meta = ET.SubElement(root, f"{{{GPX_NS}}}metadata")
    ET.SubElement(meta, f"{{{GPX_NS}}}name").text = name
    ET.SubElement(meta, f"{{{GPX_NS}}}time").text = _iso(times[0])
    trk = ET.SubElement(root, f"{{{GPX_NS}}}trk")
    ET.SubElement(trk, f"{{{GPX_NS}}}name").text = name
    ET.SubElement(trk, f"{{{GPX_NS}}}type").text = sport
    seg = ET.SubElement(trk, f"{{{GPX_NS}}}trkseg")
    for item, moment in zip(items, times, strict=True):
        try:
            lat, lng = float(item["lat"]), float(item["lng"])
        except (KeyError, TypeError, ValueError) as exc:
            raise TrackError("point without coordinates") from exc
        pt = ET.SubElement(seg, f"{{{GPX_NS}}}trkpt", {"lat": f"{lat:.7f}", "lon": f"{lng:.7f}"})
        if item.get("alt") is not None:
            ET.SubElement(pt, f"{{{GPX_NS}}}ele").text = f"{float(item['alt']):.1f}"
        ET.SubElement(pt, f"{{{GPX_NS}}}time").text = _iso(moment)
    ET.indent(root)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)
