#!/usr/bin/env python3
"""THE FILM, END TO END, ON FAKE CLIPS: the chain a finish box runs, with real ffmpeg, for zero dollars (27 September 2026).

Between 22 and 25 September four defects of the finish chain were found on rented cards, after the clips had been paid
for: a 59.94 master refused by a string comparison of its frame rate (render.mjs validPart and qa.py, six finish rentals
of gt_nyhb8aj9), a master cut by a time its parts' timestamps did not agree on ("Invalid master"), and a mono narration
refused by the sidechain against a stereo music track ("could not choose their formats", gt_ujavdzva, the first film
with music failed at its last step). Every one was a bug of the CHAIN — how one stage's file meets the next stage's
filter — and every unit test of film_finish was blind to it by construction: test_kleo_worker_graphics.py fakes ffmpeg,
the engine and the clips.

So here the chain runs for real, on clips of 128x72 made by ffmpeg at 59.94 fps (kie.ai's MiniMax rate), with the
awkward cases a real film brings: a scene length that is not a whole number of frames, a clip too short for its shot
(slowed), a clip with a frozen tail (dropped before the cut), a dissolve between two acts, a music track shorter than
the film (looped), a mono 24 kHz narration against stereo 48 kHz music.

REAL: render.mjs --shots (the cut plan out of picture.js), kleo_video.build_footage (59.94 clips to the 60 fps track),
fetch_music + shape_music, and both endings of film_finish — the plain mux (MIX_CHAIN) and the layer (run.py
--skip-voice: the two-pass loudnorm mix, render.mjs compositing onto the footage in parallel parts, the concat, the
master check, qa.py) — then film_checks, the .srt, the thumbnail, and kleo_report on both films.
FAKE: Chromium (a stub `playwright` package hands render.mjs the same transparent PNG with one magenta square for every
frame, so the composite is visible and measurable), Kokoro and whisper (voice.wav is a tone shaped like speech and the
timeline is written by hand), the network (api, urlopen). 960x540 is the smallest 16:9 width contract.py accepts.

Needs ffmpeg, ffprobe and node >= 20.11. In CI (GITHUB_ACTIONS) a missing tool is a failure, elsewhere a skip — and
nothing of Kleo runs on the owner's PC: this runs in GitHub Actions or on a rented box.
Run: python3 -m unittest test_film_e2e -v        (from worker/)
"""
import importlib.util, io, json, math, os, shutil, struct, subprocess, sys, tempfile, unittest, wave

HERE = os.path.dirname(os.path.abspath(__file__))
KEOU = os.path.join(HERE, "keou")
if HERE not in sys.path:
    sys.path.insert(0, HERE)


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


kw = load_module("kleo_worker_under_e2e", os.path.join(HERE, "kleo_worker.py"))
import kleo_report  # noqa: E402

W, H, FPS = 960, 540, 60
CLIP_W, CLIP_H, CLIP_RATE = 128, 72, "60000/1001"
SCENES = [
    # id, kind, voice, captions, (start, end), (audio_start, audio_end), shots
    ("01-climb", "cinema", "The keeper climbs the stairs every night.",
     ["The keeper climbs", "the stairs every night."], (0.0, 3.137), (0.22, 2.70), 2),
    ("02-lamp", "closing", "Tonight the lamp answers back.",
     ["Tonight the lamp", "answers back."], (3.137, 5.911), (3.357, 5.00), 1),
]
DURATION = 5.911          # not a whole number of 60 fps frames (354.66): the master is cut by frames, never by time
MUSIC_SECONDS = 3.5       # shorter than the film: shape_music must loop it
FAKE_FRAME_ENV = "KLEO_FAKE_FRAME"
STUB_PLAYWRIGHT = """import {readFileSync} from 'node:fs';
// The stand-in for Chromium (worker/test_film_e2e.py): every frame render.mjs asks for is the same PNG, a transparent
// canvas with one magenta square, so the composite onto the footage is real and can be measured in the master.
const png = readFileSync(process.env.%s).toString('base64');
const page = { on() {}, async goto() {}, async close() {}, async evaluate(fn, arg) { return typeof arg === 'number' ? png : undefined; } };
export const chromium = { async launch() { return { async newPage() { return page; }, async close() {} }; } };
""" % FAKE_FRAME_ENV


