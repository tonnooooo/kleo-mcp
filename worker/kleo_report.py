#!/usr/bin/env python3
"""What a finished video actually is, measured: the report Kleo writes about its own work after every render.

WHY THIS EXISTS (27 September 2026). Every test film of 22-25 September surfaced a defect nobody had measured before
it was watched: 39.4 s delivered for a 30 s order (six 1.8 s silences), music 3 dB under the voice in the pauses,
twelve one-second shots bought at the four-second minimum, a 59.94 master refused by a string comparison. Each was
found by a person reading a file, hours after the render, one film at a time. This module does that reading on every
video, on the box that made it, with ffmpeg only: the numbers go up with the film as report.json (never shown to the
user), the problems go in the log, and GET /internal/admin/report(s) reads them back. A film is a probe of Kleo; this
is the probe's instrument.

What it measures, and nothing it has to guess at: the stream (size, rate as a number, frames), the length against the
order, the loudness, the pauses in the sound and what lies under them (the music, or nothing), the cuts and the
shortest shots, the longest run of identical frames (qa.py's own ruler), black intervals, and the sidecar subtitles.
It never decides whether a film ships: film_checks and qa.py do. It says what to fix next.

Run on a box or in CI (never on the owner's PC):  python3 kleo_report.py film.mp4 [--ordered 30] [--music yes|no]
                                                  [--subtitles yes|no] [--srt film.srt] [--json]
"""
import argparse, array, json, math, os, re, subprocess, sys, tempfile

VERSION = 1
WINDOW_S = 0.1          # the sound is read in windows of this length
AUDIO_SR = 8000         # plenty to tell a voice from a pause; 48 kHz would only cost time
PAUSE_DB = 12.0         # a window this far under the voice's level belongs to a pause
PAUSE_S = 0.8           # ...when the quiet lasts at least this long (a breath between two words is shorter)
DEAD_AIR_S = 1.2        # a pause this long with nothing under it is dead air (22 September: six 1.8 s silences)
SILENT_DB = -55.0       # under this level (dBFS) a pause carries no music
MUSIC_HEADROOM_DB = 6.0  # music in the pauses closer than this to the voice is louder than a bed should be
CUT_SCORE = 0.3         # ffmpeg's scene score above which two frames are a cut
SHORT_SHOT_S = 1.5      # a shot shorter than this is barely seen (22 September: eleven shots of about 1 s)
SHORT_SHOTS_MAX = 2     # more short shots than this reads as flicker
FROZEN_S = 1.0          # qa.py rejects a master with one second of identical sampled frames
RATE_TOL = 0.1          # the delivery rate, compared as a number (22 September: "60000/1001" is 59.94)
LUFS_TARGET = -16.0
TIMEOUT_S = float(os.environ.get("KLEO_REPORT_TIMEOUT_S", "240"))


def _run(args, timeout=None):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout or TIMEOUT_S)


def rate_of(text):
    """ffprobe's "60000/1001" as 59.94; 0.0 when it cannot be read. Never a string comparison."""
    num, _, den = str(text or "0/1").partition("/")
    try:
        return float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        return 0.0


def stream_info(path):
    """Size, rate, frame count (packets, so nothing is decoded) and durations of the first video and audio streams."""
    r = _run(["ffprobe", "-v", "error", "-count_packets", "-show_streams", "-show_format", "-of", "json", path])
    j = json.loads(r.stdout or "{}")
    v = next((s for s in j.get("streams", []) if s.get("codec_type") == "video"), {})
    a = next((s for s in j.get("streams", []) if s.get("codec_type") == "audio"), None)
    info = {"width": v.get("width"), "height": v.get("height"), "rate": round(rate_of(v.get("r_frame_rate")), 3),
            "rate_text": v.get("r_frame_rate"), "frames": int(v.get("nb_read_packets") or 0),
            "duration": round(float((j.get("format") or {}).get("duration") or 0), 3), "audio": None}
    if a:
        info["audio"] = {"channels": a.get("channels"), "sample_rate": int(a.get("sample_rate") or 0),
                         "duration": round(float(a.get("duration") or 0), 3)}
    return info


