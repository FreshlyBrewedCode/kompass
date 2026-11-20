"""A fake Komoot API for the tests: made-up users, tours and tracks, served through httpx.MockTransport."""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

EMAIL = "alice@example.com"
PASSWORD = "correct horse"
USER_ID = "1234567890"
TOKEN = "made-up-token"
START = datetime(2024, 5, 4, 7, 12, 33, tzinfo=UTC)


def tour(
    tour_id: int,
    *,
    sport: str = "touringbicycle",
    name: str = "Morning gravel loop",
    date: str = "2024-05-04T09:12:33.000+02:00",
    kind: str = "tour_recorded",
) -> dict[str, Any]:
    return {
        "id": str(tour_id),
        "type": kind,
        "name": name,
        "sport": sport,
        "date": date,
        "distance": 42350.5,
        "duration": 7200,
        "status": "private",
    }


def track(points: int = 4, *, absolute: bool = False, timed: bool = True) -> dict[str, Any]:
    """Points around central Zurich, one every 30 s; `t` is an offset in ms unless `absolute`."""
    items = []
    for i in range(points):
        item: dict[str, Any] = {"lat": 47.3769 + i * 0.0005, "lng": 8.5417 + i * 0.0007, "alt": 410.0 + i}
        if timed:
            t = i * 30_000
            item["t"] = int((START + timedelta(milliseconds=t)).timestamp() * 1000) if absolute else t
        items.append(item)
    return {"items": items}


class FakeKomoot:
    """Records every request; `tours` are served in pages of `page_size`, newest first like Komoot."""

    def __init__(self, tours: list[dict[str, Any]], *, page_size: int = 2) -> None:
        self.tours = tours
        self.page_size = page_size
        self.tracks: dict[str, dict[str, Any]] = {}
        self.requests: list[httpx.Request] = []
        self.rate_limit_next: dict[str, int] = {}  # tour id -> how many 429s to answer first
        self.next_host = "api.komoot.de"
        self.transport = httpx.MockTransport(self._handle)

    def coordinate_requests(self) -> list[str]:
        return [r.url.path for r in self.requests if r.url.path.endswith("/coordinates")]

    def _authorized(self, request: httpx.Request, user: str, secret: str) -> bool:
        header = request.headers.get("authorization", "")
        return header == "Basic " + base64.b64encode(f"{user}:{secret}".encode()).decode()

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path.startswith("/v006/account/email/"):
            if not self._authorized(request, EMAIL, PASSWORD):
                return httpx.Response(401, json={"error": "Unauthorized"})
            return httpx.Response(200, json={"username": USER_ID, "password": TOKEN, "user": {}})
        if not self._authorized(request, USER_ID, TOKEN):
            return httpx.Response(401, json={"error": "Unauthorized"})
        if path == f"/v007/users/{USER_ID}/tours/":
            return self._list(request)
        if path.startswith("/v007/tours/") and path.endswith("/coordinates"):
            tour_id = path.split("/")[3]
            if self.rate_limit_next.get(tour_id, 0) > 0:
                self.rate_limit_next[tour_id] -= 1
                return httpx.Response(429, headers={"Retry-After": "3"}, json={})
            if tour_id not in self.tracks:
                return httpx.Response(404, json={})
            return httpx.Response(200, json=self.tracks[tour_id])
        return httpx.Response(404, json={})

    def _list(self, request: httpx.Request) -> httpx.Response:
        page = int(request.url.params.get("page", 0))
        size = self.page_size
        chunk = self.tours[page * size : (page + 1) * size]
        body: dict[str, Any] = {"_embedded": {"tours": chunk}, "_links": {}, "page": {"number": page}}
        if (page + 1) * size < len(self.tours):
            url = f"https://{self.next_host}/v007/users/{USER_ID}/tours/?page={page + 1}&limit={size}"
            body["_links"]["next"] = {"href": url}
        return httpx.Response(200, content=json.dumps(body), headers={"content-type": "application/hal+json"})
