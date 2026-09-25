#!/usr/bin/env python3
"""
Unit tests for the generated-motion wiring in kleo_worker.py: no GPU, no engine, no network. kleo_video is replaced
by a fake and the two engine steps (the voice pass, the shot-timing pass) are stubbed out, because what is under
test here is not whether a clip is beautiful. It is whether the worker can be trusted with a card that costs money.

THE RULE THIS FILE EXISTS TO DEFEND: a project that keeps its video backdrop must satisfy the engine's own
contract. contract.py refuses a video backdrop when any shot is missing its clip, and it is validated at the very
top of run.py — after the GPU has been rented, after the model has been fetched, after every clip has been paid
for. A worker that attaches the backdrop and forgets one clip does not produce a poor video, it produces no video
at all and still bills the user. That exact shape of error has already cost this project a paid card once.

So both endings are checked against the real validator: the film that was shot, and the film that fell back to the
stills when the shooting failed.

Run: python3 -m unittest worker.test_kleo_worker_video       (from the repo root)
"""
import copy, importlib.util, json, os, shutil, subprocess, tempfile, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(HERE, "keou")


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


kw = load_module("kleo_worker_under_video_test", os.path.join(HERE, "kleo_worker.py"))
contract = load_module("keou_contract_under_video_test", os.path.join(ENGINE, "contract.py"))

SCENES = [
    ("01-hook", "A lone figure runs down a rain-soaked alley at night.",
     [("a figure in a heavy coat running through neon rain", "crash_zoom_in"),
      ("water spraying up from every step", "track_alongside")]),
    ("02-city", "The city never stops moving underneath her.",
     [("a vast rain-lashed city from above, traffic flowing in rivers of light", "crane_down")]),
    ("03-closing", "Nobody ever found out where she was going.",
     [("an empty floodlit pier, the sea heaving black behind it", "pull_out")]),
]


def storyboard(backdrop="video", style="realistic"):
    scenes = []
    for i, (sid, voice, shots) in enumerate(SCENES):
        scenes.append({"id": sid, "kind": "closing" if i == len(SCENES) - 1 else "cinema",
                       "chapter": f"0{i + 1} PART", "accent": "amber", "title": f"part {i + 1}",
                       "voice": voice, "hold": 0.2,
                       "shots": [{"image_prompt": p, "motion": m, "strength": 0.8} for p, m in shots]})
    sb = {"schema_version": 1, "title": "Night run", "style": "picture", "kleo_style": style,
          "format": "16:9", "language": "en", "voice": "am_michael", "scenes": scenes}
    if backdrop:
        sb["backdrop"] = backdrop
    return sb


def job_for(sb):
    return {"job_id": "j1", "storyboard": sb, "params": {"format": "16:9"}, "brand": "Kleo", "prompt": "night run"}


def shots_json_for(project, width=3840, height=2160, fps=60):
    """What render.mjs --shots would have written for this project: one entry per shot, cut times end to end."""
    scenes, t = [], 0.0
    for s in project["scenes"]:
        shots, per = s.get("shots") or [{}], 3.0
        entry = {"id": s["id"], "start": t, "end": t + per * len(shots), "shots": []}
        for i in range(len(shots)):
            entry["shots"].append({"index": i, "start": t, "end": t + per, "clip": None, "image": None})
            t += per
        scenes.append(entry)
    return {"duration": t, "fps": fps, "width": width, "height": height, "scenes": scenes}


class FakeVideo:
    """kleo_video, without a GPU. Records what it was asked for; films whatever it is told to film."""

    def __init__(self, gpu=True, skip=(), track=True):
        self.gpu, self.skip, self.track = gpu, set(skip), track
        self.asked, self.footage_args, self.out_dir = None, None, None

    def can_generate(self):
        return self.gpu

    def generate_clips(self, shots, look, fmt, out_dir, seconds_of=None):
        self.asked = {"shots": copy.deepcopy(shots), "look": look, "fmt": fmt, "seconds_of": dict(seconds_of or {})}
        self.out_dir = out_dir
        os.makedirs(out_dir, exist_ok=True)
        made = {}
        for s in shots:
            if s["id"] in self.skip:
                continue
            path = os.path.join(out_dir, s["id"] + ".mp4")
            with open(path, "wb") as f:
                f.write(b"\0" * 32)
            made[s["id"]] = path
        return made

    def build_footage(self, shots_json, clips, out_path, width, height, fps=60, log_fn=None):
        self.footage_args = {"width": width, "height": height, "fps": fps, "clips": sorted(clips)}
        if not self.track:
            return None
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "wb") as f:
            f.write(b"\0" * 32)
        return out_path


class VideoWiringTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kleo-video-wiring-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.steps = []
        self.fake = FakeVideo()
        # No server, no pictures, no engine: only the decisions the worker makes on its own are under test.
        self.saved = {k: getattr(kw, k) for k in ("progress", "engine_step", "local_video_module", "wants_pictures")}
        kw.progress = lambda *a, **k: None
        kw.wants_pictures = lambda sb: False
        kw.local_video_module = lambda: self.fake
        kw.engine_step = self.step
        self.addCleanup(lambda: [setattr(kw, k, v) for k, v in self.saved.items()])

    def step(self, cmd, engine, log_path, what, timeout_min):
        """Stands in for the voice pass and the shot-timing pass; the timing pass leaves shots.json behind.

        IT ALSO VALIDATES THE PROJECT, because the real prepare.py does, and that one line is the whole reason a
        day of green tests missed a fault a rented GPU found in fifty seconds. A stub that only records being
        called tests the caller and nothing else: the voice pass reads project.json through contract.validate()
        BEFORE any clip can exist, and a project that declares a video backdrop at that moment is refused."""
        self.steps.append(what)
        pj = [str(c) for c in cmd if str(c).endswith("project.json")]
        if pj:
            contract.validate(pj[0])
        if "--shots" in [str(c) for c in cmd]:
            pj = [str(c) for c in cmd if str(c).endswith("project.json")][0]
            with open(pj) as f:
                project = json.load(f)
            build = os.path.join(os.path.dirname(pj), "build")
            os.makedirs(build, exist_ok=True)
            with open(os.path.join(build, "shots.json"), "w") as f:
                json.dump(shots_json_for(project), f)

    def prepared(self, sb=None):
        project, pdir, units = kw.prepare_project(job_for(sb or storyboard()), ENGINE, self.tmp)
        return project, pdir, units

    def film(self, sb=None):
        project, pdir, units = self.prepared(sb)
        ok = kw.generate_footage(project, pdir, ENGINE, os.path.join(self.tmp, "log.txt"), units)
        return project, pdir, units, ok

    # ---- the gate ------------------------------------------------------------------------------------------

    def test_only_a_picture_project_that_asked_for_it_is_filmed(self):
        self.assertTrue(kw.wants_footage({"backdrop": "video", "style": "picture"}))
        self.assertFalse(kw.wants_footage({"style": "picture"}), "silence is not a request")
        self.assertFalse(kw.wants_footage({"backdrop": "video", "style": "sketch"}),
                         "the explainer must not be able to fall into the video path by accident")
        self.assertFalse(kw.wants_footage({"backdrop": "photo", "style": "picture"}))
        self.assertFalse(kw.wants_footage(None))

    def test_a_project_that_never_asked_runs_the_old_way_and_costs_nothing(self):
        project, pdir, units = self.prepared(storyboard(backdrop=None))
        self.assertEqual(units, [], "nothing is filmed for a project with no video backdrop")
        self.assertNotIn("backdrop", project)
        self.assertIsNone(self.fake.asked, "the model must not even be loaded")

    # ---- what gets filmed ----------------------------------------------------------------------------------

    def test_the_prompts_are_read_before_the_strip_takes_them_away(self):
        project, pdir, units = self.prepared()
        self.assertEqual([u["id"] for u in units],
                         ["01-hook-s1", "01-hook-s2", "02-city-s1", "03-closing-s1"])
        self.assertTrue(all(u["image_prompt"].strip() for u in units))
        self.assertEqual(units[0]["motion"], "crash_zoom_in")
        for s in project["scenes"]:
            for sh in s["shots"]:
                self.assertNotIn("image_prompt", sh, "the engine never sees a prompt")

    def test_the_camera_the_server_resolved_reaches_the_model(self):
        _, _, _, ok = self.film()
        self.assertTrue(ok)
        asked = {s["id"]: s for s in self.fake.asked["shots"]}
        self.assertEqual(asked["01-hook-s1"]["motion"], "crash_zoom_in")
        self.assertEqual(asked["02-city-s1"]["motion"], "crane_down")
        self.assertEqual(asked["01-hook-s1"]["strength"], 0.8)
        self.assertEqual(self.fake.asked["look"], "realistic", "the look is the one the engine will draw for")
        self.assertEqual(self.fake.asked["fmt"], "16:9")

    def test_every_clip_is_filmed_to_the_length_the_engine_chose(self):
        """The one number the worker is not allowed to invent: a clip shorter than its shot is a gap in the film."""
        _, _, _, ok = self.film()
        self.assertTrue(ok)
        self.assertEqual(sorted(self.fake.asked["seconds_of"]),
                         ["01-hook-s1", "01-hook-s2", "02-city-s1", "03-closing-s1"])
        self.assertTrue(all(v == 3.0 for v in self.fake.asked["seconds_of"].values()))

    def test_the_frame_comes_from_the_engine_and_is_never_recomputed(self):
        """The footage lies under the graphics: a frame worked out twice is a frame that can disagree once."""
        _, _, _, ok = self.film()
        self.assertTrue(ok)
        self.assertEqual((self.fake.footage_args["width"], self.fake.footage_args["height"]), (3840, 2160))
        self.assertEqual(self.fake.footage_args["fps"], 60)

    def test_the_voice_runs_before_the_timing_and_the_timing_before_the_camera(self):
        _, _, _, ok = self.film()
        self.assertTrue(ok)
        self.assertEqual(self.steps, ["the voice pass", "the shot timing pass"])

    def test_the_clips_land_where_the_contract_allows_them_and_nowhere_else(self):
        project, pdir, units, ok = self.film()
        self.assertTrue(ok)
        self.assertEqual(os.path.abspath(self.fake.out_dir), os.path.abspath(os.path.join(pdir, "clips")))
        for s in project["scenes"]:
            for sh in s["shots"]:
                self.assertTrue(sh["clip"].startswith("clips/"), sh["clip"])
                self.assertTrue(os.path.isfile(os.path.join(pdir, sh["clip"])))

    # ---- the fallback, which is the whole point ------------------------------------------------------------

    def test_one_shot_that_would_not_film_takes_the_whole_backdrop_off(self):
        """A hole in the track is a black hole in the delivered film. contract.py refuses it; so does the worker,
        before spending the render on it."""
        self.fake = FakeVideo(skip=["02-city-s1"])
        kw.local_video_module = lambda: self.fake
        project, pdir, units, ok = self.film()
        self.assertFalse(ok, "three clips out of four is not a film")
        self.assertIsNone(self.fake.footage_args, "the track is not even attempted")

    def test_a_track_that_would_not_assemble_also_takes_the_backdrop_off(self):
        self.fake = FakeVideo(track=False)
        kw.local_video_module = lambda: self.fake
        _, _, _, ok = self.film()
        self.assertFalse(ok)

    def test_without_a_gpu_nothing_is_filmed_and_no_engine_step_is_paid_for(self):
        self.fake = FakeVideo(gpu=False)
        kw.local_video_module = lambda: self.fake
        _, _, _, ok = self.film()
        self.assertFalse(ok)
        self.assertEqual(self.steps, [], "a machine that cannot film must not voice the script twice")

    def test_without_the_module_nothing_is_filmed(self):
        kw.local_video_module = lambda: None
        _, _, _, ok = self.film()
        self.assertFalse(ok)
        self.assertEqual(self.steps, [])