def audio_levels(path):
    """The sound as a list of dBFS levels, one per WINDOW_S (mono, AUDIO_SR). Empty when there is no audio."""
    r = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(AUDIO_SR),
                        "-f", "s16le", "-"], capture_output=True, timeout=TIMEOUT_S)
    samples = array.array("h")
    samples.frombytes(r.stdout[: len(r.stdout) // 2 * 2])
    if sys.byteorder != "little":
        samples.byteswap()
    n = int(AUDIO_SR * WINDOW_S)
    levels = []
    for i in range(0, len(samples) - n + 1, n):
        chunk = samples[i:i + n]
        rms = math.sqrt(sum(x * x for x in chunk) / n) / 32768.0
        levels.append(round(20 * math.log10(rms), 1) if rms > 1e-6 else -120.0)
    return levels


def percentile(values, q):
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))]


def find_pauses(levels, window=WINDOW_S):
    """(voice_db, pauses): the voice's level (90th percentile of the audible windows) and every quiet run of at least
    PAUSE_S that starts after the first sound and ends before the last one — the lead-in and the closing hold are the
    film's own breath, not a pause. Each pause: {"start", "seconds", "bed_db"} where bed_db is what lies under it."""
    audible = [x for x in levels if x > -70]
    voice = percentile(audible, 0.9)
    if voice is None:
        return None, []
    quiet = [x < voice - PAUSE_DB for x in levels]
    loud = [k for k, q in enumerate(quiet) if not q]
    if not loud:
        return voice, []
    first, last = loud[0], loud[-1]
    pauses, k = [], first
    while k <= last:
        if quiet[k]:
            j = k
            while j + 1 <= last and quiet[j + 1]:
                j += 1
            secs = (j - k + 1) * window
            if secs >= PAUSE_S - 1e-9:
                pauses.append({"start": round(k * window, 2), "seconds": round(secs, 2),
                               "bed_db": percentile(levels[k:j + 1], 0.5)})
            k = j + 1
        else:
            k += 1
    return voice, pauses


def picture_pass(path):
    """One decode for three rulers: the cuts (scene score), the longest run of identical frames sampled at 6 fps on
    a 270 px frame (qa.py's framemd5 ruler) and the black intervals (film_checks' blackdetect)."""
    md5 = tempfile.NamedTemporaryFile(prefix="kleo-report-", suffix=".md5", delete=False).name
    fc = ("[0:v]scale=320:-2,split=3[a][b][c];"
          f"[a]select='gt(scene,{CUT_SCORE})',showinfo[sa];"
          "[b]fps=6,scale=270:-2[fb];"
          "[c]blackdetect=d=0.15:pic_th=0.98:pix_th=0.02[bc]")
    try:
        r = _run(["ffmpeg", "-nostdin", "-hide_banner", "-v", "info", "-y", "-i", path, "-filter_complex", fc,
                  "-map", "[sa]", "-f", "null", "-", "-map", "[fb]", "-f", "framemd5", md5, "-map", "[bc]", "-f", "null", "-"])
        cuts = [round(float(t), 3) for t in re.findall(r"Parsed_showinfo.*?pts_time:\s*([\d.]+)", r.stderr)]
        black = [[round(float(a), 2), round(float(b), 2)] for a, b in re.findall(r"black_start:([\d.]+) black_end:([\d.]+)", r.stderr)]
        with open(md5) as f:
            vals = [l.split(",")[-1].strip() for l in f.read().splitlines() if l and not l.startswith("#")]
    finally:
        try:
            os.remove(md5)
        except OSError:
            pass
    streak = longest = 0
    for left, right in zip(vals, vals[1:]):
        streak = streak + 1 if left == right else 0
        longest = max(longest, streak)
    return sorted(set(cuts)), black, round(longest / 6.0, 2)


