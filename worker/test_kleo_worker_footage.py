#!/usr/bin/env python3
"""
The kie.ai road inside kleo_worker.py, without a network: the server is a fake `api` and a fake `urlopen`. What is
under test is the box's side of the contract with src/footage.ts — it uploads each shot's still under its picture
id, sends the plan once, polls until every shot is ready or failed, downloads only real mp4 files, and hands
generate_footage the same {shot_id: path} dict the local model would have, so everything after (the track, the
backdrop rule, the engine's contract) stays the code test_kleo_worker_video.py already defends.

Run: python3 -m unittest worker.test_kleo_worker_footage       (from the repo root)
"""
import importlib.util, io, json, os, shutil, sys, tempfile, unittest, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


kw = load_module("kleo_worker_under_footage_test", os.path.join(HERE, "kleo_worker.py"))
MP4 = b"\0\0\0\x18ftypisom" + b"\0" * 2048


def load_prepare():
    """worker/keou/prepare.py, whose pure helpers fit a line to its clips (it imports its sibling contract.py by name)."""
    keou = os.path.join(HERE, "keou")
    if keou not in sys.path:
        sys.path.insert(0, keou)
    return load_module("keou_prepare_under_footage_test", os.path.join(keou, "prepare.py"))


pp = load_prepare()


class FakeServer:
    """The three routes the box talks to, plus the clip download. Scripted: which shots succeed, which fail."""

    def __init__(self, ready=(), failed=None, refuse=None, polls_before_ready=1):
        self.ready, self.failed, self.refuse = list(ready), dict(failed or {}), refuse
        self.polls_before_ready, self.polls = polls_before_ready, 0
        self.stills, self.plans, self.clips_served = {}, [], []

    def api(self, method, path, data=None, raw=None, ctype="application/json", retries=3):
        if method == "PUT" and "/stills/" in path:
            name = path.rsplit("/", 1)[1]
            self.stills[name] = (ctype, len(raw))
            return {"ok": True, "name": name, "size": len(raw)}
        if method == "POST" and path.endswith("/footage"):
            if self.refuse:
                raise urllib.error.HTTPError(path, self.refuse, "refused", {}, io.BytesIO(b'{"error":"budget"}'))
            self.plans.append(data)
            ids = [s["id"] for s in data["shots"]]
            return {"model": "kling-3.0", "ordered": len(ids), "clips": {i: "generating" for i in ids}, "ready": [], "pending": ids, "failed": {}}
        if method == "GET" and path.endswith("/footage"):
            self.polls += 1
            ids = [s["id"] for p in self.plans for s in p["shots"]]
            ready = self.ready if self.polls >= self.polls_before_ready else []
            pending = [i for i in ids if i not in ready and i not in self.failed]
            return {"model": "kling-3.0", "clips": {}, "ready": ready, "pending": pending, "failed": self.failed}
        if method == "POST" and path.endswith("/music"):
            self.music_orders = getattr(self, "music_orders", []) + [data]
            if getattr(self, "music_refuse", None):
                raise urllib.error.HTTPError(path, self.music_refuse, "refused", {}, io.BytesIO(b'{"error":"off"}'))
            return {"state": "generating", "model": "suno-v5", "cost_usd": 0.06}
        if method == "GET" and path.endswith("/music"):
            self.music_polls = getattr(self, "music_polls", 0) + 1
            state = getattr(self, "music_state", "ready")
            return {"state": state, "model": "suno-v5", "cost_usd": 0.06, **({"url": f"/internal/jobs/{kw.JOB}/music/file"} if state == "ready" else {})}
        raise AssertionError(f"unexpected call {method} {path}")

    def urlopen(self, req, timeout=0):
        url = req.full_url
        if url.endswith("/music/file"):
            assert req.get_header("Authorization") == f"Bearer {kw.SECRET}", "the track download carries the job secret"
            r = io.BytesIO(getattr(self, "music_bytes", b""))
            r.__enter__ = lambda: r
            r.__exit__ = lambda *a: None
            return r
        sid = url.rsplit("/", 1)[1]
        assert req.get_header("Authorization") == f"Bearer {kw.SECRET}", "the clip download carries the job secret"
        self.clips_served.append(sid)
        body = b"not a video" if sid.endswith("-junk") else MP4
        r = io.BytesIO(body)
        r.__enter__ = lambda: r
        r.__exit__ = lambda *a: None
        return r


class FootageRoadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kleo-footage-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.saved = {k: getattr(kw, k) for k in ("api", "progress", "FOOTAGE_BACKEND", "SECRET", "API", "JOB")}
        self.saved_urlopen = kw.urllib.request.urlopen
        kw.progress = lambda *a, **k: None
        kw.SECRET, kw.API, kw.JOB = "wsecret", "http://kleo.test", "gt_test1234"
        kw.FOOTAGE_BACKEND = "kie"
        self.addCleanup(lambda: [setattr(kw, k, v) for k, v in self.saved.items()])
        self.addCleanup(lambda: setattr(kw.urllib.request, "urlopen", self.saved_urlopen))
        self.still = os.path.join(self.tmp, "01-hook-s1.png")
        with open(self.still, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n" + b"\0" * 100)

    def serve(self, server):
        kw.api = server.api
        kw.urllib.request.urlopen = server.urlopen

    def units(self, *ids):
        out = []
        for i in ids:
            out.append({"id": i, "image_prompt": f"shot {i}", "motion": "push_in", "strength": 0.7,
                        "image": self.still if i == "01-hook-s1" else None})
        return out

    # ---- the switch -----------------------------------------------------------------------------------------

    def test_the_env_decides_and_the_job_spec_fills_in(self):
        kw.FOOTAGE_BACKEND = ""
        self.assertEqual(kw.footage_backend(), "local", "silence is the local road")
        self.assertEqual(kw.set_footage_backend({"footage": {"backend": "kie", "model": "kling-3.0"}}), "kie")
        kw.FOOTAGE_BACKEND = "local"
        self.assertEqual(kw.set_footage_backend({"footage": {"backend": "kie"}}), "local", "the env wins over the spec")
        kw.FOOTAGE_BACKEND = "nonsense"
        self.assertEqual(kw.footage_backend(), "local")

    # ---- the road -------------------------------------------------------------------------------------------

    def test_the_box_uploads_the_still_sends_the_plan_once_and_downloads_every_ready_clip(self):
        srv = FakeServer(ready=["01-hook-s1", "02-city-s1"], polls_before_ready=2)
        self.serve(srv)
        out = os.path.join(self.tmp, "clips")
        made = kw.remote_clips(self.units("01-hook-s1", "02-city-s1"), "realistic", "9:16", out,
                               seconds_of={"01-hook-s1": 3.2, "02-city-s1": 7.5}, wait_min=1, poll_s=0)
        self.assertEqual(srv.stills, {"01-hook-s1.png": ("image/png", 108)}, "only the shot that has a still uploads one")
        self.assertEqual(len(srv.plans), 1)
        plan = srv.plans[0]
        self.assertEqual(plan["format"], "9:16")
        self.assertEqual(plan["look"], "realistic")
        self.assertEqual([s["id"] for s in plan["shots"]], ["01-hook-s1", "02-city-s1"])
        self.assertEqual(plan["shots"][0]["still"], "01-hook-s1.png")
        self.assertIsNone(plan["shots"][1]["still"])
        self.assertEqual(plan["shots"][0]["seconds"], 3.2, "the engine's cut length travels to the server untouched")
        self.assertEqual(plan["shots"][0]["motion"], "push_in")
        self.assertEqual(sorted(made), ["01-hook-s1", "02-city-s1"])
        for sid, path in made.items():
            self.assertEqual(path, os.path.join(out, sid + ".mp4"))
            with open(path, "rb") as f:
                self.assertEqual(f.read(8)[4:], b"ftyp")
        self.assertEqual(srv.polls, 2, "it kept polling until the clips were ready")
        self.assertEqual(srv.clips_served, ["01-hook-s1", "02-city-s1"])

    def test_a_failed_shot_is_absent_and_the_wait_ends_without_it(self):
        srv = FakeServer(ready=["01-hook-s1"], failed={"02-city-s1": "content policy"})
        self.serve(srv)
        made = kw.remote_clips(self.units("01-hook-s1", "02-city-s1"), "realistic", "16:9", os.path.join(self.tmp, "c"), wait_min=1, poll_s=0)
        self.assertEqual(list(made), ["01-hook-s1"])
        self.assertEqual(srv.polls, 1, "nothing left pending: no second poll")

    def test_a_download_that_is_not_a_video_is_thrown_away(self):
        srv = FakeServer(ready=["03-end-junk"])
        self.serve(srv)
        made = kw.remote_clips(self.units("03-end-junk"), "realistic", "16:9", os.path.join(self.tmp, "c"), wait_min=1, poll_s=0)
        self.assertEqual(made, {})
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "c", "03-end-junk.mp4")), "the junk does not stay on disk")

    def test_the_wait_has_an_end(self):
        srv = FakeServer(ready=[], polls_before_ready=10 ** 6)
        self.serve(srv)
        made = kw.remote_clips(self.units("01-hook-s1"), "realistic", "16:9", os.path.join(self.tmp, "c"), wait_min=0.0005, poll_s=0)
        self.assertEqual(made, {})
        self.assertGreaterEqual(srv.polls, 1)

    def test_a_server_refusal_orders_nothing_and_films_nothing(self):
        srv = FakeServer(refuse=402)
        self.serve(srv)
        made = kw.remote_clips(self.units("01-hook-s1"), "realistic", "16:9", os.path.join(self.tmp, "c"), wait_min=1, poll_s=0)
        self.assertEqual(made, {})
        self.assertEqual(srv.polls, 0, "a refused plan is not polled")

    # ---- the seam with generate_footage ---------------------------------------------------------------------

    def test_generate_footage_takes_the_kie_road_and_never_asks_the_local_model_for_a_gpu(self):
        """On the kie road the box may be a 16 GB pictures card with no video model: can_generate must not be the
        gate, and generate_clips must never be called. Everything after the dict is the local road's own code."""
        calls = []

        class NoGpuVideo:
            def can_generate(self):
                calls.append("can_generate")
                return False

            def generate_clips(self, *a, **k):
                calls.append("generate_clips")
                return {}

            def build_footage(self, shots_json, clips, out_path, width, height, fps=60, log_fn=None):
                calls.append(("build_footage", sorted(clips), width, height, fps))
                os.makedirs(os.path.dirname(out_path), exist_ok=True)
                with open(out_path, "wb") as f:
                    f.write(b"\0" * 32)
                return out_path

        srv = FakeServer(ready=["01-hook-s1"])
        self.serve(srv)
        saved = {k: getattr(kw, k) for k in ("local_video_module", "engine_step", "shot_plan")}
        self.addCleanup(lambda: [setattr(kw, k, v) for k, v in saved.items()])
        kw.local_video_module = lambda: NoGpuVideo()
        kw.engine_step = lambda *a, **k: None
        kw.shot_plan = lambda build: ({"width": 2160, "height": 3840, "fps": 60}, {"01-hook-s1": 3.0})
        pdir = os.path.join(self.tmp, "p")
        os.makedirs(pdir)
        with open(os.path.join(pdir, "project.json"), "w") as f:
            json.dump({"id": "p", "scenes": []}, f)
        shot = {"image_prompt": "x", "motion": "push_in"}
        units = [{"id": "01-hook-s1", "image_prompt": "a figure running", "motion": "push_in", "strength": 0.7, "shot": shot}]
        ok = kw.generate_footage({"look": "realistic", "format": "9:16"}, pdir, HERE, os.path.join(self.tmp, "log.txt"), units)
        self.assertTrue(ok)
        self.assertNotIn("generate_clips", calls)
        self.assertNotIn("can_generate", calls)
        self.assertEqual(calls[-1], ("build_footage", ["01-hook-s1"], 2160, 3840, 60))
        self.assertEqual(shot["clip"], "clips/01-hook-s1.mp4", "the clip hangs on the shot where contract.py allows it")

    def test_a_whole_clip_travels_as_a_whole_number_and_a_fraction_as_before(self):
        """A shot the fit cut to a whole clip (fit_to_clips) is sent as that whole number: the server films exactly it."""
        srv = FakeServer(ready=["01-hook-s1", "02-city-s1"])
        self.serve(srv)
        kw.remote_clips(self.units("01-hook-s1", "02-city-s1"), "realistic", "9:16", os.path.join(self.tmp, "c"),
                        seconds_of={"01-hook-s1": 5, "02-city-s1": 4.3333}, wait_min=1, poll_s=0)
        sent = {s["id"]: s["seconds"] for s in srv.plans[0]["shots"]}
        self.assertEqual(sent, {"01-hook-s1": 5, "02-city-s1": 4.333})
        self.assertIs(type(sent["01-hook-s1"]), int)

    def test_on_the_local_road_nothing_here_is_touched(self):
        kw.FOOTAGE_BACKEND = "local"
        srv = FakeServer()
        self.serve(srv)
        self.assertEqual(kw.footage_backend(), "local")
        self.assertEqual(srv.plans, [])


