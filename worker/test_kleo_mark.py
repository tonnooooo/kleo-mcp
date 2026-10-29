#!/usr/bin/env python3
"""
The Kleo mark on free renders (kleo_mark.py, 29 October 2026): where it goes, that it is burned in and nothing else
changes (every frame, the frame rate, the length, the sound), that it obeys an explicit params.mark only, that a pass
which cannot be done ships the clean video, and that kleo_worker.main() uploads the marked video and a thumbnail cut
from it. Real ffmpeg on one-second 540x960 and 960x540 clips; no GPU, no network.

tests.yml runs its python modules by name, so these classes ride in test_kleo_worker_video (imported at its bottom).
Run: python3 -m unittest test_kleo_mark       (from worker/)
"""
import hashlib, importlib.util, json, os, shutil, subprocess, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


km = load_module("kleo_mark_under_test", os.path.join(HERE, "kleo_mark.py"))
HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def clip(path, w, h, seconds=1, audio=True):
    """A white clip at 60 fps (and a tone), so the dark pill shows wherever it is drawn."""
    args = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=white:s={w}x{h}:r=60:d={seconds}"]
    if audio:
        args += ["-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={seconds}", "-c:a", "aac", "-b:a", "96k", "-shortest"]
    subprocess.run(args + ["-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", path], check=True)
    return path


def frame(path, w, h, at=0.5):
    """One decoded frame as rgb24 bytes."""
    return subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-ss", str(at), "-i", path, "-frames:v", "1", "-f", "rawvideo",
                           "-pix_fmt", "rgb24", "-"], check=True, capture_output=True).stdout[: w * h * 3]


