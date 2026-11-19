"""A small client for Komoot's unofficial web API (the one komoot.com itself uses).

Login: HTTP basic auth with email and password against `/v006/account/email/<email>/` answers with the
user id (`username`) and an API token (`password`); every later request is basic auth with those two.
The email, password and token live in memory only. Messages never contain URLs (the login URL holds
the email).
"""

from __future__ import annotations

import contextlib
import time
from collections.abc import Callable, Iterator
from typing import Any
from urllib.parse import quote, urljoin, urlsplit

import httpx

BASE_URL = "https://api.komoot.de"
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
PAGE_SIZE = 50


class KomootError(Exception):
    """A failed Komoot call, with a message that is safe to print."""


class AuthError(KomootError):
    """Wrong email or password, or an expired token."""


class KomootClient:
    def __init__(
        self,
        *,
        base_url: str = BASE_URL,
        transport: httpx.BaseTransport | None = None,
        delay: float = 0.5,
        retries: int = 5,
        backoff: float = 2.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._http = httpx.Client(
            transport=transport,
            timeout=30.0,
            headers={"Accept": "application/hal+json,application/json", "User-Agent": "kompass-komoot"},
        )
        self._delay = delay
        self._retries = retries
        self._backoff = backoff
        self._sleep = sleep
        self._auth: httpx.BasicAuth | None = None
        self.user_id: str | None = None
        self._last_request = 0.0

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> KomootClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- transport -------------------------------------------------------------------------------

    def _get(self, url: str, *, what: str, auth: httpx.BasicAuth | None, params: dict | None = None) -> Any:
        """GET with a polite pause, retries with backoff on 429/5xx and network errors, JSON result."""
        attempt = 0
        while True:
            self._pause()
            try:
                response = self._http.get(url, auth=auth, params=params)
            except httpx.TransportError as exc:
                if attempt >= self._retries:
                    raise KomootError(f"{what}: network error ({type(exc).__name__})") from None
                self._backoff_sleep(attempt, None)
            else:
                if response.status_code == 401 or (response.status_code == 403 and what == "login"):
                    raise AuthError(f"{what}: Komoot rejected the credentials (HTTP {response.status_code})")
                if response.status_code in RETRY_STATUSES:
                    if attempt >= self._retries:
                        raise KomootError(f"{what}: HTTP {response.status_code}, giving up after retries")
                    self._backoff_sleep(attempt, response.headers.get("Retry-After"))
                elif response.status_code != 200:
                    raise KomootError(f"{what}: HTTP {response.status_code}")
                else:
                    try:
                        return response.json()
                    except ValueError:
                        raise KomootError(f"{what}: response is not JSON") from None
            attempt += 1

    def _pause(self) -> None:
        wait = self._last_request + self._delay - time.monotonic()
        if wait > 0:
            self._sleep(wait)
        self._last_request = time.monotonic()

    def _backoff_sleep(self, attempt: int, retry_after: str | None) -> None:
        seconds = self._backoff * (2**attempt)
        if retry_after:
            with contextlib.suppress(ValueError):
                seconds = max(seconds, float(retry_after))
        self._sleep(min(seconds, 120.0))

    # -- API -------------------------------------------------------------------------------------

    def login(self, email: str, password: str) -> None:
        url = f"{self.base_url}/v006/account/email/{quote(email, safe='@')}/"
        data = self._get(url, what="login", auth=httpx.BasicAuth(email, password))
        try:
            self.user_id = str(data["username"])
            token = str(data["password"])
        except (KeyError, TypeError):
            raise KomootError("login: unexpected response (the API may have changed)") from None
        self._auth = httpx.BasicAuth(self.user_id, token)

    def recorded_tours(self) -> Iterator[dict[str, Any]]:
        """Every recorded tour of the user (all pages, following the `next` links)."""
        if self._auth is None or self.user_id is None:
            raise KomootError("not logged in")
        url = f"{self.base_url}/v007/users/{quote(self.user_id, safe='')}/tours/"
        params: dict | None = {"type": "tour_recorded", "page": 0, "limit": PAGE_SIZE}
        seen: set[str] = set()
        page_no = 0
        while url not in seen:
            seen.add(url)
            page_no += 1
            data = self._get(url, what=f"tour list (page {page_no})", auth=self._auth, params=params)
            tours = (data.get("_embedded") or {}).get("tours") or []
            for tour in tours:
                if tour.get("type") == "tour_recorded":
                    yield tour
            href = ((data.get("_links") or {}).get("next") or {}).get("href")
            if not href or not tours:
                return
            url, params = self._same_origin(urljoin(url, href)), None

    def coordinates(self, tour_id: str | int) -> dict[str, Any]:
        if self._auth is None:
            raise KomootError("not logged in")
        url = f"{self.base_url}/v007/tours/{quote(str(tour_id), safe='')}/coordinates"
        return self._get(url, what="tour", auth=self._auth)

    def _same_origin(self, url: str) -> str:
        """Never send the token to another host, whatever a `next` link says."""
        if urlsplit(url)[:2] != urlsplit(self.base_url)[:2]:
            raise KomootError("tour list: next page points to another host, stopping")
        return url