class RenderKeouTest(unittest.TestCase):
    """The decision that keeps a black film off the internet does not live in generate_footage — it lives in
    render_keou, in the three lines that run when filming failed. Those lines had no test: every test above proved
    generate_footage says no, and none proved anyone listens to it.

    If they are ever removed, nothing here fails except this: the project keeps backdrop "video", contract.py
    refuses it for the missing clips, and the job dies after the card, the model and every clip have been paid for.
    If contract.py were relaxed instead, it would be worse — the engine would draw the graphics onto a transparent
    canvas with nothing behind them and deliver a film that is black from end to end."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kleo-render-keou-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.ran = []
        self.saved = {k: getattr(kw, k) for k in ("progress", "wants_pictures", "generate_footage", "run_keou", "KEOU_DIR")}
        kw.progress = lambda *a, **k: None
        kw.wants_pictures = lambda sb: False
        kw.KEOU_DIR = ENGINE
        kw.run_keou = lambda *a, **k: self.ran.append(k)
        self.addCleanup(lambda: [setattr(kw, k, v) for k, v in self.saved.items()])

    def render(self, filmed):
        """render_keou up to the point where it looks for a master the stubbed engine never wrote."""
        def footage(project, pdir, engine, log_path, units):
            for u in units:                      # whatever happened, some clips were attached before it gave up
                u["shot"]["clip"] = f"clips/{u['id']}.mp4"
            return filmed
        kw.generate_footage = footage
        out = os.path.join(self.tmp, "out")
        os.makedirs(out, exist_ok=True)
        with self.assertRaises(kw.RenderError):
            kw.render_keou(job_for(storyboard()), out)
        pdir = os.path.join(ENGINE, "projects", kw.project_id_for("j1"))
        self.addCleanup(shutil.rmtree, pdir, True)
        with open(os.path.join(pdir, "project.json")) as f:
            return json.load(f)

    def test_when_the_filming_failed_the_backdrop_and_every_clip_come_off(self):
        project = self.render(filmed=False)
        self.assertNotIn("backdrop", project, "a backdrop with no track is a promise the render cannot keep")
        for s in project["scenes"]:
            for sh in s.get("shots") or []:
                self.assertNotIn("clip", sh, "a half-attached clip is what contract.py refuses")

    def test_when_the_filming_worked_both_survive_into_the_render(self):
        project = self.render(filmed=True)
        self.assertEqual(project.get("backdrop"), "video")
        self.assertTrue(all(sh.get("clip") for s in project["scenes"] for sh in (s.get("shots") or [])))

    def test_the_script_is_not_voiced_twice(self):
        """The voice pass is the slowest thing before the render. Once the worker has run it to find the shot
        times, run.py must be told, or every filmed video pays for its narration twice."""
        self.render(filmed=True)
        self.assertEqual(len(self.ran), 1)
        self.assertIn("skip_voice", self.ran[0])


class ShotPlanTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kleo-shotplan-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def write(self, data):
        with open(os.path.join(self.tmp, "shots.json"), "w") as f:
            json.dump(data, f)
        return self.tmp

    def test_the_ids_are_the_ones_the_pictures_use(self):
        """Same key on both sides or the clip lands under the wrong shot: <sceneId>-s<n>, n counting from one."""
        plan, seconds = kw.shot_plan(self.write(shots_json_for(
            {"scenes": [{"id": "01-hook", "shots": [{}, {}]}, {"id": "02-city", "shots": [{}]}]})))
        self.assertEqual(sorted(seconds), ["01-hook-s1", "01-hook-s2", "02-city-s1"])
        self.assertEqual(plan["width"], 3840)

    def test_a_missing_plan_is_not_a_crash(self):
        plan, seconds = kw.shot_plan(self.tmp)
        self.assertIsNone(plan)
        self.assertEqual(seconds, {})

    def test_a_shot_with_no_length_is_dropped_rather_than_filmed_at_zero(self):
        _, seconds = kw.shot_plan(self.write({"width": 1920, "height": 1080, "fps": 60, "scenes": [
            {"id": "01-hook", "shots": [{"index": 0, "start": 0, "end": 2}, {"index": 1, "start": 2, "end": 2}]}]}))
        self.assertEqual(sorted(seconds), ["01-hook-s1"])


class ProgressTest(unittest.TestCase):
    """What the person waiting is told, which is the only number they ever see.

    Every render worker draws its own block of the film and prints ABSOLUTE frame numbers. So the highest number
    ever printed belongs to the LAST worker — the one whose block ends at the end of the film — and it reaches
    that end while everybody else is still in the middle. Reading the highest as progress puts the bar at the top
    of its band, and the ETA at nearly zero, for minutes of real work.

    Measured on the first 4K render, 2046 frames over six workers: the bar said 2040/2046 while the slowest worker
    was at 300 of its 341. It stayed there for over a minute saying "almost done"."""

    def setUp(self):
        self.saved = kw.progress
        self.seen = []
        kw.progress = lambda track, pc, eta_min=None, message=None: self.seen.append((track, pc, message, eta_min))
        self.addCleanup(lambda: setattr(kw, "progress", self.saved))

    def test_the_bar_counts_every_worker_and_not_just_the_luckiest(self):
        p = kw.EngineProgress(5, 6)
        p.render_started = time.time() - 60
        # Exactly the six lines the first 4K render printed, in the order it printed them.
        for line in ["FRAME 5 2040 / 2046", "FRAME 0 300 / 2046", "FRAME 1 630 / 2046",
                     "FRAME 2 990 / 2046", "FRAME 3 1320 / 2046", "FRAME 4 1680 / 2046"]:
            p.line(line)
        track, pc, message, eta = self.seen[-1]
        self.assertEqual(track, "clips")
        self.assertIn("1851/2046", message,
                      "the six blocks together hold 1851 finished frames; 2040 is one worker's position")
        self.assertLess(pc, 57, "the old reading put this at the top of the band")
        self.assertGreater(eta or 0, 0, "an ETA of zero with 195 frames left is a lie to whoever is waiting")

    def test_one_worker_finishing_does_not_finish_the_film(self):
        p = kw.EngineProgress(5, 4)
        p.line("FRAME 3 999 / 1000")          # the last worker reaches the last frame of the film
        _, pc, message, _ = self.seen[-1]
        # Its block is [750, 1000), so 250 frames of 1000 are done. The band runs 22..58, so a quarter of the
        # work reads as 31: near the FLOOR of the band, where it belongs, and not at the top where the old
        # reading put it the moment any single worker touched the last frame.
        self.assertIn("250/1000", message)
        self.assertLess(pc, 35, f"one worker of four is not a finished film: {message}")


class ContractTest(unittest.TestCase):
    """Both endings go through the engine's real validator — the one that runs after the card has been paid for."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kleo-video-contract-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.saved = {k: getattr(kw, k) for k in ("progress", "wants_pictures")}
        kw.progress = lambda *a, **k: None
        kw.wants_pictures = lambda sb: False
        self.addCleanup(lambda: [setattr(kw, k, v) for k, v in self.saved.items()])

    def build(self):
        project, pdir, units = kw.prepare_project(job_for(storyboard()), ENGINE, self.tmp)
        return project, pdir, units

    def test_a_filmed_project_is_accepted_by_the_engine(self):
        project, pdir, units = self.build()
        os.makedirs(os.path.join(pdir, "clips"), exist_ok=True)
        for u in units:
            with open(os.path.join(pdir, "clips", u["id"] + ".mp4"), "wb") as f:
                f.write(b"\0" * 32)
            u["shot"]["clip"] = f"clips/{u['id']}.mp4"
        kw.write_project(project, pdir)
        contract.validate(os.path.join(pdir, "project.json"))

    def test_the_film_that_fell_back_to_the_stills_is_accepted_too(self):
        project, pdir, units = self.build()
        project.pop("backdrop", None)
        for u in units:
            u["shot"].pop("clip", None)
        kw.write_project(project, pdir)
        contract.validate(os.path.join(pdir, "project.json"))

    def test_the_voice_pass_reads_a_project_it_can_accept_before_a_single_clip_exists(self):
        """THE ONE THAT WAS MISSING, and it cost a rented card to find.

        The order is forced: the clips are cut to times the engine computes from the timeline, and the timeline is
        made by the voice pass — so the voice pass necessarily runs while there are no clips. It validates
        project.json on the way in. contract.py refuses a video backdrop whose shots have no clip. Therefore the
        file on disk may NOT declare the backdrop until the clips are real: the storyboard asks, and the answer is
        written down only once it is true.

        Every other test here checked the project at the START and at the END. Nothing checked it in the MIDDLE,
        which is the only moment the voice pass ever sees."""
        project, pdir, units = self.build()
        self.assertTrue(units, "this storyboard did ask to be filmed")
        with open(os.path.join(pdir, "project.json")) as f:
            written = json.load(f)
        self.assertNotIn("backdrop", written,
                         "a request to be filmed is not a fact until the clips exist, and the file holds facts")
        contract.validate(os.path.join(pdir, "project.json"))

    def test_the_engine_refuses_the_backdrop_when_a_clip_is_missing(self):
        """The reason the worker gives up the whole backdrop for one missing clip: this is what would happen
        otherwise, and it happens after the GPU, the model and every other clip have already been paid for."""
        project, pdir, units = self.build()
        os.makedirs(os.path.join(pdir, "clips"), exist_ok=True)
        for u in units[:-1]:
            with open(os.path.join(pdir, "clips", u["id"] + ".mp4"), "wb") as f:
                f.write(b"\0" * 32)
            u["shot"]["clip"] = f"clips/{u['id']}.mp4"
        # Declared by hand: the worker never writes this state, and this test exists to show why it must not.
        project["backdrop"] = "video"
        kw.write_project(project, pdir)
        with self.assertRaises(ValueError) as e:
            contract.validate(os.path.join(pdir, "project.json"))
        self.assertIn("clip", str(e.exception))


