#!/usr/bin/env python3
"""Measure a finished Kleo video and list what to fix next: worker/kleo_report.py from the command line.

Every render already does this on the box that made it (report.json, GET /internal/admin/report?job_id=…). This is
for a video made before 27 September 2026, or a sample on a rented box. Never on the owner's PC.

  python3 scripts/report.py film.mp4 --ordered 30 --music yes --subtitles no [--srt film.srt] [--json]
Exit code 1 when a problem was found, so a probe script can stop on it.
"""
import os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker"))
import kleo_report  # noqa: E402

if __name__ == "__main__":
    sys.exit(kleo_report.main())