def loudness(path):
    """Integrated loudness and true peak of the whole film, as qa.py measures them. (None, None) without audio."""
    r = _run(["ffmpeg", "-nostdin", "-hide_banner", "-i", path, "-vn", "-af",
              "loudnorm=I=-16:TP=-1.5:LRA=7:print_format=json", "-f", "null", "-"])
    m = re.search(r"\{\s*\"input_i\".*?\}", r.stderr, re.S)
    if not m:
        return None, None
    d = json.loads(m.group())
    try:
        return round(float(d["input_i"]), 1), round(float(d["input_tp"]), 1)
    except (KeyError, ValueError):
        return None, None


def srt_stats(path):
    """Cues, first and last time, the longest cue in characters. None when there is no file."""
    if not path or not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8", errors="replace") as f:
        text = f.read()
    times = re.findall(r"(\d+):(\d+):(\d+),(\d+)\s*-->\s*(\d+):(\d+):(\d+),(\d+)", text)
    sec = lambda h, m, s, ms: int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000
    cues = [(sec(*t[:4]), sec(*t[4:])) for t in times]
    blocks = [b.strip().splitlines()[2:] for b in re.split(r"\n\s*\n", text) if b.strip()]
    longest = max((len(" ".join(b)) for b in blocks), default=0)
    return {"cues": len(cues), "first": round(cues[0][0], 2) if cues else None,
            "last": round(cues[-1][1], 2) if cues else None, "longest_chars": longest}


def verdict(rep, ordered_s=None, music_expected=None, subtitles_expected=None, fps=60):
    """The problems a person would have found by watching, each with its numbers. Hints for the next fix, not a gate."""
    out = []
    v, a = rep["video"], rep["audio"]
    if v.get("rate") and abs(v["rate"] - fps) > RATE_TOL:
        out.append(f"frame rate {v['rate']} ({v.get('rate_text')}), not {fps}")
    if v.get("frames") and v.get("duration") and abs(v["frames"] - v["duration"] * fps) > 2:
        out.append(f"{v['frames']} frames for {v['duration']} s at {fps} fps")
    if ordered_s:
        d = v["duration"] - ordered_s
        if abs(d) > max(1.5, 0.1 * ordered_s):
            out.append(f"{v['duration']:.1f} s delivered for a {ordered_s:g} s order ({d:+.1f} s)")
    if v.get("audio") is None:
        out.append("no audio stream")
    else:
        if a.get("lufs") is not None and not (LUFS_TARGET - 2.5 <= a["lufs"] <= LUFS_TARGET + 2):
            out.append(f"loudness {a['lufs']} LUFS (target {LUFS_TARGET:g})")
        if a.get("true_peak") is not None and a["true_peak"] > -0.8:
            out.append(f"true peak {a['true_peak']} dBTP")
        dead = [p for p in a["pauses"] if p["seconds"] >= DEAD_AIR_S and (p["bed_db"] if p["bed_db"] is not None else -120) < SILENT_DB]
        if dead:
            out.append(f"{len(dead)} silent pause(s) of {DEAD_AIR_S:g} s or more: "
                       + ", ".join(f"{p['seconds']:.1f} s at {p['start']:.1f} s" for p in dead[:4]))
        bed = a.get("bed_db")
        if music_expected is True and a["pauses"] and bed is not None and bed < SILENT_DB:
            out.append(f"music was asked for and the pauses are silent ({bed} dBFS)")
        if bed is not None and a.get("voice_db") is not None and bed > SILENT_DB and bed > a["voice_db"] - MUSIC_HEADROOM_DB:
            out.append(f"music {a['voice_db'] - bed:.1f} dB under the voice in the pauses (a bed sits {MUSIC_HEADROOM_DB:g} dB or more under)")
    short = rep["cuts"]["short"]
    if len(short) > SHORT_SHOTS_MAX:
        out.append(f"{len(short)} shots shorter than {SHORT_SHOT_S:g} s: " + ", ".join(f"{s['seconds']:.1f} s at {s['start']:.1f} s" for s in short[:5]))
    if rep["frozen_s"] >= FROZEN_S:
        out.append(f"{rep['frozen_s']:.1f} s of identical frames")
    if rep["black"]:
        out.append(f"black interval(s): {rep['black'][:3]}")
    if subtitles_expected is True and not (rep["subtitles"] and rep["subtitles"]["cues"]):
        out.append("subtitles were asked for and the sidecar .srt is missing or empty")
    return out