class RenderFilmTest(unittest.TestCase):
    """render_film: filmed shots under the narration, nothing drawn. The footage pass is stubbed, but the FILE it
    leaves behind is real (a tiny clip written by kleo_video.write_clip) and so is the voice (a sine), because the
    narration mix, the length check and the thumbnail are the part under test."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kleo-render-film-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.saved = {k: getattr(kw, k) for k in ("progress", "wants_pictures", "generate_footage", "KEOU_DIR", "local_pictures_available")}
        kw.progress = lambda *a, **k: None
        kw.wants_pictures = lambda sb: False
        kw.local_pictures_available = lambda: False
        kw.KEOU_DIR = os.path.join(self.tmp, "engine")
        os.makedirs(kw.KEOU_DIR); open(os.path.join(kw.KEOU_DIR, "run.py"), "w").write("")
        self.addCleanup(lambda: [setattr(kw, k, v) for k, v in self.saved.items()])
        self.kv = load_module("kleo_video_under_film_test", os.path.join(HERE, "kleo_video.py"))

    def footage_that(self, seconds, filmed=True):
        kv = self.kv
        def footage(project, pdir, engine, log_path, units, lay_track=True):
            import numpy as np
            build = os.path.join(pdir, "build"); os.makedirs(build, exist_ok=True)
            n = int(seconds * 24)
            frames = np.zeros((n, 36, 64, 3), np.float32)
            for i in range(n):
                frames[i, :, (i * 3) % 64, :] = 1.0; frames[i, :, :, 1] = 0.3     # something moves, nothing is black
            kv.write_clip(frames, os.path.join(build, "footage.mp4"), fps=24)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
                            "-ar", "24000", os.path.join(build, "voice.wav")], check=True)
            json.dump({"duration": seconds, "fps": 24, "scenes": [
                {"id": "01-hook", "start": 0, "end": seconds, "captions": [{"text": "A lone figure runs.", "start": 0.2, "end": seconds - 0.2}]}]},
                open(os.path.join(build, "timeline.json"), "w"))
            return filmed
        return footage

    def test_a_filmed_storyboard_becomes_a_film_with_the_narration_and_no_engine_render(self):
        kw.generate_footage = self.footage_that(3.0)
        out = os.path.join(self.tmp, "out"); os.makedirs(out)
        files = kw.render_film(job_for(storyboard()), out)
        self.assertEqual(sorted(files), ["subtitles.srt", "thumbnail.jpg", "video.mp4"], "the film, its thumbnail and the .srt sidecar (22 September: always delivered; burned in only when the user said yes)")
        probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", files["video.mp4"]],
                               capture_output=True, text=True, check=True).stdout
        info = json.loads(probe)
        self.assertEqual(sorted(st["codec_type"] for st in info["streams"]), ["audio", "video"], "the narration must be on the film")
        self.assertAlmostEqual(float(info["format"]["duration"]), 3.0, delta=0.25)
        self.assertGreater(os.path.getsize(files["thumbnail.jpg"]), 0)

    def test_render_routes_a_filmed_storyboard_to_the_film_and_a_plain_one_to_the_engine(self):
        self.assertTrue(kw.wants_film(job_for(storyboard(backdrop="video"))))
        self.assertFalse(kw.wants_film(job_for(storyboard(backdrop=None))))
        self.assertTrue(kw.wants_film({"storyboard": json.dumps(storyboard(backdrop="video"))}), "a storyboard may arrive as a string")

    def test_a_film_that_did_not_film_is_refused_not_drawn_from_the_stills(self):
        kw.generate_footage = self.footage_that(3.0, filmed=False)
        out = os.path.join(self.tmp, "out"); os.makedirs(out)
        with self.assertRaises(kw.RenderError) as cm:
            kw.render_film(job_for(storyboard()), out)
        self.assertFalse(cm.exception.retry, "a second card would film the same: no retry")
        self.assertFalse(os.path.exists(os.path.join(out, "video.mp4")))


class TwoPhaseTest(unittest.TestCase):
    """The GPU phase ends in a bundle; the finish phase starts from it. What crosses is the plan, the timings, the
    voice and the raw clips — and the finish box must be able to lay the track and mix the film from nothing else."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kleo-phase-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.saved = {k: getattr(kw, k) for k in ("progress", "KEOU_DIR", "JOB")}
        kw.progress = lambda *a, **k: None
        kw.KEOU_DIR = os.path.join(self.tmp, "engine"); os.makedirs(os.path.join(kw.KEOU_DIR, "projects"))
        kw.JOB = "gt_phase"
        self.addCleanup(lambda: [setattr(kw, k, v) for k, v in self.saved.items()])
        self.kv = load_module("kleo_video_under_phase_test", os.path.join(HERE, "kleo_video.py"))

    def gen_project(self, seconds=3.0):
        """What the GPU phase leaves in its project dir: a plan, a timeline, a voice and one raw 24 fps clip."""
        import numpy as np
        pdir = os.path.join(self.tmp, "gen-project"); build = os.path.join(pdir, "build"); clips = os.path.join(pdir, "clips")
        os.makedirs(build); os.makedirs(clips)
        n = int(seconds * 24); frames = np.zeros((n, 36, 64, 3), np.float32)
        for i in range(n):
            frames[i, :, (i * 3) % 64, :] = 1.0; frames[i, :, :, 1] = 0.3
        self.kv.write_clip(frames, os.path.join(clips, "01-hook-s1.mp4"), fps=24)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-ar", "24000", os.path.join(build, "voice.wav")], check=True)
        json.dump({"duration": seconds, "fps": 24, "width": 128, "height": 72,
                   "scenes": [{"id": "01-hook", "start": 0, "end": seconds, "shots": [{"index": 0, "start": 0, "end": seconds, "clip": None, "image": None}]}]},
                  open(os.path.join(build, "shots.json"), "w"))
        json.dump({"duration": seconds, "fps": 24, "scenes": [{"id": "01-hook", "start": 0, "end": seconds, "captions": []}]}, open(os.path.join(build, "timeline.json"), "w"))
        json.dump({"id": "gt-phase", "scenes": []}, open(os.path.join(pdir, "project.json"), "w"))
        return pdir

    def test_the_bundle_carries_the_plan_the_voice_and_the_clips_and_the_finish_box_makes_the_film_from_it(self):
        pdir = self.gen_project()
        out1 = os.path.join(self.tmp, "out-gen"); os.makedirs(out1)
        bundle = kw.pack_gen(pdir, out1)
        names = subprocess.run(["tar", "tzf", bundle], capture_output=True, text=True, check=True).stdout.split()
        for need in ("build/timeline.json", "build/shots.json", "build/voice.wav", "clips/01-hook-s1.mp4", "project.json"):
            self.assertIn(need, names)
        # the finish box: a fresh engine dir, the bundle, nothing else
        pdir2 = kw.unpack_gen(bundle, kw.KEOU_DIR)
        self.assertTrue(os.path.isfile(os.path.join(pdir2, "clips", "01-hook-s1.mp4")))
        self.assertFalse(os.path.exists(os.path.join(pdir2, "build", "footage.mp4")), "the track is the finish box's job")
        out2 = os.path.join(self.tmp, "out-finish"); os.makedirs(out2)
        files = kw.film_finish(pdir2, out2, lay_track=True)
        self.assertEqual(sorted(files), ["subtitles.srt", "thumbnail.jpg", "video.mp4"])
        probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", files["video.mp4"]],
                                          capture_output=True, text=True, check=True).stdout)
        self.assertEqual(sorted(st["codec_type"] for st in probe["streams"]), ["audio", "video"])
        self.assertAlmostEqual(float(probe["format"]["duration"]), 3.0, delta=0.25)

    def test_a_bundle_without_clips_is_refused_before_a_single_frame_is_touched(self):
        pdir = self.gen_project()
        shutil.rmtree(os.path.join(pdir, "clips"))
        with self.assertRaises(kw.RenderError):
            kw.pack_gen(pdir, os.path.join(self.tmp, "o"))


