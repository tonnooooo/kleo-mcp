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
import importlib.util, os, sys, types, unittest

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

    def test_a_shot_far_longer_than_a_take_is_slowed_to_the_cap_and_the_rest_is_held_and_said(self):
        stretch, usable, held = kv.plan_fill(10.0, 5.0, 0.0)
        self.assertEqual(stretch, kv.MAX_STRETCH)
        self.assertAlmostEqual(held, 10.0 - 5.0 * kv.MAX_STRETCH, places=6)

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
