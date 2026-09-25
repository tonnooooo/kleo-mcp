#!/usr/bin/env python3
"""
Unit tests for worker/kleo_video.py — the generated-motion module.

Nothing here loads torch, touches a GPU or renders anything: the pipeline is replaced by a fake through
sys.modules, exactly as test_kleo_pictures.py does for the picture model. What is under test is the part that
decides WHAT to ask the model for, because that is where the quality was measured to live: a shot whose
description contains nothing alive comes back as a frozen frame, and a camera instruction without its negations
comes back as a digital zoom.

Run: python3 -m unittest worker.test_kleo_video      (from the repo root)
"""
import importlib.util, math, os, sys, types, unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


kv = load("kleo_video", os.path.join(HERE, "kleo_video.py"))


class PromptTest(unittest.TestCase):
    def test_the_subject_comes_first_and_the_camera_last(self):
        p = kv.build_prompt({"id": "01", "image_prompt": "a fisherman mending a net", "motion": "push_in"}, "realistic")
        self.assertTrue(p.startswith("a fisherman mending a net"), p[:60])
        self.assertIn("the camera pushes slowly forward", p)
        self.assertLess(p.index("a fisherman"), p.index("the camera"))

    def test_every_move_forbids_the_zoom_it_would_be_mistaken_for(self):
        # The measured failure of a naive prompt is a digital zoom standing in for a physical move.
        for move, text in kv.MOVES.items():
            if move == "static_hold":
                self.assertIn("does not move", text)
                continue
            self.assertIn("NOT", text, move)
            self.assertRegex(text.lower(), r"not a (zoom|digital zoom|cut|tilt|pan|roll|push in|zoom out)", move)

    def test_a_scene_with_nothing_alive_is_given_something(self):
        dead = {"id": "03-compass", "image_prompt": "a brass compass on a wooden table", "motion": "push_in"}
        p = kv.build_prompt(dead, "realistic")
        self.assertTrue(any(a in p for a in kv.ALIVE), "a still life must be given a moving element")

    def test_a_scene_that_already_moves_is_left_alone(self):
        for prompt in ["huge waves breaking over the deck", "a woman walking away along the shore",
                       "smoke drifting across an empty street", "rain falling on a car roof",
                       "a crowd crossing a station hall"]:
            p = kv.build_prompt({"id": "x", "image_prompt": prompt, "motion": "track_left"}, "realistic")
            self.assertFalse(any(a in p for a in kv.ALIVE), f"nothing should be added to: {prompt}")

    def test_the_look_decides_the_medium(self):
        real = kv.build_prompt({"id": "1", "image_prompt": "a street", "motion": "push_in"}, "realistic")
        toon = kv.build_prompt({"id": "1", "image_prompt": "a street", "motion": "push_in"}, "cartoon")
        self.assertIn("live-action", real)
        self.assertIn("animation", toon)
        self.assertNotEqual(real, toon)

    def test_an_empty_description_asks_for_nothing(self):
        self.assertIsNone(kv.build_prompt({"id": "1", "image_prompt": "   "}, "realistic"))
        self.assertIsNone(kv.build_prompt({"id": "1"}, "realistic"))

    def test_an_unknown_move_holds_the_camera_still_rather_than_inventing_one(self):
        p = kv.build_prompt({"id": "1", "image_prompt": "a street", "motion": "teleport"}, "realistic")
        self.assertIn("locked-off frame", p)

    def test_the_negative_forbids_the_two_failures_that_cost_a_paid_clip(self):
        for word in ["static image", "still frame", "morphing", "extra fingers", "text", "watermark"]:
            self.assertIn(word, kv.NEGATIVE)


class TimingTest(unittest.TestCase):
    def test_frame_counts_are_what_the_model_accepts(self):
        for secs in [0.1, 1, 2, 3, 4, 5, 9, 100]:
            n = kv.frames_for(secs)
            self.assertEqual((n - 1) % 4, 0, f"{secs}s -> {n} frames must be 4n+1")
            self.assertGreaterEqual(n, 17)
            self.assertLessEqual(n / kv.FPS_SRC, kv.MAX_S + 0.05, "a longer clip drifts, so it is capped")

    def test_a_missing_duration_still_produces_a_shot(self):
        self.assertGreater(kv.frames_for(None), 17)

    def test_the_same_shot_always_generates_the_same_clip(self):
        a, b = kv.seed_for("02-ship-s1"), kv.seed_for("02-ship-s1")
        self.assertEqual(a, b)
        self.assertNotEqual(a, kv.seed_for("02-ship-s2"))
        self.assertTrue(0 <= a < 2 ** 31)

    def test_every_line_of_life_is_itself_recognised_as_life(self):
        """The invariant that catches the trap chat 2 fell into: a repair the rule cannot recognise makes the
        repair run again on the next pass, or worse, look like it never happened. Every phrase this module can
        add must satisfy has_motion(), and a repaired prompt must survive a second pass unchanged."""
        for phrase in kv.ALIVE:
            self.assertTrue(kv.has_motion(phrase), f"the rule must recognise its own repair: {phrase!r}")
        dead = {"id": "s1", "image_prompt": "a brass compass on a wooden table", "motion": "push_in"}
        once = kv.build_prompt(dead, "realistic")
        again = kv.build_prompt({**dead, "image_prompt": once.split(". ")[0]}, "realistic")
        self.assertEqual(len([a for a in kv.ALIVE if a in again]), 1, "a second pass must not stack a second life")

    def test_the_life_added_to_a_still_scene_is_also_deterministic(self):
        self.assertEqual(kv.alive("03-storm"), kv.alive("03-storm"))
        self.assertIn(kv.alive("03-storm"), kv.ALIVE)


def frames(n, w=16, h=16):
    """n small frames with a moving stripe, float32 in [0, 1], the way the pipeline returns them."""
    import numpy as np
    out = np.zeros((n, h, w, 3), np.float32)
    for t in range(n):
        out[t, :, (t * 2) % w, :] = 1.0
    return out


def probe_frames(path):
    import json, subprocess
    r = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
                        "-show_entries", "stream=nb_read_frames,width,height,codec_name", "-of", "json", path],
                       capture_output=True, text=True, check=True)
    st = json.loads(r.stdout)["streams"][0]
    return int(st["nb_read_frames"]), int(st["width"]), int(st["height"]), st["codec_name"]