class StillOfTest(unittest.TestCase):
    """The still handed to the video model is the shot's own picture, as an absolute path, and only when it exists."""

    def test_the_shot_picture_reaches_the_model_as_a_path_that_exists(self):
        import tempfile, shutil
        pdir = tempfile.mkdtemp(prefix="kleo-still-"); self.addCleanup(shutil.rmtree, pdir, True)
        os.makedirs(os.path.join(pdir, "img"))
        with open(os.path.join(pdir, "img", "01-hook-s1.png"), "wb") as f:
            f.write(b"\x89PNG")
        self.assertEqual(kw.still_of({"image": "img/01-hook-s1.png"}, pdir), os.path.join(pdir, "img", "01-hook-s1.png"))
        self.assertIsNone(kw.still_of({"image": "img/missing.png"}, pdir), "a picture that was never drawn is not a frame")
        self.assertIsNone(kw.still_of({}, pdir))
        self.assertIsNone(kw.still_of("not a shot", pdir))


if __name__ == "__main__":
    unittest.main(verbosity=2)


class LayerPicturesTravelTest(unittest.TestCase):
    """The finish box runs the engine over the film only when there is a layer, and the engine refuses a shot whose
    picture is not on disk: so the pictures ride in the bundle for such a film, and any still missing gets a blank
    stand-in before the engine looks (video gt_rvhmhx55, 15 September 2026)."""

    def setUp(self):
        import tempfile, shutil
        self.tmp = tempfile.mkdtemp(prefix="kleo-layer-"); self.addCleanup(shutil.rmtree, self.tmp, True)

    def project(self, graphics):
        pdir = os.path.join(self.tmp, "p"); os.makedirs(os.path.join(pdir, "build")); os.makedirs(os.path.join(pdir, "clips")); os.makedirs(os.path.join(pdir, "img"))
        for name in ("build/timeline.json", "build/shots.json"):
            json.dump({}, open(os.path.join(pdir, name), "w"))
        open(os.path.join(pdir, "build", "voice.wav"), "wb").write(b"RIFF")
        open(os.path.join(pdir, "clips", "01-a-s1.mp4"), "wb").write(b"\x00")
        open(os.path.join(pdir, "img", "01-a-s1.png"), "wb").write(kw.BLANK_PNG)
        proj = {"id": "gt-layer", "scenes": [{"id": "01-a", "image": "img/01-a-s1.png", "shots": [{"image": "img/01-a-s1.png"}, {"image": "img/01-a-s2.png"}]}]}
        if graphics:
            proj["graphics"] = {"accent": "#ffffff", "subtitles": "cinema", "chapters": "none", "hud": []}
        json.dump(proj, open(os.path.join(pdir, "project.json"), "w"))
        return pdir

    def members(self, pdir):
        out = os.path.join(self.tmp, "out"); os.makedirs(out, exist_ok=True)
        return subprocess.run(["tar", "tzf", kw.pack_gen(pdir, out)], capture_output=True, text=True, check=True).stdout.split()

    def test_a_film_with_a_layer_carries_its_pictures_in_the_bundle(self):
        names = self.members(self.project(graphics=True))
        self.assertIn("img/01-a-s1.png", names)
        self.assertIn("clips/01-a-s1.mp4", names)

    def test_a_film_without_a_layer_leaves_the_pictures_behind(self):
        names = self.members(self.project(graphics=False))
        self.assertNotIn("img/01-a-s1.png", names)
        self.assertFalse(any(n.startswith("img/") for n in names))

    def test_a_picture_the_bundle_lost_becomes_a_blank_stand_in_before_the_engine_looks(self):
        pdir = self.project(graphics=True)
        project = json.load(open(os.path.join(pdir, "project.json")))
        missing = kw.ensure_shot_pictures(pdir, project)
        self.assertEqual(missing, ["img/01-a-s2.png"])
        stand_in = os.path.join(pdir, "img", "01-a-s2.png")
        self.assertTrue(os.path.isfile(stand_in))
        self.assertEqual(open(stand_in, "rb").read()[:8], b"\x89PNG\r\n\x1a\n")
        # the picture that was there is untouched, and a second pass has nothing left to do
        self.assertEqual(open(os.path.join(pdir, "img", "01-a-s1.png"), "rb").read(), kw.BLANK_PNG)
        self.assertEqual(kw.ensure_shot_pictures(pdir, project), [])


