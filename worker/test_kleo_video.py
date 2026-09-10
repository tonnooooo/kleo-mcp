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

    def test_the_life_added_to_a_still_scene_is_also_deterministic(self):
        self.assertEqual(kv.alive("03-storm"), kv.alive("03-storm"))
        self.assertIn(kv.alive("03-storm"), kv.ALIVE)


class GenerateTest(unittest.TestCase):
    """generate_clips with a fake pipeline: no torch, no CUDA, no file the model wrote."""

    def setUp(self):
        self.saved = {k: sys.modules.get(k) for k in ("torch", "diffusers", "diffusers.utils")}
        self.calls = []
        torch = types.ModuleType("torch")
        torch.cuda = types.SimpleNamespace(is_available=lambda: True, empty_cache=lambda: None)
        torch.float32 = "f32"; torch.bfloat16 = "bf16"

        class Gen:
            def __init__(self, device=None): self.device = device
            def manual_seed(self, s): self.seed = s; return self
        torch.Generator = Gen
        calls = self.calls

        class FakePipe:
            def __call__(self, **kw):
                calls.append(kw)
                return types.SimpleNamespace(frames=[["frame"] * kw["num_frames"]])
            def to(self, d): return self
            def set_progress_bar_config(self, **kw): pass
            vae = types.SimpleNamespace(enable_tiling=lambda: None)

        diff = types.ModuleType("diffusers")
        diff.AutoencoderKLWan = types.SimpleNamespace(from_pretrained=staticmethod(lambda *a, **k: "vae"))
        diff.WanPipeline = types.SimpleNamespace(from_pretrained=staticmethod(lambda *a, **k: FakePipe()))
        utils = types.ModuleType("diffusers.utils")

        def export(frames, path, fps=24):
            with open(path, "wb") as f:
                f.write(b"\0" * 64)
        utils.export_to_video = export
        diff.utils = utils
        sys.modules.update({"torch": torch, "diffusers": diff, "diffusers.utils": utils})
        kv.release()
        import tempfile, shutil
        self.tmp = tempfile.mkdtemp(prefix="kleo-video-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.addCleanup(lambda: [sys.modules.__setitem__(k, v) if v else sys.modules.pop(k, None)
                                 for k, v in self.saved.items()])
        self.addCleanup(kv.release)

    def test_one_clip_per_shot_named_after_it(self):
        shots = [{"id": "01-hook", "image_prompt": "a harbour at dawn", "motion": "push_in"},
                 {"id": "02-sea", "image_prompt": "waves breaking on rocks", "motion": "track_right"}]
        made = kv.generate_clips(shots, "realistic", "16:9", self.tmp)
        self.assertEqual(sorted(made), ["01-hook", "02-sea"])
        for sid, path in made.items():
            self.assertEqual(path, os.path.join(self.tmp, sid + ".mp4"))
            self.assertTrue(os.path.isfile(path))
        self.assertEqual([c["width"] for c in self.calls], [1280, 1280])
        self.assertEqual([c["height"] for c in self.calls], [704, 704])

    def test_portrait_swaps_the_frame(self):
        kv.generate_clips([{"id": "a", "image_prompt": "a street", "motion": "push_in"}], "realistic", "9:16", self.tmp)
        self.assertEqual((self.calls[0]["width"], self.calls[0]["height"]), (704, 1280))

    def test_the_duration_asked_for_reaches_the_model(self):
        kv.generate_clips([{"id": "a", "image_prompt": "a street", "motion": "push_in"}], "realistic", "16:9",
                          self.tmp, seconds_of={"a": 4.0})
        self.assertEqual(self.calls[0]["num_frames"], kv.frames_for(4.0))

    def test_a_shot_without_a_description_is_skipped_not_fatal(self):
        made = kv.generate_clips([{"id": "a", "image_prompt": ""},
                                  {"id": "b", "image_prompt": "a street", "motion": "push_in"}],
                                 "realistic", "16:9", self.tmp)
        self.assertEqual(sorted(made), ["b"])

    def test_one_clip_failing_never_loses_the_others(self):
        boom = {"n": 0}
        orig = sys.modules["diffusers"].WanPipeline.from_pretrained

        class Failing:
            def __call__(self, **kw):
                boom["n"] += 1
                if boom["n"] == 1:
                    raise RuntimeError("CUDA hiccup")
                return types.SimpleNamespace(frames=[["f"] * kw["num_frames"]])
            def to(self, d): return self
            def set_progress_bar_config(self, **kw): pass
            vae = types.SimpleNamespace(enable_tiling=lambda: None)
        sys.modules["diffusers"].WanPipeline = types.SimpleNamespace(from_pretrained=staticmethod(lambda *a, **k: Failing()))
        self.addCleanup(lambda: setattr(sys.modules["diffusers"], "WanPipeline", orig))
        kv.release()
        made = kv.generate_clips([{"id": "a", "image_prompt": "one", "motion": "push_in"},
                                  {"id": "b", "image_prompt": "two", "motion": "push_in"}],
                                 "realistic", "16:9", self.tmp)
        self.assertEqual(sorted(made), ["b"])

    def test_without_cuda_nothing_is_generated_and_nothing_raises(self):
        sys.modules["torch"].cuda.is_available = lambda: False
        self.assertEqual(kv.generate_clips([{"id": "a", "image_prompt": "x"}], "realistic", "16:9", self.tmp), {})

    def test_the_card_is_handed_back_when_the_batch_ends(self):
        kv.generate_clips([{"id": "a", "image_prompt": "a street", "motion": "push_in"}], "realistic", "16:9", self.tmp)
        self.assertIsNone(kv._pipe, "the Keou render needs the GPU next")


if __name__ == "__main__":
    unittest.main(verbosity=2)
