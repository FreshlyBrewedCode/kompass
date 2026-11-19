import json
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest
from fake_komoot import EMAIL, PASSWORD, TOKEN, FakeKomoot, tour, track

from kompass_komoot.cli import build_parser, read_credentials, run
from kompass_komoot.client import AuthError, KomootClient, KomootError
from kompass_komoot.store import find_repo_root

NS = {"g": "http://www.topografix.com/GPX/1/1"}
ENV = {"KOMOOT_EMAIL": EMAIL, "KOMOOT_PASSWORD": PASSWORD}


def go(fake: FakeKomoot, out: Path, *argv: str, env: dict | None = None):
    """One run against the fake; returns (exit code, printed lines, sleeps)."""
    lines: list[str] = []
    sleeps: list[float] = []
    code = run(
        build_parser().parse_args(list(argv)),
        env=ENV if env is None else env,
        interactive=False,
        out_dir=out,
        transport=fake.transport,
        sleep=sleeps.append,
        echo=lines.append,
    )
    return code, lines, sleeps


def sample() -> FakeKomoot:
    tours = [
        tour(103, date="2024-06-01T10:00:00.000+02:00", name="Evening ride"),
        tour(102, sport="hike", date="2024-05-20T10:00:00.000+02:00", name="Lake walk"),
        tour(101, sport="mtb_easy", date="2024-05-04T09:12:33.000+02:00"),
        tour(100, kind="tour_planned", name="Planned for later"),
        tour(99, sport="racebike", date="2023-09-01T08:00:00.000+02:00", name="Road spin"),
    ]
    fake = FakeKomoot(tours, page_size=2)
    fake.tracks = {str(i): track() for i in (99, 101, 102, 103)}
    return fake


def read_index(out: Path) -> list[dict]:
    return json.loads((out / "index.json").read_text())["tours"]


def test_wrong_credentials_give_a_clear_error_and_leak_nothing(tmp_path):
    fake = sample()
    with pytest.raises(AuthError) as err:
        go(fake, tmp_path, env={"KOMOOT_EMAIL": EMAIL, "KOMOOT_PASSWORD": "wrong password"})
    assert "rejected the credentials" in str(err.value)
    assert EMAIL not in str(err.value) and "wrong password" not in str(err.value)
    assert not (tmp_path / "index.json").exists()


def test_pages_are_followed_and_only_recorded_cycling_tours_are_downloaded(tmp_path):
    fake = sample()
    code, lines, _ = go(fake, tmp_path)
    assert code == 0
    # 3 list pages (5 tours at 2 per page), no planned tour, no hike
    assert sum(r.url.path.endswith("/tours/") for r in fake.requests) == 3
    assert [e["id"] for e in read_index(tmp_path)] == ["99", "101", "103"]
    assert sorted(p.name for p in tmp_path.glob("*.gpx")) == [
        "2023-09-01_99.gpx",
        "2024-05-04_101.gpx",
        "2024-06-01_103.gpx",
    ]
    assert any("Skipped by sport: hike 1" in line for line in lines)
    assert any(line.startswith("[1/3] 2024-06-01 touringbicycle") for line in lines)
    assert lines[-1].startswith("Done: downloaded 3, already present 0, failed 0")


def test_index_entries_carry_the_metadata(tmp_path):
    go(sample(), tmp_path)
    entry = next(e for e in read_index(tmp_path) if e["id"] == "101")
    assert entry == {
        "id": "101",
        "date": "2024-05-04T09:12:33.000+02:00",
        "sport": "mtb_easy",
        "name": "Morning gravel loop",
        "distance": 42350.5,
        "duration": 7200,
        "file": "2024-05-04_101.gpx",
    }


@pytest.mark.parametrize(
    ("argv", "ids"),
    [
        (["--sport", "gravel"], ["101"]),
        (["--sport", "all"], ["99", "101", "102", "103"]),
        (["--sport", "hike,racebike"], ["99", "102"]),
        (["--since", "2024-05-04"], ["101", "103"]),
    ],
)
def test_sport_and_since_filters(tmp_path, argv, ids):
    go(sample(), tmp_path, *argv)
    assert [e["id"] for e in read_index(tmp_path)] == ids


def test_limit_takes_the_newest_tours_and_dry_run_writes_nothing(tmp_path):
    fake = sample()
    code, lines, _ = go(fake, tmp_path, "--limit", "1")
    assert code == 0 and [e["id"] for e in read_index(tmp_path)] == ["103"]

    out = tmp_path / "dry"
    fake.requests.clear()
    _, lines, _ = go(fake, out, "--dry-run")
    assert not out.exists() and fake.coordinate_requests() == []
    assert sum("(dry run)" in line for line in lines) == 3
    assert lines[-1].startswith("Done: would download 3")