class LayerClipsBoundTest(unittest.TestCase):
    """With a video backdrop the contract wants a clip on every shot; the bundle's project.json never had them."""

    def setUp(self):
        import tempfile, shutil
        self.tmp = tempfile.mkdtemp(prefix="kleo-clips-"); self.addCleanup(shutil.rmtree, self.tmp, True)
        self.pdir = os.path.join(self.tmp, "p"); os.makedirs(os.path.join(self.pdir, "clips"))
        self.project = {"id": "gt-x", "scenes": [{"id": "01-a", "shots": [{"image": "img/01-a-s1.png"}, {"image": "img/01-a-s2.png"}]},
                                                  {"id": "02-closing", "shots": [{"image": "img/02-closing-s1.png"}]}]}

    def clip(self, name):
        open(os.path.join(self.pdir, "clips", name), "wb").write(b"\x00")

    def test_every_shot_is_bound_to_the_clip_the_gpu_box_named_after_it(self):
        for n in ("01-a-s1.mp4", "01-a-s2.mp4", "02-closing-s1.mp4"):
            self.clip(n)
        self.assertEqual(kw.bind_shot_clips(self.pdir, self.project), 3)
        self.assertEqual(self.project["scenes"][0]["shots"][1]["clip"], "clips/01-a-s2.mp4")
        self.assertEqual(self.project["scenes"][1]["shots"][0]["clip"], "clips/02-closing-s1.mp4")

    def test_a_missing_clip_is_refused_in_one_sentence_not_by_the_contract(self):
        self.clip("01-a-s1.mp4"); self.clip("02-closing-s1.mp4")
        with self.assertRaises(kw.RenderError) as cm:
            kw.bind_shot_clips(self.pdir, self.project)
        self.assertIn("01-a-s2", str(cm.exception))

