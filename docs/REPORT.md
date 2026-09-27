# What Kleo says about its own videos

*27 September 2026 — `worker/kleo_report.py`, `src/report.ts`, `worker/test_film_e2e.py`*

## Why

Every test film of 22–25 September surfaced a defect nobody had measured before a person watched it: 39.4 s delivered
for a 30 s order (six 1.8 s silences), the music 3 dB under the voice in the pauses, eleven one-second shots bought at
the four-second minimum, a 59.94 fps master refused by a string comparison, a mono narration refused by the sidechain
against stereo music. Two changes close that loop.

## 1. The report (automatic, on every render)

After `film_finish` or `render_keou`, the worker runs `kleo_report.report()` on `video.mp4` (ffmpeg only, one decode of
the picture, two short audio passes, a time limit of `KLEO_REPORT_TIMEOUT_S`, 240 s by default). It measures:

- the stream: size, frame rate **as a number**, frame count, duration;
- the length against the order (`params.duration_s`);
- loudness and true peak;
- the pauses: quiet runs of 0.8 s or more between the first and last sound, and the level under each one (music, or
  nothing: dead air);
- the cuts (ffmpeg scene score) and the shots shorter than 1.5 s;
- the longest run of identical frames (qa.py's own ruler) and black intervals;
- the sidecar subtitles.

It writes `report.json` beside the deliverables and uploads it (never listed to the user), and logs one `REPORT` line
and one `PROBLEM` line per finding in `log.txt`. A report that cannot run is a log line, never a failed film.

Read them back (Bearer `INTERNAL_SECRET`):

```
GET /internal/admin/report?job_id=gt_…     one video's whole report
GET /internal/admin/reports?limit=20      the latest videos: order, length, longest pause, shortest shot, problems
```

For an older video on a rented box: `python3 scripts/report.py film.mp4 --ordered 30 --music yes --subtitles no`.

## 2. The film end to end in CI, for zero dollars

`worker/test_film_e2e.py` runs the finish chain for real in the python job of `tests.yml` (imported by
`test_kleo_worker_video.py`, because the owner's token cannot edit workflows): `render.mjs --shots`, `build_footage`
from three 128×72 clips at 59.94 fps (one slowed, one with a frozen tail, a dissolve between acts), the music fetched
and looped, both endings of `film_finish` (the plain mux with `MIX_CHAIN`, and the layer through `run.py --skip-voice`,
`render.mjs` compositing in parallel parts, the master check, `qa.py`), `film_checks`, the `.srt`, the thumbnail and
the report on both films. Chromium, Kokoro/whisper and the network are the only fakes; the timeline's length is not a
whole number of frames on purpose.