def test_second_run_downloads_only_new_tours(tmp_path):
    fake = sample()
    go(fake, tmp_path)
    fake.requests.clear()
    _, lines, _ = go(fake, tmp_path)
    assert fake.coordinate_requests() == []
    assert lines[-1].startswith("Done: downloaded 0, already present 3")

    fake.tours.insert(0, tour(104, date="2024-07-01T10:00:00.000+02:00"))
    fake.tracks["104"] = track()
    (tmp_path / "2023-09-01_99.gpx").unlink()  # a file that went missing is fetched again
    fake.requests.clear()
    go(fake, tmp_path)
    assert sorted(fake.coordinate_requests()) == ["/v007/tours/104/coordinates", "/v007/tours/99/coordinates"]
    assert [e["id"] for e in read_index(tmp_path)] == ["99", "101", "103", "104"]


def test_gpx_has_a_timestamp_and_elevation_on_every_point(tmp_path):
    go(sample(), tmp_path)
    root = ET.parse(tmp_path / "2024-05-04_101.gpx").getroot()
    assert root.get("version") == "1.1"
    assert root.find("g:trk/g:name", NS).text == "Morning gravel loop"
    points = root.findall("g:trk/g:trkseg/g:trkpt", NS)
    assert len(points) == 4
    # `t` is an offset from the tour start (09:12:33 at +02:00 = 07:12:33Z)
    assert [p.find("g:time", NS).text for p in points] == [
        "2024-05-04T07:12:33.000Z",
        "2024-05-04T07:13:03.000Z",
        "2024-05-04T07:13:33.000Z",
        "2024-05-04T07:14:03.000Z",
    ]
    assert [p.find("g:ele", NS).text for p in points] == ["410.0", "411.0", "412.0", "413.0"]
    assert points[0].get("lat") == "47.3769000" and points[0].get("lon") == "8.5417000"


def test_absolute_timestamps_are_kept(tmp_path):
    fake = sample()
    fake.tracks["101"] = track(absolute=True)  # epoch ms, START is 07:12:33Z
    go(fake, tmp_path, "--sport", "gravel")
    root = ET.parse(tmp_path / "2024-05-04_101.gpx").getroot()
    times = [p.text for p in root.findall("g:trk/g:trkseg/g:trkpt/g:time", NS)]
    assert times[0] == "2024-05-04T07:12:33.000Z" and times[-1] == "2024-05-04T07:14:03.000Z"


def test_a_track_without_timestamps_fails_that_tour_only(tmp_path):
    fake = sample()
    fake.tracks["101"] = track(timed=False)
    code, lines, _ = go(fake, tmp_path)
    assert code == 1
    assert any("FAILED" in line and "timestamps" in line for line in lines)
    assert [e["id"] for e in read_index(tmp_path)] == ["99", "103"]


def test_429_is_retried_with_backoff_and_retry_after(tmp_path):
    fake = sample()
    fake.rate_limit_next["103"] = 2
    code, _, sleeps = go(fake, tmp_path, "--sport", "touringbicycle")
    assert code == 0
    assert fake.coordinate_requests().count("/v007/tours/103/coordinates") == 3
    # backoff 2 s then 4 s, but never shorter than the server's Retry-After (3 s): 3 s, then 4 s
    assert [s for s in sleeps if s >= 1] == [3.0, 4.0]


def test_gives_up_after_the_retries(tmp_path):
    fake = sample()
    fake.rate_limit_next["103"] = 99
    code, lines, _ = go(fake, tmp_path, "--sport", "touringbicycle")
    assert code == 1 and any("giving up" in line for line in lines)


def test_next_link_to_another_host_is_not_followed():
    fake = sample()
    fake.next_host = "tracker.example.org"
    with KomootClient(transport=fake.transport, delay=0, sleep=lambda s: None) as client:
        client.login(EMAIL, PASSWORD)
        with pytest.raises(KomootError, match="another host"):
            list(client.recorded_tours())
    assert all(r.url.host == "api.komoot.de" for r in fake.requests)


def test_nothing_secret_is_printed_or_stored(tmp_path):
    fake = sample()
    _, lines, _ = go(fake, tmp_path)
    blob = "\n".join(lines) + "".join(p.read_text() for p in tmp_path.iterdir())
    assert PASSWORD not in blob and TOKEN not in blob and EMAIL not in blob


def test_credentials_need_env_or_a_terminal():
    assert read_credentials(ENV, interactive=False) == (EMAIL, PASSWORD)
    with pytest.raises(KomootError, match="no credentials"):
        read_credentials({}, interactive=False)


def test_find_repo_root(tmp_path):
    (tmp_path / ".git").write_text("gitdir: elsewhere")  # a worktree has a .git file
    deep = tmp_path / "tools" / "komoot"
    deep.mkdir(parents=True)
    assert find_repo_root(deep) == tmp_path.resolve()