class WriterTest(unittest.TestCase):
    """The clip writer, with the two libraries diffusers' exporter needs made unimportable: the worker image ships
    neither, and on 13 September every generated shot of a film was lost at export."""

    def setUp(self):
        import tempfile, shutil
        self.tmp = tempfile.mkdtemp(prefix="kleo-writer-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.saved = {k: sys.modules.get(k) for k in ("cv2", "imageio", "imageio_ffmpeg", "diffusers.utils")}
        for k in self.saved:
            sys.modules[k] = None          # `import cv2` now raises ImportError, as on the box
        self.addCleanup(lambda: [sys.modules.__setitem__(k, v) if v else sys.modules.pop(k, None)
                                 for k, v in self.saved.items()])

    def test_writes_a_playable_h264_clip_with_every_frame_and_no_opencv_or_imageio(self):
        path = os.path.join(self.tmp, "a.mp4")
        kv.write_clip(frames(13, 20, 18), path, fps=24)
        n, w, h, codec = probe_frames(path)
        self.assertEqual((n, w, h, codec), (13, 20, 18, "h264"))

    def test_odd_sides_are_trimmed_to_even_not_refused(self):
        path = os.path.join(self.tmp, "odd.mp4")
        kv.write_clip(frames(5, 17, 15), path)
        self.assertEqual(probe_frames(path)[1:3], (16, 14))

    def test_uint8_and_pil_frames_are_accepted_too(self):
        import numpy as np
        from PIL import Image
        u8 = (frames(5) * 255).astype(np.uint8)
        kv.write_clip(list(u8), os.path.join(self.tmp, "u8.mp4"))
        kv.write_clip([Image.fromarray(f) for f in u8], os.path.join(self.tmp, "pil.mp4"))
        self.assertEqual(probe_frames(os.path.join(self.tmp, "u8.mp4"))[0], 5)
        self.assertEqual(probe_frames(os.path.join(self.tmp, "pil.mp4"))[0], 5)

    def test_no_frames_is_an_error_not_an_empty_file(self):
        path = os.path.join(self.tmp, "none.mp4")
        with self.assertRaises(RuntimeError):
            kv.write_clip([], path)
        self.assertFalse(os.path.exists(path))

    def test_the_still_gate_says_it_is_off_when_it_cannot_look(self):
        kv.travel_px.warned = False
        said = []
        orig = kv.log; kv.log = lambda *a: said.append(" ".join(str(x) for x in a))
        self.addCleanup(lambda: setattr(kv, "log", orig))
        path = os.path.join(self.tmp, "g.mp4"); kv.write_clip(frames(5), path)
        self.assertIsNone(kv.travel_px(path))
        self.assertTrue(any("travel gate OFF" in m for m in said), said)


def moving_then_frozen(n_moving, n_frozen, w=64, h=36):
    """A clip whose picture moves for n_moving frames and then stops dead — what a model told to 'decelerate
    into a static hold' produces, and what a held tail produces."""
    import numpy as np
    out = np.zeros((n_moving + n_frozen, h, w, 3), np.float32)
    rng = np.random.default_rng(3)
    base = rng.random((h, w, 3)).astype(np.float32)
    for t in range(n_moving):
        out[t] = np.roll(base, t * 2, axis=1)
    out[n_moving:] = out[n_moving - 1]
    return out


class FreezeTest(unittest.TestCase):
    """The delivery QA rejects a master with one second of identical sampled frames — after thirty minutes of GPU.
    The 13 September film died there. These tests pin the ruler that now runs on every part BEFORE the master."""

    def setUp(self):
        import tempfile, shutil
        self.tmp = tempfile.mkdtemp(prefix="kleo-freeze-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def clip(self, name, moving, frozen, fps=24):
        path = os.path.join(self.tmp, name)
        kv.write_clip(moving_then_frozen(moving, frozen), path, fps=fps)
        return path

    def test_the_ruler_sees_a_frozen_tail_and_where_it_starts(self):
        # 2 s moving, 1.5 s frozen at 24 fps. Sampled at 6 fps the frozen run is ~1.5 s at ~2.0 s.
        runs = kv.frozen_runs(self.clip("a.mp4", 48, 36))
        self.assertEqual(len(runs), 1, runs)
        start, secs = runs[0]
        self.assertAlmostEqual(start, 2.0, delta=0.34)
        self.assertGreaterEqual(secs, 1.0)

    def test_a_clip_that_never_stops_has_no_runs(self):
        self.assertEqual(kv.frozen_runs(self.clip("b.mp4", 60, 0)), [])

    def test_the_fill_drops_the_frozen_tail_and_slows_the_rest_instead_of_holding(self):
        # 5.6 s wanted from a 5.0 s clip whose last 0.8 s is frozen: 4.2 s usable, slowed x1.33, nothing held.
        stretch, usable, held = kv.plan_fill(5.6, 5.0, 0.8)
        self.assertAlmostEqual(usable, 4.2, places=6)
        self.assertAlmostEqual(stretch, 5.6 / 4.2, places=4)
        self.assertLess(stretch, kv.MAX_STRETCH)
        self.assertAlmostEqual(held, 0.0, places=6)

    def test_a_shot_longer_than_its_take_is_slowed_to_the_cap_and_a_short_rest_is_held(self):
        stretch, usable, held = kv.plan_fill(8.4, 5.0, 0.0)
        self.assertEqual(stretch, kv.MAX_STRETCH)
        self.assertAlmostEqual(held, 8.4 - 5.0 * kv.MAX_STRETCH, places=6)
        self.assertLessEqual(held, kv.FROZEN_S)

    def test_a_held_frame_the_qa_would_reject_is_slowed_away_instead(self):
        # A whole 4 s clip bought for a 4 s shot (no spare second) whose last 2.2 s do not move: x1.6 would leave
        # 1.12 s held and fail the film at its QA; slowed x1.89 instead, the held frame is FROZEN_S.
        stretch, usable, held = kv.plan_fill(4.0, 4.0, 2.2)
        self.assertAlmostEqual(usable, 1.8, places=6)
        self.assertAlmostEqual(stretch, (4.0 - kv.FROZEN_S) / 1.8, places=6)
        self.assertGreater(stretch, kv.MAX_STRETCH)
        self.assertAlmostEqual(held, kv.FROZEN_S, places=6)

    def test_the_rescue_has_its_own_ceiling_and_the_rest_is_held_and_said(self):
        stretch, usable, held = kv.plan_fill(20.0, 5.0, 0.0)
        self.assertEqual(stretch, kv.RESCUE_STRETCH)
        self.assertAlmostEqual(held, 20.0 - 5.0 * kv.RESCUE_STRETCH, places=6)

    def test_a_clip_long_enough_is_neither_slowed_nor_cut(self):
        self.assertEqual(kv.plan_fill(3.0, 3.0, 0.0), (1.0, 3.0, 0.0))

    def test_the_filter_chain_slows_before_interpolating_and_never_holds_when_nothing_is_missing(self):
        vf = kv.finish_vf(1280, 704, 60, 5.6, stretch=1.12)
        self.assertTrue(vf.startswith("setpts=1.1200*PTS,minterpolate="), vf[:60])
        self.assertIn("tpad=stop_mode=clone:stop_duration=5.600", vf)
        self.assertNotIn("setpts", kv.finish_vf(1280, 704, 60, 3.0))

    def test_build_footage_measures_each_part_with_the_delivery_ruler(self):
        # A real (tiny) track: one shot of 3.0 s from a clip that moves 2 s and freezes 1.2 s. Without the repair
        # the part would carry ~1.2 s of identical frames and the master would be rejected; with it the frozen
        # tail is dropped, the 2 s slowed x1.5, and the finished part has no run of a second.
        import json
        src = self.clip("c.mp4", 48, 29)
        plan = {"width": 128, "height": 72, "fps": 24, "duration": 3.0,
                "scenes": [{"id": "s1", "shots": [{"index": 0, "start": 0.0, "end": 3.0}]}]}
        pj = os.path.join(self.tmp, "shots.json"); json.dump(plan, open(pj, "w"))
        said = []
        out = kv.build_footage(pj, {"s1-s1": src}, os.path.join(self.tmp, "footage.mp4"), 128, 72, fps=24,
                               log_fn=lambda *a: said.append(" ".join(str(x) for x in a)))
        self.assertTrue(out and os.path.isfile(out), said)
        self.assertTrue(any("do not move" in m for m in said), said)
        self.assertTrue(any("slowed x1.50" in m for m in said), said)
        self.assertFalse(any("STILL has" in m for m in said), said)
        worst = max((secs for _, secs in kv.frozen_runs(out)), default=0.0)
        self.assertLess(worst, 1.0, f"the track still freezes for {worst} s")

    def test_build_footage_finishes_parts_in_parallel_and_reports_each_one(self):
        """Seven 2K clips finished one after the other took the finish box past the server's silence limit; now the
        parts run side by side and every finished part is reported, in order, so the stage never looks dead."""
        import json
        src = self.clip("c.mp4", 48, 29)
        plan = {"width": 128, "height": 72, "fps": 24, "duration": 3.0,
                "scenes": [{"id": "s1", "shots": [{"index": 0, "start": 0.0, "end": 1.0}, {"index": 1, "start": 1.0, "end": 2.0}]},
                           {"id": "s2", "shots": [{"index": 0, "start": 2.0, "end": 3.0}]}]}
        pj = os.path.join(self.tmp, "shots.json"); json.dump(plan, open(pj, "w"))
        seen, said = [], []
        out = kv.build_footage(pj, {"s1-s1": src, "s1-s2": src}, os.path.join(self.tmp, "footage.mp4"), 128, 72, fps=24,
                               log_fn=lambda *a: said.append(" ".join(str(x) for x in a)),
                               progress_fn=lambda d, t: seen.append((d, t)), workers=3)
        self.assertTrue(out and os.path.isfile(out), said)
        self.assertEqual(seen, [(1, 3), (2, 3), (3, 3)], "one report per part, in order, out of the total")
        self.assertTrue(any("3 parts, 3 at a time" in m for m in said), said)
        self.assertTrue(any("stays black" in m for m in said), "the shot without a clip is black, not missing")
        self.assertAlmostEqual(kv.seconds_of(out), 3.0, delta=0.15)


class DissolveTest(FreezeTest):
    """The dissolve between two acts (22 September 2026): the plan marks the scene that dissolves in, the part before
    it is cut longer, and xfade folds the two — the track stays exactly as long as the timeline."""

    def plan_of(self, transition):
        import json
        plan = {"width": 128, "height": 72, "fps": 24, "duration": 4.0, "dissolve_s": 0.5,
                "scenes": [{"id": "s1", "transition": "cut", "shots": [{"index": 0, "start": 0.0, "end": 2.0}]},
                           {"id": "s2", "transition": transition, "shots": [{"index": 0, "start": 2.0, "end": 4.0}]}]}
        pj = os.path.join(self.tmp, "shots.json"); json.dump(plan, open(pj, "w"))
        return pj

    def test_a_dissolve_keeps_the_track_length_and_folds_the_two_parts(self):
        src = self.clip("d.mp4", 72, 0)
        said = []
        out = kv.build_footage(self.plan_of("dissolve"), {"s1-s1": src, "s2-s1": src}, os.path.join(self.tmp, "footage.mp4"), 128, 72, fps=24,
                               log_fn=lambda *a: said.append(" ".join(str(x) for x in a)))
        self.assertTrue(out and os.path.isfile(out), said)
        self.assertAlmostEqual(kv.seconds_of(out), 4.0, delta=0.15, msg="the dissolve borrows from the part before, never from the timeline")
        self.assertTrue(any("1 dissolve(s) between acts, 0.5 s each" in m for m in said), said)
        parts = os.path.join(self.tmp, "footage-parts")
        self.assertTrue(any(n.startswith("x") for n in os.listdir(parts)), "the folded part is on disk")
        self.assertAlmostEqual(kv.seconds_of(os.path.join(parts, "000.mp4")), 2.5, delta=0.15, msg="the outgoing part was cut dissolve_s longer")

    def test_a_cut_changes_nothing(self):
        src = self.clip("e.mp4", 72, 0)
        said = []
        out = kv.build_footage(self.plan_of("cut"), {"s1-s1": src, "s2-s1": src}, os.path.join(self.tmp, "footage.mp4"), 128, 72, fps=24,
                               log_fn=lambda *a: said.append(" ".join(str(x) for x in a)))
        self.assertTrue(out and os.path.isfile(out), said)
        self.assertAlmostEqual(kv.seconds_of(out), 4.0, delta=0.15)
        self.assertFalse(any("dissolve" in m for m in said), said)
        self.assertFalse(any(n.startswith("x") for n in os.listdir(os.path.join(self.tmp, "footage-parts"))))

    def test_xfade_of_two_parts_is_their_nominal_length(self):
        a = self.clip("f.mp4", 60, 0)   # 2.5 s: a 2.0 s slot cut 0.5 s long
        b = self.clip("g.mp4", 48, 0)   # 2.0 s
        out = os.path.join(self.tmp, "x.mp4")
        self.assertTrue(kv.xfade_parts(a, b, out, offset=2.0, seconds=0.5, fps=24))
        self.assertAlmostEqual(kv.seconds_of(out), 4.0, delta=0.15)


ksr = load("kleo_sr_under_test", os.path.join(HERE, "kleo_sr.py"))


class SrPlanTest(unittest.TestCase):
    """worker/kleo_sr.py, the pure half: what factor, which frames, how long, and which weights. No torch here."""

    def test_the_factor_follows_the_source_against_the_delivery(self):
        for (w, h, W, H), f in {(480, 864, 2160, 3840): 4, (864, 480, 3840, 2160): 4, (720, 1280, 2160, 3840): 4,
                                (1080, 1920, 2160, 3840): 2, (1440, 2560, 2160, 3840): 1, (2160, 3840, 2160, 3840): 1}.items():
            self.assertEqual(ksr.plan(w, h, W, H), f, f"{w}x{h} -> {W}x{H}")

    def test_the_model_follows_the_look_and_the_factor(self):
        self.assertEqual(ksr.model_for("realistic", 4), "realesr-general-x4v3")
        self.assertEqual(ksr.model_for("animation", 4), "realesr-animevideov3")
        self.assertEqual(ksr.model_for("cartoon", 4), "realesr-animevideov3")
        self.assertEqual(ksr.model_for("animation", 2), "RealESRGAN_x2plus")
        self.assertIsNone(ksr.model_for("realistic", 1))

    def test_24_to_60_fps_is_the_minterpolate_timestamps(self):
        tl = ksr.timeline(24, 60, 1.0, 5.0)
        self.assertEqual(len(tl), 300)
        self.assertEqual(tl[:6], [(0, 0.0), (0, 0.4), (0, 0.8), (1, 0.2), (1, 0.6), (2, 0.0)])
        self.assertEqual({round(t, 3) for _, t in tl}, {0.0, 0.4, 0.8, 0.2, 0.6})

    def test_a_slowed_part_has_the_frame_count_of_setpts_and_never_runs_past_its_frames(self):
        usable, want, stretch = 4.0, 5.0, 1.12
        tl = ksr.timeline(24, 60, stretch, min(want, usable * stretch))
        self.assertEqual(len(tl), math.ceil(min(want, usable * stretch) * 60))
        self.assertEqual([i for i, _ in tl], sorted(i for i, _ in tl), "monotonic: the decoder only moves forward")
        self.assertLess(tl[-1][0], usable * 24)
        held = ksr.timeline(24, 60, 2.0, 5.0, n_src=10)
        self.assertTrue(all(i <= 9 for i, _ in held))
        self.assertEqual(held[-1], (9, 0.0), "past the last frame it is held, like tpad")

    def test_the_estimate_counts_source_frames_for_sr_and_output_frames_for_rife(self):
        bench = {"sr_s": 0.1, "rife_s": 0.05, "io_s": 0.01}
        est = ksr.estimate_minutes(bench, [("a", 5.0, 1.0, 5.0), ("b", 4.0, 1.25, 5.0)], 60)
        want = 1.25 * ((120 * 0.1 + 300 * 0.06) + (96 * 0.1 + 300 * 0.06)) / 60
        self.assertAlmostEqual(est, want, places=6)

    def test_off_and_no_torch_are_reasons_not_errors(self):
        os.environ["KLEO_SR"] = "off"; self.addCleanup(lambda: os.environ.pop("KLEO_SR", None))
        self.assertEqual(ksr.available(), (False, "KLEO_SR=off"))
        os.environ["KLEO_SR"] = "auto"
        saved = sys.modules.get("torch"); sys.modules["torch"] = None
        self.addCleanup(lambda: sys.modules.__setitem__("torch", saved) if saved else sys.modules.pop("torch", None))
        ok, why = ksr.available()
        self.assertFalse(ok); self.assertIn("no torch", why)

    def test_importing_it_never_imports_torch(self):
        import subprocess
        r = subprocess.run([sys.executable, "-c", "import sys; sys.path.insert(0, sys.argv[1]); import kleo_sr; print('torch' in sys.modules)", HERE],
                           capture_output=True, text=True)
        self.assertEqual(r.stdout.strip(), "False", r.stderr)

    def test_missing_or_altered_weights_are_refused(self):
        import tempfile, shutil
        d = tempfile.mkdtemp(prefix="kleo-sr-w-"); self.addCleanup(shutil.rmtree, d, True)
        ok, why = ksr.weights_ok(d)
        self.assertFalse(ok); self.assertIn("is not in", why)
        for name in ksr.WEIGHTS:
            open(os.path.join(d, name), "wb").write(b"not the weights")
        ksr._checked.pop(d, None)
        ok, why = ksr.weights_ok(d)
        self.assertFalse(ok); self.assertIn("pinned sha256", why)

    def test_the_image_pins_the_same_weights_as_the_module(self):
        """Dockerfile.keou fetches with curl and checks sha256sum; kleo_sr checks the same files at run time. The two
        tables must be one table, or the image ships weights the module then refuses (SR silently off everywhere)."""
        docker = open(os.path.join(HERE, "Dockerfile.keou"), encoding="utf-8").read()
        for name, (urls, size, sha) in ksr.WEIGHTS.items():
            self.assertIn(sha, docker, name)
            self.assertIn(str(size), docker, name)
            for url in urls:
                self.assertIn(url, docker, name)
        for url in ksr.RIFE_ZIP[0]:
            self.assertIn(url, docker)
        self.assertIn(ksr.RIFE_ZIP[2], docker)
        self.assertIn(ksr.RIFE_FILE, docker)
        self.assertIn("COPY worker/kleo_sr.py /opt/kleo/kleo_sr.py", docker)

    def test_out_of_memory_is_recognised(self):
        self.assertTrue(ksr.is_oom(RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB")))
        self.assertFalse(ksr.is_oom(RuntimeError("no kernel image is available")))

    def test_the_rate_is_the_frames_really_there_not_the_base_rate(self):
        """A variable-rate clip whose r_frame_rate says 48 while it carries 24 frames a second would play twice as
        fast and then freeze under the timestamp map: the count of frames over the duration wins."""
        self.assertAlmostEqual(ksr.rate_of({"r_frame_rate": "48/1", "avg_frame_rate": "24/1", "nb_frames": "121", "duration": "5.041667"}), 24.0, places=3)
        self.assertAlmostEqual(ksr.rate_of({"r_frame_rate": "50/1", "avg_frame_rate": "25/1"}), 25.0)
        self.assertAlmostEqual(ksr.rate_of({"r_frame_rate": "24000/1001", "avg_frame_rate": "0/0"}), 23.976, places=3)
        self.assertEqual(ksr.rate_of({}), 24.0)
        self.assertEqual(ksr.rate_of({"r_frame_rate": "90000/1", "avg_frame_rate": "0/0", "nb_frames": "N/A"}), 24.0, "a timebase is not a rate")

    def frames(self, n):
        import io
        fr = object.__new__(ksr._Frames)
        fr.w, fr.h, fr.fps = 2, 1, 24.0
        fr.proc = types.SimpleNamespace(stdout=io.BytesIO(bytes(range(n)) * 6))
        fr.cache, fr.decoded, fr.eof = {}, 0, False
        fr._upscale = lambda raw: raw
        return fr

    def test_one_frame_past_the_end_is_the_hold_two_are_a_wrong_rate(self):
        fr = self.frames(5)
        for i in range(5):
            self.assertIsNotNone(fr.get(i))
        self.assertEqual(fr.get(5), fr.get(4), "one past the last frame: held, like tpad")
        with self.assertRaisesRegex(RuntimeError, "ran out at frame 5 where the timeline needs frame 7"):
            fr.get(7)

    def test_the_whole_window_is_counted_even_when_the_map_stops_early(self):
        """A rate read too low: the map needs only the first half of the frames, the rest are counted, not upscaled."""
        fr = self.frames(10)
        fr.get(4)
        self.assertEqual(fr.decoded, 5)
        self.assertEqual(fr.drain(), 10)


class SrCardTest(unittest.TestCase):
    """kleo_sr.Card: the card in a child process, a time limit on every request. Real children here, no torch."""

    def test_the_real_child_answers_and_says_why_there_is_no_card(self):
        c = ksr.Card(); self.addCleanup(c.kill)
        ok, why, gpu = c.available(timeout=120)
        self.assertFalse(ok); self.assertTrue(why)
        with self.assertRaisesRegex(RuntimeError, "unknown op"):
            c.call("format_the_disk", 60)
        c.close()
        self.assertIsNone(c.proc)

    def test_a_request_past_its_limit_kills_the_child_and_frees_the_caller(self):
        import time
        hang = "import sys, time\nfor line in sys.stdin:\n    time.sleep(3600)\n"
        c = ksr.Card([sys.executable, "-c", hang]); self.addCleanup(c.kill)
        t0 = time.time()
        with self.assertRaises(ksr.Overrun):
            c.enhance("a.mp4", "b.mp4", 1.0, 1.0, 1.0, 60, 4, "realistic", timeout=1.0)
        self.assertLess(time.time() - t0, 15)
        self.assertIsNone(c.proc, "the hung child is gone")

    def test_a_child_that_dies_is_an_error_not_a_hang(self):
        c = ksr.Card([sys.executable, "-c", "import sys; sys.stdin.readline(); sys.exit(3)"]); self.addCleanup(c.kill)
        with self.assertRaisesRegex(RuntimeError, "died during benchmark"):
            c.benchmark("a.mp4", 4, "realistic", timeout=60)

    def test_an_out_of_memory_answer_stays_an_out_of_memory_error(self):
        say = "import sys, json\nfor line in sys.stdin:\n    print(json.dumps({'ok': False, 'error': 'OutOfMemoryError: boom', 'oom': True}), flush=True)\n"
        c = ksr.Card([sys.executable, "-c", say]); self.addCleanup(c.kill)
        with self.assertRaises(RuntimeError) as cm:
            c.enhance("a.mp4", "b.mp4", 1.0, 1.0, 1.0, 60, 4, "realistic", timeout=60)
        self.assertTrue(ksr.is_oom(cm.exception))

    def test_off_never_starts_a_child(self):
        os.environ["KLEO_SR"] = "off"; self.addCleanup(lambda: os.environ.pop("KLEO_SR", None))
        c = ksr.Card(["/nonexistent/python"])
        self.assertEqual(c.available(), (False, "KLEO_SR=off", None))
        self.assertIsNone(c.proc)


class FakeCard:
    """kleo_sr.Card with the child replaced: enhance() writes a real (tiny) clip of the part's slowed length at `fps`.
    `cost` seconds of (fake) GPU time per part, read off kv._clock; a part that would take longer than the time it is
    given behaves like the real child past its limit: the clock moves to the limit, the child is killed, Overrun."""

    def __init__(self, fake):
        import threading
        self.fake, self.lock = fake, threading.Lock()

    def available(self, timeout=180):
        return (True, "ok", "Fake GPU") if self.fake.ok else (False, "no CUDA device", None)

    def benchmark(self, src, factor, look, timeout=300):
        return {"sr_s": 0.01}

    def kill(self):
        self.fake.killed += 1

    def close(self):
        self.fake.released += 1

    def enhance(self, src, mid, usable, stretch, want, fps, factor, look, tile=None, timeout=600):
        import subprocess, time
        f = self.fake
        part = int(os.path.basename(mid)[:3])
        with f.lock:
            f.active += 1; f.max_active = max(f.max_active, f.active); f.calls.append((part, tile)); f.timeouts.append(timeout)
        try:
            time.sleep(0.05)
            cost = f.costs.get(part, f.cost)
            if cost > timeout:
                f.now[0] += timeout
                self.kill()
                raise f.Overrun(f"enhance took more than {timeout:.0f} s; the GPU process was killed")
            f.now[0] += cost
            if part == f.fail_on:
                raise RuntimeError("boom")
            if part == f.oom_on:
                raise RuntimeError("CUDA out of memory")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=size=64x36:rate={fps}",
                            "-t", f"{min(want, usable * stretch):.3f}", "-c:v", "libx264", "-preset", "ultrafast",
                            "-pix_fmt", "yuv420p", mid], check=True, capture_output=True)
            return {"frames_in": 1, "frames_out": 1}
        finally:
            with f.lock:
                f.active -= 1


class FakeSr:
    """kleo_sr with the GPU replaced (its Card is a FakeCard); the pure half is the real module's where it matters."""
    Overrun = ksr.Overrun

    def __init__(self, ok=True, est=1.0, fail_on=None, oom_on=None, cost=0.0, costs=None):
        import threading
        self.lock = threading.Lock()
        self.ok, self.est, self.fail_on, self.oom_on, self.cost, self.costs = ok, est, fail_on, oom_on, cost, costs or {}
        self.calls, self.timeouts, self.active, self.max_active, self.released, self.killed = [], [], 0, 0, 0, 0
        self.now = [1000.0]

    def Card(self): return FakeCard(self)
    def plan(self, w, h, W, H): return 2
    def model_for(self, look, factor): return "fake-x2"
    def estimate_minutes(self, bench, recipes, fps): return self.est
    def is_oom(self, e): return "out of memory" in str(e)


class SrHookTest(FreezeTest):
    """build_footage with kleo_sr faked: the track keeps its length to the frame and its one report per part whatever
    the GPU does, a failing part falls back to today's chain, and the card is never shared by two parts."""

    def use(self, fake):
        saved = sys.modules.get("kleo_sr")
        sys.modules["kleo_sr"] = fake
        self.addCleanup(lambda: sys.modules.__setitem__("kleo_sr", saved) if saved else sys.modules.pop("kleo_sr", None))
        clock = kv._clock
        kv._clock = lambda: fake.now[0]
        self.addCleanup(setattr, kv, "_clock", clock)
        return fake

    def film(self, n=3, workers=3):
        import json
        src = self.clip("m.mp4", 72, 0)
        plan = {"width": 128, "height": 72, "fps": 24, "duration": float(n),
                "scenes": [{"id": "s1", "shots": [{"index": k, "start": float(k), "end": float(k + 1)} for k in range(n)]}]}
        pj = os.path.join(self.tmp, "shots.json"); json.dump(plan, open(pj, "w"))
        seen, said = [], []
        out = kv.build_footage(pj, {f"s1-s{k + 1}": src for k in range(n)}, os.path.join(self.tmp, "footage.mp4"), 128, 72, fps=24,
                               log_fn=lambda *a: said.append(" ".join(str(x) for x in a)),
                               progress_fn=lambda d, t: seen.append((d, t)), workers=workers)
        return out, seen, said

    def test_the_gpu_finishes_every_part_one_at_a_time_and_the_track_keeps_its_length(self):
        fake = self.use(FakeSr())
        out, seen, said = self.film()
        self.assertTrue(out and os.path.isfile(out), said)
        self.assertTrue(any("SR on: Fake GPU, fake-x2 x2 + RIFE 4.25" in m for m in said), said)
        self.assertEqual(sorted(p for p, _ in fake.calls), [0, 1, 2])
        self.assertEqual(fake.max_active, 1, "two parts on the card at once")
        self.assertEqual(seen, [(1, 3), (2, 3), (3, 3)])
        self.assertAlmostEqual(kv.seconds_of(out), 3.0, delta=0.15)
        self.assertFalse(any("Lanczos path" in m for m in said), said)
        self.assertGreaterEqual(fake.released, 1, "the card is handed back after the track")
        # The report the server reads to keep the AI upscale's credits (25 September 2026): every part upscaled.
        self.assertEqual(kv.LAST_SR, {"parts": 3, "applied": 3, "model": "fake-x2", "gpu": "Fake GPU", "reason": None})

    def test_rife_alone_is_not_the_ai_upscale_the_film_was_sold(self):
        # Clips already near the delivery size (factor 1, no upscaler): every part goes through RIFE, but no
        # Real-ESRGAN pass ran, so the report says "not applied" and the server refunds the upscale (review, 25 Sep).
        fake = FakeSr()
        fake.plan = lambda w, h, W, H: 1
        fake.model_for = lambda look, factor: None
        self.use(fake)
        out, _, said = self.film()
        self.assertTrue(out and os.path.isfile(out), said)
        self.assertTrue(any("SR on: Fake GPU, no upscaler x1 + RIFE 4.25" in m for m in said), said)
        self.assertEqual(kv.LAST_SR, {"parts": 3, "applied": 0, "model": None, "gpu": "Fake GPU",
                                      "reason": "the clips are already near 4K: no Real-ESRGAN pass, RIFE only"})

    def test_every_part_gets_only_the_gpu_time_the_film_has_left(self):
        fake = self.use(FakeSr(est=2.0, cost=30.0))
        out, _, said = self.film(workers=1)
        self.assertTrue(out and os.path.isfile(out), said)
        allowance = max(1.5 * 2.0, 2.0 + kv.SR_GRACE_MIN) * 60
        self.assertEqual(fake.timeouts, [allowance, allowance - 30, allowance - 60])

    def test_a_card_slower_than_its_projection_hands_the_rest_to_the_cpu(self):
        """The 12-frame benchmark said 2 min; the card really needs 2.5 min a part. The allowance is
        max(1.5 x 2, 2 + 5) = 7 min: two parts fit, the third is cut off at the 2 min left (its child killed) and
        finished by today's chain, and the film is delivered at its length."""
        fake = self.use(FakeSr(est=2.0, cost=150.0))
        self.assertEqual(kv.SR_GRACE_MIN, 5.0)
        out, seen, said = self.film(workers=1)
        self.assertTrue(out and os.path.isfile(out), said)
        self.assertEqual([p for p, _ in fake.calls], [0, 1, 2])
        self.assertEqual(fake.timeouts, [420.0, 270.0, 120.0])
        self.assertTrue(any("s1 shot 3: SR failed (enhance took more than 120 s" in m for m in said), said)
        self.assertEqual(sum("SR off for the parts not started yet: a part overran" in m for m in said), 1, said)
        self.assertEqual((kv.LAST_SR["parts"], kv.LAST_SR["applied"]), (3, 2))
        self.assertIn("enhance took more than 120 s", kv.LAST_SR["reason"])
        self.assertEqual(seen, [(1, 3), (2, 3), (3, 3)])
        self.assertAlmostEqual(kv.seconds_of(out), 3.0, delta=0.15)

    def test_once_the_allowance_is_spent_no_part_starts_on_the_card(self):
        fake = self.use(FakeSr(est=0.5, costs={0: 330.0}))
        out, _, said = self.film(workers=1)
        self.assertTrue(out and os.path.isfile(out), said)
        self.assertEqual([p for p, _ in fake.calls], [0], "5.5 min of 5.5 spent: nothing else is sent to the card")
        self.assertEqual(sum("SR off for the parts not started yet: the GPU has used 5.5 min" in m for m in said), 1, said)
        self.assertFalse(any("SR failed" in m for m in said), said)
        self.assertAlmostEqual(kv.seconds_of(out), 3.0, delta=0.15)

    def test_the_wall_clock_deadline_stops_the_card_too(self):
        fake = self.use(FakeSr(est=1.0, cost=10.0))
        saved = kv.SR_DEADLINE_MIN; kv.SR_DEADLINE_MIN = 0.25; self.addCleanup(setattr, kv, "SR_DEADLINE_MIN", saved)
        out, _, said = self.film(workers=1)
        self.assertTrue(out and os.path.isfile(out), said)
        self.assertEqual(fake.timeouts, [15.0, 5.0])
        self.assertTrue(any("SR failed (enhance took more than 5 s" in m for m in said), said)
        self.assertAlmostEqual(kv.seconds_of(out), 3.0, delta=0.15)

    def test_a_failing_part_falls_back_and_the_rest_stop_trusting_the_gpu(self):
        fake = self.use(FakeSr(fail_on=1))
        out, seen, said = self.film(workers=1)
        self.assertTrue(out and os.path.isfile(out), said)
        self.assertTrue(any("s1 shot 2: SR failed (boom), Lanczos path" in m for m in said), said)
        self.assertEqual(sum("SR off for the parts not started yet" in m for m in said), 1, said)
        self.assertEqual([p for p, _ in fake.calls], [0, 1], "the third part never went to the card")
        self.assertEqual(seen, [(1, 3), (2, 3), (3, 3)])
        # One part on the classic chain is enough for the upscale not to count as applied: its credits go back.
        self.assertEqual((kv.LAST_SR["parts"], kv.LAST_SR["applied"]), (3, 1))
        self.assertIn("boom", kv.LAST_SR["reason"])
        self.assertAlmostEqual(kv.seconds_of(out), 3.0, delta=0.15)

    def test_out_of_memory_retries_in_tiles_then_falls_back_for_that_part_only(self):
        fake = self.use(FakeSr(oom_on=1))
        out, seen, said = self.film(workers=1)
        self.assertTrue(out and os.path.isfile(out), said)
        self.assertEqual(fake.calls, [(0, None), (1, None), (1, 256), (2, None)])
        self.assertEqual(fake.killed, 1, "the retry runs in a fresh child, on an emptied card")
        self.assertFalse(any("SR off for the parts" in m for m in said), "an OOM is not a reason to stop for the film")
        self.assertAlmostEqual(kv.seconds_of(out), 3.0, delta=0.15)

    def test_over_budget_the_whole_film_takes_todays_chain(self):
        fake = self.use(FakeSr(est=99.0))
        out, _, said = self.film()
        self.assertTrue(out and os.path.isfile(out), said)
        self.assertTrue(any("SR off: estimated 99 min over the 20 min budget" in m for m in said), said)
        self.assertEqual(fake.calls, [])
        self.assertEqual((kv.LAST_SR["parts"], kv.LAST_SR["applied"]), (3, 0))
        self.assertIn("over the 20 min budget", kv.LAST_SR["reason"])

    def test_no_card_means_todays_chain_and_says_why(self):
        fake = self.use(FakeSr(ok=False))
        out, _, said = self.film()
        self.assertTrue(out and os.path.isfile(out), said)
        self.assertTrue(any("SR off: no CUDA device" in m for m in said), said)
        self.assertEqual(fake.calls, [])
        self.assertEqual(kv.LAST_SR, {"parts": 3, "applied": 0, "model": None, "gpu": None, "reason": "no CUDA device"})

    def test_the_real_module_on_a_machine_without_a_card_is_off_and_said(self):
        saved = sys.modules.pop("kleo_sr", None)
        self.addCleanup(lambda: sys.modules.__setitem__("kleo_sr", saved) if saved else None)
        out, _, said = self.film()
        self.assertTrue(out and os.path.isfile(out), said)
        self.assertTrue(any(m.startswith("SR off:") for m in said), said)

    def test_kleo_sr_off_on_the_box_is_reported_as_the_reason(self):
        """A job without the AI upscale gets KLEO_SR=off (src/backends/vast.ts), and so does one sold it when the
        Worker's switch is off. The report says so, and a paid upscale is refunded on that reason."""
        saved = sys.modules.pop("kleo_sr", None)
        self.addCleanup(lambda: sys.modules.__setitem__("kleo_sr", saved) if saved else None)
        os.environ["KLEO_SR"] = "off"; self.addCleanup(lambda: os.environ.pop("KLEO_SR", None))
        out, _, said = self.film()
        self.assertTrue(out and os.path.isfile(out), said)
        self.assertEqual(kv.LAST_SR["applied"], 0)
        self.assertEqual(kv.LAST_SR["reason"], "KLEO_SR=off")

    def test_the_dissolve_is_untouched_by_the_gpu_pass(self):
        import json
        fake = self.use(FakeSr())
        src = self.clip("d.mp4", 72, 0)
        plan = {"width": 128, "height": 72, "fps": 24, "duration": 4.0, "dissolve_s": 0.5,
                "scenes": [{"id": "s1", "transition": "cut", "shots": [{"index": 0, "start": 0.0, "end": 2.0}]},
                           {"id": "s2", "transition": "dissolve", "shots": [{"index": 0, "start": 2.0, "end": 4.0}]}]}
        pj = os.path.join(self.tmp, "shots.json"); json.dump(plan, open(pj, "w"))
        said = []
        out = kv.build_footage(pj, {"s1-s1": src, "s2-s1": src}, os.path.join(self.tmp, "footage.mp4"), 128, 72, fps=24,
                               log_fn=lambda *a: said.append(" ".join(str(x) for x in a)))
        self.assertTrue(out and os.path.isfile(out), said)
        self.assertEqual(len(fake.calls), 2)
        self.assertAlmostEqual(kv.seconds_of(out), 4.0, delta=0.15)
        self.assertTrue(any("1 dissolve(s) between acts, 0.5 s each" in m for m in said), said)

    def test_the_tail_after_the_gpu_keeps_the_hold_and_the_grade_but_not_the_cpu_interpolation(self):
        vf = kv.finish_vf_sr(2160, 3840, 5.0)
        self.assertNotIn("minterpolate", vf); self.assertNotIn("setpts", vf)
        self.assertIn("tpad=stop_mode=clone:stop_duration=5.000", vf)
        self.assertTrue(vf.endswith(kv.GRADE))
        self.assertIn("scale=2160:3840", vf)


srab = load("sr_ab_under_test", os.path.join(os.path.dirname(HERE), "scripts", "sr-ab.py"))


class SrAbEvidenceTest(unittest.TestCase):
    """scripts/sr-ab.py on the box: whatever fails after forty minutes of rented GPU, what was measured reaches R2
    before `guarded` destroys the box — the probe is never paid for twice for want of an upload."""

    def setUp(self):
        import tempfile, shutil
        self.tmp = tempfile.mkdtemp(prefix="kleo-srab-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.said = []
        self.patch("say", lambda *a: self.said.append(" ".join(str(x) for x in a)))

    def patch(self, name, fake):
        saved = getattr(srab, name); setattr(srab, name, fake); self.addCleanup(setattr, srab, name, saved)

    def test_a_late_failure_still_uploads_the_evidence_and_says_ab_fail(self):
        out, sent = os.path.join(self.tmp, "out"), []

        def run(ab, o):
            os.makedirs(o, exist_ok=True)
            open(os.path.join(o, "results.json"), "w").write("{}")
            raise RuntimeError("the split encode failed")
        self.patch("run", run)
        self.patch("upload", lambda o: sent.append(o) or ["probe/results.json"])
        self.assertEqual(srab.box("/opt/kleo/ab", out), 1)
        self.assertEqual(sent, [out], "the upload ran after the failure")
        self.assertIn("PROBE_FILES 1 uploaded", self.said)
        self.assertIn("AB_FAIL RuntimeError: the split encode failed", self.said)
        self.assertNotIn("AB_DONE", self.said)

    def test_a_clean_run_says_ab_done(self):
        self.patch("run", lambda ab, o: {})
        self.patch("upload", lambda o: [])
        self.assertEqual(srab.box("/opt/kleo/ab", os.path.join(self.tmp, "out")), 0)
        self.assertEqual(self.said[-1], "AB_DONE")

    def test_the_run_leaves_a_results_json_with_its_error(self):
        import json
        out = os.path.join(self.tmp, "out")
        with self.assertRaises(FileNotFoundError):
            srab.run(os.path.join(self.tmp, "no-bundle"), out)
        r = json.load(open(os.path.join(out, "results.json")))
        self.assertIn("FileNotFoundError", r["error"])
        self.assertEqual(r["variants"], {})

    def test_one_refused_file_does_not_lose_the_others(self):
        out = os.path.join(self.tmp, "out"); os.makedirs(out)
        for name in ("a.json", "b.mp4", "c.jpg"):
            open(os.path.join(out, name), "w").write("x")

        def one(path, name):
            if name == "b.mp4":
                raise RuntimeError("PUT -> 413")
        self.patch("upload_one", one)
        with self.assertRaisesRegex(RuntimeError, "1 file\\(s\\) not uploaded: b.mp4"):
            srab.upload(out)
        self.assertEqual(open(os.path.join(out, "uploaded.txt")).read().split(), ["probe/a.json", "probe/c.jpg"])


class GenerateTest(unittest.TestCase):
    """generate_clips with LTX-2.5 replaced by a fake that records what it was asked: no torch, no CUDA, no weights.
    The frames the fake returns are real (tiny) arrays and the file is written by the real writer through ffmpeg."""

    def setUp(self):
        import tempfile, shutil
        self.tmp = tempfile.mkdtemp(prefix="kleo-ltx-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.saved = {k: sys.modules.get(k) for k in ("torch", "diffusers", "diffusers.utils", "diffusers.pipelines",
                                                        "diffusers.pipelines.ltx2", "diffusers.pipelines.ltx2.utils",
                                                        "diffusers.pipelines.ltx2.latent_upsampler", "huggingface_hub", "huggingface_hub.constants")}
        self.calls = calls = []
        torch = types.ModuleType("torch")
        torch.cuda = types.SimpleNamespace(is_available=lambda: True, empty_cache=lambda: None)
        torch.bfloat16 = "bf16"; torch.float32 = "f32"
        class Gen:
            def __init__(self, device=None): pass
            def manual_seed(self, s): return self
        torch.Generator = Gen

        class FakeLtx:
            vae = types.SimpleNamespace(enable_tiling=lambda: None)
            def to(self, d): return self
            def enable_model_cpu_offload(self): calls.append(("offload",))
            def set_progress_bar_config(self, **kw): pass
            def __call__(self, **kw):
                calls.append(("pipe", kw))
                n = kw["num_frames"]
                if kw.get("output_type") == "latent":
                    return ("LAT", "AUD")
                h, w = kw.get("height", 1088), kw.get("width", 1920)
                if "latents" in kw: h, w = 1088, 1920           # stage two decodes the upsampled latents
                return (frames(n, w, h)[None], ["audio"])
        class FakeUp:
            def __init__(self, vae=None, latent_upsampler=None): pass
            def __call__(self, **kw):
                calls.append(("upsample", kw)); return ("UP",)
        self.FakeLtx = FakeLtx
        diff = types.ModuleType("diffusers")
        diff.LTX2Pipeline = types.SimpleNamespace(from_pretrained=staticmethod(lambda *a, **k: (calls.append(("load", k)), FakeLtx())[1]))
        diff.LTX2LatentUpsamplePipeline = FakeUp
        pl = types.ModuleType("diffusers.pipelines"); ltx2 = types.ModuleType("diffusers.pipelines.ltx2")
        utils = types.ModuleType("diffusers.pipelines.ltx2.utils")
        utils.DEFAULT_NEGATIVE_PROMPT = "neg"; utils.DISTILLED_SIGMA_VALUES = [1.0, 0.5, 0.0]; utils.STAGE_2_DISTILLED_SIGMA_VALUES = [0.9, 0.0]
        lu = types.ModuleType("diffusers.pipelines.ltx2.latent_upsampler")
        lu.LTX2LatentUpsamplerModel = types.SimpleNamespace(from_pretrained=staticmethod(lambda *a, **k: types.SimpleNamespace(to=lambda d: "UPMODEL")))
        sys.modules.update({"torch": torch, "diffusers": diff, "diffusers.pipelines": pl, "diffusers.pipelines.ltx2": ltx2,
                            "diffusers.pipelines.ltx2.utils": utils, "diffusers.pipelines.ltx2.latent_upsampler": lu})
        sys.modules.pop("diffusers.utils", None)
        self.addCleanup(lambda: [sys.modules.__setitem__(k, v) if v else sys.modules.pop(k, None) for k, v in self.saved.items()])
        self.kv = kv
        kv.release()
        self.addCleanup(kv.release)

    def test_the_geometry_is_ltx_and_frames_are_8n_plus_1(self):
        self.assertEqual(self.kv.SIZES["16:9"], (960, 544)); self.assertEqual(self.kv.SIZES["9:16"], (544, 960))
        for secs in [1, 2, 3, 5]:
            self.assertEqual((self.kv.frames_for(secs) - 1) % 8, 0, f"{secs}s must give 8n+1 frames")
        self.assertEqual(self.kv.frames_for(5.0), 121)

    def test_one_clip_per_shot_named_after_it(self):
        shots = [{"id": "01-hook", "image_prompt": "a harbour at dawn", "motion": "push_in"},
                 {"id": "02-sea", "image_prompt": "waves breaking on rocks", "motion": "track_right"}]
        made = self.kv.generate_clips(shots, "realistic", "16:9", self.tmp)
        self.assertEqual(sorted(made), ["01-hook", "02-sea"])
        for sid, path in made.items():
            self.assertEqual(path, os.path.join(self.tmp, sid + ".mp4"))
            self.assertEqual(probe_frames(path)[0], self.kv.frames_for(3.0), "every generated frame must reach the file")

    def test_the_duration_asked_for_reaches_the_model(self):
        self.kv.generate_clips([{"id": "a", "image_prompt": "a street", "motion": "push_in"}], "realistic", "16:9", self.tmp, seconds_of={"a": 4.0})
        first = next(c for c in self.calls if c[0] == "pipe")[1]
        self.assertEqual(first["num_frames"], self.kv.frames_for(4.0))

    def test_a_shot_without_a_description_is_skipped_not_fatal(self):
        made = self.kv.generate_clips([{"id": "a", "image_prompt": ""}, {"id": "b", "image_prompt": "a street", "motion": "push_in"}], "realistic", "16:9", self.tmp)
        self.assertEqual(sorted(made), ["b"])

    def test_one_clip_failing_never_loses_the_others(self):
        boom = {"n": 0}; Fake = self.FakeLtx; orig = Fake.__call__
        def flaky(inner, **kw):
            if kw.get("output_type") == "latent":
                boom["n"] += 1
                if boom["n"] == 1: raise RuntimeError("CUDA hiccup")
            return orig(inner, **kw)
        Fake.__call__ = flaky; self.addCleanup(lambda: setattr(Fake, "__call__", orig))
        made = self.kv.generate_clips([{"id": "a", "image_prompt": "one", "motion": "push_in"}, {"id": "b", "image_prompt": "two", "motion": "push_in"}], "realistic", "16:9", self.tmp)
        self.assertEqual(sorted(made), ["b"])

    def test_without_cuda_nothing_is_generated_and_nothing_raises(self):
        sys.modules["torch"].cuda.is_available = lambda: False
        self.assertEqual(self.kv.generate_clips([{"id": "a", "image_prompt": "x"}], "realistic", "16:9", self.tmp), {})

    def test_the_card_is_handed_back_when_the_batch_ends(self):
        self.kv.generate_clips([{"id": "a", "image_prompt": "a street", "motion": "push_in"}], "realistic", "16:9", self.tmp)
        self.assertIsNone(self.kv._pipe, "the finish work needs the memory next")

    def test_a_shot_runs_two_stages_from_its_still_and_lands_in_a_real_file(self):
        from PIL import Image
        still = os.path.join(self.tmp, "s.png"); Image.new("RGB", (1344, 768), (10, 120, 200)).save(still)
        made = self.kv.generate_clips([{"id": "a", "image_prompt": "a lagoon", "motion": "push_in", "image": still}], "realistic", "16:9", self.tmp)
        self.assertEqual(sorted(made), ["a"])
        kinds = [c[0] for c in self.calls]
        self.assertEqual(kinds[:1], ["load"])
        self.assertEqual([k for k in kinds if k != "load"], ["pipe", "upsample", "pipe"], "stage one, upsample, stage two")
        one = self.calls[1][1]; two = self.calls[3][1]
        self.assertEqual((one["width"], one["height"]), (960, 544)); self.assertEqual(one["output_type"], "latent")
        self.assertEqual(one["image"].size, (960, 544), "the still is fitted to stage one's frame")
        self.assertEqual(one["guidance_scale"], 1.0, "distilled schedule: no classifier-free guidance")
        self.assertEqual(one["sigmas"], [1.0, 0.5, 0.0])
        self.assertEqual(two["latents"], "UP"); self.assertEqual(two["sigmas"], [0.9, 0.0]); self.assertEqual(two["output_type"], "np")
        self.assertEqual(probe_frames(made["a"])[1:3], (1920, 1088), "the file carries stage two's size")

    def test_without_the_upsampler_one_stage_at_stage_one_size(self):
        kv = self.kv; kv.LTX_UPSAMPLE = False; self.addCleanup(lambda: setattr(kv, "LTX_UPSAMPLE", True))
        made = kv.generate_clips([{"id": "b", "image_prompt": "waves", "motion": "pull_out"}], "realistic", "9:16", self.tmp)
        kinds = [c[0] for c in self.calls]
        self.assertEqual([k for k in kinds if k != "load"], ["pipe"])
        self.assertEqual(probe_frames(made["b"])[1:3], (544, 960))
        self.assertNotIn("image", self.calls[1][1], "no still, invented from the text")

    def test_the_gated_weights_are_asked_for_with_the_token(self):
        os.environ["HF_TOKEN"] = "hf_test_token"; self.addCleanup(lambda: os.environ.pop("HF_TOKEN", None))
        self.kv.generate_clips([{"id": "c", "image_prompt": "piles", "motion": "push_in"}], "realistic", "16:9", self.tmp)
        self.assertEqual(self.calls[0][1].get("token"), "hf_test_token")


if __name__ == "__main__":
    unittest.main(verbosity=2)


class SrInferenceModeTest(unittest.TestCase):
    """The first A/B probe (25 September 2026) never upscaled a frame: spandrel returns inference tensors and the
    code clamped them in place outside inference mode. The frame paths must stay inside torch.inference_mode and the
    byte conversion must be out of place."""

    def test_frame_paths_run_in_inference_mode(self):
        import inspect
        import kleo_sr
        for fn in (kleo_sr._sr_frame, kleo_sr._rife_frame):
            src = inspect.getsource(fn)
            self.assertIn("torch.inference_mode()", src, fn.__name__)
            self.assertNotIn("torch.no_grad()", src, fn.__name__)

    def test_byte_conversion_is_out_of_place(self):
        import inspect
        import kleo_sr
        src = inspect.getsource(kleo_sr)
        self.assertNotIn(".round_().clamp_(0, 255)", src)
