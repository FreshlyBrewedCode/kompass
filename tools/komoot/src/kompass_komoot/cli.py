"""`kompass-komoot`: download the user's recorded Komoot tours as GPX into `data/tracks/komoot/`."""

from __future__ import annotations

import argparse
import getpass
import os
import sys
import time
from collections.abc import Callable, Sequence
from datetime import date
from pathlib import Path
from typing import Any

import httpx

from .client import AuthError, KomootClient, KomootError
from .gpx import TrackError, build_gpx, extract_items, parse_komoot_date
from .sports import Selection, parse_sport_selection
from .store import Store, default_out_dir, gpx_name


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="kompass-komoot",
        description="Download your recorded Komoot tours as GPX (unofficial API). Credentials come from "
        "KOMOOT_EMAIL / KOMOOT_PASSWORD or an interactive prompt and are never stored.",
    )
    p.add_argument("--out", type=Path, help="output directory (default: <repo>/data/tracks/komoot)")
    p.add_argument(
        "--sport",
        action="append",
        default=[],
        metavar="SPORT",
        help="cycling (default), gravel, all, or Komoot sport ids such as touringbicycle, mtb, racebike, "
        "mtb_easy; repeatable or comma-separated",
    )
    p.add_argument("--since", type=date.fromisoformat, metavar="YYYY-MM-DD", help="only tours on or after")
    p.add_argument("--limit", type=int, metavar="N", help="download at most N new tours (a trial run)")
    p.add_argument("--dry-run", action="store_true", help="list what would be downloaded, write nothing")
    p.add_argument("--delay", type=float, default=0.5, metavar="SECONDS", help="pause between requests")
    return p


def read_credentials(env: dict[str, str], *, interactive: bool) -> tuple[str, str]:
    email = env.get("KOMOOT_EMAIL", "").strip()
    password = env.get("KOMOOT_PASSWORD", "")
    if (not email or not password) and not interactive:
        raise KomootError("no credentials: set KOMOOT_EMAIL and KOMOOT_PASSWORD or run in a terminal")
    if not email:
        email = input("Komoot email: ").strip()
    if not password:
        password = getpass.getpass("Komoot password (not shown, not stored): ")
    if not email or not password:
        raise KomootError("email and password are required")
    return email, password


def _tour_line(tour: dict[str, Any]) -> str:
    km = float(tour.get("distance") or 0) / 1000
    return f"{str(tour['date'])[:10]} {tour.get('sport', '?')} {km:.1f} km  {tour.get('name', '')}"


def select_tours(
    tours: Sequence[dict[str, Any]], *, sports: Selection, since: date | None
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Recorded tours that match the filters, newest first, plus a count of skipped sports."""
    wanted: list[dict[str, Any]] = []
    other_sports: dict[str, int] = {}
    for tour in tours:
        if not tour.get("date"):
            tour["date"] = tour.get("changed_at")
        if not tour["date"] or "id" not in tour:
            continue  # nothing to name or date the file by
        sport = str(tour.get("sport", ""))
        if not sports.matches(sport):
            other_sports[sport] = other_sports.get(sport, 0) + 1
            continue
        if since and date.fromisoformat(str(tour["date"])[:10]) < since:
            continue
        wanted.append(tour)
    wanted.sort(key=lambda t: str(t["date"]), reverse=True)
    return wanted, other_sports


def run(
    args: argparse.Namespace,
    *,
    env: dict[str, str],
    interactive: bool,
    out_dir: Path,
    transport: httpx.BaseTransport | None = None,
    sleep: Callable[[float], None] = time.sleep,
    echo: Callable[[str], None] = print,
) -> int:
    sports = parse_sport_selection(args.sport)
    email, password = read_credentials(env, interactive=interactive)
    store = Store(out_dir)

    with KomootClient(transport=transport, delay=args.delay, sleep=sleep) as client:
        client.login(email, password)
        echo("Logged in.")
        tours = list(client.recorded_tours())
        wanted, other_sports = select_tours(tours, sports=sports, since=args.since)
        new = [t for t in wanted if not store.has(t["id"])]
        already = len(wanted) - len(new)
        if args.limit is not None:
            new = new[: max(args.limit, 0)]
        echo(
            f"{len(tours)} recorded tours, {len(wanted)} match sport={sports.describe()}"
            f"{f' since {args.since}' if args.since else ''}; {already} already downloaded, "
            f"{len(new)} to download."
        )

        done, failed = 0, 0
        for number, tour in enumerate(new, 1):
            prefix = f"[{number}/{len(new)}] {_tour_line(tour)}"
            if args.dry_run:
                echo(f"{prefix}  (dry run)")
                continue
            try:
                items = extract_items(client.coordinates(tour["id"]))
                gpx = build_gpx(
                    items,
                    name=str(tour.get("name") or tour["id"]),
                    sport=str(tour.get("sport", "")),
                    start=parse_komoot_date(str(tour["date"])),
                )
            except AuthError:
                raise
            except (KomootError, TrackError) as exc:
                failed += 1
                echo(f"{prefix}  FAILED: {exc}")
                continue
            file = gpx_name(str(tour["date"]), tour["id"])
            store.add(
                {
                    "id": str(tour["id"]),
                    "date": str(tour["date"]),
                    "sport": tour.get("sport"),
                    "name": tour.get("name"),
                    "distance": tour.get("distance"),
                    "duration": tour.get("duration"),
                    "file": file,
                },
                gpx,
            )
            done += 1
            echo(f"{prefix}  -> {file}")

    if other_sports:
        names = ", ".join(f"{k or '?'} {v}" for k, v in sorted(other_sports.items()))
        echo(f"Skipped by sport: {names} (use --sport to include).")
    verb = "would download" if args.dry_run else "downloaded"
    count = len(new) if args.dry_run else done
    echo(f"Done: {verb} {count}, already present {already}, failed {failed}. Output: {out_dir}")
    return 1 if failed else 0


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    out_dir = args.out if args.out else default_out_dir(Path(__file__).parent)
    try:
        return run(args, env=dict(os.environ), interactive=sys.stdin.isatty(), out_dir=out_dir)
    except AuthError as exc:
        print(
            f"Login failed: {exc}. Check email and password (the account needs a password).", file=sys.stderr
        )
        return 1
    except KomootError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nInterrupted; tours downloaded so far are kept, run again to continue.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