def timeline_like_prepare(voices, fmt="9:16", holds=None, fps=60):
    """The timeline prepare.py writes for picture-style scenes of these voice lengths (lead 0.06 on the first scene,
    0.22 after; the planner's hold 0.2, 0.4 on the closing; every end on a frame), one shot per scene."""
    import math
    scenes, cursor = [], 0.0
    for i, v in enumerate(voices):
        last = i == len(voices) - 1
        lead = 0.06 if i == 0 else 0.22
        hold = max((holds or {}).get(i, 0.4 if last else 0.2), kw.hold_floor(fmt, last))
        end = math.ceil((cursor + lead + v + hold) * fps) / fps
        scenes.append({"id": f"0{i + 1}-s", "start": cursor, "end": end, "audio_start": cursor + lead, "audio_end": cursor + lead + v})
        cursor = end
    return {"duration": cursor, "fps": fps, "scenes": scenes}


def plan_of(timeline, cuts=None):
    """The engine's shot plan for that timeline: one shot per scene unless `cuts` gives a scene's inner cut times."""
    scenes = []
    for s in timeline["scenes"]:
        starts = [0.0] + list((cuts or {}).get(s["id"], []))
        ends = starts[1:] + [s["end"] - s["start"]]
        scenes.append({"id": s["id"], "start": s["start"], "end": s["end"],
                       "shots": [{"index": j, "start": s["start"] + a, "end": s["start"] + b} for j, (a, b) in enumerate(zip(starts, ends))]})
    return {"duration": timeline["duration"], "fps": 60, "width": 2160, "height": 3840, "dissolve_s": 0.8, "scenes": scenes}


def project_of(timeline, fmt="9:16", shots=None):
    return {"id": "p", "format": fmt, "max_duration": 24, "scenes": [
        {"id": s["id"], "voice": "a line", "hold": 0.2, "shots": [{} for _ in range((shots or {}).get(s["id"], 1))]}
        for s in timeline["scenes"]]}