class AiUpscaleReportTest(unittest.TestCase):
    """25 September 2026: the AI upscale is an option the user pays for, and the server gives its credits back unless
    every shot went through the GPU. The finish box says what happened in its /done call — nothing else carries it."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kleo-sr-report-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        os.makedirs(os.path.join(self.tmp, "build"))
        self.saved = {k: getattr(kw, k) for k in ("local_video_module", "progress", "api", "watchdog", "set_footage_backend",
                                                  "download", "unpack_gen", "film_finish", "upload", "upload_log",
                                                  "self_destruct", "API", "JOB", "SECRET", "SR_REPORT")}
        self.addCleanup(lambda: [setattr(kw, k, v) for k, v in self.saved.items()])
        kw.progress = lambda *a, **k: None

    def fake_video(self, report):
        class Mod:
            LAST_SR = report

            def build_footage(self, shots_json, clips, out_path, width, height, fps=60, log_fn=None):
                open(out_path, "wb").write(b"\0" * 32)
                return out_path
        return Mod()

    def test_lay_footage_keeps_what_the_neural_finish_did(self):
        rep = {"parts": 3, "applied": 2, "model": "realesr-general-x4v3", "gpu": "RTX 3060", "reason": "s1 shot 3: boom"}
        kw.local_video_module = lambda: self.fake_video(rep)
        self.assertTrue(kw.lay_footage(self.tmp, {}, 64, 36, 60))
        self.assertEqual(kw.SR_REPORT, rep)
        kw.local_video_module = lambda: self.fake_video(None)   # an older kleo_video: nothing to report
        self.assertTrue(kw.lay_footage(self.tmp, {}, 64, 36, 60))
        self.assertIsNone(kw.SR_REPORT)

    def test_the_finish_box_sends_the_report_with_done(self):
        rep = {"parts": 4, "applied": 4, "model": "realesr-animevideov3", "gpu": "RTX 3060", "reason": None}
        calls = []
        kw.API, kw.JOB, kw.SECRET = "http://kleo.test", "gt_sr", "wk_1"
        kw.watchdog = lambda: None
        kw.api = lambda method, path, data=None, **k: calls.append((method, path, data)) or {"job_id": "gt_sr", "params": {}}
        kw.set_footage_backend = lambda job: "kie"
        kw.download = lambda name, path: None
        kw.unpack_gen = lambda bundle, engine: self.tmp
        kw.upload = kw.upload_log = lambda *a, **k: None
        kw.self_destruct = lambda reason: None

        def finish(pdir, out_dir, lay_track=False):
            kw.SR_REPORT = rep
            return {}
        kw.film_finish = finish
        os.environ["KLEO_PHASE"] = "finish"; self.addCleanup(os.environ.pop, "KLEO_PHASE", None)
        kw.main()
        done = [d for m, p, d in calls if p.endswith("/done")]
        self.assertEqual(len(done), 1, calls)
        self.assertEqual(done[0]["sr"], rep)


# The caption repair of prepare.py (22 September 2026) rides in this module: tests.yml lists its modules by name and
# the OAuth token that pushes from the owner's PC has no `workflow` scope to add one.
from test_keou_prepare import CaptionRepairTest  # noqa: E402,F401