def tools_or_skip(case):
    """ffmpeg, ffprobe and a node that has import.meta.dirname (render.mjs uses it): a failure in CI, a skip elsewhere."""
    missing = [t for t in ("ffmpeg", "ffprobe", "node") if not shutil.which(t)]
    if not missing:
        v = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip().lstrip("v")
        major, minor = (int(x) for x in (v.split(".") + ["0", "0"])[:2])
        if (major, minor) < (20, 11):
            missing.append(f"node >= 20.11 (found {v})")
    if missing:
        why = "the film chain needs " + ", ".join(missing)
        if os.environ.get("GITHUB_ACTIONS"):
            raise AssertionError(why)
        raise unittest.SkipTest(why)


def ff(*args):
    r = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg " + " ".join(args[-3:]) + ": " + r.stderr[-400:])


def probe(path, count=False):
    r = subprocess.run(["ffprobe", "-v", "error", *(["-count_frames"] if count else []), "-show_streams", "-show_format",
                        "-of", "json", path], capture_output=True, text=True)
    return json.loads(r.stdout)


def video_of(p):
    return next(s for s in p["streams"] if s["codec_type"] == "video")


def audio_of(p):
    return next((s for s in p["streams"] if s["codec_type"] == "audio"), None)


def pixel(video, t, x, y):
    """(r, g, b) of one pixel of the frame at `t` seconds."""
    r = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{t:.3f}", "-i", video, "-frames:v", "1",
                        "-vf", f"crop=1:1:{x}:{y}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True)
    return tuple(r.stdout[:3])


def write_voice(path, spans, duration, sr=24000):
    """Kokoro's shape: mono, 24 kHz, 24-bit, sound only inside each scene's audio span — a 140 Hz voice with harmonics
    and a 4 Hz syllable envelope, silence everywhere else."""
    frames = bytearray()
    for i in range(int(round(duration * sr))):
        t = i / sr
        v = 0.0
        if any(a <= t < b for a, b in spans):
            env = 0.55 + 0.45 * math.sin(2 * math.pi * 4 * t)
            v = 0.3 * env * (math.sin(2 * math.pi * 140 * t) + 0.5 * math.sin(2 * math.pi * 280 * t) + 0.25 * math.sin(2 * math.pi * 420 * t))
        frames += struct.pack("<i", int(max(-1.0, min(1.0, v)) * 8388607))[:3]
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(3); w.setframerate(sr); w.writeframes(bytes(frames))


def project():
    """The bundle's project.json as the GPU phase leaves it: no backdrop and no clip yet (film_overlay binds them)."""
    return {
        "schema_version": 1, "editorial_status": "ready", "id": "e2e-film", "title": "The keeper", "brand": "Kleo",
        "style": "picture", "look": "realistic", "format": "16:9", "width": W, "fps": FPS, "language": "en",
        "voice": "am_michael", "music": "track", "music_brief": "a slow piano over low strings, no drums",
        "graphics": {"accent": "#ffb347", "subtitles": "cinema", "chapters": "none",
                     "hud": [{"id": "signal", "kind": "line", "edge": "bottom", "means": "the lamp"}]},
        "scenes": [dict({"id": sid, "kind": kind, "voice": voice,
                         "shots": [{"image": f"img/{sid}-s{n + 1}.png", "motion": "push_in", "strength": 0.8} for n in range(nshots)]},
                        **({"transition": "dissolve"} if i else {}))
                   for i, (sid, kind, voice, _, _, _, nshots) in enumerate(SCENES)],
    }