class ClipFitTest(unittest.TestCase):
    """The API road buys clips by the whole second (25 September 2026): every scene is cut to whole clips and the voice
    is fitted to it, so the seconds billed are the seconds on screen. Pure arithmetic first, then the seam."""
    SEEDANCE = list(range(4, 31))
    MINIMAX = list(range(4, 16))

    def setUp(self):
        self.saved = {k: getattr(kw, k) for k in ("CLIP_LENGTHS", "FOOTAGE_BACKEND", "engine_step", "shot_plan", "progress")}
        self.addCleanup(lambda: [setattr(kw, k, v) for k, v in self.saved.items()])
        kw.progress = lambda *a, **k: None
        self.tmp = tempfile.mkdtemp(prefix="kleo-fit-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    # ---- what the server says the model films ---------------------------------------------------------------

    def test_the_job_spec_says_which_whole_lengths_the_model_films(self):
        self.assertEqual(kw.clip_lengths_of({"backend": "kie", "clip_min_s": 4, "clip_max_s": 15}), self.MINIMAX)
        self.assertEqual(kw.clip_lengths_of({"clip_min_s": 4, "clip_max_s": 8, "clip_seconds": [8, 4, 6]}), [4, 6, 8],
                         "a model that films a few lengths only is held to them")
        for bad in (None, {}, {"backend": "kie"}, {"clip_min_s": 4}, {"clip_min_s": 9, "clip_max_s": 4},
                    {"clip_min_s": 4.5, "clip_max_s": 8}, {"clip_min_s": True, "clip_max_s": 8}):
            self.assertIsNone(kw.clip_lengths_of(bad), bad)

    def test_the_lengths_are_read_even_when_the_env_chose_the_road(self):
        kw.FOOTAGE_BACKEND = "kie"
        self.assertEqual(kw.set_footage_backend({"footage": {"backend": "kie", "model": "seedance-2.5-480p", "clip_min_s": 4, "clip_max_s": 30}}), "kie")
        self.assertEqual(kw.CLIP_LENGTHS, self.SEEDANCE)
        kw.set_footage_backend({"footage": {"backend": "kie"}})
        self.assertIsNone(kw.CLIP_LENGTHS, "an older server: no lengths, no fit")

    # ---- one scene ------------------------------------------------------------------------------------------

    def test_a_line_a_little_short_for_its_clip_fills_it_with_a_pause_instead_of_throwing_it_away(self):
        """A 2.9 s line on Seedance is a 4 s clip either way; 0.8 s more pause and all 4 s are seen."""
        self.assertEqual(kw.fit_scene(0.06, 2.9, 3.2, [], 0.15, self.SEEDANCE), {"length": 4, "tempo": 1.0, "shots": [4]})

    def test_a_line_far_shorter_than_its_clip_is_never_padded_with_dead_air(self):
        """The pirates film (gt_ujavdzva): a 2.27 s line in a 2.53 s scene would have 1.5 s of silence added to fill a
        4 s clip, the pauses the owner rejected on 22 September. The scene keeps the old cut, and says why."""
        why = []
        self.assertIsNone(kw.fit_scene(0.06, 2.27, 2.5333, [], 0.15, self.SEEDANCE, why=why))
        self.assertTrue(why and why[0].startswith("FIT_PAD 1.47 s"), why)
        self.assertEqual(kw.fit_scene(0.06, 2.27, 2.5333, [], 0.15, self.SEEDANCE, max_pad=1.5)["length"], 4)
        # A closing line of 1.8 s, and two shots over a 3 s line (two 4 s clips at the least): dead air both, refused.
        self.assertIsNone(kw.fit_scene(0.22, 1.8, 2.42, [], 0.4, self.SEEDANCE))
        self.assertIsNone(kw.fit_scene(0.22, 3.0, 3.5, [1.8], 0.15, self.SEEDANCE))

    def test_a_line_a_little_long_for_its_clip_is_said_faster(self):
        fit = kw.fit_scene(0.22, 5.6, 6.2333, [], 0.4, self.SEEDANCE)
        self.assertEqual((fit["length"], fit["shots"]), (6, [6]))
        self.assertAlmostEqual(fit["tempo"], 1.0409, places=4)
        self.assertLessEqual(0.22 + 5.6 / fit["tempo"] + 0.4, 6 + 1e-9, "said this fast, the line ends inside its room")

    def test_a_line_that_would_need_more_than_the_tempo_cap_gets_one_more_second_instead(self):
        # 4.49 s rounds to 4, but 4.07 s of voice in 3.63 s of room is x1.121: over 1.12, so the clip is 5 s.
        self.assertEqual(kw.fit_scene(0.22, 4.07, 4.49, [], 0.15, self.MINIMAX), {"length": 5, "tempo": 1.0, "shots": [5]})
        self.assertEqual(kw.fit_scene(0.22, 4.07, 4.49, [], 0.15, self.MINIMAX, max_tempo=1.2)["length"], 4)

    def test_a_list_model_is_cut_to_a_length_it_actually_films(self):
        self.assertEqual(kw.fit_scene(0.22, 5.0, 5.42, [], 0.15, [4, 6, 8]), {"length": 6, "tempo": 1.0, "shots": [6]})
        self.assertIsNone(kw.fit_scene(0.22, 4.4, 4.82, [], 0.15, [4, 6, 8]),
                          "4 s is too short for the line even said x1.12 faster, 6 s is 1.2 s of added silence")

    def test_the_cut_between_two_clips_lands_on_the_whole_second_nearest_its_word(self):
        fit = kw.fit_scene(0.22, 8.6, 9.02, [5.3], 0.15, self.SEEDANCE)
        self.assertEqual(fit, {"length": 9, "tempo": 1.0, "shots": [5, 4]}, "the word at 5.3 s: the cut at 5, not at 4")
        self.assertEqual(kw.fit_scene(0.22, 7.2, 7.62, [3.1], 0.15, self.SEEDANCE)["shots"], [4, 4],
                         "two shots are two clips of at least 4 s, the cut moved from 3.1 to 4")

    def test_a_scene_that_dissolves_out_is_fitted_with_its_last_clip_under_the_dissolve(self):
        """The last clip of a scene the next one dissolves into stays on screen 0.8 s past the scene's end
        (build_footage): the scene is 0.8 s shorter than its clips, and that clip is laid whole at its own speed."""
        fit = kw.fit_scene(0.06, 3.9, 4.1667, [], 0.15, self.SEEDANCE, overlap=0.8)
        self.assertEqual(fit, {"length": 4.2, "tempo": 1.0, "shots": [5], "overlap": 0.8})
        self.assertAlmostEqual(fit["shots"][-1] - fit["overlap"], 4.2, places=6, msg="the slot the engine cuts")
        self.assertEqual(kw.fit_scene(0.06, 3.9, 4.1667, [], 0.15, self.SEEDANCE)["length"], 4, "a hard cut: no overlap")

    def test_a_line_too_long_for_its_clips_is_left_to_the_old_cut(self):
        self.assertIsNone(kw.fit_scene(0.22, 20.0, 20.5, [], 0.15, self.MINIMAX))
        self.assertIsNone(kw.fit_scene(0.22, 3.0, 3.5, [], 0.15, []))

    def test_split_whole(self):
        self.assertEqual(kw.split_whole(12, self.SEEDANCE, [4.2, 7.9]), [4, 4, 4])
        self.assertEqual(kw.split_whole(13, self.SEEDANCE, [6.4]), [6, 7])
        self.assertIsNone(kw.split_whole(7, [4, 6, 8], [3.0]), "no two clips of 4, 6 or 8 make 7")

    # ---- the whole film: the two worked examples of 25 September ---------------------------------------------

    def fit_film(self, voices, lengths):
        timeline = timeline_like_prepare(voices)
        plan = plan_of(timeline)
        project = project_of(timeline)
        fits = kw.plan_fit(project, timeline, plan, lengths)
        _, seconds = kw.shot_plan(self.write_plan(plan))
        return timeline, project, fits, seconds

    def write_plan(self, plan):
        with open(os.path.join(self.tmp, "shots.json"), "w") as f:
            json.dump(plan, f)
        return self.tmp

    def test_pirates_five_short_lines_on_seedance(self):
        """Voices 2.27/2.01/3.02/2.92/2.98 s, one shot each: 20 s of clips bought for a 15.4 s film before. The three
        lines of about 3 s fill their 4 s clips with under a second more pause; the two of about 2 s would need 1.5 s
        of silence each and keep the old cut (FIT_PAD): 20 s bought for a 17 s film, and no dead air."""
        timeline = timeline_like_prepare([2.27, 2.01, 3.02, 2.92, 2.98])
        notes = []
        fits = kw.plan_fit(project_of(timeline), timeline, plan_of(timeline), self.SEEDANCE, notes=notes)
        _, seconds = kw.shot_plan(self.write_plan(plan_of(timeline)))
        self.assertAlmostEqual(timeline["duration"], 15.37, delta=0.02)
        self.assertEqual(kw.billed_seconds(seconds.values(), self.SEEDANCE), 20)
        self.assertEqual(sorted(fits), ["03-s", "04-s", "05-s"])
        self.assertEqual([f["length"] for f in fits.values()], [4, 4, 4])
        self.assertTrue(all(f["tempo"] == 1.0 for f in fits.values()), "every line fits: a longer pause, never a faster voice")
        self.assertEqual([n.split(":")[0] for n in notes], ["01-s", "02-s"])
        self.assertTrue(all("FIT_PAD" in n for n in notes), notes)

    def test_a_fifteen_second_film_planned_with_the_clip_floor(self):
        """Voices 4.4/5.1/5.6 s: 18 s of clips bought for a 16.4 s film before, 17 s for a 17 s film now."""
        timeline, project, fits, seconds = self.fit_film([4.4, 5.1, 5.6], self.SEEDANCE)
        self.assertAlmostEqual(timeline["duration"], 16.4333, places=3)
        self.assertEqual(kw.billed_seconds(seconds.values(), self.SEEDANCE), 18)
        self.assertEqual([f["length"] for f in fits.values()], [5, 6, 6])
        self.assertEqual([f["tempo"] for f in fits.values()][:2], [1.0, 1.0])
        self.assertAlmostEqual(fits["03-s"]["tempo"], 1.0409, places=4)

    def test_the_fit_tempo_rides_on_kokoros_own_speed_and_never_passes_its_ceiling(self):
        """The closing line of 5.6 s needs x1.041 to fit 6 s. At the voice's usual speed 1.1 that is 1.145 in all;
        at 1.25 it would be 1.30, over the contract's 1.3 ceiling, so the scene takes one more second instead."""
        timeline = timeline_like_prepare([4.4, 5.6])
        plan = plan_of(timeline)
        project = project_of(timeline)
        project["speed"] = 1.1
        fit = kw.plan_fit(project, timeline, plan, self.SEEDANCE)["02-s"]
        self.assertEqual(fit["length"], 6)
        self.assertAlmostEqual(fit["tempo"], 1.0409, places=4)
        project["speed"] = 1.25
        self.assertEqual(kw.plan_fit(project, timeline, plan, self.SEEDANCE)["02-s"], {"length": 7, "tempo": 1.0, "shots": [7]})
        project["speed"] = 1.3
        self.assertTrue(all(f["tempo"] == 1.0 for f in kw.plan_fit(project, timeline, plan, self.SEEDANCE).values()),
                        "at the contract's top speed a line is never said faster still")

    def test_the_plan_reads_the_dissolve_from_the_engines_shot_plan(self):
        timeline = timeline_like_prepare([3.9, 5.1])
        plan = plan_of(timeline)
        plan["scenes"][1]["transition"] = "dissolve"
        fits = kw.plan_fit(project_of(timeline), timeline, plan, self.SEEDANCE)
        self.assertEqual(fits["01-s"], {"length": 4.2, "tempo": 1.0, "shots": [5], "overlap": 0.8})
        self.assertNotIn("overlap", fits["02-s"], "the last scene dissolves into nothing")

    def test_apply_fit_writes_what_prepare_and_picture_read_and_the_contract_accepts(self):
        timeline = timeline_like_prepare([4.4, 8.6])
        plan = plan_of(timeline, cuts={"02-s": [5.3]})
        project = project_of(timeline, shots={"02-s": 2})
        project["scenes"][0]["fit"] = {"length": 99}          # a stale fit is cleared, never kept
        fits = kw.plan_fit(project, timeline, plan, self.SEEDANCE)
        kw.apply_fit(project, fits)
        self.assertEqual(project["scenes"][0]["fit"], {"length": 5})
        self.assertEqual(project["scenes"][1]["fit"]["length"], fits["02-s"]["length"])
        self.assertNotIn("cut", project["scenes"][1]["shots"][0], "the first shot opens the scene")
        self.assertEqual(project["scenes"][1]["shots"][1]["cut"], fits["02-s"]["shots"][0])
        self.assertIsInstance(project["scenes"][1]["shots"][1]["cut"], int)

    def test_a_scene_with_a_shot_not_bought_is_not_fitted(self):
        timeline = timeline_like_prepare([4.4, 5.1])
        fits = kw.plan_fit(project_of(timeline), timeline, plan_of(timeline), self.SEEDANCE, unit_ids={"01-s-s1"})
        self.assertEqual(list(fits), ["01-s"])

    # ---- the seam: the second pass, and what is ordered ----------------------------------------------------

    def fit_seam(self, second_plan_seconds, dissolve_into=()):
        """fit_to_clips over a first pass of voices 4.4/5.1/5.6 s, with the engine stubbed: the second shot plan
        comes out with `second_plan_seconds` per shot. `dissolve_into`: the scene ids the plan dissolves into."""
        pdir = os.path.join(self.tmp, "p")
        os.makedirs(os.path.join(pdir, "build"))
        timeline = timeline_like_prepare([4.4, 5.1, 5.6])
        with open(os.path.join(pdir, "build", "timeline.json"), "w") as f:
            json.dump(timeline, f)
        project = project_of(timeline)
        plan = plan_of(timeline)
        for s in plan["scenes"]:
            if s["id"] in dissolve_into:
                s["transition"] = "dissolve"
        _, seconds = kw.shot_plan(self.write_plan(plan))
        steps = []
        kw.CLIP_LENGTHS = self.SEEDANCE
        kw.engine_step = lambda cmd, engine, log_path, what, timeout: steps.append(what)
        second = {"duration": sum(second_plan_seconds), "width": 2160, "height": 3840, "fps": 60}
        kw.shot_plan = lambda build: (second, {f"0{i + 1}-s-s1": v for i, v in enumerate(second_plan_seconds)})
        units = [{"id": f"0{i + 1}-s-s1"} for i in range(3)]
        new_plan, new_seconds = kw.fit_to_clips(project, pdir, self.tmp, os.path.join(self.tmp, "log.txt"), units, plan, seconds)
        with open(os.path.join(pdir, "project.json")) as f:
            written = json.load(f)
        return steps, new_plan, new_seconds, written

    def test_the_fit_voices_again_from_the_cache_times_again_and_orders_whole_clips(self):
        steps, plan, seconds, written = self.fit_seam([5.0, 6.0, 6.0])
        self.assertEqual(steps, ["the voice fit pass", "the shot timing pass"])
        self.assertEqual(seconds, {"01-s-s1": 5, "02-s-s1": 6, "03-s-s1": 6})
        self.assertTrue(all(type(v) is int for v in seconds.values()), "whole seconds travel as whole numbers")
        self.assertEqual([s.get("fit", {}).get("length") for s in written["scenes"]], [5, 6, 6], "project.json carries the fit")

    def test_the_clip_under_a_dissolve_is_ordered_whole_though_its_slot_is_shorter(self):
        # 01-s dissolves into 02-s: a 5 s clip, 4.2 s of slot and 0.8 s under the dissolve (the line said x1.103).
        _, _, seconds, written = self.fit_seam([4.2, 6.0, 6.0], dissolve_into={"02-s"})
        self.assertEqual(seconds, {"01-s-s1": 5, "02-s-s1": 6, "03-s-s1": 6})
        self.assertEqual(written["scenes"][0]["fit"]["length"], 4.2)
        self.assertEqual(set(written["scenes"][0]["fit"]), {"length", "tempo"}, "the contract's two fields, nothing else")

    def test_a_scene_that_came_out_another_length_is_cut_as_before(self):
        _, _, seconds, _ = self.fit_seam([5.0, 6.0, 6.4])
        self.assertEqual(seconds["03-s-s1"], 6.4, "not a whole clip: the old rule, the clip is cut to its shot")
        self.assertEqual(seconds["01-s-s1"], 5)

    def test_without_lengths_nothing_is_voiced_again(self):
        kw.CLIP_LENGTHS = None
        steps = []
        kw.engine_step = lambda *a, **k: steps.append(a)
        plan, seconds = {"scenes": []}, {"01-s-s1": 4.6}
        self.assertEqual(kw.fit_to_clips({"scenes": []}, self.tmp, self.tmp, "log", [], plan, seconds), (plan, seconds))
        self.assertEqual(steps, [])

    def test_a_fit_that_would_pass_the_films_ceiling_is_not_applied(self):
        pdir = os.path.join(self.tmp, "q")
        os.makedirs(os.path.join(pdir, "build"))
        timeline = timeline_like_prepare([2.27, 2.01, 3.02, 2.92, 2.98])
        with open(os.path.join(pdir, "build", "timeline.json"), "w") as f:
            json.dump(timeline, f)
        project = project_of(timeline)
        project["max_duration"] = 16
        kw.CLIP_LENGTHS = self.SEEDANCE
        steps = []
        kw.engine_step = lambda *a, **k: steps.append(a)
        plan = plan_of(timeline)
        got = kw.fit_to_clips(project, pdir, self.tmp, "log", [{"id": f"0{i + 1}-s-s1"} for i in range(5)], plan, {"x": 1.0})
        self.assertEqual(got, (plan, {"x": 1.0}))
        self.assertEqual(steps, [], "17 s of fitted film would pass the 16 s ceiling prepare.py enforces")

    def test_the_box_is_never_told_to_keep_a_storyboards_own_fit(self):
        project = {"style": "picture", "scenes": [{"id": "a", "fit": {"length": 60}, "shots": [{"at": "x"}, {"cut": 1, "at": "y"}]}]}
        kw.strip_kleo_fields(project)
        self.assertNotIn("fit", project["scenes"][0])
        self.assertNotIn("cut", project["scenes"][0]["shots"][1])
        self.assertEqual(project["scenes"][0]["shots"][1]["at"], "y")


class MusicRoadTest(unittest.TestCase):
    """The user's track (22 September 2026): ordered from the server, polled, downloaded with the job secret, shaped
    over build/music.wav (looped, faded, levelled) — and every refusal leaves the film without it, never without a film."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kleo-music-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.saved = {k: getattr(kw, k) for k in ("api", "progress", "SECRET", "API", "JOB", "MUSIC_POLL_S")}
        self.saved_urlopen = kw.urllib.request.urlopen
        kw.progress = lambda *a, **k: None
        kw.SECRET, kw.API, kw.JOB, kw.MUSIC_POLL_S = "wsecret", "http://kleo.test", "gt_test1234", 0
        self.addCleanup(lambda: [setattr(kw, k, v) for k, v in self.saved.items()])
        self.addCleanup(lambda: setattr(kw.urllib.request, "urlopen", self.saved_urlopen))
        self.build = os.path.join(self.tmp, "build"); os.makedirs(self.build)
        with open(os.path.join(self.build, "timeline.json"), "w") as f:
            json.dump({"duration": 3.0, "scenes": []}, f)
        # A two-second "track": a real wav made by ffmpeg, so shape_music has something real to loop and fade.
        self.track = os.path.join(self.tmp, "track.wav")
        import subprocess
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000", "-t", "2", "-ac", "2", self.track], check=True)

    def serve(self, server):
        kw.api = server.api
        kw.urllib.request.urlopen = server.urlopen

    def test_wants_music_reads_the_storyboard_word(self):
        self.assertTrue(kw.wants_music({"music": "track"}))
        self.assertFalse(kw.wants_music({"music": "none"})); self.assertFalse(kw.wants_music({})); self.assertFalse(kw.wants_music(None))

    def test_the_track_is_ordered_with_the_brief_polled_downloaded_and_shaped_to_the_film(self):
        srv = FakeServer(); srv.music_state = "ready"
        with open(self.track, "rb") as f: srv.music_bytes = f.read()
        self.serve(srv)
        ok = kw.fetch_music({"music": "track", "music_brief": "sparse felt piano", "title": "The Empty Page"}, self.build)
        self.assertTrue(ok)
        self.assertEqual(srv.music_orders, [{"brief": "sparse felt piano", "seconds": 3.0, "title": "The Empty Page"}])
        wav = os.path.join(self.build, "music.wav")
        self.assertTrue(os.path.isfile(wav))
        import subprocess
        dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav], capture_output=True, text=True).stdout.strip())
        self.assertAlmostEqual(dur, 3.0, delta=0.1, msg="a two-second track loops to the film's three seconds and stops there")

    def test_a_brief_the_storyboard_did_not_write_becomes_the_plain_bed_sentence(self):
        srv = FakeServer(); srv.music_state = "ready"
        with open(self.track, "rb") as f: srv.music_bytes = f.read()
        self.serve(srv)
        self.assertTrue(kw.fetch_music({"music": "track"}, self.build))
        self.assertIn("quiet instrumental bed", srv.music_orders[0]["brief"])

    def test_a_refusal_a_failure_and_a_timeout_leave_the_film_without_music_and_without_an_error(self):
        srv = FakeServer(); srv.music_refuse = 409
        self.serve(srv)
        self.assertFalse(kw.fetch_music({"music": "track", "music_brief": "x"}, self.build))
        self.assertFalse(os.path.exists(os.path.join(self.build, "music.wav")))
        srv = FakeServer(); srv.music_state = "failed"
        self.serve(srv)
        self.assertFalse(kw.fetch_music({"music": "track", "music_brief": "x"}, self.build))
        srv = FakeServer(); srv.music_state = "generating"
        self.serve(srv)
        saved = kw.MUSIC_WAIT_MIN; kw.MUSIC_WAIT_MIN = 0.0005
        try:
            self.assertFalse(kw.fetch_music({"music": "track", "music_brief": "x"}, self.build))
        finally:
            kw.MUSIC_WAIT_MIN = saved
        self.assertGreaterEqual(srv.music_polls, 1)

    def test_a_download_that_is_not_audio_is_thrown_away(self):
        srv = FakeServer(); srv.music_state = "ready"; srv.music_bytes = b"not audio at all"
        self.serve(srv)
        self.assertFalse(kw.fetch_music({"music": "track", "music_brief": "x"}, self.build))
        self.assertFalse(os.path.exists(os.path.join(self.build, "music.wav")))


class VoiceFitTest(unittest.TestCase):
    """The other half of the fit (25 September 2026): prepare.py fits the line to the scene the worker cut to whole
    clips. Pure helpers, loaded from worker/keou/prepare.py; numpy and ffmpeg only for the tempo itself."""

    def test_no_fit_changes_nothing(self):
        self.assertEqual(pp.scene_fit({"voice": "x"}), (None, 1.0))
        timing = {"captions": [{"text": "a", "start": 0.1, "end": 1.0}], "words": [{"text": "a", "start": 0.1}]}
        self.assertIs(pp.stretch_timing(timing, 1.0), timing)

    def test_a_faster_line_moves_every_caption_and_word_with_it(self):
        self.assertEqual(pp.scene_fit({"fit": {"length": 6, "tempo": 1.05}}), (6.0, 1.05))
        timing = {"captions": [{"text": "one two", "start": 0.12, "end": 1.05}, {"text": "three", "start": 1.05, "end": 2.1}],
                  "words": [{"text": "one", "start": 0.12}, {"text": "three", "start": 1.05}], "match": 1.0}
        out = pp.stretch_timing(timing, 1.05)
        self.assertAlmostEqual(out["captions"][1]["end"], 2.0)
        self.assertAlmostEqual(out["words"][1]["start"], 1.0)
        self.assertEqual(out["match"], 1.0)
        self.assertAlmostEqual(timing["captions"][1]["end"], 2.1, msg="the cached timing is never edited in place")

    def test_a_fitted_scene_ends_exactly_on_its_whole_second(self):
        self.assertEqual(pp.fitted_end(10.0, 0.22, 4.4, 5, 60), 15.0)
        self.assertEqual(pp.fitted_end(0.0, 0.06, 3.85, 4, 60), 4.0)
        self.assertIsNone(pp.fitted_end(0.0, 0.22, 3.9, 4, 60), "a line that does not fit keeps prepare's own end")

    def test_the_voice_is_said_faster_at_the_same_rate(self):
        import numpy as np
        sr = 24000
        t = np.arange(int(2.1 * sr)) / sr
        audio = (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
        out = pp.stretch_voice(audio, sr, 1.05)
        self.assertEqual(out.dtype, np.float32)
        self.assertAlmostEqual(len(out) / sr, 2.0, delta=0.03)
        self.assertTrue(np.isfinite(out).all())


if __name__ == "__main__":
    unittest.main()