def pill(at):
    """A band low inside the pill, under its words and its logo: only the dark pill is there."""
    mw, mh, x, y = at
    return (x + mw * 3 // 10, y + mh * 8 // 10, mw * 4 // 10, max(2, mh // 10))


def mean_luma(rgb, w, box):
    """Mean brightness (0-255) inside box = (x, y, width, height)."""
    x0, y0, bw, bh = box
    total = n = 0
    for y in range(y0, y0 + bh):
        row = rgb[(y * w + x0) * 3:(y * w + x0 + bw) * 3]
        total += sum(row) / 3
        n += bw
    return total / n


class KleoMarkPlacementTest(unittest.TestCase):
    def test_where_the_mark_goes_on_the_two_render_formats(self):
        self.assertEqual(km.placement(2160, 3840), (691, 186, 86, 768), "9:16: left, 20% down, under the chapter pill")
        self.assertEqual(km.placement(3840, 2160), (845, 227, 2841, 475), "16:9: right, 22% down, clear of the brand")
        self.assertEqual(km.placement(540, 960), (173, 47, 22, 192))
        self.assertEqual(km.placement(960, 540), (211, 57, 711, 119))
        self.assertEqual(km.placement(300, 200), (96, 26, 192, 44), "never under 96 px")
        self.assertIsNone(km.placement(50, 50))

    def test_js_rounding_not_bankers_rounding(self):
        self.assertEqual(km.js_round(2.5), 3)
        self.assertEqual(km.js_round(0.5), 1)

    def test_only_an_explicit_true_marks(self):
        self.assertTrue(km.wanted({"params": {"mark": True}}))
        self.assertTrue(km.wanted({"params": json.dumps({"mark": True, "format": "9:16"})}))
        for params in ({}, {"mark": False}, {"mark": "true"}, {"mark": 1}, None, "not json", json.dumps({"product": "animatic"})):
            self.assertFalse(km.wanted({"params": params}), params)
        self.assertFalse(km.wanted(None))


class KleoMarkShipsTest(unittest.TestCase):
    def test_the_image_carries_the_module_and_the_mark(self):
        for name in ("Dockerfile.keou",):
            docker = open(os.path.join(HERE, name), encoding="utf-8").read()
            self.assertIn("COPY worker/kleo_mark.py /opt/kleo/kleo_mark.py", docker)
            self.assertIn("COPY worker/made-with-kleo.png /opt/kleo/made-with-kleo.png", docker)
        slim = open(os.path.join(ROOT, "docker", "Dockerfile.slim"), encoding="utf-8").read()
        self.assertIn("COPY worker/kleo_mark.py /opt/kleo/kleo_mark.py", slim)
        self.assertIn("COPY worker/made-with-kleo.png /opt/kleo/made-with-kleo.png", slim)

    def test_one_mark_everywhere(self):
        digest = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
        here = digest(km.MARK)
        for other in (os.path.join(ROOT, "studio-web", "made-with-kleo.png"), os.path.join(ROOT, "watermark", "made-with-kleo.png")):
            self.assertEqual(digest(other), here, other)
        png = open(km.MARK, "rb").read(32)
        self.assertEqual((int.from_bytes(png[16:20], "big"), int.from_bytes(png[20:24], "big")), (km.MARK_W, km.MARK_H))


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg is not installed")
class KleoMarkBurnTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kleo-mark-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def check_burn(self, w, h):
        src = clip(os.path.join(self.tmp, f"in-{w}x{h}.mp4"), w, h)
        dst = os.path.join(self.tmp, f"out-{w}x{h}.mp4")
        info, at = km.burn(src, dst)
        self.assertEqual(at, km.placement(w, h))
        got = km.probe(dst)
        self.assertEqual((got["w"], got["h"]), (w, h))
        self.assertEqual(got["frames"], info["frames"], "every frame kept")
        self.assertGreaterEqual(info["frames"], 58)
        self.assertAlmostEqual(got["fps"], 60.0, places=2)
        self.assertTrue(got["audio"], "the sound track is copied")
        before, after = frame(src, w, h), frame(dst, w, h)
        self.assertGreater(mean_luma(before, w, pill(at)), 240, "the source is white there")
        self.assertLess(mean_luma(after, w, pill(at)), 140, "the dark pill is burned in")
        for box in ((0, h - h // 5, w // 3, h // 6), (w - w // 3, h - h // 5, w // 3, h // 6)):
            self.assertGreater(mean_luma(after, w, box), 240, f"nothing changes away from the mark: {box}")

    def test_a_tall_render(self):
        self.check_burn(540, 960)

    def test_a_wide_render(self):
        self.check_burn(960, 540)

    def test_mark_files_obeys_the_flag_and_cuts_the_thumbnail_again(self):
        src = clip(os.path.join(self.tmp, "video.mp4"), 540, 960)
        thumb = os.path.join(self.tmp, "thumbnail.jpg")
        open(thumb, "wb").write(b"old thumbnail")
        clean = open(src, "rb").read()
        lines, cuts = [], []
        log = lambda *a: lines.append(" ".join(str(x) for x in a))

        files = {"video.mp4": src, "thumbnail.jpg": thumb}
        self.assertIs(km.mark_files({"params": {"format": "9:16"}}, files, self.tmp, log=log), files)
        self.assertEqual(open(src, "rb").read(), clean, "no flag, no pass")

        def cut(video, out):
            cuts.append(video)
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", "0.5", "-i", video, "-frames:v", "1", out], check=True)
        out = km.mark_files({"params": {"mark": True}}, files, self.tmp, log=log, thumbnail=cut)
        self.assertEqual(out["video.mp4"], src, "the same name: the server takes only video.mp4")
        self.assertNotEqual(open(src, "rb").read(), clean)
        self.assertEqual(cuts, [src], "the thumbnail is cut from the marked video")
        self.assertNotEqual(open(thumb, "rb").read(), b"old thumbnail")
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "video.marked.mp4")))
        self.assertTrue(any(l.startswith("mark: 173x47 at 22,192 on 540x960, ") for l in lines), lines)

    def test_a_pass_that_fails_ships_the_clean_video(self):
        broken = os.path.join(self.tmp, "video.mp4")
        open(broken, "wb").write(b"\0" * 4096)
        lines = []
        files = {"video.mp4": broken}
        out = km.mark_files({"params": {"mark": True}}, files, self.tmp, log=lambda *a: lines.append(" ".join(map(str, a))))
        self.assertEqual(out, files)
        self.assertEqual(open(broken, "rb").read(), b"\0" * 4096)
        self.assertTrue(any(l.startswith("mark: FAILED") for l in lines), lines)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "video.marked.mp4")))


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg is not installed")
class KleoMarkWorkerTest(unittest.TestCase):
    """kleo_worker.main() with the network and the engine faked: what it uploads for a marked and an unmarked job."""

    def setUp(self):
        self.kw = load_module("kleo_worker_under_mark_test", os.path.join(HERE, "kleo_worker.py"))
        self.tmp = tempfile.mkdtemp(prefix="kleo-mark-main-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        # Two seconds: the worker cuts its thumbnail at 1.5 s (kleo_worker.THUMB_AT_S).
        self.source = clip(os.path.join(self.tmp, "rendered.mp4"), 540, 960, seconds=2)

    def run_main(self, params):
        kw, uploads, calls = self.kw, {}, []
        kw.API, kw.JOB, kw.SECRET = "http://kleo.test", "gt_mark", "wk_1"
        kw.watchdog = lambda: None
        kw.set_footage_backend = lambda job: "none"
        kw.progress = lambda *a, **k: None
        kw.self_report = lambda files, job, out_dir: None
        kw.upload_log = lambda out_dir: None
        kw.self_destruct = lambda reason: None
        kw.api = lambda method, path, data=None, **k: calls.append((method, path, data)) or {"job_id": "gt_mark", "template": "film", "params": params}

        def render(job, out_dir):
            video = os.path.join(out_dir, "video.mp4")
            shutil.copy(self.source, video)
            thumb = kw.thumbnail_from(video, os.path.join(out_dir, "thumbnail.jpg"))
            return {"video.mp4": video, "thumbnail.jpg": thumb}
        kw.render = render
        kw.upload = lambda path, name: uploads.__setitem__(name, open(path, "rb").read())
        os.environ.pop("KLEO_PHASE", None)
        kw.main()
        self.assertTrue(any(p.endswith("/done") for m, p, d in calls), calls)
        return uploads

    def test_a_marked_job_uploads_the_marked_video_and_its_thumbnail(self):
        up = self.run_main({"format": "9:16", "product": "animatic", "mark": True})
        self.assertNotEqual(up["video.mp4"], open(self.source, "rb").read())
        got = os.path.join(self.tmp, "uploaded.mp4")
        open(got, "wb").write(up["video.mp4"])
        at = km.placement(540, 960)
        self.assertLess(mean_luma(frame(got, 540, 960), 540, pill(at)), 140)
        thumb = os.path.join(self.tmp, "uploaded.jpg")
        open(thumb, "wb").write(up["thumbnail.jpg"])
        self.assertLess(mean_luma(frame(thumb, 540, 960, at=0), 540, pill(at)), 140, "the poster carries it too")

    def test_an_unmarked_job_uploads_the_render_untouched(self):
        up = self.run_main({"format": "9:16", "product": "animatic"})
        self.assertEqual(up["video.mp4"], open(self.source, "rb").read())


if __name__ == "__main__":
    unittest.main()