def report(video, ordered_s=None, music_expected=None, subtitles_expected=None, srt=None, fps=60):
    """The whole report for one video file. Raises only when the file cannot be read at all."""
    info = stream_info(video)
    if not info.get("width"):
        raise ValueError(f"no video stream in {video}")
    rep = {"version": VERSION, "video": info, "ordered_s": ordered_s, "music_expected": music_expected,
           "subtitles_expected": subtitles_expected}
    levels = audio_levels(video) if info["audio"] else []
    voice, pauses = find_pauses(levels)
    lufs, peak = loudness(video) if info["audio"] else (None, None)
    beds = [p["bed_db"] for p in pauses if p["bed_db"] is not None]
    rep["audio"] = {"lufs": lufs, "true_peak": peak, "voice_db": voice, "pauses": pauses,
                    "bed_db": percentile(beds, 0.5), "longest_pause_s": max((p["seconds"] for p in pauses), default=0.0)}
    cuts, black, frozen = picture_pass(video)
    edges = [0.0] + [c for c in cuts if 0 < c < info["duration"]] + [info["duration"]]
    shots = [{"start": round(a, 2), "seconds": round(b - a, 2)} for a, b in zip(edges, edges[1:]) if b > a]
    rep["cuts"] = {"count": len(edges) - 2, "at": cuts, "shortest_s": min((s["seconds"] for s in shots), default=None),
                   "short": [s for s in shots if s["seconds"] < SHORT_SHOT_S]}
    rep["black"], rep["frozen_s"] = black, frozen
    rep["subtitles"] = srt_stats(srt)
    rep["problems"] = verdict(rep, ordered_s, music_expected, subtitles_expected, fps)
    return rep


def summary(rep):
    """One line for the log."""
    v, a = rep["video"], rep["audio"]
    order = f" for {rep['ordered_s']:g} s" if rep.get("ordered_s") else ""
    return (f"{v['duration']:.1f} s{order}, {v['width']}x{v['height']} at {v['rate']:g} fps, {v['frames']} frames; "
            f"{a['lufs']} LUFS, voice {a['voice_db']} dBFS, {len(a['pauses'])} pause(s) (longest {a['longest_pause_s']:.1f} s, "
            f"bed {a['bed_db']} dBFS); {rep['cuts']['count']} cut(s), shortest shot {rep['cuts']['shortest_s']} s; "
            f"frozen {rep['frozen_s']:.1f} s; {len(rep['problems'])} problem(s)")


def expectations(params):
    """(ordered_s, music_expected, subtitles_expected) from a job's params. A key that is absent is unknown (None):
    the question was not asked on that job, so its answer is not held against the film."""
    p = params if isinstance(params, dict) else {}
    try:
        ordered = float(p["duration_s"]) if p.get("duration_s") else None
    except (TypeError, ValueError):
        ordered = None
    music = (p["music"] is not None and p["music"] is not False) if "music" in p else None
    subs = bool(p["subtitles"]) if "subtitles" in p and p["subtitles"] is not None else None
    return ordered, music, subs


def main(argv=None):
    ap = argparse.ArgumentParser(description="Measure a finished Kleo video and list what to fix next.")
    ap.add_argument("video")
    ap.add_argument("--ordered", type=float, help="the length the user ordered, seconds")
    ap.add_argument("--music", choices=("yes", "no"), help="whether the user asked for music")
    ap.add_argument("--subtitles", choices=("yes", "no"), help="whether the user asked for subtitles")
    ap.add_argument("--srt", help="the sidecar subtitles")
    ap.add_argument("--json", action="store_true", help="print the whole report as JSON")
    a = ap.parse_args(argv)
    yes = lambda x: None if x is None else x == "yes"
    rep = report(a.video, a.ordered, yes(a.music), yes(a.subtitles), a.srt)
    if a.json:
        print(json.dumps(rep, indent=1))
    else:
        print(summary(rep))
        for p in rep["problems"]:
            print("  PROBLEM:", p)
    return 1 if rep["problems"] else 0


if __name__ == "__main__":
    sys.exit(main())
