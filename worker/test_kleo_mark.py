#!/usr/bin/env python3
"""
The Kleo mark on free renders (kleo_mark.py, 29 October 2026): where it goes (clear of a HUD readout), that it is
burned in and nothing else changes (every frame, the frame rate, the length, the sound), that a master joined from
parts keeps its frame count, that it obeys an explicit params.mark only, that a pass which cannot be done ships the
clean video and says why, and that kleo_worker.main() uploads the marked video, a thumbnail cut from it, the outcome
line in log.txt and the outcome in /done. Real ffmpeg on one- and two-second 540x960 and 960x540 clips; no GPU, no
network.

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


def read(path, n=-1):
    with open(path, "rb") as f:
        return f.read(n)


def write(path, data):
    with open(path, "wb") as f:
        f.write(data)


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

    def test_a_hud_readout_top_left_moves_the_tall_mark(self):
        self.assertEqual(km.placement(2160, 3840, frozenset({"top-left"})), (691, 186, 1383, 768), "to the right side")
        self.assertEqual(km.placement(2160, 3840, frozenset({"top-left", "top-right"})), (691, 186, 86, 1920), "down to 50%")
        self.assertEqual(km.placement(2160, 3840, frozenset({"top-right", "bottom-left"})), (691, 186, 86, 768))
        self.assertEqual(km.placement(3840, 2160, frozenset({"top-right"})), (845, 227, 2841, 475), "16:9 readouts end above it")

    def test_hud_corners_reads_only_readouts_from_the_storyboard(self):
        sb = {"scenes": [], "graphics": {"accent": "#ffffff", "hud": [
            {"id": "a", "kind": "readout", "corner": "top-left", "rows": ["HR 72"]},
            {"id": "b", "kind": "stamp", "corner": "top-right"},
            {"id": "c", "kind": "line", "edge": "top"},
        ]}}
        self.assertEqual(km.hud_corners({"storyboard": sb}), frozenset({"top-left"}))
        self.assertEqual(km.hud_corners({"storyboard": json.dumps(sb)}), frozenset({"top-left"}))
        for sb in (None, "not json", {"graphics": None}, {"graphics": {"hud": "x"}}, {"graphics": {"hud": [None, 3]}}):
            self.assertEqual(km.hud_corners({"storyboard": sb}), frozenset(), sb)
        self.assertEqual(km.hud_corners(None), frozenset())

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
        with open(os.path.join(HERE, "Dockerfile.keou"), encoding="utf-8") as f:
            docker = f.read()
        self.assertIn("COPY worker/kleo_mark.py /opt/kleo/kleo_mark.py", docker)
        self.assertIn("COPY worker/made-with-kleo.png /opt/kleo/made-with-kleo.png", docker)
        with open(os.path.join(ROOT, "docker", "Dockerfile.slim"), encoding="utf-8") as f:
            slim = f.read()
        self.assertIn("COPY worker/kleo_mark.py /opt/kleo/kleo_mark.py", slim)
        self.assertIn("COPY worker/made-with-kleo.png /opt/kleo/made-with-kleo.png", slim)

    def test_one_mark_everywhere(self):
        digest = lambda p: hashlib.sha256(read(p)).hexdigest()
        here = digest(km.MARK)
        for other in (os.path.join(ROOT, "studio-web", "made-with-kleo.png"), os.path.join(ROOT, "watermark", "made-with-kleo.png")):
            self.assertEqual(digest(other), here, other)
        png = read(km.MARK, 32)
        self.assertEqual((int.from_bytes(png[16:20], "big"), int.from_bytes(png[20:24], "big")), (km.MARK_W, km.MARK_H))


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg is not installed")
class KleoMarkBurnTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kleo-mark-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def check_burn(self, src, w, h):
        dst = src[:-4] + ".out.mp4"
        info, at = km.burn(src, dst)
        self.assertEqual(at, km.placement(w, h))
        got = km.probe(dst)
        self.assertEqual((got["w"], got["h"]), (w, h))
        self.assertEqual(got["frames"], info["frames"], "every frame kept, none added")
        self.assertAlmostEqual(got["fps"], 60.0, places=2)
        before, after = frame(src, w, h), frame(dst, w, h)
        self.assertGreater(mean_luma(before, w, pill(at)), 240, "the source is white there")
        self.assertLess(mean_luma(after, w, pill(at)), 140, "the dark pill is burned in")
        for box in ((0, h - h // 5, w // 3, h // 6), (w - w // 3, h - h // 5, w // 3, h // 6)):
            self.assertGreater(mean_luma(after, w, box), 240, f"nothing changes away from the mark: {box}")
        return info, got

    def test_a_tall_render(self):
        info, got = self.check_burn(clip(os.path.join(self.tmp, "in-540x960.mp4"), 540, 960), 540, 960)
        self.assertGreaterEqual(info["frames"], 58)
        self.assertTrue(got["audio"], "the sound track is copied")

    def test_a_wide_render(self):
        self.check_burn(clip(os.path.join(self.tmp, "in-960x540.mp4"), 960, 540), 960, 540)

    def test_a_master_joined_from_parts_keeps_every_frame(self):
        # The engine renders a master in parts and joins them with the concat demuxer and stream copy
        # (keou/engine/render.mjs); the joins can sit a hair off the 1/60 grid. Three 56-frame parts, joined the same way.
        parts = []
        for i in range(3):
            p = os.path.join(self.tmp, f"part{i}.mp4")
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=540x960:r=60",
                            "-frames:v", "56", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", p], check=True)
            parts.append(p)
        listing = os.path.join(self.tmp, "parts.txt")
        with open(listing, "w", encoding="utf-8") as f:
            f.write("".join(f"file '{p}'\n" for p in parts))
        master = os.path.join(self.tmp, "master.mp4")
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listing, "-c:v", "copy", master], check=True)
        info, got = self.check_burn(master, 540, 960)
        self.assertEqual(info["frames"], 168)
        self.assertIn(km.sync_args(), (["-vsync", "passthrough"], ["-fps_mode", "passthrough"]))

    def test_mark_files_obeys_the_flag_and_cuts_the_thumbnail_again(self):
        src = clip(os.path.join(self.tmp, "video.mp4"), 540, 960)
        thumb = os.path.join(self.tmp, "thumbnail.jpg")
        write(thumb, b"old thumbnail")
        clean = read(src)
        lines, cuts = [], []
        log = lambda *a: lines.append(" ".join(str(x) for x in a))

        files = {"video.mp4": src, "thumbnail.jpg": thumb}
        same, outcome = km.mark_files({"params": {"format": "9:16"}}, files, self.tmp, log=log)
        self.assertIs(same, files)
        self.assertIsNone(outcome, "no flag: nothing to report")
        self.assertEqual(read(src), clean, "no flag, no pass")

        def cut(video, out):
            cuts.append(video)
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", "0.5", "-i", video, "-frames:v", "1", out], check=True)
        out, outcome = km.mark_files({"params": {"mark": True}}, files, self.tmp, log=log, thumbnail=cut)
        self.assertEqual(out["video.mp4"], src, "the same name: the server takes only video.mp4")
        self.assertTrue(outcome["applied"])
        self.assertIsNone(outcome["why"])
        self.assertNotEqual(read(src), clean)
        self.assertEqual(cuts, [src], "the thumbnail is cut from the marked video")
        self.assertNotEqual(read(thumb), b"old thumbnail")
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "video.marked.mp4")))
        self.assertTrue(any(l.startswith("mark: 173x47 at 22,192 on 540x960, ") for l in lines), lines)

    def test_a_pass_that_fails_ships_the_clean_video_and_says_why(self):
        broken = os.path.join(self.tmp, "video.mp4")
        write(broken, b"\0" * 4096)
        lines = []
        files = {"video.mp4": broken}
        out, outcome = km.mark_files({"params": {"mark": True}}, files, self.tmp, log=lambda *a: lines.append(" ".join(map(str, a))))
        self.assertEqual(out, files)
        self.assertFalse(outcome["applied"])
        self.assertTrue(outcome["why"])
        self.assertEqual(read(broken), b"\0" * 4096)
        self.assertTrue(any(l.startswith("mark: FAILED") for l in lines), lines)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "video.marked.mp4")))


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg is not installed")
class KleoMarkWorkerTest(unittest.TestCase):
    """kleo_worker.main() with the network and the engine faked: what it uploads and reports for a marked and an
    unmarked job."""

    def setUp(self):
        self.kw = load_module("kleo_worker_under_mark_test", os.path.join(HERE, "kleo_worker.py"))
        self.tmp = tempfile.mkdtemp(prefix="kleo-mark-main-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        # Two seconds: the worker cuts its thumbnail at 1.5 s (kleo_worker.THUMB_AT_S).
        self.source = clip(os.path.join(self.tmp, "rendered.mp4"), 540, 960, seconds=2)

    def run_main(self, params):
        kw, uploads, calls, logs = self.kw, {}, [], []
        kw.API, kw.JOB, kw.SECRET = "http://kleo.test", "gt_mark", "wk_1"
        kw.watchdog = lambda: None
        kw.set_footage_backend = lambda job: "none"
        kw.progress = lambda *a, **k: None
        kw.self_report = lambda files, job, out_dir: None
        kw.self_destruct = lambda reason: None
        kw.api = lambda method, path, data=None, **k: calls.append((method, path, data)) or {"job_id": "gt_mark", "template": "film", "params": params}

        def upload_log(out_dir):
            p = os.path.join(out_dir, "log.txt")
            logs.append(read(p).decode("utf-8") if os.path.isfile(p) else "")
        kw.upload_log = upload_log

        def render(job, out_dir):
            video = os.path.join(out_dir, "video.mp4")
            shutil.copy(self.source, video)
            thumb = kw.thumbnail_from(video, os.path.join(out_dir, "thumbnail.jpg"))
            return {"video.mp4": video, "thumbnail.jpg": thumb}
        kw.render = render
        kw.upload = lambda path, name: uploads.__setitem__(name, read(path))
        os.environ.pop("KLEO_PHASE", None)
        kw.main()
        done = [d for m, p, d in calls if p.endswith("/done")]
        self.assertEqual(len(done), 1, calls)
        return uploads, done[0], "".join(logs)

    def test_a_marked_job_uploads_the_marked_video_its_thumbnail_and_the_outcome(self):
        up, done, log_txt = self.run_main({"format": "9:16", "product": "animatic", "mark": True})
        self.assertNotEqual(up["video.mp4"], read(self.source))
        got = os.path.join(self.tmp, "uploaded.mp4")
        write(got, up["video.mp4"])
        at = km.placement(540, 960)
        self.assertLess(mean_luma(frame(got, 540, 960), 540, pill(at)), 140)
        thumb = os.path.join(self.tmp, "uploaded.jpg")
        write(thumb, up["thumbnail.jpg"])
        self.assertLess(mean_luma(frame(thumb, 540, 960, at=0), 540, pill(at)), 140, "the poster carries it too")
        self.assertTrue(done["mark"]["applied"], done)
        self.assertIn("mark: 173x47 at 22,192 on 540x960", log_txt, "the line reaches the uploaded log.txt")

    def test_an_unmarked_job_uploads_the_render_untouched_and_reports_nothing(self):
        up, done, log_txt = self.run_main({"format": "9:16", "product": "animatic"})
        self.assertEqual(up["video.mp4"], read(self.source))
        self.assertNotIn("mark", done)
        self.assertNotIn("mark:", log_txt)


if __name__ == "__main__":
    unittest.main()