def timeline():
    """What prepare.py would have written: the project's scenes with their measured times, captions and words."""
    scenes = []
    for sc, (sid, kind, voice, caps, (start, end), (a0, a1), _) in zip(project()["scenes"], SCENES):
        words = voice.split()
        step = (a1 - a0) / len(words)
        half = a0 + (a1 - a0) / 2
        scenes.append(dict(sc, start=start, end=end, audio_start=a0, audio_end=a1, speech_match=0.97, transcript=voice,
                           captions=[{"start": a0, "end": half, "text": caps[0]}, {"start": half, "end": min(a1 + .12, end - .1), "text": caps[1]}],
                           words=[{"word": w, "start": a0 + k * step, "end": a0 + (k + 1) * step} for k, w in enumerate(words)]))
    return {"duration": DURATION, "fps": FPS, "scenes": scenes, "tts": "fake", "device": "cpu", "version": "e2e"}


class FilmEndToEnd(unittest.TestCase):
    """One film, laid and finished twice (with the layer, and as the plain mux), then measured."""

    @classmethod
    def setUpClass(cls):
        tools_or_skip(cls)
        cls.tmp = tempfile.mkdtemp(prefix="kleo-e2e-")
        cls.errors, cls.logs, cls.api_calls = {}, [], []
        cls.engine = os.path.join(cls.tmp, "keou")
        shutil.copytree(KEOU, cls.engine, ignore=shutil.ignore_patterns("node_modules", ".venv", "projects", "examples", "docs", "*.orig"))
        stub = os.path.join(cls.engine, "node_modules", "playwright")
        os.makedirs(stub)
        with open(os.path.join(stub, "package.json"), "w") as f:
            json.dump({"name": "playwright", "version": "0.0.0-kleo-e2e", "type": "module", "exports": "./index.js"}, f)
        with open(os.path.join(stub, "index.js"), "w") as f:
            f.write(STUB_PLAYWRIGHT)
        from PIL import Image, ImageDraw
        cls.frame = os.path.join(cls.tmp, "frame.png")
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(img).rectangle([20, 20, 79, 79], fill=(255, 0, 255, 255))
        img.save(cls.frame)
        cls.saved = {k: getattr(kw, k) for k in ("KEOU_DIR", "progress", "api", "log", "JOB")}
        cls.saved_urlopen = kw.urllib.request.urlopen
        cls.saved_env = os.environ.get(FAKE_FRAME_ENV)
        os.environ[FAKE_FRAME_ENV] = cls.frame
        kw.KEOU_DIR, kw.JOB = cls.engine, "gt_e2e"
        kw.progress = lambda *a, **k: None
        kw.log = lambda *a: cls.logs.append(" ".join(str(x) for x in a))

        def api(method, path, data=None, **k):
            cls.api_calls.append((method, path, data))
            return {"state": "ready"}
        kw.api = api
        cls.music_src = os.path.join(cls.tmp, "suno.mp3")
        try:
            ff("-f", "lavfi", "-i", f"sine=f=220:d={MUSIC_SECONDS}", "-f", "lavfi", "-i", f"sine=f=330:d={MUSIC_SECONDS}",
               "-filter_complex", "[0:a][1:a]amerge=inputs=2[a]", "-map", "[a]", "-ar", "44100", "-c:a", "libmp3lame", "-q:a", "4", cls.music_src)
        except RuntimeError:
            cls.music_src = os.path.join(cls.tmp, "suno.wav")      # an ffmpeg without lame: the track is a wav, still stereo 44.1k
            ff("-f", "lavfi", "-i", f"sine=f=220:d={MUSIC_SECONDS}", "-f", "lavfi", "-i", f"sine=f=330:d={MUSIC_SECONDS}",
               "-filter_complex", "[0:a][1:a]amerge=inputs=2[a]", "-map", "[a]", "-ar", "44100", cls.music_src)
        kw.urllib.request.urlopen = lambda req, timeout=None: io.BytesIO(open(cls.music_src, "rb").read())
        try:
            cls.chain()
        except Exception as e:   # recorded per stage below; the tests report it
            cls.errors.setdefault("setup", repr(e))

    @classmethod
    def tearDownClass(cls):
        for k, v in getattr(cls, "saved", {}).items():
            setattr(kw, k, v)
        if hasattr(cls, "saved_urlopen"):
            kw.urllib.request.urlopen = cls.saved_urlopen
        if getattr(cls, "saved_env", None) is None:
            os.environ.pop(FAKE_FRAME_ENV, None)
        else:
            os.environ[FAKE_FRAME_ENV] = cls.saved_env
        shutil.rmtree(getattr(cls, "tmp", ""), ignore_errors=True)

    @classmethod
    def stage(cls, name, fn, needs=()):
        failed = [n for n in ("setup",) + tuple(needs) if n in cls.errors]
        if failed:
            cls.errors[name] = "not reached: " + ", ".join(failed) + " failed"
            return None
        try:
            return fn()
        except BaseException as e:
            tail = "\n".join(cls.logs[-25:])
            cls.errors[name] = f"{e!r}\n--- last log lines ---\n{tail}"
            return None

    @classmethod
    def chain(cls):
        pdir = cls.pdir = os.path.join(cls.engine, "projects", "e2e-film")
        build = os.path.join(pdir, "build")
        os.makedirs(build)
        with open(os.path.join(pdir, "project.json"), "w") as f:
            json.dump(project(), f, indent=1)
        with open(os.path.join(build, "timeline.json"), "w") as f:
            json.dump(timeline(), f, indent=1)
        write_voice(os.path.join(build, "voice.wav"), [s[5] for s in SCENES], DURATION)

        def shots():
            r = subprocess.run(["node", os.path.join(cls.engine, "engine", "render.mjs"), os.path.join(pdir, "project.json"), "--shots"],
                               cwd=cls.engine, capture_output=True, text=True)
            if r.returncode != 0:
                raise RuntimeError("render.mjs --shots: " + (r.stderr or r.stdout)[-600:])
            with open(os.path.join(build, "shots.json")) as f:
                return json.load(f)
        cls.plan = cls.stage("plan", shots)

        def clips():
            """The clips a paid road would have bought, one per shot, at 59.94: the first a little longer than its slot,
            the second too short (it must be slowed), the third with a frozen second at its end (it must be dropped)."""
            os.makedirs(os.path.join(pdir, "clips"))
            sources = ["testsrc2", "mandelbrot", "testsrc2"]
            k = 0
            for sc in cls.plan["scenes"]:
                for sh in sc["shots"]:
                    slot = sh["end"] - sh["start"]
                    cid = f"{sc['id']}-s{sh['index'] + 1}"
                    src = f"{sources[k]}=size={CLIP_W}x{CLIP_H}:rate={CLIP_RATE}"
                    if k == 0:
                        ff("-f", "lavfi", "-i", src, "-t", f"{slot + .3:.3f}", "-pix_fmt", "yuv420p", os.path.join(pdir, "clips", cid + ".mp4"))
                    elif k == 1:
                        ff("-f", "lavfi", "-i", src, "-t", f"{(slot + .8) / 1.4:.3f}", "-pix_fmt", "yuv420p", os.path.join(pdir, "clips", cid + ".mp4"))
                    else:
                        ff("-f", "lavfi", "-i", f"{src}:duration={slot:.3f}", "-vf", "negate,tpad=stop_mode=clone:stop_duration=0.9",
                           "-pix_fmt", "yuv420p", os.path.join(pdir, "clips", cid + ".mp4"))
                    k += 1
        cls.stage("clips", clips, needs=("plan",))

        cls.out_layer = os.path.join(cls.tmp, "out-layer")
        os.makedirs(cls.out_layer)
        cls.files_layer = cls.stage("film with the layer", lambda: kw.film_finish(pdir, cls.out_layer, lay_track=True), needs=("clips",))

        def plain():
            pdir_b = cls.pdir_plain = os.path.join(cls.engine, "projects", "e2e-plain")
            shutil.copytree(pdir, pdir_b, ignore=shutil.ignore_patterns("out"))
            p = project()
            p.pop("graphics")
            with open(os.path.join(pdir_b, "project.json"), "w") as f:
                json.dump(p, f, indent=1)
            if os.path.isfile(os.path.join(pdir_b, "build", "music.wav")):
                os.remove(os.path.join(pdir_b, "build", "music.wav"))
            out = cls.out_plain = os.path.join(cls.tmp, "out-plain")
            os.makedirs(out)
            return kw.film_finish(pdir_b, out, lay_track=False)
        cls.files_plain = cls.stage("film without a layer", plain, needs=("clips",))

        job = {"params": {"duration_s": 6, "format": "16:9", "music": "a slow piano over low strings", "subtitles": True}}
        cls.report_layer = cls.stage("report of the layer film", lambda: json.load(open(kw.self_report(cls.files_layer, job, cls.out_layer))),
                                     needs=("film with the layer",))
        cls.report_plain = cls.stage("report of the plain film", lambda: json.load(open(kw.self_report(cls.files_plain, job, cls.out_plain))),
                                     needs=("film without a layer",))

    def reached(self, *names):
        for n in ("setup",) + names:
            if n in self.errors:
                self.fail(f"{n}: {self.errors[n]}")

    # ---- the plan --------------------------------------------------------------------------------------------------
    def test_the_engine_plans_the_cuts_and_the_dissolve(self):
        self.reached("plan")
        p = self.plan
        self.assertEqual((p["width"], p["height"], p["fps"]), (W, H, FPS))
        self.assertAlmostEqual(p["dissolve_s"], 0.8)
        self.assertEqual([s["transition"] for s in p["scenes"]], ["cut", "dissolve"])
        cuts = [(sh["start"], sh["end"]) for s in p["scenes"] for sh in s["shots"]]
        self.assertAlmostEqual(cuts[0][0], 0.0)
        self.assertAlmostEqual(cuts[-1][1], DURATION, places=3)
        for (a0, a1), (b0, _) in zip(cuts, cuts[1:]):
            self.assertAlmostEqual(a1, b0, places=6, msg="the shots cover the film end to end")

    # ---- the track -------------------------------------------------------------------------------------------------
    def test_the_track_is_60_fps_at_the_films_length_from_5994_clips(self):
        self.reached("plan", "clips")
        self.assertTrue(os.path.isfile(os.path.join(self.pdir, "build", "footage.mp4")),
                        f"the track was not laid: {self.errors.get('film with the layer')}")
        clip = video_of(probe(os.path.join(self.pdir, "clips", "01-climb-s1.mp4")))
        self.assertEqual(clip["r_frame_rate"], "60000/1001", "the fixture really is kie.ai's rate")
        track = probe(os.path.join(self.pdir, "build", "footage.mp4"))
        v = video_of(track)
        self.assertEqual((v["width"], v["height"]), (W, H))
        self.assertAlmostEqual(kleo_report.rate_of(v["r_frame_rate"]), FPS, delta=0.1)
        self.assertAlmostEqual(float(track["format"]["duration"]), DURATION, delta=1 / FPS + 0.02)
        said = "\n".join(self.logs)
        self.assertIn("1 dissolve(s) between acts", said)
        self.assertIn("slowed", said, "the short clip is slowed, not held")
        self.assertIn("do not move", said, "the frozen tail is found and dropped before the cut")

    def test_the_music_is_looped_to_the_film_and_shaped_to_stereo_48k(self):
        self.reached("clips")
        posts = [c for c in self.api_calls if c[0] == "POST" and c[1].endswith("/music")]
        self.assertTrue(posts, "the track is ordered")
        self.assertEqual(posts[0][2]["brief"], project()["music_brief"])
        a = audio_of(probe(os.path.join(self.pdir, "build", "music.wav")))
        self.assertEqual((a["channels"], a["sample_rate"]), (2, "48000"))
        self.assertAlmostEqual(float(a["duration"]), DURATION, delta=0.05, msg="a 3.5 s track is looped to the film")

    # ---- the two endings -------------------------------------------------------------------------------------------
    def check_delivery(self, files):
        video = files["video.mp4"]
        p = probe(video, count=True)
        v, a = video_of(p), audio_of(p)
        self.assertEqual((v["width"], v["height"]), (W, H))
        self.assertAlmostEqual(kleo_report.rate_of(v["r_frame_rate"]), FPS, delta=0.1, msg=v["r_frame_rate"])
        self.assertLessEqual(abs(int(v["nb_read_frames"]) - DURATION * FPS), 2)
        self.assertIsNotNone(a, "the narration is on the film")
        self.assertEqual((a["channels"], a["sample_rate"]), (2, "48000"))
        self.assertAlmostEqual(float(p["format"]["duration"]), DURATION, delta=0.25)
        with open(files["subtitles.srt"]) as f:
            self.assertEqual(f.read().count("-->"), 4, "one cue per caption group")
        self.assertGreater(os.path.getsize(files["thumbnail.jpg"]), 0)

    def test_the_layer_film_is_composited_mixed_and_passes_qa(self):
        self.reached("film with the layer")
        self.check_delivery(self.files_layer)
        with open(os.path.join(self.pdir, "out", "FINAL-QA.json")) as f:
            qa = json.load(f)
        self.assertEqual(qa["status"], "PASS")
        film, track = self.files_layer["video.mp4"], os.path.join(self.pdir, "build", "footage.mp4")
        r, g, b = pixel(film, 2.0, 50, 50)
        self.assertTrue(r >= 200 and g <= 70 and b >= 200, f"the layer's magenta square is on the film: {(r, g, b)}")
        film_px, track_px = pixel(film, 2.0, W // 2, H // 2), pixel(track, 2.0, W // 2, H // 2)
        self.assertTrue(all(abs(x - y) <= 40 for x, y in zip(film_px, track_px)),
                        f"outside the square the layer is transparent: film {film_px}, footage {track_px}")

    def test_the_plain_film_mixes_a_mono_voice_with_stereo_music(self):
        self.reached("film without a layer")
        self.check_delivery(self.files_plain)

    # ---- what Kleo says about them -----------------------------------------------------------------------------------
    def test_kleo_reports_both_films_and_finds_nothing_wrong(self):
        self.reached("report of the layer film", "report of the plain film")
        for rep in (self.report_layer, self.report_plain):
            self.assertEqual(rep["problems"], [], json.dumps(rep, indent=1))
            self.assertEqual(rep["job_id"], "gt_e2e")
            self.assertEqual(rep["ordered_s"], 6.0)
            self.assertTrue(rep["music_expected"])
            self.assertEqual(rep["subtitles"]["cues"], 4)
            self.assertAlmostEqual(rep["video"]["duration"], DURATION, delta=0.25)
            self.assertGreaterEqual(rep["cuts"]["count"], 1, "the hard cut between the first two shots is seen")
        said = "\n".join(self.logs)
        self.assertIn("REPORT", said)


class ReportTest(unittest.TestCase):
    """kleo_report on a film made to be wrong, and its pure parts."""

    def test_a_bad_film_is_described_in_numbers(self):
        tools_or_skip(self)
        tmp = tempfile.mkdtemp(prefix="kleo-report-")
        self.addCleanup(shutil.rmtree, tmp, True)
        bad = os.path.join(tmp, "bad.mp4")
        # Four shots of 0.6 s then one of 2 s; a voice, two seconds of nothing, the voice again: 4.4 s for a 10 s order.
        seg = lambda src, extra="": f"{src}=size=160x90:rate=30{extra}"
        fc = (f"{seg('testsrc2')},trim=duration=0.6,setpts=PTS-STARTPTS[a];{seg('mandelbrot')},trim=duration=0.6,setpts=PTS-STARTPTS[b];"
              f"{seg('testsrc2')},negate,trim=duration=0.6,setpts=PTS-STARTPTS[c];{seg('mandelbrot')},negate,trim=duration=0.6,setpts=PTS-STARTPTS[d];"
              f"{seg('testsrc2')},hue=h=90,trim=duration=2,setpts=PTS-STARTPTS[e];[a][b][c][d][e]concat=n=5:v=1:a=0,format=yuv420p[v];"
              "aevalsrc='0.3*sin(2*PI*220*t)*(lt(t,1)+gte(t,3))':s=48000:d=4.4[x]")
        ff("-filter_complex", fc, "-map", "[v]", "-map", "[x]", "-c:v", "libx264", "-c:a", "aac", "-shortest", bad)
        srt = os.path.join(tmp, "empty.srt")
        open(srt, "w").close()
        rep = kleo_report.report(bad, ordered_s=10, music_expected=True, subtitles_expected=True, srt=srt, fps=30)
        said = "\n".join(rep["problems"])
        self.assertIn("delivered for a 10 s order", said)
        self.assertIn("silent pause", said)
        self.assertIn("music was asked for and the pauses are silent", said)
        self.assertIn("shorter than 1.5 s", said)
        self.assertIn("subtitles were asked for", said)
        self.assertAlmostEqual(rep["audio"]["pauses"][0]["start"], 1.0, delta=0.15)
        self.assertAlmostEqual(rep["audio"]["pauses"][0]["seconds"], 2.0, delta=0.2)
        self.assertGreaterEqual(rep["cuts"]["count"], 3)

    def test_pauses_ignore_the_lead_in_and_the_closing_hold(self):
        loud, quiet = -18.0, -120.0
        levels = [quiet] * 3 + [loud] * 20 + [quiet] * 15 + [loud] * 20 + [quiet] * 12
        voice, pauses = kleo_report.find_pauses(levels)
        self.assertEqual(voice, loud)
        self.assertEqual(pauses, [{"start": 2.3, "seconds": 1.5, "bed_db": quiet}])

    def test_a_pause_with_music_under_it_is_not_dead_air(self):
        levels = [-18.0] * 20 + [-40.0] * 15 + [-18.0] * 20
        voice, pauses = kleo_report.find_pauses(levels)
        rep = {"video": {"rate": 60, "rate_text": "60/1", "frames": 330, "duration": 5.5, "audio": {"channels": 2}},
               "audio": {"lufs": -16, "true_peak": -1.5, "voice_db": voice, "pauses": pauses, "bed_db": -40.0},
               "cuts": {"short": []}, "frozen_s": 0, "black": [], "subtitles": None}
        self.assertEqual(kleo_report.verdict(rep, music_expected=True), [])

    def test_the_rate_is_a_number(self):
        self.assertAlmostEqual(kleo_report.rate_of("60000/1001"), 59.94, places=2)
        self.assertEqual(kleo_report.rate_of("60/1"), 60.0)
        self.assertEqual(kleo_report.rate_of(None), 0.0)

    def test_what_the_job_asked_for(self):
        self.assertEqual(kleo_report.expectations({"duration_s": 30, "music": None, "subtitles": False}), (30.0, False, False))
        self.assertEqual(kleo_report.expectations({"duration_s": 15, "music": "piano", "subtitles": True}), (15.0, True, True))
        self.assertEqual(kleo_report.expectations({"duration_s": 15}), (15.0, None, None), "a question never asked is not held against the film")
        self.assertEqual(kleo_report.expectations(None), (None, None, None))


if __name__ == "__main__":
    unittest.main()
