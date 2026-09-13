#!/usr/bin/env python3
"""
The kie.ai road inside kleo_worker.py, without a network: the server is a fake `api` and a fake `urlopen`. What is
under test is the box's side of the contract with src/footage.ts — it uploads each shot's still under its picture
id, sends the plan once, polls until every shot is ready or failed, downloads only real mp4 files, and hands
generate_footage the same {shot_id: path} dict the local model would have, so everything after (the track, the
backdrop rule, the engine's contract) stays the code test_kleo_worker_video.py already defends.

Run: python3 -m unittest worker.test_kleo_worker_footage       (from the repo root)
"""
import importlib.util, io, json, os, shutil, tempfile, unittest, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


kw = load_module("kleo_worker_under_footage_test", os.path.join(HERE, "kleo_worker.py"))
MP4 = b"\0\0\0\x18ftypisom" + b"\0" * 2048


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
        raise AssertionError(f"unexpected call {method} {path}")

    def urlopen(self, req, timeout=0):
        url = req.full_url
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
        self.saved = {k: getattr(kw, k) for k in ("api", "progress", "FOOTAGE_BACKEND", "SECRET")}
        self.saved_urlopen = kw.urllib.request.urlopen
        kw.progress = lambda *a, **k: None
        kw.SECRET = "wsecret"
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

    def test_on_the_local_road_nothing_here_is_touched(self):
        kw.FOOTAGE_BACKEND = "local"
        srv = FakeServer()
        self.serve(srv)
        self.assertEqual(kw.footage_backend(), "local")
        self.assertEqual(srv.plans, [])


if __name__ == "__main__":
    unittest.main()
