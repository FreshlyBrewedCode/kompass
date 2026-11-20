# kompass-komoot

Downloads your **recorded** Komoot tours as GPX files, so the ride history can feed Kompass' explored
map. You run it yourself, on your own machine, with your own login.

```sh
# inside the dev shell (`nix develop`), from the repo root
uv run --project tools/komoot kompass-komoot --limit 3 --dry-run   # trial: log in, list 3 tours, write nothing
uv run --project tools/komoot kompass-komoot --limit 3             # trial: download 3 tours
uv run --project tools/komoot kompass-komoot                       # everything (cycling), incremental
```

## Credentials

Asked interactively (email, then the password without echo), or taken from the environment:

```sh
KOMOOT_EMAIL=… KOMOOT_PASSWORD=… uv run --project tools/komoot kompass-komoot
```

There are deliberately no credential options on the command line (shell history). The email, the
password and the API token live in memory for the run only: **nothing is stored, no token cache, nothing
is logged or printed**, and error messages never contain URLs (the login URL contains the email). The
account needs a Komoot password (a social-only login has none; set one in the Komoot account settings).

## Options

| option                | default                   | meaning                                                              |
| --------------------- | ------------------------- | -------------------------------------------------------------------- |
| `--out DIR`           | `<repo>/data/tracks/komoot` | output directory                                                   |
| `--sport SPORT`       | `cycling`                 | `cycling` (all bike sports), `gravel`, `all`, or Komoot sport ids    |
| `--since YYYY-MM-DD`  | none                      | only tours on or after that date                                     |
| `--limit N`           | none                      | download at most N new tours, newest first (a trial run)             |
| `--dry-run`           | off                       | log in and list what would be downloaded, write nothing              |
| `--delay SECONDS`     | `0.5`                     | pause between requests                                               |

`--sport` can repeat or be comma-separated (`--sport racebike,mtb_easy`). Komoot's cycling ids:
`racebike`, `touringbicycle`, `mtb` (mountain bike), `mtb_easy` (**gravel**), `mtb_advanced`, each with an
`e_` variant for e-bikes. Ids not in that list that contain `bike`, `bicycle` or `mtb` count as cycling
too. Tours of other sports are skipped, and the summary says which ones, so a wrong guess is visible.

## What it writes

Under the output directory (gitignored `data/`, never committed):

- `<YYYY-MM-DD>_<tour id>.gpx`: one track per tour; the date is the tour's own local date. Every point
  has `lat`, `lon`, `<ele>` and `<time>` (UTC).
- `index.json`: `{"version": 1, "tours": [{id, date, sport, name, distance, duration, file}, …]}`;
  `date` as Komoot gives it (ISO with offset), `distance` in metres, `duration` in seconds.

Incremental: a tour that is in the index and whose file exists is skipped, so a second run fetches only
new tours (delete a GPX to fetch it again). Files and index are written atomically after each tour, so
an interrupted run (Ctrl+C) loses nothing; run it again. Requests are paced, and 429/5xx answers and
network errors are retried with exponential backoff (honouring `Retry-After`). Exit code 1 if a tour
failed or the login did; the failed tours are retried on the next run.

## Getting the download into the app

The app imports the GPX files directly, and a **zip** of them, in one step:

```sh
cd data/tracks && zip -r komoot.zip komoot/*.gpx      # 185 tours: about 9 MB
```

- **On the phone:** put `komoot.zip` on it (AirDrop, or into the Files app / iCloud Drive), open the app,
  Rides → "Add GPX or FIT files, or a zip", pick the zip. The app unpacks it as a stream (nothing
  unpacked is kept in memory), imports, and matches the rides to the map in the background; the explored
  map fills in as it goes.
- **Or import on a desktop** and move the library: Rides → Export gives a `.kompassrides` backup (all
  points, no matches: those are derived on the device), which the same picker (or Restore) takes on the
  phone. Use this to carry rides from several sources, or to keep a backup.

Nothing is uploaded either way: the files are read in the browser.

## How it talks to Komoot, and how it may break

Komoot has no public API; this uses the web API that komoot.com and the Komoot apps use, as other
open-source exporters do (KomootGPX, komoot-export and similar). **It is unofficial and can break any
time** (changed endpoints, new login rules, rate limits). Steps:

1. Login: basic auth with email and password against `https://api.komoot.de/v006/account/email/<email>/`
   returns the user id and an API token; later requests use basic auth with those.
2. List: `/v007/users/<user id>/tours/?type=tour_recorded&page=0&limit=50`, HAL+JSON, following the
   `_links.next` links (only to the same host; the token never goes elsewhere).
3. Track: `/v007/tours/<id>/coordinates`, `{"items": [{lat, lng, alt, t}, …]}`. The GPX is **built from
   these coordinates** rather than fetched from Komoot's own `.gpx` export, so the timestamps do not
   depend on what that export includes (the app needs a time on every point: it deduplicates rides by
   overlapping time and derives "last ridden").

`t` is milliseconds: for recorded tours the offset from the tour start (added to the tour's `date`);
absolute epoch times (ms or s) are detected and used as they are. A track without timestamps is not
written: that tour is reported as failed.

Verified only against made-up responses (the tests use a fake transport, no real network or account).
If a run fails against the live API, the first things to check are the three URLs above and the shape of
the `coordinates` items.
