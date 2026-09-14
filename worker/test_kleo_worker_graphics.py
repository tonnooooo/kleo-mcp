"""The layer on the finish box: a film whose project carries `graphics` goes through the engine (hud.js over the
footage, render.mjs compositing) instead of the plain narration mux, with the music bed silenced and the bundle's
missing music.wav made of silence. Everything heavy is a fake: no ffmpeg, no engine, no clips.
Run: python3 -m unittest test_kleo_worker_graphics"""
import json, os, shutil, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kleo_worker as kw


def project_with(graphics):
    p = {"schema_version": 1, "editorial_status": "ready", "id": "gt-layer", "title": "Signal Delay", "style": "picture", "look": "realistic",
         "format": "16:9", "width": 3840, "fps": 60, "language": "en", "voice": "am_michael", "music": "bed",
         "scenes": [{"id": "01-a", "kind": "cinema", "voice": "one", "shots": [{"image_prompt": "a dish at night"}]},
                    {"id": "02-b", "kind": "closing", "voice": "two", "shots": [{"image_prompt": "the dish at dawn"}]}]}
    if graphics is not None:
        p["graphics"] = graphics
    return p


class FilmFinishWithALayer(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.pdir = os.path.join(self.tmp, "projects", "gt-layer"); self.build = os.path.join(self.pdir, "build")
        self.out = os.path.join(self.tmp, "out"); os.makedirs(self.build); os.makedirs(self.out)
        for name in ("footage.mp4", "voice.wav"):
            open(os.path.join(self.build, name), "wb").write(b"x" * 64)
        json.dump({"duration": 12.0, "fps": 60, "scenes": []}, open(os.path.join(self.build, "timeline.json"), "w"))
        self.calls = {"run_keou": [], "ffmpeg": []}
        self.saved = {k: getattr(kw, k) for k in ("run_keou", "film_checks", "thumbnail_from", "progress", "KEOU_DIR")}
        kw.KEOU_DIR = os.path.join(self.tmp, "engine"); os.makedirs(kw.KEOU_DIR)

        def run_keou(engine, project_json, n, log_path, skip_voice=False):
            self.calls["run_keou"].append({"engine": engine, "project": json.load(open(project_json)), "n": n, "skip_voice": skip_voice})
            os.makedirs(os.path.join(self.pdir, "out"), exist_ok=True)
            open(os.path.join(self.pdir, "out", "master.mp4"), "wb").write(b"MASTER")
        kw.run_keou = run_keou
        kw.film_checks = lambda video, timeline: (12.0, 0.0)
        kw.thumbnail_from = lambda video, out_path, png=None: open(out_path, "wb").write(b"jpg") or out_path
        kw.progress = lambda *a, **k: None
        self.real_run = kw.subprocess.run

        def fake_run(cmd, **k):
            self.calls["ffmpeg"].append(cmd)
            class R: returncode = 0; stderr = ""
            # anullsrc → the silent music track; the plain mux → video.mp4
            if "anullsrc=r=48000:cl=stereo" in cmd:
                open(cmd[-1], "wb").write(b"SILENCE")
            elif cmd[0] == "ffmpeg" and cmd[-1].endswith("video.mp4"):
                open(cmd[-1], "wb").write(b"MUXED")
            return R()
        kw.subprocess.run = fake_run

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(kw, k, v)
        kw.subprocess.run = self.real_run
        shutil.rmtree(self.tmp, ignore_errors=True)

    def finish(self, graphics):
        json.dump(project_with(graphics), open(os.path.join(self.pdir, "project.json"), "w"))
        return kw.film_finish(self.pdir, self.out)

    def test_a_film_with_a_layer_is_drawn_by_the_engine_over_the_footage_with_silence_for_music(self):
        layer = {"accent": "#ffb347", "subtitles": "cinema", "chapters": "none", "hud": [{"id": "signal", "kind": "line", "edge": "bottom", "means": "the link"}]}
        files = self.finish(layer)
        self.assertEqual(len(self.calls["run_keou"]), 1, "the engine runs once, over the footage")
        call = self.calls["run_keou"][0]
        self.assertTrue(call["skip_voice"], "the voice is already on disk: the engine must not record it again")
        self.assertEqual(call["n"], 2)
        self.assertEqual(call["project"]["backdrop"], "video", "the footage is on disk, so the backdrop goes back on")
        self.assertEqual(call["project"]["music"], "none", "no bed under the narration")
        self.assertEqual(call["project"]["graphics"], layer, "the layer reaches the engine untouched")
        self.assertTrue(os.path.isfile(os.path.join(self.build, "music.wav")), "the bundle had no music.wav: silence is made")
        self.assertTrue(any("anullsrc=r=48000:cl=stereo" in c for c in self.calls["ffmpeg"]))
        self.assertFalse(any(c[0] == "ffmpeg" and c[-1].endswith("video.mp4") for c in self.calls["ffmpeg"]), "the plain mux is not run: the engine's master IS the film")
        self.assertEqual(open(files["video.mp4"], "rb").read(), b"MASTER")
        self.assertTrue(os.path.isfile(files["thumbnail.jpg"]))

    def test_a_film_without_a_layer_is_muxed_as_before_and_never_touches_the_engine(self):
        files = self.finish(None)
        self.assertEqual(self.calls["run_keou"], [], "no layer, no engine")
        self.assertFalse(os.path.isfile(os.path.join(self.build, "music.wav")))
        self.assertEqual(open(files["video.mp4"], "rb").read(), b"MUXED")

    def test_an_engine_that_delivers_no_master_is_a_retryable_failure(self):
        def broken(engine, project_json, n, log_path, skip_voice=False):
            self.calls["run_keou"].append({})
        kw.run_keou = broken
        with self.assertRaises(kw.RenderError) as cm:
            self.finish({"accent": "#ffffff", "subtitles": "none", "chapters": "film", "hud": []})
        self.assertTrue(cm.exception.retry)


if __name__ == "__main__":
    unittest.main()
