"""Komoot sport ids and the `--sport` selection.

Komoot names sports with short ids (`touringbicycle`, `mtb`, `racebike`, `mtb_easy` for gravel, and an
`e_` prefix for the e-bike variants). The list is not documented officially; ids that are not known
here but look like cycling (`bike`, `bicycle` or `mtb` in the id) still count as cycling.
"""

from __future__ import annotations

from collections.abc import Iterable

KNOWN_CYCLING = frozenset(
    {
        "racebike",
        "e_racebike",
        "touringbicycle",
        "e_touringbicycle",
        "mtb",
        "e_mtb",
        "mtb_easy",
        "e_mtb_easy",
        "mtb_advanced",
        "e_mtb_advanced",
    }
)

# Komoot files gravel riding under the easy-mountain-bike sport
GRAVEL = frozenset({"mtb_easy", "e_mtb_easy"})


def is_cycling(sport: str) -> bool:
    return sport in KNOWN_CYCLING or any(word in sport for word in ("bike", "bicycle", "mtb"))


def parse_sport_selection(values: Iterable[str]) -> Selection:
    """`--sport` values (repeatable, comma-separated): `cycling`, `gravel`, `all` or raw Komoot ids."""
    wanted = {part.strip().lower() for value in values for part in value.split(",") if part.strip()}
    if not wanted:
        wanted = {"cycling"}
    return Selection(frozenset(wanted))


class Selection:
    def __init__(self, wanted: frozenset[str]) -> None:
        self.wanted = wanted

    def matches(self, sport: str) -> bool:
        if "all" in self.wanted:
            return True
        if "cycling" in self.wanted and is_cycling(sport):
            return True
        if "gravel" in self.wanted and sport in GRAVEL:
            return True
        return sport in self.wanted

    def describe(self) -> str:
        return ", ".join(sorted(self.wanted))
